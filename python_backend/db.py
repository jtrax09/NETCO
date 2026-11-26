"""SQLite database initialization, migrations, and lifecycle sweeps for TRAX LINK Python backend."""

from __future__ import annotations

import json
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, TypeVar

from .config import ROOT_DIR, get_env
from .security import generate_id, generate_reference, hash_password

DEFAULT_BUSINESS_ID = "biz_trax_default"
DEFAULT_LOCATION_ID = "loc_trax_default"

DEFAULT_STAFF_ACCOUNTS = [
    {"email": "undergodmusic255@gmail.com", "fullName": "UNDER GOD MUSIC", "code": "STF-001"},
    {"email": "mlingwajastine277@gmail.com", "fullName": "TRAX LINK Platform Admin", "code": "STF-002"},
]
DEFAULT_STAFF_PASSWORD_HASH = (
    "scrypt:5eda2d3d4bca4af575be144081e79c08:"
    "a17d12d23968499072b046c640d4264ff370ed1d9c407ab777a1820f7074d337"
    "d4096e4b269d82ef71b2c0e0a7e9f682a75fe4946cdb153522195eccd615fe00"
)

T = TypeVar("T")


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso_dt(value: str) -> datetime:
    cleaned = value.strip()
    if cleaned.endswith("Z"):
        cleaned = cleaned[:-1] + "+00:00"
    dt = datetime.fromisoformat(cleaned)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


class DatabaseManager:
    """Thread-safe SQLite connection manager with explicit BEGIN IMMEDIATE transactions."""

    def __init__(self, db_path: str | None = None):
        raw_path = db_path or get_env("SQLITE_DB_PATH") or str(ROOT_DIR / "data" / "netco.db")
        self.db_path = raw_path
        if raw_path != ":memory:":
            Path(raw_path).parent.mkdir(parents=True, exist_ok=True)

        self.lock = threading.RLock()
        self.conn = sqlite3.connect(
            raw_path,
            check_same_thread=False,
            isolation_level=None,  # Explicit transaction control (BEGIN IMMEDIATE)
            timeout=10.0,
        )
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode = WAL;")
        self.conn.execute("PRAGMA foreign_keys = ON;")
        self.conn.execute("PRAGMA busy_timeout = 5000;")
        self._init_schema()

    def close(self) -> None:
        with self.lock:
            self.conn.close()

    def query_all(self, sql: str, params: tuple[Any, ...] = ()) -> list[dict[str, Any]]:
        with self.lock:
            cur = self.conn.execute(sql, params)
            return [dict(row) for row in cur.fetchall()]

    def query_one(self, sql: str, params: tuple[Any, ...] = ()) -> dict[str, Any] | None:
        with self.lock:
            cur = self.conn.execute(sql, params)
            row = cur.fetchone()
            return dict(row) if row is not None else None

    def execute(self, sql: str, params: tuple[Any, ...] = ()) -> int:
        with self.lock:
            cur = self.conn.execute(sql, params)
            return cur.rowcount

    def transaction(self, fn: Callable[[sqlite3.Connection], T]) -> T:
        with self.lock:
            self.conn.execute("BEGIN IMMEDIATE")
            try:
                result = fn(self.conn)
                self.conn.execute("COMMIT")
                return result
            except Exception:
                self.conn.execute("ROLLBACK")
                raise

    def _has_column(self, table: str, column: str) -> bool:
        cols = self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(row["name"] == column for row in cols)

    def _get_table_sql(self, table: str) -> str:
        row = self.conn.execute(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?", (table,)
        ).fetchone()
        return str(row["sql"]) if row and row["sql"] else ""

    def _init_schema(self) -> None:
        with self.lock:
            self.conn.executescript(
                f"""
                CREATE TABLE IF NOT EXISTS saas_plans (
                  id TEXT PRIMARY KEY,
                  code TEXT NOT NULL UNIQUE,
                  name TEXT NOT NULL,
                  price_monthly_tzs INTEGER NOT NULL DEFAULT 0,
                  price_yearly_tzs INTEGER NOT NULL DEFAULT 0,
                  max_routers INTEGER NOT NULL DEFAULT 2,
                  max_locations INTEGER NOT NULL DEFAULT 1,
                  max_active_customers INTEGER NOT NULL DEFAULT 200,
                  commission_bps INTEGER NOT NULL DEFAULT 0,
                  features_json TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS businesses (
                  id TEXT PRIMARY KEY,
                  name TEXT NOT NULL,
                  slug TEXT NOT NULL UNIQUE,
                  email TEXT NOT NULL,
                  phone TEXT NOT NULL,
                  country TEXT NOT NULL DEFAULT 'Tanzania',
                  currency TEXT NOT NULL DEFAULT 'TZS',
                  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('PENDING','ACTIVE','SUSPENDED')),
                  timezone TEXT NOT NULL DEFAULT 'Africa/Dar_es_Salaam',
                  hotspot_title TEXT,
                  hotspot_support_phone TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS saas_subscriptions (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
                  plan_id TEXT NOT NULL REFERENCES saas_plans(id) ON DELETE RESTRICT,
                  status TEXT NOT NULL DEFAULT 'TRIAL' CHECK(status IN ('TRIAL','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED')),
                  billing_cycle TEXT NOT NULL DEFAULT 'MONTHLY' CHECK(billing_cycle IN ('MONTHLY','YEARLY')),
                  current_period_start TEXT NOT NULL,
                  current_period_end TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS saas_payments (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
                  saas_subscription_id TEXT NOT NULL REFERENCES saas_subscriptions(id) ON DELETE CASCADE,
                  reference TEXT NOT NULL UNIQUE,
                  amount_tzs INTEGER NOT NULL CHECK(amount_tzs >= 0),
                  provider TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','FAILED','REFUNDED')),
                  paid_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS locations (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  region TEXT NOT NULL DEFAULT 'Dar es Salaam',
                  address TEXT,
                  contact_name TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(business_id, name)
                );

                CREATE TABLE IF NOT EXISTS admin_users (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  firebase_uid TEXT UNIQUE,
                  email TEXT NOT NULL UNIQUE,
                  full_name TEXT NOT NULL,
                  password_hash TEXT,
                  role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(role IN ('SUPER_ADMIN','BUSINESS_OWNER','ADMIN','ACCOUNTANT','NETWORK_OPERATOR','SUPPORT_STAFF','CASHIER')),
                  is_active INTEGER NOT NULL DEFAULT 1,
                  last_login_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS staff (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  admin_user_id TEXT NOT NULL UNIQUE REFERENCES admin_users(id) ON DELETE CASCADE,
                  staff_code TEXT NOT NULL UNIQUE,
                  department TEXT NOT NULL,
                  phone TEXT,
                  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','BUSINESS_OWNER','ADMIN','ACCOUNTANT','NETWORK_OPERATOR','SUPPORT_STAFF','CASHIER')),
                  is_suspended INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS staff_sessions (
                  id TEXT PRIMARY KEY,
                  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
                  token_hash TEXT NOT NULL UNIQUE,
                  ip_address TEXT,
                  user_agent TEXT,
                  expires_at TEXT NOT NULL,
                  revoked_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS password_reset_tokens (
                  id TEXT PRIMARY KEY,
                  admin_user_id TEXT NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
                  token_hash TEXT NOT NULL UNIQUE,
                  expires_at TEXT NOT NULL,
                  used_at TEXT,
                  requested_ip TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS packages (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  location_id TEXT,
                  name TEXT NOT NULL,
                  description TEXT,
                  category TEXT NOT NULL CHECK(category IN ('HOURLY','DAILY','WEEKLY','MONTHLY')),
                  package_type TEXT NOT NULL DEFAULT 'TIME_BASED' CHECK(package_type IN ('TIME_BASED','DATA_BASED','HYBRID','BANDWIDTH_PROFILE')),
                  price_tzs INTEGER NOT NULL CHECK(price_tzs >= 0),
                  currency TEXT NOT NULL DEFAULT 'TZS',
                  duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
                  download_kbps INTEGER NOT NULL CHECK(download_kbps > 0),
                  upload_kbps INTEGER NOT NULL CHECK(upload_kbps > 0),
                  data_limit_mb INTEGER,
                  device_limit INTEGER NOT NULL DEFAULT 1,
                  simultaneous_sessions INTEGER NOT NULL DEFAULT 1,
                  fup_policy TEXT,
                  validity_days INTEGER NOT NULL DEFAULT 30,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(business_id, name)
                );

                CREATE TABLE IF NOT EXISTS customers (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  customer_code TEXT NOT NULL UNIQUE,
                  full_name TEXT NOT NULL,
                  phone TEXT NOT NULL,
                  email TEXT,
                  notes TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  package_id TEXT REFERENCES packages(id) ON DELETE SET NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS devices (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  device_fingerprint TEXT NOT NULL UNIQUE,
                  mac_address TEXT,
                  user_agent TEXT,
                  device_label TEXT,
                  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
                  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
                  last_seen_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS routers (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  location_id TEXT,
                  name TEXT NOT NULL,
                  host TEXT NOT NULL,
                  api_port INTEGER NOT NULL DEFAULT 8728,
                  use_tls INTEGER NOT NULL DEFAULT 0,
                  username TEXT NOT NULL,
                  password_encrypted TEXT NOT NULL,
                  hotspot_server TEXT NOT NULL DEFAULT '',
                  router_os_family TEXT NOT NULL DEFAULT 'ROUTEROS_V7',
                  wireguard_pubkey TEXT,
                  wireguard_endpoint TEXT,
                  radius_secret TEXT,
                  status TEXT NOT NULL DEFAULT 'NOT_CONNECTED' CHECK(status IN ('CONNECTED','NOT_CONNECTED','ERROR')),
                  cpu_load INTEGER,
                  memory_used_bytes INTEGER,
                  memory_total_bytes INTEGER,
                  uptime TEXT,
                  router_os_version TEXT,
                  board_name TEXT,
                  last_error TEXT,
                  last_checked_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(business_id, name),
                  UNIQUE(business_id, host, api_port)
                );

                CREATE TABLE IF NOT EXISTS router_interfaces (
                  id TEXT PRIMARY KEY,
                  router_id TEXT NOT NULL REFERENCES routers(id) ON DELETE CASCADE,
                  name TEXT NOT NULL,
                  type TEXT NOT NULL,
                  running INTEGER NOT NULL DEFAULT 0,
                  disabled INTEGER NOT NULL DEFAULT 0,
                  rx_bytes INTEGER NOT NULL DEFAULT 0,
                  tx_bytes INTEGER NOT NULL DEFAULT 0,
                  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(router_id, name)
                );

                CREATE TABLE IF NOT EXISTS vouchers (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  code_hash TEXT NOT NULL UNIQUE,
                  code_encrypted TEXT NOT NULL,
                  code_masked TEXT NOT NULL,
                  batch_id TEXT,
                  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
                  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
                  status TEXT NOT NULL DEFAULT 'UNUSED' CHECK(status IN ('UNUSED','ACTIVE','EXPIRED','REVOKED')),
                  bound_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
                  bound_device_name TEXT,
                  is_test INTEGER NOT NULL DEFAULT 0,
                  test_note TEXT,
                  activated_at TEXT,
                  expires_at TEXT,
                  revoked_at TEXT,
                  revoked_reason TEXT,
                  created_by_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS voucher_redemptions (
                  id TEXT PRIMARY KEY,
                  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
                  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                  ip_address TEXT,
                  success INTEGER NOT NULL,
                  reason TEXT,
                  redeemed_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS sessions (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  session_token TEXT NOT NULL UNIQUE,
                  voucher_id TEXT NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
                  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
                  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
                  router_id TEXT REFERENCES routers(id) ON DELETE SET NULL,
                  ip_address TEXT,
                  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('ACTIVE','EXPIRED','TERMINATED')),
                  bytes_in INTEGER NOT NULL DEFAULT 0,
                  bytes_out INTEGER NOT NULL DEFAULT 0,
                  started_at TEXT NOT NULL DEFAULT (datetime('now')),
                  expires_at TEXT NOT NULL,
                  ended_at TEXT,
                  end_reason TEXT
                );

                CREATE TABLE IF NOT EXISTS payments (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  reference TEXT NOT NULL UNIQUE,
                  receipt_number TEXT UNIQUE,
                  provider TEXT NOT NULL CHECK(provider IN ('MPESA','AIRTEL_MONEY','TIGO_PESA','HALOPESA','CASH_DESK','CARD')),
                  phone_number TEXT NOT NULL,
                  amount_tzs INTEGER NOT NULL CHECK(amount_tzs >= 0),
                  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','FAILED','REFUNDED')),
                  is_test INTEGER NOT NULL DEFAULT 0,
                  payment_mode TEXT NOT NULL DEFAULT 'GATEWAY',
                  external_tx_id TEXT UNIQUE,
                  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
                  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
                  voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
                  provider_payload TEXT,
                  verified_at TEXT,
                  refunded_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS subscriptions (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
                  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
                  package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
                  payment_id TEXT REFERENCES payments(id) ON DELETE SET NULL,
                  voucher_id TEXT REFERENCES vouchers(id) ON DELETE SET NULL,
                  radius_username TEXT NOT NULL UNIQUE,
                  status TEXT NOT NULL DEFAULT 'PENDING_PROVISIONING' CHECK(status IN ('PENDING_PROVISIONING','ACTIVE','EXPIRED','SUSPENDED')),
                  provisioning_status TEXT NOT NULL DEFAULT 'PENDING' CHECK(provisioning_status IN ('PENDING','STANDALONE','PROVISIONED','FAILED_RETRYING')),
                  download_kbps INTEGER NOT NULL,
                  upload_kbps INTEGER NOT NULL,
                  data_limit_mb INTEGER,
                  starts_at TEXT NOT NULL,
                  expires_at TEXT NOT NULL,
                  revoked_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS provisioning_jobs (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  subscription_id TEXT NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
                  router_id TEXT REFERENCES routers(id) ON DELETE SET NULL,
                  action TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROVISIONED','FAILED_RETRYING','COMPLETED','CANCELLED')),
                  attempts INTEGER NOT NULL DEFAULT 0,
                  max_attempts INTEGER NOT NULL DEFAULT 5,
                  last_error TEXT,
                  next_retry_at TEXT,
                  completed_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS radcheck (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  username TEXT NOT NULL,
                  attribute TEXT NOT NULL,
                  op TEXT NOT NULL DEFAULT ':=',
                  value TEXT NOT NULL,
                  expires_at TEXT,
                  is_active INTEGER NOT NULL DEFAULT 1,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(business_id, username, attribute)
                );

                CREATE TABLE IF NOT EXISTS radreply (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  username TEXT NOT NULL,
                  attribute TEXT NOT NULL,
                  op TEXT NOT NULL DEFAULT ':=',
                  value TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(business_id, username, attribute)
                );

                CREATE TABLE IF NOT EXISTS radacct (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  acct_session_id TEXT NOT NULL UNIQUE,
                  username TEXT NOT NULL,
                  nas_ip_address TEXT,
                  framed_ip_address TEXT,
                  calling_station_id TEXT,
                  acct_input_octets INTEGER NOT NULL DEFAULT 0,
                  acct_output_octets INTEGER NOT NULL DEFAULT 0,
                  acct_session_time INTEGER NOT NULL DEFAULT 0,
                  acct_start_time TEXT NOT NULL DEFAULT (datetime('now')),
                  acct_stop_time TEXT,
                  terminate_cause TEXT
                );

                CREATE TABLE IF NOT EXISTS invoices (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
                  invoice_number TEXT NOT NULL UNIQUE,
                  ledger_type TEXT NOT NULL DEFAULT 'WIFI' CHECK(ledger_type IN ('WIFI','SAAS')),
                  payment_id TEXT,
                  payment_reference TEXT NOT NULL,
                  customer_name TEXT,
                  phone_number TEXT,
                  item_description TEXT NOT NULL,
                  subtotal_tzs INTEGER NOT NULL DEFAULT 0,
                  tax_tzs INTEGER NOT NULL DEFAULT 0,
                  total_tzs INTEGER NOT NULL DEFAULT 0,
                  currency TEXT NOT NULL DEFAULT 'TZS',
                  is_test INTEGER NOT NULL DEFAULT 0,
                  status TEXT NOT NULL DEFAULT 'PAID' CHECK(status IN ('ISSUED','PAID','VOID','REFUNDED')),
                  issued_at TEXT NOT NULL,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS coa_disconnect_logs (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
                  nas_ip TEXT NOT NULL,
                  username TEXT NOT NULL,
                  acct_session_id TEXT,
                  success INTEGER NOT NULL DEFAULT 0,
                  response_detail TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS support_tickets (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
                  customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
                  phone TEXT NOT NULL,
                  subject TEXT NOT NULL,
                  message TEXT NOT NULL,
                  status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','IN_PROGRESS','RESOLVED')),
                  reply TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS webhook_events (
                  id TEXT PRIMARY KEY,
                  provider TEXT NOT NULL,
                  external_event_id TEXT NOT NULL,
                  payment_reference TEXT,
                  payload TEXT NOT NULL,
                  received_at TEXT NOT NULL DEFAULT (datetime('now')),
                  UNIQUE(provider, external_event_id)
                );

                CREATE TABLE IF NOT EXISTS network_usage (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  router_id TEXT REFERENCES routers(id) ON DELETE SET NULL,
                  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
                  rx_bytes INTEGER NOT NULL DEFAULT 0,
                  tx_bytes INTEGER NOT NULL DEFAULT 0,
                  recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS notifications (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  type TEXT NOT NULL,
                  severity TEXT NOT NULL DEFAULT 'INFO',
                  title TEXT NOT NULL,
                  message TEXT NOT NULL,
                  metadata TEXT,
                  is_read INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS audit_logs (
                  id TEXT PRIMARY KEY,
                  business_id TEXT,
                  actor_id TEXT REFERENCES admin_users(id) ON DELETE SET NULL,
                  actor_email TEXT NOT NULL,
                  actor_role TEXT NOT NULL,
                  action TEXT NOT NULL,
                  entity_type TEXT NOT NULL,
                  entity_id TEXT,
                  ip_address TEXT,
                  details TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS system_settings (
                  key TEXT PRIMARY KEY,
                  value TEXT NOT NULL,
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );

                CREATE TABLE IF NOT EXISTS schema_migrations (
                  id TEXT PRIMARY KEY,
                  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                """
            )

            self._run_migrations()

            self.conn.executescript(
                """
                CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
                CREATE INDEX IF NOT EXISTS idx_vouchers_business_status ON vouchers(business_id, status);
                CREATE INDEX IF NOT EXISTS idx_vouchers_package ON vouchers(package_id);
                CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions(status, expires_at);
                CREATE INDEX IF NOT EXISTS idx_sessions_business_status ON sessions(business_id, status, expires_at);
                CREATE INDEX IF NOT EXISTS idx_sessions_voucher_status ON sessions(voucher_id, status);
                CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
                CREATE INDEX IF NOT EXISTS idx_payments_business_status ON payments(business_id, status, created_at);
                CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
                CREATE INDEX IF NOT EXISTS idx_customers_business ON customers(business_id, is_active);
                CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(business_id, is_read, created_at);
                CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(business_id, action, created_at);
                CREATE INDEX IF NOT EXISTS idx_subscriptions_biz_status ON subscriptions(business_id, status, expires_at);
                CREATE INDEX IF NOT EXISTS idx_prov_jobs_due ON provisioning_jobs(status, next_retry_at);
                CREATE INDEX IF NOT EXISTS idx_radcheck_user ON radcheck(username, is_active);
                CREATE INDEX IF NOT EXISTS idx_invoices_biz_issued ON invoices(business_id, issued_at);
                """
            )

    def _run_migrations(self) -> None:
        now_iso = utc_now_iso()

        if not self._has_column("vouchers", "is_test"):
            self.conn.execute("ALTER TABLE vouchers ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;")
        if not self._has_column("vouchers", "test_note"):
            self.conn.execute("ALTER TABLE vouchers ADD COLUMN test_note TEXT;")
        if not self._has_column("payments", "is_test"):
            self.conn.execute("ALTER TABLE payments ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;")
        if not self._has_column("payments", "payment_mode"):
            self.conn.execute("ALTER TABLE payments ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'GATEWAY';")
        if not self._has_column("vouchers", "bound_device_name"):
            self.conn.execute("ALTER TABLE vouchers ADD COLUMN bound_device_name TEXT;")

        for tbl in (
            "admin_users",
            "staff",
            "customers",
            "devices",
            "vouchers",
            "sessions",
            "payments",
            "network_usage",
            "notifications",
            "audit_logs",
        ):
            if not self._has_column(tbl, "business_id"):
                def_clause = "" if tbl == "audit_logs" else f" NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}'"
                self.conn.execute(f"ALTER TABLE {tbl} ADD COLUMN business_id TEXT{def_clause};")

        admin_sql = self._get_table_sql("admin_users")
        if admin_sql and "BUSINESS_OWNER" not in admin_sql:
            self.conn.execute("PRAGMA foreign_keys = OFF;")
            self.conn.executescript(
                f"""
                CREATE TABLE admin_users_new (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  firebase_uid TEXT UNIQUE,
                  email TEXT NOT NULL UNIQUE,
                  full_name TEXT NOT NULL,
                  password_hash TEXT,
                  role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(role IN ('SUPER_ADMIN','BUSINESS_OWNER','ADMIN','ACCOUNTANT','NETWORK_OPERATOR','SUPPORT_STAFF','CASHIER')),
                  is_active INTEGER NOT NULL DEFAULT 1,
                  last_login_at TEXT,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO admin_users_new (id, business_id, firebase_uid, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at)
                SELECT id, COALESCE(business_id, '{DEFAULT_BUSINESS_ID}'), firebase_uid, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at FROM admin_users;
                DROP TABLE admin_users;
                ALTER TABLE admin_users_new RENAME TO admin_users;

                CREATE TABLE staff_new (
                  id TEXT PRIMARY KEY,
                  business_id TEXT NOT NULL DEFAULT '{DEFAULT_BUSINESS_ID}',
                  admin_user_id TEXT NOT NULL UNIQUE REFERENCES admin_users(id) ON DELETE CASCADE,
                  staff_code TEXT NOT NULL UNIQUE,
                  department TEXT NOT NULL,
                  phone TEXT,
                  role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','BUSINESS_OWNER','ADMIN','ACCOUNTANT','NETWORK_OPERATOR','SUPPORT_STAFF','CASHIER')),
                  is_suspended INTEGER NOT NULL DEFAULT 0,
                  created_at TEXT NOT NULL DEFAULT (datetime('now')),
                  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
                );
                INSERT INTO staff_new (id, business_id, admin_user_id, staff_code, department, phone, role, is_suspended, created_at, updated_at)
                SELECT id, COALESCE(business_id, '{DEFAULT_BUSINESS_ID}'), admin_user_id, staff_code, department, phone, role, is_suspended, created_at, updated_at FROM staff;
                DROP TABLE staff;
                ALTER TABLE staff_new RENAME TO staff;
                """
            )
            self.conn.execute("PRAGMA foreign_keys = ON;")

        self._seed_saas_defaults(now_iso)

        for mig_id in (
            "001_standalone_mode_and_test_tokens",
            "002_single_use_device_name_lock",
            "003_trax_link_multitenant_saas",
            "004_python_real_wifi_billing_invoices",
        ):
            exists = self.conn.execute("SELECT id FROM schema_migrations WHERE id = ?", (mig_id,)).fetchone()
            if not exists:
                self.conn.execute(
                    "INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)",
                    (mig_id, now_iso),
                )

        default_mode = "MIKROTIK_MODE" if get_env("NETCO_MODE") == "MIKROTIK_MODE" else "STANDALONE_MODE"
        self.conn.execute(
            "INSERT OR IGNORE INTO system_settings (key, value, updated_at) VALUES ('operating_mode', ?, ?)",
            (default_mode, now_iso),
        )

    def _seed_saas_defaults(self, now_iso: str) -> None:
        plans = [
            (
                "plan_starter",
                "STARTER",
                "Starter ISP",
                25_000,
                250_000,
                2,
                1,
                200,
                0,
                json.dumps(["Standalone & MikroTik Ready", "Up to 2 Routers", "1 Location", "Mobile Money & Vouchers"]),
            ),
            (
                "plan_growth",
                "GROWTH",
                "Growth WISP",
                75_000,
                750_000,
                10,
                5,
                2000,
                0,
                json.dumps(["Up to 10 Routers", "5 Locations", "FreeRADIUS + WireGuard Tunneling", "Multi-Staff RBAC"]),
            ),
            (
                "plan_enterprise",
                "ENTERPRISE",
                "Enterprise Carrier",
                200_000,
                2_000_000,
                100,
                50,
                50_000,
                0,
                json.dumps(["100 Routers", "50 Locations", "Priority SLA & Audit Exports", "Dedicated RADIUS Accounting"]),
            ),
        ]
        for p in plans:
            self.conn.execute(
                """
                INSERT OR IGNORE INTO saas_plans (
                  id, code, name, price_monthly_tzs, price_yearly_tzs, max_routers, max_locations,
                  max_active_customers, commission_bps, features_json, is_active, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (*p, now_iso, now_iso),
            )

        self.conn.execute(
            """
            INSERT OR IGNORE INTO businesses (
              id, name, slug, email, phone, country, currency, status, timezone, hotspot_title, created_at, updated_at
            ) VALUES (?, 'TRAX LINK Primary Hotspot', 'trax-default', 'ops@traxlink.co.tz', '+255700000000', 'Tanzania', 'TZS', 'ACTIVE', 'Africa/Dar_es_Salaam', 'TRAX LINK WiFi Zone', ?, ?)
            """,
            (DEFAULT_BUSINESS_ID, now_iso, now_iso),
        )

        self.conn.execute(
            """
            INSERT OR IGNORE INTO locations (
              id, business_id, name, region, address, is_active, created_at, updated_at
            ) VALUES (?, ?, 'Main Hotspot Zone', 'Dar es Salaam', 'Primary Site', 1, ?, ?)
            """,
            (DEFAULT_LOCATION_ID, DEFAULT_BUSINESS_ID, now_iso, now_iso),
        )

        period_end = (datetime.now(timezone.utc) + timedelta(days=365)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        self.conn.execute(
            """
            INSERT OR IGNORE INTO saas_subscriptions (
              id, business_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at, updated_at
            ) VALUES ('ssub_default', ?, 'plan_enterprise', 'ACTIVE', 'YEARLY', ?, ?, ?, ?)
            """,
            (DEFAULT_BUSINESS_ID, now_iso, period_end, now_iso, now_iso),
        )


def get_operating_mode(db: DatabaseManager) -> str:
    row = db.query_one("SELECT value FROM system_settings WHERE key = 'operating_mode'")
    return "MIKROTIK_MODE" if row and row["value"] == "MIKROTIK_MODE" else "STANDALONE_MODE"


def set_operating_mode(db: DatabaseManager, mode: str) -> str:
    now_iso = utc_now_iso()
    db.execute(
        """
        INSERT INTO system_settings (key, value, updated_at)
        VALUES ('operating_mode', ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
        """,
        (mode, now_iso),
    )
    return mode


def ensure_primary_staff_accounts(db: DatabaseManager) -> None:
    custom_email = get_env("STAFF_EMAIL").lower()
    staff_password = get_env("STAFF_PASSWORD")
    pw_hash = hash_password(staff_password) if staff_password else DEFAULT_STAFF_PASSWORD_HASH
    accounts = list(DEFAULT_STAFF_ACCOUNTS)
    if custom_email:
        accounts.insert(0, {"email": custom_email, "fullName": "TRAX LINK Platform Admin", "code": "STF-001"})
    now_iso = utc_now_iso()

    def _tx(conn: sqlite3.Connection) -> None:
        for acct in accounts:
            existing = conn.execute(
                "SELECT id, password_hash FROM admin_users WHERE LOWER(email) = ?",
                (acct["email"],),
            ).fetchone()
            if existing:
                if not existing["password_hash"]:
                    conn.execute(
                        "UPDATE admin_users SET password_hash = ?, is_active = 1, updated_at = ? WHERE id = ?",
                        (pw_hash, now_iso, existing["id"]),
                    )
                continue

            admin_id = generate_id("adm")
            code_exists = conn.execute("SELECT id FROM staff WHERE staff_code = ?", (acct["code"],)).fetchone()
            staff_code = generate_reference("STF") if code_exists else acct["code"]

            conn.execute(
                """
                INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 1, ?, ?)
                """,
                (admin_id, DEFAULT_BUSINESS_ID, acct["email"], acct["fullName"], pw_hash, now_iso, now_iso),
            )
            conn.execute(
                """
                INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, role, is_suspended)
                VALUES (?, ?, ?, ?, 'Executive Operations', 'SUPER_ADMIN', 0)
                """,
                (generate_id("stf"), DEFAULT_BUSINESS_ID, admin_id, staff_code),
            )

    db.transaction(_tx)


def expire_stale_records(db: DatabaseManager) -> dict[str, int]:
    now_iso = utc_now_iso()

    def _tx(conn: sqlite3.Connection) -> dict[str, int]:
        expired_sess = conn.execute(
            """
            UPDATE sessions
            SET status = 'EXPIRED', ended_at = ?, end_reason = 'Time limit elapsed'
            WHERE status = 'ACTIVE' AND expires_at <= ?
            """,
            (now_iso, now_iso),
        )
        expired_vouch = conn.execute(
            """
            UPDATE vouchers
            SET status = 'EXPIRED', updated_at = ?
            WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?
            """,
            (now_iso, now_iso),
        )
        stale_subs = conn.execute(
            "SELECT id, radius_username FROM subscriptions WHERE status = 'ACTIVE' AND expires_at <= ?",
            (now_iso,),
        ).fetchall()
        if stale_subs:
            conn.execute(
                "UPDATE subscriptions SET status = 'EXPIRED', updated_at = ? WHERE status = 'ACTIVE' AND expires_at <= ?",
                (now_iso, now_iso),
            )
            for s in stale_subs:
                conn.execute("UPDATE radcheck SET is_active = 0 WHERE username = ?", (s["radius_username"],))
        return {
            "expiredSessions": int(expired_sess.rowcount or 0),
            "expiredVouchers": int(expired_vouch.rowcount or 0),
            "expiredSubscriptions": len(stale_subs),
        }

    return db.transaction(_tx)
