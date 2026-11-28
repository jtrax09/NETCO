"""Real MikroTik RouterOS binary API client (v6/v7) & WireGuard+RADIUS generator in Python."""

from __future__ import annotations

import concurrent.futures
import hashlib
import ipaddress
import json
import re
import socket
import ssl
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
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
        mem_pct: float | None = None
        if result.memory_total_bytes and result.memory_total_bytes > 0 and result.memory_used_bytes is not None:
            mem_pct = round(max(0.0, min(100.0, (result.memory_used_bytes / result.memory_total_bytes) * 100.0)), 1)
        db.execute(
            """
            INSERT INTO router_telemetry_history (
              id, business_id, router_id, cpu_load, memory_used_bytes, memory_total_bytes, memory_pct, active_hotspot_count, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                generate_id("rth"),
                str(row["business_id"]),
                router_id,
                result.cpu_load,
                result.memory_used_bytes,
                result.memory_total_bytes,
                mem_pct,
                result.active_hotspot_count,
                now_iso,
            ),
        )
        db.execute(
            """
            DELETE FROM router_telemetry_history
            WHERE router_id = ?
              AND id NOT IN (
                SELECT id FROM router_telemetry_history
                WHERE router_id = ?
                ORDER BY recorded_at DESC
                LIMIT 500
              )
            """,
            (router_id, router_id),
        )

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


def get_router_telemetry_history(
    db: DatabaseManager,
    business_id: str,
    router_id: str,
    hours: int = 24,
) -> dict[str, Any]:
    """Return 24-hour historical CPU load and memory usage telemetry for a specific router."""
    router = db.query_one(
        """
        SELECT id, business_id as businessId, name, host, api_port as apiPort, use_tls as useTls,
               router_os_family as routerOsFamily, status, cpu_load as cpuLoad,
               memory_used_bytes as memoryUsedBytes, memory_total_bytes as memoryTotalBytes,
               uptime, router_os_version as routerOsVersion, board_name as boardName,
               last_error as lastError, last_checked_at as lastCheckedAt
        FROM routers
        WHERE id = ? AND business_id = ?
        """,
        (router_id, business_id),
    )
    if not router:
        raise ValueError("Router not found")

    window_hours = max(1, min(168, int(hours)))
    cutoff_iso = (datetime.now(timezone.utc) - timedelta(hours=window_hours)).strftime("%Y-%m-%dT%H:%M:%SZ")

    raw_rows = db.query_all(
        """
        SELECT cpu_load as cpuLoad,
               memory_used_bytes as memoryUsedBytes,
               memory_total_bytes as memoryTotalBytes,
               memory_pct as memoryPct,
               active_hotspot_count as activeHotspotCount,
               recorded_at as recordedAt
        FROM router_telemetry_history
        WHERE business_id = ? AND router_id = ? AND recorded_at >= ?
        ORDER BY recorded_at ASC
        LIMIT 288
        """,
        (business_id, router_id, cutoff_iso),
    )

    samples: list[dict[str, Any]] = []
    cpu_values: list[int] = []
    mem_values: list[float] = []

    for row in raw_rows:
        rec_at = str(row.get("recordedAt") or "")
        label = rec_at[11:19] if len(rec_at) >= 19 else rec_at
        cpu_val = int(row["cpuLoad"]) if row.get("cpuLoad") is not None else None
        mem_used = int(row["memoryUsedBytes"]) if row.get("memoryUsedBytes") is not None else None
        mem_total = int(row["memoryTotalBytes"]) if row.get("memoryTotalBytes") is not None else None
        mem_pct = float(row["memoryPct"]) if row.get("memoryPct") is not None else None
        if mem_pct is None and mem_used is not None and mem_total and mem_total > 0:
            mem_pct = round(max(0.0, min(100.0, (mem_used / mem_total) * 100.0)), 1)

        if cpu_val is not None:
            cpu_values.append(cpu_val)
        if mem_pct is not None:
            mem_values.append(mem_pct)

        samples.append(
            {
                "recordedAt": rec_at,
                "label": label,
                "cpuLoad": cpu_val,
                "memoryPct": mem_pct,
                "memoryUsedMb": round(mem_used / (1024 * 1024), 1) if mem_used is not None else None,
                "memoryTotalMb": round(mem_total / (1024 * 1024), 1) if mem_total is not None else None,
                "activeHotspotCount": int(row.get("activeHotspotCount") or 0),
            }
        )

    latest = samples[-1] if samples else None
    summary = {
        "windowHours": window_hours,
        "sampleCount": len(samples),
        "latestCpuPct": latest["cpuLoad"] if latest else router.get("cpuLoad"),
        "avgCpuPct": round(sum(cpu_values) / len(cpu_values), 1) if cpu_values else None,
        "peakCpuPct": max(cpu_values) if cpu_values else None,
        "latestMemoryPct": latest["memoryPct"] if latest else None,
        "avgMemoryPct": round(sum(mem_values) / len(mem_values), 1) if mem_values else None,
        "peakMemoryPct": max(mem_values) if mem_values else None,
        "latestHotspotCount": latest["activeHotspotCount"] if latest else 0,
    }

    return {
        "router": router,
        "summary": summary,
        "samples": samples,
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


def parse_ip_scan_range(ip_range: str, max_hosts: int = 256) -> list[str]:
    """Parse CIDR (e.g. 192.168.88.0/24), IP range (192.168.88.1-20), or single IPv4 up to max_hosts."""
    raw = str(ip_range or "").strip()
    if not raw or len(raw) > 80:
        raise ValueError("Provide a valid IPv4 range or CIDR (for example 192.168.88.0/24).")

    candidates: list[ipaddress.IPv4Address] = []
    if "/" in raw:
        try:
            net = ipaddress.ip_network(raw, strict=False)
        except ValueError as exc:
            raise ValueError(f"Invalid CIDR subnet: {raw}") from exc
        if net.version != 4:
            raise ValueError("Only IPv4 ranges are supported for network scanning.")
        if net.num_addresses > max_hosts + 2:
            raise ValueError(f"IP range exceeds maximum {max_hosts}-host scan window (use /24 or smaller).")
        hosts = list(net.hosts())
        candidates = hosts if hosts else [net.network_address]
    elif "-" in raw:
        parts = [p.strip() for p in raw.split("-", 1)]
        if len(parts) != 2 or not parts[0] or not parts[1]:
            raise ValueError("Invalid IP range format (use e.g. 192.168.88.1-192.168.88.50).")
        try:
            start_ip = ipaddress.IPv4Address(parts[0])
        except ValueError as exc:
            raise ValueError(f"Invalid start IP: {parts[0]}") from exc
        if "." in parts[1]:
            try:
                end_ip = ipaddress.IPv4Address(parts[1])
            except ValueError as exc:
                raise ValueError(f"Invalid end IP: {parts[1]}") from exc
        else:
            if not parts[1].isdigit():
                raise ValueError(f"Invalid end octet: {parts[1]}")
            last_octet = int(parts[1])
            if not (0 <= last_octet <= 255):
                raise ValueError(f"End octet out of range (0-255): {parts[1]}")
            octets = parts[0].split(".")
            end_ip = ipaddress.IPv4Address(".".join([*octets[:3], str(last_octet)]))
        if int(end_ip) < int(start_ip):
            raise ValueError("End IP address must be greater than or equal to start IP address.")
        count = int(end_ip) - int(start_ip) + 1
        if count > max_hosts:
            raise ValueError(f"IP range exceeds maximum {max_hosts}-host scan window.")
        candidates = [ipaddress.IPv4Address(int(start_ip) + idx) for idx in range(count)]
    else:
        try:
            single = ipaddress.IPv4Address(raw)
        except ValueError as exc:
            raise ValueError(f"Invalid IPv4 address or CIDR: {raw}") from exc
        candidates = [single]

    filtered: list[str] = []
    for addr in candidates:
        addr_str = str(addr)
        if addr_str == "8.8.8.8":
            continue
        if addr.is_link_local or addr.is_multicast or addr.is_unspecified:
            continue
        filtered.append(addr_str)
    if not filtered:
        raise ValueError("No valid scannable IPv4 addresses in that range.")
    return filtered[:max_hosts]


def _parse_mndp_packet(payload: bytes) -> dict[str, str]:
    """Decode MikroTik Neighbor Discovery Protocol (MNDP UDP 5678) TLV fields."""
    if len(payload) < 4:
        return {}
    info: dict[str, str] = {}
    offset = 4
    while offset + 4 <= len(payload):
        tag = int.from_bytes(payload[offset : offset + 2], "big")
        length = int.from_bytes(payload[offset + 2 : offset + 4], "big")
        offset += 4
        if offset + length > len(payload):
            break
        val = payload[offset : offset + length]
        offset += length
        if tag == 1 and len(val) == 6:
            info["macAddress"] = ":".join(f"{b:02X}" for b in val)
        elif tag == 5:
            info["identity"] = val.decode("utf-8", errors="replace").strip("\x00 ")
        elif tag == 7:
            info["version"] = val.decode("utf-8", errors="replace").strip("\x00 ")
        elif tag == 8:
            info["platform"] = val.decode("utf-8", errors="replace").strip("\x00 ")
        elif tag == 12:
            info["boardName"] = val.decode("utf-8", errors="replace").strip("\x00 ")
        elif tag == 16:
            info["interfaceName"] = val.decode("utf-8", errors="replace").strip("\x00 ")
    return info


def _probe_mndp_hosts(hosts: list[str], mndp_port: int = 5678, listen_window: float = 0.25) -> dict[str, dict[str, str]]:
    """Send MNDP discovery datagrams and collect MikroTik Neighbor Discovery responses."""
    results: dict[str, dict[str, str]] = {}
    if not hosts or not (1 <= mndp_port <= 65535):
        return results
    sock: socket.socket | None = None
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.08)
        for ip in hosts:
            try:
                sock.sendto(b"\x00\x00\x00\x00", (ip, mndp_port))
            except OSError:
                continue
        deadline = time.perf_counter() + listen_window
        while time.perf_counter() < deadline:
            try:
                data, addr = sock.recvfrom(2048)
            except TimeoutError:
                break
            except OSError:
                break
            parsed = _parse_mndp_packet(data)
            if parsed:
                results[addr[0]] = parsed
    except OSError:
        return results
    finally:
        if sock is not None:
            try:
                sock.close()
            except OSError:
                pass
    return results


def _probe_routeros_api_host(
    host: str,
    ports: list[tuple[int, bool]],
    timeout: float = 0.35,
) -> dict[str, Any] | None:
    """Attempt fast TCP/TLS RouterOS binary API handshake on candidate port(s)."""
    for port, use_tls in ports:
        client = RouterOsClient()
        started = time.perf_counter()
        try:
            client.connect(host, port, use_tls=use_tls, timeout=timeout)
            rtt_ms = round((time.perf_counter() - started) * 1000.0, 2)
            api_verified = False
            try:
                assert client._sock is not None
                client._sock.settimeout(min(timeout, 0.3))
                client._sock.sendall(encode_sentence(["/login"]))
                sentence = client._read_sentence()
                if sentence and sentence[0] in ("!done", "!re", "!trap"):
                    api_verified = True
            except Exception:
                api_verified = False
            return {
                "host": host,
                "apiPort": port,
                "useTls": use_tls,
                "roundTripMs": rtt_ms,
                "apiVerified": api_verified,
            }
        except Exception:
            continue
        finally:
            client.close()
    return None


def scan_network_for_routers(
    db: DatabaseManager,
    business_id: str,
    ip_range: str,
    api_port: int = 8728,
    use_tls: bool = False,
    include_mndp: bool = True,
    mndp_port: int = 5678,
    timeout: float = 0.35,
) -> dict[str, Any]:
    """Scan an IPv4 subnet/range for MikroTik RouterOS API endpoints and MNDP neighbors."""
    started = time.perf_counter()
    hosts = parse_ip_scan_range(ip_range, max_hosts=256)

    existing_rows = db.query_all(
        "SELECT host, api_port as apiPort FROM routers WHERE business_id = ?",
        (business_id,),
    )
    existing_hosts = {str(r.get("host") or "").strip() for r in existing_rows if str(r.get("host") or "").strip()}

    probe_ports: list[tuple[int, bool]] = [(int(api_port), bool(use_tls))]
    if int(api_port) == 8728 and not use_tls:
        probe_ports.append((8729, True))

    mndp_map: dict[str, dict[str, str]] = {}
    if include_mndp:
        mndp_map = _probe_mndp_hosts(hosts, mndp_port=mndp_port, listen_window=min(0.28, max(0.15, timeout)))

    api_hits: dict[str, dict[str, Any]] = {}
    workers = min(24, max(1, len(hosts)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_probe_routeros_api_host, ip, probe_ports, timeout): ip for ip in hosts
        }
        for fut in concurrent.futures.as_completed(futures):
            res = fut.result()
            if res is not None:
                api_hits[str(res["host"])] = res

    discovered: list[dict[str, Any]] = []
    for ip in hosts:
        api_hit = api_hits.get(ip)
        mndp = mndp_map.get(ip)
        if not api_hit and not mndp:
            continue
        methods: list[str] = []
        if api_hit:
            methods.append("ROUTEROS_API_TLS" if api_hit["useTls"] else "ROUTEROS_API")
        if mndp:
            methods.append("MNDP")
        identity = (mndp or {}).get("identity") or None
        version = (mndp or {}).get("version") or None
        os_family = "ROUTEROS_V6" if version and version.startswith("6.") else "ROUTEROS_V7"
        discovered.append(
            {
                "host": ip,
                "apiPort": int(api_hit["apiPort"]) if api_hit else int(api_port),
                "useTls": bool(api_hit["useTls"]) if api_hit else bool(use_tls),
                "suggestedName": identity or f"MikroTik {ip}",
                "identity": identity,
                "boardName": (mndp or {}).get("boardName") or None,
                "routerOsVersion": version,
                "macAddress": (mndp or {}).get("macAddress") or None,
                "interfaceName": (mndp or {}).get("interfaceName") or None,
                "routerOsFamily": os_family,
                "discoveryMethods": methods,
                "apiVerified": bool(api_hit.get("apiVerified")) if api_hit else False,
                "roundTripMs": api_hit.get("roundTripMs") if api_hit else None,
                "alreadyAdded": ip in existing_hosts,
            }
        )

    duration_ms = round((time.perf_counter() - started) * 1000.0, 1)
    return {
        "ipRange": str(ip_range).strip(),
        "scannedHosts": len(hosts),
        "durationMs": duration_ms,
        "discovered": discovered,
    }


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


BULK_COMMAND_TYPES = {"UPDATE_SSID", "UPDATE_NTP", "SET_DNS_SERVERS", "SET_TIMEZONE"}
_SAFE_IFACE_RE = re.compile(r"^[A-Za-z0-9._:-]{1,64}$")
_SAFE_TIMEZONE_RE = re.compile(r"^[A-Za-z0-9_+/\-]{1,64}$")


def validate_bulk_command_payload(command_type: str, params: dict[str, Any]) -> dict[str, Any]:
    """Validate and normalize shared configuration command parameters for bulk RouterOS push."""
    ctype = str(command_type or "").strip().upper()
    if ctype not in BULK_COMMAND_TYPES:
        raise ValueError("Unsupported bulk command type.")

    if not isinstance(params, dict):
        raise ValueError("Command parameters must be a JSON object.")

    if ctype == "UPDATE_SSID":
        ssid = str(params.get("ssid") or "").strip()
        if not ssid or len(ssid) > 32 or any(ord(ch) < 32 or ord(ch) == 127 for ch in ssid):
            raise ValueError("SSID must be 1 to 32 printable characters without control characters.")
        iface_name = str(params.get("interfaceName") or "").strip()
        if iface_name and not _SAFE_IFACE_RE.fullmatch(iface_name):
            raise ValueError("Interface name contains invalid characters.")
        return {"ssid": ssid, "interfaceName": iface_name}

    if ctype == "UPDATE_NTP":
        primary = str(params.get("primaryServer") or "").strip()
        secondary = str(params.get("secondaryServer") or "").strip()
        enabled = bool(params.get("enabled", True))
        if not primary or len(primary) > 128 or not _SAFE_HOST_RE.fullmatch(primary):
            raise ValueError("Primary NTP server must be a valid hostname or IP address.")
        if secondary and (len(secondary) > 128 or not _SAFE_HOST_RE.fullmatch(secondary)):
            raise ValueError("Secondary NTP server must be a valid hostname or IP address.")
        return {"primaryServer": primary, "secondaryServer": secondary, "enabled": enabled}

    if ctype == "SET_DNS_SERVERS":
        raw_servers = str(params.get("servers") or "").strip()
        parts = [p.strip() for p in raw_servers.split(",") if p.strip()]
        if not parts or len(parts) > 4:
            raise ValueError("Provide 1 to 4 comma-separated IPv4/IPv6 DNS server addresses.")
        normalized: list[str] = []
        for item in parts:
            try:
                normalized.append(str(ipaddress.ip_address(item)))
            except ValueError as exc:
                raise ValueError(f"Invalid DNS server IP address: {item}") from exc
        allow_remote = bool(params.get("allowRemoteRequests", True))
        return {"servers": ",".join(normalized), "allowRemoteRequests": allow_remote}

    tz = str(params.get("timezone") or "").strip()
    if not tz or not _SAFE_TIMEZONE_RE.fullmatch(tz) or ".." in tz:
        raise ValueError("Provide a valid RouterOS timezone name (e.g. Africa/Dar_es_Salaam).")
    return {"timezone": tz}


def _execute_single_router_bulk_command(
    row: dict[str, Any],
    command_type: str,
    validated_params: dict[str, Any],
    timeout: float = 4.0,
) -> dict[str, Any]:
    rid = str(row["id"])
    rname = str(row.get("name") or rid)
    host = str(row.get("host") or "").strip()
    port = int(row.get("api_port") or 8728)
    use_tls = bool(row.get("use_tls"))
    username = str(row.get("username") or "").strip()
    enc_pass = str(row.get("password_encrypted") or "").strip()
    os_family = str(row.get("router_os_family") or "ROUTEROS_V7").strip().upper()

    base = {
        "routerId": rid,
        "routerName": rname,
        "host": host,
        "apiPort": port,
        "commandType": command_type,
    }

    if not host or not username or not enc_pass:
        return {
            **base,
            "success": False,
            "summary": None,
            "error": "No MikroTik router connected (credentials not configured).",
        }

    disallowed = _is_disallowed_probe_host(host)
    if disallowed:
        return {
            **base,
            "success": False,
            "summary": None,
            "error": disallowed,
        }

    client = RouterOsClient()
    try:
        password = decrypt_secret(enc_pass)
        client.connect(host, port, use_tls=use_tls, timeout=timeout)
        client.login(username, password)

        if command_type == "UPDATE_SSID":
            ssid = validated_params["ssid"]
            iface_filter = validated_params["interfaceName"]
            wireless_cmd = ["/interface/wireless/print"]
            if iface_filter:
                wireless_cmd.append(f"?name={iface_filter}")
            wireless_ifaces = client.command(wireless_cmd)

            updated_count = 0
            for iface in wireless_ifaces:
                if iface.get(".id"):
                    client.command(
                        ["/interface/wireless/set", f"=.id={iface['.id']}", f"=ssid={ssid}"]
                    )
                    updated_count += 1

            if updated_count == 0:
                wifi_cmd = ["/interface/wifi/print"]
                if iface_filter:
                    wifi_cmd.append(f"?name={iface_filter}")
                wifi_ifaces = client.command(wifi_cmd)
                for iface in wifi_ifaces:
                    if iface.get(".id"):
                        client.command(
                            ["/interface/wifi/set", f"=.id={iface['.id']}", f"=configuration.ssid={ssid}"]
                        )
                        updated_count += 1

            if updated_count == 0:
                return {
                    **base,
                    "success": False,
                    "summary": None,
                    "error": (
                        f"Wireless interface '{iface_filter}' not found on router."
                        if iface_filter
                        else "No wireless/wifi interfaces found on router."
                    ),
                }

            return {
                **base,
                "success": True,
                "summary": f"Updated SSID to '{ssid}' across {updated_count} wireless interface(s).",
                "error": None,
            }

        if command_type == "UPDATE_NTP":
            primary = validated_params["primaryServer"]
            secondary = validated_params["secondaryServer"]
            enabled_str = "yes" if validated_params["enabled"] else "no"
            if os_family == "ROUTEROS_V6":
                cmd = [
                    "/system/ntp/client/set",
                    f"=enabled={enabled_str}",
                    f"=primary-ntp={primary}",
                ]
                if secondary:
                    cmd.append(f"=secondary-ntp={secondary}")
                servers_label = f"{primary}, {secondary}" if secondary else primary
            else:
                servers_csv = f"{primary},{secondary}" if secondary else primary
                cmd = [
                    "/system/ntp/client/set",
                    f"=enabled={enabled_str}",
                    f"=servers={servers_csv}",
                ]
                servers_label = servers_csv
            client.command(cmd)
            return {
                **base,
                "success": True,
                "summary": f"NTP {'enabled' if validated_params['enabled'] else 'disabled'} ({servers_label}).",
                "error": None,
            }

        if command_type == "SET_DNS_SERVERS":
            servers_csv = validated_params["servers"]
            allow_remote = "yes" if validated_params["allowRemoteRequests"] else "no"
            client.command(
                [
                    "/ip/dns/set",
                    f"=servers={servers_csv}",
                    f"=allow-remote-requests={allow_remote}",
                ]
            )
            return {
                **base,
                "success": True,
                "summary": f"DNS servers updated to {servers_csv}.",
                "error": None,
            }

        tz = validated_params["timezone"]
        client.command(["/system/clock/set", f"=time-zone-name={tz}"])
        return {
            **base,
            "success": True,
            "summary": f"System timezone set to {tz}.",
            "error": None,
        }
    except Exception as exc:
        return {
            **base,
            "success": False,
            "summary": None,
            "error": str(exc) or f"Failed to push {command_type} to {host}:{port}",
        }
    finally:
        client.close()


def execute_bulk_router_command(
    router_rows: list[dict[str, Any]],
    command_type: str,
    params: dict[str, Any],
    timeout: float = 4.0,
) -> dict[str, Any]:
    """Push a validated shared configuration change simultaneously across selected routers."""
    ctype = str(command_type or "").strip().upper()
    validated = validate_bulk_command_payload(ctype, params)
    if not router_rows:
        raise ValueError("Select at least one router for bulk command execution.")

    results_by_id: dict[str, dict[str, Any]] = {}
    workers = min(12, max(1, len(router_rows)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(_execute_single_router_bulk_command, row, ctype, validated, timeout): str(row["id"])
            for row in router_rows
        }
        for fut in concurrent.futures.as_completed(future_map):
            rid = future_map[fut]
            try:
                results_by_id[rid] = fut.result()
            except Exception as exc:
                results_by_id[rid] = {
                    "routerId": rid,
                    "routerName": rid,
                    "host": "",
                    "apiPort": 8728,
                    "commandType": ctype,
                    "success": False,
                    "summary": None,
                    "error": str(exc) or "Unexpected bulk execution error",
                }

    ordered_results = [results_by_id[str(row["id"])] for row in router_rows]
    succeeded_count = sum(1 for item in ordered_results if item["success"])
    failed_count = len(ordered_results) - succeeded_count

    return {
        "commandType": ctype,
        "totalRequested": len(ordered_results),
        "succeededCount": succeeded_count,
        "failedCount": failed_count,
        "executedAt": utc_now_iso(),
        "results": ordered_results,
    }


def get_router_auto_sync_setting(db: DatabaseManager, business_id: str) -> dict[str, Any]:
    row = db.query_one(
        "SELECT id, auto_sync_profiles, updated_at FROM businesses WHERE id = ?",
        (business_id,),
    )
    if not row:
        raise ValueError("Business not found")
    return {
        "businessId": str(row["id"]),
        "autoSyncProfiles": bool(row.get("auto_sync_profiles")),
        "updatedAt": row.get("updated_at"),
    }


def set_router_auto_sync_setting(db: DatabaseManager, business_id: str, enabled: bool) -> dict[str, Any]:
    now_iso = utc_now_iso()
    updated_count = db.execute(
        "UPDATE businesses SET auto_sync_profiles = ?, updated_at = ? WHERE id = ?",
        (1 if enabled else 0, now_iso, business_id),
    )
    if updated_count == 0:
        raise ValueError("Business not found")
    return {
        "businessId": business_id,
        "autoSyncProfiles": bool(enabled),
        "updatedAt": now_iso,
    }


def auto_sync_package_profile_to_routers(
    db: DatabaseManager,
    business_id: str,
    package_row: dict[str, Any],
) -> dict[str, Any]:
    """Automatically push a package's hotspot profile to configured tenant MikroTik routers if enabled."""
    setting = get_router_auto_sync_setting(db, business_id)
    if not setting["autoSyncProfiles"]:
        return {
            "enabled": False,
            "synced": 0,
            "failed": 0,
            "skipped": 0,
            "results": [],
        }

    all_routers = db.query_all(
        "SELECT id, name, host, username, password_encrypted FROM routers WHERE business_id = ? ORDER BY created_at ASC",
        (business_id,),
    )
    configured = [
        r
        for r in all_routers
        if str(r.get("host") or "").strip()
        and str(r.get("host") or "").strip() != "8.8.8.8"
        and str(r.get("username") or "").strip()
        and str(r.get("password_encrypted") or "").strip()
    ]
    skipped_count = len(all_routers) - len(configured)

    if not configured:
        return {
            "enabled": True,
            "synced": 0,
            "failed": 0,
            "skipped": skipped_count,
            "results": [],
        }

    profile_name = f"trax-{package_row['id']}"
    dl_kbps = int(package_row.get("download_kbps") or package_row.get("downloadKbps") or 1000)
    ul_kbps = int(package_row.get("upload_kbps") or package_row.get("uploadKbps") or 1000)

    results_by_id: dict[str, dict[str, Any]] = {}
    workers = min(8, max(1, len(configured)))
    with concurrent.futures.ThreadPoolExecutor(max_workers=workers) as pool:
        future_map = {
            pool.submit(push_hotspot_profile_to_router, db, str(r["id"]), profile_name, dl_kbps, ul_kbps): r
            for r in configured
        }
        for fut in concurrent.futures.as_completed(future_map):
            r = future_map[fut]
            rid = str(r["id"])
            try:
                res = fut.result()
                results_by_id[rid] = {
                    "routerId": rid,
                    "routerName": str(r.get("name") or rid),
                    "synced": bool(res.get("synced")),
                    "message": str(res.get("message") or ""),
                }
            except Exception as exc:
                results_by_id[rid] = {
                    "routerId": rid,
                    "routerName": str(r.get("name") or rid),
                    "synced": False,
                    "message": str(exc) or "Profile sync failed",
                }

    ordered = [results_by_id[str(r["id"])] for r in configured]
    synced_count = sum(1 for item in ordered if item["synced"])
    failed_count = len(ordered) - synced_count
    return {
        "enabled": True,
        "synced": synced_count,
        "failed": failed_count,
        "skipped": skipped_count,
        "results": ordered,
    }


def validate_wifi_gateway_ip(raw_ip: str) -> str:
    ip_str = (raw_ip or "").strip()
    if not ip_str:
        return ""
    if ip_str == "8.8.8.8":
        raise ValueError("8.8.8.8 is a public DNS IP and cannot be used as a WiFi gateway.")
    try:
        addr = ipaddress.ip_address(ip_str)
    except ValueError as exc:
        raise ValueError("Gateway IP must be a valid IPv4 address (e.g. 192.168.88.1 or 192.168.8.1).") from exc
    if addr.version != 4 or addr.is_multicast or addr.is_link_local or addr.is_unspecified:
        raise ValueError("Gateway IP must be a valid unicast IPv4 address and not a link-local metadata IP.")
    return str(addr)


def probe_wifi_gateway(gateway_ip: str, ports: tuple[int, ...] = (80, 443, 8728), timeout: float = 0.8) -> dict[str, Any]:
    ip_str = validate_wifi_gateway_ip(gateway_ip)
    if not ip_str:
        return {"reachable": False, "port": None, "roundTripMs": None, "error": "No gateway IP configured"}
    last_err = "Gateway did not respond on local ports"
    for port in ports:
        started = time.perf_counter()
        try:
            with socket.create_connection((ip_str, port), timeout=timeout):
                rtt_ms = round((time.perf_counter() - started) * 1000.0, 2)
                return {"reachable": True, "port": port, "roundTripMs": rtt_ms, "error": None}
        except OSError as exc:
            last_err = str(exc) or last_err
    return {"reachable": False, "port": None, "roundTripMs": None, "error": last_err}

