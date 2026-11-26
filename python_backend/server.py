"""Standalone & embedded HTTP server runner + background expiry/provisioning worker."""

from __future__ import annotations

import threading
import time
from http.server import ThreadingHTTPServer
from typing import Callable

from .config import get_env, load_dotenv
from .db import DatabaseManager, ensure_primary_staff_accounts, expire_stale_records
from .rate_limit import RateLimiter
from .services.billing import process_due_provisioning_jobs


class TraxHttpServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def create_http_server(
    host: str = "127.0.0.1",
    port: int = 8001,
    db_path: str | None = None,
    event_callback: Callable[[str, dict], None] | None = None,
    seed_primary_staff: bool = True,
) -> tuple[TraxHttpServer, DatabaseManager]:
    from .app import make_handler_class

    load_dotenv()
    db = DatabaseManager(db_path=db_path)
    if seed_primary_staff:
        ensure_primary_staff_accounts(db)
    started_at = time.monotonic()

    auth_limiter = RateLimiter(window_seconds=60, max_requests=30)
    portal_limiter = RateLimiter(window_seconds=60, max_requests=35)
    handler_cls = make_handler_class(
        db=db,
        started_at=started_at,
        auth_limiter=auth_limiter,
        portal_limiter=portal_limiter,
        event_callback=event_callback,
    )
    httpd = TraxHttpServer((host, port), handler_cls)
    return httpd, db


def start_background_worker(
    db: DatabaseManager,
    stop_event: threading.Event,
    event_callback: Callable[[str, dict], None] | None = None,
    interval_seconds: int = 30,
) -> threading.Thread:
    def _loop() -> None:
        while not stop_event.wait(interval_seconds):
            try:
                res = expire_stale_records(db)
                if (res["expiredSessions"] > 0 or res["expiredSubscriptions"] > 0) and event_callback:
                    event_callback(
                        "session:ended",
                        {
                            "expiredCount": res["expiredSessions"],
                            "expiredSubscriptions": res["expiredSubscriptions"],
                        },
                    )
                process_due_provisioning_jobs(db, limit=10)
            except Exception as exc:
                print(f"[TRAX LINK Python Worker] Sweep error: {exc}", flush=True)

    thread = threading.Thread(target=_loop, name="traxlink-billing-worker", daemon=True)
    thread.start()
    return thread


def run_server(
    host: str | None = None,
    port: int | None = None,
    db_path: str | None = None,
    seed_primary_staff: bool = True,
) -> None:
    load_dotenv()
    bind_host = host or get_env("PYTHON_API_HOST", "127.0.0.1")
    bind_port = port if port is not None else int(get_env("PYTHON_API_PORT") or get_env("PORT") or "8001")

    httpd, db = create_http_server(
        host=bind_host,
        port=bind_port,
        db_path=db_path,
        seed_primary_staff=seed_primary_staff,
    )
    stop_event = threading.Event()
    start_background_worker(db, stop_event)

    print(f"TRAX LINK Python WiFi Billing API listening on http://{bind_host}:{httpd.server_address[1]}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        stop_event.set()
        httpd.shutdown()
        httpd.server_close()
        db.close()
