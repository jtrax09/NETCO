"""Tanzanian mobile money & card payment processing, outbound gateway dispatchers, and webhook engine."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import sqlite3
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from ..config import get_env
from ..db import DatabaseManager, get_operating_mode, utc_now_iso
from ..security import (
    decrypt_secret,
    encrypt_secret,
    generate_id,
    generate_reference,
    generate_voucher_code,
    mask_voucher_code,
    sha256_hex,
)
from .billing import create_invoice_for_payment, provision_subscription_for_activation

SUPPORTED_PROVIDERS = ("MPESA", "AIRTEL_MONEY", "TIGO_PESA", "HALOPESA", "CARD")


def get_provider_statuses() -> list[dict[str, Any]]:
    checks = [
        {
            "provider": "MPESA",
            "displayName": "Vodacom M-Pesa Tanzania",
            "requiredEnv": [
                "MPESA_API_KEY",
                "MPESA_PUBLIC_KEY",
                "MPESA_SERVICE_PROVIDER_CODE",
                "MPESA_WEBHOOK_SECRET",
            ],
            "webhookPath": "/api/payments/webhook/MPESA",
        },
        {
            "provider": "AIRTEL_MONEY",
            "displayName": "Airtel Money Tanzania",
            "requiredEnv": ["AIRTEL_CLIENT_ID", "AIRTEL_CLIENT_SECRET", "AIRTEL_WEBHOOK_SECRET"],
            "webhookPath": "/api/payments/webhook/AIRTEL_MONEY",
        },
        {
            "provider": "TIGO_PESA",
            "displayName": "Mixx by Yas (Tigo Pesa)",
            "requiredEnv": ["TIGO_CLIENT_ID", "TIGO_CLIENT_SECRET", "TIGO_BILLER_CODE", "TIGO_WEBHOOK_SECRET"],
            "webhookPath": "/api/payments/webhook/TIGO_PESA",
        },
        {
            "provider": "HALOPESA",
            "displayName": "HaloPesa Tanzania",
            "requiredEnv": ["HALOPESA_MERCHANT_CODE", "HALOPESA_API_SECRET", "HALOPESA_WEBHOOK_SECRET"],
            "webhookPath": "/api/payments/webhook/HALOPESA",
        },
        {
            "provider": "CARD",
            "displayName": "Visa / Mastercard Gateway",
            "requiredEnv": ["CARD_GATEWAY_KEY", "CARD_WEBHOOK_SECRET"],
            "webhookPath": "/api/payments/webhook/CARD",
        },
    ]
    statuses: list[dict[str, Any]] = []
    for c in checks:
        missing = [k for k in c["requiredEnv"] if not get_env(k)]
        statuses.append(
            {
                "provider": c["provider"],
                "displayName": c["displayName"],
                "configured": len(missing) == 0,
                "missingCredentials": missing,
                "webhookPath": c["webhookPath"],
            }
        )
    return statuses


def get_webhook_secret(provider: str) -> str | None:
    mapping = {
        "MPESA": "MPESA_WEBHOOK_SECRET",
        "AIRTEL_MONEY": "AIRTEL_WEBHOOK_SECRET",
        "TIGO_PESA": "TIGO_WEBHOOK_SECRET",
        "HALOPESA": "HALOPESA_WEBHOOK_SECRET",
        "CARD": "CARD_WEBHOOK_SECRET",
    }
    env_key = mapping.get(provider)
    return get_env(env_key) or None if env_key else None


def verify_webhook_signature(
    provider: str, raw_payload: bytes | str, signature_header: str | None
) -> tuple[bool, str | None]:
    secret = get_webhook_secret(provider)
    if not secret:
        return False, f"Webhook secret for {provider} is not configured in server environment."
    if not signature_header:
        return False, "Missing X-Webhook-Signature header"

    payload_bytes = raw_payload.encode("utf-8") if isinstance(raw_payload, str) else raw_payload
    expected = hmac.new(secret.encode("utf-8"), payload_bytes, hashlib.sha256).digest()
    provided_hex = re.sub(r"^sha256=", "", signature_header.strip(), flags=re.IGNORECASE)
    try:
        provided = bytes.fromhex(provided_hex)
    except ValueError:
        return False, "Invalid webhook signature format"
    if len(expected) != len(provided) or not expected:
        return False, "Invalid webhook signature format"
    if not hmac.compare_digest(expected, provided):
        return False, "Webhook HMAC signature mismatch"
    return True, None


def normalize_tanzania_phone(phone: str) -> str | None:
    digits = re.sub(r"\D", "", phone)
    if digits.startswith("255") and len(digits) == 12:
        return digits
    if digits.startswith("0") and len(digits) == 10:
        return f"255{digits[1:]}"
    if (digits.startswith("7") or digits.startswith("6")) and len(digits) == 9:
        return f"255{digits}"
    return None


def _dispatch_airtel_money_push(reference: str, msisdn: str, amount_tzs: int) -> dict[str, Any]:
    """Initiate Airtel Money OpenAPI USSD push when AIRTEL_BASE_URL + credentials are present."""
    base_url = get_env("AIRTEL_BASE_URL")
    if not base_url or not base_url.startswith("https://"):
        return {"dispatched": False, "mode": "WEBHOOK_AWAIT"}

    client_id = get_env("AIRTEL_CLIENT_ID")
    client_secret = get_env("AIRTEL_CLIENT_SECRET")
    try:
        token_req = urllib.request.Request(
            f"{base_url.rstrip('/')}/auth/oauth2/token",
            data=json.dumps(
                {"client_id": client_id, "client_secret": client_secret, "grant_type": "client_credentials"}
            ).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(token_req, timeout=6) as tok_resp:
            tok_data = json.loads(tok_resp.read().decode("utf-8"))
        access_token = tok_data.get("access_token")
        if not access_token:
            return {"dispatched": False, "error": "Missing Airtel OAuth token"}

        local_msisdn = msisdn[3:] if msisdn.startswith("255") else msisdn
        pay_req = urllib.request.Request(
            f"{base_url.rstrip('/')}/merchant/v1/payments/",
            data=json.dumps(
                {
                    "reference": reference,
                    "subscriber": {"country": "TZ", "currency": "TZS", "msisdn": local_msisdn},
                    "transaction": {"amount": amount_tzs, "country": "TZ", "currency": "TZS", "id": reference},
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {access_token}",
                "X-Country": "TZ",
                "X-Currency": "TZS",
            },
            method="POST",
        )
        with urllib.request.urlopen(pay_req, timeout=6) as pay_resp:
            return {"dispatched": True, "httpStatus": pay_resp.status}
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return {"dispatched": False, "error": str(exc)}


def _dispatch_mpesa_push(reference: str, msisdn: str, amount_tzs: int) -> dict[str, Any]:
    """Initiate Vodacom M-Pesa OpenAPI C2B push when MPESA_BASE_URL is configured."""
    base_url = get_env("MPESA_BASE_URL")
    if not base_url or not base_url.startswith("https://"):
        return {"dispatched": False, "mode": "WEBHOOK_AWAIT"}

    session_key = get_env("MPESA_SESSION_KEY") or get_env("MPESA_API_KEY")
    sp_code = get_env("MPESA_SERVICE_PROVIDER_CODE")
    try:
        req = urllib.request.Request(
            f"{base_url.rstrip('/')}/ipg/v2/vodacomTZN/c2bPayment/singleStage/",
            data=json.dumps(
                {
                    "input_Amount": str(amount_tzs),
                    "input_Country": "TZN",
                    "input_Currency": "TZS",
                    "input_CustomerMSISDN": msisdn,
                    "input_ServiceProviderCode": sp_code,
                    "input_ThirdPartyConversationID": reference,
                    "input_TransactionReference": reference,
                    "input_PurchasedItemsDesc": "TRAX LINK WiFi Package",
                }
            ).encode("utf-8"),
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {session_key}",
                "Origin": "*",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            return {"dispatched": True, "httpStatus": resp.status}
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        return {"dispatched": False, "error": str(exc)}


def initiate_payment(
    db: DatabaseManager,
    package_id: str,
    provider: str,
    phone_number: str,
    customer_id: str | None = None,
    business_id: str | None = None,
    card_summary: dict[str, str] | None = None,
) -> dict[str, Any]:
    contact = phone_number.strip()
    if provider != "CARD":
        norm = normalize_tanzania_phone(contact)
        if not norm:
            raise ValueError("Enter a valid Tanzanian mobile money number (e.g. 0712345678 or 255712345678).")
        contact = norm
    elif len(contact) < 4:
        raise ValueError("Enter a valid cardholder phone or billing email.")

    safe_card_meta: dict[str, str] | None = None
    if provider == "CARD" and card_summary:
        last4 = re.sub(r"\D", "", str(card_summary.get("cardLast4") or ""))
        if last4 and len(last4) != 4:
            raise ValueError("Invalid card summary: last 4 digits required.")
        expiry = str(card_summary.get("cardExpiry") or "").strip()
        if expiry and not re.fullmatch(r"(0[1-9]|1[0-2])/\d{2}", expiry):
            raise ValueError("Invalid card expiry format (expected MM/YY).")
        holder = str(card_summary.get("cardHolder") or "").strip()[:80]
        brand = str(card_summary.get("cardBrand") or "CARD").strip().upper()[:24]
        safe_card_meta = {
            "cardBrand": brand or "CARD",
            "cardLast4": last4,
            "cardExpiry": expiry,
            "cardHolder": holder,
        }

    pkg = db.query_one(
        "SELECT id, business_id, name, price_tzs, is_active FROM packages WHERE id = ?",
        (package_id,),
    )
    if not pkg or not pkg["is_active"]:
        raise ValueError("Selected package is unavailable.")
    if business_id and str(pkg["business_id"]) != business_id:
        raise ValueError("Selected package does not belong to the chosen WiFi provider workspace.")

    resolved_biz_id = str(pkg["business_id"])
    provider_info = next((p for p in get_provider_statuses() if p["provider"] == provider), None)
    provider_configured = bool(provider_info and provider_info["configured"])
    payment_mode = "GATEWAY" if provider_configured else "STANDALONE_TEST"
    is_test = 0 if provider_configured else 1
    payment_id = generate_id("pay")
    reference = generate_reference("TRX-PAY")
    now_iso = utc_now_iso()

    gateway_dispatch: dict[str, Any] = {"dispatched": False}
    if provider_configured:
        if provider == "AIRTEL_MONEY":
            gateway_dispatch = _dispatch_airtel_money_push(reference, contact, int(pkg["price_tzs"]))
        elif provider == "MPESA":
            gateway_dispatch = _dispatch_mpesa_push(reference, contact, int(pkg["price_tzs"]))

    payload_obj: dict[str, Any] = {
        "integrationMode": "LIVE_GATEWAY" if provider_configured else "STANDALONE_TEST_CHECKOUT",
        "missingCredentials": provider_info["missingCredentials"] if provider_info else [],
        "gatewayDispatch": gateway_dispatch,
    }
    if safe_card_meta:
        payload_obj["cardSummary"] = safe_card_meta

    db.execute(
        """
        INSERT INTO payments (
          id, business_id, reference, provider, phone_number, amount_tzs, status,
          is_test, payment_mode, package_id, customer_id, provider_payload, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            payment_id,
            resolved_biz_id,
            reference,
            provider,
            contact,
            int(pkg["price_tzs"]),
            is_test,
            payment_mode,
            str(pkg["id"]),
            customer_id,
            json.dumps(payload_obj),
            now_iso,
            now_iso,
        ),
    )

    return {
        "paymentId": payment_id,
        "businessId": resolved_biz_id,
        "reference": reference,
        "provider": provider,
        "phoneNumber": contact,
        "packageName": str(pkg["name"]),
        "amountTzs": int(pkg["price_tzs"]),
        "status": "PENDING",
        "isTest": bool(is_test),
        "paymentMode": payment_mode,
        "providerConfigured": provider_configured,
        "missingCredentials": provider_info["missingCredentials"] if provider_info else [],
        "message": (
            f"Payment request {reference} queued for {provider}. Complete verification for {contact}."
            if provider_configured
            else f"Transaction {reference} created in Standalone Mode. Confirm payment below to receive your Voucher Token."
        ),
    }


def confirm_standalone_payment_for_token(db: DatabaseManager, reference: str) -> dict[str, Any]:
    def _tx(conn: sqlite3.Connection) -> dict[str, Any]:
        row = conn.execute(
            """
            SELECT p.*, pk.name as package_name
            FROM payments p
            JOIN packages pk ON pk.id = p.package_id
            WHERE p.reference = ?
            """,
            (reference,),
        ).fetchone()
        if not row:
            raise ValueError("Payment reference not found")
        payment = dict(row)

        provider_info = next((p for p in get_provider_statuses() if p["provider"] == str(payment["provider"])), None)
        mode = get_operating_mode(db)
        if provider_info and provider_info["configured"] and mode != "STANDALONE_MODE" and not payment["is_test"]:
            raise ValueError("Live payment gateway is active; voucher issuance requires verified provider webhook confirmation.")

        if str(payment["status"]) == "COMPLETED" and payment.get("voucher_id"):
            vrow = conn.execute("SELECT code_encrypted FROM vouchers WHERE id = ?", (str(payment["voucher_id"]),)).fetchone()
            code_val = None
            if vrow:
                try:
                    code_val = decrypt_secret(str(vrow["code_encrypted"]))
                except Exception:
                    code_val = None
            return {
                "reference": str(payment["reference"]),
                "businessId": str(payment["business_id"]),
                "provider": str(payment["provider"]),
                "phoneNumber": str(payment["phone_number"]),
                "packageName": str(payment["package_name"]),
                "amountTzs": int(payment["amount_tzs"]),
                "status": "COMPLETED",
                "isTest": bool(payment["is_test"]),
                "receiptNumber": str(payment["receipt_number"]) if payment.get("receipt_number") else None,
                "voucherCode": code_val,
            }

        if str(payment["status"]) != "PENDING":
            raise ValueError(f"Cannot issue token for payment in status {payment['status']}")

        voucher_code = generate_voucher_code()
        voucher_id = generate_id("vch")
        receipt_number = generate_reference("TST")
        now_iso = utc_now_iso()
        business_id = str(payment["business_id"])

        conn.execute(
            """
            INSERT INTO vouchers (
              id, business_id, code_hash, code_encrypted, code_masked, batch_id,
              package_id, customer_id, status, is_test, test_note, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', 1, ?, ?, ?)
            """,
            (
                voucher_id,
                business_id,
                sha256_hex(voucher_code),
                encrypt_secret(voucher_code),
                mask_voucher_code(voucher_code),
                f"TOKEN-{payment['provider']}",
                str(payment["package_id"]),
                payment.get("customer_id"),
                f"Standalone checkout token ({payment['reference']})",
                now_iso,
                now_iso,
            ),
        )

        conn.execute(
            """
            UPDATE payments
            SET status = 'COMPLETED', is_test = 1, payment_mode = 'STANDALONE_TEST',
                receipt_number = ?, voucher_id = ?, verified_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (receipt_number, voucher_id, now_iso, now_iso, str(payment["id"])),
        )

        create_invoice_for_payment(
            conn,
            business_id=business_id,
            ledger_type="WIFI",
            payment_id=str(payment["id"]),
            payment_reference=str(payment["reference"]),
            item_description=f"[TEST] WiFi Package: {payment['package_name']}",
            total_tzs=int(payment["amount_tzs"]),
            phone_number=str(payment["phone_number"]),
            is_test=True,
        )

        conn.execute(
            """
            INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
            VALUES (?, ?, 'STANDALONE_TOKEN_ISSUED', 'INFO', ?, ?, ?)
            """,
            (
                generate_id("ntf"),
                business_id,
                f"[TEST MODE] Token Issued ({receipt_number})",
                f"Standalone payment {payment['reference']} issued dev/test voucher token for {payment['package_name']} (excluded from verified revenue).",
                json.dumps({"reference": str(payment["reference"]), "receiptNumber": receipt_number, "voucherId": voucher_id, "isTest": True}),
            ),
        )

        return {
            "reference": str(payment["reference"]),
            "businessId": business_id,
            "provider": str(payment["provider"]),
            "phoneNumber": str(payment["phone_number"]),
            "packageName": str(payment["package_name"]),
            "amountTzs": int(payment["amount_tzs"]),
            "status": "COMPLETED",
            "isTest": True,
            "receiptNumber": receipt_number,
            "voucherCode": voucher_code,
        }

    return db.transaction(_tx)


def process_verified_payment_callback(
    db: DatabaseManager,
    provider: str,
    external_event_id: str,
    reference: str,
    external_tx_id: str,
    status: str,
    raw_payload: dict[str, Any],
    amount_tzs: int | None = None,
) -> dict[str, Any]:
    def _tx(conn: sqlite3.Connection) -> dict[str, Any]:
        existing_event = conn.execute(
            "SELECT id FROM webhook_events WHERE provider = ? AND external_event_id = ?",
            (provider, external_event_id),
        ).fetchone()

        pay_row = conn.execute(
            """
            SELECT p.*, pk.duration_minutes, pk.location_id, pk.name as package_name
            FROM payments p
            JOIN packages pk ON pk.id = p.package_id
            WHERE p.reference = ?
            """,
            (reference,),
        ).fetchone()
        if not pay_row:
            raise ValueError(f"Payment reference {reference} not found")
        payment = dict(pay_row)
        business_id = str(payment["business_id"])

        if existing_event:
            return {
                "duplicate": True,
                "paymentId": str(payment["id"]),
                "businessId": business_id,
                "reference": str(payment["reference"]),
                "status": str(payment["status"]),
                "receiptNumber": str(payment["receipt_number"]) if payment.get("receipt_number") else None,
                "shouldProvision": False,
            }

        if amount_tzs is not None and int(amount_tzs) != int(payment["amount_tzs"]):
            raise ValueError("Payment callback amount mismatch")

        conn.execute(
            "INSERT INTO webhook_events (id, provider, external_event_id, payment_reference, payload) VALUES (?, ?, ?, ?, ?)",
            (generate_id("whk"), provider, external_event_id, reference, json.dumps(raw_payload)),
        )

        now_iso = utc_now_iso()

        if status == "FAILED":
            conn.execute(
                """
                UPDATE payments SET status = 'FAILED', external_tx_id = ?, provider_payload = ?, updated_at = ?
                WHERE id = ? AND status = 'PENDING'
                """,
                (external_tx_id, json.dumps(raw_payload), now_iso, str(payment["id"])),
            )
            conn.execute(
                """
                INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
                VALUES (?, ?, 'PAYMENT_FAILED', 'WARNING', ?, ?, ?)
                """,
                (
                    generate_id("ntf"),
                    business_id,
                    f"Payment Failed ({reference})",
                    f"{provider} payment for {payment['phone_number']} failed verification.",
                    json.dumps({"reference": reference, "provider": provider}),
                ),
            )
            return {
                "duplicate": False,
                "paymentId": str(payment["id"]),
                "businessId": business_id,
                "reference": str(payment["reference"]),
                "status": "FAILED",
                "shouldProvision": False,
            }

        if status == "REFUNDED":
            conn.execute(
                """
                UPDATE payments SET status = 'REFUNDED', refunded_at = ?, provider_payload = ?, updated_at = ?
                WHERE id = ?
                """,
                (now_iso, json.dumps(raw_payload), now_iso, str(payment["id"])),
            )
            if payment.get("voucher_id"):
                conn.execute(
                    """
                    UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'Payment refunded', updated_at = ?
                    WHERE id = ? AND status != 'REVOKED'
                    """,
                    (now_iso, now_iso, str(payment["voucher_id"])),
                )
            conn.execute(
                "UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE payment_id = ?",
                (now_iso, now_iso, str(payment["id"])),
            )
            conn.execute("UPDATE invoices SET status = 'REFUNDED' WHERE payment_id = ?", (str(payment["id"]),))
            return {
                "duplicate": False,
                "paymentId": str(payment["id"]),
                "businessId": business_id,
                "reference": str(payment["reference"]),
                "status": "REFUNDED",
                "receiptNumber": str(payment["receipt_number"]) if payment.get("receipt_number") else None,
                "shouldProvision": False,
            }

        if str(payment["status"]) == "COMPLETED" and payment.get("voucher_id"):
            return {
                "duplicate": True,
                "paymentId": str(payment["id"]),
                "businessId": business_id,
                "reference": str(payment["reference"]),
                "status": "COMPLETED",
                "receiptNumber": str(payment["receipt_number"]) if payment.get("receipt_number") else None,
                "shouldProvision": False,
            }

        voucher_code = generate_voucher_code()
        voucher_id = generate_id("vch")
        receipt_number = generate_reference("RCP")

        conn.execute(
            """
            INSERT INTO vouchers (
              id, business_id, code_hash, code_encrypted, code_masked, batch_id,
              package_id, customer_id, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', ?, ?)
            """,
            (
                voucher_id,
                business_id,
                sha256_hex(voucher_code),
                encrypt_secret(voucher_code),
                mask_voucher_code(voucher_code),
                f"PAY-{provider}",
                str(payment["package_id"]),
                payment.get("customer_id"),
                now_iso,
                now_iso,
            ),
        )

        conn.execute(
            """
            UPDATE payments
            SET status = 'COMPLETED', is_test = 0, receipt_number = ?, external_tx_id = ?,
                voucher_id = ?, provider_payload = ?, verified_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                receipt_number,
                external_tx_id,
                voucher_id,
                json.dumps(raw_payload),
                now_iso,
                now_iso,
                str(payment["id"]),
            ),
        )

        create_invoice_for_payment(
            conn,
            business_id=business_id,
            ledger_type="WIFI",
            payment_id=str(payment["id"]),
            payment_reference=str(payment["reference"]),
            item_description=f"WiFi Package: {payment['package_name']}",
            total_tzs=int(payment["amount_tzs"]),
            phone_number=str(payment["phone_number"]),
            is_test=False,
        )

        conn.execute(
            """
            INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
            VALUES (?, ?, 'PAYMENT_SUCCESS', 'INFO', ?, ?, ?)
            """,
            (
                generate_id("ntf"),
                business_id,
                f"Payment Verified ({receipt_number})",
                f"{provider} payment of {int(payment['amount_tzs']):,} TZS verified; voucher & RADIUS subscription issued.",
                json.dumps({"reference": reference, "receiptNumber": receipt_number, "voucherId": voucher_id}),
            ),
        )

        expires_at_iso = (
            (datetime.now(timezone.utc) + timedelta(minutes=int(payment["duration_minutes"])))
            .isoformat(timespec="milliseconds")
            .replace("+00:00", "Z")
        )
        return {
            "duplicate": False,
            "paymentId": str(payment["id"]),
            "businessId": business_id,
            "locationId": str(payment["location_id"]) if payment.get("location_id") else None,
            "customerId": str(payment["customer_id"]) if payment.get("customer_id") else None,
            "packageId": str(payment["package_id"]),
            "voucherId": voucher_id,
            "reference": str(payment["reference"]),
            "status": "COMPLETED",
            "receiptNumber": receipt_number,
            "issuedVoucherCode": voucher_code,
            "startsAtIso": now_iso,
            "expiresAtIso": expires_at_iso,
            "shouldProvision": True,
        }

    tx_result = db.transaction(_tx)
    if not tx_result.get("shouldProvision") or not tx_result.get("issuedVoucherCode"):
        return {
            "duplicate": tx_result["duplicate"],
            "paymentId": tx_result["paymentId"],
            "businessId": tx_result["businessId"],
            "reference": tx_result["reference"],
            "status": tx_result["status"],
            "receiptNumber": tx_result.get("receiptNumber"),
        }

    radius_username = re.sub(r"[^A-Z0-9]", "", tx_result["issuedVoucherCode"].upper())
    prov = provision_subscription_for_activation(
        db,
        business_id=tx_result["businessId"],
        location_id=tx_result.get("locationId"),
        customer_id=tx_result.get("customerId"),
        package_id=tx_result["packageId"],
        payment_id=tx_result["paymentId"],
        voucher_id=tx_result["voucherId"],
        radius_username=radius_username,
        radius_secret_value=tx_result["issuedVoucherCode"],
        starts_at_iso=tx_result["startsAtIso"],
        expires_at_iso=tx_result["expiresAtIso"],
    )

    return {
        "duplicate": False,
        "paymentId": tx_result["paymentId"],
        "businessId": tx_result["businessId"],
        "reference": tx_result["reference"],
        "status": "COMPLETED",
        "receiptNumber": tx_result.get("receiptNumber"),
        "issuedVoucherCode": tx_result["issuedVoucherCode"],
        "subscriptionId": prov["subscriptionId"],
        "provisioningStatus": prov["provisioningStatus"],
    }
