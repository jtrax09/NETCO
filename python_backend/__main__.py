"""CLI entry point: python3 -m python_backend [--host 127.0.0.1] [--port 8001]."""

from __future__ import annotations

import argparse

from .server import run_server


def main() -> None:
    parser = argparse.ArgumentParser(description="TRAX LINK Python WiFi Billing & Network Engine")
    parser.add_argument("--host", default=None, help="Bind host (default: PYTHON_API_HOST or 127.0.0.1)")
    parser.add_argument("--port", type=int, default=None, help="Bind port (default: PYTHON_API_PORT or 8001)")
    parser.add_argument("--db", default=None, help="SQLite database path")
    parser.add_argument("--no-seed-staff", action="store_true", help="Skip seeding default staff accounts")
    args = parser.parse_args()
    run_server(
        host=args.host,
        port=args.port,
        db_path=args.db,
        seed_primary_staff=not args.no_seed_staff,
    )


if __name__ == "__main__":
    main()
