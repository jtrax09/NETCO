"""Real MikroTik RouterOS binary API client (v6/v7) & WireGuard+RADIUS generator in Python."""

from __future__ import annotations

import hashlib
import ipaddress
import json
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from typing import Any

from ..db import DatabaseManager, utc_now_iso
from ..security import decrypt_secret, generate_id


def encode_word(word: str) -> bytes:
    buf = word.encode("utf-8")
    length = len(buf)
    if length < 0x80:
        len_bytes = bytes([length])
    elif length < 0x4000:
        val = length | 0x8000
        len_bytes = bytes([(val >> 8) & 0xFF, val & 0xFF])
    elif length < 0x200000:
        val = length | 0xC00000
        len_bytes = bytes([(val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF])
    elif length < 0x10000000:
        val = length | 0xE0000000
        len_bytes = bytes(
            [(val >> 24) & 0xFF, (val >> 16) & 0xFF, (val >> 8) & 0xFF, val & 0xFF]
        )
    else:
        len_bytes = b"\xF0" + length.to_bytes(4, "big")
    return len_bytes + buf


def encode_sentence(words: list[str]) -> bytes:
    return b"".join(encode_word(w) for w in words) + b"\x00"


def decode_length(buffer: bytes | bytearray, offset: int) -> tuple[int, int] | None:
    if offset >= len(buffer):
        return None
    b0 = buffer[offset]
    if (b0 & 0x80) == 0:
        return b0, 1
    if (b0 & 0xC0) == 0x80:
        if offset + 1 >= len(buffer):
            return None
        return ((b0 & ~0xC0) << 8) + buffer[offset + 1], 2
    if (b0 & 0xE0) == 0xC0:
        if offset + 2 >= len(buffer):
            return None
        return ((b0 & ~0xE0) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2], 3
    if (b0 & 0xF0) == 0xE0:
        if offset + 3 >= len(buffer):
            return None
        val = (
            ((b0 & ~0xF0) << 24)
            + (buffer[offset + 1] << 16)
            + (buffer[offset + 2] << 8)
            + buffer[offset + 3]
        )
        return val, 4
    return None


@dataclass
class RouterTelemetryResult:
    connected: bool
    error: str | None = None
    cpu_load: int | None = None
    memory_used_bytes: int | None = None
    memory_total_bytes: int | None = None
    uptime: str | None = None
    router_os_version: str | None = None
    board_name: str | None = None
    interfaces: list[dict[str, Any]] = field(default_factory=list)
    active_hotspot_count: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "connected": self.connected,
            "error": self.error,
            "cpuLoad": self.cpu_load,
            "memoryUsedBytes": self.memory_used_bytes,
            "memoryTotalBytes": self.memory_total_bytes,
            "uptime": self.uptime,
            "routerOsVersion": self.router_os_version,
            "boardName": self.board_name,
            "interfaces": self.interfaces,
            "activeHotspotCount": self.active_hotspot_count,
        }


class RouterOsClient:
    """Pure Python TCP/TLS client implementing the MikroTik RouterOS binary API protocol."""

    def __init__(self) -> None:
        self._sock: socket.socket | ssl.SSLSocket | None = None
        self._buf = bytearray()

    def connect(self, host: str, port: int = 8728, use_tls: bool = False, timeout: float = 4.0) -> None:
        raw_sock = socket.create_connection((host, port), timeout=timeout)
        raw_sock.settimeout(timeout)
        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            self._sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            self._sock = raw_sock

    def _read_sentence(self) -> list[str]:
        assert self._sock is not None
        sentence: list[str] = []
        while True:
            while True:
                len_info = decode_length(self._buf, 0)
                if len_info is None:
                    break
                word_len, prefix_bytes = len_info
                if word_len == 0:
                    del self._buf[:prefix_bytes]
                    return sentence
                needed = prefix_bytes + word_len
                if len(self._buf) < needed:
                    break
                word_bytes = bytes(self._buf[prefix_bytes:needed])
                del self._buf[:needed]
                sentence.append(word_bytes.decode("utf-8", errors="replace"))
            chunk = self._sock.recv(4096)
            if not chunk:
                raise ConnectionError("RouterOS socket closed unexpectedly")
            self._buf.extend(chunk)

    def command(self, words: list[str]) -> list[dict[str, str]]:
        if not self._sock:
            raise ConnectionError("RouterOS socket not connected")
        self._sock.sendall(encode_sentence(words))
        records: list[dict[str, str]] = []
        while True:
            sentence = self._read_sentence()
            if not sentence:
                continue
            tag = sentence[0]
            parsed: dict[str, str] = {}
            for word in sentence[1:]:
                if word.startswith("=") and "=" in word[1:]:
                    eq_idx = word.index("=", 1)
                    parsed[word[1:eq_idx]] = word[eq_idx + 1 :]
            if tag == "!re":
                records.append(parsed)
            elif tag == "!done":
                if parsed:
                    records.append(parsed)
                return records
            elif tag in ("!trap", "!fatal"):
                raise RuntimeError(parsed.get("message") or "RouterOS API command rejected")

    def login(self, username: str, password: str) -> None:
        res = self.command(["/login", f"=name={username}", f"=password={password}"])
        ret = res[0].get("ret") if res else None
        if ret:
            # Legacy pre-6.43 challenge login
            challenge = bytes.fromhex(ret)
            digest = hashlib.md5(b"\x00" + password.encode("utf-8") + challenge).hexdigest()
            self.command(["/login", f"=name={username}", f"=response=00{digest}"])

    def close(self) -> None:
        if self._sock:
            try:
                self._sock.close()
            except OSError:
                pass
            self._sock = None


def test_router_connection(
    host: str, api_port: int, use_tls: bool, username: str, password: str
) -> RouterTelemetryResult:
    client = RouterOsClient()
    try:
        client.connect(host, api_port, use_tls, timeout=4.0)
        client.login(username, password)
        resources = client.command(["/system/resource/print"])
        ifaces = client.command(["/interface/print"])
        hotspot_active = client.command(["/ip/hotspot/active/print"])

        res = resources[0] if resources else {}
        total_mem = int(res.get("total-memory") or 0)
        free_mem = int(res.get("free-memory") or 0)
        return RouterTelemetryResult(
            connected=True,
            cpu_load=int(res.get("cpu-load") or 0),
            memory_total_bytes=total_mem,
            memory_used_bytes=max(0, total_mem - free_mem),
            uptime=res.get("uptime") or None,
            router_os_version=res.get("version") or None,
            board_name=res.get("board-name") or res.get("platform") or None,
            interfaces=[
                {
                    "name": iface.get("name") or "ether",
                    "type": iface.get("type") or "ether",
                    "running": iface.get("running") == "true",
                    "disabled": iface.get("disabled") == "true",
                    "rxBytes": int(iface.get("rx-byte") or 0),
                    "txBytes": int(iface.get("tx-byte") or 0),
                }
                for iface in ifaces[:24]
            ],
            active_hotspot_count=len(hotspot_active),
        )
    except Exception as exc:
        return RouterTelemetryResult(connected=False, error=str(exc) or "Unable to reach MikroTik RouterOS API")
    finally:
        client.close()


def sync_router_telemetry(db: DatabaseManager, router_id: str) -> RouterTelemetryResult:
    row = db.query_one("SELECT * FROM routers WHERE id = ?", (router_id,))
    if not row:
        raise ValueError("Router not found")

    host = str(row.get("host") or "").strip()
    username = str(row.get("username") or "").strip()
    enc_pass = str(row.get("password_encrypted") or "").strip()

    if not host or not username or not enc_pass:
        result = RouterTelemetryResult(
            connected=False,
            error="No MikroTik router connected — host or credentials not configured (Standalone Mode).",
        )
    elif host == "8.8.8.8":
        result = RouterTelemetryResult(
            connected=False,
            error="8.8.8.8 is not a valid MikroTik router address.",
        )
    else:
        try:
            password = decrypt_secret(enc_pass)
            result = test_router_connection(
                host=host,
                api_port=int(row.get("api_port") or 8728),
                use_tls=bool(row.get("use_tls")),
                username=username,
                password=password,
            )
        except Exception as exc:
            result = RouterTelemetryResult(connected=False, error=str(exc))

    now_iso = utc_now_iso()
    prev_status = str(row["status"])
    next_status = "CONNECTED" if result.connected else "NOT_CONNECTED"

    db.execute(
        """
        UPDATE routers
        SET status = ?, cpu_load = ?, memory_used_bytes = ?, memory_total_bytes = ?,
            uptime = ?, router_os_version = ?, board_name = ?, last_error = ?,
            last_checked_at = ?, updated_at = ?
        WHERE id = ?
        """,
        (
            next_status,
            result.cpu_load if result.connected else None,
            result.memory_used_bytes if result.connected else None,
            result.memory_total_bytes if result.connected else None,
            result.uptime if result.connected else None,
            result.router_os_version if result.connected else None,
            result.board_name if result.connected else None,
            None if result.connected else (result.error or "Router unreachable"),
            now_iso,
            now_iso,
            router_id,
        ),
    )

    if result.connected and result.interfaces:
        for iface in result.interfaces:
            db.execute(
                """
                INSERT INTO router_interfaces (id, router_id, name, type, running, disabled, rx_bytes, tx_bytes, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(router_id, name) DO UPDATE SET
                  type = excluded.type, running = excluded.running, disabled = excluded.disabled,
                  rx_bytes = excluded.rx_bytes, tx_bytes = excluded.tx_bytes, updated_at = excluded.updated_at
                """,
                (
                    generate_id("rif"),
                    router_id,
                    iface["name"],
                    iface["type"],
                    1 if iface["running"] else 0,
                    1 if iface["disabled"] else 0,
                    iface["rxBytes"],
                    iface["txBytes"],
                    now_iso,
                ),
            )

    if result.connected:
        record_connected_routers_bandwidth_sample(db, str(row["business_id"]), now_iso)

    if prev_status != next_status:
        db.execute(
            """
            INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                generate_id("ntf"),
                str(row["business_id"]),
                "ROUTER_ONLINE" if result.connected else "ROUTER_OFFLINE",
                "INFO" if result.connected else "WARNING",
                f"Router {row['name']} Online" if result.connected else f"Router {row['name']} Not Connected",
                (
                    f"Connected to MikroTik RouterOS ({result.board_name or row['host']})."
                    if result.connected
                    else (result.error or f"Router {row['host']}:{row['api_port']} is unreachable.")
                ),
                json.dumps({"routerId": router_id, "host": row["host"]}),
            ),
        )

    return result


def record_connected_routers_bandwidth_sample(
    db: DatabaseManager,
    business_id: str,
    recorded_at: str | None = None,
) -> dict[str, int]:
    """Compute aggregate RX/TX bytes across all CONNECTED routers and record a timestamped sample."""
    agg = db.query_one(
        """
        SELECT COALESCE(SUM(ri.rx_bytes), 0) as rxBytes,
               COALESCE(SUM(ri.tx_bytes), 0) as txBytes
        FROM router_interfaces ri
        JOIN routers r ON r.id = ri.router_id
        WHERE r.business_id = ? AND r.status = 'CONNECTED'
        """,
        (business_id,),
    )
    rx_bytes = int((agg or {}).get("rxBytes") or 0)
    tx_bytes = int((agg or {}).get("txBytes") or 0)
    ts = recorded_at or utc_now_iso()

    db.execute(
        """
        INSERT INTO network_usage (id, business_id, router_id, session_id, rx_bytes, tx_bytes, recorded_at)
        VALUES (?, ?, NULL, NULL, ?, ?, ?)
        """,
        (generate_id("nug"), business_id, rx_bytes, tx_bytes, ts),
    )
    db.execute(
        """
        DELETE FROM network_usage
        WHERE business_id = ? AND router_id IS NULL
          AND id NOT IN (
            SELECT id FROM network_usage
            WHERE business_id = ? AND router_id IS NULL
            ORDER BY recorded_at DESC
            LIMIT 120
          )
        """,
        (business_id, business_id),
    )
    return {"rxBytes": rx_bytes, "txBytes": tx_bytes}


def get_routers_bandwidth_overview(db: DatabaseManager, business_id: str) -> dict[str, Any]:
    """Return total connected-router bandwidth summary, per-router breakdown, and live line series."""
    routers = db.query_all(
        """
        SELECT r.id, r.name, r.status, r.host, r.api_port as apiPort,
               r.cpu_load as cpuLoad, r.memory_used_bytes as memoryUsedBytes,
               r.memory_total_bytes as memoryTotalBytes,
               COALESCE(SUM(ri.rx_bytes), 0) as rxBytes,
               COALESCE(SUM(ri.tx_bytes), 0) as txBytes,
               COUNT(ri.id) as interfaceCount,
               COALESCE(SUM(CASE WHEN ri.running = 1 AND ri.disabled = 0 THEN 1 ELSE 0 END), 0) as activeInterfaces
        FROM routers r
        LEFT JOIN router_interfaces ri ON ri.router_id = r.id
        WHERE r.business_id = ?
        GROUP BY r.id
        ORDER BY r.created_at DESC
        """,
        (business_id,),
    )

    connected_rows = [r for r in routers if str(r.get("status")) == "CONNECTED"]
    total_rx = sum(int(r.get("rxBytes") or 0) for r in connected_rows)
    total_tx = sum(int(r.get("txBytes") or 0) for r in connected_rows)
    total_interfaces = sum(int(r.get("interfaceCount") or 0) for r in connected_rows)
    active_interfaces = sum(int(r.get("activeInterfaces") or 0) for r in connected_rows)

    raw_series = db.query_all(
        """
        SELECT rx_bytes as rxBytes, tx_bytes as txBytes, recorded_at as sampledAt
        FROM network_usage
        WHERE business_id = ? AND router_id IS NULL
        ORDER BY recorded_at DESC
        LIMIT 24
        """,
        (business_id,),
    )
    raw_series.reverse()

    series: list[dict[str, Any]] = []
    for pt in raw_series:
        rx_b = int(pt.get("rxBytes") or 0)
        tx_b = int(pt.get("txBytes") or 0)
        tot_b = rx_b + tx_b
        sampled_at = str(pt.get("sampledAt") or "")
        label = sampled_at[11:19] if len(sampled_at) >= 19 else sampled_at
        series.append(
            {
                "sampledAt": sampled_at,
                "label": label,
                "rxBytes": rx_b,
                "txBytes": tx_b,
                "totalBytes": tot_b,
                "rxMb": round(rx_b / (1024 * 1024), 2),
                "txMb": round(tx_b / (1024 * 1024), 2),
                "totalMb": round(tot_b / (1024 * 1024), 2),
            }
        )

    per_router = [
        {
            "routerId": str(r["id"]),
            "name": str(r["name"]),
            "status": str(r["status"]),
            "rxBytes": int(r.get("rxBytes") or 0),
            "txBytes": int(r.get("txBytes") or 0),
            "totalBytes": int(r.get("rxBytes") or 0) + int(r.get("txBytes") or 0),
            "interfaceCount": int(r.get("interfaceCount") or 0),
            "activeInterfaces": int(r.get("activeInterfaces") or 0),
        }
        for r in routers
    ]

    return {
        "summary": {
            "totalRouters": len(routers),
            "connectedRouters": len(connected_rows),
            "offlineRouters": len(routers) - len(connected_rows),
            "totalRxBytes": total_rx,
            "totalTxBytes": total_tx,
            "totalBandwidthBytes": total_rx + total_tx,
            "totalInterfaces": total_interfaces,
            "activeInterfaces": active_interfaces,
        },
        "perRouterBandwidth": per_router,
        "bandwidthSeries": series,
    }


_SAFE_HOST_RE = re.compile(r"^[A-Za-z0-9._:-]{1,255}$")


def _is_disallowed_probe_host(host: str) -> str | None:
    if not host or not _SAFE_HOST_RE.fullmatch(host):
        return "Invalid router host format."
    if host == "8.8.8.8":
        return "8.8.8.8 is a public DNS IP and cannot be probed as a MikroTik router."
    try:
        ip_obj = ipaddress.ip_address(host)
    except ValueError:
        return None
    if ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_unspecified:
        return "Link-local, multicast, or unspecified addresses cannot be probed."
    return None


def ping_router_host(db: DatabaseManager, router_id: str, timeout: float = 2.5) -> dict[str, Any]:
    """Measure TCP/TLS handshake round-trip time (ms) to a configured router endpoint."""
    row = db.query_one(
        "SELECT id, business_id, name, host, api_port, use_tls FROM routers WHERE id = ?",
        (router_id,),
    )
    if not row:
        raise ValueError("Router not found")

    host = str(row.get("host") or "").strip()
    port = int(row.get("api_port") or 8728)
    use_tls = bool(row.get("use_tls"))
    checked_at = utc_now_iso()
    method = "TCP_TLS" if use_tls else "TCP"

    base = {
        "routerId": str(row["id"]),
        "routerName": str(row["name"]),
        "host": host,
        "port": port,
        "method": method,
        "checkedAt": checked_at,
    }

    if not host:
        return {
            **base,
            "reachable": False,
            "roundTripMs": None,
            "error": "Host IP not configured for this router (Standalone Mode).",
        }

    disallowed_reason = _is_disallowed_probe_host(host)
    if disallowed_reason:
        return {
            **base,
            "reachable": False,
            "roundTripMs": None,
            "error": disallowed_reason,
        }

    sock: socket.socket | ssl.SSLSocket | None = None
    started = time.perf_counter()
    try:
        raw_sock = socket.create_connection((host, port), timeout=timeout)
        raw_sock.settimeout(timeout)
        if use_tls:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
            sock = ctx.wrap_socket(raw_sock, server_hostname=host)
        else:
            sock = raw_sock
        rtt_ms = round((time.perf_counter() - started) * 1000.0, 2)
        return {
            **base,
            "reachable": True,
            "roundTripMs": rtt_ms,
            "error": None,
        }
    except Exception as exc:
        return {
            **base,
            "reachable": False,
            "roundTripMs": None,
            "error": str(exc) or f"Router {host}:{port} unreachable",
        }
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass


def push_hotspot_profile_to_router(
    db: DatabaseManager,
    router_id: str,
    profile_name: str,
    download_kbps: int,
    upload_kbps: int,
) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM routers WHERE id = ?", (router_id,))
    if not row:
        return {"synced": False, "message": "Router not found"}
    host = str(row.get("host") or "").strip()
    username = str(row.get("username") or "").strip()
    enc_pass = str(row.get("password_encrypted") or "").strip()
    if not host or not username or not enc_pass or host == "8.8.8.8":
        return {"synced": False, "message": "No MikroTik router connected (credentials not configured)"}

    client = RouterOsClient()
    try:
        password = decrypt_secret(enc_pass)
        client.connect(host, int(row.get("api_port") or 8728), bool(row.get("use_tls")), timeout=4.0)
        client.login(username, password)
        rate_limit = f"{upload_kbps}k/{download_kbps}k"
        existing = client.command(["/ip/hotspot/user/profile/print", f"?name={profile_name}"])
        if existing and existing[0].get(".id"):
            client.command(
                [
                    "/ip/hotspot/user/profile/set",
                    f"=.id={existing[0]['.id']}",
                    f"=rate-limit={rate_limit}",
                    "=shared-users=1",
                ]
            )
        else:
            client.command(
                [
                    "/ip/hotspot/user/profile/add",
                    f"=name={profile_name}",
                    f"=rate-limit={rate_limit}",
                    "=shared-users=1",
                ]
            )
        return {"synced": True, "message": f"Synced profile {profile_name} ({rate_limit}, shared-users=1)"}
    except Exception as exc:
        return {
            "synced": False,
            "message": str(exc) or "RouterOS profile sync skipped (router unreachable)",
        }
    finally:
        client.close()


def provision_hotspot_user_on_router(
    db: DatabaseManager,
    router_id: str,
    username: str,
    password: str,
    profile_name: str,
    limit_uptime_seconds: int,
    limit_bytes_total: int | None = None,
) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM routers WHERE id = ?", (router_id,))
    if not row:
        return {"provisioned": False, "message": "Router not found"}
    host = str(row.get("host") or "").strip()
    r_user = str(row.get("username") or "").strip()
    enc_pass = str(row.get("password_encrypted") or "").strip()
    if not host or not r_user or not enc_pass or host == "8.8.8.8":
        return {"provisioned": False, "message": "Router credentials not configured"}

    client = RouterOsClient()
    try:
        r_pass = decrypt_secret(enc_pass)
        client.connect(host, int(row.get("api_port") or 8728), bool(row.get("use_tls")), timeout=4.0)
        client.login(r_user, r_pass)
        args = [
            "/ip/hotspot/user/add",
            f"=name={username}",
            f"=password={password}",
            f"=profile={profile_name}",
            f"=limit-uptime={max(60, int(limit_uptime_seconds))}s",
        ]
        if limit_bytes_total and limit_bytes_total > 0:
            args.append(f"=limit-bytes-total={int(limit_bytes_total)}")
        client.command(args)
        return {"provisioned": True, "message": f"Hotspot user {username} added on {host}"}
    except Exception as exc:
        return {"provisioned": False, "message": str(exc)}
    finally:
        client.close()


def terminate_router_session(
    db: DatabaseManager, router_id: str, ip_address: str | None = None
) -> dict[str, Any]:
    row = db.query_one("SELECT * FROM routers WHERE id = ?", (router_id,))
    if not row or not ip_address or not row.get("host") or not row.get("username") or not row.get("password_encrypted"):
        return {"removed": False, "detail": "No connected router binding for session"}

    client = RouterOsClient()
    try:
        password = decrypt_secret(str(row["password_encrypted"]))
        client.connect(str(row["host"]), int(row.get("api_port") or 8728), bool(row.get("use_tls")), timeout=3.5)
        client.login(str(row["username"]), password)
        active = client.command(["/ip/hotspot/active/print", f"?address={ip_address}"])
        for item in active:
            if item.get(".id"):
                client.command(["/ip/hotspot/active/remove", f"=.id={item['.id']}"])
        return {"removed": len(active) > 0, "detail": f"Removed {len(active)} active RouterOS hotspot session(s)"}
    except Exception as exc:
        return {"removed": False, "detail": str(exc) or "RouterOS API unreachable"}
    finally:
        client.close()


def generate_mikrotik_wireguard_snippet(
    router_name: str,
    cloud_wg_public_key: str,
    cloud_wg_endpoint: str,
    router_tunnel_cidr: str,
    cloud_radius_ip: str,
    radius_secret: str,
    hotspot_server: str = "",
) -> str:
    safe_name = "".join(c if c.isalnum() or c in "-_" else "-" for c in router_name)[:24]
    hotspot_line = (
        f"/ip hotspot profile set [find name={hotspot_server}] use-radius=yes"
        if hotspot_server.strip()
        else "/ip hotspot profile set [find default=yes] use-radius=yes"
    )
    return "\n".join(
        [
            f"# TRAX LINK RouterOS v7 WireGuard + FreeRADIUS Onboarding ({safe_name})",
            "/interface wireguard add name=wg-traxlink listen-port=51820",
            f"/ip address add address={router_tunnel_cidr} interface=wg-traxlink",
            f'/interface wireguard peers add interface=wg-traxlink public-key="{cloud_wg_public_key}" endpoint-address={cloud_wg_endpoint.split(":")[0]} endpoint-port=51820 allowed-address=10.66.0.0/24 persistent-keepalive=25',
            f'/radius add service=hotspot address={cloud_radius_ip} secret="{radius_secret}" timeout=3000ms',
            "/radius incoming set accept=yes port=3799",
            hotspot_line,
        ]
    )
