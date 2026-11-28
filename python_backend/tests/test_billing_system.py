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

    def test_business_settings_update_and_portal_reflection(self) -> None:
        gs, gbody = _api(self.base_url, "/api/business/settings", token=self.admin_token)
        self.assertEqual(gs, 200)
        self.assertEqual(gbody["settings"]["currency"], "TZS")

        ps, pbody = _api(
            self.base_url,
            "/api/business/settings",
            method="PATCH",
            token=self.admin_token,
            body={
                "hotspotTitle": "Zanzibar Fiber Lounge",
                "hotspotSupportPhone": "+255754888999",
                "currency": "TZS",
                "timezone": "Africa/Dar_es_Salaam",
            },
        )
        self.assertEqual(ps, 200)
        self.assertEqual(pbody["settings"]["hotspotTitle"], "Zanzibar Fiber Lounge")
        self.assertEqual(pbody["settings"]["hotspotSupportPhone"], "+255754888999")

        pub_s, pub_body = _api(self.base_url, "/api/portal/businesses")
        self.assertEqual(pub_s, 200)
        self.assertTrue(
            any(
                b.get("hotspotTitle") == "Zanzibar Fiber Lounge"
                and b.get("hotspotSupportPhone") == "+255754888999"
                for b in pub_body.get("businesses", [])
            )
        )

    def test_manual_payment_reconciliation_and_invoice(self) -> None:
        s, pkg = _api(
            self.base_url,
            "/api/packages",
            method="POST",
            token=self.admin_token,
            body={
                "name": "Reconcile Fiber Pass",
                "category": "DAILY",
                "priceTzs": 2500,
                "durationMinutes": 1440,
                "downloadKbps": 8000,
                "uploadKbps": 4000,
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
                "provider": "MPESA",
                "phoneNumber": "0754222333",
            },
        )
        self.assertEqual(ps, 201)
        pay_row = self.db.query_one(
            "SELECT id, reference FROM payments WHERE reference = ?", (pinit["payment"]["reference"],)
        )
        self.assertIsNotNone(pay_row)
        pid = str(pay_row["id"])

        rs, rbody = _api(
            self.base_url,
            f"/api/payments/{pid}/reconcile",
            method="POST",
            token=self.admin_token,
            body={"externalTxId": "MPESA-VERIFY-9911", "note": "Verified on statement"},
        )
        self.assertEqual(rs, 200)
        self.assertEqual(rbody["outcome"]["status"], "COMPLETED")
        self.assertTrue(str(rbody["outcome"]["issuedVoucherCode"]).startswith("NTC-"))

        inv_s, inv_body = _api(self.base_url, "/api/invoices", token=self.admin_token)
        self.assertEqual(inv_s, 200)
        self.assertTrue(
            any(i["paymentReference"] == pay_row["reference"] for i in inv_body.get("invoices", []))
        )

        # Second reconciliation attempt on COMPLETED payment must be rejected
        dup_s, _ = _api(
            self.base_url,
            f"/api/payments/{pid}/reconcile",
            method="POST",
            token=self.admin_token,
            body={"externalTxId": "MPESA-VERIFY-9911"},
        )
        self.assertEqual(dup_s, 400)

    def test_routers_bandwidth_overview_and_live_series(self) -> None:
        srv_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv_sock.bind(("127.0.0.1", 0))
        srv_sock.listen(4)
        ros_port = srv_sock.getsockname()[1]
        stop_flag = threading.Event()
        poll_count = {"n": 0}

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
                        cmd = words[0]
                        if cmd == "/login":
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/system/resource/print":
                            conn.sendall(
                                encode_sentence(
                                    [
                                        "!re",
                                        "=cpu-load=22",
                                        "=total-memory=268435456",
                                        "=free-memory=134217728",
                                        "=uptime=1d02:00:00",
                                        "=version=7.14.2",
                                        "=board-name=RB750Gr3",
                                    ]
                                )
                            )
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/interface/print":
                            poll_count["n"] += 1
                            rx_val = 2097152 * poll_count["n"]
                            tx_val = 1048576 * poll_count["n"]
                            conn.sendall(
                                encode_sentence(
                                    [
                                        "!re",
                                        "=name=ether1-wan",
                                        "=type=ether",
                                        "=running=true",
                                        "=disabled=false",
                                        f"=rx-byte={rx_val}",
                                        f"=tx-byte={tx_val}",
                                    ]
                                )
                            )
                            conn.sendall(encode_sentence(["!done"]))
                        else:
                            conn.sendall(encode_sentence(["!done"]))

        t = threading.Thread(target=_mock_ros, daemon=True)
        t.start()

        try:
            rs, rcreated = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Overview Edge Router",
                    "host": "127.0.0.1",
                    "apiPort": ros_port,
                    "username": "admin",
                    "password": "secret",
                    "routerOsFamily": "ROUTEROS_V7",
                },
            )
            self.assertEqual(rs, 201)
            rid = rcreated["router"]["id"]

            ts, tres = _api(
                self.base_url,
                f"/api/routers/{rid}/test",
                method="POST",
                token=self.admin_token,
            )
            self.assertEqual(ts, 200)
            self.assertTrue(tres["telemetry"]["connected"])

            # Poll liveSync twice so series records multiple chronological points
            os1, ob1 = _api(
                self.base_url,
                "/api/routers/overview?poll=1&liveSync=1",
                token=self.admin_token,
            )
            self.assertEqual(os1, 200)
            os2, ob2 = _api(
                self.base_url,
                "/api/routers/overview?poll=1",
                token=self.admin_token,
            )
            self.assertEqual(os2, 200)

            summary = ob2["summary"]
            self.assertGreaterEqual(summary["connectedRouters"], 1)
            self.assertGreater(summary["totalRxBytes"], 0)
            self.assertGreater(summary["totalTxBytes"], 0)
            self.assertEqual(
                summary["totalBandwidthBytes"],
                summary["totalRxBytes"] + summary["totalTxBytes"],
            )
            self.assertGreaterEqual(len(ob2["bandwidthSeries"]), 2)
            latest = ob2["bandwidthSeries"][-1]
            self.assertGreater(latest["rxMb"], 0)
            self.assertGreater(latest["txMb"], 0)
            self.assertGreater(latest["totalMb"], 0)

            # Verify 24h per-router CPU & memory telemetry history endpoint
            th_s, th_b = _api(
                self.base_url,
                f"/api/routers/{rid}/telemetry?hours=24",
                token=self.admin_token,
            )
            self.assertEqual(th_s, 200)
            self.assertGreaterEqual(th_b["summary"]["sampleCount"], 2)
            self.assertEqual(th_b["summary"]["latestCpuPct"], 22)
            self.assertEqual(th_b["summary"]["latestMemoryPct"], 50.0)
            self.assertEqual(len(th_b["samples"]), th_b["summary"]["sampleCount"])
            self.assertEqual(th_b["samples"][-1]["cpuLoad"], 22)
            self.assertEqual(th_b["samples"][-1]["memoryPct"], 50.0)

            # Register a separate business tenant and verify isolated zeroed overview & cross-tenant block
            sb, bb = _api(
                self.base_url,
                "/api/auth/register-business",
                method="POST",
                body={
                    "businessName": "Arusha Fiber",
                    "ownerName": "Amina",
                    "ownerEmail": "amina@arushafiber.co.tz",
                    "password": "ArushaPassword#2026",
                    "phone": "+255754999111",
                    "country": "Tanzania",
                    "region": "Arusha",
                    "planCode": "STARTER",
                },
            )
            self.assertEqual(sb, 201)
            th_deny, _ = _api(
                self.base_url,
                f"/api/routers/{rid}/telemetry?hours=24",
                token=bb["token"],
            )
            self.assertEqual(th_deny, 403)
            iso_s, iso_b = _api(
                self.base_url,
                "/api/routers/overview",
                token=bb["token"],
            )
            self.assertEqual(iso_s, 200)
            self.assertEqual(iso_b["summary"]["totalRouters"], 0)
            self.assertEqual(iso_b["summary"]["totalBandwidthBytes"], 0)
            self.assertEqual(iso_b["bandwidthSeries"], [])

            # Ping diagnostic on reachable router returns roundTripMs >= 0
            ps_ok, pbody_ok = _api(
                self.base_url,
                f"/api/routers/{rid}/ping",
                method="POST",
                token=self.admin_token,
            )
            self.assertEqual(ps_ok, 200)
            self.assertTrue(pbody_ok["ping"]["reachable"])
            self.assertIsNotNone(pbody_ok["ping"]["roundTripMs"])
            self.assertGreaterEqual(pbody_ok["ping"]["roundTripMs"], 0.0)
            self.assertEqual(pbody_ok["ping"]["method"], "TCP")

            # Cross-tenant ping request must be denied
            ps_deny, _ = _api(
                self.base_url,
                f"/api/routers/{rid}/ping",
                method="POST",
                token=bb["token"],
            )
            self.assertEqual(ps_deny, 403)

            # Standalone placeholder router without host returns clean unreachable ping response
            es, ecreated = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=bb["token"],
                body={
                    "name": "Standalone Pending Router",
                    "host": "",
                    "apiPort": 8728,
                    "routerOsFamily": "ROUTEROS_V7",
                },
            )
            self.assertEqual(es, 201)
            ps_empty, pbody_empty = _api(
                self.base_url,
                f"/api/routers/{ecreated['router']['id']}/ping",
                method="POST",
                token=bb["token"],
            )
            self.assertEqual(ps_empty, 200)
            self.assertFalse(pbody_empty["ping"]["reachable"])
            self.assertIsNone(pbody_empty["ping"]["roundTripMs"])
        finally:
            stop_flag.set()
            srv_sock.close()
            t.join(timeout=2)

    def test_network_scanner_discovers_routeros_and_mndp(self) -> None:
        tcp_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        tcp_sock.bind(("127.0.0.1", 0))
        tcp_sock.listen(4)
        ros_port = tcp_sock.getsockname()[1]

        udp_sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        udp_sock.bind(("127.0.0.1", 0))
        mndp_port = udp_sock.getsockname()[1]

        stop_flag = threading.Event()

        def _tlv(tag: int, val: bytes) -> bytes:
            return tag.to_bytes(2, "big") + len(val).to_bytes(2, "big") + val

        mndp_packet = (
            b"\x00\x00\x00\x01"
            + _tlv(1, bytes.fromhex("48A98A112233"))
            + _tlv(5, b"Dar-Core-CCR")
            + _tlv(7, b"7.14.2")
            + _tlv(12, b"CCR2004")
        )

        def _mock_tcp() -> None:
            while not stop_flag.is_set():
                try:
                    tcp_sock.settimeout(0.2)
                    conn, _ = tcp_sock.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                with conn:
                    words = _read_ros_sentence(conn)
                    if words and words[0] == "/login":
                        conn.sendall(encode_sentence(["!done"]))

        def _mock_udp() -> None:
            while not stop_flag.is_set():
                try:
                    udp_sock.settimeout(0.2)
                    _, addr = udp_sock.recvfrom(1024)
                    udp_sock.sendto(mndp_packet, addr)
                except TimeoutError:
                    continue
                except OSError:
                    break

        t_tcp = threading.Thread(target=_mock_tcp, daemon=True)
        t_udp = threading.Thread(target=_mock_udp, daemon=True)
        t_tcp.start()
        t_udp.start()

        try:
            # Oversized CIDR (/16) and metadata IP range (169.254.169.254) must be rejected cleanly
            bad1, _ = _api(
                self.base_url,
                "/api/routers/scan",
                method="POST",
                token=self.admin_token,
                body={"ipRange": "192.168.0.0/16", "apiPort": ros_port},
            )
            self.assertEqual(bad1, 400)

            bad2, _ = _api(
                self.base_url,
                "/api/routers/scan",
                method="POST",
                token=self.admin_token,
                body={"ipRange": "169.254.169.254", "apiPort": ros_port},
            )
            self.assertEqual(bad2, 400)

            # Scan 127.0.0.1-127.0.0.1 -> discovers both RouterOS API and MNDP attributes
            ok_s, ok_body = _api(
                self.base_url,
                "/api/routers/scan",
                method="POST",
                token=self.admin_token,
                body={
                    "ipRange": "127.0.0.1-127.0.0.1",
                    "apiPort": ros_port,
                    "includeMndp": True,
                    "mndpPort": mndp_port,
                },
            )
            self.assertEqual(ok_s, 200)
            self.assertEqual(ok_body["scannedHosts"], 1)
            self.assertEqual(len(ok_body["discovered"]), 1)
            found = ok_body["discovered"][0]
            self.assertEqual(found["host"], "127.0.0.1")
            self.assertEqual(found["apiPort"], ros_port)
            self.assertEqual(found["suggestedName"], "Dar-Core-CCR")
            self.assertEqual(found["boardName"], "CCR2004")
            self.assertEqual(found["routerOsVersion"], "7.14.2")
            self.assertEqual(found["macAddress"], "48:A9:8A:11:22:33")
            self.assertIn("ROUTEROS_API", found["discoveryMethods"])
            self.assertIn("MNDP", found["discoveryMethods"])
            self.assertTrue(found["apiVerified"])
            self.assertFalse(found["alreadyAdded"])

            # Add discovered router, then re-scan and verify alreadyAdded flips to True
            add_s, _ = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": found["suggestedName"],
                    "host": found["host"],
                    "apiPort": found["apiPort"],
                    "routerOsFamily": found["routerOsFamily"],
                },
            )
            self.assertEqual(add_s, 201)

            re_s, re_body = _api(
                self.base_url,
                "/api/routers/scan",
                method="POST",
                token=self.admin_token,
                body={
                    "ipRange": "127.0.0.1",
                    "apiPort": ros_port,
                    "includeMndp": False,
                },
            )
            self.assertEqual(re_s, 200)
            self.assertTrue(re_body["discovered"][0]["alreadyAdded"])
        finally:
            stop_flag.set()
            tcp_sock.close()
            udp_sock.close()
            t_tcp.join(timeout=2)
            t_udp.join(timeout=2)

    def test_bulk_command_pushes_ssid_and_ntp_simultaneously(self) -> None:
        servers: list[socket.socket] = []
        ports: list[int] = []
        commands_by_port: dict[int, list[list[str]]] = {}
        stop_flag = threading.Event()
        threads: list[threading.Thread] = []

        for _ in range(2):
            srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            srv.bind(("127.0.0.1", 0))
            srv.listen(4)
            p = srv.getsockname()[1]
            servers.append(srv)
            ports.append(p)
            commands_by_port[p] = []

            def _serve(sock_obj: socket.socket = srv, port_num: int = p) -> None:
                while not stop_flag.is_set():
                    try:
                        sock_obj.settimeout(0.2)
                        conn, _ = sock_obj.accept()
                    except TimeoutError:
                        continue
                    except OSError:
                        break
                    with conn:
                        while True:
                            words = _read_ros_sentence(conn)
                            if not words:
                                break
                            commands_by_port[port_num].append(words)
                            cmd = words[0]
                            if cmd == "/login":
                                conn.sendall(encode_sentence(["!done"]))
                            elif cmd == "/interface/wireless/print":
                                conn.sendall(encode_sentence(["!re", "=.id=*1", "=name=wlan1", "=ssid=OLD-WIFI"]))
                                conn.sendall(encode_sentence(["!done"]))
                            else:
                                conn.sendall(encode_sentence(["!done"]))

            th = threading.Thread(target=_serve, daemon=True)
            th.start()
            threads.append(th)

        try:
            r1_s, r1 = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Bulk AP North",
                    "host": "127.0.0.1",
                    "apiPort": ports[0],
                    "username": "admin",
                    "password": "secret",
                    "routerOsFamily": "ROUTEROS_V7",
                },
            )
            self.assertEqual(r1_s, 201)

            r2_s, r2 = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Bulk AP South",
                    "host": "127.0.0.1",
                    "apiPort": ports[1],
                    "username": "admin",
                    "password": "secret",
                    "routerOsFamily": "ROUTEROS_V6",
                },
            )
            self.assertEqual(r2_s, 201)

            r3_s, r3 = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Unconfigured Standby",
                    "host": "",
                    "apiPort": 8728,
                    "routerOsFamily": "ROUTEROS_V7",
                },
            )
            self.assertEqual(r3_s, 201)

            r1_id = r1["router"]["id"]
            r2_id = r2["router"]["id"]
            r3_id = r3["router"]["id"]

            # Push SSID simultaneously to r1, r2, and unconfigured r3
            ssid_s, ssid_res = _api(
                self.base_url,
                "/api/routers/bulk-command",
                method="POST",
                token=self.admin_token,
                body={
                    "routerIds": [r1_id, r2_id, r3_id],
                    "commandType": "UPDATE_SSID",
                    "params": {"ssid": "TRAX-CAMPUS-5G"},
                },
            )
            self.assertEqual(ssid_s, 200)
            self.assertEqual(ssid_res["totalRequested"], 3)
            self.assertEqual(ssid_res["succeededCount"], 2)
            self.assertEqual(ssid_res["failedCount"], 1)
            self.assertTrue(ssid_res["results"][0]["success"])
            self.assertTrue(ssid_res["results"][1]["success"])
            self.assertFalse(ssid_res["results"][2]["success"])

            for p in ports:
                self.assertTrue(
                    any(
                        c[0] == "/interface/wireless/set" and "=ssid=TRAX-CAMPUS-5G" in c
                        for c in commands_by_port[p]
                    )
                )

            # Push NTP server settings to r1 (ROS v7) and r2 (ROS v6)
            ntp_s, ntp_res = _api(
                self.base_url,
                "/api/routers/bulk-command",
                method="POST",
                token=self.admin_token,
                body={
                    "routerIds": [r1_id, r2_id],
                    "commandType": "UPDATE_NTP",
                    "params": {
                        "primaryServer": "pool.ntp.org",
                        "secondaryServer": "time.cloudflare.com",
                        "enabled": True,
                    },
                },
            )
            self.assertEqual(ntp_s, 200)
            self.assertEqual(ntp_res["succeededCount"], 2)
            self.assertTrue(
                any(
                    c[0] == "/system/ntp/client/set" and "=servers=pool.ntp.org,time.cloudflare.com" in c
                    for c in commands_by_port[ports[0]]
                )
            )
            self.assertTrue(
                any(
                    c[0] == "/system/ntp/client/set" and "=primary-ntp=pool.ntp.org" in c and "=secondary-ntp=time.cloudflare.com" in c
                    for c in commands_by_port[ports[1]]
                )
            )

            # Invalid SSID (> 32 chars) must be rejected cleanly with 400
            bad_s, _ = _api(
                self.base_url,
                "/api/routers/bulk-command",
                method="POST",
                token=self.admin_token,
                body={
                    "routerIds": [r1_id],
                    "commandType": "UPDATE_SSID",
                    "params": {"ssid": "X" * 33},
                },
            )
            self.assertEqual(bad_s, 400)

            # Cross-tenant router ID in bulk-command must be denied with 403
            sb, bb = _api(
                self.base_url,
                "/api/auth/register-business",
                method="POST",
                body={
                    "businessName": "Mwanza Mesh",
                    "ownerName": "Neema",
                    "ownerEmail": "neema@mwanzamesh.co.tz",
                    "password": "MwanzaPassword#2026",
                    "phone": "+255754444555",
                    "country": "Tanzania",
                    "region": "Mwanza",
                    "planCode": "STARTER",
                },
            )
            self.assertEqual(sb, 201)
            deny_s, _ = _api(
                self.base_url,
                "/api/routers/bulk-command",
                method="POST",
                token=bb["token"],
                body={
                    "routerIds": [r1_id],
                    "commandType": "UPDATE_NTP",
                    "params": {"primaryServer": "pool.ntp.org"},
                },
            )
            self.assertEqual(deny_s, 403)
        finally:
            stop_flag.set()
            for srv in servers:
                srv.close()
            for th in threads:
                th.join(timeout=2)

    def test_router_auto_sync_profiles_on_package_create_and_update(self) -> None:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(4)
        ros_port = srv.getsockname()[1]
        commands: list[list[str]] = []
        created_profiles: dict[str, str] = {}
        stop_flag = threading.Event()

        def _serve() -> None:
            while not stop_flag.is_set():
                try:
                    srv.settimeout(0.2)
                    conn, _ = srv.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                with conn:
                    while True:
                        words = _read_ros_sentence(conn)
                        if not words:
                            break
                        commands.append(words)
                        cmd = words[0]
                        if cmd == "/login":
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/ip/hotspot/user/profile/print":
                            target_name = ""
                            for w in words[1:]:
                                if w.startswith("?name="):
                                    target_name = w.split("=", 1)[1]
                            if target_name in created_profiles:
                                conn.sendall(
                                    encode_sentence(
                                        ["!re", f"=.id={created_profiles[target_name]}", f"=name={target_name}"]
                                    )
                                )
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/ip/hotspot/user/profile/add":
                            prof_name = ""
                            for w in words[1:]:
                                if w.startswith("=name="):
                                    prof_name = w.split("=", 1)[1]
                            if prof_name:
                                created_profiles[prof_name] = f"*{len(created_profiles) + 1}"
                            conn.sendall(encode_sentence(["!done"]))
                        else:
                            conn.sendall(encode_sentence(["!done"]))

        th = threading.Thread(target=_serve, daemon=True)
        th.start()

        try:
            # Default setting must be False
            gs, gbody = _api(self.base_url, "/api/routers/settings", token=self.admin_token)
            self.assertEqual(gs, 200)
            self.assertFalse(gbody["autoSyncProfiles"])

            # Non-boolean autoSyncProfiles must fail with 400
            bad_s, _ = _api(
                self.base_url,
                "/api/routers/settings",
                method="PATCH",
                token=self.admin_token,
                body={"autoSyncProfiles": "yes"},
            )
            self.assertEqual(bad_s, 400)

            # Add configured MikroTik router
            rs, _ = _api(
                self.base_url,
                "/api/routers",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "AutoSync Core",
                    "host": "127.0.0.1",
                    "apiPort": ros_port,
                    "username": "admin",
                    "password": "secret",
                    "routerOsFamily": "ROUTEROS_V7",
                },
            )
            self.assertEqual(rs, 201)

            # Create package while autoSyncProfiles is False -> no push sent
            p1_s, p1 = _api(
                self.base_url,
                "/api/packages",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Manual Sync Pack",
                    "category": "HOURLY",
                    "priceTzs": 1000,
                    "durationMinutes": 60,
                    "downloadKbps": 4000,
                    "uploadKbps": 2000,
                },
            )
            self.assertEqual(p1_s, 201)
            self.assertFalse(p1["profileSync"]["enabled"])
            self.assertEqual(len(commands), 0)

            # Enable autoSyncProfiles
            es, ebody = _api(
                self.base_url,
                "/api/routers/settings",
                method="PATCH",
                token=self.admin_token,
                body={"autoSyncProfiles": True},
            )
            self.assertEqual(es, 200)
            self.assertTrue(ebody["autoSyncProfiles"])

            # Create package -> automatically triggers /ip/hotspot/user/profile/add
            p2_s, p2 = _api(
                self.base_url,
                "/api/packages",
                method="POST",
                token=self.admin_token,
                body={
                    "name": "Auto Sync Fiber Pack",
                    "category": "DAILY",
                    "priceTzs": 2500,
                    "durationMinutes": 1440,
                    "downloadKbps": 12000,
                    "uploadKbps": 6000,
                },
            )
            self.assertEqual(p2_s, 201)
            self.assertTrue(p2["profileSync"]["enabled"])
            self.assertEqual(p2["profileSync"]["synced"], 1)
            pkg2_id = p2["package"]["id"]
            self.assertTrue(
                any(
                    c[0] == "/ip/hotspot/user/profile/add"
                    and f"=name=trax-{pkg2_id}" in c
                    and "=rate-limit=6000k/12000k" in c
                    for c in commands
                )
            )

            # Update package -> automatically triggers /ip/hotspot/user/profile/set
            u2_s, u2 = _api(
                self.base_url,
                f"/api/packages/{pkg2_id}",
                method="PATCH",
                token=self.admin_token,
                body={"downloadKbps": 20000, "uploadKbps": 10000},
            )
            self.assertEqual(u2_s, 200)
            self.assertTrue(u2["profileSync"]["enabled"])
            self.assertEqual(u2["profileSync"]["synced"], 1)
            self.assertTrue(
                any(
                    c[0] == "/ip/hotspot/user/profile/set"
                    and "=rate-limit=10000k/20000k" in c
                    for c in commands
                )
            )
        finally:
            stop_flag.set()
            srv.close()
            th.join(timeout=2)

    def test_business_details_and_portal_reflection(self) -> None:
        # Unsafe website scheme must be rejected
        bad_url_s, _ = _api(
            self.base_url,
            "/api/business/settings",
            method="PATCH",
            token=self.admin_token,
            body={"websiteUrl": "javascript:alert(1)"},
        )
        self.assertEqual(bad_url_s, 400)

        # Update rich business page details
        upd_s, upd = _api(
            self.base_url,
            "/api/business/settings",
            method="PATCH",
            token=self.admin_token,
            body={
                "hotspotTitle": "Serengeti Mesh WiFi",
                "hotspotSupportPhone": "+255754888999",
                "description": "High-speed prepaid fiber hotspot across Arusha & Dar.",
                "physicalAddress": "Ohio Street, Plot 22",
                "city": "Dar es Salaam",
                "websiteUrl": "https://serengetimesh.co.tz",
                "supportHours": "Daily 06:00 - 23:00 EAT",
            },
        )
        self.assertEqual(upd_s, 200)
        self.assertEqual(upd["settings"]["city"], "Dar es Salaam")
        self.assertEqual(upd["settings"]["websiteUrl"], "https://serengetimesh.co.tz")

        # Dedicated GET /api/business/details endpoint
        det_s, det = _api(self.base_url, "/api/business/details", token=self.admin_token)
        self.assertEqual(det_s, 200)
        self.assertEqual(det["business"]["physicalAddress"], "Ohio Street, Plot 22")
        self.assertEqual(det["business"]["supportHours"], "Daily 06:00 - 23:00 EAT")
        self.assertIn("metrics", det)
        self.assertIn("packagesSummary", det)

        # Reflected cleanly on public /api/portal/businesses
        pb_s, pb = _api(self.base_url, "/api/portal/businesses")
        self.assertEqual(pb_s, 200)
        self.assertEqual(pb["businesses"][0]["hotspotTitle"], "Serengeti Mesh WiFi")
        self.assertEqual(pb["businesses"][0]["websiteUrl"], "https://serengetimesh.co.tz")

    def test_admin_wifi_quick_connect(self) -> None:
        # Reject forbidden public DNS / metadata IPs
        for bad_ip in ("8.8.8.8", "169.254.169.254"):
            bad_s, _ = _api(
                self.base_url,
                "/api/wifi/connect",
                method="POST",
                token=self.admin_token,
                body={
                    "wifiSsid": "MyShop-WiFi",
                    "gatewayType": "POCKET_WIFI",
                    "gatewayIp": bad_ip,
                },
            )
            self.assertEqual(bad_s, 400)

        # Link Pocket WiFi in Standalone Mode cleanly
        pw_s, pw = _api(
            self.base_url,
            "/api/wifi/connect",
            method="POST",
            token=self.admin_token,
            body={
                "wifiSsid": "Airtel-Shop-4G",
                "gatewayType": "POCKET_WIFI",
                "gatewayIp": "192.168.8.1",
            },
        )
        self.assertEqual(pw_s, 200)
        self.assertEqual(pw["wifiSsid"], "Airtel-Shop-4G")
        self.assertEqual(pw["operatingMode"], "STANDALONE_MODE")

        st_s, st = _api(self.base_url, "/api/wifi/status", token=self.admin_token)
        self.assertEqual(st_s, 200)
        self.assertEqual(st["wifiSsid"], "Airtel-Shop-4G")
        self.assertEqual(st["wifiGatewayIp"], "192.168.8.1")

        # Link & connect real MikroTik WiFi router + push SSID
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.bind(("127.0.0.1", 0))
        srv.listen(4)
        ros_port = srv.getsockname()[1]
        commands: list[list[str]] = []
        stop_flag = threading.Event()

        def _serve() -> None:
            while not stop_flag.is_set():
                try:
                    srv.settimeout(0.2)
                    conn, _ = srv.accept()
                except TimeoutError:
                    continue
                except OSError:
                    break
                with conn:
                    while True:
                        words = _read_ros_sentence(conn)
                        if not words:
                            break
                        commands.append(words)
                        cmd = words[0]
                        if cmd == "/login":
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/system/resource/print":
                            conn.sendall(
                                encode_sentence(
                                    [
                                        "!re",
                                        "=cpu-load=14",
                                        "=free-memory=268435456",
                                        "=total-memory=536870912",
                                        "=uptime=2d",
                                        "=version=7.15",
                                        "=board-name=hAP ax2",
                                    ]
                                )
                            )
                            conn.sendall(encode_sentence(["!done"]))
                        elif cmd == "/interface/wireless/print":
                            conn.sendall(encode_sentence(["!re", "=.id=*1", "=name=wlan1", "=ssid=OLD"]))
                            conn.sendall(encode_sentence(["!done"]))
                        else:
                            conn.sendall(encode_sentence(["!done"]))

        th = threading.Thread(target=_serve, daemon=True)
        th.start()

        try:
            mk_s, mk = _api(
                self.base_url,
                "/api/wifi/connect",
                method="POST",
                token=self.admin_token,
                body={
                    "wifiSsid": "TRAX-CAFE-PRO",
                    "gatewayType": "MIKROTIK",
                    "gatewayIp": "127.0.0.1",
                    "apiPort": ros_port,
                    "username": "admin",
                    "password": "secret",
                    "updateRouterSsid": True,
                },
            )
            self.assertEqual(mk_s, 200)
            self.assertTrue(mk["telemetry"]["connected"])
            self.assertEqual(mk["operatingMode"], "MIKROTIK_MODE")
            self.assertEqual(mk["ssidPush"]["succeededCount"], 1)
            self.assertTrue(
                any(c[0] == "/interface/wireless/set" and "=ssid=TRAX-CAFE-PRO" in c for c in commands)
            )

            # Unlink WiFi clears workspace wifi fields cleanly
            del_s, del_body = _api(
                self.base_url,
                "/api/wifi/connect",
                method="DELETE",
                token=self.admin_token,
            )
            self.assertEqual(del_s, 200)
            self.assertIsNone(del_body["wifiSsid"])
        finally:
            stop_flag.set()
            srv.close()
            th.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
