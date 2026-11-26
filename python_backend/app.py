"""Complete HTTP request router for TRAX LINK Python WiFi Billing & Network Management API."""

from __future__ import annotations

import csv
import hmac
import io
import json
import platform
import re
import secrets
import sqlite3
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler
from typing import Any, Callable

from .auth import (
    ALL_BUSINESS_ROLES,
    BUSINESS_MANAGEMENT_ROLES,
    FINANCE_ROLES,
    NETWORK_ROLES,
    AuthenticatedActor,
    authenticate_bearer_token,
    get_client_ip,
    record_audit_log,
    resolve_tenant_scope,
)
from .config import get_env
from .db import (
    DEFAULT_BUSINESS_ID,
    DatabaseManager,
    expire_stale_records,
    get_operating_mode,
    set_operating_mode,
    utc_now_iso,
)
from .rate_limit import RateLimiter
from .security import (
    decrypt_secret,
    encrypt_secret,
    generate_id,
    generate_reference,
    generate_session_token,
    hash_password,
    sha256_hex,
    verify_password,
)
from .services.billing import (
    authorize_radius_request,
    create_invoice_for_payment,
    ingest_radius_accounting,
    provision_subscription_for_activation,
    retry_provisioning_job,
    suspend_subscription_and_disconnect,
)
from .services.mikrotik import (
    generate_mikrotik_wireguard_snippet,
    push_hotspot_profile_to_router,
    sync_router_telemetry,
    terminate_router_session,
)
from .services.payments import (
    SUPPORTED_PROVIDERS,
    confirm_standalone_payment_for_token,
    get_provider_statuses,
    initiate_payment,
    process_verified_payment_callback,
    verify_webhook_signature,
)
from .services.vouchers import (
    VoucherError,
    create_voucher_batch,
    decrypt_voucher_code_safe,
    redeem_voucher_for_device,
    validate_voucher_code,
)
from .validators import clean_bool, clean_enum, clean_int, clean_opt_str, clean_str, is_valid_email

ALL_STAFF_ROLES = set(ALL_BUSINESS_ROLES)


def _verify_radius_secret(headers: Any) -> bool:
    configured = get_env("RADIUS_SHARED_SECRET")
    if not configured:
        return False
    provided = str(headers.get("x-radius-secret") or headers.get("X-Radius-Secret") or "").strip()
    if not provided:
        return False
    return hmac.compare_digest(configured.encode("utf-8"), provided.encode("utf-8"))


def _slugify(name: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", name.strip().lower()).strip("-")[:36]
    return slug or "wifi-biz"


def _csv_response(headers_row: list[str], rows: list[list[Any]]) -> bytes:
    buf = io.StringIO()
    writer = csv.writer(buf, lineterminator="\n")
    writer.writerow(headers_row)
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    return buf.getvalue().encode("utf-8")


def make_handler_class(
    db: DatabaseManager,
    started_at: float,
    auth_limiter: RateLimiter,
    portal_limiter: RateLimiter,
    event_callback: Callable[[str, dict[str, Any]], None] | None = None,
) -> type[BaseHTTPRequestHandler]:
    class TraxRequestHandler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, format: str, *args: Any) -> None:
            # Suppress noisy default stderr request logging during tests/production
            pass

        def _parse_url(self) -> tuple[str, dict[str, str]]:
            parsed = urllib.parse.urlsplit(self.path)
            qs = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
            flat_qs = {k: v[0] for k, v in qs.items() if v}
            return parsed.path, flat_qs

        def _read_body_bytes(self) -> tuple[bytes, str | None]:
            raw_len = self.headers.get("Content-Length")
            if not raw_len:
                return b"", None
            try:
                length = int(raw_len)
            except ValueError:
                return b"", "Invalid Content-Length header"
            if length > 1_048_576:
                return b"", "Request payload exceeds 1MB limit"
            if length <= 0:
                return b"", None
            return self.rfile.read(length), None

        def _read_json(self) -> tuple[dict[str, Any] | None, bytes, tuple[int, str] | None]:
            raw_bytes, err = self._read_body_bytes()
            if err:
                return None, raw_bytes, (400, err)
            if not raw_bytes:
                return {}, raw_bytes, None
            try:
                data = json.loads(raw_bytes.decode("utf-8"))
                if not isinstance(data, dict):
                    return None, raw_bytes, (400, "JSON body must be an object")
                return data, raw_bytes, None
            except (UnicodeDecodeError, json.JSONDecodeError):
                return None, raw_bytes, (400, "Invalid JSON request payload")

        def _emit(self, events_out: list[dict[str, Any]], event: str, payload: dict[str, Any]) -> None:
            events_out.append({"event": event, "payload": payload})
            if event_callback:
                try:
                    event_callback(event, payload)
                except Exception:
                    pass

        def _send_json(
            self,
            status: int,
            payload: dict[str, Any],
            events_out: list[dict[str, Any]] | None = None,
        ) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
            self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
            self.send_header("X-Backend-Engine", "Python-3.11-TraxLink")
            if events_out:
                self.send_header("X-Trax-Events", json.dumps(events_out))
            self.end_headers()
            self.wfile.write(body)

        def _send_csv(self, filename: str, content: bytes) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Content-Length", str(len(content)))
            self.send_header("X-Content-Type-Options", "nosniff")
            self.end_headers()
            self.wfile.write(content)

        def _require_auth(
            self, allowed_roles: tuple[str, ...] | None = None
        ) -> AuthenticatedActor | None:
            actor, err = authenticate_bearer_token(
                db, self.headers.get("Authorization") or self.headers.get("authorization")
            )
            if err or not actor:
                status, msg = err or (401, "Authentication required")
                self._send_json(status, {"error": msg})
                return None
            if allowed_roles and actor.role not in allowed_roles:
                self._send_json(
                    403,
                    {"error": f"Insufficient permissions. Required role: {' or '.join(allowed_roles)}"},
                )
                return None
            return actor

        def _resolve_scope(
            self,
            actor: AuthenticatedActor,
            qs: dict[str, str],
            body: dict[str, Any] | None,
            path: str,
        ) -> str | None:
            biz_id, err = resolve_tenant_scope(
                db,
                actor,
                self.headers,
                qs,
                body,
                get_client_ip(self.headers, self.client_address),
                path,
            )
            if err or not biz_id:
                status, msg = err or (403, "Cross-tenant access denied")
                self._send_json(status, {"error": msg})
                return None
            return biz_id

        def _check_limit(self, limiter: RateLimiter, bucket: str) -> bool:
            ip = get_client_ip(self.headers, self.client_address)
            if not limiter.allow(f"{bucket}:{ip}"):
                self._send_json(429, {"error": "Too many requests. Please wait a moment and try again."})
                return False
            return True

        def do_GET(self) -> None:
            self._dispatch("GET")

        def do_POST(self) -> None:
            self._dispatch("POST")

        def do_PATCH(self) -> None:
            self._dispatch("PATCH")

        def do_DELETE(self) -> None:
            self._dispatch("DELETE")

        def _dispatch(self, method: str) -> None:
            path, qs = self._parse_url()
            events: list[dict[str, Any]] = []
            ip = get_client_ip(self.headers, self.client_address)

            try:
                # ---------------------------------------------------------------
                # HEALTH & SYSTEM MODE
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/health":
                    return self._send_json(
                        200,
                        {
                            "status": "ok",
                            "service": "TRAX LINK",
                            "engine": "python",
                            "pythonVersion": platform.python_version(),
                            "operatingMode": get_operating_mode(db),
                            "timestamp": utc_now_iso(),
                        },
                    )

                if method == "GET" and path == "/api/system/mode":
                    mode = get_operating_mode(db)
                    biz_filter = (qs.get("businessId") or "").strip()
                    if biz_filter:
                        counts = db.query_one(
                            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END) as connected FROM routers WHERE business_id = ?",
                            (biz_filter,),
                        )
                    else:
                        counts = db.query_one(
                            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END) as connected FROM routers"
                        )
                    r_count = int((counts or {}).get("total") or 0)
                    c_count = int((counts or {}).get("connected") or 0)
                    return self._send_json(
                        200,
                        {
                            "operatingMode": mode,
                            "routerCount": r_count,
                            "connectedRouterCount": c_count,
                            "routerStatusMessage": (
                                f"{c_count} MikroTik router(s) connected"
                                if c_count > 0
                                else "No MikroTik router connected"
                            ),
                            "airtelPocketWifiNotice": "Standalone Mode enforces database voucher & one-device session tracking only. It does not directly control or restrict internet access on an Airtel Pocket WiFi.",
                        },
                    )

                if method == "PATCH" and path == "/api/system/mode":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    mode_val = clean_enum(body.get("operatingMode"), {"STANDALONE_MODE", "MIKROTIK_MODE"})
                    if not mode_val:
                        return self._send_json(400, {"error": "operatingMode must be STANDALONE_MODE or MIKROTIK_MODE"})
                    updated = set_operating_mode(db, mode_val)
                    record_audit_log(
                        db, actor, "SYSTEM_MODE_CHANGED", "SystemSetting", "operating_mode", ip, {"operatingMode": updated}
                    )
                    self._emit(events, "router:status", {"operatingMode": updated})
                    return self._send_json(200, {"operatingMode": updated}, events)

                # ---------------------------------------------------------------
                # AUTHENTICATION & ONBOARDING
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/auth/bootstrap-status":
                    existing_pw = db.query_one(
                        "SELECT id FROM admin_users WHERE role = 'SUPER_ADMIN' AND password_hash IS NOT NULL LIMIT 1"
                    )
                    env_pass = get_env("ADMIN_INITIAL_PASSCODE")
                    return self._send_json(
                        200,
                        {
                            "needsPasswordBootstrap": not existing_pw and not env_pass,
                            "envPasscodeConfigured": bool(env_pass),
                        },
                    )

                if method == "POST" and path == "/api/auth/bootstrap":
                    if not self._check_limit(auth_limiter, "auth"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    email = body.get("email")
                    full_name = clean_str(body.get("fullName"), 2, 100)
                    password = clean_str(body.get("password"), 8, 128)
                    setup_passcode = clean_opt_str(body.get("setupPasscode"), 128)
                    if not is_valid_email(email) or not full_name or not password:
                        return self._send_json(400, {"error": "Invalid registration details"})

                    existing_pw = db.query_one(
                        "SELECT id FROM admin_users WHERE role = 'SUPER_ADMIN' AND password_hash IS NOT NULL LIMIT 1"
                    )
                    if existing_pw:
                        return self._send_json(409, {"error": "Super Admin password account is already claimed."})
                    env_pass = get_env("ADMIN_INITIAL_PASSCODE")
                    if env_pass and setup_passcode != env_pass:
                        return self._send_json(403, {"error": "Invalid initial admin setup passcode."})

                    email_lower = str(email).strip().lower()
                    now_iso = utc_now_iso()
                    pw_hash = hash_password(password)

                    def _boot_tx(conn: sqlite3.Connection) -> str:
                        existing = conn.execute(
                            "SELECT id FROM admin_users WHERE LOWER(email) = ?", (email_lower,)
                        ).fetchone()
                        if existing:
                            conn.execute(
                                """
                                UPDATE admin_users
                                SET password_hash = ?, full_name = ?, role = 'SUPER_ADMIN', business_id = ?,
                                    is_active = 1, last_login_at = ?, updated_at = ?
                                WHERE id = ?
                                """,
                                (pw_hash, full_name, DEFAULT_BUSINESS_ID, now_iso, now_iso, existing["id"]),
                            )
                            return str(existing["id"])
                        aid = generate_id("adm")
                        conn.execute(
                            """
                            INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 1, ?, ?, ?)
                            """,
                            (aid, DEFAULT_BUSINESS_ID, email_lower, full_name, pw_hash, now_iso, now_iso, now_iso),
                        )
                        code_exists = conn.execute("SELECT id FROM staff WHERE staff_code = ?", ("STF-001",)).fetchone()
                        staff_code = generate_reference("STF") if code_exists else "STF-001"
                        conn.execute(
                            """
                            INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, role)
                            VALUES (?, ?, ?, ?, 'Executive Operations', 'SUPER_ADMIN')
                            """,
                            (generate_id("stf"), DEFAULT_BUSINESS_ID, aid, staff_code),
                        )
                        return aid

                    admin_id = db.transaction(_boot_tx)
                    raw_token = generate_session_token()
                    expires_at = (
                        (datetime.now(timezone.utc) + timedelta(hours=24))
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )
                    db.execute(
                        """
                        INSERT INTO staff_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            generate_id("ss"),
                            admin_id,
                            sha256_hex(raw_token),
                            ip,
                            self.headers.get("User-Agent"),
                            expires_at,
                        ),
                    )
                    record_audit_log(
                        db,
                        {"id": admin_id, "businessId": DEFAULT_BUSINESS_ID, "email": email_lower, "role": "SUPER_ADMIN"},
                        "ADMIN_BOOTSTRAP",
                        "AdminUser",
                        admin_id,
                        ip,
                    )
                    return self._send_json(
                        201,
                        {
                            "token": raw_token,
                            "expiresAt": expires_at,
                            "user": {
                                "id": admin_id,
                                "businessId": DEFAULT_BUSINESS_ID,
                                "businessName": "TRAX LINK Primary Hotspot",
                                "businessStatus": "ACTIVE",
                                "email": email_lower,
                                "fullName": full_name,
                                "role": "SUPER_ADMIN",
                            },
                        },
                    )

                if method == "POST" and path == "/api/auth/login":
                    if not self._check_limit(auth_limiter, "auth"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    email = body.get("email")
                    password = body.get("password")
                    if not is_valid_email(email) or not isinstance(password, str) or not (1 <= len(password) <= 128):
                        return self._send_json(400, {"error": "Valid email and password are required"})

                    email_lower = str(email).strip().lower()
                    user = db.query_one(
                        """
                        SELECT u.*, st.is_suspended, b.name as business_name, b.status as business_status
                        FROM admin_users u
                        LEFT JOIN staff st ON st.admin_user_id = u.id
                        LEFT JOIN businesses b ON b.id = u.business_id
                        WHERE LOWER(u.email) = ?
                        """,
                        (email_lower,),
                    )
                    if not user or not user.get("password_hash") or not verify_password(password, str(user["password_hash"])):
                        return self._send_json(401, {"error": "Invalid email or password"})
                    if not user["is_active"] or user.get("is_suspended"):
                        return self._send_json(403, {"error": "Account is suspended or deactivated"})
                    role = str(user["role"])
                    biz_status = str(user.get("business_status") or "ACTIVE")
                    if role != "SUPER_ADMIN" and biz_status == "SUSPENDED":
                        return self._send_json(403, {"error": "Business workspace is suspended. Contact TRAX LINK support."})

                    biz_id = str(user.get("business_id") or DEFAULT_BUSINESS_ID)
                    now_iso = utc_now_iso()
                    raw_token = generate_session_token()
                    expires_at = (
                        (datetime.now(timezone.utc) + timedelta(hours=24))
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )
                    db.execute(
                        "UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?",
                        (now_iso, now_iso, str(user["id"])),
                    )
                    db.execute(
                        """
                        INSERT INTO staff_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        """,
                        (
                            generate_id("ss"),
                            str(user["id"]),
                            sha256_hex(raw_token),
                            ip,
                            self.headers.get("User-Agent"),
                            expires_at,
                        ),
                    )
                    record_audit_log(
                        db,
                        {"id": str(user["id"]), "businessId": biz_id, "email": str(user["email"]), "role": role},
                        "STAFF_LOGIN",
                        "AdminUser",
                        str(user["id"]),
                        ip,
                    )
                    return self._send_json(
                        200,
                        {
                            "token": raw_token,
                            "expiresAt": expires_at,
                            "user": {
                                "id": str(user["id"]),
                                "businessId": biz_id,
                                "businessName": str(user.get("business_name") or "TRAX LINK Primary Hotspot"),
                                "businessStatus": biz_status,
                                "email": str(user["email"]),
                                "fullName": str(user["full_name"]),
                                "role": role,
                            },
                        },
                    )

                if method == "POST" and path == "/api/auth/logout":
                    actor = self._require_auth()
                    if not actor:
                        return
                    auth_hdr = self.headers.get("Authorization") or ""
                    token = auth_hdr[len("Bearer ") :].strip()
                    if token and actor.auth_source == "SESSION":
                        db.execute(
                            "UPDATE staff_sessions SET revoked_at = ? WHERE token_hash = ?",
                            (utc_now_iso(), sha256_hex(token)),
                        )
                    record_audit_log(db, actor, "STAFF_LOGOUT", "AdminUser", actor.id, ip)
                    return self._send_json(200, {"ok": True})

                if method == "GET" and path == "/api/auth/me":
                    actor = self._require_auth()
                    if not actor:
                        return
                    return self._send_json(200, {"user": actor.to_dict()})

                if method == "POST" and path == "/api/auth/forgot-password":
                    if not self._check_limit(auth_limiter, "auth"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    email = body.get("email")
                    if not is_valid_email(email):
                        return self._send_json(400, {"error": "Please enter a valid staff email address"})
                    email_lower = str(email).strip().lower()
                    now_iso = utc_now_iso()
                    user = db.query_one(
                        """
                        SELECT u.id, u.business_id, u.email, u.full_name, u.role, u.is_active, st.is_suspended
                        FROM admin_users u
                        LEFT JOIN staff st ON st.admin_user_id = u.id
                        WHERE LOWER(u.email) = ?
                        """,
                        (email_lower,),
                    )
                    email_sent = False
                    if user and user["is_active"] and not user.get("is_suspended"):
                        raw_code = secrets.token_hex(4).upper()
                        formatted = f"{raw_code[:4]}-{raw_code[4:8]}"
                        expires_at = (
                            (datetime.now(timezone.utc) + timedelta(minutes=15))
                            .isoformat(timespec="milliseconds")
                            .replace("+00:00", "Z")
                        )
                        biz_id = str(user.get("business_id") or DEFAULT_BUSINESS_ID)

                        def _forgot_tx(conn: sqlite3.Connection) -> None:
                            conn.execute(
                                "UPDATE password_reset_tokens SET used_at = ? WHERE admin_user_id = ? AND used_at IS NULL",
                                (now_iso, str(user["id"])),
                            )
                            conn.execute(
                                "INSERT INTO password_reset_tokens (id, admin_user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?, ?)",
                                (generate_id("prt"), str(user["id"]), sha256_hex(raw_code), expires_at, ip),
                            )
                            conn.execute(
                                "INSERT INTO notifications (id, business_id, type, severity, title, message, metadata) VALUES (?, ?, 'SECURITY', 'WARN', 'Staff Password Reset Requested', ?, ?)",
                                (
                                    generate_id("ntf"),
                                    biz_id,
                                    f"A password reset was requested for {user['email']} from IP {ip}.",
                                    json.dumps({"email": user["email"], "expiresAt": expires_at}),
                                ),
                            )

                        db.transaction(_forgot_tx)
                        record_audit_log(
                            db,
                            {"id": str(user["id"]), "businessId": biz_id, "email": str(user["email"]), "role": str(user["role"])},
                            "PASSWORD_RESET_REQUESTED",
                            "AdminUser",
                            str(user["id"]),
                            ip,
                        )
                        self._emit(events, "notification:new", {"type": "SECURITY"})

                        resend_key = get_env("RESEND_API_KEY")
                        mail_from = get_env("MAIL_FROM", "TRAX LINK Security <no-reply@traxlink.co.tz>")
                        if resend_key:
                            try:
                                req = urllib.request.Request(
                                    "https://api.resend.com/emails",
                                    data=json.dumps(
                                        {
                                            "from": mail_from,
                                            "to": [str(user["email"])],
                                            "subject": "TRAX LINK Password Recovery Code",
                                            "text": f"Your TRAX LINK one-time password recovery code is: {formatted}\n\nThis code expires in 15 minutes.",
                                        }
                                    ).encode("utf-8"),
                                    headers={
                                        "Authorization": f"Bearer {resend_key}",
                                        "Content-Type": "application/json",
                                    },
                                    method="POST",
                                )
                                with urllib.request.urlopen(req, timeout=5) as r:
                                    email_sent = 200 <= r.status < 300
                            except Exception:
                                email_sent = False

                    return self._send_json(
                        200,
                        {
                            "ok": True,
                            "emailSent": email_sent,
                            "message": (
                                "Recovery code sent to your staff email address. Enter the code below within 15 minutes."
                                if email_sent
                                else "If an active staff account matches that email, a reset request has been logged. Enter the recovery code issued by your administrator (or sign in with Google Workspace)."
                            ),
                        },
                        events,
                    )

                if method == "POST" and path == "/api/auth/reset-password":
                    if not self._check_limit(auth_limiter, "auth"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    email = body.get("email")
                    code = clean_str(body.get("code"), 4, 64)
                    new_pw = clean_str(body.get("newPassword"), 8, 128)
                    if not is_valid_email(email) or not code or not new_pw:
                        return self._send_json(
                            400,
                            {"error": "Valid email, recovery code, and new password (min 8 characters) are required"},
                        )

                    email_lower = str(email).strip().lower()
                    norm_code = re.sub(r"[^A-Z0-9]", "", code.upper())
                    now_iso = utc_now_iso()
                    user = db.query_one(
                        """
                        SELECT u.id, u.business_id, u.email, u.role, u.is_active, st.is_suspended
                        FROM admin_users u LEFT JOIN staff st ON st.admin_user_id = u.id
                        WHERE LOWER(u.email) = ?
                        """,
                        (email_lower,),
                    )
                    if not user or not user["is_active"] or user.get("is_suspended"):
                        return self._send_json(400, {"error": "Invalid or expired recovery code"})

                    token_row = db.query_one(
                        "SELECT id, expires_at, used_at FROM password_reset_tokens WHERE admin_user_id = ? AND token_hash = ?",
                        (str(user["id"]), sha256_hex(norm_code)),
                    )
                    if not token_row or token_row.get("used_at") or str(token_row["expires_at"]) <= now_iso:
                        return self._send_json(400, {"error": "Invalid or expired recovery code"})

                    new_hash = hash_password(new_pw)

                    def _reset_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            "UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?",
                            (new_hash, now_iso, str(user["id"])),
                        )
                        conn.execute("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?", (now_iso, token_row["id"]))
                        conn.execute(
                            "UPDATE staff_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL",
                            (now_iso, str(user["id"])),
                        )

                    db.transaction(_reset_tx)
                    record_audit_log(
                        db,
                        {
                            "id": str(user["id"]),
                            "businessId": str(user.get("business_id") or DEFAULT_BUSINESS_ID),
                            "email": str(user["email"]),
                            "role": str(user["role"]),
                        },
                        "PASSWORD_RESET_COMPLETED",
                        "AdminUser",
                        str(user["id"]),
                        ip,
                    )
                    return self._send_json(200, {"ok": True, "message": "Password updated successfully. Please sign in."})

                if method == "POST" and path == "/api/auth/register-business":
                    if not self._check_limit(auth_limiter, "auth"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})

                    biz_name = clean_str(body.get("businessName"), 2, 120)
                    owner_name = clean_str(body.get("ownerName"), 2, 100)
                    owner_email = body.get("ownerEmail")
                    password = clean_str(body.get("password"), 8, 128)
                    phone = clean_str(body.get("phone"), 8, 24)
                    country = clean_str(body.get("country") or "Tanzania", 2, 60)
                    region = clean_str(body.get("region") or "Dar es Salaam", 2, 80)
                    plan_code = clean_str(body.get("planCode") or "STARTER", 2, 40)

                    if not biz_name or not owner_name or not is_valid_email(owner_email) or not password or not phone or not country or not region or not plan_code:
                        return self._send_json(400, {"error": "Invalid registration details"})

                    email_lower = str(owner_email).strip().lower()
                    if db.query_one("SELECT id FROM admin_users WHERE LOWER(email) = ?", (email_lower,)):
                        return self._send_json(409, {"error": "An account with this email already exists"})

                    base_slug = _slugify(biz_name)
                    slug = f"{base_slug}-{secrets.token_hex(2)}" if db.query_one("SELECT id FROM businesses WHERE slug = ?", (base_slug,)) else base_slug
                    plan = db.query_one("SELECT * FROM saas_plans WHERE code = ? AND is_active = 1", (plan_code.upper(),))
                    if not plan:
                        return self._send_json(400, {"error": "Selected SaaS plan is unavailable"})

                    now_iso = utc_now_iso()
                    trial_end = (
                        (datetime.now(timezone.utc) + timedelta(days=30))
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )
                    biz_id = generate_id("biz")
                    loc_id = generate_id("loc")
                    admin_id = generate_id("adm")
                    staff_id = generate_id("stf")
                    saas_sub_id = generate_id("ssub")
                    staff_code = generate_reference("STF")
                    pw_hash = hash_password(password)
                    raw_token = generate_session_token()
                    sess_exp = (
                        (datetime.now(timezone.utc) + timedelta(hours=24))
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )

                    def _reg_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            """
                            INSERT INTO businesses (
                              id, name, slug, email, phone, country, currency, status, timezone, hotspot_title, hotspot_support_phone, created_at, updated_at
                            ) VALUES (?, ?, ?, ?, ?, ?, 'TZS', 'ACTIVE', 'Africa/Dar_es_Salaam', ?, ?, ?, ?)
                            """,
                            (biz_id, biz_name, slug, email_lower, phone, country, f"{biz_name} WiFi", phone, now_iso, now_iso),
                        )
                        conn.execute(
                            """
                            INSERT INTO locations (id, business_id, name, region, address, contact_name, is_active, created_at, updated_at)
                            VALUES (?, ?, 'Main Hotspot Location', ?, 'Primary Site', ?, 1, ?, ?)
                            """,
                            (loc_id, biz_id, region, owner_name, now_iso, now_iso),
                        )
                        conn.execute(
                            """
                            INSERT INTO saas_subscriptions (
                              id, business_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at, updated_at
                            ) VALUES (?, ?, ?, 'TRIAL', 'MONTHLY', ?, ?, ?, ?)
                            """,
                            (saas_sub_id, biz_id, str(plan["id"]), now_iso, trial_end, now_iso, now_iso),
                        )
                        conn.execute(
                            """
                            INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, 'BUSINESS_OWNER', 1, ?, ?, ?)
                            """,
                            (admin_id, biz_id, email_lower, owner_name, pw_hash, now_iso, now_iso, now_iso),
                        )
                        conn.execute(
                            """
                            INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, phone, role, is_suspended)
                            VALUES (?, ?, ?, ?, 'Executive Management', ?, 'BUSINESS_OWNER', 0)
                            """,
                            (staff_id, biz_id, admin_id, staff_code, phone),
                        )
                        conn.execute(
                            """
                            INSERT INTO staff_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            """,
                            (generate_id("ss"), admin_id, sha256_hex(raw_token), ip, self.headers.get("User-Agent"), sess_exp),
                        )

                    db.transaction(_reg_tx)
                    record_audit_log(
                        db,
                        {"id": admin_id, "businessId": biz_id, "email": email_lower, "role": "BUSINESS_OWNER"},
                        "BUSINESS_REGISTERED",
                        "Business",
                        biz_id,
                        ip,
                        {"businessName": biz_name, "planCode": plan_code.upper()},
                    )
                    return self._send_json(
                        201,
                        {
                            "token": raw_token,
                            "expiresAt": sess_exp,
                            "user": {
                                "id": admin_id,
                                "businessId": biz_id,
                                "businessName": biz_name,
                                "businessStatus": "ACTIVE",
                                "email": email_lower,
                                "fullName": owner_name,
                                "role": "BUSINESS_OWNER",
                            },
                            "business": {
                                "id": biz_id,
                                "name": biz_name,
                                "slug": slug,
                                "status": "ACTIVE",
                                "planCode": plan_code.upper(),
                            },
                        },
                    )

                # ---------------------------------------------------------------
                # PUBLIC CAPTIVE PORTAL ENDPOINTS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/portal/businesses":
                    businesses = db.query_all(
                        """
                        SELECT id, name, slug, hotspot_title as hotspotTitle, hotspot_support_phone as hotspotSupportPhone, country, currency
                        FROM businesses WHERE status = 'ACTIVE' ORDER BY created_at ASC
                        """
                    )
                    return self._send_json(200, {"businesses": businesses})

                if method == "GET" and path == "/api/portal/packages":
                    biz_filter = (qs.get("businessId") or qs.get("business") or "").strip()
                    sql = """
                      SELECT pk.id, pk.business_id as businessId, b.name as businessName, b.slug as businessSlug,
                             pk.name, pk.description, pk.category, pk.package_type as packageType,
                             pk.price_tzs as priceTzs, pk.currency,
                             pk.duration_minutes as durationMinutes, pk.download_kbps as downloadKbps,
                             pk.upload_kbps as uploadKbps, pk.data_limit_mb as dataLimitMb,
                             pk.device_limit as deviceLimit, pk.simultaneous_sessions as simultaneousSessions,
                             pk.fup_policy as fupPolicy, pk.validity_days as validityDays
                      FROM packages pk
                      JOIN businesses b ON b.id = pk.business_id
                      WHERE pk.is_active = 1 AND b.status = 'ACTIVE'
                    """
                    params: tuple[Any, ...] = ()
                    if biz_filter:
                        sql += " AND (b.id = ? OR b.slug = ?)"
                        params = (biz_filter, biz_filter)
                    sql += " ORDER BY pk.price_tzs ASC"
                    return self._send_json(200, {"packages": db.query_all(sql, params)})

                if method == "GET" and path == "/api/portal/providers":
                    return self._send_json(200, {"providers": get_provider_statuses()})

                if method == "GET" and path == "/api/portal/account":
                    phone_digits = re.sub(r"\D", "", qs.get("phone") or "")
                    ref = (qs.get("reference") or "").strip().upper()
                    if (len(phone_digits) < 9) and (len(ref) < 4):
                        return self._send_json(400, {"error": "Enter your mobile number or payment reference to look up purchases."})
                    tail = phone_digits[-9:] if len(phone_digits) >= 9 else ""
                    rows = db.query_all(
                        """
                        SELECT p.reference, p.receipt_number as receiptNumber, p.provider, p.phone_number as phoneNumber,
                               p.amount_tzs as amountTzs, p.status, p.is_test as isTest, p.created_at as createdAt,
                               pk.name as packageName, b.name as businessName,
                               v.code_masked as voucherMasked, v.status as voucherStatus, v.expires_at as voucherExpiresAt,
                               v.code_encrypted as voucherEncrypted
                        FROM payments p
                        JOIN packages pk ON pk.id = p.package_id
                        JOIN businesses b ON b.id = p.business_id
                        LEFT JOIN vouchers v ON v.id = p.voucher_id
                        WHERE (? != '' AND p.phone_number LIKE ?) OR (? != '' AND p.reference = ?)
                        ORDER BY p.created_at DESC
                        LIMIT 15
                        """,
                        (tail, f"%{tail}", ref, ref),
                    )
                    purchases = []
                    for r in rows:
                        enc = r.pop("voucherEncrypted", None)
                        v_code = None
                        if r["status"] == "COMPLETED" and r.get("voucherStatus") == "UNUSED" and enc:
                            v_code = decrypt_voucher_code_safe(str(enc))
                        r["isTest"] = bool(r["isTest"])
                        r["voucherCode"] = v_code
                        purchases.append(r)
                    return self._send_json(200, {"purchases": purchases})

                if method == "POST" and path == "/api/portal/support":
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id_opt = clean_opt_str(body.get("businessId"), 64)
                    phone = clean_str(body.get("phone"), 8, 24)
                    subject = clean_str(body.get("subject"), 3, 120)
                    message = clean_str(body.get("message"), 5, 1000)
                    if not phone or not subject or not message:
                        return self._send_json(400, {"error": "Please complete phone, subject, and message"})

                    target_biz = (
                        db.query_one("SELECT id FROM businesses WHERE id = ? AND status = 'ACTIVE'", (biz_id_opt,))
                        if biz_id_opt
                        else db.query_one("SELECT id FROM businesses WHERE status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1")
                    )
                    if not target_biz:
                        return self._send_json(404, {"error": "Selected WiFi provider workspace not found"})

                    tid = generate_id("tkt")
                    now_iso = utc_now_iso()

                    def _sup_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            "INSERT INTO support_tickets (id, business_id, phone, subject, message, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)",
                            (tid, str(target_biz["id"]), phone, subject, message, now_iso, now_iso),
                        )
                        conn.execute(
                            "INSERT INTO notifications (id, business_id, type, severity, title, message, metadata) VALUES (?, ?, 'SUPPORT_TICKET', 'INFO', ?, ?, ?)",
                            (
                                generate_id("ntf"),
                                str(target_biz["id"]),
                                f"Customer Support: {subject}",
                                f"{phone}: {message[:140]}",
                                json.dumps({"ticketId": tid}),
                            ),
                        )

                    db.transaction(_sup_tx)
                    self._emit(events, "notification:new", {"type": "SUPPORT_TICKET", "businessId": str(target_biz["id"])})
                    return self._send_json(201, {"ok": True, "ticketId": tid}, events)

                if method == "POST" and path == "/api/portal/validate":
                    if not self._check_limit(portal_limiter, "portal"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    code = clean_str(body.get("code"), 4, 40)
                    if not code:
                        return self._send_json(400, {"error": "Enter a valid voucher code."})
                    try:
                        return self._send_json(200, {"validation": validate_voucher_code(db, code)})
                    except VoucherError as vex:
                        return self._send_json(vex.status_code, {"error": vex.message, "code": vex.code})

                if method == "POST" and path == "/api/portal/redeem":
                    if not self._check_limit(portal_limiter, "portal"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    code = clean_str(body.get("code"), 4, 40)
                    fp = clean_str(body.get("deviceFingerprint"), 8, 256)
                    mac = clean_opt_str(body.get("macAddress"), 32)
                    dev_label = clean_opt_str(body.get("deviceLabel"), 120)
                    if not code or not fp:
                        return self._send_json(400, {"error": "Invalid voucher or device payload"})
                    try:
                        result = redeem_voucher_for_device(
                            db,
                            code=code,
                            device_fingerprint=fp,
                            mac_address=mac,
                            user_agent=self.headers.get("User-Agent"),
                            device_label=dev_label,
                            ip_address=ip,
                        )
                        self._emit(
                            events,
                            "session:started",
                            {
                                "sessionId": result["sessionId"],
                                "businessId": result["businessId"],
                                "voucherId": result["voucherId"],
                                "packageName": result["packageName"],
                                "reconnected": result["reconnected"],
                            },
                        )
                        self._emit(events, "notification:new", {"type": "VOUCHER_ACTIVATED", "businessId": result["businessId"]})
                        return self._send_json(
                            200, {"session": {**result, "operatingMode": get_operating_mode(db)}}, events
                        )
                    except VoucherError as vex:
                        if vex.code in ("DEVICE_LIMIT_REACHED", "VOUCHER_ALREADY_USED"):
                            self._emit(events, "notification:new", {"type": "SUSPICIOUS_ACTIVITY"})
                        return self._send_json(vex.status_code, {"error": vex.message, "code": vex.code}, events)

                if method == "GET" and path == "/api/portal/session":
                    expire_stale_records(db)
                    auth_hdr = self.headers.get("Authorization") or ""
                    token = str(self.headers.get("x-portal-session") or "").strip()
                    if not token and auth_hdr.startswith("Bearer "):
                        token = auth_hdr[len("Bearer ") :].strip()
                    if not token:
                        return self._send_json(401, {"error": "No active portal session token"})

                    row = db.query_one(
                        """
                        SELECT s.*, v.code_masked, v.is_test as voucher_is_test, v.bound_device_name,
                               p.name as package_name, p.category,
                               p.download_kbps, p.upload_kbps, p.data_limit_mb,
                               d.device_label, d.device_fingerprint, b.name as business_name
                        FROM sessions s
                        JOIN vouchers v ON v.id = s.voucher_id
                        JOIN packages p ON p.id = v.package_id
                        JOIN devices d ON d.id = s.device_id
                        LEFT JOIN businesses b ON b.id = s.business_id
                        WHERE s.session_token = ?
                        """,
                        (token,),
                    )
                    if not row:
                        return self._send_json(404, {"error": "Session not found"})
                    remaining = 0
                    if row["status"] == "ACTIVE":
                        from .db import parse_iso_dt

                        remaining = max(0, int((parse_iso_dt(str(row["expires_at"])) - datetime.now(timezone.utc)).total_seconds()))
                    return self._send_json(
                        200,
                        {
                            "session": {
                                "sessionId": str(row["id"]),
                                "businessId": str(row.get("business_id") or DEFAULT_BUSINESS_ID),
                                "businessName": str(row.get("business_name") or "TRAX LINK Hotspot"),
                                "status": str(row["status"]),
                                "codeMasked": str(row["code_masked"]),
                                "packageName": str(row["package_name"]),
                                "category": str(row["category"]),
                                "downloadKbps": int(row["download_kbps"]),
                                "uploadKbps": int(row["upload_kbps"]),
                                "dataLimitMb": int(row["data_limit_mb"]) if row["data_limit_mb"] is not None else None,
                                "bytesIn": int(row["bytes_in"]),
                                "bytesOut": int(row["bytes_out"]),
                                "startedAt": str(row["started_at"]),
                                "expiresAt": str(row["expires_at"]),
                                "endedAt": str(row["ended_at"]) if row.get("ended_at") else None,
                                "endReason": str(row["end_reason"]) if row.get("end_reason") else None,
                                "remainingSeconds": remaining,
                                "deviceLabel": str(row.get("bound_device_name") or row.get("device_label") or "Authorized Device"),
                                "isTest": bool(row["voucher_is_test"]),
                                "operatingMode": get_operating_mode(db),
                            }
                        },
                    )

                if method == "POST" and path == "/api/portal/logout":
                    auth_hdr = self.headers.get("Authorization") or ""
                    token = str(self.headers.get("x-portal-session") or "").strip()
                    if not token and auth_hdr.startswith("Bearer "):
                        token = auth_hdr[len("Bearer ") :].strip()
                    if not token:
                        return self._send_json(400, {"error": "Portal session token required"})
                    sess = db.query_one(
                        "SELECT * FROM sessions WHERE session_token = ? AND status = 'ACTIVE'", (token,)
                    )
                    if not sess:
                        return self._send_json(404, {"error": "Active session not found"})

                    now_iso = utc_now_iso()

                    def _logout_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            "UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = 'Customer disconnected via portal' WHERE id = ?",
                            (now_iso, str(sess["id"])),
                        )
                        conn.execute(
                            "UPDATE vouchers SET status = 'EXPIRED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'",
                            (now_iso, str(sess["voucher_id"])),
                        )

                    db.transaction(_logout_tx)
                    if sess.get("router_id") and sess.get("ip_address"):
                        terminate_router_session(db, str(sess["router_id"]), str(sess["ip_address"]))
                    self._emit(events, "session:ended", {"sessionId": str(sess["id"]), "reason": "Customer disconnected"})
                    self._emit(events, "voucher:updated", {"voucherId": str(sess["voucher_id"]), "status": "EXPIRED"})
                    return self._send_json(
                        200,
                        {
                            "ok": True,
                            "message": "Session ended cleanly. Because voucher codes are single-use, this code cannot be reused.",
                        },
                        events,
                    )

                if method == "POST" and path == "/api/portal/payments/initiate":
                    if not self._check_limit(portal_limiter, "portal"):
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    pkg_id = clean_str(body.get("packageId"), 1, 64)
                    provider = clean_enum(body.get("provider"), set(SUPPORTED_PROVIDERS))
                    phone = clean_str(body.get("phoneNumber"), 4, 80)
                    if not pkg_id or not provider or not phone:
                        return self._send_json(400, {"error": "Invalid payment initiation request"})
                    try:
                        card_summary = None
                        if provider == "CARD":
                            raw_cs = body.get("cardSummary")
                            if isinstance(raw_cs, dict):
                                card_summary = {
                                    "cardBrand": clean_opt_str(raw_cs.get("cardBrand"), 24) or "CARD",
                                    "cardLast4": clean_opt_str(raw_cs.get("cardLast4"), 4) or "",
                                    "cardExpiry": clean_opt_str(raw_cs.get("cardExpiry"), 7) or "",
                                    "cardHolder": clean_opt_str(raw_cs.get("cardHolder"), 80) or "",
                                }
                        pay = initiate_payment(
                            db,
                            package_id=pkg_id,
                            provider=provider,
                            phone_number=phone,
                            customer_id=clean_opt_str(body.get("customerId"), 64),
                            business_id=clean_opt_str(body.get("businessId"), 64),
                            card_summary=card_summary,
                        )
                        self._emit(
                            events,
                            "payment:updated",
                            {"reference": pay["reference"], "status": pay["status"], "businessId": pay["businessId"]},
                        )
                        return self._send_json(201, {"payment": pay}, events)
                    except ValueError as exc:
                        return self._send_json(400, {"error": str(exc)})

                m = re.fullmatch(r"/api/portal/payments/([^/]+)/confirm-test", path)
                if method == "POST" and m:
                    if not self._check_limit(portal_limiter, "portal"):
                        return
                    ref = urllib.parse.unquote(m.group(1))
                    try:
                        pay = confirm_standalone_payment_for_token(db, ref)
                        self._emit(
                            events,
                            "payment:updated",
                            {
                                "reference": pay["reference"],
                                "status": pay["status"],
                                "receiptNumber": pay["receiptNumber"],
                                "businessId": pay["businessId"],
                            },
                        )
                        self._emit(events, "voucher:updated", {"source": "standalone-payment", "reference": pay["reference"]})
                        self._emit(events, "notification:new", {"type": "STANDALONE_TOKEN_ISSUED", "businessId": pay["businessId"]})
                        return self._send_json(200, {"payment": pay}, events)
                    except ValueError as exc:
                        return self._send_json(400, {"error": str(exc)})

                m = re.fullmatch(r"/api/portal/payments/([^/]+)", path)
                if method == "GET" and m:
                    ref = urllib.parse.unquote(m.group(1))
                    row = db.query_one(
                        """
                        SELECT p.id, p.business_id as businessId, p.reference, p.receipt_number as receiptNumber, p.provider,
                               p.phone_number as phoneNumber, p.amount_tzs as amountTzs,
                               p.status, p.is_test as isTest, p.payment_mode as paymentMode,
                               p.verified_at as verifiedAt, p.created_at as createdAt,
                               pk.name as packageName, v.code_encrypted as voucherEncrypted
                        FROM payments p
                        JOIN packages pk ON pk.id = p.package_id
                        LEFT JOIN vouchers v ON v.id = p.voucher_id
                        WHERE p.reference = ?
                        """,
                        (ref,),
                    )
                    if not row:
                        return self._send_json(404, {"error": "Payment reference not found"})
                    enc = row.pop("voucherEncrypted", None)
                    v_code = decrypt_voucher_code_safe(str(enc)) if (row["status"] == "COMPLETED" and enc) else None
                    row["isTest"] = bool(row["isTest"])
                    row["paymentMode"] = str(row.get("paymentMode") or "GATEWAY")
                    row["voucherCode"] = v_code
                    return self._send_json(200, {"payment": row})

                # ---------------------------------------------------------------
                # PAYMENT GATEWAY WEBHOOK CALLBACKS
                # ---------------------------------------------------------------
                m = re.fullmatch(r"/api/payments/webhook/([^/]+)", path)
                if method == "POST" and m:
                    provider = urllib.parse.unquote(m.group(1)).upper()
                    if provider not in SUPPORTED_PROVIDERS:
                        return self._send_json(400, {"error": "Unsupported payment provider"})
                    body, raw_bytes, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})

                    valid_sig, sig_reason = verify_webhook_signature(
                        provider,
                        raw_bytes,
                        self.headers.get("X-Webhook-Signature") or self.headers.get("x-webhook-signature"),
                    )
                    if not valid_sig:
                        return self._send_json(401, {"error": sig_reason or "Unauthorized webhook signature"})

                    ext_evt = clean_str(body.get("externalEventId"), 2, 128)
                    ref = clean_str(body.get("reference"), 4, 64)
                    ext_tx = clean_str(body.get("externalTxId"), 2, 128)
                    wh_status = clean_enum(body.get("status"), {"COMPLETED", "FAILED", "REFUNDED"})
                    amt = clean_int(body.get("amountTzs"), 0, 1_000_000_000) if "amountTzs" in body else None
                    if not ext_evt or not ref or not ext_tx or not wh_status or ("amountTzs" in body and amt is None):
                        return self._send_json(400, {"error": "Invalid webhook payload"})

                    try:
                        outcome = process_verified_payment_callback(
                            db,
                            provider=provider,
                            external_event_id=ext_evt,
                            reference=ref,
                            external_tx_id=ext_tx,
                            status=wh_status,
                            raw_payload=body,
                            amount_tzs=amt,
                        )
                        self._emit(
                            events,
                            "payment:updated",
                            {
                                "reference": outcome["reference"],
                                "businessId": outcome["businessId"],
                                "status": outcome["status"],
                                "receiptNumber": outcome.get("receiptNumber"),
                            },
                        )
                        self._emit(events, "notification:new", {"type": "PAYMENT_WEBHOOK", "businessId": outcome["businessId"]})
                        return self._send_json(200, {"ok": True, "outcome": outcome}, events)
                    except ValueError as exc:
                        return self._send_json(400, {"error": str(exc)})

                # ---------------------------------------------------------------
                # FREERADIUS REST ADAPTER
                # ---------------------------------------------------------------
                if method == "POST" and path == "/api/radius/authorize":
                    if not _verify_radius_secret(self.headers):
                        return self._send_json(401, {"access": "Access-Reject", "error": "Unauthorized RADIUS secret"})
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"access": "Access-Reject", "error": err[1]})
                    username = clean_str(body.get("username"), 2, 120)
                    if not username:
                        return self._send_json(400, {"access": "Access-Reject", "error": "Invalid RADIUS authorize payload"})
                    res = authorize_radius_request(
                        db,
                        username=username,
                        password=body.get("password") if isinstance(body.get("password"), str) else None,
                        nas_ip_address=clean_opt_str(body.get("nasIpAddress"), 64),
                    )
                    if not res["authorized"]:
                        return self._send_json(401, {"access": "Access-Reject", "reason": res.get("reason")})
                    return self._send_json(
                        200,
                        {"access": "Access-Accept", "businessId": res["businessId"], "reply": res["replyAttributes"]},
                    )

                if method == "POST" and path == "/api/radius/accounting":
                    if not _verify_radius_secret(self.headers):
                        return self._send_json(401, {"error": "Unauthorized RADIUS secret"})
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    acct_sid = clean_str(body.get("acctSessionId"), 2, 128)
                    username = clean_str(body.get("username"), 2, 120)
                    st_type = clean_enum(body.get("statusType"), {"Start", "Interim-Update", "Stop"})
                    if not acct_sid or not username or not st_type:
                        return self._send_json(400, {"error": "Invalid RADIUS accounting payload"})
                    try:
                        outcome = ingest_radius_accounting(
                            db,
                            acct_session_id=acct_sid,
                            username=username,
                            status_type=st_type,
                            nas_ip_address=clean_opt_str(body.get("nasIpAddress"), 64),
                            framed_ip_address=clean_opt_str(body.get("framedIpAddress"), 64),
                            calling_station_id=clean_opt_str(body.get("callingStationId"), 64),
                            acct_input_octets=clean_int(body.get("acctInputOctets"), 0, 10**15, 0) or 0,
                            acct_output_octets=clean_int(body.get("acctOutputOctets"), 0, 10**15, 0) or 0,
                            acct_session_time=clean_int(body.get("acctSessionTime"), 0, 10**9, 0) or 0,
                            terminate_cause=clean_opt_str(body.get("terminateCause"), 64),
                        )
                        return self._send_json(200, outcome)
                    except ValueError as exc:
                        return self._send_json(404, {"error": str(exc)})

                # ---------------------------------------------------------------
                # SUPER ADMIN PLATFORM CONSOLE
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/superadmin/overview":
                    actor = self._require_auth(("SUPER_ADMIN",))
                    if not actor:
                        return
                    biz_counts = db.query_one(
                        """
                        SELECT COUNT(*) as total,
                               SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
                               SUM(CASE WHEN status = 'SUSPENDED' THEN 1 ELSE 0 END) as suspended,
                               SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending
                        FROM businesses
                        """
                    ) or {}
                    rtr_counts = db.query_one(
                        "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END) as online FROM routers"
                    ) or {}
                    total_cust = int((db.query_one("SELECT COUNT(*) as c FROM customers") or {}).get("c") or 0)
                    active_subs = int(
                        (db.query_one("SELECT COUNT(*) as c FROM saas_subscriptions WHERE status IN ('ACTIVE','TRIAL')") or {}).get("c") or 0
                    )
                    saas_rev = int(
                        (db.query_one("SELECT COALESCE(SUM(amount_tzs), 0) as s FROM saas_payments WHERE status = 'COMPLETED'") or {}).get("s") or 0
                    )
                    wifi_rev = int(
                        (db.query_one("SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE status = 'COMPLETED' AND is_test = 0") or {}).get("s") or 0
                    )
                    pending_jobs = int(
                        (db.query_one("SELECT COUNT(*) as c FROM provisioning_jobs WHERE status = 'FAILED_RETRYING'") or {}).get("c") or 0
                    )
                    total_r = int(rtr_counts.get("total") or 0)
                    online_r = int(rtr_counts.get("online") or 0)
                    return self._send_json(
                        200,
                        {
                            "stats": {
                                "totalBusinesses": int(biz_counts.get("total") or 0),
                                "activeBusinesses": int(biz_counts.get("active") or 0),
                                "suspendedBusinesses": int(biz_counts.get("suspended") or 0),
                                "pendingBusinesses": int(biz_counts.get("pending") or 0),
                                "totalCustomers": total_cust,
                                "totalRouters": total_r,
                                "onlineRouters": online_r,
                                "offlineRouters": max(0, total_r - online_r),
                                "activeSaasSubscriptions": active_subs,
                                "saasRevenueTzs": saas_rev,
                                "totalWifiRevenueTzs": wifi_rev,
                                "retryingProvisioningJobs": pending_jobs,
                            },
                            "systemHealth": {
                                "database": "OK",
                                "uptimeSeconds": int(time.monotonic() - started_at),
                                "nodeVersion": f"Python {platform.python_version()}",
                                "pythonVersion": platform.python_version(),
                                "timestamp": utc_now_iso(),
                            },
                        },
                    )

                if method == "GET" and path == "/api/superadmin/businesses":
                    actor = self._require_auth(("SUPER_ADMIN",))
                    if not actor:
                        return
                    businesses = db.query_all(
                        """
                        SELECT b.id, b.name, b.slug, b.email, b.phone, b.country, b.currency, b.status,
                               b.created_at as createdAt,
                               sp.code as planCode, sp.name as planName, ss.status as subscriptionStatus,
                               ss.current_period_end as currentPeriodEnd,
                               (SELECT COUNT(*) FROM routers r WHERE r.business_id = b.id) as routerCount,
                               (SELECT COUNT(*) FROM locations l WHERE l.business_id = b.id) as locationCount,
                               (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id) as customerCount,
                               (SELECT COALESCE(SUM(p.amount_tzs), 0) FROM payments p WHERE p.business_id = b.id AND p.status = 'COMPLETED' AND p.is_test = 0) as wifiRevenueTzs
                        FROM businesses b
                        LEFT JOIN saas_subscriptions ss ON ss.business_id = b.id
                        LEFT JOIN saas_plans sp ON sp.id = ss.plan_id
                        ORDER BY b.created_at DESC
                        """
                    )
                    return self._send_json(200, {"businesses": businesses})

                m = re.fullmatch(r"/api/superadmin/businesses/([^/]+)/status", path)
                if method == "PATCH" and m:
                    actor = self._require_auth(("SUPER_ADMIN",))
                    if not actor:
                        return
                    biz_target = urllib.parse.unquote(m.group(1))
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    st = clean_enum(body.get("status"), {"PENDING", "ACTIVE", "SUSPENDED"})
                    if not st:
                        return self._send_json(400, {"error": "Invalid business status"})
                    if not db.query_one("SELECT id FROM businesses WHERE id = ?", (biz_target,)):
                        return self._send_json(404, {"error": "Business not found"})
                    db.execute("UPDATE businesses SET status = ?, updated_at = ? WHERE id = ?", (st, utc_now_iso(), biz_target))
                    record_audit_log(db, actor, "BUSINESS_STATUS_UPDATED", "Business", biz_target, ip, {"status": st})
                    return self._send_json(200, {"ok": True, "id": biz_target, "status": st})

                if method == "GET" and path == "/api/superadmin/plans":
                    actor = self._require_auth(("SUPER_ADMIN",))
                    if not actor:
                        return
                    plans = db.query_all(
                        """
                        SELECT id, code, name, price_monthly_tzs as priceMonthlyTzs, price_yearly_tzs as priceYearlyTzs,
                               max_routers as maxRouters, max_locations as maxLocations,
                               max_active_customers as maxActiveCustomers, commission_bps as commissionBps,
                               is_active as isActive, created_at as createdAt
                        FROM saas_plans ORDER BY price_monthly_tzs ASC
                        """
                    )
                    return self._send_json(200, {"plans": plans})

                if method == "POST" and path == "/api/superadmin/plans":
                    actor = self._require_auth(("SUPER_ADMIN",))
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    code = clean_str(body.get("code"), 2, 40)
                    name = clean_str(body.get("name"), 2, 80)
                    pm = clean_int(body.get("priceMonthlyTzs"), 0, 100_000_000)
                    py = clean_int(body.get("priceYearlyTzs"), 0, 1_000_000_000)
                    mr = clean_int(body.get("maxRouters"), 1, 10_000)
                    ml = clean_int(body.get("maxLocations"), 1, 10_000)
                    mc = clean_int(body.get("maxActiveCustomers"), 1, 10_000_000)
                    comm = clean_int(body.get("commissionBps"), 0, 10_000, 0)
                    if not code or not name or pm is None or py is None or mr is None or ml is None or mc is None or comm is None:
                        return self._send_json(400, {"error": "Invalid SaaS plan payload"})
                    code_up = code.upper()
                    if db.query_one("SELECT id FROM saas_plans WHERE code = ?", (code_up,)):
                        return self._send_json(409, {"error": "Plan code already exists"})
                    pid = generate_id("plan")
                    now_iso = utc_now_iso()
                    db.execute(
                        """
                        INSERT INTO saas_plans (
                          id, code, name, price_monthly_tzs, price_yearly_tzs, max_routers, max_locations,
                          max_active_customers, commission_bps, is_active, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                        """,
                        (pid, code_up, name, pm, py, mr, ml, mc, comm, now_iso, now_iso),
                    )
                    record_audit_log(db, actor, "SAAS_PLAN_CREATED", "SaasPlan", pid, ip, {"code": code_up})
                    return self._send_json(201, {"id": pid, "code": code_up, "name": name})

                if method == "GET" and path == "/api/superadmin/saas-payments":
                    actor = self._require_auth(("SUPER_ADMIN",))
                    if not actor:
                        return
                    rows = db.query_all(
                        """
                        SELECT sp.id, sp.reference, sp.amount_tzs as amountTzs, sp.provider, sp.status, sp.paid_at as paidAt,
                               sp.created_at as createdAt, b.name as businessName, pl.name as planName
                        FROM saas_payments sp
                        JOIN businesses b ON b.id = sp.business_id
                        JOIN saas_subscriptions ss ON ss.id = sp.saas_subscription_id
                        JOIN saas_plans pl ON pl.id = ss.plan_id
                        ORDER BY sp.created_at DESC LIMIT 200
                        """
                    )
                    return self._send_json(200, {"saasPayments": rows})

                # ---------------------------------------------------------------
                # BUSINESS SUBSCRIPTIONS & LOCATIONS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/business/subscription":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    business = db.query_one(
                        "SELECT id, name, slug, email, phone, country, currency, status, timezone, hotspot_title as hotspotTitle, hotspot_support_phone as hotspotSupportPhone FROM businesses WHERE id = ?",
                        (biz_id,),
                    )
                    subscription = db.query_one(
                        """
                        SELECT ss.id, ss.status, ss.billing_cycle as billingCycle,
                               ss.current_period_start as currentPeriodStart, ss.current_period_end as currentPeriodEnd,
                               p.id as planId, p.code as planCode, p.name as planName,
                               p.price_monthly_tzs as priceMonthlyTzs, p.price_yearly_tzs as priceYearlyTzs,
                               p.max_routers as maxRouters, p.max_locations as maxLocations, p.max_active_customers as maxActiveCustomers
                        FROM saas_subscriptions ss
                        JOIN saas_plans p ON p.id = ss.plan_id
                        WHERE ss.business_id = ?
                        ORDER BY ss.created_at DESC LIMIT 1
                        """,
                        (biz_id,),
                    )
                    plans = db.query_all(
                        "SELECT id, code, name, price_monthly_tzs as priceMonthlyTzs, price_yearly_tzs as priceYearlyTzs, max_routers as maxRouters, max_locations as maxLocations, max_active_customers as maxActiveCustomers FROM saas_plans WHERE is_active = 1 ORDER BY price_monthly_tzs ASC"
                    )
                    saas_pays = db.query_all(
                        "SELECT id, reference, amount_tzs as amountTzs, provider, status, paid_at as paidAt, created_at as createdAt FROM saas_payments WHERE business_id = ? ORDER BY created_at DESC LIMIT 50",
                        (biz_id,),
                    )
                    return self._send_json(
                        200, {"business": business, "subscription": subscription, "plans": plans, "saasPayments": saas_pays}
                    )

                if method == "POST" and path == "/api/business/subscription/checkout":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    plan_code = clean_str(body.get("planCode"), 2, 40)
                    cycle = clean_enum(body.get("billingCycle"), {"MONTHLY", "YEARLY"}, "MONTHLY")
                    provider = clean_enum(body.get("provider"), set(SUPPORTED_PROVIDERS), "MPESA")
                    if not plan_code or not cycle or not provider:
                        return self._send_json(400, {"error": "Invalid plan checkout payload"})

                    plan = db.query_one("SELECT * FROM saas_plans WHERE code = ? AND is_active = 1", (plan_code.upper(),))
                    if not plan:
                        return self._send_json(404, {"error": "SaaS plan not found"})
                    amt = int(plan["price_yearly_tzs"]) if cycle == "YEARLY" else int(plan["price_monthly_tzs"])
                    now_iso = utc_now_iso()
                    days = 365 if cycle == "YEARLY" else 30
                    period_end = (
                        (datetime.now(timezone.utc) + timedelta(days=days))
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )
                    ref = generate_reference("SAAS-PAY")

                    def _chk_tx(conn: sqlite3.Connection) -> None:
                        existing = conn.execute(
                            "SELECT id FROM saas_subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1",
                            (biz_id,),
                        ).fetchone()
                        if not existing:
                            sub_id = generate_id("ssub")
                            conn.execute(
                                """
                                INSERT INTO saas_subscriptions (id, business_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at, updated_at)
                                VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
                                """,
                                (sub_id, biz_id, str(plan["id"]), cycle, now_iso, period_end, now_iso, now_iso),
                            )
                        else:
                            sub_id = str(existing["id"])
                            conn.execute(
                                """
                                UPDATE saas_subscriptions
                                SET plan_id = ?, status = 'ACTIVE', billing_cycle = ?, current_period_start = ?, current_period_end = ?, updated_at = ?
                                WHERE id = ?
                                """,
                                (str(plan["id"]), cycle, now_iso, period_end, now_iso, sub_id),
                            )
                        sp_id = generate_id("spay")
                        conn.execute(
                            """
                            INSERT INTO saas_payments (id, business_id, saas_subscription_id, reference, amount_tzs, provider, status, paid_at, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)
                            """,
                            (sp_id, biz_id, sub_id, ref, amt, provider, now_iso, now_iso),
                        )
                        create_invoice_for_payment(
                            conn,
                            business_id=biz_id,
                            ledger_type="SAAS",
                            payment_id=sp_id,
                            payment_reference=ref,
                            item_description=f"TRAX LINK SaaS Plan: {plan['name']} ({cycle})",
                            total_tzs=amt,
                            is_test=False,
                        )

                    db.transaction(_chk_tx)
                    record_audit_log(
                        db,
                        actor,
                        "SAAS_PLAN_UPGRADED",
                        "SaasSubscription",
                        biz_id,
                        ip,
                        {"planCode": plan_code.upper(), "billingCycle": cycle, "amountTzs": amt, "reference": ref},
                    )
                    return self._send_json(201, {"ok": True, "reference": ref, "amountTzs": amt, "planCode": plan_code.upper()})

                if method == "GET" and path == "/api/locations":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    locs = db.query_all(
                        """
                        SELECT l.id, l.name, l.region, l.address, l.contact_name as contactName, l.is_active as isActive,
                               l.created_at as createdAt,
                               (SELECT COUNT(*) FROM routers r WHERE r.location_id = l.id) as routerCount,
                               (SELECT COUNT(*) FROM subscriptions s WHERE s.location_id = l.id AND s.status = 'ACTIVE') as activeSubscriptions
                        FROM locations l WHERE l.business_id = ? ORDER BY l.created_at ASC
                        """,
                        (biz_id,),
                    )
                    return self._send_json(200, {"locations": locs})

                if method == "POST" and path == "/api/locations":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES + ("NETWORK_OPERATOR",))
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    name = clean_str(body.get("name"), 2, 80)
                    region = clean_str(body.get("region") or "Dar es Salaam", 2, 80)
                    if not name or not region:
                        return self._send_json(400, {"error": "Invalid location payload"})
                    if db.query_one("SELECT id FROM locations WHERE business_id = ? AND LOWER(name) = LOWER(?)", (biz_id, name)):
                        return self._send_json(409, {"error": "A location with this name already exists in your workspace"})
                    lid = generate_id("loc")
                    now_iso = utc_now_iso()
                    db.execute(
                        "INSERT INTO locations (id, business_id, name, region, address, contact_name, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                        (lid, biz_id, name, region, clean_opt_str(body.get("address"), 200), clean_opt_str(body.get("contactName"), 100), now_iso, now_iso),
                    )
                    record_audit_log(db, actor, "LOCATION_CREATED", "Location", lid, ip, {"name": name})
                    created = db.query_one(
                        "SELECT id, name, region, address, contact_name as contactName, is_active as isActive, created_at as createdAt FROM locations WHERE id = ?",
                        (lid,),
                    )
                    return self._send_json(201, {"location": created})

                m = re.fullmatch(r"/api/locations/([^/]+)", path)
                if method == "DELETE" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    lid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT id, business_id FROM locations WHERE id = ?", (lid,))
                    if not ex:
                        return self._send_json(404, {"error": "Location not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    db.execute("DELETE FROM locations WHERE id = ? AND business_id = ?", (lid, biz_id))
                    return self._send_json(200, {"ok": True})

                # ---------------------------------------------------------------
                # SUBSCRIPTIONS & PROVISIONING JOBS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/subscriptions":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    subs = db.query_all(
                        """
                        SELECT s.id, s.radius_username as radiusUsername, s.status, s.provisioning_status as provisioningStatus,
                               s.download_kbps as downloadKbps, s.upload_kbps as uploadKbps, s.data_limit_mb as dataLimitMb,
                               s.starts_at as startsAt, s.expires_at as expiresAt, s.revoked_at as revokedAt, s.created_at as createdAt,
                               pk.name as packageName, c.full_name as customerName, l.name as locationName,
                               (SELECT id FROM provisioning_jobs pj WHERE pj.subscription_id = s.id AND pj.status = 'FAILED_RETRYING' LIMIT 1) as pendingJobId
                        FROM subscriptions s
                        JOIN packages pk ON pk.id = s.package_id
                        LEFT JOIN customers c ON c.id = s.customer_id
                        LEFT JOIN locations l ON l.id = s.location_id
                        WHERE s.business_id = ? ORDER BY s.created_at DESC LIMIT 250
                        """,
                        (biz_id,),
                    )
                    jobs = db.query_all(
                        """
                        SELECT pj.id, pj.subscription_id as subscriptionId, pj.router_id as routerId, pj.action,
                               pj.status, pj.attempts, pj.max_attempts as maxAttempts, pj.last_error as lastError,
                               pj.next_retry_at as nextRetryAt, pj.completed_at as completedAt, pj.created_at as createdAt,
                               r.name as routerName
                        FROM provisioning_jobs pj LEFT JOIN routers r ON r.id = pj.router_id
                        WHERE pj.business_id = ? ORDER BY pj.created_at DESC LIMIT 100
                        """,
                        (biz_id,),
                    )
                    return self._send_json(200, {"subscriptions": subs, "provisioningJobs": jobs})

                if method == "POST" and path == "/api/subscriptions":
                    actor = self._require_auth(FINANCE_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    pkg_id = clean_str(body.get("packageId"), 1, 64)
                    if not pkg_id:
                        return self._send_json(400, {"error": "Invalid subscription payload"})
                    pkg = db.query_one("SELECT id, business_id, duration_minutes FROM packages WHERE id = ?", (pkg_id,))
                    if not pkg:
                        return self._send_json(404, {"error": "Package not found"})
                    if str(pkg["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    now_iso = utc_now_iso()
                    exp_iso = (
                        (datetime.now(timezone.utc) + timedelta(minutes=int(pkg["duration_minutes"])))
                        .isoformat(timespec="milliseconds")
                        .replace("+00:00", "Z")
                    )
                    raw_uname = clean_opt_str(body.get("username"), 64) or generate_reference("TRX")
                    uname = re.sub(r"[^A-Z0-9_-]", "", raw_uname.upper())
                    secret_val = secrets.token_hex(6).upper()
                    result = provision_subscription_for_activation(
                        db,
                        business_id=biz_id,
                        location_id=clean_opt_str(body.get("locationId"), 64),
                        customer_id=clean_opt_str(body.get("customerId"), 64),
                        package_id=str(pkg["id"]),
                        radius_username=uname,
                        radius_secret_value=secret_val,
                        starts_at_iso=now_iso,
                        expires_at_iso=exp_iso,
                    )
                    record_audit_log(
                        db,
                        actor,
                        "SUBSCRIPTION_PROVISIONED",
                        "Subscription",
                        result["subscriptionId"],
                        ip,
                        {"provisioningStatus": result["provisioningStatus"]},
                    )
                    return self._send_json(201, {"subscription": result})

                m = re.fullmatch(r"/api/subscriptions/([^/]+)/suspend", path)
                if method == "POST" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES + ("NETWORK_OPERATOR",))
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    sid = urllib.parse.unquote(m.group(1))
                    try:
                        suspend_subscription_and_disconnect(db, sid, biz_id, "Suspended by tenant operator")
                        return self._send_json(200, {"ok": True})
                    except PermissionError:
                        return self._send_json(403, {"error": "CROSS_TENANT_FORBIDDEN"})
                    except ValueError as exc:
                        return self._send_json(404, {"error": str(exc)})

                m = re.fullmatch(r"/api/provisioning-jobs/([^/]+)/retry", path)
                if method == "POST" and m:
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    jid = urllib.parse.unquote(m.group(1))
                    try:
                        res = retry_provisioning_job(db, jid, biz_id)
                        return self._send_json(200, {"result": res})
                    except PermissionError:
                        return self._send_json(403, {"error": "CROSS_TENANT_FORBIDDEN"})
                    except ValueError as exc:
                        return self._send_json(404, {"error": str(exc)})

                # ---------------------------------------------------------------
                # SUPPORT TICKETS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/support-tickets":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    tickets = db.query_all(
                        "SELECT id, phone, subject, message, status, reply, created_at as createdAt, updated_at as updatedAt FROM support_tickets WHERE business_id = ? ORDER BY created_at DESC LIMIT 100",
                        (biz_id,),
                    )
                    return self._send_json(200, {"tickets": tickets})

                m = re.fullmatch(r"/api/support-tickets/([^/]+)", path)
                if method == "PATCH" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES + ("SUPPORT_STAFF",))
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    tid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT id, business_id FROM support_tickets WHERE id = ?", (tid,))
                    if not ex:
                        return self._send_json(404, {"error": "Ticket not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    st = clean_enum(body.get("status"), {"OPEN", "IN_PROGRESS", "RESOLVED"}) if "status" in body else None
                    if "status" in body and not st:
                        return self._send_json(400, {"error": "Invalid ticket update"})
                    reply = clean_opt_str(body.get("reply"), 1000)
                    db.execute(
                        "UPDATE support_tickets SET status = COALESCE(?, status), reply = COALESCE(?, reply), updated_at = ? WHERE id = ? AND business_id = ?",
                        (st, reply, utc_now_iso(), tid, biz_id),
                    )
                    return self._send_json(200, {"ok": True})

                # ---------------------------------------------------------------
                # DASHBOARD SUMMARY
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/dashboard/summary":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    expire_stale_records(db)

                    total_cust = int((db.query_one("SELECT COUNT(*) as c FROM customers WHERE business_id = ?", (biz_id,)) or {}).get("c") or 0)
                    online_cust = int(
                        (
                            db.query_one(
                                "SELECT COUNT(DISTINCT COALESCE(customer_id, device_id)) as c FROM sessions WHERE business_id = ? AND status = 'ACTIVE'",
                                (biz_id,),
                            )
                            or {}
                        ).get("c")
                        or 0
                    )
                    v_counts = db.query_all("SELECT status, COUNT(*) as c FROM vouchers WHERE business_id = ? GROUP BY status", (biz_id,))
                    v_map = {"UNUSED": 0, "ACTIVE": 0, "EXPIRED": 0, "REVOKED": 0}
                    for vc in v_counts:
                        v_map[str(vc["status"])] = int(vc["c"])

                    now = datetime.now(timezone.utc)
                    start_day = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    start_week = (now - timedelta(days=7)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
                    start_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat(timespec="milliseconds").replace("+00:00", "Z")

                    daily_rev = int(
                        (
                            db.query_one(
                                "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?",
                                (biz_id, start_day),
                            )
                            or {}
                        ).get("s")
                        or 0
                    )
                    weekly_rev = int(
                        (
                            db.query_one(
                                "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?",
                                (biz_id, start_week),
                            )
                            or {}
                        ).get("s")
                        or 0
                    )
                    monthly_rev = int(
                        (
                            db.query_one(
                                "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?",
                                (biz_id, start_month),
                            )
                            or {}
                        ).get("s")
                        or 0
                    )
                    total_rev = int(
                        (
                            db.query_one(
                                "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0",
                                (biz_id,),
                            )
                            or {}
                        ).get("s")
                        or 0
                    )
                    pending_pay = int((db.query_one("SELECT COUNT(*) as c FROM payments WHERE business_id = ? AND status = 'PENDING'", (biz_id,)) or {}).get("c") or 0)
                    active_subs = int((db.query_one("SELECT COUNT(*) as c FROM subscriptions WHERE business_id = ? AND status = 'ACTIVE'", (biz_id,)) or {}).get("c") or 0)
                    expired_subs = int((db.query_one("SELECT COUNT(*) as c FROM subscriptions WHERE business_id = ? AND status = 'EXPIRED'", (biz_id,)) or {}).get("c") or 0)
                    test_vouchers = int((db.query_one("SELECT COUNT(*) as c FROM vouchers WHERE business_id = ? AND is_test = 1", (biz_id,)) or {}).get("c") or 0)
                    test_payments = int(
                        (db.query_one("SELECT COUNT(*) as c FROM payments WHERE business_id = ? AND is_test = 1 AND status = 'COMPLETED'", (biz_id,)) or {}).get("c") or 0
                    )
                    bw = db.query_one("SELECT COALESCE(SUM(bytes_in), 0) as rx, COALESCE(SUM(bytes_out), 0) as tx FROM sessions WHERE business_id = ?", (biz_id,)) or {"rx": 0, "tx": 0}
                    rif = db.query_one(
                        "SELECT COALESCE(SUM(ri.rx_bytes), 0) as rx, COALESCE(SUM(ri.tx_bytes), 0) as tx FROM router_interfaces ri JOIN routers r ON r.id = ri.router_id WHERE r.business_id = ?",
                        (biz_id,),
                    ) or {"rx": 0, "tx": 0}
                    routers = db.query_all(
                        """
                        SELECT id, name, host, api_port as apiPort, status, cpu_load as cpuLoad,
                               memory_used_bytes as memoryUsedBytes, memory_total_bytes as memoryTotalBytes,
                               uptime, board_name as boardName, router_os_version as routerOsVersion,
                               last_error as lastError, last_checked_at as lastCheckedAt
                        FROM routers WHERE business_id = ? ORDER BY created_at DESC
                        """,
                        (biz_id,),
                    )
                    activities = db.query_all(
                        "SELECT id, actor_email as actorEmail, actor_role as actorRole, action, entity_type as entityType, entity_id as entityId, created_at as createdAt FROM audit_logs WHERE business_id = ? ORDER BY created_at DESC LIMIT 12",
                        (biz_id,),
                    )
                    daily_series = db.query_all(
                        "SELECT substr(verified_at, 1, 10) as day, COALESCE(SUM(amount_tzs), 0) as revenueTzs, COUNT(*) as txCount FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ? GROUP BY substr(verified_at, 1, 10) ORDER BY day ASC",
                        (biz_id, start_week),
                    )
                    active_sess = int((db.query_one("SELECT COUNT(*) as c FROM sessions WHERE business_id = ? AND status = 'ACTIVE'", (biz_id,)) or {}).get("c") or 0)

                    return self._send_json(
                        200,
                        {
                            "businessId": biz_id,
                            "operatingMode": get_operating_mode(db),
                            "stats": {
                                "totalCustomers": total_cust,
                                "onlineCustomers": online_cust,
                                "offlineCustomers": max(0, total_cust - online_cust),
                                "activeSessionsCount": active_sess,
                                "activeSubscriptionsCount": active_subs,
                                "expiredSubscriptionsCount": expired_subs,
                                "pendingPaymentsCount": pending_pay,
                                "activeVouchers": v_map["ACTIVE"],
                                "unusedVouchers": v_map["UNUSED"],
                                "expiredVouchers": v_map["EXPIRED"],
                                "revokedVouchers": v_map["REVOKED"],
                                "testVouchersCount": test_vouchers,
                                "testPaymentsCount": test_payments,
                                "dailyRevenueTzs": daily_rev,
                                "weeklyRevenueTzs": weekly_rev,
                                "monthlyRevenueTzs": monthly_rev,
                                "totalRevenueTzs": total_rev,
                                "totalRxBytes": int(bw["rx"]) + int(rif["rx"]),
                                "totalTxBytes": int(bw["tx"]) + int(rif["tx"]),
                            },
                            "routers": routers,
                            "recentActivities": activities,
                            "dailySeries": daily_series,
                        },
                    )

                # ---------------------------------------------------------------
                # CUSTOMERS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/customers":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    q = (qs.get("q") or "").strip()
                    status_f = qs.get("status") or "ALL"
                    sql = """
                      SELECT c.*, p.name as package_name,
                             (SELECT COUNT(*) FROM sessions s WHERE s.customer_id = c.id AND s.status = 'ACTIVE') as active_session_count,
                             (SELECT COUNT(*) FROM vouchers v WHERE v.customer_id = c.id) as voucher_count
                      FROM customers c LEFT JOIN packages p ON p.id = c.package_id
                      WHERE c.business_id = ?
                    """
                    params: list[Any] = [biz_id]
                    if q:
                        sql += " AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.customer_code LIKE ? OR COALESCE(c.email, '') LIKE ?)"
                        like = f"%{q}%"
                        params.extend([like, like, like, like])
                    if status_f == "ACTIVE":
                        sql += " AND c.is_active = 1"
                    elif status_f == "INACTIVE":
                        sql += " AND c.is_active = 0"
                    sql += " ORDER BY c.created_at DESC"
                    return self._send_json(200, {"customers": db.query_all(sql, tuple(params))})

                m = re.fullmatch(r"/api/customers/([^/]+)", path)
                if method == "GET" and m:
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    cid = urllib.parse.unquote(m.group(1))
                    cust = db.query_one(
                        "SELECT c.*, p.name as package_name FROM customers c LEFT JOIN packages p ON p.id = c.package_id WHERE c.id = ?",
                        (cid,),
                    )
                    if not cust:
                        return self._send_json(404, {"error": "Customer not found"})
                    if str(cust["business_id"]) != biz_id:
                        record_audit_log(db, actor, "CROSS_TENANT_ACCESS_BLOCKED", "Customer", cid, ip)
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    vouchers = db.query_all(
                        "SELECT v.id, v.code_masked as codeMasked, v.status, v.activated_at as activatedAt, v.expires_at as expiresAt, v.created_at as createdAt, p.name as packageName FROM vouchers v JOIN packages p ON p.id = v.package_id WHERE v.customer_id = ? AND v.business_id = ? ORDER BY v.created_at DESC",
                        (cid, biz_id),
                    )
                    sessions = db.query_all(
                        "SELECT s.id, s.status, s.ip_address as ipAddress, s.bytes_in as bytesIn, s.bytes_out as bytesOut, s.started_at as startedAt, s.expires_at as expiresAt, s.ended_at as endedAt, d.device_label as deviceLabel, d.device_fingerprint as deviceFingerprint FROM sessions s JOIN devices d ON d.id = s.device_id WHERE s.customer_id = ? AND s.business_id = ? ORDER BY s.started_at DESC",
                        (cid, biz_id),
                    )
                    return self._send_json(200, {"customer": cust, "vouchers": vouchers, "sessions": sessions})

                if method == "POST" and path == "/api/customers":
                    actor = self._require_auth(FINANCE_ROLES + ("SUPPORT_STAFF",))
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    full_name = clean_str(body.get("fullName"), 2, 120)
                    phone = clean_str(body.get("phone"), 8, 24)
                    email = clean_opt_str(body.get("email"), 254)
                    if not full_name or not phone or (email and not is_valid_email(email)):
                        return self._send_json(400, {"error": "Invalid customer data"})
                    cid = generate_id("cus")
                    code = generate_reference("CUST")
                    now_iso = utc_now_iso()
                    db.execute(
                        "INSERT INTO customers (id, business_id, customer_code, full_name, phone, email, notes, is_active, package_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
                        (cid, biz_id, code, full_name, phone, email, clean_opt_str(body.get("notes"), 500), clean_opt_str(body.get("packageId"), 64), now_iso, now_iso),
                    )
                    record_audit_log(db, actor, "CUSTOMER_CREATED", "Customer", cid, ip, {"fullName": full_name})
                    return self._send_json(201, {"customer": db.query_one("SELECT * FROM customers WHERE id = ?", (cid,))})

                if method == "PATCH" and m:
                    actor = self._require_auth(FINANCE_ROLES + ("SUPPORT_STAFF",))
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    cid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT * FROM customers WHERE id = ?", (cid,))
                    if not ex:
                        return self._send_json(404, {"error": "Customer not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    full_name = clean_str(body.get("fullName"), 2, 120) if "fullName" in body else None
                    phone = clean_str(body.get("phone"), 8, 24) if "phone" in body else None
                    if ("fullName" in body and not full_name) or ("phone" in body and not phone):
                        return self._send_json(400, {"error": "Invalid customer update"})
                    is_active = clean_bool(body.get("isActive")) if "isActive" in body else None
                    db.execute(
                        """
                        UPDATE customers
                        SET full_name = COALESCE(?, full_name),
                            phone = COALESCE(?, phone),
                            email = CASE WHEN ? THEN ? ELSE email END,
                            package_id = CASE WHEN ? THEN ? ELSE package_id END,
                            notes = CASE WHEN ? THEN ? ELSE notes END,
                            is_active = COALESCE(?, is_active),
                            updated_at = ?
                        WHERE id = ? AND business_id = ?
                        """,
                        (
                            full_name,
                            phone,
                            1 if "email" in body else 0,
                            clean_opt_str(body.get("email"), 254),
                            1 if "packageId" in body else 0,
                            clean_opt_str(body.get("packageId"), 64),
                            1 if "notes" in body else 0,
                            clean_opt_str(body.get("notes"), 500),
                            (1 if is_active else 0) if is_active is not None else None,
                            utc_now_iso(),
                            cid,
                            biz_id,
                        ),
                    )
                    record_audit_log(db, actor, "CUSTOMER_UPDATED", "Customer", cid, ip)
                    return self._send_json(200, {"customer": db.query_one("SELECT * FROM customers WHERE id = ?", (cid,))})

                if method == "DELETE" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    cid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT id, business_id FROM customers WHERE id = ?", (cid,))
                    if not ex:
                        return self._send_json(404, {"error": "Customer not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    if db.query_one("SELECT 1 FROM payments WHERE customer_id = ? LIMIT 1", (cid,)):
                        db.execute("UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ? AND business_id = ?", (utc_now_iso(), cid, biz_id))
                        record_audit_log(db, actor, "CUSTOMER_DEACTIVATED", "Customer", cid, ip)
                        return self._send_json(200, {"ok": True, "mode": "DEACTIVATED"})
                    db.execute("DELETE FROM customers WHERE id = ? AND business_id = ?", (cid, biz_id))
                    record_audit_log(db, actor, "CUSTOMER_DELETED", "Customer", cid, ip)
                    return self._send_json(200, {"ok": True, "mode": "DELETED"})

                # ---------------------------------------------------------------
                # PACKAGES
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/packages":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rows = db.query_all(
                        """
                        SELECT id, business_id as businessId, location_id as locationId, name, description, category,
                               package_type as packageType, price_tzs as priceTzs, currency,
                               duration_minutes as durationMinutes, download_kbps as downloadKbps,
                               upload_kbps as uploadKbps, data_limit_mb as dataLimitMb,
                               device_limit as deviceLimit, simultaneous_sessions as simultaneousSessions,
                               fup_policy as fupPolicy, validity_days as validityDays, is_active as isActive,
                               created_at as createdAt, updated_at as updatedAt
                        FROM packages WHERE business_id = ? ORDER BY price_tzs ASC
                        """,
                        (biz_id,),
                    )
                    return self._send_json(200, {"packages": rows})

                if method == "POST" and path == "/api/packages":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    name = clean_str(body.get("name"), 2, 80)
                    category = clean_enum(body.get("category"), {"HOURLY", "DAILY", "WEEKLY", "MONTHLY"})
                    pkg_type = clean_enum(body.get("packageType"), {"TIME_BASED", "DATA_BASED", "HYBRID", "BANDWIDTH_PROFILE"}, "TIME_BASED")
                    price = clean_int(body.get("priceTzs"), 0, 100_000_000)
                    currency = clean_str(body.get("currency") or "TZS", 3, 8)
                    dur = clean_int(body.get("durationMinutes"), 1, 525_600)
                    dl = clean_int(body.get("downloadKbps"), 64, 10_000_000)
                    ul = clean_int(body.get("uploadKbps"), 64, 10_000_000)
                    dlimit = clean_int(body.get("dataLimitMb"), 1, 10_000_000) if body.get("dataLimitMb") is not None else None
                    dev_lim = clean_int(body.get("deviceLimit"), 1, 50, 1)
                    sim_ses = clean_int(body.get("simultaneousSessions"), 1, 50, 1)
                    val_days = clean_int(body.get("validityDays"), 1, 3650, 30)
                    is_act = clean_bool(body.get("isActive"), True)
                    if not name or not category or not pkg_type or price is None or not currency or dur is None or dl is None or ul is None or dev_lim is None or sim_ses is None or val_days is None or is_act is None:
                        return self._send_json(400, {"error": "Invalid package fields"})
                    if db.query_one("SELECT id FROM packages WHERE business_id = ? AND LOWER(name) = LOWER(?)", (biz_id, name)):
                        return self._send_json(409, {"error": "A package with this name already exists in your workspace"})
                    pid = generate_id("pkg")
                    now_iso = utc_now_iso()
                    db.execute(
                        """
                        INSERT INTO packages (
                          id, business_id, location_id, name, description, category, package_type, price_tzs, currency,
                          duration_minutes, download_kbps, upload_kbps, data_limit_mb, device_limit, simultaneous_sessions,
                          fup_policy, validity_days, is_active, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            pid, biz_id, clean_opt_str(body.get("locationId"), 64), name,
                            clean_opt_str(body.get("description"), 300), category, pkg_type, price, currency.upper(),
                            dur, dl, ul, dlimit, dev_lim, sim_ses, clean_opt_str(body.get("fupPolicy"), 240),
                            val_days, 1 if is_act else 0, now_iso, now_iso,
                        ),
                    )
                    record_audit_log(db, actor, "PACKAGE_CREATED", "Package", pid, ip, {"name": name, "priceTzs": price})
                    created = db.query_one(
                        """
                        SELECT id, business_id as businessId, location_id as locationId, name, description, category,
                               package_type as packageType, price_tzs as priceTzs, currency,
                               duration_minutes as durationMinutes, download_kbps as downloadKbps,
                               upload_kbps as uploadKbps, data_limit_mb as dataLimitMb,
                               device_limit as deviceLimit, simultaneous_sessions as simultaneousSessions,
                               fup_policy as fupPolicy, validity_days as validityDays, is_active as isActive, created_at as createdAt
                        FROM packages WHERE id = ?
                        """,
                        (pid,),
                    )
                    return self._send_json(201, {"package": created})

                m = re.fullmatch(r"/api/packages/([^/]+)", path)
                if method == "PATCH" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    pid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT * FROM packages WHERE id = ?", (pid,))
                    if not ex:
                        return self._send_json(404, {"error": "Package not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    is_act = clean_bool(body.get("isActive")) if "isActive" in body else None
                    db.execute(
                        """
                        UPDATE packages
                        SET name = COALESCE(?, name),
                            description = CASE WHEN ? THEN ? ELSE description END,
                            category = COALESCE(?, category),
                            package_type = COALESCE(?, package_type),
                            price_tzs = COALESCE(?, price_tzs),
                            duration_minutes = COALESCE(?, duration_minutes),
                            download_kbps = COALESCE(?, download_kbps),
                            upload_kbps = COALESCE(?, upload_kbps),
                            data_limit_mb = CASE WHEN ? THEN ? ELSE data_limit_mb END,
                            device_limit = COALESCE(?, device_limit),
                            simultaneous_sessions = COALESCE(?, simultaneous_sessions),
                            fup_policy = CASE WHEN ? THEN ? ELSE fup_policy END,
                            validity_days = COALESCE(?, validity_days),
                            is_active = COALESCE(?, is_active),
                            updated_at = ?
                        WHERE id = ? AND business_id = ?
                        """,
                        (
                            clean_str(body.get("name"), 2, 80) if "name" in body else None,
                            1 if "description" in body else 0,
                            clean_opt_str(body.get("description"), 300),
                            clean_enum(body.get("category"), {"HOURLY", "DAILY", "WEEKLY", "MONTHLY"}) if "category" in body else None,
                            clean_enum(body.get("packageType"), {"TIME_BASED", "DATA_BASED", "HYBRID", "BANDWIDTH_PROFILE"}) if "packageType" in body else None,
                            clean_int(body.get("priceTzs"), 0, 100_000_000) if "priceTzs" in body else None,
                            clean_int(body.get("durationMinutes"), 1, 525_600) if "durationMinutes" in body else None,
                            clean_int(body.get("downloadKbps"), 64, 10_000_000) if "downloadKbps" in body else None,
                            clean_int(body.get("uploadKbps"), 64, 10_000_000) if "uploadKbps" in body else None,
                            1 if "dataLimitMb" in body else 0,
                            clean_int(body.get("dataLimitMb"), 1, 10_000_000) if body.get("dataLimitMb") is not None else None,
                            clean_int(body.get("deviceLimit"), 1, 50) if "deviceLimit" in body else None,
                            clean_int(body.get("simultaneousSessions"), 1, 50) if "simultaneousSessions" in body else None,
                            1 if "fupPolicy" in body else 0,
                            clean_opt_str(body.get("fupPolicy"), 240),
                            clean_int(body.get("validityDays"), 1, 3650) if "validityDays" in body else None,
                            (1 if is_act else 0) if is_act is not None else None,
                            utc_now_iso(),
                            pid,
                            biz_id,
                        ),
                    )
                    record_audit_log(db, actor, "PACKAGE_UPDATED", "Package", pid, ip)
                    updated = db.query_one(
                        """
                        SELECT id, business_id as businessId, name, description, category, package_type as packageType,
                               price_tzs as priceTzs, currency, duration_minutes as durationMinutes, download_kbps as downloadKbps,
                               upload_kbps as uploadKbps, data_limit_mb as dataLimitMb, device_limit as deviceLimit,
                               simultaneous_sessions as simultaneousSessions, fup_policy as fupPolicy,
                               validity_days as validityDays, is_active as isActive, updated_at as updatedAt
                        FROM packages WHERE id = ?
                        """,
                        (pid,),
                    )
                    return self._send_json(200, {"package": updated})

                if method == "DELETE" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    pid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT id, business_id FROM packages WHERE id = ?", (pid,))
                    if not ex:
                        return self._send_json(404, {"error": "Package not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    if db.query_one("SELECT 1 FROM vouchers WHERE package_id = ? LIMIT 1", (pid,)):
                        db.execute("UPDATE packages SET is_active = 0, updated_at = ? WHERE id = ? AND business_id = ?", (utc_now_iso(), pid, biz_id))
                        return self._send_json(200, {"ok": True, "mode": "DEACTIVATED"})
                    db.execute("DELETE FROM packages WHERE id = ? AND business_id = ?", (pid, biz_id))
                    record_audit_log(db, actor, "PACKAGE_DELETED", "Package", pid, ip)
                    return self._send_json(200, {"ok": True, "mode": "DELETED"})

                # ---------------------------------------------------------------
                # VOUCHERS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/vouchers/export/csv":
                    actor = self._require_auth(FINANCE_ROLES + ("SUPPORT_STAFF",))
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    st = qs.get("status") or "ALL"
                    sql = (
                        "SELECT v.*, p.name as package_name, p.price_tzs FROM vouchers v JOIN packages p ON p.id = v.package_id WHERE v.business_id = ? ORDER BY v.created_at DESC"
                        if st == "ALL"
                        else "SELECT v.*, p.name as package_name, p.price_tzs FROM vouchers v JOIN packages p ON p.id = v.package_id WHERE v.business_id = ? AND v.status = ? ORDER BY v.created_at DESC"
                    )
                    rows = db.query_all(sql, (biz_id,) if st == "ALL" else (biz_id, st))
                    csv_rows = []
                    for r in rows:
                        code = (decrypt_voucher_code_safe(str(r["code_encrypted"])) or str(r["code_masked"])) if r["status"] == "UNUSED" else str(r["code_masked"])
                        csv_rows.append([r["id"], code, r["code_masked"], r["package_name"], r["price_tzs"], r["status"], r.get("batch_id") or "", r["created_at"], r.get("expires_at") or ""])
                    return self._send_csv(
                        "traxlink-vouchers.csv",
                        _csv_response(["ID", "Code", "Masked", "Package", "Price_TZS", "Status", "Batch_ID", "Created_At", "Expires_At"], csv_rows),
                    )

                if method == "GET" and path == "/api/vouchers":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    expire_stale_records(db)
                    q = (qs.get("q") or "").strip()
                    st = qs.get("status") or "ALL"
                    pkg_id = qs.get("packageId") or ""
                    sql = """
                      SELECT v.id, v.code_encrypted, v.code_masked as codeMasked, v.batch_id as batchId,
                             v.package_id as packageId, p.name as packageName, p.price_tzs as priceTzs,
                             p.duration_minutes as durationMinutes, p.download_kbps as downloadKbps, p.upload_kbps as uploadKbps,
                             v.customer_id as customerId, c.full_name as customerName,
                             v.status, v.is_test as isTest, v.test_note as testNote, v.bound_device_id as boundDeviceId,
                             v.bound_device_name as boundDeviceName,
                             v.activated_at as activatedAt, v.expires_at as expiresAt,
                             v.revoked_at as revokedAt, v.revoked_reason as revokedReason,
                             v.created_at as createdAt
                      FROM vouchers v JOIN packages p ON p.id = v.package_id
                      LEFT JOIN customers c ON c.id = v.customer_id
                      WHERE v.business_id = ?
                    """
                    params: list[Any] = [biz_id]
                    if st != "ALL":
                        sql += " AND v.status = ?"
                        params.append(st)
                    if pkg_id:
                        sql += " AND v.package_id = ?"
                        params.append(pkg_id)
                    if q:
                        sql += " AND (v.code_masked LIKE ? OR COALESCE(v.batch_id, '') LIKE ? OR p.name LIKE ? OR COALESCE(c.full_name, '') LIKE ?)"
                        like = f"%{q}%"
                        params.extend([like, like, like, like])
                    sql += " ORDER BY v.created_at DESC LIMIT 300"
                    rows = db.query_all(sql, tuple(params))
                    out = []
                    for r in rows:
                        enc = r.pop("code_encrypted", None)
                        printable = decrypt_voucher_code_safe(str(enc)) if (r["status"] == "UNUSED" and enc) else None
                        r["isTest"] = bool(r["isTest"])
                        r["code"] = printable
                        out.append(r)
                    return self._send_json(200, {"vouchers": out})

                if method == "POST" and path == "/api/vouchers/generate":
                    actor = self._require_auth(FINANCE_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    pkg_id = clean_str(body.get("packageId"), 1, 64)
                    cnt = clean_int(body.get("count"), 1, 500, 1)
                    is_test = clean_bool(body.get("isTest"), False)
                    if not pkg_id or cnt is None or is_test is None:
                        return self._send_json(400, {"error": "Invalid voucher generation request"})
                    try:
                        res = create_voucher_batch(
                            db,
                            package_id=pkg_id,
                            count=cnt,
                            customer_id=clean_opt_str(body.get("customerId"), 64),
                            created_by_id=actor.id,
                            business_id=biz_id,
                            is_test=is_test,
                            test_note=clean_opt_str(body.get("testNote"), 240),
                        )
                        record_audit_log(
                            db,
                            actor,
                            "VOUCHERS_GENERATED",
                            "Voucher",
                            res["batchId"] or (res["vouchers"][0]["id"] if res["vouchers"] else None),
                            ip,
                            {"count": cnt, "packageId": pkg_id, "isTest": is_test},
                        )
                        self._emit(events, "voucher:updated", {"count": len(res["vouchers"]), "batchId": res["batchId"], "businessId": biz_id})
                        return self._send_json(201, res, events)
                    except VoucherError as vex:
                        return self._send_json(vex.status_code, {"error": vex.message, "code": vex.code})

                m = re.fullmatch(r"/api/vouchers/([^/]+)/revoke", path)
                if method == "POST" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    vid = urllib.parse.unquote(m.group(1))
                    reason = clean_str(body.get("reason") or "Revoked by administrator", 2, 240) or "Revoked by administrator"
                    voucher = db.query_one("SELECT * FROM vouchers WHERE id = ?", (vid,))
                    if not voucher:
                        return self._send_json(404, {"error": "Voucher not found"})
                    if str(voucher["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    now_iso = utc_now_iso()
                    active_sess = db.query_all("SELECT id, router_id, ip_address FROM sessions WHERE voucher_id = ? AND status = 'ACTIVE'", (vid,))

                    def _rev_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            "UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = ?, updated_at = ? WHERE id = ? AND business_id = ?",
                            (now_iso, reason, now_iso, vid, biz_id),
                        )
                        conn.execute(
                            "UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = ? WHERE voucher_id = ? AND status = 'ACTIVE'",
                            (now_iso, f"Voucher revoked: {reason}", vid),
                        )
                        conn.execute(
                            "UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE voucher_id = ? AND status = 'ACTIVE'",
                            (now_iso, now_iso, vid),
                        )

                    db.transaction(_rev_tx)
                    for s in active_sess:
                        if s.get("router_id") and s.get("ip_address"):
                            terminate_router_session(db, str(s["router_id"]), str(s["ip_address"]))
                    record_audit_log(db, actor, "VOUCHER_REVOKED", "Voucher", vid, ip, {"reason": reason})
                    self._emit(events, "voucher:updated", {"voucherId": vid, "status": "REVOKED", "businessId": biz_id})
                    return self._send_json(200, {"ok": True}, events)

                m = re.fullmatch(r"/api/vouchers/([^/]+)/redemptions", path)
                if method == "GET" and m:
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    vid = urllib.parse.unquote(m.group(1))
                    voucher = db.query_one("SELECT id, business_id FROM vouchers WHERE id = ?", (vid,))
                    if not voucher:
                        return self._send_json(404, {"error": "Voucher not found"})
                    if str(voucher["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    reds = db.query_all(
                        """
                        SELECT r.id, r.ip_address as ipAddress, r.success, r.reason, r.redeemed_at as redeemedAt,
                               d.device_label as deviceLabel, d.device_fingerprint as deviceFingerprint, d.mac_address as macAddress
                        FROM voucher_redemptions r JOIN devices d ON d.id = r.device_id
                        WHERE r.voucher_id = ? ORDER BY r.redeemed_at DESC
                        """,
                        (vid,),
                    )
                    return self._send_json(200, {"redemptions": reds})

                # ---------------------------------------------------------------
                # SESSIONS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/sessions":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    expire_stale_records(db)
                    st = qs.get("status") or "ALL"
                    sql = """
                      SELECT s.id, s.status, s.ip_address as ipAddress, s.bytes_in as bytesIn, s.bytes_out as bytesOut,
                             s.started_at as startedAt, s.expires_at as expiresAt, s.ended_at as endedAt, s.end_reason as endReason,
                             v.id as voucherId, v.code_masked as codeMasked,
                             p.name as packageName, p.download_kbps as downloadKbps, p.upload_kbps as uploadKbps,
                             d.id as deviceId, d.device_fingerprint as deviceFingerprint, d.mac_address as macAddress, d.device_label as deviceLabel,
                             c.full_name as customerName, r.name as routerName
                      FROM sessions s
                      JOIN vouchers v ON v.id = s.voucher_id
                      JOIN packages p ON p.id = v.package_id
                      JOIN devices d ON d.id = s.device_id
                      LEFT JOIN customers c ON c.id = s.customer_id
                      LEFT JOIN routers r ON r.id = s.router_id
                      WHERE s.business_id = ?
                    """
                    params_s: list[Any] = [biz_id]
                    if st != "ALL":
                        sql += " AND s.status = ?"
                        params_s.append(st)
                    sql += " ORDER BY s.started_at DESC LIMIT 250"
                    return self._send_json(200, {"sessions": db.query_all(sql, tuple(params_s))})

                if method == "POST" and path == "/api/sessions/expire-sweep":
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    res = expire_stale_records(db)
                    if res["expiredSessions"] > 0 or res["expiredSubscriptions"] > 0:
                        self._emit(events, "session:ended", {"expiredCount": res["expiredSessions"]})
                    return self._send_json(200, res, events)

                m = re.fullmatch(r"/api/sessions/([^/]+)/terminate", path)
                if method == "POST" and m:
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    sid = urllib.parse.unquote(m.group(1))
                    sess = db.query_one("SELECT * FROM sessions WHERE id = ?", (sid,))
                    if not sess:
                        return self._send_json(404, {"error": "Session not found"})
                    if str(sess["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    db.execute(
                        "UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = 'Terminated by administrator' WHERE id = ? AND status = 'ACTIVE' AND business_id = ?",
                        (utc_now_iso(), sid, biz_id),
                    )
                    router_res = None
                    if sess.get("router_id") and sess.get("ip_address"):
                        router_res = terminate_router_session(db, str(sess["router_id"]), str(sess["ip_address"]))
                    record_audit_log(db, actor, "SESSION_TERMINATED", "Session", sid, ip, {"routerResult": router_res})
                    self._emit(events, "session:ended", {"sessionId": sid, "reason": "Admin terminated", "businessId": biz_id})
                    return self._send_json(200, {"ok": True, "routerResult": router_res}, events)

                # ---------------------------------------------------------------
                # PAYMENTS & BILLING INVOICES
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/payments/providers":
                    actor = self._require_auth()
                    if not actor:
                        return
                    return self._send_json(200, {"providers": get_provider_statuses()})

                if method == "GET" and path == "/api/payments":
                    actor = self._require_auth(FINANCE_ROLES + ("SUPPORT_STAFF",))
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    st = qs.get("status") or "ALL"
                    prov = qs.get("provider") or "ALL"
                    sql = """
                      SELECT p.id, p.reference, p.receipt_number as receiptNumber, p.provider,
                             p.phone_number as phoneNumber, p.amount_tzs as amountTzs,
                             p.status, p.is_test as isTest, p.payment_mode as paymentMode,
                             p.external_tx_id as externalTxId, p.verified_at as verifiedAt,
                             p.refunded_at as refundedAt, p.created_at as createdAt,
                             pk.name as packageName, v.code_masked as voucherMasked,
                             c.full_name as customerName
                      FROM payments p JOIN packages pk ON pk.id = p.package_id
                      LEFT JOIN vouchers v ON v.id = p.voucher_id
                      LEFT JOIN customers c ON c.id = p.customer_id
                      WHERE p.business_id = ?
                    """
                    params_p: list[Any] = [biz_id]
                    if st != "ALL":
                        sql += " AND p.status = ?"
                        params_p.append(st)
                    if prov != "ALL":
                        sql += " AND p.provider = ?"
                        params_p.append(prov)
                    sql += " ORDER BY p.created_at DESC LIMIT 300"
                    rows = db.query_all(sql, tuple(params_p))
                    for r in rows:
                        r["isTest"] = bool(r["isTest"])
                    return self._send_json(200, {"payments": rows})

                m = re.fullmatch(r"/api/payments/([^/]+)/refund", path)
                if method == "POST" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES + ("ACCOUNTANT",))
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    pid = urllib.parse.unquote(m.group(1))
                    pay = db.query_one("SELECT * FROM payments WHERE id = ?", (pid,))
                    if not pay:
                        return self._send_json(404, {"error": "Payment not found"})
                    if str(pay["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    if pay["status"] != "COMPLETED":
                        return self._send_json(400, {"error": "Only completed payments can be marked refunded"})
                    now_iso = utc_now_iso()

                    def _ref_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            "UPDATE payments SET status = 'REFUNDED', refunded_at = ?, updated_at = ? WHERE id = ? AND business_id = ?",
                            (now_iso, now_iso, pid, biz_id),
                        )
                        if pay.get("voucher_id"):
                            conn.execute(
                                "UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'Payment refunded', updated_at = ? WHERE id = ? AND status != 'REVOKED'",
                                (now_iso, now_iso, str(pay["voucher_id"])),
                            )
                        conn.execute(
                            "UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE payment_id = ?",
                            (now_iso, now_iso, pid),
                        )
                        conn.execute("UPDATE invoices SET status = 'REFUNDED' WHERE payment_id = ?", (pid,))

                    db.transaction(_ref_tx)
                    record_audit_log(db, actor, "PAYMENT_REFUNDED", "Payment", pid, ip, {"reference": pay["reference"]})
                    self._emit(events, "payment:updated", {"reference": pay["reference"], "status": "REFUNDED", "businessId": biz_id})
                    return self._send_json(200, {"ok": True}, events)

                if method == "GET" and path == "/api/invoices":
                    actor = self._require_auth(FINANCE_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rows = db.query_all(
                        """
                        SELECT id, invoice_number as invoiceNumber, ledger_type as ledgerType,
                               payment_reference as paymentReference, customer_name as customerName,
                               phone_number as phoneNumber, item_description as itemDescription,
                               subtotal_tzs as subtotalTzs, tax_tzs as taxTzs, total_tzs as totalTzs,
                               currency, is_test as isTest, status, issued_at as issuedAt
                        FROM invoices WHERE business_id = ? ORDER BY issued_at DESC LIMIT 200
                        """,
                        (biz_id,),
                    )
                    for r in rows:
                        r["isTest"] = bool(r["isTest"])
                    return self._send_json(200, {"invoices": rows})

                m = re.fullmatch(r"/api/invoices/([^/]+)", path)
                if method == "GET" and m:
                    actor = self._require_auth(FINANCE_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    inv_id = urllib.parse.unquote(m.group(1))
                    inv = db.query_one("SELECT * FROM invoices WHERE id = ?", (inv_id,))
                    if not inv:
                        return self._send_json(404, {"error": "Invoice not found"})
                    if str(inv["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    inv["isTest"] = bool(inv["is_test"])
                    return self._send_json(200, {"invoice": inv})

                # ---------------------------------------------------------------
                # MIKROTIK ROUTERS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/routers":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    routers = db.query_all(
                        """
                        SELECT r.id, r.business_id as businessId, r.location_id as locationId, l.name as locationName,
                               r.name, r.host, r.api_port as apiPort, r.use_tls as useTls, r.username,
                               r.hotspot_server as hotspotServer, r.router_os_family as routerOsFamily,
                               r.wireguard_pubkey as wireguardPubkey, r.status, r.cpu_load as cpuLoad,
                               r.memory_used_bytes as memoryUsedBytes, r.memory_total_bytes as memoryTotalBytes,
                               r.uptime, r.router_os_version as routerOsVersion, r.board_name as boardName,
                               r.last_error as lastError, r.last_checked_at as lastCheckedAt, r.created_at as createdAt
                        FROM routers r LEFT JOIN locations l ON l.id = r.location_id
                        WHERE r.business_id = ? ORDER BY r.created_at DESC
                        """,
                        (biz_id,),
                    )
                    return self._send_json(200, {"routers": routers})

                if method == "POST" and path == "/api/routers":
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    name = clean_str(body.get("name"), 2, 80)
                    host = str(body.get("host") or "").strip()[:255]
                    api_port = clean_int(body.get("apiPort"), 1, 65535, 8728)
                    use_tls = clean_bool(body.get("useTls"), False)
                    uname = str(body.get("username") or "").strip()[:80]
                    pwd = str(body.get("password") or "").strip()[:128]
                    hs_srv = str(body.get("hotspotServer") or "").strip()[:80]
                    os_fam = clean_enum(body.get("routerOsFamily"), {"ROUTEROS_V6", "ROUTEROS_V7"}, "ROUTEROS_V7")
                    if not name or api_port is None or use_tls is None or not os_fam:
                        return self._send_json(400, {"error": "Invalid router configuration"})
                    if host == "8.8.8.8":
                        return self._send_json(400, {"error": "8.8.8.8 is a public DNS IP and cannot be used as a MikroTik router address."})
                    if db.query_one("SELECT id FROM routers WHERE business_id = ? AND LOWER(name) = LOWER(?)", (biz_id, name)):
                        return self._send_json(409, {"error": "A router with this name already exists in your workspace"})
                    if host:
                        if db.query_one("SELECT id FROM routers WHERE business_id = ? AND host = ? AND api_port = ?", (biz_id, host, api_port)):
                            return self._send_json(409, {"error": "A router with this host and port already exists"})
                    else:
                        if db.query_one("SELECT id FROM routers WHERE business_id = ? AND host = '' AND api_port = ?", (biz_id, api_port)):
                            return self._send_json(409, {"error": "An unconfigured router profile already exists. Edit it to add hardware details."})

                    rid = generate_id("rtr")
                    now_iso = utc_now_iso()
                    rad_sec = secrets.token_hex(12)
                    db.execute(
                        """
                        INSERT INTO routers (
                          id, business_id, location_id, name, host, api_port, use_tls, username, password_encrypted,
                          hotspot_server, router_os_family, wireguard_pubkey, radius_secret, status, last_error, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_CONNECTED', ?, ?, ?)
                        """,
                        (
                            rid, biz_id, clean_opt_str(body.get("locationId"), 64), name, host, api_port,
                            1 if use_tls else 0, uname, encrypt_secret(pwd) if pwd else "", hs_srv, os_fam,
                            clean_opt_str(body.get("wireguardPubkey"), 128), rad_sec,
                            None if host else "Awaiting MikroTik hardware credentials", now_iso, now_iso,
                        ),
                    )
                    record_audit_log(db, actor, "ROUTER_ADDED", "Router", rid, ip, {"name": name, "host": host or None, "apiPort": api_port})
                    created = db.query_one(
                        "SELECT id, business_id as businessId, location_id as locationId, name, host, api_port as apiPort, use_tls as useTls, username, hotspot_server as hotspotServer, router_os_family as routerOsFamily, status, last_error as lastError, created_at as createdAt FROM routers WHERE id = ?",
                        (rid,),
                    )
                    return self._send_json(201, {"router": created})

                m = re.fullmatch(r"/api/routers/([^/]+)/test", path)
                if method == "POST" and m:
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rid = urllib.parse.unquote(m.group(1))
                    rrow = db.query_one("SELECT id, business_id FROM routers WHERE id = ?", (rid,))
                    if not rrow:
                        return self._send_json(404, {"error": "Router not found"})
                    if str(rrow["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    telemetry = sync_router_telemetry(db, rid)
                    updated = db.query_one(
                        "SELECT id, name, host, api_port as apiPort, use_tls as useTls, username, hotspot_server as hotspotServer, router_os_family as routerOsFamily, status, cpu_load as cpuLoad, memory_used_bytes as memoryUsedBytes, memory_total_bytes as memoryTotalBytes, uptime, router_os_version as routerOsVersion, board_name as boardName, last_error as lastError, last_checked_at as lastCheckedAt FROM routers WHERE id = ?",
                        (rid,),
                    )
                    record_audit_log(db, actor, "ROUTER_CONNECTION_TEST", "Router", rid, ip, {"connected": telemetry.connected, "error": telemetry.error})
                    self._emit(events, "router:status", {"routerId": rid, "connected": telemetry.connected, "businessId": biz_id})
                    return self._send_json(200, {"router": updated, "telemetry": telemetry.to_dict()}, events)

                m = re.fullmatch(r"/api/routers/([^/]+)/interfaces", path)
                if method == "GET" and m:
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rid = urllib.parse.unquote(m.group(1))
                    rrow = db.query_one("SELECT id, business_id FROM routers WHERE id = ?", (rid,))
                    if not rrow:
                        return self._send_json(404, {"error": "Router not found"})
                    if str(rrow["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    ifaces = db.query_all(
                        "SELECT id, name, type, running, disabled, rx_bytes as rxBytes, tx_bytes as txBytes, updated_at as updatedAt FROM router_interfaces WHERE router_id = ? ORDER BY name ASC",
                        (rid,),
                    )
                    return self._send_json(200, {"interfaces": ifaces})

                m = re.fullmatch(r"/api/routers/([^/]+)/sync-profiles", path)
                if method == "POST" and m:
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rid = urllib.parse.unquote(m.group(1))
                    rrow = db.query_one("SELECT id, business_id FROM routers WHERE id = ?", (rid,))
                    if not rrow:
                        return self._send_json(404, {"error": "Router not found"})
                    if str(rrow["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    pkgs = db.query_all("SELECT * FROM packages WHERE is_active = 1 AND business_id = ?", (biz_id,))
                    results = []
                    for pkg in pkgs:
                        r = push_hotspot_profile_to_router(db, rid, f"trax-{pkg['id']}", int(pkg["download_kbps"]), int(pkg["upload_kbps"]))
                        results.append({"packageName": pkg["name"], **r})
                    record_audit_log(db, actor, "ROUTER_PROFILES_SYNCED", "Router", rid, ip, {"count": len(results)})
                    return self._send_json(200, {"results": results})

                m = re.fullmatch(r"/api/routers/([^/]+)/wireguard-snippet", path)
                if method == "GET" and m:
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rid = urllib.parse.unquote(m.group(1))
                    rrow = db.query_one("SELECT * FROM routers WHERE id = ?", (rid,))
                    if not rrow:
                        return self._send_json(404, {"error": "Router not found"})
                    if str(rrow["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    snippet = generate_mikrotik_wireguard_snippet(
                        router_name=str(rrow["name"]),
                        cloud_wg_public_key=get_env("WIREGUARD_CLOUD_PUBKEY") or "<CLOUD_WG_PUBLIC_KEY>",
                        cloud_wg_endpoint=get_env("WIREGUARD_ENDPOINT") or "<CLOUD_VPS_IP>:51820",
                        router_tunnel_cidr="10.66.0.10/24",
                        cloud_radius_ip="10.66.0.1",
                        radius_secret=str(rrow.get("radius_secret") or get_env("RADIUS_SHARED_SECRET") or "<RADIUS_SHARED_SECRET>"),
                        hotspot_server=str(rrow.get("hotspot_server") or ""),
                    )
                    return self._send_json(200, {"snippet": snippet, "routerOsFamily": str(rrow.get("router_os_family") or "ROUTEROS_V7")})

                m = re.fullmatch(r"/api/routers/([^/]+)", path)
                if method == "PATCH" and m:
                    actor = self._require_auth(NETWORK_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    rid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT id, business_id FROM routers WHERE id = ?", (rid,))
                    if not ex:
                        return self._send_json(404, {"error": "Router not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    host_val = str(body["host"]).strip() if "host" in body and isinstance(body["host"], str) else None
                    if host_val == "8.8.8.8":
                        return self._send_json(400, {"error": "8.8.8.8 is a public DNS IP and cannot be used as a MikroTik router address."})
                    pwd_val = str(body["password"]).strip() if "password" in body and isinstance(body["password"], str) and body["password"].strip() else None
                    use_tls = clean_bool(body.get("useTls")) if "useTls" in body else None
                    db.execute(
                        """
                        UPDATE routers
                        SET name = COALESCE(?, name),
                            host = COALESCE(?, host),
                            api_port = COALESCE(?, api_port),
                            use_tls = COALESCE(?, use_tls),
                            username = COALESCE(?, username),
                            password_encrypted = COALESCE(?, password_encrypted),
                            hotspot_server = COALESCE(?, hotspot_server),
                            location_id = CASE WHEN ? THEN ? ELSE location_id END,
                            router_os_family = COALESCE(?, router_os_family),
                            updated_at = ?
                        WHERE id = ? AND business_id = ?
                        """,
                        (
                            clean_str(body.get("name"), 2, 80) if "name" in body else None,
                            host_val,
                            clean_int(body.get("apiPort"), 1, 65535) if "apiPort" in body else None,
                            (1 if use_tls else 0) if use_tls is not None else None,
                            str(body["username"]).strip()[:80] if "username" in body and isinstance(body["username"], str) else None,
                            encrypt_secret(pwd_val) if pwd_val else None,
                            str(body["hotspotServer"]).strip()[:80] if "hotspotServer" in body and isinstance(body["hotspotServer"], str) else None,
                            1 if "locationId" in body else 0,
                            clean_opt_str(body.get("locationId"), 64),
                            clean_enum(body.get("routerOsFamily"), {"ROUTEROS_V6", "ROUTEROS_V7"}) if "routerOsFamily" in body else None,
                            utc_now_iso(),
                            rid,
                            biz_id,
                        ),
                    )
                    record_audit_log(db, actor, "ROUTER_UPDATED", "Router", rid, ip)
                    updated = db.query_one(
                        "SELECT id, business_id as businessId, location_id as locationId, name, host, api_port as apiPort, use_tls as useTls, username, hotspot_server as hotspotServer, router_os_family as routerOsFamily, status, last_error as lastError FROM routers WHERE id = ?",
                        (rid,),
                    )
                    return self._send_json(200, {"router": updated})

                if method == "DELETE" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rid = urllib.parse.unquote(m.group(1))
                    ex = db.query_one("SELECT id, business_id, name FROM routers WHERE id = ?", (rid,))
                    if not ex:
                        return self._send_json(404, {"error": "Router not found"})
                    if str(ex["business_id"]) != biz_id:
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    db.execute("DELETE FROM routers WHERE id = ? AND business_id = ?", (rid, biz_id))
                    record_audit_log(db, actor, "ROUTER_REMOVED", "Router", rid, ip, {"name": ex["name"]})
                    return self._send_json(200, {"ok": True})

                # ---------------------------------------------------------------
                # REPORTS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/reports/overview":
                    actor = self._require_auth(FINANCE_ROLES + ("NETWORK_OPERATOR",))
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    from_dt = qs.get("from") or "1970-01-01T00:00:00.000Z"
                    to_dt = qs.get("to") or "2999-12-31T23:59:59.999Z"
                    rev_by_prov = db.query_all(
                        "SELECT provider, COUNT(*) as txCount, COALESCE(SUM(amount_tzs), 0) as totalTzs FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ? AND verified_at <= ? GROUP BY provider",
                        (biz_id, from_dt, to_dt),
                    )
                    test_stats = db.query_one(
                        "SELECT COUNT(*) as testTokensIssued, COALESCE(SUM(amount_tzs), 0) as testNominalTzs FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 1 AND verified_at >= ? AND verified_at <= ?",
                        (biz_id, from_dt, to_dt),
                    ) or {"testTokensIssued": 0, "testNominalTzs": 0}
                    test_vouchers = db.query_one(
                        "SELECT COUNT(*) as testVouchersCount FROM vouchers WHERE business_id = ? AND is_test = 1 AND created_at >= ? AND created_at <= ?",
                        (biz_id, from_dt, to_dt),
                    ) or {"testVouchersCount": 0}
                    pkg_sales = db.query_all(
                        """
                        SELECT pk.name as packageName, pk.category, pk.price_tzs as unitPriceTzs,
                               COUNT(v.id) as vouchersIssued,
                               SUM(CASE WHEN v.status IN ('ACTIVE','EXPIRED') THEN 1 ELSE 0 END) as vouchersRedeemed
                        FROM packages pk
                        LEFT JOIN vouchers v ON v.package_id = pk.id AND v.created_at >= ? AND v.created_at <= ?
                        WHERE pk.business_id = ? GROUP BY pk.id ORDER BY vouchersIssued DESC
                        """,
                        (from_dt, to_dt, biz_id),
                    )
                    sess_stats = db.query_all(
                        "SELECT status, COUNT(*) as count, COALESCE(SUM(bytes_in), 0) as totalRxBytes, COALESCE(SUM(bytes_out), 0) as totalTxBytes FROM sessions WHERE business_id = ? AND started_at >= ? AND started_at <= ? GROUP BY status",
                        (biz_id, from_dt, to_dt),
                    )
                    return self._send_json(
                        200,
                        {
                            "revenueByProvider": rev_by_prov,
                            "testSummary": {
                                "testVouchersCount": int(test_vouchers.get("testVouchersCount") or 0),
                                "testTokensIssued": int(test_stats.get("testTokensIssued") or 0),
                                "testNominalTzs": int(test_stats.get("testNominalTzs") or 0),
                            },
                            "packageSales": pkg_sales,
                            "sessionStats": sess_stats,
                        },
                    )

                if method == "GET" and path == "/api/reports/export/csv":
                    actor = self._require_auth(FINANCE_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    rtype = qs.get("type") or "payments"
                    if rtype == "sessions":
                        rows = db.query_all(
                            """
                            SELECT s.id, v.code_masked, p.name as package_name, d.device_label, s.ip_address,
                                   s.status, s.bytes_in, s.bytes_out, s.started_at, s.expires_at, s.ended_at
                            FROM sessions s JOIN vouchers v ON v.id = s.voucher_id
                            JOIN packages p ON p.id = v.package_id JOIN devices d ON d.id = s.device_id
                            WHERE s.business_id = ? ORDER BY s.started_at DESC
                            """,
                            (biz_id,),
                        )
                        csv_rows = [[r["id"], r["code_masked"], r["package_name"], r.get("device_label") or "", r.get("ip_address") or "", r["status"], r["bytes_in"], r["bytes_out"], r["started_at"], r["expires_at"], r.get("ended_at") or ""] for r in rows]
                        return self._send_csv(
                            "traxlink-sessions-report.csv",
                            _csv_response(["Session_ID", "Voucher", "Package", "Device", "IP", "Status", "Bytes_In", "Bytes_Out", "Started_At", "Expires_At", "Ended_At"], csv_rows),
                        )
                    rows = db.query_all(
                        """
                        SELECT p.reference, p.receipt_number, p.provider, p.phone_number, p.amount_tzs,
                               p.status, p.is_test, p.payment_mode, pk.name as package_name, p.verified_at, p.created_at
                        FROM payments p JOIN packages pk ON pk.id = p.package_id
                        WHERE p.business_id = ? ORDER BY p.created_at DESC
                        """,
                        (biz_id,),
                    )
                    csv_rows = [[r["reference"], r.get("receipt_number") or "", r["provider"], r["phone_number"], r["amount_tzs"], r["status"], "TEST_STANDALONE" if r["is_test"] else "LIVE_VERIFIED", r["package_name"], r.get("verified_at") or "", r["created_at"]] for r in rows]
                    return self._send_csv(
                        "traxlink-payments-report.csv",
                        _csv_response(["Reference", "Receipt", "Provider", "Phone", "Amount_TZS", "Status", "Mode", "Package", "Verified_At", "Created_At"], csv_rows),
                    )

                # ---------------------------------------------------------------
                # NOTIFICATIONS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/notifications":
                    actor = self._require_auth(ALL_BUSINESS_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    notifs = db.query_all(
                        "SELECT id, type, severity, title, message, metadata, is_read as isRead, created_at as createdAt FROM notifications WHERE business_id = ? ORDER BY created_at DESC LIMIT 100",
                        (biz_id,),
                    )
                    return self._send_json(200, {"notifications": notifs})

                if method == "POST" and path == "/api/notifications/read-all":
                    actor = self._require_auth()
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    db.execute("UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND business_id = ?", (biz_id,))
                    return self._send_json(200, {"ok": True})

                m = re.fullmatch(r"/api/notifications/([^/]+)/read", path)
                if method == "POST" and m:
                    actor = self._require_auth()
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    nid = urllib.parse.unquote(m.group(1))
                    db.execute("UPDATE notifications SET is_read = 1 WHERE id = ? AND business_id = ?", (nid, biz_id))
                    return self._send_json(200, {"ok": True})

                # ---------------------------------------------------------------
                # STAFF & AUDIT LOGS
                # ---------------------------------------------------------------
                if method == "GET" and path == "/api/staff/sessions":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    sessions = db.query_all(
                        """
                        SELECT ss.id, ss.ip_address as ipAddress, ss.user_agent as userAgent,
                               ss.expires_at as expiresAt, ss.revoked_at as revokedAt, ss.created_at as createdAt,
                               u.email, u.full_name as fullName, u.role
                        FROM staff_sessions ss JOIN admin_users u ON u.id = ss.admin_user_id
                        WHERE u.business_id = ? ORDER BY ss.created_at DESC LIMIT 100
                        """,
                        (biz_id,),
                    )
                    return self._send_json(200, {"sessions": sessions})

                m = re.fullmatch(r"/api/staff/sessions/([^/]+)/revoke", path)
                if method == "POST" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    ssid = urllib.parse.unquote(m.group(1))
                    target = db.query_one(
                        "SELECT ss.id, u.business_id FROM staff_sessions ss JOIN admin_users u ON u.id = ss.admin_user_id WHERE ss.id = ?",
                        (ssid,),
                    )
                    if not target:
                        return self._send_json(404, {"error": "Staff session not found"})
                    if str(target["business_id"]) != biz_id and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    db.execute("UPDATE staff_sessions SET revoked_at = ? WHERE id = ?", (utc_now_iso(), ssid))
                    record_audit_log(db, actor, "STAFF_SESSION_REVOKED", "StaffSession", ssid, ip)
                    return self._send_json(200, {"ok": True})

                if method == "GET" and path == "/api/staff":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    staff = db.query_all(
                        """
                        SELECT u.id, u.email, u.full_name as fullName, u.role, u.is_active as isActive,
                               u.last_login_at as lastLoginAt, u.created_at as createdAt,
                               s.staff_code as staffCode, s.department, s.phone, s.is_suspended as isSuspended
                        FROM admin_users u LEFT JOIN staff s ON s.admin_user_id = u.id
                        WHERE u.business_id = ? ORDER BY u.created_at DESC
                        """,
                        (biz_id,),
                    )
                    return self._send_json(200, {"staff": staff})

                if method == "POST" and path == "/api/staff":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    email = body.get("email")
                    full_name = clean_str(body.get("fullName"), 2, 100)
                    password = clean_str(body.get("password"), 8, 128)
                    role = clean_enum(body.get("role"), ALL_STAFF_ROLES)
                    dept = clean_str(body.get("department") or "Operations", 2, 80)
                    if not is_valid_email(email) or not full_name or not password or not role or not dept:
                        return self._send_json(400, {"error": "Invalid staff account payload"})
                    if role == "SUPER_ADMIN" and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Only a Super Admin can create another Super Admin"})
                    email_lower = str(email).strip().lower()
                    if db.query_one("SELECT id FROM admin_users WHERE LOWER(email) = ?", (email_lower,)):
                        return self._send_json(409, {"error": "A staff account with this email already exists"})

                    aid = generate_id("adm")
                    staff_code = generate_reference("STF")
                    now_iso = utc_now_iso()
                    pw_hash = hash_password(password)

                    def _stf_tx(conn: sqlite3.Connection) -> None:
                        conn.execute(
                            "INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)",
                            (aid, biz_id, email_lower, full_name, pw_hash, role, now_iso, now_iso),
                        )
                        conn.execute(
                            "INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, phone, role, is_suspended) VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
                            (generate_id("stf"), biz_id, aid, staff_code, dept, clean_opt_str(body.get("phone"), 24), role),
                        )

                    db.transaction(_stf_tx)
                    record_audit_log(db, actor, "STAFF_CREATED", "Staff", aid, ip, {"email": email_lower, "role": role})
                    return self._send_json(
                        201,
                        {
                            "staff": {
                                "id": aid,
                                "businessId": biz_id,
                                "email": email_lower,
                                "fullName": full_name,
                                "role": role,
                                "staffCode": staff_code,
                                "department": dept,
                            }
                        },
                    )

                m = re.fullmatch(r"/api/staff/([^/]+)/reset-password", path)
                if method == "POST" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    sid = urllib.parse.unquote(m.group(1))
                    new_pw = clean_str(body.get("newPassword"), 8, 128)
                    if not new_pw:
                        return self._send_json(400, {"error": "New password must be at least 8 characters"})
                    target = db.query_one("SELECT id, business_id, role FROM admin_users WHERE id = ?", (sid,))
                    if not target:
                        return self._send_json(404, {"error": "Staff user not found"})
                    if str(target["business_id"]) != biz_id and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    if target["role"] == "SUPER_ADMIN" and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Only Super Admin can reset a Super Admin password"})
                    now_iso = utc_now_iso()
                    db.execute("UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?", (hash_password(new_pw), now_iso, sid))
                    db.execute("UPDATE staff_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL", (now_iso, sid))
                    record_audit_log(db, actor, "STAFF_PASSWORD_RESET", "Staff", sid, ip)
                    return self._send_json(200, {"ok": True})

                m = re.fullmatch(r"/api/staff/([^/]+)/recovery-code", path)
                if method == "POST" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    sid = urllib.parse.unquote(m.group(1))
                    target = db.query_one("SELECT id, business_id, email, role, is_active FROM admin_users WHERE id = ?", (sid,))
                    if not target or not target["is_active"]:
                        return self._send_json(404, {"error": "Active staff user not found"})
                    if str(target["business_id"]) != biz_id and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    if target["role"] == "SUPER_ADMIN" and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Only Super Admin can issue a recovery code for a Super Admin"})
                    raw_code = secrets.token_hex(4).upper()
                    formatted = f"{raw_code[:4]}-{raw_code[4:8]}"
                    now_iso = utc_now_iso()
                    exp_at = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="milliseconds").replace("+00:00", "Z")

                    def _rec_tx(conn: sqlite3.Connection) -> None:
                        conn.execute("UPDATE password_reset_tokens SET used_at = ? WHERE admin_user_id = ? AND used_at IS NULL", (now_iso, sid))
                        conn.execute(
                            "INSERT INTO password_reset_tokens (id, admin_user_id, token_hash, expires_at, requested_ip) VALUES (?, ?, ?, ?, ?)",
                            (generate_id("prt"), sid, sha256_hex(raw_code), exp_at, ip),
                        )

                    db.transaction(_rec_tx)
                    record_audit_log(db, actor, "STAFF_RECOVERY_CODE_ISSUED", "Staff", sid, ip, {"targetEmail": target["email"]})
                    return self._send_json(200, {"code": formatted, "expiresAt": exp_at, "email": target["email"]})

                m = re.fullmatch(r"/api/staff/([^/]+)", path)
                if method == "PATCH" and m:
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    body, _, err = self._read_json()
                    if err or body is None:
                        return self._send_json(err[0], {"error": err[1]})
                    biz_id = self._resolve_scope(actor, qs, body, path)
                    if not biz_id:
                        return
                    sid = urllib.parse.unquote(m.group(1))
                    target = db.query_one("SELECT * FROM admin_users WHERE id = ?", (sid,))
                    if not target:
                        return self._send_json(404, {"error": "Staff user not found"})
                    if str(target["business_id"]) != biz_id and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Cross-tenant access denied"})
                    new_role = clean_enum(body.get("role"), ALL_STAFF_ROLES) if "role" in body else None
                    is_susp = clean_bool(body.get("isSuspended")) if "isSuspended" in body else None
                    dept = clean_str(body.get("department"), 2, 80) if "department" in body else None
                    if ("role" in body and not new_role) or ("isSuspended" in body and is_susp is None) or ("department" in body and not dept):
                        return self._send_json(400, {"error": "Invalid staff update"})
                    if (target["role"] == "SUPER_ADMIN" or new_role == "SUPER_ADMIN") and actor.role != "SUPER_ADMIN":
                        return self._send_json(403, {"error": "Only Super Admin can modify a Super Admin account"})
                    if sid == actor.id and is_susp:
                        return self._send_json(400, {"error": "You cannot suspend your own account"})
                    now_iso = utc_now_iso()

                    def _up_stf(conn: sqlite3.Connection) -> None:
                        if new_role:
                            conn.execute("UPDATE admin_users SET role = ?, updated_at = ? WHERE id = ?", (new_role, now_iso, sid))
                            conn.execute("UPDATE staff SET role = ?, updated_at = ? WHERE admin_user_id = ?", (new_role, now_iso, sid))
                        if is_susp is not None:
                            conn.execute("UPDATE admin_users SET is_active = ?, updated_at = ? WHERE id = ?", (0 if is_susp else 1, now_iso, sid))
                            conn.execute("UPDATE staff SET is_suspended = ?, updated_at = ? WHERE admin_user_id = ?", (1 if is_susp else 0, now_iso, sid))
                            if is_susp:
                                conn.execute("UPDATE staff_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL", (now_iso, sid))
                        if dept:
                            conn.execute("UPDATE staff SET department = ?, updated_at = ? WHERE admin_user_id = ?", (dept, now_iso, sid))

                    db.transaction(_up_stf)
                    record_audit_log(db, actor, "STAFF_UPDATED", "Staff", sid, ip, body)
                    return self._send_json(200, {"ok": True})

                if method == "GET" and path == "/api/audit-logs":
                    actor = self._require_auth(BUSINESS_MANAGEMENT_ROLES)
                    if not actor:
                        return
                    biz_id = self._resolve_scope(actor, qs, None, path)
                    if not biz_id:
                        return
                    action_f = (qs.get("action") or "").strip()
                    if action_f:
                        logs = db.query_all(
                            "SELECT * FROM audit_logs WHERE business_id = ? AND action LIKE ? ORDER BY created_at DESC LIMIT 200",
                            (biz_id, f"%{action_f}%"),
                        )
                    else:
                        logs = db.query_all(
                            "SELECT * FROM audit_logs WHERE business_id = ? ORDER BY created_at DESC LIMIT 200",
                            (biz_id,),
                        )
                    return self._send_json(200, {"logs": logs})

                return self._send_json(404, {"error": f"API endpoint not found: {method} {path}"})
            except Exception as exc:
                print(f"[TRAX LINK Python API] Unhandled error on {method} {path}: {exc}", flush=True)
                return self._send_json(500, {"error": "Internal server error"})

    return TraxRequestHandler
