import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type NetcoDb = DatabaseSync;

export function createDatabase(dbPath?: string): NetcoDb {
  const resolvedPath = dbPath ?? process.env.SQLITE_DB_PATH ?? path.resolve(process.cwd(), 'data/netco.db');
  if (resolvedPath !== ':memory:') {
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
  }

  const db = new DatabaseSync(resolvedPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id TEXT PRIMARY KEY,
      firebase_uid TEXT UNIQUE,
      email TEXT NOT NULL UNIQUE,
      full_name TEXT NOT NULL,
      password_hash TEXT,
      role TEXT NOT NULL DEFAULT 'ADMIN' CHECK(role IN ('SUPER_ADMIN','ADMIN','NETWORK_OPERATOR','CASHIER')),
      is_active INTEGER NOT NULL DEFAULT 1,
      last_login_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS staff (
      id TEXT PRIMARY KEY,
      admin_user_id TEXT NOT NULL UNIQUE REFERENCES admin_users(id) ON DELETE CASCADE,
      staff_code TEXT NOT NULL UNIQUE,
      department TEXT NOT NULL,
      phone TEXT,
      role TEXT NOT NULL CHECK(role IN ('SUPER_ADMIN','ADMIN','NETWORK_OPERATOR','CASHIER')),
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
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      category TEXT NOT NULL CHECK(category IN ('HOURLY','DAILY','WEEKLY','MONTHLY')),
      price_tzs INTEGER NOT NULL CHECK(price_tzs >= 0),
      duration_minutes INTEGER NOT NULL CHECK(duration_minutes > 0),
      download_kbps INTEGER NOT NULL CHECK(download_kbps > 0),
      upload_kbps INTEGER NOT NULL CHECK(upload_kbps > 0),
      data_limit_mb INTEGER,
      validity_days INTEGER NOT NULL DEFAULT 30,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS customers (
      id TEXT PRIMARY KEY,
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
      name TEXT NOT NULL UNIQUE,
      host TEXT NOT NULL,
      api_port INTEGER NOT NULL DEFAULT 8728,
      use_tls INTEGER NOT NULL DEFAULT 0,
      username TEXT NOT NULL,
      password_encrypted TEXT NOT NULL,
      hotspot_server TEXT NOT NULL DEFAULT '',
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
      UNIQUE(host, api_port)
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
      code_hash TEXT NOT NULL UNIQUE,
      code_encrypted TEXT NOT NULL,
      code_masked TEXT NOT NULL,
      batch_id TEXT,
      package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE RESTRICT,
      customer_id TEXT REFERENCES customers(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'UNUSED' CHECK(status IN ('UNUSED','ACTIVE','EXPIRED','REVOKED')),
      bound_device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
      bound_device_name TEXT,
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
      reference TEXT NOT NULL UNIQUE,
      receipt_number TEXT UNIQUE,
      provider TEXT NOT NULL CHECK(provider IN ('MPESA','AIRTEL_MONEY','TIGO_PESA','HALOPESA','CASH_DESK')),
      phone_number TEXT NOT NULL,
      amount_tzs INTEGER NOT NULL CHECK(amount_tzs >= 0),
      status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','COMPLETED','FAILED','REFUNDED')),
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
      router_id TEXT REFERENCES routers(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
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

    CREATE INDEX IF NOT EXISTS idx_vouchers_status ON vouchers(status);
    CREATE INDEX IF NOT EXISTS idx_vouchers_package ON vouchers(package_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status_expires ON sessions(status, expires_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_voucher_status ON sessions(voucher_id, status);
    CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
    CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone);
    CREATE INDEX IF NOT EXISTS idx_notifications_read ON notifications(is_read, created_at);
    CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_logs(action, created_at);
  `);

  runMigrations(db);
  return db;
}

export type OperatingMode = 'STANDALONE_MODE' | 'MIKROTIK_MODE';

function hasColumn(db: NetcoDb, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function runMigrations(db: NetcoDb) {
  const nowIso = new Date().toISOString();

  if (!hasColumn(db, 'vouchers', 'is_test')) {
    db.exec('ALTER TABLE vouchers ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;');
  }
  if (!hasColumn(db, 'vouchers', 'test_note')) {
    db.exec('ALTER TABLE vouchers ADD COLUMN test_note TEXT;');
  }
  if (!hasColumn(db, 'payments', 'is_test')) {
    db.exec('ALTER TABLE payments ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;');
  }
  if (!hasColumn(db, 'payments', 'payment_mode')) {
    db.exec("ALTER TABLE payments ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'GATEWAY';");
  }
  if (!hasColumn(db, 'vouchers', 'bound_device_name')) {
    db.exec('ALTER TABLE vouchers ADD COLUMN bound_device_name TEXT;');
  }

  for (const migrationId of ['001_standalone_mode_and_test_tokens', '002_single_use_device_name_lock']) {
    const applied = db.prepare('SELECT id FROM schema_migrations WHERE id = ?').get(migrationId);
    if (!applied) {
      db.prepare('INSERT INTO schema_migrations (id, applied_at) VALUES (?, ?)').run(migrationId, nowIso);
    }
  }

  const defaultMode: OperatingMode =
    process.env.NETCO_MODE?.trim() === 'MIKROTIK_MODE' ? 'MIKROTIK_MODE' : 'STANDALONE_MODE';
  db.prepare(`
    INSERT OR IGNORE INTO system_settings (key, value, updated_at)
    VALUES ('operating_mode', ?, ?)
  `).run(defaultMode, nowIso);
}

export function getOperatingMode(db: NetcoDb): OperatingMode {
  const row = db
    .prepare("SELECT value FROM system_settings WHERE key = 'operating_mode'")
    .get() as { value: string } | undefined;
  return row?.value === 'MIKROTIK_MODE' ? 'MIKROTIK_MODE' : 'STANDALONE_MODE';
}

export function setOperatingMode(db: NetcoDb, mode: OperatingMode): OperatingMode {
  const nowIso = new Date().toISOString();
  db.prepare(`
    INSERT INTO system_settings (key, value, updated_at)
    VALUES ('operating_mode', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(mode, nowIso);
  return mode;
}

export function withTransaction<T>(db: NetcoDb, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function expireStaleRecords(db: NetcoDb): { expiredSessions: number; expiredVouchers: number } {
  const nowIso = new Date().toISOString();
  return withTransaction(db, () => {
    const expiredSess = db.prepare(`
      UPDATE sessions
      SET status = 'EXPIRED', ended_at = ?, end_reason = 'Time limit elapsed'
      WHERE status = 'ACTIVE' AND expires_at <= ?
    `).run(nowIso, nowIso);

    const expiredVouch = db.prepare(`
      UPDATE vouchers
      SET status = 'EXPIRED', updated_at = ?
      WHERE status = 'ACTIVE' AND expires_at IS NOT NULL AND expires_at <= ?
    `).run(nowIso, nowIso);

    return {
      expiredSessions: Number(expiredSess.changes || 0),
      expiredVouchers: Number(expiredVouch.changes || 0),
    };
  });
}
