import express from 'express';
import crypto from 'node:crypto';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import {
  DEFAULT_BUSINESS_ID,
  expireStaleRecords,
  getOperatingMode,
  setOperatingMode,
  withTransaction,
  type NetcoDb,
} from './db.ts';
import {
  ALL_BUSINESS_ROLES,
  BUSINESS_MANAGEMENT_ROLES,
  createAuthMiddleware,
  FINANCE_ROLES,
  getClientIp,
  NETWORK_ROLES,
  recordAuditLog,
  resolveTenantScope,
  type AuthedRequest,
  type StaffRole,
} from './middleware/auth.ts';
import { createRateLimiter } from './middleware/rateLimit.ts';
import {
  encryptSecret,
  generateId,
  generateReference,
  generateSessionToken,
  hashPassword,
  sha256,
  verifyPassword,
} from './utils/crypto.ts';
import {
  createVoucherBatch,
  decryptVoucherCodeForAdmin,
  redeemVoucherForDevice,
  validateVoucherCode,
  VoucherError,
} from './services/vouchers.ts';
import {
  confirmStandalonePaymentForToken,
  getProviderStatuses,
  initiatePayment,
  processVerifiedPaymentCallback,
  verifyWebhookSignature,
  type MobileMoneyProvider,
} from './services/payments.ts';
import {
  pushHotspotProfileToRouter,
  syncRouterTelemetry,
  terminateRouterSession,
} from './services/mikrotik.ts';
import { registerSaasRoutes } from './routes/saasRoutes.ts';

function csvEscape(val: unknown): string {
  const s = val === null || val === undefined ? '' : String(val);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function emitEvent(io: SocketIOServer | undefined, event: string, payload: unknown) {
  if (io) {
    io.emit(event, payload);
  }
}

export function createApp(db: NetcoDb, io?: SocketIOServer) {
  const app = express();
  app.set('trust proxy', true);

  app.use(
    express.json({
      limit: '1mb',
      verify: (req: express.Request & { rawBody?: string }, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    next();
  });

  const { requireAuth, requireRole } = createAuthMiddleware(db);
  const authLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 30, bucketName: 'auth' });
  const portalLimiter = createRateLimiter({ windowMs: 60_000, maxRequests: 35, bucketName: 'portal' });

  // Mount TRAX LINK multi-tenant SaaS, Super Admin, Locations, Subscriptions, and FreeRADIUS routes
  registerSaasRoutes(app, db, io, { requireAuth, requireRole }, authLimiter);

  // =========================================================================
  // HEALTH & OPERATING MODE
  // =========================================================================
  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: 'TRAX LINK',
      operatingMode: getOperatingMode(db),
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/api/system/mode', (req, res) => {
    const operatingMode = getOperatingMode(db);
    const bizFilter = typeof req.query.businessId === 'string' && req.query.businessId.trim() ? req.query.businessId.trim() : null;
    const counts = bizFilter
      ? (db
          .prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END) as connected FROM routers WHERE business_id = ?"
          )
          .get(bizFilter) as { total: number; connected: number | null })
      : (db
          .prepare(
            "SELECT COUNT(*) as total, SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END) as connected FROM routers"
          )
          .get() as { total: number; connected: number | null });

    const routerCount = Number(counts?.total || 0);
    const connectedRouterCount = Number(counts?.connected || 0);
    res.json({
      operatingMode,
      routerCount,
      connectedRouterCount,
      routerStatusMessage:
        connectedRouterCount > 0
          ? `${connectedRouterCount} MikroTik router(s) connected`
          : 'No MikroTik router connected',
      airtelPocketWifiNotice:
        'Standalone Mode enforces database voucher & one-device session tracking only. It does not directly control or restrict internet access on an Airtel Pocket WiFi.',
    });
  });

  app.patch('/api/system/mode', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const schema = z.object({
      operatingMode: z.enum(['STANDALONE_MODE', 'MIKROTIK_MODE']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'operatingMode must be STANDALONE_MODE or MIKROTIK_MODE' });
    }
    const updated = setOperatingMode(db, parsed.data.operatingMode);
    if (req.actor) {
      recordAuditLog(db, req.actor, 'SYSTEM_MODE_CHANGED', 'SystemSetting', 'operating_mode', getClientIp(req), {
        operatingMode: updated,
      });
    }
    emitEvent(io, 'router:status', { operatingMode: updated });
    res.json({ operatingMode: updated });
  });

  // =========================================================================
  // AUTHENTICATION & FIRST-RUN BOOTSTRAP
  // =========================================================================
  app.get('/api/auth/bootstrap-status', (_req, res) => {
    const existingPasswordAdmin = db
      .prepare("SELECT id FROM admin_users WHERE role = 'SUPER_ADMIN' AND password_hash IS NOT NULL LIMIT 1")
      .get();
    const envPasscode = process.env.ADMIN_INITIAL_PASSCODE?.trim();
    res.json({
      needsPasswordBootstrap: !existingPasswordAdmin && !envPasscode,
      envPasscodeConfigured: Boolean(envPasscode),
    });
  });

  app.post('/api/auth/bootstrap', authLimiter, (req, res) => {
    const schema = z.object({
      email: z.string().email().max(254),
      fullName: z.string().min(2).max(100),
      password: z.string().min(8).max(128),
      setupPasscode: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid registration details', issues: parsed.error.issues });
    }

    const envPasscode = process.env.ADMIN_INITIAL_PASSCODE?.trim();
    const existingPasswordAdmin = db
      .prepare("SELECT id FROM admin_users WHERE role = 'SUPER_ADMIN' AND password_hash IS NOT NULL LIMIT 1")
      .get();

    if (existingPasswordAdmin) {
      return res.status(409).json({ error: 'Super Admin password account is already claimed.' });
    }
    if (envPasscode && parsed.data.setupPasscode !== envPasscode) {
      return res.status(403).json({ error: 'Invalid initial admin setup passcode.' });
    }

    const emailLower = parsed.data.email.toLowerCase();
    const nowIso = new Date().toISOString();
    const passwordHash = hashPassword(parsed.data.password);

    const adminId = withTransaction(db, () => {
      const existing = db
        .prepare('SELECT id FROM admin_users WHERE LOWER(email) = ?')
        .get(emailLower) as { id: string } | undefined;

      if (existing) {
        db.prepare(`
          UPDATE admin_users
          SET password_hash = ?, full_name = ?, role = 'SUPER_ADMIN', business_id = ?, is_active = 1, last_login_at = ?, updated_at = ?
          WHERE id = ?
        `).run(passwordHash, parsed.data.fullName, DEFAULT_BUSINESS_ID, nowIso, nowIso, existing.id);
        return existing.id;
      }

      const id = generateId('adm');
      db.prepare(`
        INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 1, ?, ?, ?)
      `).run(id, DEFAULT_BUSINESS_ID, emailLower, parsed.data.fullName, passwordHash, nowIso, nowIso, nowIso);

      const codeExists = db.prepare('SELECT id FROM staff WHERE staff_code = ?').get('STF-001');
      const staffCode = codeExists ? generateReference('STF') : 'STF-001';
      db.prepare(`
        INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, role)
        VALUES (?, ?, ?, ?, 'Executive Operations', 'SUPER_ADMIN')
      `).run(generateId('stf'), DEFAULT_BUSINESS_ID, id, staffCode);

      return id;
    });

    const rawToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    db.prepare(`
      INSERT INTO staff_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(generateId('ss'), adminId, sha256(rawToken), getClientIp(req), req.headers['user-agent'] || null, expiresAt);

    recordAuditLog(
      db,
      { id: adminId, businessId: DEFAULT_BUSINESS_ID, email: emailLower, role: 'SUPER_ADMIN' },
      'ADMIN_BOOTSTRAP',
      'AdminUser',
      adminId,
      getClientIp(req)
    );

    res.status(201).json({
      token: rawToken,
      expiresAt,
      user: {
        id: adminId,
        businessId: DEFAULT_BUSINESS_ID,
        businessName: 'TRAX LINK Primary Hotspot',
        businessStatus: 'ACTIVE',
        email: emailLower,
        fullName: parsed.data.fullName,
        role: 'SUPER_ADMIN',
      },
    });
  });

  app.post('/api/auth/login', authLimiter, (req, res) => {
    const schema = z.object({
      email: z.string().email().max(254),
      password: z.string().min(1).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid email and password are required' });
    }

    const emailLower = parsed.data.email.toLowerCase();
    const user = db
      .prepare(`
        SELECT u.*, st.is_suspended, b.name as business_name, b.status as business_status
        FROM admin_users u
        LEFT JOIN staff st ON st.admin_user_id = u.id
        LEFT JOIN businesses b ON b.id = u.business_id
        WHERE LOWER(u.email) = ?
      `)
      .get(emailLower) as Record<string, unknown> | undefined;

    if (!user || !user.password_hash || !verifyPassword(parsed.data.password, String(user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.is_active || user.is_suspended) {
      return res.status(403).json({ error: 'Account is suspended or deactivated' });
    }

    const role = String(user.role) as StaffRole;
    const businessStatus = String(user.business_status || 'ACTIVE');
    if (role !== 'SUPER_ADMIN' && businessStatus === 'SUSPENDED') {
      return res.status(403).json({ error: 'Business workspace is suspended. Contact TRAX LINK support.' });
    }

    const businessId = String(user.business_id || DEFAULT_BUSINESS_ID);
    const nowIso = new Date().toISOString();
    const rawToken = generateSessionToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

    db.prepare('UPDATE admin_users SET last_login_at = ?, updated_at = ? WHERE id = ?').run(
      nowIso,
      nowIso,
      String(user.id)
    );
    db.prepare(`
      INSERT INTO staff_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      generateId('ss'),
      String(user.id),
      sha256(rawToken),
      getClientIp(req),
      req.headers['user-agent'] || null,
      expiresAt
    );

    recordAuditLog(
      db,
      { id: String(user.id), businessId, email: String(user.email), role },
      'STAFF_LOGIN',
      'AdminUser',
      String(user.id),
      getClientIp(req)
    );

    res.json({
      token: rawToken,
      expiresAt,
      user: {
        id: String(user.id),
        businessId,
        businessName: String(user.business_name || 'TRAX LINK Primary Hotspot'),
        businessStatus,
        email: String(user.email),
        fullName: String(user.full_name),
        role,
      },
    });
  });

  app.post('/api/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    const token = req.headers.authorization?.slice('Bearer '.length).trim();
    if (token && req.actor?.authSource === 'SESSION') {
      db.prepare('UPDATE staff_sessions SET revoked_at = ? WHERE token_hash = ?').run(
        new Date().toISOString(),
        sha256(token)
      );
    }
    if (req.actor) {
      recordAuditLog(db, req.actor, 'STAFF_LOGOUT', 'AdminUser', req.actor.id, getClientIp(req));
    }
    res.json({ ok: true });
  });

  app.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.actor });
  });

  app.post('/api/auth/forgot-password', authLimiter, async (req, res) => {
    const schema = z.object({
      email: z.string().email().max(254),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please enter a valid staff email address' });
    }

    const emailLower = parsed.data.email.trim().toLowerCase();
    const nowIso = new Date().toISOString();
    const user = db
      .prepare(`
        SELECT u.id, u.business_id, u.email, u.full_name, u.role, u.is_active, st.is_suspended
        FROM admin_users u
        LEFT JOIN staff st ON st.admin_user_id = u.id
        WHERE LOWER(u.email) = ?
      `)
      .get(emailLower) as Record<string, unknown> | undefined;

    let emailSent = false;
    if (user && user.is_active && !user.is_suspended) {
      const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
      const formattedCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;
      const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();
      const ip = getClientIp(req);
      const businessId = String(user.business_id || DEFAULT_BUSINESS_ID);

      withTransaction(db, () => {
        db.prepare(
          'UPDATE password_reset_tokens SET used_at = ? WHERE admin_user_id = ? AND used_at IS NULL'
        ).run(nowIso, String(user.id));

        db.prepare(`
          INSERT INTO password_reset_tokens (id, admin_user_id, token_hash, expires_at, requested_ip)
          VALUES (?, ?, ?, ?, ?)
        `).run(generateId('prt'), String(user.id), sha256(rawCode), expiresAt, ip);

        db.prepare(`
          INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
          VALUES (?, ?, 'SECURITY', 'WARN', 'Staff Password Reset Requested', ?, ?)
        `).run(
          generateId('ntf'),
          businessId,
          `A password reset was requested for ${String(user.email)} from IP ${ip}.`,
          JSON.stringify({ email: String(user.email), expiresAt })
        );
      });

      recordAuditLog(
        db,
        { id: String(user.id), businessId, email: String(user.email), role: String(user.role) },
        'PASSWORD_RESET_REQUESTED',
        'AdminUser',
        String(user.id),
        ip
      );
      io?.emit('notification:new', { type: 'SECURITY' });

      const resendKey = process.env.RESEND_API_KEY?.trim();
      const mailFrom = process.env.MAIL_FROM?.trim() || 'TRAX LINK Security <no-reply@traxlink.co.tz>';
      if (resendKey) {
        try {
          const mailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${resendKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              from: mailFrom,
              to: [String(user.email)],
              subject: 'TRAX LINK Password Recovery Code',
              text: `Your TRAX LINK one-time password recovery code is: ${formattedCode}\n\nThis code expires in 15 minutes.`,
            }),
          });
          emailSent = mailRes.ok;
        } catch {
          emailSent = false;
        }
      }
    }

    res.json({
      ok: true,
      emailSent,
      message: emailSent
        ? 'Recovery code sent to your staff email address. Enter the code below within 15 minutes.'
        : 'If an active staff account matches that email, a reset request has been logged. Enter the recovery code issued by your administrator (or sign in with Google Workspace).',
    });
  });

  app.post('/api/auth/reset-password', authLimiter, (req, res) => {
    const schema = z.object({
      email: z.string().email().max(254),
      code: z.string().min(4).max(64),
      newPassword: z.string().min(8).max(128),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Valid email, recovery code, and new password (min 8 characters) are required',
      });
    }

    const emailLower = parsed.data.email.trim().toLowerCase();
    const normalizedCode = parsed.data.code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    const codeHash = sha256(normalizedCode);
    const nowIso = new Date().toISOString();

    const user = db
      .prepare(`
        SELECT u.id, u.business_id, u.email, u.role, u.is_active, st.is_suspended
        FROM admin_users u
        LEFT JOIN staff st ON st.admin_user_id = u.id
        WHERE LOWER(u.email) = ?
      `)
      .get(emailLower) as Record<string, unknown> | undefined;

    if (!user || !user.is_active || user.is_suspended) {
      return res.status(400).json({ error: 'Invalid or expired recovery code' });
    }

    const tokenRow = db
      .prepare(`
        SELECT id, expires_at, used_at
        FROM password_reset_tokens
        WHERE admin_user_id = ? AND token_hash = ?
      `)
      .get(String(user.id), codeHash) as { id: string; expires_at: string; used_at: string | null } | undefined;

    if (!tokenRow || tokenRow.used_at || tokenRow.expires_at <= nowIso) {
      return res.status(400).json({ error: 'Invalid or expired recovery code' });
    }

    const newHash = hashPassword(parsed.data.newPassword);
    withTransaction(db, () => {
      db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
        newHash,
        nowIso,
        String(user.id)
      );
      db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE id = ?').run(nowIso, tokenRow.id);
      db.prepare('UPDATE staff_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL').run(
        nowIso,
        String(user.id)
      );
    });

    recordAuditLog(
      db,
      {
        id: String(user.id),
        businessId: String(user.business_id || DEFAULT_BUSINESS_ID),
        email: String(user.email),
        role: String(user.role),
      },
      'PASSWORD_RESET_COMPLETED',
      'AdminUser',
      String(user.id),
      getClientIp(req)
    );

    res.json({ ok: true, message: 'Password updated successfully. Please sign in.' });
  });

  // =========================================================================
  // PUBLIC CUSTOMER HOTSPOT CAPTIVE PORTAL
  // =========================================================================
  app.get('/api/portal/packages', (req, res) => {
    const bizFilter = typeof req.query.business === 'string' ? req.query.business.trim() : '';
    let sql = `
      SELECT pk.id, pk.business_id as businessId, b.name as businessName, b.slug as businessSlug,
             pk.name, pk.description, pk.category, pk.package_type as packageType,
             pk.price_tzs as priceTzs, pk.currency,
             pk.duration_minutes as durationMinutes, pk.download_kbps as downloadKbps,
             pk.upload_kbps as uploadKbps, pk.data_limit_mb as dataLimitMb,
             pk.device_limit as deviceLimit, pk.simultaneous_sessions as simultaneousSessions,
             pk.fup_policy as fupPolicy, pk.validity_days as validityDays
      FROM packages pk
      JOIN businesses b ON b.id = pk.business_id
      WHERE pk.is_active = 1 AND b.status = 'ACTIVE'
    `;
    const params: string[] = [];
    if (bizFilter) {
      sql += ' AND (b.id = ? OR b.slug = ?)';
      params.push(bizFilter, bizFilter);
    }
    sql += ' ORDER BY pk.price_tzs ASC';

    const packages = db.prepare(sql).all(...params);
    res.json({ packages });
  });

  app.get('/api/portal/providers', (_req, res) => {
    res.json({ providers: getProviderStatuses() });
  });

  app.post('/api/portal/validate', portalLimiter, (req, res) => {
    const schema = z.object({
      code: z.string().min(4).max(40),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Enter a valid voucher code.' });
    }

    try {
      const validation = validateVoucherCode(db, parsed.data.code);
      res.json({ validation });
    } catch (err) {
      if (err instanceof VoucherError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post('/api/portal/redeem', portalLimiter, (req, res) => {
    const schema = z.object({
      code: z.string().min(4).max(40),
      deviceFingerprint: z.string().min(8).max(256),
      macAddress: z.string().max(32).optional().nullable(),
      deviceLabel: z.string().max(120).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid voucher or device payload', issues: parsed.error.issues });
    }

    try {
      const result = redeemVoucherForDevice(db, {
        code: parsed.data.code,
        deviceFingerprint: parsed.data.deviceFingerprint,
        macAddress: parsed.data.macAddress ?? null,
        userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null,
        deviceLabel: parsed.data.deviceLabel ?? null,
        ipAddress: getClientIp(req),
      });

      emitEvent(io, 'session:started', {
        sessionId: result.sessionId,
        businessId: result.businessId,
        voucherId: result.voucherId,
        packageName: result.packageName,
        reconnected: result.reconnected,
      });
      emitEvent(io, 'notification:new', { type: 'VOUCHER_ACTIVATED', businessId: result.businessId });

      res.json({ session: { ...result, operatingMode: getOperatingMode(db) } });
    } catch (err) {
      if (err instanceof VoucherError) {
        if (err.code === 'DEVICE_LIMIT_REACHED' || err.code === 'VOUCHER_ALREADY_USED') {
          emitEvent(io, 'notification:new', { type: 'SUSPICIOUS_ACTIVITY' });
        }
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.get('/api/portal/session', (req, res) => {
    expireStaleRecords(db);
    const token =
      (typeof req.headers['x-portal-session'] === 'string' ? req.headers['x-portal-session'] : '') ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice('Bearer '.length).trim()
        : '');

    if (!token) {
      return res.status(401).json({ error: 'No active portal session token' });
    }

    const row = db
      .prepare(`
        SELECT s.*, v.code_masked, v.is_test as voucher_is_test, v.bound_device_name,
               p.name as package_name, p.category,
               p.download_kbps, p.upload_kbps, p.data_limit_mb,
               d.device_label, d.device_fingerprint, b.name as business_name
        FROM sessions s
        JOIN vouchers v ON v.id = s.voucher_id
        JOIN packages p ON p.id = v.package_id
        JOIN devices d ON d.id = s.device_id
        LEFT JOIN businesses b ON b.id = s.business_id
        WHERE s.session_token = ?
      `)
      .get(token) as Record<string, unknown> | undefined;

    if (!row) {
      return res.status(404).json({ error: 'Session not found' });
    }

    const remainingSeconds =
      row.status === 'ACTIVE'
        ? Math.max(0, Math.floor((new Date(String(row.expires_at)).getTime() - Date.now()) / 1000))
        : 0;

    res.json({
      session: {
        sessionId: String(row.id),
        businessId: String(row.business_id || DEFAULT_BUSINESS_ID),
        businessName: row.business_name ? String(row.business_name) : 'TRAX LINK Hotspot',
        status: String(row.status),
        codeMasked: String(row.code_masked),
        packageName: String(row.package_name),
        category: String(row.category),
        downloadKbps: Number(row.download_kbps),
        uploadKbps: Number(row.upload_kbps),
        dataLimitMb: row.data_limit_mb !== null ? Number(row.data_limit_mb) : null,
        bytesIn: Number(row.bytes_in),
        bytesOut: Number(row.bytes_out),
        startedAt: String(row.started_at),
        expiresAt: String(row.expires_at),
        endedAt: row.ended_at ? String(row.ended_at) : null,
        endReason: row.end_reason ? String(row.end_reason) : null,
        remainingSeconds,
        deviceLabel: row.bound_device_name
          ? String(row.bound_device_name)
          : row.device_label
          ? String(row.device_label)
          : 'Authorized Device',
        isTest: Boolean(row.voucher_is_test),
        operatingMode: getOperatingMode(db),
      },
    });
  });

  app.post('/api/portal/logout', async (req, res) => {
    const token =
      (typeof req.headers['x-portal-session'] === 'string' ? req.headers['x-portal-session'] : '') ||
      (req.headers.authorization?.startsWith('Bearer ')
        ? req.headers.authorization.slice('Bearer '.length).trim()
        : '');
    if (!token) {
      return res.status(400).json({ error: 'Portal session token required' });
    }

    const session = db
      .prepare("SELECT * FROM sessions WHERE session_token = ? AND status = 'ACTIVE'")
      .get(token) as Record<string, unknown> | undefined;

    if (!session) {
      return res.status(404).json({ error: 'Active session not found' });
    }

    const nowIso = new Date().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = 'Customer disconnected via portal'
        WHERE id = ?
      `).run(nowIso, String(session.id));

      db.prepare(`
        UPDATE vouchers SET status = 'EXPIRED', updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'
      `).run(nowIso, String(session.voucher_id));
    });

    if (session.router_id && session.ip_address) {
      await terminateRouterSession(db, String(session.router_id), String(session.ip_address));
    }

    emitEvent(io, 'session:ended', { sessionId: String(session.id), reason: 'Customer disconnected' });
    emitEvent(io, 'voucher:updated', { voucherId: String(session.voucher_id), status: 'EXPIRED' });
    res.json({
      ok: true,
      message: 'Session ended cleanly. Because voucher codes are single-use, this code cannot be reused.',
    });
  });

  app.post('/api/portal/payments/initiate', portalLimiter, (req, res) => {
    const schema = z.object({
      packageId: z.string().min(1).max(64),
      provider: z.enum(['MPESA', 'AIRTEL_MONEY', 'TIGO_PESA', 'HALOPESA', 'CARD']),
      phoneNumber: z.string().min(4).max(80),
      customerId: z.string().optional().nullable(),
      businessId: z.string().optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payment initiation request', issues: parsed.error.issues });
    }

    try {
      const payment = initiatePayment(db, parsed.data);
      emitEvent(io, 'payment:updated', {
        reference: payment.reference,
        status: payment.status,
        businessId: payment.businessId,
      });
      res.status(201).json({ payment });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to initiate payment' });
    }
  });

  app.post('/api/portal/payments/:reference/confirm-test', portalLimiter, (req, res) => {
    try {
      const payment = confirmStandalonePaymentForToken(db, req.params.reference);
      emitEvent(io, 'payment:updated', {
        reference: payment.reference,
        status: payment.status,
        receiptNumber: payment.receiptNumber,
        businessId: payment.businessId,
      });
      emitEvent(io, 'voucher:updated', { source: 'standalone-payment', reference: payment.reference });
      emitEvent(io, 'notification:new', { type: 'STANDALONE_TOKEN_ISSUED', businessId: payment.businessId });
      res.json({ payment });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Unable to confirm standalone payment' });
    }
  });

  app.get('/api/portal/payments/:reference', (req, res) => {
    const row = db
      .prepare(`
        SELECT p.id, p.business_id as businessId, p.reference, p.receipt_number as receiptNumber, p.provider,
               p.phone_number as phoneNumber, p.amount_tzs as amountTzs,
               p.status, p.is_test as isTest, p.payment_mode as paymentMode,
               p.verified_at as verifiedAt, p.created_at as createdAt,
               pk.name as packageName, v.code_encrypted as voucherEncrypted
        FROM payments p
        JOIN packages pk ON pk.id = p.package_id
        LEFT JOIN vouchers v ON v.id = p.voucher_id
        WHERE p.reference = ?
      `)
      .get(req.params.reference) as Record<string, unknown> | undefined;

    if (!row) {
      return res.status(404).json({ error: 'Payment reference not found' });
    }

    const voucherCode =
      row.status === 'COMPLETED' && row.voucherEncrypted
        ? decryptVoucherCodeForAdmin(String(row.voucherEncrypted))
        : null;

    res.json({
      payment: {
        id: row.id,
        businessId: row.businessId,
        reference: row.reference,
        receiptNumber: row.receiptNumber,
        provider: row.provider,
        phoneNumber: row.phoneNumber,
        amountTzs: row.amountTzs,
        status: row.status,
        isTest: Boolean(row.isTest),
        paymentMode: String(row.paymentMode || 'GATEWAY'),
        packageName: row.packageName,
        verifiedAt: row.verifiedAt,
        createdAt: row.createdAt,
        voucherCode,
      },
    });
  });

  // =========================================================================
  // SERVER-SIDE PAYMENT PROVIDER WEBHOOK CALLBACKS
  // =========================================================================
  app.post('/api/payments/webhook/:provider', async (req: express.Request & { rawBody?: string }, res) => {
    const providerParam = req.params.provider?.toUpperCase() as MobileMoneyProvider;
    if (!['MPESA', 'AIRTEL_MONEY', 'TIGO_PESA', 'HALOPESA', 'CARD'].includes(providerParam)) {
      return res.status(400).json({ error: 'Unsupported payment provider' });
    }

    const rawBody = req.rawBody ?? JSON.stringify(req.body ?? {});
    const sigCheck = verifyWebhookSignature(
      providerParam,
      rawBody,
      req.headers['x-webhook-signature'] as string | undefined
    );
    if (!sigCheck.valid) {
      return res.status(401).json({ error: sigCheck.reason || 'Unauthorized webhook signature' });
    }

    const schema = z.object({
      externalEventId: z.string().min(2).max(128),
      reference: z.string().min(4).max(64),
      externalTxId: z.string().min(2).max(128),
      status: z.enum(['COMPLETED', 'FAILED', 'REFUNDED']),
      amountTzs: z.number().int().nonnegative().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid webhook payload', issues: parsed.error.issues });
    }

    try {
      const outcome = await processVerifiedPaymentCallback(db, {
        provider: providerParam,
        externalEventId: parsed.data.externalEventId,
        reference: parsed.data.reference,
        externalTxId: parsed.data.externalTxId,
        status: parsed.data.status,
        amountTzs: parsed.data.amountTzs,
        rawPayload: req.body,
      });

      emitEvent(io, 'payment:updated', {
        reference: outcome.reference,
        businessId: outcome.businessId,
        status: outcome.status,
        receiptNumber: outcome.receiptNumber,
      });
      emitEvent(io, 'notification:new', { type: 'PAYMENT_WEBHOOK', businessId: outcome.businessId });

      res.json({ ok: true, outcome });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Webhook processing failed' });
    }
  });

  // =========================================================================
  // TENANT DASHBOARD SUMMARY (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/dashboard/summary', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    expireStaleRecords(db);
    const bizId = scope.businessId;

    const totalCustomers = Number(
      (db.prepare('SELECT COUNT(*) as c FROM customers WHERE business_id = ?').get(bizId) as { c: number }).c
    );
    const onlineCustomers = Number(
      (
        db
          .prepare(
            "SELECT COUNT(DISTINCT COALESCE(customer_id, device_id)) as c FROM sessions WHERE business_id = ? AND status = 'ACTIVE'"
          )
          .get(bizId) as { c: number }
      ).c
    );
    const offlineCustomers = Math.max(0, totalCustomers - onlineCustomers);

    const voucherCounts = db
      .prepare('SELECT status, COUNT(*) as c FROM vouchers WHERE business_id = ? GROUP BY status')
      .all(bizId) as Array<{ status: string; c: number }>;
    const vMap: Record<string, number> = { UNUSED: 0, ACTIVE: 0, EXPIRED: 0, REVOKED: 0 };
    for (const row of voucherCounts) {
      vMap[row.status] = Number(row.c);
    }

    const now = new Date();
    const startOfDay = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const startOfWeek = new Date(now.getTime() - 7 * 86_400_000).toISOString();
    const startOfMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const dailyRevenueTzs = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?"
          )
          .get(bizId, startOfDay) as { s: number }
      ).s
    );
    const weeklyRevenueTzs = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?"
          )
          .get(bizId, startOfWeek) as { s: number }
      ).s
    );
    const monthlyRevenueTzs = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?"
          )
          .get(bizId, startOfMonth) as { s: number }
      ).s
    );
    const totalRevenueTzs = Number(
      (
        db
          .prepare(
            "SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0"
          )
          .get(bizId) as { s: number }
      ).s
    );
    const pendingPaymentsCount = Number(
      (db.prepare("SELECT COUNT(*) as c FROM payments WHERE business_id = ? AND status = 'PENDING'").get(bizId) as { c: number }).c
    );
    const activeSubscriptionsCount = Number(
      (db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE business_id = ? AND status = 'ACTIVE'").get(bizId) as { c: number }).c
    );
    const expiredSubscriptionsCount = Number(
      (db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE business_id = ? AND status = 'EXPIRED'").get(bizId) as { c: number }).c
    );
    const testVouchersCount = Number(
      (db.prepare('SELECT COUNT(*) as c FROM vouchers WHERE business_id = ? AND is_test = 1').get(bizId) as { c: number }).c
    );
    const testPaymentsCount = Number(
      (
        db
          .prepare("SELECT COUNT(*) as c FROM payments WHERE business_id = ? AND is_test = 1 AND status = 'COMPLETED'")
          .get(bizId) as { c: number }
      ).c
    );

    const bwRow = db
      .prepare('SELECT COALESCE(SUM(bytes_in), 0) as rx, COALESCE(SUM(bytes_out), 0) as tx FROM sessions WHERE business_id = ?')
      .get(bizId) as { rx: number; tx: number };

    const routerIfRow = db
      .prepare(`
        SELECT COALESCE(SUM(ri.rx_bytes), 0) as rx, COALESCE(SUM(ri.tx_bytes), 0) as tx
        FROM router_interfaces ri
        JOIN routers r ON r.id = ri.router_id
        WHERE r.business_id = ?
      `)
      .get(bizId) as { rx: number; tx: number };

    const routers = db
      .prepare(`
        SELECT id, name, host, api_port as apiPort, status, cpu_load as cpuLoad,
               memory_used_bytes as memoryUsedBytes, memory_total_bytes as memoryTotalBytes,
               uptime, board_name as boardName, router_os_version as routerOsVersion,
               last_error as lastError, last_checked_at as lastCheckedAt
        FROM routers
        WHERE business_id = ?
        ORDER BY created_at DESC
      `)
      .all(bizId);

    const recentActivities = db
      .prepare(`
        SELECT id, actor_email as actorEmail, actor_role as actorRole, action,
               entity_type as entityType, entity_id as entityId, created_at as createdAt
        FROM audit_logs
        WHERE business_id = ?
        ORDER BY created_at DESC
        LIMIT 12
      `)
      .all(bizId);

    const dailySeries = db
      .prepare(`
        SELECT substr(verified_at, 1, 10) as day,
               COALESCE(SUM(amount_tzs), 0) as revenueTzs,
               COUNT(*) as txCount
        FROM payments
        WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ?
        GROUP BY substr(verified_at, 1, 10)
        ORDER BY day ASC
      `)
      .all(bizId, startOfWeek);

    const activeSessionsCount = Number(
      (db.prepare("SELECT COUNT(*) as c FROM sessions WHERE business_id = ? AND status = 'ACTIVE'").get(bizId) as { c: number }).c
    );

    res.json({
      businessId: bizId,
      operatingMode: getOperatingMode(db),
      stats: {
        totalCustomers,
        onlineCustomers,
        offlineCustomers,
        activeSessionsCount,
        activeSubscriptionsCount,
        expiredSubscriptionsCount,
        pendingPaymentsCount,
        activeVouchers: vMap.ACTIVE,
        unusedVouchers: vMap.UNUSED,
        expiredVouchers: vMap.EXPIRED,
        revokedVouchers: vMap.REVOKED,
        testVouchersCount,
        testPaymentsCount,
        dailyRevenueTzs,
        weeklyRevenueTzs,
        monthlyRevenueTzs,
        totalRevenueTzs,
        totalRxBytes: Number(bwRow.rx) + Number(routerIfRow.rx),
        totalTxBytes: Number(bwRow.tx) + Number(routerIfRow.tx),
      },
      routers,
      recentActivities,
      dailySeries,
    });
  });

  // =========================================================================
  // CUSTOMERS (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/customers', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';

    let sql = `
      SELECT c.*, p.name as package_name,
             (SELECT COUNT(*) FROM sessions s WHERE s.customer_id = c.id AND s.status = 'ACTIVE') as active_session_count,
             (SELECT COUNT(*) FROM vouchers v WHERE v.customer_id = c.id) as voucher_count
      FROM customers c
      LEFT JOIN packages p ON p.id = c.package_id
      WHERE c.business_id = ?
    `;
    const params: string[] = [scope.businessId];
    if (q) {
      sql += " AND (c.full_name LIKE ? OR c.phone LIKE ? OR c.customer_code LIKE ? OR COALESCE(c.email, '') LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    if (status === 'ACTIVE') {
      sql += ' AND c.is_active = 1';
    } else if (status === 'INACTIVE') {
      sql += ' AND c.is_active = 0';
    }
    sql += ' ORDER BY c.created_at DESC';

    const rows = db.prepare(sql).all(...params);
    res.json({ customers: rows });
  });

  app.get('/api/customers/:id', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const customer = db
      .prepare(`
        SELECT c.*, p.name as package_name
        FROM customers c
        LEFT JOIN packages p ON p.id = c.package_id
        WHERE c.id = ?
      `)
      .get(req.params.id) as Record<string, unknown> | undefined;
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    if (String(customer.business_id) !== scope.businessId) {
      if (req.actor) {
        recordAuditLog(db, req.actor, 'CROSS_TENANT_ACCESS_BLOCKED', 'Customer', req.params.id, getClientIp(req));
      }
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const vouchers = db
      .prepare(`
        SELECT v.id, v.code_masked as codeMasked, v.status, v.activated_at as activatedAt,
               v.expires_at as expiresAt, v.created_at as createdAt, p.name as packageName
        FROM vouchers v
        JOIN packages p ON p.id = v.package_id
        WHERE v.customer_id = ? AND v.business_id = ?
        ORDER BY v.created_at DESC
      `)
      .all(req.params.id, scope.businessId);

    const sessions = db
      .prepare(`
        SELECT s.id, s.status, s.ip_address as ipAddress, s.bytes_in as bytesIn, s.bytes_out as bytesOut,
               s.started_at as startedAt, s.expires_at as expiresAt, s.ended_at as endedAt,
               d.device_label as deviceLabel, d.device_fingerprint as deviceFingerprint
        FROM sessions s
        JOIN devices d ON d.id = s.device_id
        WHERE s.customer_id = ? AND s.business_id = ?
        ORDER BY s.started_at DESC
      `)
      .all(req.params.id, scope.businessId);

    res.json({ customer, vouchers, sessions });
  });

  app.post('/api/customers', requireAuth, requireRole(...FINANCE_ROLES, 'SUPPORT_STAFF'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      fullName: z.string().min(2).max(120),
      phone: z.string().min(8).max(24),
      email: z.string().email().max(254).optional().nullable().or(z.literal('')),
      packageId: z.string().optional().nullable().or(z.literal('')),
      notes: z.string().max(500).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid customer data', issues: parsed.error.issues });
    }

    const id = generateId('cus');
    const code = generateReference('CUST');
    const nowIso = new Date().toISOString();

    db.prepare(`
      INSERT INTO customers (id, business_id, customer_code, full_name, phone, email, notes, is_active, package_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
    `).run(
      id,
      scope.businessId,
      code,
      parsed.data.fullName.trim(),
      parsed.data.phone.trim(),
      parsed.data.email?.trim() || null,
      parsed.data.notes?.trim() || null,
      parsed.data.packageId?.trim() || null,
      nowIso,
      nowIso
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'CUSTOMER_CREATED', 'Customer', id, getClientIp(req), {
        fullName: parsed.data.fullName,
      });
    }

    const created = db.prepare('SELECT * FROM customers WHERE id = ?').get(id);
    res.status(201).json({ customer: created });
  });

  app.patch('/api/customers/:id', requireAuth, requireRole(...FINANCE_ROLES, 'SUPPORT_STAFF'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Customer not found' });
    if (String(existing.business_id) !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const schema = z.object({
      fullName: z.string().min(2).max(120).optional(),
      phone: z.string().min(8).max(24).optional(),
      email: z.string().email().max(254).optional().nullable().or(z.literal('')),
      packageId: z.string().optional().nullable().or(z.literal('')),
      notes: z.string().max(500).optional().nullable(),
      isActive: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid customer update', issues: parsed.error.issues });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE customers
      SET full_name = COALESCE(?, full_name),
          phone = COALESCE(?, phone),
          email = CASE WHEN ? IS NOT NULL THEN ? ELSE email END,
          package_id = CASE WHEN ? IS NOT NULL THEN ? ELSE package_id END,
          notes = CASE WHEN ? IS NOT NULL THEN ? ELSE notes END,
          is_active = COALESCE(?, is_active),
          updated_at = ?
      WHERE id = ? AND business_id = ?
    `).run(
      parsed.data.fullName?.trim() ?? null,
      parsed.data.phone?.trim() ?? null,
      parsed.data.email !== undefined ? 'set' : null,
      parsed.data.email?.trim() || null,
      parsed.data.packageId !== undefined ? 'set' : null,
      parsed.data.packageId?.trim() || null,
      parsed.data.notes !== undefined ? 'set' : null,
      parsed.data.notes?.trim() || null,
      parsed.data.isActive !== undefined ? (parsed.data.isActive ? 1 : 0) : null,
      nowIso,
      req.params.id,
      scope.businessId
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'CUSTOMER_UPDATED', 'Customer', req.params.id, getClientIp(req));
    }

    const updated = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
    res.json({ customer: updated });
  });

  app.delete('/api/customers/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT id, business_id FROM customers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Customer not found' });
    if (existing.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const hasPayments = db.prepare('SELECT 1 FROM payments WHERE customer_id = ? LIMIT 1').get(req.params.id);
    if (hasPayments) {
      db.prepare('UPDATE customers SET is_active = 0, updated_at = ? WHERE id = ? AND business_id = ?').run(
        new Date().toISOString(),
        req.params.id,
        scope.businessId
      );
      if (req.actor) {
        recordAuditLog(db, req.actor, 'CUSTOMER_DEACTIVATED', 'Customer', req.params.id, getClientIp(req));
      }
      return res.json({ ok: true, mode: 'DEACTIVATED' });
    }

    db.prepare('DELETE FROM customers WHERE id = ? AND business_id = ?').run(req.params.id, scope.businessId);
    if (req.actor) {
      recordAuditLog(db, req.actor, 'CUSTOMER_DELETED', 'Customer', req.params.id, getClientIp(req));
    }
    res.json({ ok: true, mode: 'DELETED' });
  });

  // =========================================================================
  // PACKAGES (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/packages', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const rows = db
      .prepare(`
        SELECT id, business_id as businessId, location_id as locationId, name, description, category,
               package_type as packageType, price_tzs as priceTzs, currency,
               duration_minutes as durationMinutes, download_kbps as downloadKbps,
               upload_kbps as uploadKbps, data_limit_mb as dataLimitMb,
               device_limit as deviceLimit, simultaneous_sessions as simultaneousSessions,
               fup_policy as fupPolicy, validity_days as validityDays, is_active as isActive,
               created_at as createdAt, updated_at as updatedAt
        FROM packages
        WHERE business_id = ?
        ORDER BY price_tzs ASC
      `)
      .all(scope.businessId);
    res.json({ packages: rows });
  });

  app.post('/api/packages', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      name: z.string().min(2).max(80),
      description: z.string().max(300).optional().nullable(),
      category: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']),
      packageType: z.enum(['TIME_BASED', 'DATA_BASED', 'HYBRID', 'BANDWIDTH_PROFILE']).default('TIME_BASED'),
      priceTzs: z.number().int().min(0).max(100_000_000),
      currency: z.string().min(3).max(8).default('TZS'),
      durationMinutes: z.number().int().min(1).max(525_600),
      downloadKbps: z.number().int().min(64).max(10_000_000),
      uploadKbps: z.number().int().min(64).max(10_000_000),
      dataLimitMb: z.number().int().min(1).max(10_000_000).optional().nullable(),
      deviceLimit: z.number().int().min(1).max(50).default(1),
      simultaneousSessions: z.number().int().min(1).max(50).default(1),
      fupPolicy: z.string().max(240).optional().nullable(),
      locationId: z.string().max(64).optional().nullable(),
      validityDays: z.number().int().min(1).max(3650).default(30),
      isActive: z.boolean().default(true),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid package fields', issues: parsed.error.issues });
    }

    const dup = db
      .prepare('SELECT id FROM packages WHERE business_id = ? AND LOWER(name) = LOWER(?)')
      .get(scope.businessId, parsed.data.name.trim());
    if (dup) {
      return res.status(409).json({ error: 'A package with this name already exists in your workspace' });
    }

    const id = generateId('pkg');
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO packages (
        id, business_id, location_id, name, description, category, package_type, price_tzs, currency,
        duration_minutes, download_kbps, upload_kbps, data_limit_mb, device_limit, simultaneous_sessions,
        fup_policy, validity_days, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      scope.businessId,
      parsed.data.locationId?.trim() || null,
      parsed.data.name.trim(),
      parsed.data.description?.trim() || null,
      parsed.data.category,
      parsed.data.packageType,
      parsed.data.priceTzs,
      parsed.data.currency.toUpperCase(),
      parsed.data.durationMinutes,
      parsed.data.downloadKbps,
      parsed.data.uploadKbps,
      parsed.data.dataLimitMb ?? null,
      parsed.data.deviceLimit,
      parsed.data.simultaneousSessions,
      parsed.data.fupPolicy?.trim() || null,
      parsed.data.validityDays,
      parsed.data.isActive ? 1 : 0,
      nowIso,
      nowIso
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'PACKAGE_CREATED', 'Package', id, getClientIp(req), {
        name: parsed.data.name,
        priceTzs: parsed.data.priceTzs,
      });
    }

    const created = db
      .prepare(`
        SELECT id, business_id as businessId, location_id as locationId, name, description, category,
               package_type as packageType, price_tzs as priceTzs, currency,
               duration_minutes as durationMinutes, download_kbps as downloadKbps,
               upload_kbps as uploadKbps, data_limit_mb as dataLimitMb,
               device_limit as deviceLimit, simultaneous_sessions as simultaneousSessions,
               fup_policy as fupPolicy, validity_days as validityDays, is_active as isActive, created_at as createdAt
        FROM packages WHERE id = ?
      `)
      .get(id);
    res.status(201).json({ package: created });
  });

  app.patch('/api/packages/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT * FROM packages WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!existing) return res.status(404).json({ error: 'Package not found' });
    if (String(existing.business_id) !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const schema = z.object({
      name: z.string().min(2).max(80).optional(),
      description: z.string().max(300).optional().nullable(),
      category: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']).optional(),
      packageType: z.enum(['TIME_BASED', 'DATA_BASED', 'HYBRID', 'BANDWIDTH_PROFILE']).optional(),
      priceTzs: z.number().int().min(0).max(100_000_000).optional(),
      durationMinutes: z.number().int().min(1).max(525_600).optional(),
      downloadKbps: z.number().int().min(64).max(10_000_000).optional(),
      uploadKbps: z.number().int().min(64).max(10_000_000).optional(),
      dataLimitMb: z.number().int().min(1).max(10_000_000).optional().nullable(),
      deviceLimit: z.number().int().min(1).max(50).optional(),
      simultaneousSessions: z.number().int().min(1).max(50).optional(),
      fupPolicy: z.string().max(240).optional().nullable(),
      validityDays: z.number().int().min(1).max(3650).optional(),
      isActive: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid package update', issues: parsed.error.issues });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE packages
      SET name = COALESCE(?, name),
          description = CASE WHEN ? IS NOT NULL THEN ? ELSE description END,
          category = COALESCE(?, category),
          package_type = COALESCE(?, package_type),
          price_tzs = COALESCE(?, price_tzs),
          duration_minutes = COALESCE(?, duration_minutes),
          download_kbps = COALESCE(?, download_kbps),
          upload_kbps = COALESCE(?, upload_kbps),
          data_limit_mb = CASE WHEN ? IS NOT NULL THEN ? ELSE data_limit_mb END,
          device_limit = COALESCE(?, device_limit),
          simultaneous_sessions = COALESCE(?, simultaneous_sessions),
          fup_policy = CASE WHEN ? IS NOT NULL THEN ? ELSE fup_policy END,
          validity_days = COALESCE(?, validity_days),
          is_active = COALESCE(?, is_active),
          updated_at = ?
      WHERE id = ? AND business_id = ?
    `).run(
      parsed.data.name?.trim() ?? null,
      parsed.data.description !== undefined ? 'set' : null,
      parsed.data.description?.trim() || null,
      parsed.data.category ?? null,
      parsed.data.packageType ?? null,
      parsed.data.priceTzs ?? null,
      parsed.data.durationMinutes ?? null,
      parsed.data.downloadKbps ?? null,
      parsed.data.uploadKbps ?? null,
      parsed.data.dataLimitMb !== undefined ? 'set' : null,
      parsed.data.dataLimitMb ?? null,
      parsed.data.deviceLimit ?? null,
      parsed.data.simultaneousSessions ?? null,
      parsed.data.fupPolicy !== undefined ? 'set' : null,
      parsed.data.fupPolicy?.trim() || null,
      parsed.data.validityDays ?? null,
      parsed.data.isActive !== undefined ? (parsed.data.isActive ? 1 : 0) : null,
      nowIso,
      req.params.id,
      scope.businessId
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'PACKAGE_UPDATED', 'Package', req.params.id, getClientIp(req));
    }

    const updated = db
      .prepare(`
        SELECT id, business_id as businessId, name, description, category, package_type as packageType,
               price_tzs as priceTzs, currency, duration_minutes as durationMinutes, download_kbps as downloadKbps,
               upload_kbps as uploadKbps, data_limit_mb as dataLimitMb, device_limit as deviceLimit,
               simultaneous_sessions as simultaneousSessions, fup_policy as fupPolicy,
               validity_days as validityDays, is_active as isActive, updated_at as updatedAt
        FROM packages WHERE id = ?
      `)
      .get(req.params.id);
    res.json({ package: updated });
  });

  app.delete('/api/packages/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT id, business_id FROM packages WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Package not found' });
    if (existing.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const inUse = db.prepare('SELECT 1 FROM vouchers WHERE package_id = ? LIMIT 1').get(req.params.id);
    if (inUse) {
      db.prepare('UPDATE packages SET is_active = 0, updated_at = ? WHERE id = ? AND business_id = ?').run(
        new Date().toISOString(),
        req.params.id,
        scope.businessId
      );
      return res.json({ ok: true, mode: 'DEACTIVATED' });
    }

    db.prepare('DELETE FROM packages WHERE id = ? AND business_id = ?').run(req.params.id, scope.businessId);
    if (req.actor) {
      recordAuditLog(db, req.actor, 'PACKAGE_DELETED', 'Package', req.params.id, getClientIp(req));
    }
    res.json({ ok: true, mode: 'DELETED' });
  });

  // =========================================================================
  // VOUCHERS (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/vouchers', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    expireStaleRecords(db);
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    const packageId = typeof req.query.packageId === 'string' ? req.query.packageId : '';

    let sql = `
      SELECT v.id, v.code_encrypted, v.code_masked as codeMasked, v.batch_id as batchId,
             v.package_id as packageId, p.name as packageName, p.price_tzs as priceTzs,
             p.duration_minutes as durationMinutes, p.download_kbps as downloadKbps, p.upload_kbps as uploadKbps,
             v.customer_id as customerId, c.full_name as customerName,
             v.status, v.is_test as isTest, v.test_note as testNote, v.bound_device_id as boundDeviceId,
             v.bound_device_name as boundDeviceName,
             v.activated_at as activatedAt, v.expires_at as expiresAt,
             v.revoked_at as revokedAt, v.revoked_reason as revokedReason,
             v.created_at as createdAt
      FROM vouchers v
      JOIN packages p ON p.id = v.package_id
      LEFT JOIN customers c ON c.id = v.customer_id
      WHERE v.business_id = ?
    `;
    const params: string[] = [scope.businessId];
    if (status !== 'ALL') {
      sql += ' AND v.status = ?';
      params.push(status);
    }
    if (packageId) {
      sql += ' AND v.package_id = ?';
      params.push(packageId);
    }
    if (q) {
      sql += " AND (v.code_masked LIKE ? OR COALESCE(v.batch_id, '') LIKE ? OR p.name LIKE ? OR COALESCE(c.full_name, '') LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }
    sql += ' ORDER BY v.created_at DESC LIMIT 300';

    const rows = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const vouchers = rows.map((r) => {
      let printableCode: string | null = null;
      if (r.status === 'UNUSED') {
        try {
          printableCode = decryptVoucherCodeForAdmin(String(r.code_encrypted));
        } catch {
          printableCode = null;
        }
      }
      const { code_encrypted: _omit, isTest, ...rest } = r;
      return { ...rest, isTest: Boolean(isTest), code: printableCode };
    });

    res.json({ vouchers });
  });

  app.post('/api/vouchers/generate', requireAuth, requireRole(...FINANCE_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      packageId: z.string().min(1).max(64),
      count: z.number().int().min(1).max(500).default(1),
      customerId: z.string().optional().nullable().or(z.literal('')),
      isTest: z.boolean().optional().default(false),
      testNote: z.string().max(240).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid voucher generation request', issues: parsed.error.issues });
    }

    try {
      const result = createVoucherBatch(db, {
        packageId: parsed.data.packageId,
        count: parsed.data.count,
        customerId: parsed.data.customerId?.trim() || null,
        createdById: req.actor?.id ?? null,
        businessId: scope.businessId,
        isTest: parsed.data.isTest,
        testNote: parsed.data.testNote ?? null,
      });

      if (req.actor) {
        recordAuditLog(db, req.actor, 'VOUCHERS_GENERATED', 'Voucher', result.batchId || result.vouchers[0]?.id || null, getClientIp(req), {
          count: parsed.data.count,
          packageId: parsed.data.packageId,
          isTest: parsed.data.isTest,
        });
      }

      emitEvent(io, 'voucher:updated', { count: result.vouchers.length, batchId: result.batchId, businessId: scope.businessId });
      res.status(201).json(result);
    } catch (err) {
      if (err instanceof VoucherError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      throw err;
    }
  });

  app.post('/api/vouchers/:id/revoke', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      reason: z.string().min(2).max(240).default('Revoked by administrator'),
    });
    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid revocation reason' });
    }

    const voucher = db.prepare('SELECT * FROM vouchers WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
    if (String(voucher.business_id) !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const nowIso = new Date().toISOString();
    const activeSessions = db
      .prepare("SELECT id, router_id, ip_address FROM sessions WHERE voucher_id = ? AND status = 'ACTIVE'")
      .all(req.params.id) as Array<{ id: string; router_id: string | null; ip_address: string | null }>;

    withTransaction(db, () => {
      db.prepare(`
        UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = ?, updated_at = ?
        WHERE id = ? AND business_id = ?
      `).run(nowIso, parsed.data.reason, nowIso, req.params.id, scope.businessId);

      db.prepare(`
        UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = ?
        WHERE voucher_id = ? AND status = 'ACTIVE'
      `).run(nowIso, `Voucher revoked: ${parsed.data.reason}`, req.params.id);

      db.prepare(`
        UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ?
        WHERE voucher_id = ? AND status = 'ACTIVE'
      `).run(nowIso, nowIso, req.params.id);
    });

    for (const s of activeSessions) {
      if (s.router_id && s.ip_address) {
        await terminateRouterSession(db, s.router_id, s.ip_address);
      }
    }

    if (req.actor) {
      recordAuditLog(db, req.actor, 'VOUCHER_REVOKED', 'Voucher', req.params.id, getClientIp(req), {
        reason: parsed.data.reason,
      });
    }

    emitEvent(io, 'voucher:updated', { voucherId: req.params.id, status: 'REVOKED', businessId: scope.businessId });
    res.json({ ok: true });
  });

  app.get('/api/vouchers/:id/redemptions', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const voucher = db.prepare('SELECT id, business_id FROM vouchers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!voucher) return res.status(404).json({ error: 'Voucher not found' });
    if (voucher.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const rows = db
      .prepare(`
        SELECT r.id, r.ip_address as ipAddress, r.success, r.reason, r.redeemed_at as redeemedAt,
               d.device_label as deviceLabel, d.device_fingerprint as deviceFingerprint, d.mac_address as macAddress
        FROM voucher_redemptions r
        JOIN devices d ON d.id = r.device_id
        WHERE r.voucher_id = ?
        ORDER BY r.redeemed_at DESC
      `)
      .all(req.params.id);
    res.json({ redemptions: rows });
  });

  app.get('/api/vouchers/export/csv', requireAuth, requireRole(...FINANCE_ROLES, 'SUPPORT_STAFF'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    const sql =
      status === 'ALL'
        ? 'SELECT v.*, p.name as package_name, p.price_tzs FROM vouchers v JOIN packages p ON p.id = v.package_id WHERE v.business_id = ? ORDER BY v.created_at DESC'
        : 'SELECT v.*, p.name as package_name, p.price_tzs FROM vouchers v JOIN packages p ON p.id = v.package_id WHERE v.business_id = ? AND v.status = ? ORDER BY v.created_at DESC';
    const rows = (status === 'ALL' ? db.prepare(sql).all(scope.businessId) : db.prepare(sql).all(scope.businessId, status)) as Array<
      Record<string, unknown>
    >;

    const lines = ['ID,Code,Masked,Package,Price_TZS,Status,Batch_ID,Created_At,Expires_At'];
    for (const r of rows) {
      let code = String(r.code_masked);
      if (r.status === 'UNUSED') {
        try {
          code = decryptVoucherCodeForAdmin(String(r.code_encrypted));
        } catch {
          code = String(r.code_masked);
        }
      }
      lines.push(
        [
          r.id,
          code,
          r.code_masked,
          r.package_name,
          r.price_tzs,
          r.status,
          r.batch_id || '',
          r.created_at,
          r.expires_at || '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="traxlink-vouchers.csv"');
    res.send(lines.join('\n'));
  });

  // =========================================================================
  // SESSIONS & NETWORK ACCESS CONTROL (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/sessions', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    expireStaleRecords(db);
    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    let sql = `
      SELECT s.id, s.status, s.ip_address as ipAddress, s.bytes_in as bytesIn, s.bytes_out as bytesOut,
             s.started_at as startedAt, s.expires_at as expiresAt, s.ended_at as endedAt, s.end_reason as endReason,
             v.id as voucherId, v.code_masked as codeMasked,
             p.name as packageName, p.download_kbps as downloadKbps, p.upload_kbps as uploadKbps,
             d.id as deviceId, d.device_fingerprint as deviceFingerprint, d.mac_address as macAddress, d.device_label as deviceLabel,
             c.full_name as customerName, r.name as routerName
      FROM sessions s
      JOIN vouchers v ON v.id = s.voucher_id
      JOIN packages p ON p.id = v.package_id
      JOIN devices d ON d.id = s.device_id
      LEFT JOIN customers c ON c.id = s.customer_id
      LEFT JOIN routers r ON r.id = s.router_id
      WHERE s.business_id = ?
    `;
    const params: string[] = [scope.businessId];
    if (status !== 'ALL') {
      sql += ' AND s.status = ?';
      params.push(status);
    }
    sql += ' ORDER BY s.started_at DESC LIMIT 250';
    const sessions = db.prepare(sql).all(...params);
    res.json({ sessions });
  });

  app.post('/api/sessions/:id/terminate', requireAuth, requireRole(...NETWORK_ROLES), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!session) return res.status(404).json({ error: 'Session not found' });
    if (String(session.business_id) !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = 'Terminated by administrator'
      WHERE id = ? AND status = 'ACTIVE' AND business_id = ?
    `).run(nowIso, req.params.id, scope.businessId);

    let routerResult: { removed: boolean; detail: string } | null = null;
    if (session.router_id && session.ip_address) {
      routerResult = await terminateRouterSession(db, String(session.router_id), String(session.ip_address));
    }

    if (req.actor) {
      recordAuditLog(db, req.actor, 'SESSION_TERMINATED', 'Session', req.params.id, getClientIp(req), {
        routerResult,
      });
    }

    emitEvent(io, 'session:ended', { sessionId: req.params.id, reason: 'Admin terminated', businessId: scope.businessId });
    res.json({ ok: true, routerResult });
  });

  app.post('/api/sessions/expire-sweep', requireAuth, requireRole(...NETWORK_ROLES), (_req, res) => {
    const result = expireStaleRecords(db);
    if (result.expiredSessions > 0 || result.expiredSubscriptions > 0) {
      emitEvent(io, 'session:ended', { expiredCount: result.expiredSessions });
    }
    res.json(result);
  });

  // =========================================================================
  // PAYMENTS (TENANT WIFI REVENUE LEDGER — ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/payments/providers', requireAuth, (_req, res) => {
    res.json({ providers: getProviderStatuses() });
  });

  app.get('/api/payments', requireAuth, requireRole(...FINANCE_ROLES, 'SUPPORT_STAFF'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const status = typeof req.query.status === 'string' ? req.query.status : 'ALL';
    const provider = typeof req.query.provider === 'string' ? req.query.provider : 'ALL';
    let sql = `
      SELECT p.id, p.reference, p.receipt_number as receiptNumber, p.provider,
             p.phone_number as phoneNumber, p.amount_tzs as amountTzs,
             p.status, p.is_test as isTest, p.payment_mode as paymentMode,
             p.external_tx_id as externalTxId, p.verified_at as verifiedAt,
             p.refunded_at as refundedAt, p.created_at as createdAt,
             pk.name as packageName, v.code_masked as voucherMasked,
             c.full_name as customerName
      FROM payments p
      JOIN packages pk ON pk.id = p.package_id
      LEFT JOIN vouchers v ON v.id = p.voucher_id
      LEFT JOIN customers c ON c.id = p.customer_id
      WHERE p.business_id = ?
    `;
    const params: string[] = [scope.businessId];
    if (status !== 'ALL') {
      sql += ' AND p.status = ?';
      params.push(status);
    }
    if (provider !== 'ALL') {
      sql += ' AND p.provider = ?';
      params.push(provider);
    }
    sql += ' ORDER BY p.created_at DESC LIMIT 300';
    const rawPayments = db.prepare(sql).all(...params) as Array<Record<string, unknown>>;
    const payments = rawPayments.map((p) => ({
      ...p,
      isTest: Boolean(p.isTest),
    }));
    res.json({ payments });
  });

  app.post('/api/payments/:id/refund', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES, 'ACCOUNTANT'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (String(payment.business_id) !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }
    if (payment.status !== 'COMPLETED') {
      return res.status(400).json({ error: 'Only completed payments can be marked refunded' });
    }

    const nowIso = new Date().toISOString();
    withTransaction(db, () => {
      db.prepare("UPDATE payments SET status = 'REFUNDED', refunded_at = ?, updated_at = ? WHERE id = ? AND business_id = ?").run(
        nowIso,
        nowIso,
        req.params.id,
        scope.businessId
      );
      if (payment.voucher_id) {
        db.prepare(`
          UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'Payment refunded', updated_at = ?
          WHERE id = ? AND status != 'REVOKED'
        `).run(nowIso, nowIso, String(payment.voucher_id));
      }
      db.prepare("UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE payment_id = ?").run(
        nowIso,
        nowIso,
        req.params.id
      );
    });

    if (req.actor) {
      recordAuditLog(db, req.actor, 'PAYMENT_REFUNDED', 'Payment', req.params.id, getClientIp(req), {
        reference: payment.reference,
      });
    }
    emitEvent(io, 'payment:updated', { reference: payment.reference, status: 'REFUNDED', businessId: scope.businessId });
    res.json({ ok: true });
  });

  // =========================================================================
  // MIKROTIK ROUTERS (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/routers', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const routers = db
      .prepare(`
        SELECT r.id, r.business_id as businessId, r.location_id as locationId, l.name as locationName,
               r.name, r.host, r.api_port as apiPort, r.use_tls as useTls, r.username,
               r.hotspot_server as hotspotServer, r.router_os_family as routerOsFamily,
               r.wireguard_pubkey as wireguardPubkey, r.status, r.cpu_load as cpuLoad,
               r.memory_used_bytes as memoryUsedBytes, r.memory_total_bytes as memoryTotalBytes,
               r.uptime, r.router_os_version as routerOsVersion, r.board_name as boardName,
               r.last_error as lastError, r.last_checked_at as lastCheckedAt, r.created_at as createdAt
        FROM routers r
        LEFT JOIN locations l ON l.id = r.location_id
        WHERE r.business_id = ?
        ORDER BY r.created_at DESC
      `)
      .all(scope.businessId);
    res.json({ routers });
  });

  app.post('/api/routers', requireAuth, requireRole(...NETWORK_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      name: z.string().min(2).max(80),
      host: z.string().max(255).optional().default(''),
      apiPort: z.number().int().min(1).max(65535).optional().default(8728),
      useTls: z.boolean().optional().default(false),
      username: z.string().max(80).optional().default(''),
      password: z.string().max(128).optional().default(''),
      hotspotServer: z.string().max(80).optional().default(''),
      locationId: z.string().max(64).optional().nullable(),
      routerOsFamily: z.enum(['ROUTEROS_V6', 'ROUTEROS_V7']).optional().default('ROUTEROS_V7'),
      wireguardPubkey: z.string().max(128).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid router configuration', issues: parsed.error.issues });
    }

    const cleanHost = parsed.data.host.trim();
    if (cleanHost === '8.8.8.8') {
      return res.status(400).json({ error: '8.8.8.8 is a public DNS IP and cannot be used as a MikroTik router address.' });
    }

    const dupByName = db
      .prepare('SELECT id FROM routers WHERE business_id = ? AND LOWER(name) = LOWER(?)')
      .get(scope.businessId, parsed.data.name.trim());
    if (dupByName) {
      return res.status(409).json({ error: 'A router with this name already exists in your workspace' });
    }
    if (cleanHost) {
      const dupByHost = db
        .prepare('SELECT id FROM routers WHERE business_id = ? AND host = ? AND api_port = ?')
        .get(scope.businessId, cleanHost, parsed.data.apiPort);
      if (dupByHost) {
        return res.status(409).json({ error: 'A router with this host and port already exists' });
      }
    } else {
      const unconfigured = db
        .prepare("SELECT id FROM routers WHERE business_id = ? AND host = '' AND api_port = ?")
        .get(scope.businessId, parsed.data.apiPort);
      if (unconfigured) {
        return res.status(409).json({ error: 'An unconfigured router profile already exists. Edit it to add hardware details.' });
      }
    }

    const id = generateId('rtr');
    const nowIso = new Date().toISOString();
    const cleanPass = parsed.data.password.trim();
    const radiusSecret = crypto.randomBytes(12).toString('hex');

    db.prepare(`
      INSERT INTO routers (
        id, business_id, location_id, name, host, api_port, use_tls, username, password_encrypted,
        hotspot_server, router_os_family, wireguard_pubkey, radius_secret, status, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'NOT_CONNECTED', ?, ?, ?)
    `).run(
      id,
      scope.businessId,
      parsed.data.locationId?.trim() || null,
      parsed.data.name.trim(),
      cleanHost,
      parsed.data.apiPort,
      parsed.data.useTls ? 1 : 0,
      parsed.data.username.trim(),
      cleanPass ? encryptSecret(cleanPass) : '',
      parsed.data.hotspotServer.trim(),
      parsed.data.routerOsFamily,
      parsed.data.wireguardPubkey?.trim() || null,
      radiusSecret,
      cleanHost ? null : 'Awaiting MikroTik hardware credentials',
      nowIso,
      nowIso
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'ROUTER_ADDED', 'Router', id, getClientIp(req), {
        name: parsed.data.name,
        host: cleanHost || null,
        apiPort: parsed.data.apiPort,
      });
    }

    const router = db
      .prepare(`
        SELECT id, business_id as businessId, location_id as locationId, name, host, api_port as apiPort, use_tls as useTls, username,
               hotspot_server as hotspotServer, router_os_family as routerOsFamily, status, last_error as lastError, created_at as createdAt
        FROM routers WHERE id = ?
      `)
      .get(id);
    res.status(201).json({ router });
  });

  app.patch('/api/routers/:id', requireAuth, requireRole(...NETWORK_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT id, business_id FROM routers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Router not found' });
    if (existing.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const schema = z.object({
      name: z.string().min(2).max(80).optional(),
      host: z.string().max(255).optional(),
      apiPort: z.number().int().min(1).max(65535).optional(),
      useTls: z.boolean().optional(),
      username: z.string().max(80).optional(),
      password: z.string().max(128).optional(),
      hotspotServer: z.string().max(80).optional(),
      locationId: z.string().max(64).optional().nullable(),
      routerOsFamily: z.enum(['ROUTEROS_V6', 'ROUTEROS_V7']).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid router update', issues: parsed.error.issues });
    }

    if (parsed.data.host?.trim() === '8.8.8.8') {
      return res.status(400).json({ error: '8.8.8.8 is a public DNS IP and cannot be used as a MikroTik router address.' });
    }

    const nowIso = new Date().toISOString();
    db.prepare(`
      UPDATE routers
      SET name = COALESCE(?, name),
          host = COALESCE(?, host),
          api_port = COALESCE(?, api_port),
          use_tls = COALESCE(?, use_tls),
          username = COALESCE(?, username),
          password_encrypted = COALESCE(?, password_encrypted),
          hotspot_server = COALESCE(?, hotspot_server),
          location_id = CASE WHEN ? IS NOT NULL THEN ? ELSE location_id END,
          router_os_family = COALESCE(?, router_os_family),
          updated_at = ?
      WHERE id = ? AND business_id = ?
    `).run(
      parsed.data.name?.trim() ?? null,
      parsed.data.host !== undefined ? parsed.data.host.trim() : null,
      parsed.data.apiPort ?? null,
      parsed.data.useTls !== undefined ? (parsed.data.useTls ? 1 : 0) : null,
      parsed.data.username !== undefined ? parsed.data.username.trim() : null,
      parsed.data.password !== undefined && parsed.data.password.trim()
        ? encryptSecret(parsed.data.password.trim())
        : null,
      parsed.data.hotspotServer !== undefined ? parsed.data.hotspotServer.trim() : null,
      parsed.data.locationId !== undefined ? 'set' : null,
      parsed.data.locationId?.trim() || null,
      parsed.data.routerOsFamily ?? null,
      nowIso,
      req.params.id,
      scope.businessId
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'ROUTER_UPDATED', 'Router', req.params.id, getClientIp(req));
    }

    const updated = db
      .prepare(`
        SELECT id, business_id as businessId, location_id as locationId, name, host, api_port as apiPort, use_tls as useTls, username,
               hotspot_server as hotspotServer, router_os_family as routerOsFamily, status, last_error as lastError
        FROM routers WHERE id = ?
      `)
      .get(req.params.id);
    res.json({ router: updated });
  });

  app.delete('/api/routers/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT id, business_id, name FROM routers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string; name: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Router not found' });
    if (existing.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    db.prepare('DELETE FROM routers WHERE id = ? AND business_id = ?').run(req.params.id, scope.businessId);
    if (req.actor) {
      recordAuditLog(db, req.actor, 'ROUTER_REMOVED', 'Router', req.params.id, getClientIp(req), {
        name: existing.name,
      });
    }
    res.json({ ok: true });
  });

  app.post('/api/routers/:id/test', requireAuth, requireRole(...NETWORK_ROLES), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const routerRow = db.prepare('SELECT id, business_id FROM routers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!routerRow) return res.status(404).json({ error: 'Router not found' });
    if (routerRow.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    try {
      const telemetry = await syncRouterTelemetry(db, req.params.id);
      const updated = db
        .prepare(`
          SELECT id, name, host, api_port as apiPort, use_tls as useTls, username,
                 hotspot_server as hotspotServer, router_os_family as routerOsFamily, status, cpu_load as cpuLoad,
                 memory_used_bytes as memoryUsedBytes, memory_total_bytes as memoryTotalBytes,
                 uptime, router_os_version as routerOsVersion, board_name as boardName,
                 last_error as lastError, last_checked_at as lastCheckedAt
          FROM routers WHERE id = ?
        `)
        .get(req.params.id);

      if (req.actor) {
        recordAuditLog(db, req.actor, 'ROUTER_CONNECTION_TEST', 'Router', req.params.id, getClientIp(req), {
          connected: telemetry.connected,
          error: telemetry.error ?? null,
        });
      }

      emitEvent(io, 'router:status', { routerId: req.params.id, connected: telemetry.connected, businessId: scope.businessId });
      res.json({ router: updated, telemetry });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Router not found' });
    }
  });

  app.get('/api/routers/:id/interfaces', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const routerRow = db.prepare('SELECT id, business_id FROM routers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!routerRow) return res.status(404).json({ error: 'Router not found' });
    if (routerRow.business_id !== scope.businessId) return res.status(403).json({ error: 'Cross-tenant access denied' });

    const interfaces = db
      .prepare(`
        SELECT id, name, type, running, disabled, rx_bytes as rxBytes, tx_bytes as txBytes, updated_at as updatedAt
        FROM router_interfaces
        WHERE router_id = ?
        ORDER BY name ASC
      `)
      .all(req.params.id);
    res.json({ interfaces });
  });

  app.post('/api/routers/:id/sync-profiles', requireAuth, requireRole(...NETWORK_ROLES), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const routerRow = db.prepare('SELECT id, business_id FROM routers WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!routerRow) return res.status(404).json({ error: 'Router not found' });
    if (routerRow.business_id !== scope.businessId) return res.status(403).json({ error: 'Cross-tenant access denied' });

    const packages = db
      .prepare('SELECT * FROM packages WHERE is_active = 1 AND business_id = ?')
      .all(scope.businessId) as Array<Record<string, unknown>>;
    const results = [];
    for (const pkg of packages) {
      const r = await pushHotspotProfileToRouter(
        db,
        req.params.id,
        `trax-${String(pkg.id)}`,
        Number(pkg.download_kbps),
        Number(pkg.upload_kbps)
      );
      results.push({ packageName: pkg.name, ...r });
    }
    if (req.actor) {
      recordAuditLog(db, req.actor, 'ROUTER_PROFILES_SYNCED', 'Router', req.params.id, getClientIp(req), {
        count: results.length,
      });
    }
    res.json({ results });
  });

  // =========================================================================
  // REPORTS & ANALYTICS (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/reports/overview', requireAuth, requireRole(...FINANCE_ROLES, 'NETWORK_OPERATOR'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const from = typeof req.query.from === 'string' && req.query.from ? req.query.from : '1970-01-01T00:00:00.000Z';
    const to = typeof req.query.to === 'string' && req.query.to ? req.query.to : '2999-12-31T23:59:59.999Z';

    const revenueByProvider = db
      .prepare(`
        SELECT provider, COUNT(*) as txCount, COALESCE(SUM(amount_tzs), 0) as totalTzs
        FROM payments
        WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 0 AND verified_at >= ? AND verified_at <= ?
        GROUP BY provider
      `)
      .all(scope.businessId, from, to);

    const testStatsRow = db
      .prepare(`
        SELECT COUNT(*) as testTokensIssued, COALESCE(SUM(amount_tzs), 0) as testNominalTzs
        FROM payments
        WHERE business_id = ? AND status = 'COMPLETED' AND is_test = 1 AND verified_at >= ? AND verified_at <= ?
      `)
      .get(scope.businessId, from, to) as { testTokensIssued: number; testNominalTzs: number };

    const testVouchersRow = db
      .prepare('SELECT COUNT(*) as testVouchersCount FROM vouchers WHERE business_id = ? AND is_test = 1 AND created_at >= ? AND created_at <= ?')
      .get(scope.businessId, from, to) as { testVouchersCount: number };

    const packageSales = db
      .prepare(`
        SELECT pk.name as packageName, pk.category, pk.price_tzs as unitPriceTzs,
               COUNT(v.id) as vouchersIssued,
               SUM(CASE WHEN v.status IN ('ACTIVE','EXPIRED') THEN 1 ELSE 0 END) as vouchersRedeemed
        FROM packages pk
        LEFT JOIN vouchers v ON v.package_id = pk.id AND v.created_at >= ? AND v.created_at <= ?
        WHERE pk.business_id = ?
        GROUP BY pk.id
        ORDER BY vouchersIssued DESC
      `)
      .all(from, to, scope.businessId);

    const sessionStats = db
      .prepare(`
        SELECT status, COUNT(*) as count,
               COALESCE(SUM(bytes_in), 0) as totalRxBytes,
               COALESCE(SUM(bytes_out), 0) as totalTxBytes
        FROM sessions
        WHERE business_id = ? AND started_at >= ? AND started_at <= ?
        GROUP BY status
      `)
      .all(scope.businessId, from, to);

    res.json({
      revenueByProvider,
      testSummary: {
        testVouchersCount: Number(testVouchersRow?.testVouchersCount || 0),
        testTokensIssued: Number(testStatsRow?.testTokensIssued || 0),
        testNominalTzs: Number(testStatsRow?.testNominalTzs || 0),
      },
      packageSales,
      sessionStats,
    });
  });

  app.get('/api/reports/export/csv', requireAuth, requireRole(...FINANCE_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const type = typeof req.query.type === 'string' ? req.query.type : 'payments';
    if (type === 'sessions') {
      const rows = db
        .prepare(`
          SELECT s.id, v.code_masked, p.name as package_name, d.device_label, s.ip_address,
                 s.status, s.bytes_in, s.bytes_out, s.started_at, s.expires_at, s.ended_at
          FROM sessions s
          JOIN vouchers v ON v.id = s.voucher_id
          JOIN packages p ON p.id = v.package_id
          JOIN devices d ON d.id = s.device_id
          WHERE s.business_id = ?
          ORDER BY s.started_at DESC
        `)
        .all(scope.businessId) as Array<Record<string, unknown>>;
      const lines = ['Session_ID,Voucher,Package,Device,IP,Status,Bytes_In,Bytes_Out,Started_At,Expires_At,Ended_At'];
      for (const r of rows) {
        lines.push(
          [r.id, r.code_masked, r.package_name, r.device_label || '', r.ip_address || '', r.status, r.bytes_in, r.bytes_out, r.started_at, r.expires_at, r.ended_at || '']
            .map(csvEscape)
            .join(',')
        );
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="traxlink-sessions-report.csv"');
      return res.send(lines.join('\n'));
    }

    const rows = db
      .prepare(`
        SELECT p.reference, p.receipt_number, p.provider, p.phone_number, p.amount_tzs,
               p.status, p.is_test, p.payment_mode, pk.name as package_name, p.verified_at, p.created_at
        FROM payments p
        JOIN packages pk ON pk.id = p.package_id
        WHERE p.business_id = ?
        ORDER BY p.created_at DESC
      `)
      .all(scope.businessId) as Array<Record<string, unknown>>;
    const lines = ['Reference,Receipt,Provider,Phone,Amount_TZS,Status,Mode,Package,Verified_At,Created_At'];
    for (const r of rows) {
      const modeLabel = r.is_test ? 'TEST_STANDALONE' : 'LIVE_VERIFIED';
      lines.push(
        [r.reference, r.receipt_number || '', r.provider, r.phone_number, r.amount_tzs, r.status, modeLabel, r.package_name, r.verified_at || '', r.created_at]
          .map(csvEscape)
          .join(',')
      );
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="traxlink-payments-report.csv"');
    res.send(lines.join('\n'));
  });

  // =========================================================================
  // NOTIFICATIONS (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/notifications', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const notifications = db
      .prepare(`
        SELECT id, type, severity, title, message, metadata, is_read as isRead, created_at as createdAt
        FROM notifications
        WHERE business_id = ?
        ORDER BY created_at DESC
        LIMIT 100
      `)
      .all(scope.businessId);
    res.json({ notifications });
  });

  app.post('/api/notifications/:id/read', requireAuth, (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND business_id = ?').run(req.params.id, scope.businessId);
    res.json({ ok: true });
  });

  app.post('/api/notifications/read-all', requireAuth, (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    db.prepare('UPDATE notifications SET is_read = 1 WHERE is_read = 0 AND business_id = ?').run(scope.businessId);
    res.json({ ok: true });
  });

  // =========================================================================
  // STAFF, RBAC & AUDIT LOGS (ISOLATED BY business_id)
  // =========================================================================
  app.get('/api/staff', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const staff = db
      .prepare(`
        SELECT u.id, u.email, u.full_name as fullName, u.role, u.is_active as isActive,
               u.last_login_at as lastLoginAt, u.created_at as createdAt,
               s.staff_code as staffCode, s.department, s.phone, s.is_suspended as isSuspended
        FROM admin_users u
        LEFT JOIN staff s ON s.admin_user_id = u.id
        WHERE u.business_id = ?
        ORDER BY u.created_at DESC
      `)
      .all(scope.businessId);
    res.json({ staff });
  });

  app.post('/api/staff', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      email: z.string().email().max(254),
      fullName: z.string().min(2).max(100),
      password: z.string().min(8).max(128),
      role: z.enum([
        'SUPER_ADMIN',
        'BUSINESS_OWNER',
        'ADMIN',
        'ACCOUNTANT',
        'NETWORK_OPERATOR',
        'SUPPORT_STAFF',
        'CASHIER',
      ]),
      department: z.string().min(2).max(80).default('Operations'),
      phone: z.string().max(24).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid staff account payload', issues: parsed.error.issues });
    }

    if (parsed.data.role === 'SUPER_ADMIN' && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only a Super Admin can create another Super Admin' });
    }

    const emailLower = parsed.data.email.toLowerCase();
    const dup = db.prepare('SELECT id FROM admin_users WHERE LOWER(email) = ?').get(emailLower);
    if (dup) {
      return res.status(409).json({ error: 'A staff account with this email already exists' });
    }

    const id = generateId('adm');
    const staffCode = generateReference('STF');
    const nowIso = new Date().toISOString();

    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        scope.businessId,
        emailLower,
        parsed.data.fullName.trim(),
        hashPassword(parsed.data.password),
        parsed.data.role,
        nowIso,
        nowIso
      );

      db.prepare(`
        INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, phone, role, is_suspended)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        generateId('stf'),
        scope.businessId,
        id,
        staffCode,
        parsed.data.department.trim(),
        parsed.data.phone?.trim() || null,
        parsed.data.role
      );
    });

    if (req.actor) {
      recordAuditLog(db, req.actor, 'STAFF_CREATED', 'Staff', id, getClientIp(req), {
        email: emailLower,
        role: parsed.data.role,
      });
    }

    res.status(201).json({
      staff: {
        id,
        businessId: scope.businessId,
        email: emailLower,
        fullName: parsed.data.fullName.trim(),
        role: parsed.data.role,
        staffCode,
        department: parsed.data.department.trim(),
      },
    });
  });

  app.patch('/api/staff/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const target = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!target) return res.status(404).json({ error: 'Staff user not found' });
    if (String(target.business_id) !== scope.businessId && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    const schema = z.object({
      role: z
        .enum(['SUPER_ADMIN', 'BUSINESS_OWNER', 'ADMIN', 'ACCOUNTANT', 'NETWORK_OPERATOR', 'SUPPORT_STAFF', 'CASHIER'])
        .optional(),
      isSuspended: z.boolean().optional(),
      department: z.string().min(2).max(80).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid staff update' });
    }

    if ((target.role === 'SUPER_ADMIN' || parsed.data.role === 'SUPER_ADMIN') && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only Super Admin can modify a Super Admin account' });
    }
    if (req.params.id === req.actor?.id && parsed.data.isSuspended) {
      return res.status(400).json({ error: 'You cannot suspend your own account' });
    }

    const nowIso = new Date().toISOString();
    withTransaction(db, () => {
      if (parsed.data.role) {
        db.prepare('UPDATE admin_users SET role = ?, updated_at = ? WHERE id = ?').run(
          parsed.data.role,
          nowIso,
          req.params.id
        );
        db.prepare('UPDATE staff SET role = ?, updated_at = ? WHERE admin_user_id = ?').run(
          parsed.data.role,
          nowIso,
          req.params.id
        );
      }
      if (parsed.data.isSuspended !== undefined) {
        db.prepare('UPDATE admin_users SET is_active = ?, updated_at = ? WHERE id = ?').run(
          parsed.data.isSuspended ? 0 : 1,
          nowIso,
          req.params.id
        );
        db.prepare('UPDATE staff SET is_suspended = ?, updated_at = ? WHERE admin_user_id = ?').run(
          parsed.data.isSuspended ? 1 : 0,
          nowIso,
          req.params.id
        );
        if (parsed.data.isSuspended) {
          db.prepare('UPDATE staff_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL').run(
            nowIso,
            req.params.id
          );
        }
      }
      if (parsed.data.department) {
        db.prepare('UPDATE staff SET department = ?, updated_at = ? WHERE admin_user_id = ?').run(
          parsed.data.department.trim(),
          nowIso,
          req.params.id
        );
      }
    });

    if (req.actor) {
      recordAuditLog(db, req.actor, 'STAFF_UPDATED', 'Staff', req.params.id, getClientIp(req), parsed.data);
    }
    res.json({ ok: true });
  });

  app.post('/api/staff/:id/reset-password', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({ newPassword: z.string().min(8).max(128) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'New password must be at least 8 characters' });
    }

    const target = db.prepare('SELECT id, business_id, role FROM admin_users WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string; role: StaffRole }
      | undefined;
    if (!target) return res.status(404).json({ error: 'Staff user not found' });
    if (target.business_id !== scope.businessId && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }
    if (target.role === 'SUPER_ADMIN' && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only Super Admin can reset a Super Admin password' });
    }

    const nowIso = new Date().toISOString();
    db.prepare('UPDATE admin_users SET password_hash = ?, updated_at = ? WHERE id = ?').run(
      hashPassword(parsed.data.newPassword),
      nowIso,
      req.params.id
    );
    db.prepare('UPDATE staff_sessions SET revoked_at = ? WHERE admin_user_id = ? AND revoked_at IS NULL').run(
      nowIso,
      req.params.id
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'STAFF_PASSWORD_RESET', 'Staff', req.params.id, getClientIp(req));
    }
    res.json({ ok: true });
  });

  app.post('/api/staff/:id/recovery-code', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const target = db.prepare('SELECT id, business_id, email, role, is_active FROM admin_users WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string; email: string; role: StaffRole; is_active: number }
      | undefined;
    if (!target || !target.is_active) {
      return res.status(404).json({ error: 'Active staff user not found' });
    }
    if (target.business_id !== scope.businessId && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }
    if (target.role === 'SUPER_ADMIN' && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Only Super Admin can issue a recovery code for a Super Admin' });
    }

    const rawCode = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formattedCode = `${rawCode.slice(0, 4)}-${rawCode.slice(4, 8)}`;
    const nowIso = new Date().toISOString();
    const expiresAt = new Date(Date.now() + 15 * 60_000).toISOString();

    withTransaction(db, () => {
      db.prepare('UPDATE password_reset_tokens SET used_at = ? WHERE admin_user_id = ? AND used_at IS NULL').run(
        nowIso,
        target.id
      );
      db.prepare(`
        INSERT INTO password_reset_tokens (id, admin_user_id, token_hash, expires_at, requested_ip)
        VALUES (?, ?, ?, ?, ?)
      `).run(generateId('prt'), target.id, sha256(rawCode), expiresAt, getClientIp(req));
    });

    if (req.actor) {
      recordAuditLog(db, req.actor, 'STAFF_RECOVERY_CODE_ISSUED', 'Staff', target.id, getClientIp(req), {
        targetEmail: target.email,
      });
    }

    res.json({ code: formattedCode, expiresAt, email: target.email });
  });

  app.get('/api/staff/sessions', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const sessions = db
      .prepare(`
        SELECT ss.id, ss.ip_address as ipAddress, ss.user_agent as userAgent,
               ss.expires_at as expiresAt, ss.revoked_at as revokedAt, ss.created_at as createdAt,
               u.email, u.full_name as fullName, u.role
        FROM staff_sessions ss
        JOIN admin_users u ON u.id = ss.admin_user_id
        WHERE u.business_id = ?
        ORDER BY ss.created_at DESC
        LIMIT 100
      `)
      .all(scope.businessId);
    res.json({ sessions });
  });

  app.post('/api/staff/sessions/:id/revoke', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const target = db
      .prepare('SELECT ss.id, u.business_id FROM staff_sessions ss JOIN admin_users u ON u.id = ss.admin_user_id WHERE ss.id = ?')
      .get(req.params.id) as { id: string; business_id: string } | undefined;
    if (!target) return res.status(404).json({ error: 'Staff session not found' });
    if (target.business_id !== scope.businessId && req.actor?.role !== 'SUPER_ADMIN') {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    db.prepare('UPDATE staff_sessions SET revoked_at = ? WHERE id = ?').run(
      new Date().toISOString(),
      req.params.id
    );
    if (req.actor) {
      recordAuditLog(db, req.actor, 'STAFF_SESSION_REVOKED', 'StaffSession', req.params.id, getClientIp(req));
    }
    res.json({ ok: true });
  });

  app.get('/api/audit-logs', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const action = typeof req.query.action === 'string' ? req.query.action.trim() : '';
    const sql = action
      ? 'SELECT * FROM audit_logs WHERE business_id = ? AND action LIKE ? ORDER BY created_at DESC LIMIT 200'
      : 'SELECT * FROM audit_logs WHERE business_id = ? ORDER BY created_at DESC LIMIT 200';
    const logs = action ? db.prepare(sql).all(scope.businessId, `%${action}%`) : db.prepare(sql).all(scope.businessId);
    res.json({ logs });
  });

  app.use(
    (
      err: Error & { status?: number; statusCode?: number; type?: string },
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction
    ) => {
      if (err?.type === 'entity.parse.failed') {
        return res.status(400).json({ error: 'Invalid JSON request payload' });
      }
      const status = err.statusCode || err.status || 500;
      const message = status >= 500 ? 'Internal server error' : err.message || 'Request failed';
      if (status >= 500) {
        console.error('Unhandled API error:', err);
      }
      res.status(status).json({ error: message });
    }
  );

  return app;
}
