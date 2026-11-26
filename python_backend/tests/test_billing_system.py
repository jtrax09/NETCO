"""Comprehensive unittest suite for TRAX LINK Python WiFi Billing & Network Management Engine."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import socket
import struct
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from typing import Any

from python_backend.db import utc_now_iso
from python_backend.security import generate_id
from python_backend.server import create_http_server
from python_backend.services.billing import send_radius_disconnect
from python_backend.services.mikrotik import (
    decode_length,
    encode_sentence,
    push_hotspot_profile_to_router,
    provision_hotspot_user_on_router,
    terminate_router_session,
    test_router_connection,
)


def _api(
    base_url: str,
    path: str,
    method: str = "GET",
    token: str | None = None,
    body: Any = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict[str, Any]]:
    hdrs: dict[str, str] = {"Content-Type": "application/json"}
    if token:
        hdrs["Authorization"] = f"Bearer {token}"
    if headers:
        hdrs.update(headers)
    data = None
    if body is not None:
        data = body.encode("utf-8") if isinstance(body, str) else json.dumps(body).encode("utf-8")

    req = urllib.request.Request(f"{base_url}{path}", data=data, headers=hdrs, method=method)
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        try:
            parsed = json.loads(raw) if raw else {}
        except ValueError:
            parsed = {"raw": raw}
        return exc.code, parsed


def _read_ros_sentence(conn: socket.socket) -> list[str]:
    buf = bytearray()
    words: list[str] = []
    while True:
        while True:
            info = decode_length(buf, 0)
            if info is None:
                break
            length, prefix = info
            if length == 0:
                del buf[:prefix]
                return words
            needed = prefix + length
            if len(buf) < needed:
                break
            words.append(bytes(buf[prefix:needed]).decode("utf-8"))
            del buf[:needed]
        chunk = conn.recv(4096)
        if not chunk:
            return words
        buf.extend(chunk)


class TraxPythonBillingTests(unittest.TestCase):
    def setUp(self) -> None:
        os.environ.pop("ADMIN_INITIAL_PASSCODE", None)
        os.environ["MPESA_WEBHOOK_SECRET"] = "test_mpesa_secret_key_2026"
        os.environ["RADIUS_SHARED_SECRET"] = "radius_test_secret_2026"
        self.httpd, self.db = create_http_server(
            host="127.0.0.1", port=0, db_path=":memory:", seed_primary_staff=False
        )
        self.port = self.httpd.server_address[1]
        self.base_url = f"http://127.0.0.1:{self.port}"
        self.srv_thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.srv_thread.start()

        status, boot = _api(
            self.base_url,
            "/api/auth/bootstrap",
            method="POST",
            body={
                "email": "superadmin@traxlink.co.tz",
                "fullName": "TRAX Chief Admin",
                "password": "StrongPassword#2026",
            },
        )
        self.assertEqual(status, 201)
        self.admin_token = str(boot["token"])

    def tearDown(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self.db.close()

    def test_health_auth_and_recovery_flow(self) -> None:
        status, health = _api(self.base_url, "/api/health")
        self.assertEqual(status, 200)
        self.assertEqual(health["engine"], "python")
        self.assertEqual(health["operatingMode"], "STANDALONE_MODE")

        dup_s, _ = _api(
            self.base_url,
            "/api/auth/bootstrap",
            method="POST",
            body={"email": "x@trax.co.tz", "fullName": "Attacker", "password": "Password123!"},
        )
        self.assertEqual(dup_s, 409)

        bad_s, _ = _api(
            self.base_url,
            "/api/auth/login",
            method="POST",
            body={"email": "superadmin@traxlink.co.tz", "password": "WrongPassword"},
        )
        self.assertEqual(bad_s, 401)

        ok_s, login = _api(
            self.base_url,
            "/api/auth/login",
            method="POST",
            body={"email": "superadmin@traxlink.co.tz", "password": "StrongPassword#2026"},
        )
        self.assertEqual(ok_s, 200)
        tok = str(login["token"])

        me_s, _ = _api(self.base_url, "/api/auth/me", token=tok)
        self.assertEqual(me_s, 200)

        _api(self.base_url, "/api/auth/logout", method="POST", token=tok)
        me_after, _ = _api(self.base_url, "/api/auth/me", token=tok)
        self.assertEqual(me_after, 401)

    def test_single_use_and_one_device_name_voucher_lock(self) -> None:
        s, pkg = _api(
            self.base_url,
            "/api/packages",
            method="POST",
            token=self.admin_token,
            body={
                "name": "24H Fast Fiber",
                "category": "DAILY",
                "priceTzs": 2000,
                "durationMinutes": 1440,
                "downloadKbps": 10000,
                "uploadKbps": 5000,
            },
        )
        self.assertEqual(s, 201)
        pkg_id = pkg["package"]["id"]

        gs, batch = _api(
            self.base_url,
            "/api/vouchers/generate",
            method="POST",
            token=self.admin_token,
            body={"packageId": pkg_id, "count": 5},
        )
        self.assertEqual(gs, 201)
        code = batch["vouchers"][0]["code"]

        # Missing device name -> 400
        ms, mres = _api(
            self.base_url,
            "/api/portal/redeem",
            method="POST",
            body={"code": code, "deviceFingerprint": "fp-alpha-111111"},
        )
        self.assertEqual(ms, 400)
        self.assertEqual(mres["code"], "DEVICE_NAME_REQUIRED")

        # Redeem on Device 1 -> 200
        d1s, d1 = _api(
            self.base_url,
            "/api/portal/redeem",
            method="POST",
            body={"code": code, "deviceFingerprint": "fp-alpha-111111", "deviceLabel": "iPhone 15"},
        )
        self.assertEqual(d1s, 200)
        ses_tok = d1["session"]["sessionToken"]

        # Second device -> 409
        d2s, d2 = _api(
            self.base_url,
            "/api/portal/redeem",
            method="POST",
            body={"code": code, "deviceFingerprint": "fp-beta-222222", "deviceLabel": "Galaxy S24"},
        )
        self.assertEqual(d2s, 409)
        self.assertEqual(d2["code"], "DEVICE_LIMIT_REACHED")

        # Same device re-redeeming -> 409 VOUCHER_ALREADY_USED
        rs, rres = _api(
            self.base_url,
            "/api/portal/redeem",
            method="POST",
            body={"code": code, "deviceFingerprint": "fp-alpha-111111", "deviceLabel": "iPhone 15"},
        )
        self.assertEqual(rs, 409)
        self.assertEqual(rres["code"], "VOUCHER_ALREADY_USED")

        # Logout permanently consumes voucher
        ls, _ = _api(
            self.base_url,
            "/api/portal/logout",
            method="POST",
            headers={"X-Portal-Session": ses_tok},
        )
        self.assertEqual(ls, 200)

        as_, ares = _api(
            self.base_url,
            "/api/portal/redeem",
            method="POST",
            body={"code": code, "deviceFingerprint": "fp-alpha-111111", "deviceLabel": "iPhone 15"},
        )
        self.assertEqual(as_, 403)
        self.assertEqual(ares["code"], "VOUCHER_EXPIRED")

    def test_payments_webhook_invoices_radius_and_coa_disconnect(self) -> None:
        s, pkg = _api(
            self.base_url,
            "/api/packages",
            method="POST",
            token=self.admin_token,
            body={
                "name": "Pro Data Plan",
                "category": "WEEKLY",
                "packageType": "HYBRID",
                "priceTzs": 10000,
                "durationMinutes": 10080,
                "downloadKbps": 15000,
                "uploadKbps": 8000,
                "dataLimitMb": 1024,
            },
        )
        self.assertEqual(s, 201)
        pkg_id = pkg["package"]["id"]

        ps, pinit = _api(
            self.base_url,
            "/api/portal/payments/initiate",
            method="POST",
            body={"packageId": pkg_id, "provider": "MPESA", "phoneNumber": "0754123456"},
        )
        self.assertEqual(ps, 201)
        ref = pinit["payment"]["reference"]

        payload_str = json.dumps(
            {
                "externalEventId": "evt-py-100",
                "reference": ref,
                "externalTxId": "MPESA-PY-100",
                "status": "COMPLETED",
                "amountTzs": 10000,
            }
        )
        sig = hmac.new(
            os.environ["MPESA_WEBHOOK_SECRET"].encode("utf-8"),
            payload_str.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

        ws, wres = _api(
            self.base_url,
            "/api/payments/webhook/MPESA",
            method="POST",
            body=payload_str,
            headers={"X-Webhook-Signature": f"sha256={sig}"},
        )
        self.assertEqual(ws, 200)
        voucher_code = wres["outcome"]["issuedVoucherCode"]
        self.assertTrue(voucher_code.startswith("NTC-"))

        # Invoice generated automatically
        is_, inv_res = _api(self.base_url, "/api/invoices", token=self.admin_token)
        self.assertEqual(is_, 200)
        self.assertTrue(any(inv["paymentReference"] == ref and inv["invoiceNumber"].startswith("INV-") for inv in inv_res["invoices"]))

        # FreeRADIUS authorize accepts stripped NTCXXXXXXXX as well as dashed
        stripped = voucher_code.replace("-", "")
        rs, rres = _api(
            self.base_url,
            "/api/radius/authorize",
            method="POST",
            headers={"x-radius-secret": os.environ["RADIUS_SHARED_SECRET"]},
            body={"username": stripped},
        )
        self.assertEqual(rs, 200)
        self.assertEqual(rres["access"], "Access-Accept")

        # RFC 5176 UDP CoA Disconnect-Request test against local UDP NAS responder
        coa_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        coa_sock.bind(("127.0.0.1", 0))
        coa_port = coa_sock.getsockname()[1]
        received_packets: list[bytes] = []

        def _udp_nas() -> None:
            pkt, addr = coa_sock.recvfrom(4096)
            received_packets.append(pkt)
            pkt_id = pkt[1]
            # Reply Disconnect-ACK (Code 41)
            ack_hdr = struct.pack("!BBH16s", 41, pkt_id, 20, b"\x00" * 16)
            coa_sock.sendto(ack_hdr, addr)

        t_udp = threading.Thread(target=_udp_nas, daemon=True)
        t_udp.start()
        coa_res = send_radius_disconnect(
            self.db,
            business_id="biz_trax_default",
            nas_ip="127.0.0.1",
            username=voucher_code,
            shared_secret=os.environ["RADIUS_SHARED_SECRET"],
            acct_session_id="acct-999",
            coa_port=coa_port,
        )
        t_udp.join(timeout=2)
        coa_sock.close()
        self.assertTrue(coa_res["ack"])
        self.assertEqual(received_packets[0][0], 40)

        # Accounting data cap exceeding 1024MB auto-expires subscription
        acs, acres = _api(
            self.base_url,
            "/api/radius/accounting",
            method="POST",
            headers={"x-radius-secret": os.environ["RADIUS_SHARED_SECRET"]},
            body={
                "acctSessionId": "acct-999",
                "username": voucher_code,
                "statusType": "Interim-Update",
                "acctInputOctets": 700 * 1024 * 1024,
                "acctOutputOctets": 400 * 1024 * 1024,
                "acctSessionTime": 1200,
            },
        )
        self.assertEqual(acs, 200)
        self.assertTrue(acres["quotaExceeded"])

        rs_after, _ = _api(
            self.base_url,
            "/api/radius/authorize",
            method="POST",
            headers={"x-radius-secret": os.environ["RADIUS_SHARED_SECRET"]},
            body={"username": voucher_code},
        )
        self.assertEqual(rs_after, 401)

    def test_multi_tenant_isolation_and_spoof_block(self) -> None:
        sa, ba = _api(
            self.base_url,
            "/api/auth/register-business",
            method="POST",
            body={
                "businessName": "Kili WiFi Ltd",
                "ownerName": "Amina",
                "ownerEmail": "amina@kili.co.tz",
                "password": "KiliPassword#2026",
                "phone": "+255754111222",
                "country": "Tanzania",
                "region": "Arusha",
                "planCode": "STARTER",
            },
        )
        self.assertEqual(sa, 201)
        tok_a = ba["token"]
        id_a = ba["business"]["id"]

        sb, bb = _api(
            self.base_url,
            "/api/auth/register-business",
            method="POST",
            body={
                "businessName": "Zanzibar Net",
                "ownerName": "Juma",
                "ownerEmail": "juma@znz.co.tz",
                "password": "ZnzPassword#2026",
                "phone": "+255777333444",
                "country": "Tanzania",
                "region": "Zanzibar",
                "planCode": "STARTER",
            },
        )
        self.assertEqual(sb, 201)
        tok_b = bb["token"]

        spoof_s, _ = _api(
            self.base_url,
            "/api/packages",
            token=tok_b,
            headers={"x-tenant-id": id_a},
        )
        self.assertEqual(spoof_s, 403)
        row = self.db.query_one(
            "SELECT COUNT(*) as c FROM audit_logs WHERE action = 'CROSS_TENANT_ACCESS_BLOCKED'"
        )
        self.assertGreaterEqual(int(row["c"]), 1)

    def test_mikrotik_binary_protocol_client(self) -> None:
        srv_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv_sock.bind(("127.0.0.1", 0))
        srv_sock.listen(4)
        ros_port = srv_sock.getsockname()[1]
        commands_seen: list[list[str]] = []
        stop_flag = threading.Event()

        def _mock_ros() -> None:
            while not stop_flag.is_set():
                try:
                    srv_sock.settimeout(0.2)
                    conn, _ = srv_sock.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                with conn:
                    while True:
                        words = _read_ros_sentence(conn)
                        if not words:
                            break
                        commands_seen.append(words)
                        cmd = words[0]
                        if cmd == "/login":
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/system/resource/print":
                            conn.sendall(
                                encode_sentence(
                                    [
                                        "!re",
                                        "=cpu-load=14",
                                        "=total-memory=268435456",
                                        "=free-memory=134217728",
                                        "=uptime=3d04:12:00",
                                        "=version=7.14.2",
                                        "=board-name=RB750Gr3",
                                    ]
                                )
                            )
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/interface/print":
                            conn.sendall(
                                encode_sentence(
                                    ["!re", "=name=ether1-wan", "=type=ether", "=running=true", "=disabled=false", "=rx-byte=1000", "=tx-byte=2000"]
                                )
                            )
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/ip/hotspot/active/print":
                            if any(w.startswith("?address=") for w in words):
                                conn.sendall(encode_sentence(["!re", "=.id=*1A", "=address=10.5.50.10"]))
                            conn.sendall(encode_sentence(["!done"]))
                        else:
                            conn.sendall(encode_sentence(["!done"]))

        t = threading.Thread(target=_mock_ros, daemon=True)
        t.start()

        try:
            tele = test_router_connection("127.0.0.1", ros_port, False, "admin", "secret")
            self.assertTrue(tele.connected)
            self.assertEqual(tele.board_name, "RB750Gr3")
            self.assertEqual(tele.cpu_load, 14)

            # Register mock router via API & push profile / provision user / terminate session
            rs, rcreated = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Lab RB750Gr3",
                    "host": "127.0.0.1",
                    "apiPort": ros_port,
                    "username": "admin",
                    "password": "secret",
                    "routerOsFamily": "ROUTEROS_V7",
                },
            )
            self.assertEqual(rs, 201)
            rid = rcreated["router"]["id"]

            prof = push_hotspot_profile_to_router(self.db, rid, "trax-test", 10000, 5000)
            self.assertTrue(prof["synced"])

            uadd = provision_hotspot_user_on_router(self.db, rid, "NTC-1111-2222", "PASS", "trax-test", 3600)
            self.assertTrue(uadd["provisioned"])

            term = terminate_router_session(self.db, rid, "10.5.50.10")
            self.assertTrue(term["removed"])
            self.assertTrue(any("/ip/hotspot/active/remove" in c for c in commands_seen))
        finally:
            stop_flag.set()
            srv_sock.close()
            t.join(timeout=2)

    def test_card_payment_summary_redaction(self) -> None:
        s, pkg = _api(
            self.base_url,
            "/api/packages",
            method="POST",
            token=self.admin_token,
            body={
                "name": "Card Express Pass",
                "category": "DAILY",
                "priceTzs": 3000,
                "durationMinutes": 1440,
                "downloadKbps": 10000,
                "uploadKbps": 5000,
            },
        )
        self.assertEqual(s, 201)
        pkg_id = pkg["package"]["id"]

        ps, pinit = _api(
            self.base_url,
            "/api/portal/payments/initiate",
            method="POST",
            body={
                "packageId": pkg_id,
                "provider": "CARD",
                "phoneNumber": "0754123456",
                "cardSummary": {
                    "cardBrand": "VISA",
                    "cardLast4": "4242",
                    "cardExpiry": "08/28",
                    "cardHolder": "JUMA HASSAN",
                },
            },
        )
        self.assertEqual(ps, 201)
        ref = pinit["payment"]["reference"]

        row = self.db.query_one("SELECT provider_payload FROM payments WHERE reference = ?", (ref,))
        self.assertIsNotNone(row)
        payload = json.loads(str(row["provider_payload"] or "{}"))
        self.assertEqual(payload.get("cardSummary", {}).get("cardLast4"), "4242")
        self.assertEqual(payload.get("cardSummary", {}).get("cardBrand"), "VISA")
        self.assertNotIn("cardNumber", payload)
        self.assertNotIn("cvv", payload)

        cs, cresp = _api(
            self.base_url,
            f"/api/portal/payments/{ref}/confirm-test",
            method="POST",
        )
        self.assertEqual(cs, 200)
        self.assertTrue(str(cresp["payment"]["voucherCode"]).startswith("NTC-"))


if __name__ == "__main__":
    unittest.main()
