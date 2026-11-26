"""Atomic single-use, single-device-name voucher engine in Python."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone
from typing import Any

from ..db import DatabaseManager, expire_stale_records, utc_now_iso
from ..security import (
    decrypt_secret,
    encrypt_secret,
    generate_id,
    generate_reference,
    generate_session_token,
    generate_voucher_code,
    mask_voucher_code,
    normalize_voucher_code,
    sha256_hex,
)


class VoucherError(Exception):
    def __init__(self, message: str, status_code: int = 400, code: str = "VOUCHER_ERROR"):
        super().__init__(message)
        self.message = message
        self.status_code = status_code
        self.code = code


def create_voucher_batch(
    db: DatabaseManager,
    package_id: str,
    count: int,
    customer_id: str | None = None,
    created_by_id: str | None = None,
    business_id: str | None = None,
    is_test: bool = False,
    test_note: str | None = None,
) -> dict[str, Any]:
    if count < 1 or count > 500:
        raise VoucherError("Batch count must be between 1 and 500", 400, "INVALID_COUNT")

    pkg = db.query_one(
        "SELECT id, business_id, name, is_active FROM packages WHERE id = ?", (package_id,)
    )
    if not pkg:
        raise VoucherError("Assigned package not found", 404, "PACKAGE_NOT_FOUND")
    if business_id and str(pkg["business_id"]) != business_id:
        raise VoucherError("Package belongs to a different business workspace", 403, "CROSS_TENANT_FORBIDDEN")

    tenant_business_id = str(pkg["business_id"])
    if customer_id:
        cust = db.query_one("SELECT id, business_id FROM customers WHERE id = ?", (customer_id,))
        if not cust:
            raise VoucherError("Assigned customer not found", 404, "CUSTOMER_NOT_FOUND")
        if str(cust["business_id"]) != tenant_business_id:
            raise VoucherError("Customer belongs to a different business workspace", 403, "CROSS_TENANT_FORBIDDEN")

    note = (test_note or "").strip() or "Admin-issued development test voucher" if is_test else None
    batch_id = (
        generate_reference("TEST" if is_test else "BATCH")
        if (count > 1 or is_test)
        else None
    )
    now_iso = utc_now_iso()

    def _tx(conn: sqlite3.Connection) -> dict[str, Any]:
        created: list[dict[str, Any]] = []
        for _ in range(count):
            code = generate_voucher_code()
            code_hash = sha256_hex(code)
            while conn.execute("SELECT 1 FROM vouchers WHERE code_hash = ?", (code_hash,)).fetchone():
                code = generate_voucher_code()
                code_hash = sha256_hex(code)

            vid = generate_id("vch")
            masked = mask_voucher_code(code)
            conn.execute(
                """
                INSERT INTO vouchers (
                  id, business_id, code_hash, code_encrypted, code_masked, batch_id,
                  package_id, customer_id, status, is_test, test_note, created_by_id, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', ?, ?, ?, ?, ?)
                """,
                (
                    vid,
                    tenant_business_id,
                    code_hash,
                    encrypt_secret(code),
                    masked,
                    batch_id,
                    pkg["id"],
                    customer_id,
                    1 if is_test else 0,
                    note,
                    created_by_id,
                    now_iso,
                    now_iso,
                ),
            )
            created.append(
                {
                    "id": vid,
                    "businessId": tenant_business_id,
                    "code": code,
                    "codeMasked": masked,
                    "batchId": batch_id,
                    "packageId": pkg["id"],
                    "packageName": pkg["name"],
                    "status": "UNUSED",
                    "isTest": bool(is_test),
                    "createdAt": now_iso,
                }
            )
        return {"batchId": batch_id, "vouchers": created}

    return db.transaction(_tx)


def validate_voucher_code(db: DatabaseManager, code: str) -> dict[str, Any]:
    expire_stale_records(db)
    norm = normalize_voucher_code(code)
    if len(norm) < 6:
        raise VoucherError("Enter a valid voucher code.", 400, "INVALID_CODE")

    row = db.query_one(
        """
        SELECT v.id, v.business_id, v.code_masked, v.status, v.bound_device_id, v.bound_device_name,
               v.is_test, v.test_note, v.created_at, v.activated_at, v.expires_at,
               v.revoked_at, v.revoked_reason,
               p.name as package_name, p.category, p.price_tzs, p.duration_minutes,
               p.download_kbps, p.upload_kbps, p.data_limit_mb,
               b.name as business_name
        FROM vouchers v
        JOIN packages p ON p.id = v.package_id
        LEFT JOIN businesses b ON b.id = v.business_id
        WHERE v.code_hash = ?
        """,
        (sha256_hex(norm),),
    )
    if not row:
        raise VoucherError("Voucher code not recognized.", 404, "VOUCHER_NOT_FOUND")

    status = str(row["status"])
    return {
        "valid": status == "UNUSED",
        "status": status,
        "businessId": str(row["business_id"]),
        "businessName": str(row["business_name"] or "TRAX LINK Hotspot"),
        "codeMasked": str(row["code_masked"]),
        "packageName": str(row["package_name"]),
        "category": str(row["category"]),
        "priceTzs": int(row["price_tzs"]),
        "durationMinutes": int(row["duration_minutes"]),
        "downloadKbps": int(row["download_kbps"]),
        "uploadKbps": int(row["upload_kbps"]),
        "dataLimitMb": int(row["data_limit_mb"]) if row["data_limit_mb"] is not None else None,
        "isBoundToDevice": bool(row["bound_device_id"]),
        "boundDeviceName": str(row["bound_device_name"]) if row["bound_device_name"] else None,
        "isTest": bool(row["is_test"]),
        "testNote": str(row["test_note"]) if row["test_note"] else None,
        "createdAt": str(row["created_at"]),
        "activatedAt": str(row["activated_at"]) if row["activated_at"] else None,
        "expiresAt": str(row["expires_at"]) if row["expires_at"] else None,
        "revokedReason": str(row["revoked_reason"]) if row["revoked_reason"] else None,
    }


def redeem_voucher_for_device(
    db: DatabaseManager,
    code: str,
    device_fingerprint: str,
    mac_address: str | None = None,
    user_agent: str | None = None,
    device_label: str | None = None,
    ip_address: str | None = None,
    router_id: str | None = None,
) -> dict[str, Any]:
    expire_stale_records(db)
    norm = normalize_voucher_code(code)
    if len(norm) < 6:
        raise VoucherError("Enter a valid voucher code.", 400, "INVALID_CODE")

    fp = device_fingerprint.strip()
    if len(fp) < 8 or len(fp) > 256:
        raise VoucherError(
            "Valid device identifier is required for one-device enforcement.",
            400,
            "INVALID_DEVICE",
        )

    clean_device_name = (device_label or "").strip()
    if len(clean_device_name) < 2 or len(clean_device_name) > 120:
        raise VoucherError(
            "Device name is required (at least 2 characters). Each voucher code can only be used once on one device name.",
            400,
            "DEVICE_NAME_REQUIRED",
        )

    code_hash = sha256_hex(norm)
    now = datetime.now(timezone.utc)
    now_iso = now.isoformat(timespec="milliseconds").replace("+00:00", "Z")

    def _tx(conn: sqlite3.Connection) -> dict[str, Any]:
        voucher_row = conn.execute(
            """
            SELECT v.*, p.name as package_name, p.duration_minutes, p.download_kbps, p.upload_kbps,
                   p.data_limit_mb, p.category, b.name as business_name
            FROM vouchers v
            JOIN packages p ON p.id = v.package_id
            LEFT JOIN businesses b ON b.id = v.business_id
            WHERE v.code_hash = ?
            """,
            (code_hash,),
        ).fetchone()

        if not voucher_row:
            raise VoucherError("Voucher code not recognized.", 404, "VOUCHER_NOT_FOUND")
        voucher = dict(voucher_row)
        business_id = str(voucher["business_id"])

        dev_row = conn.execute("SELECT * FROM devices WHERE device_fingerprint = ?", (fp,)).fetchone()
        if not dev_row:
            device_id = generate_id("dev")
            conn.execute(
                """
                INSERT INTO devices (id, business_id, device_fingerprint, mac_address, user_agent, device_label, customer_id, first_seen_at, last_seen_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    device_id,
                    business_id,
                    fp,
                    mac_address,
                    user_agent,
                    clean_device_name,
                    voucher.get("customer_id"),
                    now_iso,
                    now_iso,
                ),
            )
            device = dict(conn.execute("SELECT * FROM devices WHERE id = ?", (device_id,)).fetchone())
        else:
            device = dict(dev_row)
            device_id = str(device["id"])
            conn.execute(
                """
                UPDATE devices
                SET last_seen_at = ?,
                    mac_address = COALESCE(?, mac_address),
                    user_agent = COALESCE(?, user_agent),
                    device_label = COALESCE(device_label, ?)
                WHERE id = ?
                """,
                (now_iso, mac_address, user_agent, clean_device_name, device_id),
            )

        voucher_id = str(voucher["id"])
        voucher_status = str(voucher["status"])

        def log_redemption(success: bool, reason: str) -> None:
            conn.execute(
                """
                INSERT INTO voucher_redemptions (id, voucher_id, device_id, ip_address, success, reason, redeemed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (generate_id("red"), voucher_id, device_id, ip_address, 1 if success else 0, reason, now_iso),
            )

        if voucher_status == "REVOKED":
            log_redemption(False, "Voucher revoked")
            raise VoucherError("This voucher has been revoked by an administrator.", 403, "VOUCHER_REVOKED")

        if voucher_status == "EXPIRED" or (voucher["expires_at"] and str(voucher["expires_at"]) <= now_iso):
            if voucher_status != "EXPIRED":
                conn.execute("UPDATE vouchers SET status = 'EXPIRED', updated_at = ? WHERE id = ?", (now_iso, voucher_id))
            log_redemption(False, "Voucher expired / single-use already consumed")
            raise VoucherError("This voucher has expired and can no longer be used.", 403, "VOUCHER_EXPIRED")

        if voucher_status != "UNUSED" or voucher["activated_at"] is not None:
            bound_name = str(voucher["bound_device_name"] or device.get("device_label") or "authorized device")
            diff_device = (
                (voucher["bound_device_id"] and str(voucher["bound_device_id"]) != device_id)
                or (
                    voucher["bound_device_name"]
                    and str(voucher["bound_device_name"]).strip().lower() != clean_device_name.lower()
                )
            )
            log_redemption(
                False,
                f'Rejected ({clean_device_name}): single-use voucher already used once and locked to "{bound_name}"',
            )
            if diff_device:
                conn.execute(
                    """
                    INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
                    VALUES (?, ?, 'SUSPICIOUS_ACTIVITY', 'WARNING', ?, ?, ?)
                    """,
                    (
                        generate_id("ntf"),
                        business_id,
                        f"Multi-Device / Reuse Attempt Blocked ({voucher['code_masked']})",
                        f'Device "{clean_device_name}" ({ip_address or fp[:10]}) tried to reuse a single-use voucher locked to "{bound_name}".',
                        json.dumps(
                            {
                                "voucherId": voucher_id,
                                "attemptedDeviceId": device_id,
                                "attemptedDeviceName": clean_device_name,
                                "boundDeviceId": voucher.get("bound_device_id"),
                                "boundDeviceName": bound_name,
                            }
                        ),
                    ),
                )
                raise VoucherError(
                    f'This voucher code has already been used once and is locked to "{bound_name}". Only one device name is allowed.',
                    409,
                    "DEVICE_LIMIT_REACHED",
                )
            raise VoucherError(
                f'This voucher code can only be used once and has already been activated on "{bound_name}".',
                409,
                "VOUCHER_ALREADY_USED",
            )

        expires_at = (
            (now + timedelta(minutes=int(voucher["duration_minutes"])))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        session_token = generate_session_token()
        session_id = generate_id("ses")

        updated = conn.execute(
            """
            UPDATE vouchers
            SET status = 'ACTIVE', bound_device_id = ?, bound_device_name = ?,
                activated_at = ?, expires_at = ?, updated_at = ?
            WHERE id = ? AND status = 'UNUSED' AND activated_at IS NULL
            """,
            (device_id, clean_device_name, now_iso, expires_at, now_iso, voucher_id),
        )
        if int(updated.rowcount or 0) != 1:
            raise VoucherError("This voucher code has already been used.", 409, "VOUCHER_ALREADY_USED")

        conn.execute(
            """
            INSERT INTO sessions (
              id, business_id, session_token, voucher_id, device_id, customer_id, router_id,
              ip_address, status, started_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
            """,
            (
                session_id,
                business_id,
                session_token,
                voucher_id,
                device_id,
                voucher.get("customer_id"),
                router_id,
                ip_address,
                now_iso,
                expires_at,
            ),
        )
        log_redemption(True, f'Single-use activation locked to device name "{clean_device_name}"')

        conn.execute(
            """
            INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
            VALUES (?, ?, 'VOUCHER_ACTIVATED', 'INFO', ?, ?, ?)
            """,
            (
                generate_id("ntf"),
                business_id,
                f"Voucher Activated ({voucher['code_masked']})",
                f'Package {voucher["package_name"]} activated once and locked to device "{clean_device_name}".',
                json.dumps(
                    {
                        "voucherId": voucher_id,
                        "sessionId": session_id,
                        "deviceId": device_id,
                        "boundDeviceName": clean_device_name,
                    }
                ),
            ),
        )

        return {
            "reconnected": False,
            "sessionId": session_id,
            "sessionToken": session_token,
            "businessId": business_id,
            "businessName": str(voucher.get("business_name") or "TRAX LINK Hotspot"),
            "voucherId": voucher_id,
            "codeMasked": str(voucher["code_masked"]),
            "packageName": str(voucher["package_name"]),
            "category": str(voucher["category"]),
            "downloadKbps": int(voucher["download_kbps"]),
            "uploadKbps": int(voucher["upload_kbps"]),
            "dataLimitMb": int(voucher["data_limit_mb"]) if voucher["data_limit_mb"] is not None else None,
            "deviceLabel": clean_device_name,
            "startedAt": now_iso,
            "expiresAt": expires_at,
        }

    return db.transaction(_tx)


def decrypt_voucher_code_safe(encrypted_code: str) -> str | None:
    try:
        return decrypt_secret(encrypted_code)
    except Exception:
        return None
