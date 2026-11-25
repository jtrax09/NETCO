#!/usr/bin/env bash
set -euo pipefail

BACKUP_DIR="${1:-./backups}"
mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d_%H%M%S)"

if [ -f "./data/netco.db" ]; then
  sqlite3 "./data/netco.db" ".backup ${BACKUP_DIR}/traxlink_sqlite_${STAMP}.db"
  echo "SQLite backup written to ${BACKUP_DIR}/traxlink_sqlite_${STAMP}.db"
fi

if [ -n "${DATABASE_URL:-}" ] && command -v pg_dump >/dev/null 2>&1; then
  pg_dump "$DATABASE_URL" -F c -f "${BACKUP_DIR}/traxlink_pg_${STAMP}.dump"
  echo "PostgreSQL backup written to ${BACKUP_DIR}/traxlink_pg_${STAMP}.dump"
fi
