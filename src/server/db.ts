import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export type NetcoDb = DatabaseSync;

export const DEFAULT_BUSINESS_ID = 'biz_trax_default';
export const DEFAULT_LOCATION_ID = 'loc_trax_default';

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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      attribute TEXT NOT NULL,
      op TEXT NOT NULL DEFAULT ':=',
      value TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(business_id, username, attribute)
    );

    CREATE TABLE IF NOT EXISTS radacct (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
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

    CREATE TABLE IF NOT EXISTS support_tickets (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}' REFERENCES businesses(id) ON DELETE CASCADE,
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
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
      router_id TEXT REFERENCES routers(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      rx_bytes INTEGER NOT NULL DEFAULT 0,
      tx_bytes INTEGER NOT NULL DEFAULT 0,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY,
      business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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

  `);

  runMigrations(db);

  db.exec(`
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
  `);

  return db;
}

export type OperatingMode = 'STANDALONE_MODE' | 'MIKROTIK_MODE';

function hasColumn(db: NetcoDb, table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.some((c) => c.name === column);
}

function getTableSql(db: NetcoDb, table: string): string {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table) as { sql: string } | undefined;
  return row?.sql || '';
}

function seedSaasDefaults(db: NetcoDb, nowIso: string) {
  const plans = [
    {
      id: 'plan_starter',
      code: 'STARTER',
      name: 'Starter ISP',
      priceMonthlyTzs: 25_000,
      priceYearlyTzs: 250_000,
      maxRouters: 2,
      maxLocations: 1,
      maxActiveCustomers: 200,
      commissionBps: 0,
      featuresJson: JSON.stringify(['Standalone & MikroTik Ready', 'Up to 2 Routers', '1 Location', 'Mobile Money & Vouchers']),
    },
    {
      id: 'plan_growth',
      code: 'GROWTH',
      name: 'Growth WISP',
      priceMonthlyTzs: 75_000,
      priceYearlyTzs: 750_000,
      maxRouters: 10,
      maxLocations: 5,
      maxActiveCustomers: 2000,
      commissionBps: 0,
      featuresJson: JSON.stringify(['Up to 10 Routers', '5 Locations', 'FreeRADIUS + WireGuard Tunneling', 'Multi-Staff RBAC']),
    },
    {
      id: 'plan_enterprise',
      code: 'ENTERPRISE',
      name: 'Enterprise Carrier',
      priceMonthlyTzs: 200_000,
      priceYearlyTzs: 2_000_000,
      maxRouters: 100,
      maxLocations: 50,
      maxActiveCustomers: 50_000,
      commissionBps: 0,
      featuresJson: JSON.stringify(['100 Routers', '50 Locations', 'Priority SLA & Audit Exports', 'Dedicated RADIUS Accounting']),
    },
  ];

  const insertPlan = db.prepare(`
    INSERT OR IGNORE INTO saas_plans (
      id, code, name, price_monthly_tzs, price_yearly_tzs, max_routers, max_locations,
      max_active_customers, commission_bps, features_json, is_active, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);
  for (const p of plans) {
    insertPlan.run(
      p.id,
      p.code,
      p.name,
      p.priceMonthlyTzs,
      p.priceYearlyTzs,
      p.maxRouters,
      p.maxLocations,
      p.maxActiveCustomers,
      p.commissionBps,
      p.featuresJson,
      nowIso,
      nowIso
    );
  }

  db.prepare(`
    INSERT OR IGNORE INTO businesses (
      id, name, slug, email, phone, country, currency, status, timezone, hotspot_title, created_at, updated_at
    ) VALUES (?, 'TRAX LINK Primary Hotspot', 'trax-default', 'ops@traxlink.co.tz', '+255700000000', 'Tanzania', 'TZS', 'ACTIVE', 'Africa/Dar_es_Salaam', 'TRAX LINK WiFi Zone', ?, ?)
  `).run(DEFAULT_BUSINESS_ID, nowIso, nowIso);

  db.prepare(`
    INSERT OR IGNORE INTO locations (
      id, business_id, name, region, address, is_active, created_at, updated_at
    ) VALUES (?, ?, 'Main Hotspot Zone', 'Dar es Salaam', 'Primary Site', 1, ?, ?)
  `).run(DEFAULT_LOCATION_ID, DEFAULT_BUSINESS_ID, nowIso, nowIso);

  const periodEnd = new Date(Date.now() + 365 * 86_400_000).toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO saas_subscriptions (
      id, business_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at, updated_at
    ) VALUES ('ssub_default', ?, 'plan_enterprise', 'ACTIVE', 'YEARLY', ?, ?, ?, ?)
  `).run(DEFAULT_BUSINESS_ID, nowIso, periodEnd, nowIso, nowIso);
}

function runMigrations(db: NetcoDb) {
  const nowIso = new Date().toISOString();

  // Legacy 001 & 002 column guards
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

  // Migration 003: Multi-tenant TRAX LINK SaaS columns & constraint upgrades
  const tablesNeedingBusinessId = [
    'admin_users',
    'staff',
    'customers',
    'devices',
    'vouchers',
    'sessions',
    'payments',
    'network_usage',
    'notifications',
    'audit_logs',
  ];
  for (const tbl of tablesNeedingBusinessId) {
    if (!hasColumn(db, tbl, 'business_id')) {
      const defClause = tbl === 'audit_logs' ? '' : ` NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}'`;
      db.exec(`ALTER TABLE ${tbl} ADD COLUMN business_id TEXT${defClause};`);
    }
  }

  // Upgrade CHECK constraints on pre-existing DBs cleanly if needed
  const adminSql = getTableSql(db, 'admin_users');
  if (adminSql && !adminSql.includes('BUSINESS_OWNER')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE admin_users_new (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      SELECT id, COALESCE(business_id, '${DEFAULT_BUSINESS_ID}'), firebase_uid, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at FROM admin_users;
      DROP TABLE admin_users;
      ALTER TABLE admin_users_new RENAME TO admin_users;

      CREATE TABLE staff_new (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      SELECT id, COALESCE(business_id, '${DEFAULT_BUSINESS_ID}'), admin_user_id, staff_code, department, phone, role, is_suspended, created_at, updated_at FROM staff;
      DROP TABLE staff;
      ALTER TABLE staff_new RENAME TO staff;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  const pkgSql = getTableSql(db, 'packages');
  if (pkgSql && !pkgSql.includes('package_type')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE packages_new (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      INSERT INTO packages_new (id, business_id, name, description, category, price_tzs, duration_minutes, download_kbps, upload_kbps, data_limit_mb, validity_days, is_active, created_at, updated_at)
      SELECT id, '${DEFAULT_BUSINESS_ID}', name, description, category, price_tzs, duration_minutes, download_kbps, upload_kbps, data_limit_mb, validity_days, is_active, created_at, updated_at FROM packages;
      DROP TABLE packages;
      ALTER TABLE packages_new RENAME TO packages;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  const paySql = getTableSql(db, 'payments');
  if (paySql && !paySql.includes("'CARD'")) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE payments_new (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      INSERT INTO payments_new (id, business_id, reference, receipt_number, provider, phone_number, amount_tzs, status, is_test, payment_mode, external_tx_id, package_id, customer_id, voucher_id, provider_payload, verified_at, refunded_at, created_at, updated_at)
      SELECT id, '${DEFAULT_BUSINESS_ID}', reference, receipt_number, provider, phone_number, amount_tzs, status, is_test, payment_mode, external_tx_id, package_id, customer_id, voucher_id, provider_payload, verified_at, refunded_at, created_at, updated_at FROM payments;
      DROP TABLE payments;
      ALTER TABLE payments_new RENAME TO payments;
      CREATE INDEX IF NOT EXISTS idx_payments_status_created ON payments(status, created_at);
      CREATE INDEX IF NOT EXISTS idx_payments_business_status ON payments(business_id, status, created_at);
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  const rtrSql = getTableSql(db, 'routers');
  if (rtrSql && !rtrSql.includes('router_os_family')) {
    db.exec('PRAGMA foreign_keys = OFF;');
    db.exec(`
      CREATE TABLE routers_new (
        id TEXT PRIMARY KEY,
        business_id TEXT NOT NULL DEFAULT '${DEFAULT_BUSINESS_ID}',
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
      INSERT INTO routers_new (id, business_id, name, host, api_port, use_tls, username, password_encrypted, hotspot_server, status, cpu_load, memory_used_bytes, memory_total_bytes, uptime, router_os_version, board_name, last_error, last_checked_at, created_at, updated_at)
      SELECT id, '${DEFAULT_BUSINESS_ID}', name, host, api_port, use_tls, username, password_encrypted, hotspot_server, status, cpu_load, memory_used_bytes, memory_total_bytes, uptime, router_os_version, board_name, last_error, last_checked_at, created_at, updated_at FROM routers;
      DROP TABLE routers;
      ALTER TABLE routers_new RENAME TO routers;
    `);
    db.exec('PRAGMA foreign_keys = ON;');
  }

  seedSaasDefaults(db, nowIso);

  for (const migrationId of [
    '001_standalone_mode_and_test_tokens',
    '002_single_use_device_name_lock',
    '003_trax_link_multitenant_saas',
  ]) {
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

export function expireStaleRecords(db: NetcoDb): {
  expiredSessions: number;
  expiredVouchers: number;
  expiredSubscriptions: number;
} {
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

    const staleSubs = db
      .prepare("SELECT id, radius_username FROM subscriptions WHERE status = 'ACTIVE' AND expires_at <= ?")
      .all(nowIso) as Array<{ id: string; radius_username: string }>;

    if (staleSubs.length > 0) {
      db.prepare(`
        UPDATE subscriptions
        SET status = 'EXPIRED', updated_at = ?
        WHERE status = 'ACTIVE' AND expires_at <= ?
      `).run(nowIso, nowIso);

      const disableRad = db.prepare('UPDATE radcheck SET is_active = 0 WHERE username = ?');
      for (const s of staleSubs) {
        disableRad.run(s.radius_username);
      }
    }

    return {
      expiredSessions: Number(expiredSess.changes || 0),
      expiredVouchers: Number(expiredVouch.changes || 0),
      expiredSubscriptions: staleSubs.length,
    };
  });
}
