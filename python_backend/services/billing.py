"""Real WiFi billing engine: RADIUS auth/accounting, RFC 5176 CoA disconnect, invoices, and router retry queue."""

from __future__ import annotations

import hashlib
import json
import os
import re
import socket
import sqlite3
import struct
from datetime import datetime, timedelta, timezone
from typing import Any

from ..db import DatabaseManager, expire_stale_records, get_operating_mode, parse_iso_dt, utc_now_iso
from ..security import generate_id, generate_reference
from .mikrotik import (
    provision_hotspot_user_on_router,
    push_hotspot_profile_to_router,
    terminate_router_session,
)


def compute_next_retry_delay_ms(attempt: int) -> int:
    # Exponential backoff: 30s, 2m, 5m, 15m, 30m
    schedule = [30_000, 120_000, 300_000, 900_000, 1_800_000]
    idx = max(0, min(len(schedule) - 1, attempt - 1))
    return schedule[idx]


def compute_subscription_policy(
    username: str,
    download_kbps: int,
    upload_kbps: int,
    session_timeout_seconds: int,
    data_limit_mb: int | None = None,
    simultaneous_use: int = 1,
) -> dict[str, Any]:
    rate_limit = f"{upload_kbps}k/{download_kbps}k"
    data_limit_bytes = int(data_limit_mb) * 1024 * 1024 if data_limit_mb and data_limit_mb > 0 else None
    return {
        "username": username,
        "mikrotikRateLimit": rate_limit,
        "sessionTimeoutSeconds": max(60, int(session_timeout_seconds)),
        "simultaneousUse": max(1, int(simultaneous_use or 1)),
        "dataLimitBytes": data_limit_bytes,
    }


def _encode_radius_attr(attr_type: int, value: bytes) -> bytes:
    length = 2 + len(value)
    return bytes([attr_type, length]) + value


def build_radius_disconnect_packet(
    username: str,
    shared_secret: str,
    acct_session_id: str | None = None,
    nas_ip: str | None = None,
    packet_id: int | None = None,
) -> bytes:
    """Build an RFC 5176 RADIUS Disconnect-Request (Code 40) UDP datagram."""
    pkt_id = packet_id if packet_id is not None else (os.getpid() ^ int(datetime.now(timezone.utc).timestamp())) & 0xFF
    attrs = bytearray()
    attrs.extend(_encode_radius_attr(1, username.encode("utf-8")))  # User-Name (1)
    if acct_session_id:
        attrs.extend(_encode_radius_attr(44, acct_session_id.encode("utf-8")))  # Acct-Session-Id (44)
    if nas_ip:
        try:
            attrs.extend(_encode_radius_attr(4, socket.inet_aton(nas_ip)))  # NAS-IP-Address (4)
        except OSError:
            pass

    total_len = 20 + len(attrs)
    zero_auth = b"\x00" * 16
    header_placeholder = struct.pack("!BBH16s", 40, pkt_id, total_len, zero_auth)
    authenticator = hashlib.md5(header_placeholder + bytes(attrs) + shared_secret.encode("utf-8")).digest()
    return struct.pack("!BBH16s", 40, pkt_id, total_len, authenticator) + bytes(attrs)


def send_radius_disconnect(
    db: DatabaseManager,
    business_id: str,
    nas_ip: str,
    username: str,
    shared_secret: str,
    acct_session_id: str | None = None,
    coa_port: int = 3799,
) -> dict[str, Any]:
    """Dispatch an RFC 5176 RADIUS Disconnect-Request UDP packet to a MikroTik NAS on port 3799."""
    if not nas_ip or not shared_secret:
        return {"sent": False, "detail": "NAS IP or RADIUS secret missing"}

    packet = build_radius_disconnect_packet(
        username=username,
        shared_secret=shared_secret,
        acct_session_id=acct_session_id,
        nas_ip=nas_ip,
    )
    success = False
    detail = ""
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sock.settimeout(1.5)
    try:
        sock.sendto(packet, (nas_ip, coa_port))
        try:
            resp, _ = sock.recvfrom(4096)
            code = resp[0] if resp else 0
            if code == 41:  # Disconnect-ACK
                success = True
                detail = "Disconnect-ACK received from NAS"
            elif code == 42:  # Disconnect-NAK
                detail = "Disconnect-NAK returned by NAS"
            else:
                detail = f"Unexpected CoA response code {code}"
        except TimeoutError:
            detail = f"CoA Disconnect-Request UDP sent to {nas_ip}:{coa_port} (no ACK within timeout)"
    except OSError as exc:
        detail = f"CoA UDP error: {exc}"
    finally:
        sock.close()

    db.execute(
        """
        INSERT INTO coa_disconnect_logs (id, business_id, nas_ip, username, acct_session_id, success, response_detail)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            generate_id("coa"),
            business_id,
            nas_ip,
            username,
            acct_session_id,
            1 if success else 0,
            detail,
        ),
    )
    return {"sent": True, "ack": success, "detail": detail}


def create_invoice_for_payment(
    conn: sqlite3.Connection,
    business_id: str,
    ledger_type: str,
    payment_id: str | None,
    payment_reference: str,
    item_description: str,
    total_tzs: int,
    customer_name: str | None = None,
    phone_number: str | None = None,
    currency: str = "TZS",
    is_test: bool = False,
) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")
    ym = now.strftime("%Y%m")
    invoice_number = f"INV-{ym}-{generate_reference('TX').split('-')[-1]}"
    inv_id = generate_id("inv")
    conn.execute(
        """
        INSERT INTO invoices (
          id, business_id, invoice_number, ledger_type, payment_id, payment_reference,
          customer_name, phone_number, item_description, subtotal_tzs, tax_tzs, total_tzs,
          currency, is_test, status, issued_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'PAID', ?)
        """,
        (
            inv_id,
            business_id,
            invoice_number,
            ledger_type,
            payment_id,
            payment_reference,
            customer_name,
            phone_number,
            item_description,
            int(total_tzs),
            int(total_tzs),
            currency,
            1 if is_test else 0,
            now_iso,
        ),
    )
    return {"id": inv_id, "invoiceNumber": invoice_number, "totalTzs": int(total_tzs)}


def provision_subscription_for_activation(
    db: DatabaseManager,
    business_id: str,
    package_id: str,
    radius_username: str,
    radius_secret_value: str,
    starts_at_iso: str,
    expires_at_iso: str,
    location_id: str | None = None,
    customer_id: str | None = None,
    payment_id: str | None = None,
    voucher_id: str | None = None,
) -> dict[str, Any]:
    pkg = db.query_one(
        """
        SELECT id, name, duration_minutes, download_kbps, upload_kbps, data_limit_mb, simultaneous_sessions
        FROM packages WHERE id = ? AND business_id = ?
        """,
        (package_id, business_id),
    )
    if not pkg:
        raise ValueError("Package not found in tenant workspace for subscription provisioning")

    download_kbps = int(pkg["download_kbps"])
    upload_kbps = int(pkg["upload_kbps"])
    data_limit_mb = int(pkg["data_limit_mb"]) if pkg["data_limit_mb"] is not None else None
    simultaneous_use = int(pkg.get("simultaneous_sessions") or 1)
    duration_seconds = max(
        60,
        int((parse_iso_dt(expires_at_iso) - parse_iso_dt(starts_at_iso)).total_seconds()),
    )

    policy = compute_subscription_policy(
        username=radius_username,
        download_kbps=download_kbps,
        upload_kbps=upload_kbps,
        session_timeout_seconds=duration_seconds,
        data_limit_mb=data_limit_mb,
        simultaneous_use=simultaneous_use,
    )

    sub_id = generate_id("sub")
    now_iso = utc_now_iso()

    def _tx(conn: sqlite3.Connection) -> None:
        conn.execute(
            """
            INSERT INTO subscriptions (
              id, business_id, location_id, customer_id, package_id, payment_id, voucher_id,
              radius_username, status, provisioning_status, download_kbps, upload_kbps, data_limit_mb,
              starts_at, expires_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'PENDING', ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                sub_id,
                business_id,
                location_id,
                customer_id,
                package_id,
                payment_id,
                voucher_id,
                radius_username,
                download_kbps,
                upload_kbps,
                data_limit_mb,
                starts_at_iso,
                expires_at_iso,
                now_iso,
                now_iso,
            ),
        )

        conn.execute(
            """
            INSERT INTO radcheck (id, business_id, username, attribute, op, value, expires_at, is_active, created_at)
            VALUES (?, ?, ?, 'Cleartext-Password', ':=', ?, ?, 1, ?)
            ON CONFLICT(business_id, username, attribute) DO UPDATE SET
              value = excluded.value, expires_at = excluded.expires_at, is_active = 1
            """,
            (generate_id("rc"), business_id, radius_username, radius_secret_value, expires_at_iso, now_iso),
        )

        attrs = [
            ("Mikrotik-Rate-Limit", policy["mikrotikRateLimit"]),
            ("Session-Timeout", str(policy["sessionTimeoutSeconds"])),
            ("Simultaneous-Use", str(policy["simultaneousUse"])),
        ]
        if policy["dataLimitBytes"] is not None:
            attrs.append(("Mikrotik-Total-Limit", str(policy["dataLimitBytes"])))

        for attr, val in attrs:
            conn.execute(
                """
                INSERT INTO radreply (id, business_id, username, attribute, op, value, created_at)
                VALUES (?, ?, ?, ?, ':=', ?, ?)
                ON CONFLICT(business_id, username, attribute) DO UPDATE SET value = excluded.value
                """,
                (generate_id("rr"), business_id, radius_username, attr, val, now_iso),
            )

    db.transaction(_tx)

    mode = get_operating_mode(db)
    router_row = db.query_one(
        """
        SELECT id, name, host FROM routers
        WHERE business_id = ? AND host != '' AND username != '' AND password_encrypted != ''
        ORDER BY CASE WHEN status = 'CONNECTED' THEN 0 ELSE 1 END, created_at DESC LIMIT 1
        """,
        (business_id,),
    )

    if mode == "STANDALONE_MODE" or not router_row:
        db.execute(
            "UPDATE subscriptions SET provisioning_status = 'STANDALONE', updated_at = ? WHERE id = ?",
            (utc_now_iso(), sub_id),
        )
        return {
            "subscriptionId": sub_id,
            "radiusUsername": radius_username,
            "status": "ACTIVE",
            "provisioningStatus": "STANDALONE",
            "jobId": None,
            "detail": "Subscription active with RADIUS policy ready (Standalone Mode).",
        }

    profile_name = f"trax-{package_id}"
    sync_res = push_hotspot_profile_to_router(
        db, str(router_row["id"]), profile_name, download_kbps, upload_kbps
    )
    if sync_res["synced"]:
        provision_hotspot_user_on_router(
            db,
            router_id=str(router_row["id"]),
            username=radius_username,
            password=radius_secret_value,
            profile_name=profile_name,
            limit_uptime_seconds=duration_seconds,
            limit_bytes_total=policy["dataLimitBytes"],
        )
        db.execute(
            "UPDATE subscriptions SET provisioning_status = 'PROVISIONED', updated_at = ? WHERE id = ?",
            (utc_now_iso(), sub_id),
        )
        return {
            "subscriptionId": sub_id,
            "radiusUsername": radius_username,
            "status": "ACTIVE",
            "provisioningStatus": "PROVISIONED",
            "jobId": None,
            "detail": sync_res["message"],
        }

    job_id = generate_id("job")
    next_retry = (
        datetime.now(timezone.utc) + timedelta(milliseconds=compute_next_retry_delay_ms(1))
    ).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    retry_now = utc_now_iso()

    def _retry_tx(conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE subscriptions SET provisioning_status = 'FAILED_RETRYING', updated_at = ? WHERE id = ?",
            (retry_now, sub_id),
        )
        conn.execute(
            """
            INSERT INTO provisioning_jobs (
              id, business_id, subscription_id, router_id, action, status,
              attempts, max_attempts, last_error, next_retry_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'PROVISION_SUBSCRIPTION', 'FAILED_RETRYING', 1, 5, ?, ?, ?, ?)
            """,
            (
                job_id,
                business_id,
                sub_id,
                str(router_row["id"]),
                sync_res["message"],
                next_retry,
                retry_now,
                retry_now,
            ),
        )
        conn.execute(
            """
            INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
            VALUES (?, ?, 'PROVISIONING_RETRY', 'WARNING', ?, ?, ?)
            """,
            (
                generate_id("ntf"),
                business_id,
                f"Router Provisioning Queued ({router_row['name']})",
                f"Router {router_row['name']} was unreachable. Provisioning job {job_id} scheduled for automatic retry.",
                json.dumps(
                    {
                        "subscriptionId": sub_id,
                        "routerId": str(router_row["id"]),
                        "jobId": job_id,
                        "error": sync_res["message"],
                    }
                ),
            ),
        )

    db.transaction(_retry_tx)
    return {
        "subscriptionId": sub_id,
        "radiusUsername": radius_username,
        "status": "ACTIVE",
        "provisioningStatus": "FAILED_RETRYING",
        "jobId": job_id,
        "detail": f"Router offline — queued retry job {job_id}: {sync_res['message']}",
    }


def retry_provisioning_job(
    db: DatabaseManager, job_id: str, expected_business_id: str | None = None
) -> dict[str, Any]:
    job = db.query_one(
        """
        SELECT j.*, s.package_id, s.download_kbps, s.upload_kbps, s.business_id as sub_business_id
        FROM provisioning_jobs j
        JOIN subscriptions s ON s.id = j.subscription_id
        WHERE j.id = ?
        """,
        (job_id,),
    )
    if not job:
        raise ValueError("Provisioning job not found")
    if expected_business_id and str(job["business_id"]) != expected_business_id:
        raise PermissionError("CROSS_TENANT_FORBIDDEN")

    business_id = str(job["business_id"])
    router_id = str(job["router_id"]) if job.get("router_id") else None
    now_iso = utc_now_iso()

    if str(job["status"]) == "COMPLETED":
        return {
            "jobId": job_id,
            "subscriptionId": str(job["subscription_id"]),
            "status": "COMPLETED",
            "provisioningStatus": "PROVISIONED",
            "synced": True,
            "message": "Provisioning already completed.",
        }

    if not router_id:
        db.execute(
            "UPDATE provisioning_jobs SET status = 'COMPLETED', completed_at = ?, updated_at = ? WHERE id = ?",
            (now_iso, now_iso, job_id),
        )
        db.execute(
            "UPDATE subscriptions SET provisioning_status = 'STANDALONE', updated_at = ? WHERE id = ?",
            (now_iso, str(job["subscription_id"])),
        )
        return {
            "jobId": job_id,
            "subscriptionId": str(job["subscription_id"]),
            "status": "COMPLETED",
            "provisioningStatus": "STANDALONE",
            "synced": True,
            "message": "No router bound; switched to Standalone RADIUS policy.",
        }

    sync_res = push_hotspot_profile_to_router(
        db,
        router_id,
        f"trax-{job['package_id']}",
        int(job["download_kbps"]),
        int(job["upload_kbps"]),
    )

    if sync_res["synced"]:
        def _ok_tx(conn: sqlite3.Connection) -> None:
            conn.execute(
                """
                UPDATE provisioning_jobs
                SET status = 'COMPLETED', attempts = attempts + 1, last_error = NULL,
                    completed_at = ?, updated_at = ?
                WHERE id = ?
                """,
                (now_iso, now_iso, job_id),
            )
            conn.execute(
                "UPDATE subscriptions SET provisioning_status = 'PROVISIONED', updated_at = ? WHERE id = ?",
                (now_iso, str(job["subscription_id"])),
            )

        db.transaction(_ok_tx)
        return {
            "jobId": job_id,
            "subscriptionId": str(job["subscription_id"]),
            "status": "COMPLETED",
            "provisioningStatus": "PROVISIONED",
            "synced": True,
            "message": sync_res["message"],
        }

    next_attempts = int(job.get("attempts") or 0) + 1
    max_attempts = int(job.get("max_attempts") or 5)
    next_retry_at = (
        None
        if next_attempts >= max_attempts
        else (
            datetime.now(timezone.utc)
            + timedelta(milliseconds=compute_next_retry_delay_ms(next_attempts))
        )
        .isoformat(timespec="milliseconds")
        .replace("+00:00", "Z")
    )

    db.execute(
        """
        UPDATE provisioning_jobs
        SET status = 'FAILED_RETRYING', attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
        WHERE id = ? AND business_id = ?
        """,
        (next_attempts, sync_res["message"], next_retry_at, now_iso, job_id, business_id),
    )
    return {
        "jobId": job_id,
        "subscriptionId": str(job["subscription_id"]),
        "status": "FAILED_RETRYING",
        "provisioningStatus": "FAILED_RETRYING",
        "synced": False,
        "message": sync_res["message"],
    }


def process_due_provisioning_jobs(db: DatabaseManager, limit: int = 10) -> int:
    now_iso = utc_now_iso()
    due = db.query_all(
        """
        SELECT id FROM provisioning_jobs
        WHERE status = 'FAILED_RETRYING' AND attempts < max_attempts
          AND (next_retry_at IS NULL OR next_retry_at <= ?)
        ORDER BY updated_at ASC LIMIT ?
        """,
        (now_iso, limit),
    )
    completed = 0
    for job in due:
        try:
            res = retry_provisioning_job(db, str(job["id"]))
            if res.get("synced"):
                completed += 1
        except Exception:
            pass
    return completed


def authorize_radius_request(
    db: DatabaseManager,
    username: str,
    password: str | None = None,
    nas_ip_address: str | None = None,
) -> dict[str, Any]:
    expire_stale_records(db)
    raw_username = username.strip()
    if not raw_username:
        return {"authorized": False, "reason": "Missing RADIUS username"}
    normalized_username = re.sub(r"[^A-Z0-9]", "", raw_username.upper())

    check = db.query_one(
        """
        SELECT rc.business_id, rc.username, rc.value, rc.expires_at, rc.is_active,
               b.status as business_status,
               s.status as sub_status, s.expires_at as sub_expires_at
        FROM radcheck rc
        JOIN businesses b ON b.id = rc.business_id
        LEFT JOIN subscriptions s ON s.radius_username = rc.username AND s.business_id = rc.business_id
        WHERE (rc.username = ? OR rc.username = ?) AND rc.attribute = 'Cleartext-Password'
        LIMIT 1
        """,
        (raw_username, normalized_username),
    )

    if not check:
        return {"authorized": False, "reason": "Unknown RADIUS subscriber"}

    canon_username = str(check["username"])
    if not check["is_active"]:
        return {"authorized": False, "reason": "Subscriber access revoked or expired"}
    if str(check["business_status"]) == "SUSPENDED":
        return {"authorized": False, "reason": "Tenant workspace is suspended"}
    if check.get("sub_status") and str(check["sub_status"]) != "ACTIVE":
        return {"authorized": False, "reason": f"Subscription status is {check['sub_status']}"}

    now_iso = utc_now_iso()
    if (check.get("expires_at") and str(check["expires_at"]) <= now_iso) or (
        check.get("sub_expires_at") and str(check["sub_expires_at"]) <= now_iso
    ):
        db.execute("UPDATE radcheck SET is_active = 0 WHERE username = ?", (canon_username,))
        db.execute(
            "UPDATE subscriptions SET status = 'EXPIRED', updated_at = ? WHERE radius_username = ?",
            (now_iso, canon_username),
        )
        return {"authorized": False, "reason": "Subscription time limit expired"}

    if password is not None and password != str(check["value"]):
        return {"authorized": False, "reason": "Invalid voucher/subscriber credentials"}

    replies = db.query_all(
        "SELECT attribute, value FROM radreply WHERE username = ? AND business_id = ?",
        (canon_username, str(check["business_id"])),
    )
    reply_attrs: dict[str, Any] = {}
    for r in replies:
        val = str(r["value"])
        reply_attrs[str(r["attribute"])] = int(val) if val.isdigit() else val

    exp_iso = str(check.get("sub_expires_at") or check.get("expires_at") or "")
    if exp_iso:
        remaining_sec = max(1, int((parse_iso_dt(exp_iso) - datetime.now(timezone.utc)).total_seconds()))
        reply_attrs["Session-Timeout"] = remaining_sec

    return {
        "authorized": True,
        "businessId": str(check["business_id"]),
        "replyAttributes": reply_attrs,
    }


def ingest_radius_accounting(
    db: DatabaseManager,
    acct_session_id: str,
    username: str,
    status_type: str,
    nas_ip_address: str | None = None,
    framed_ip_address: str | None = None,
    calling_station_id: str | None = None,
    acct_input_octets: int = 0,
    acct_output_octets: int = 0,
    acct_session_time: int = 0,
    terminate_cause: str | None = None,
) -> dict[str, Any]:
    raw_user = username.strip()
    norm_user = re.sub(r"[^A-Z0-9]", "", raw_user.upper())
    sub = db.query_one(
        """
        SELECT id, business_id, radius_username, voucher_id, data_limit_mb
        FROM subscriptions
        WHERE radius_username = ? OR radius_username = ?
        LIMIT 1
        """,
        (raw_user, norm_user),
    )
    if not sub:
        raise ValueError("RADIUS accounting username not found")

    acct_username = str(sub["radius_username"])
    now_iso = utc_now_iso()
    rx = max(0, int(acct_input_octets or 0))
    tx = max(0, int(acct_output_octets or 0))
    ses_time = max(0, int(acct_session_time or 0))

    def _tx(conn: sqlite3.Connection) -> dict[str, Any]:
        conn.execute(
            """
            INSERT INTO radacct (
              id, business_id, acct_session_id, username, nas_ip_address, framed_ip_address,
              calling_station_id, acct_input_octets, acct_output_octets, acct_session_time,
              acct_start_time, acct_stop_time, terminate_cause
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(acct_session_id) DO UPDATE SET
              acct_input_octets = excluded.acct_input_octets,
              acct_output_octets = excluded.acct_output_octets,
              acct_session_time = excluded.acct_session_time,
              acct_stop_time = CASE WHEN excluded.acct_stop_time IS NOT NULL THEN excluded.acct_stop_time ELSE radacct.acct_stop_time END,
              terminate_cause = COALESCE(excluded.terminate_cause, radacct.terminate_cause)
            """,
            (
                generate_id("rac"),
                str(sub["business_id"]),
                acct_session_id,
                acct_username,
                nas_ip_address,
                framed_ip_address,
                calling_station_id,
                rx,
                tx,
                ses_time,
                now_iso,
                now_iso if status_type == "Stop" else None,
                terminate_cause,
            ),
        )

        if sub.get("voucher_id"):
            conn.execute(
                "UPDATE sessions SET bytes_in = ?, bytes_out = ? WHERE voucher_id = ? AND status = 'ACTIVE'",
                (rx, tx, str(sub["voucher_id"])),
            )

        quota_exceeded = False
        if sub.get("data_limit_mb") is not None and int(sub["data_limit_mb"]) > 0:
            limit_bytes = int(sub["data_limit_mb"]) * 1024 * 1024
            if rx + tx >= limit_bytes:
                quota_exceeded = True
                conn.execute(
                    "UPDATE subscriptions SET status = 'EXPIRED', updated_at = ? WHERE id = ?",
                    (now_iso, str(sub["id"])),
                )
                conn.execute(
                    "UPDATE radcheck SET is_active = 0 WHERE username = ? AND business_id = ?",
                    (acct_username, str(sub["business_id"])),
                )

        return {"ok": True, "quotaExceeded": quota_exceeded, "businessId": str(sub["business_id"])}

    return db.transaction(_tx)


def suspend_subscription_and_disconnect(
    db: DatabaseManager, subscription_id: str, business_id: str, reason: str = "Suspended by administrator"
) -> None:
    sub = db.query_one("SELECT * FROM subscriptions WHERE id = ?", (subscription_id,))
    if not sub:
        raise ValueError("Subscription not found")
    if str(sub["business_id"]) != business_id:
        raise PermissionError("CROSS_TENANT_FORBIDDEN")

    now_iso = utc_now_iso()

    def _tx(conn: sqlite3.Connection) -> None:
        conn.execute(
            "UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE id = ?",
            (now_iso, now_iso, subscription_id),
        )
        conn.execute(
            "UPDATE radcheck SET is_active = 0 WHERE username = ? AND business_id = ?",
            (str(sub["radius_username"]), business_id),
        )
        if sub.get("voucher_id"):
            conn.execute(
                """
                UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = ?, updated_at = ?
                WHERE id = ? AND status != 'REVOKED'
                """,
                (now_iso, reason, now_iso, str(sub["voucher_id"])),
            )
            conn.execute(
                """
                UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = ?
                WHERE voucher_id = ? AND status = 'ACTIVE'
                """,
                (now_iso, reason, str(sub["voucher_id"])),
            )

    db.transaction(_tx)

    # Active RouterOS disconnect
    if sub.get("voucher_id"):
        active_sess = db.query_all(
            "SELECT router_id, ip_address FROM sessions WHERE voucher_id = ? AND router_id IS NOT NULL",
            (str(sub["voucher_id"]),),
        )
        for s in active_sess:
            if s.get("router_id") and s.get("ip_address"):
                terminate_router_session(db, str(s["router_id"]), str(s["ip_address"]))

    # Optional RFC 5176 RADIUS CoA Disconnect if an active radacct NAS session exists
    active_rad = db.query_one(
        """
        SELECT acct_session_id, nas_ip_address
        FROM radacct
        WHERE username = ? AND business_id = ? AND acct_stop_time IS NULL AND nas_ip_address IS NOT NULL
        ORDER BY acct_start_time DESC LIMIT 1
        """,
        (str(sub["radius_username"]), business_id),
    )
    if active_rad and active_rad.get("nas_ip_address"):
        router_secret_row = db.query_one(
            "SELECT radius_secret FROM routers WHERE business_id = ? AND radius_secret IS NOT NULL LIMIT 1",
            (business_id,),
        )
        secret = (
            str(router_secret_row["radius_secret"])
            if router_secret_row and router_secret_row.get("radius_secret")
            else os.environ.get("RADIUS_SHARED_SECRET", "")
        )
        if secret:
            send_radius_disconnect(
                db,
                business_id=business_id,
                nas_ip=str(active_rad["nas_ip_address"]),
                username=str(sub["radius_username"]),
                shared_secret=secret,
                acct_session_id=str(active_rad["acct_session_id"]),
            )
