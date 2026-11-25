#!/usr/bin/env bash
set -euo pipefail

BACKUP_FILE="${1:?Usage: ./scripts/restore.sh <backup-file>}"

if [[ "$BACKUP_FILE" == *.db ]]; then
  mkdir -p ./data
  sqlite3 "./data/netco.db" ".restore '${BACKUP_FILE}'"
  echo "SQLite database restored from ${BACKUP_FILE}"
elif [[ "$BACKUP_FILE" == *.dump ]]; then
  : "${DATABASE_URL:?DATABASE_URL must be set to restore PostgreSQL dumps}"
  pg_restore -d "$DATABASE_URL" --clean --if-exists "$BACKUP_FILE"
  echo "PostgreSQL database restored from ${BACKUP_FILE}"
else
  echo "Unsupported backup extension: ${BACKUP_FILE}" >&2
  exit 1
fi
