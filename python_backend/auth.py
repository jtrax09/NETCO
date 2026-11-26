"""Multi-tenant RBAC authentication, Firebase token verification, and audit logging."""

from __future__ import annotations

import json
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any

from .config import load_firebase_web_config
from .db import DEFAULT_BUSINESS_ID, DatabaseManager, utc_now_iso
from .security import generate_id, generate_reference, sha256_hex

BUSINESS_MANAGEMENT_ROLES = ("SUPER_ADMIN", "BUSINESS_OWNER", "ADMIN")
FINANCE_ROLES = ("SUPER_ADMIN", "BUSINESS_OWNER", "ADMIN", "ACCOUNTANT", "CASHIER")
NETWORK_ROLES = ("SUPER_ADMIN", "BUSINESS_OWNER", "ADMIN", "NETWORK_OPERATOR")
ALL_BUSINESS_ROLES = (
    "SUPER_ADMIN",
    "BUSINESS_OWNER",
    "ADMIN",
    "ACCOUNTANT",
    "NETWORK_OPERATOR",
    "SUPPORT_STAFF",
    "CASHIER",
)

BOOTSTRAP_SUPER_ADMIN_EMAILS = {
    "undergodmusic255@gmail.com",
    "mlingwajastine277@gmail.com",
}


@dataclass
class AuthenticatedActor:
    id: str
    business_id: str
    business_name: str
    business_status: str
    email: str
    full_name: str
    role: str
    auth_source: str

    def to_dict(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "businessId": self.business_id,
            "businessName": self.business_name,
            "businessStatus": self.business_status,
            "email": self.email,
            "fullName": self.full_name,
            "role": self.role,
            "authSource": self.auth_source,
        }


def get_client_ip(headers: Any, client_address: tuple[str, int] | None) -> str:
    forwarded = headers.get("X-Forwarded-For") or headers.get("x-forwarded-for")
    if isinstance(forwarded, str) and forwarded.strip():
        return forwarded.split(",")[0].strip()
    if client_address:
        return str(client_address[0])
    return "0.0.0.0"


def record_audit_log(
    db: DatabaseManager,
    actor: AuthenticatedActor | dict[str, Any],
    action: str,
    entity_type: str,
    entity_id: str | None,
    ip_address: str | None,
    details: dict[str, Any] | None = None,
) -> None:
    if isinstance(actor, AuthenticatedActor):
        business_id = actor.business_id
        actor_id = actor.id
        actor_email = actor.email
        actor_role = actor.role
    else:
        business_id = actor.get("businessId")
        actor_id = actor.get("id")
        actor_email = str(actor.get("email", ""))
        actor_role = str(actor.get("role", ""))

    db.execute(
        """
        INSERT INTO audit_logs (id, business_id, actor_id, actor_email, actor_role, action, entity_type, entity_id, ip_address, details)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            generate_id("aud"),
            business_id,
            actor_id,
            actor_email,
            actor_role,
            action,
            entity_type,
            entity_id,
            ip_address,
            json.dumps(details) if details is not None else None,
        ),
    )


def _verify_firebase_id_token(id_token: str) -> dict[str, Any] | None:
    """Verify a Firebase ID token via Google Identity Toolkit REST endpoint."""
    cfg = load_firebase_web_config()
    api_key = str(cfg.get("apiKey") or "").strip()
    if not api_key:
        return None
    url = f"https://identitytoolkit.googleapis.com/v1/accounts:lookup?key={api_key}"
    payload = json.dumps({"idToken": id_token}).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        users = data.get("users") or []
        if not users:
            return None
        user = users[0]
        return {
            "uid": str(user.get("localId") or ""),
            "email": str(user.get("email") or ""),
            "email_verified": bool(user.get("emailVerified")),
            "name": str(user.get("displayName") or ""),
        }
    except (urllib.error.URLError, TimeoutError, ValueError, KeyError):
        return None


def authenticate_bearer_token(
    db: DatabaseManager, auth_header: str | None
) -> tuple[AuthenticatedActor | None, tuple[int, str] | None]:
    if not auth_header or not auth_header.startswith("Bearer "):
        return None, (401, "Authentication required")

    token = auth_header[len("Bearer ") :].strip()
    if not token:
        return None, (401, "Invalid authorization token")

    token_hash = sha256_hex(token)
    now_iso = utc_now_iso()
    session_row = db.query_one(
        """
        SELECT s.id as session_id, s.expires_at, s.revoked_at,
               u.id as user_id, u.business_id, u.email, u.full_name, u.role, u.is_active,
               st.is_suspended,
               b.name as business_name, b.status as business_status
        FROM staff_sessions s
        JOIN admin_users u ON u.id = s.admin_user_id
        LEFT JOIN staff st ON st.admin_user_id = u.id
        LEFT JOIN businesses b ON b.id = u.business_id
        WHERE s.token_hash = ?
        """,
        (token_hash,),
    )

    if session_row:
        if session_row["revoked_at"] or str(session_row["expires_at"]) <= now_iso:
            return None, (401, "Session expired or revoked")
        if not session_row["is_active"] or session_row["is_suspended"]:
            return None, (403, "Account is suspended or deactivated")
        role = str(session_row["role"])
        biz_status = str(session_row["business_status"] or "ACTIVE")
        if role != "SUPER_ADMIN" and biz_status == "SUSPENDED":
            return None, (403, "Business workspace is suspended. Contact TRAX LINK support.")
        return (
            AuthenticatedActor(
                id=str(session_row["user_id"]),
                business_id=str(session_row["business_id"] or DEFAULT_BUSINESS_ID),
                business_name=str(session_row["business_name"] or "TRAX LINK Primary Hotspot"),
                business_status=biz_status,
                email=str(session_row["email"]),
                full_name=str(session_row["full_name"]),
                role=role,
                auth_source="SESSION",
            ),
            None,
        )

    # Fallback: verify Firebase JWT ID token if token looks like a JWT
    if token.count(".") == 2:
        decoded = _verify_firebase_id_token(token)
        if not decoded:
            return None, (401, "Invalid or expired authentication token")
        if not decoded.get("email") or not decoded.get("email_verified"):
            return None, (403, "Verified email required")

        email_lower = str(decoded["email"]).lower()
        admin_row = db.query_one(
            """
            SELECT u.*, st.is_suspended, b.name as business_name, b.status as business_status
            FROM admin_users u
            LEFT JOIN staff st ON st.admin_user_id = u.id
            LEFT JOIN businesses b ON b.id = u.business_id
            WHERE LOWER(u.email) = ?
            """,
            (email_lower,),
        )

        if not admin_row and email_lower in BOOTSTRAP_SUPER_ADMIN_EMAILS:
            new_id = generate_id("adm")
            display_name = decoded.get("name") or "TRAX LINK Super Admin"
            code_exists = db.query_one("SELECT id FROM staff WHERE staff_code = ?", ("STF-001",))
            staff_code = generate_reference("STF") if code_exists else "STF-001"
            db.execute(
                """
                INSERT INTO admin_users (id, business_id, firebase_uid, email, full_name, role, is_active, last_login_at)
                VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 1, ?)
                """,
                (new_id, DEFAULT_BUSINESS_ID, decoded["uid"], email_lower, display_name, now_iso),
            )
            db.execute(
                """
                INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, role)
                VALUES (?, ?, ?, ?, 'Executive Operations', 'SUPER_ADMIN')
                """,
                (generate_id("stf"), DEFAULT_BUSINESS_ID, new_id, staff_code),
            )
            admin_row = db.query_one(
                """
                SELECT u.*, st.is_suspended, b.name as business_name, b.status as business_status
                FROM admin_users u
                LEFT JOIN staff st ON st.admin_user_id = u.id
                LEFT JOIN businesses b ON b.id = u.business_id
                WHERE u.id = ?
                """,
                (new_id,),
            )

        if not admin_row:
            return None, (403, "Account is not authorized as TRAX LINK staff")
        if not admin_row["is_active"] or admin_row["is_suspended"]:
            return None, (403, "Staff account is suspended or deactivated")
        role = str(admin_row["role"])
        biz_status = str(admin_row["business_status"] or "ACTIVE")
        if role != "SUPER_ADMIN" and biz_status == "SUSPENDED":
            return None, (403, "Business workspace is suspended. Contact TRAX LINK support.")

        if not admin_row["firebase_uid"]:
            db.execute(
                "UPDATE admin_users SET firebase_uid = ?, last_login_at = ? WHERE id = ?",
                (decoded["uid"], now_iso, str(admin_row["id"])),
            )

        return (
            AuthenticatedActor(
                id=str(admin_row["id"]),
                business_id=str(admin_row["business_id"] or DEFAULT_BUSINESS_ID),
                business_name=str(admin_row["business_name"] or "TRAX LINK Primary Hotspot"),
                business_status=biz_status,
                email=str(admin_row["email"]),
                full_name=str(admin_row["full_name"]),
                role=role,
                auth_source="FIREBASE",
            ),
            None,
        )

    return None, (401, "Invalid or expired authentication token")


def resolve_tenant_scope(
    db: DatabaseManager,
    actor: AuthenticatedActor,
    headers: Any,
    query: dict[str, str],
    body: dict[str, Any] | None,
    ip_address: str,
    path: str,
) -> tuple[str | None, tuple[int, str] | None]:
    header_tenant = str(headers.get("x-tenant-id") or headers.get("X-Tenant-Id") or "").strip()
    query_tenant = str(query.get("businessId") or "").strip()
    body_tenant = str(body.get("businessId") or "").strip() if isinstance(body, dict) else ""

    requested = header_tenant or query_tenant or body_tenant
    if actor.role == "SUPER_ADMIN":
        target_id = requested or actor.business_id or DEFAULT_BUSINESS_ID
        biz = db.query_one("SELECT id FROM businesses WHERE id = ?", (target_id,))
        if not biz:
            return None, (404, "Target business workspace not found")
        return str(biz["id"]), None

    if requested and requested != actor.business_id:
        record_audit_log(
            db,
            actor,
            "CROSS_TENANT_ACCESS_BLOCKED",
            "Business",
            requested,
            ip_address,
            {
                "actorBusinessId": actor.business_id,
                "attemptedBusinessId": requested,
                "path": path,
            },
        )
        return None, (403, "Cross-tenant access denied")

    return actor.business_id, None
