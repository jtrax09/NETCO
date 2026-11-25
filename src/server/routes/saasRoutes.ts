import crypto from 'node:crypto';
import type { Express, Request, Response, NextFunction } from 'express';
import type { Server as SocketIOServer } from 'socket.io';
import { z } from 'zod';
import { withTransaction, type NetcoDb } from '../db.ts';
import {
  ALL_BUSINESS_ROLES,
  BUSINESS_MANAGEMENT_ROLES,
  FINANCE_ROLES,
  getClientIp,
  NETWORK_ROLES,
  recordAuditLog,
  resolveTenantScope,
  type AuthedRequest,
  type StaffRole,
} from '../middleware/auth.ts';
import {
  authorizeRadiusRequest,
  ingestRadiusAccounting,
  provisionSubscriptionForActivation,
  retryProvisioningJob,
  suspendSubscriptionAndDisconnect,
} from '../services/billing.ts';
import { decryptSecret, generateId, generateReference, generateSessionToken, hashPassword, sha256 } from '../utils/crypto.ts';
import { businessRegistrationSchema, locationSchema, saasPlanSchema } from '../../../packages/validation/index.ts';
import { generateMikrotikWireguardSnippet } from '../../../packages/router-adapters/index.ts';

function verifyRadiusSecret(req: Request): boolean {
  const configured = process.env.RADIUS_SHARED_SECRET?.trim();
  if (!configured) return false;
  const provided = String(req.headers['x-radius-secret'] || '').trim();
  if (!provided) return false;
  const a = Buffer.from(configured, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function registerSaasRoutes(
  app: Express,
  db: NetcoDb,
  io: SocketIOServer | undefined,
  middleware: {
    requireAuth: (req: AuthedRequest, res: Response, next: NextFunction) => unknown;
    requireRole: (...roles: StaffRole[]) => (req: AuthedRequest, res: Response, next: NextFunction) => unknown;
  },
  authLimiter: (req: Request, res: Response, next: NextFunction) => unknown
) {
  const { requireAuth, requireRole } = middleware;

  // =========================================================================
  // SELF-SERVICE BUSINESS WORKSPACE REGISTRATION (MULTI-TENANT ONBOARDING)
  // =========================================================================
  app.post('/api/auth/register-business', authLimiter, (req, res) => {
    const parsed = businessRegistrationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid registration details', issues: parsed.error.issues });
    }

    const emailLower = parsed.data.ownerEmail.trim().toLowerCase();
    const existingEmail = db.prepare('SELECT id FROM admin_users WHERE LOWER(email) = ?').get(emailLower);
    if (existingEmail) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const baseSlug = parsed.data.businessName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 36) || 'wifi-biz';
    const slugDup = db.prepare('SELECT id FROM businesses WHERE slug = ?').get(baseSlug);
    const slug = slugDup ? `${baseSlug}-${crypto.randomBytes(2).toString('hex')}` : baseSlug;

    const planCode = parsed.data.planCode || 'STARTER';
    const plan = db
      .prepare('SELECT * FROM saas_plans WHERE code = ? AND is_active = 1')
      .get(planCode) as Record<string, unknown> | undefined;
    if (!plan) {
      return res.status(400).json({ error: 'Selected SaaS plan is unavailable' });
    }

    const nowIso = new Date().toISOString();
    const trialEnd = new Date(Date.now() + 30 * 86_400_000).toISOString();
    const businessId = generateId('biz');
    const locationId = generateId('loc');
    const adminId = generateId('adm');
    const staffId = generateId('stf');
    const saasSubId = generateId('ssub');
    const staffCode = generateReference('STF');
    const passwordHash = hashPassword(parsed.data.password);
    const rawToken = generateSessionToken();
    const sessionExpiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();

    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO businesses (
          id, name, slug, email, phone, country, currency, status, timezone, hotspot_title, hotspot_support_phone, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'TZS', 'ACTIVE', 'Africa/Dar_es_Salaam', ?, ?, ?, ?)
      `).run(
        businessId,
        parsed.data.businessName.trim(),
        slug,
        emailLower,
        parsed.data.phone.trim(),
        parsed.data.country.trim(),
        `${parsed.data.businessName.trim()} WiFi`,
        parsed.data.phone.trim(),
        nowIso,
        nowIso
      );

      db.prepare(`
        INSERT INTO locations (id, business_id, name, region, address, contact_name, is_active, created_at, updated_at)
        VALUES (?, ?, 'Main Hotspot Location', ?, 'Primary Site', ?, 1, ?, ?)
      `).run(locationId, businessId, parsed.data.region.trim(), parsed.data.ownerName.trim(), nowIso, nowIso);

      db.prepare(`
        INSERT INTO saas_subscriptions (
          id, business_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at, updated_at
        ) VALUES (?, ?, ?, 'TRIAL', 'MONTHLY', ?, ?, ?, ?)
      `).run(saasSubId, businessId, String(plan.id), nowIso, trialEnd, nowIso, nowIso);

      db.prepare(`
        INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, last_login_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'BUSINESS_OWNER', 1, ?, ?, ?)
      `).run(adminId, businessId, emailLower, parsed.data.ownerName.trim(), passwordHash, nowIso, nowIso, nowIso);

      db.prepare(`
        INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, phone, role, is_suspended)
        VALUES (?, ?, ?, ?, 'Executive Management', ?, 'BUSINESS_OWNER', 0)
      `).run(staffId, businessId, adminId, staffCode, parsed.data.phone.trim());

      db.prepare(`
        INSERT INTO staff_sessions (id, admin_user_id, token_hash, ip_address, user_agent, expires_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        generateId('ss'),
        adminId,
        sha256(rawToken),
        getClientIp(req),
        req.headers['user-agent'] || null,
        sessionExpiresAt
      );
    });

    recordAuditLog(
      db,
      { id: adminId, businessId, email: emailLower, role: 'BUSINESS_OWNER' },
      'BUSINESS_REGISTERED',
      'Business',
      businessId,
      getClientIp(req),
      { businessName: parsed.data.businessName.trim(), planCode }
    );

    res.status(201).json({
      token: rawToken,
      expiresAt: sessionExpiresAt,
      user: {
        id: adminId,
        businessId,
        businessName: parsed.data.businessName.trim(),
        businessStatus: 'ACTIVE',
        email: emailLower,
        fullName: parsed.data.ownerName.trim(),
        role: 'BUSINESS_OWNER',
      },
      business: {
        id: businessId,
        name: parsed.data.businessName.trim(),
        slug,
        status: 'ACTIVE',
        planCode,
      },
    });
  });

  // =========================================================================
  // PUBLIC PORTAL: MULTI-TENANT WORKSPACES, CUSTOMER ACCOUNT & SUPPORT
  // =========================================================================
  app.get('/api/portal/businesses', (_req, res) => {
    const businesses = db
      .prepare(`
        SELECT id, name, slug, hotspot_title as hotspotTitle, hotspot_support_phone as hotspotSupportPhone, country, currency
        FROM businesses
        WHERE status = 'ACTIVE'
        ORDER BY created_at ASC
      `)
      .all();
    res.json({ businesses });
  });

  app.get('/api/portal/account', (req, res) => {
    const phone = typeof req.query.phone === 'string' ? req.query.phone.replace(/\D/g, '') : '';
    const ref = typeof req.query.reference === 'string' ? req.query.reference.trim().toUpperCase() : '';
    if ((!phone || phone.length < 9) && (!ref || ref.length < 4)) {
      return res.status(400).json({ error: 'Enter your mobile number or payment reference to look up purchases.' });
    }

    const tail = phone.length >= 9 ? phone.slice(-9) : '';
    const payments = db
      .prepare(`
        SELECT p.reference, p.receipt_number as receiptNumber, p.provider, p.phone_number as phoneNumber,
               p.amount_tzs as amountTzs, p.status, p.is_test as isTest, p.created_at as createdAt,
               pk.name as packageName, b.name as businessName,
               v.code_masked as voucherMasked, v.status as voucherStatus, v.expires_at as voucherExpiresAt,
               v.code_encrypted as voucherEncrypted
        FROM payments p
        JOIN packages pk ON pk.id = p.package_id
        JOIN businesses b ON b.id = p.business_id
        LEFT JOIN vouchers v ON v.id = p.voucher_id
        WHERE (? != '' AND p.phone_number LIKE ?) OR (? != '' AND p.reference = ?)
        ORDER BY p.created_at DESC
        LIMIT 15
      `)
      .all(tail, `%${tail}`, ref, ref) as Array<Record<string, unknown>>;

    const sanitized = payments.map((p) => {
      let voucherCode: string | null = null;
      if (p.status === 'COMPLETED' && p.voucherStatus === 'UNUSED' && p.voucherEncrypted) {
        try {
          voucherCode = decryptSecret(String(p.voucherEncrypted));
        } catch {
          voucherCode = null;
        }
      }
      const { voucherEncrypted: _omit, isTest, ...rest } = p;
      return { ...rest, isTest: Boolean(isTest), voucherCode };
    });

    res.json({ purchases: sanitized });
  });

  app.post('/api/portal/support', (req, res) => {
    const schema = z.object({
      businessId: z.string().min(2).max(64).optional(),
      phone: z.string().min(8).max(24),
      subject: z.string().min(3).max(120),
      message: z.string().min(5).max(1000),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Please complete phone, subject, and message', issues: parsed.error.issues });
    }

    const targetBiz = parsed.data.businessId
      ? (db.prepare("SELECT id FROM businesses WHERE id = ? AND status = 'ACTIVE'").get(parsed.data.businessId) as
          | { id: string }
          | undefined)
      : (db.prepare("SELECT id FROM businesses WHERE status = 'ACTIVE' ORDER BY created_at ASC LIMIT 1").get() as
          | { id: string }
          | undefined);

    if (!targetBiz) {
      return res.status(404).json({ error: 'Selected WiFi provider workspace not found' });
    }

    const id = generateId('tkt');
    const nowIso = new Date().toISOString();
    withTransaction(db, () => {
      db.prepare(`
        INSERT INTO support_tickets (id, business_id, phone, subject, message, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'OPEN', ?, ?)
      `).run(id, targetBiz.id, parsed.data.phone.trim(), parsed.data.subject.trim(), parsed.data.message.trim(), nowIso, nowIso);

      db.prepare(`
        INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
        VALUES (?, ?, 'SUPPORT_TICKET', 'INFO', ?, ?, ?)
      `).run(
        generateId('ntf'),
        targetBiz.id,
        `Customer Support: ${parsed.data.subject.trim()}`,
        `${parsed.data.phone.trim()}: ${parsed.data.message.trim().slice(0, 140)}`,
        JSON.stringify({ ticketId: id })
      );
    });

    io?.emit('notification:new', { type: 'SUPPORT_TICKET', businessId: targetBiz.id });
    res.status(201).json({ ok: true, ticketId: id });
  });

  // =========================================================================
  // FREERADIUS REST ADAPTER ENDPOINTS
  // =========================================================================
  app.post('/api/radius/authorize', (req, res) => {
    if (!verifyRadiusSecret(req)) {
      return res.status(401).json({ access: 'Access-Reject', error: 'Unauthorized RADIUS secret' });
    }
    const schema = z.object({
      username: z.string().min(2).max(120),
      password: z.string().max(128).optional().nullable(),
      nasIpAddress: z.string().max(64).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ access: 'Access-Reject', error: 'Invalid RADIUS authorize payload' });
    }

    const result = authorizeRadiusRequest(db, parsed.data);
    if (!result.authorized) {
      return res.status(401).json({ access: 'Access-Reject', reason: result.reason });
    }
    return res.json({
      access: 'Access-Accept',
      businessId: result.businessId,
      reply: result.replyAttributes,
    });
  });

  app.post('/api/radius/accounting', (req, res) => {
    if (!verifyRadiusSecret(req)) {
      return res.status(401).json({ error: 'Unauthorized RADIUS secret' });
    }
    const schema = z.object({
      acctSessionId: z.string().min(2).max(128),
      username: z.string().min(2).max(120),
      statusType: z.enum(['Start', 'Interim-Update', 'Stop']),
      nasIpAddress: z.string().max(64).optional().nullable(),
      framedIpAddress: z.string().max(64).optional().nullable(),
      callingStationId: z.string().max(64).optional().nullable(),
      acctInputOctets: z.number().nonnegative().optional(),
      acctOutputOctets: z.number().nonnegative().optional(),
      acctSessionTime: z.number().int().nonnegative().optional(),
      terminateCause: z.string().max(64).optional().nullable(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid RADIUS accounting payload', issues: parsed.error.issues });
    }

    try {
      const outcome = ingestRadiusAccounting(db, parsed.data);
      res.json(outcome);
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Accounting update failed' });
    }
  });

  // =========================================================================
  // SUPER ADMIN PLATFORM CONSOLE
  // =========================================================================
  app.get('/api/superadmin/overview', requireAuth, requireRole('SUPER_ADMIN'), (_req, res) => {
    const bizCounts = db
      .prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'ACTIVE' THEN 1 ELSE 0 END) as active,
               SUM(CASE WHEN status = 'SUSPENDED' THEN 1 ELSE 0 END) as suspended,
               SUM(CASE WHEN status = 'PENDING' THEN 1 ELSE 0 END) as pending
        FROM businesses
      `)
      .get() as Record<string, number | null>;

    const rtrCounts = db
      .prepare(`
        SELECT COUNT(*) as total,
               SUM(CASE WHEN status = 'CONNECTED' THEN 1 ELSE 0 END) as online
        FROM routers
      `)
      .get() as Record<string, number | null>;

    const totalCustomers = Number((db.prepare('SELECT COUNT(*) as c FROM customers').get() as { c: number }).c);
    const activeSubs = Number(
      (db.prepare("SELECT COUNT(*) as c FROM saas_subscriptions WHERE status IN ('ACTIVE','TRIAL')").get() as { c: number }).c
    );
    const saasRev = Number(
      (db.prepare("SELECT COALESCE(SUM(amount_tzs), 0) as s FROM saas_payments WHERE status = 'COMPLETED'").get() as { s: number }).s
    );
    const wifiRev = Number(
      (db.prepare("SELECT COALESCE(SUM(amount_tzs), 0) as s FROM payments WHERE status = 'COMPLETED' AND is_test = 0").get() as { s: number }).s
    );
    const pendingJobs = Number(
      (db.prepare("SELECT COUNT(*) as c FROM provisioning_jobs WHERE status = 'FAILED_RETRYING'").get() as { c: number }).c
    );

    res.json({
      stats: {
        totalBusinesses: Number(bizCounts.total || 0),
        activeBusinesses: Number(bizCounts.active || 0),
        suspendedBusinesses: Number(bizCounts.suspended || 0),
        pendingBusinesses: Number(bizCounts.pending || 0),
        totalCustomers,
        totalRouters: Number(rtrCounts.total || 0),
        onlineRouters: Number(rtrCounts.online || 0),
        offlineRouters: Math.max(0, Number(rtrCounts.total || 0) - Number(rtrCounts.online || 0)),
        activeSaasSubscriptions: activeSubs,
        saasRevenueTzs: saasRev,
        totalWifiRevenueTzs: wifiRev,
        retryingProvisioningJobs: pendingJobs,
      },
      systemHealth: {
        database: 'OK',
        uptimeSeconds: Math.floor(process.uptime()),
        nodeVersion: process.version,
        timestamp: new Date().toISOString(),
      },
    });
  });

  app.get('/api/superadmin/businesses', requireAuth, requireRole('SUPER_ADMIN'), (_req, res) => {
    const businesses = db
      .prepare(`
        SELECT b.id, b.name, b.slug, b.email, b.phone, b.country, b.currency, b.status,
               b.created_at as createdAt,
               sp.code as planCode, sp.name as planName, ss.status as subscriptionStatus,
               ss.current_period_end as currentPeriodEnd,
               (SELECT COUNT(*) FROM routers r WHERE r.business_id = b.id) as routerCount,
               (SELECT COUNT(*) FROM locations l WHERE l.business_id = b.id) as locationCount,
               (SELECT COUNT(*) FROM customers c WHERE c.business_id = b.id) as customerCount,
               (SELECT COALESCE(SUM(p.amount_tzs), 0) FROM payments p WHERE p.business_id = b.id AND p.status = 'COMPLETED' AND p.is_test = 0) as wifiRevenueTzs
        FROM businesses b
        LEFT JOIN saas_subscriptions ss ON ss.business_id = b.id
        LEFT JOIN saas_plans sp ON sp.id = ss.plan_id
        ORDER BY b.created_at DESC
      `)
      .all();
    res.json({ businesses });
  });

  app.patch('/api/superadmin/businesses/:id/status', requireAuth, requireRole('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const schema = z.object({
      status: z.enum(['PENDING', 'ACTIVE', 'SUSPENDED']),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid business status' });
    }
    const existing = db.prepare('SELECT id, name FROM businesses WHERE id = ?').get(req.params.id) as
      | { id: string; name: string }
      | undefined;
    if (!existing) {
      return res.status(404).json({ error: 'Business not found' });
    }
    db.prepare('UPDATE businesses SET status = ?, updated_at = ? WHERE id = ?').run(
      parsed.data.status,
      new Date().toISOString(),
      req.params.id
    );
    if (req.actor) {
      recordAuditLog(db, req.actor, 'BUSINESS_STATUS_UPDATED', 'Business', req.params.id, getClientIp(req), {
        status: parsed.data.status,
      });
    }
    res.json({ ok: true, id: req.params.id, status: parsed.data.status });
  });

  app.get('/api/superadmin/plans', requireAuth, requireRole('SUPER_ADMIN'), (_req, res) => {
    const plans = db
      .prepare(`
        SELECT id, code, name, price_monthly_tzs as priceMonthlyTzs, price_yearly_tzs as priceYearlyTzs,
               max_routers as maxRouters, max_locations as maxLocations,
               max_active_customers as maxActiveCustomers, commission_bps as commissionBps,
               is_active as isActive, created_at as createdAt
        FROM saas_plans
        ORDER BY price_monthly_tzs ASC
      `)
      .all();
    res.json({ plans });
  });

  app.post('/api/superadmin/plans', requireAuth, requireRole('SUPER_ADMIN'), (req: AuthedRequest, res) => {
    const parsed = saasPlanSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid SaaS plan payload', issues: parsed.error.issues });
    }
    const code = parsed.data.code.toUpperCase();
    const dup = db.prepare('SELECT id FROM saas_plans WHERE code = ?').get(code);
    if (dup) {
      return res.status(409).json({ error: 'Plan code already exists' });
    }
    const id = generateId('plan');
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO saas_plans (
        id, code, name, price_monthly_tzs, price_yearly_tzs, max_routers, max_locations,
        max_active_customers, commission_bps, is_active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      code,
      parsed.data.name.trim(),
      parsed.data.priceMonthlyTzs,
      parsed.data.priceYearlyTzs,
      parsed.data.maxRouters,
      parsed.data.maxLocations,
      parsed.data.maxActiveCustomers,
      parsed.data.commissionBps,
      nowIso,
      nowIso
    );
    if (req.actor) {
      recordAuditLog(db, req.actor, 'SAAS_PLAN_CREATED', 'SaasPlan', id, getClientIp(req), { code });
    }
    res.status(201).json({ id, code, name: parsed.data.name.trim() });
  });

  app.get('/api/superadmin/saas-payments', requireAuth, requireRole('SUPER_ADMIN'), (_req, res) => {
    const payments = db
      .prepare(`
        SELECT sp.id, sp.reference, sp.amount_tzs as amountTzs, sp.provider, sp.status, sp.paid_at as paidAt,
               sp.created_at as createdAt, b.name as businessName, pl.name as planName
        FROM saas_payments sp
        JOIN businesses b ON b.id = sp.business_id
        JOIN saas_subscriptions ss ON ss.id = sp.saas_subscription_id
        JOIN saas_plans pl ON pl.id = ss.plan_id
        ORDER BY sp.created_at DESC
        LIMIT 200
      `)
      .all();
    res.json({ saasPayments: payments });
  });

  // =========================================================================
  // TENANT BUSINESS SUBSCRIPTION & LOCATIONS
  // =========================================================================
  app.get('/api/business/subscription', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const business = db
      .prepare(`
        SELECT id, name, slug, email, phone, country, currency, status, timezone,
               hotspot_title as hotspotTitle, hotspot_support_phone as hotspotSupportPhone
        FROM businesses WHERE id = ?
      `)
      .get(scope.businessId);

    const subscription = db
      .prepare(`
        SELECT ss.id, ss.status, ss.billing_cycle as billingCycle,
               ss.current_period_start as currentPeriodStart, ss.current_period_end as currentPeriodEnd,
               p.id as planId, p.code as planCode, p.name as planName,
               p.price_monthly_tzs as priceMonthlyTzs, p.price_yearly_tzs as priceYearlyTzs,
               p.max_routers as maxRouters, p.max_locations as maxLocations, p.max_active_customers as maxActiveCustomers
        FROM saas_subscriptions ss
        JOIN saas_plans p ON p.id = ss.plan_id
        WHERE ss.business_id = ?
        ORDER BY ss.created_at DESC LIMIT 1
      `)
      .get(scope.businessId);

    const plans = db
      .prepare(`
        SELECT id, code, name, price_monthly_tzs as priceMonthlyTzs, price_yearly_tzs as priceYearlyTzs,
               max_routers as maxRouters, max_locations as maxLocations, max_active_customers as maxActiveCustomers
        FROM saas_plans WHERE is_active = 1 ORDER BY price_monthly_tzs ASC
      `)
      .all();

    const payments = db
      .prepare(`
        SELECT id, reference, amount_tzs as amountTzs, provider, status, paid_at as paidAt, created_at as createdAt
        FROM saas_payments WHERE business_id = ? ORDER BY created_at DESC LIMIT 50
      `)
      .all(scope.businessId);

    res.json({ business, subscription, plans, saasPayments: payments });
  });

  app.post('/api/business/subscription/checkout', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      planCode: z.string().min(2).max(40),
      billingCycle: z.enum(['MONTHLY', 'YEARLY']).default('MONTHLY'),
      provider: z.enum(['MPESA', 'AIRTEL_MONEY', 'TIGO_PESA', 'HALOPESA', 'CARD']).default('MPESA'),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid plan checkout payload' });
    }

    const plan = db
      .prepare('SELECT * FROM saas_plans WHERE code = ? AND is_active = 1')
      .get(parsed.data.planCode.toUpperCase()) as Record<string, unknown> | undefined;
    if (!plan) {
      return res.status(404).json({ error: 'SaaS plan not found' });
    }

    const amountTzs =
      parsed.data.billingCycle === 'YEARLY' ? Number(plan.price_yearly_tzs) : Number(plan.price_monthly_tzs);
    const nowIso = new Date().toISOString();
    const days = parsed.data.billingCycle === 'YEARLY' ? 365 : 30;
    const periodEnd = new Date(Date.now() + days * 86_400_000).toISOString();
    const ref = generateReference('SAAS-PAY');

    withTransaction(db, () => {
      let existingSub = db
        .prepare('SELECT id FROM saas_subscriptions WHERE business_id = ? ORDER BY created_at DESC LIMIT 1')
        .get(scope.businessId) as { id: string } | undefined;

      if (!existingSub) {
        const subId = generateId('ssub');
        db.prepare(`
          INSERT INTO saas_subscriptions (id, business_id, plan_id, status, billing_cycle, current_period_start, current_period_end, created_at, updated_at)
          VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?, ?, ?)
        `).run(subId, scope.businessId, String(plan.id), parsed.data.billingCycle, nowIso, periodEnd, nowIso, nowIso);
        existingSub = { id: subId };
      } else {
        db.prepare(`
          UPDATE saas_subscriptions
          SET plan_id = ?, status = 'ACTIVE', billing_cycle = ?, current_period_start = ?, current_period_end = ?, updated_at = ?
          WHERE id = ?
        `).run(String(plan.id), parsed.data.billingCycle, nowIso, periodEnd, nowIso, existingSub.id);
      }

      db.prepare(`
        INSERT INTO saas_payments (id, business_id, saas_subscription_id, reference, amount_tzs, provider, status, paid_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'COMPLETED', ?, ?)
      `).run(generateId('spay'), scope.businessId, existingSub.id, ref, amountTzs, parsed.data.provider, nowIso, nowIso);
    });

    if (req.actor) {
      recordAuditLog(db, req.actor, 'SAAS_PLAN_UPGRADED', 'SaasSubscription', scope.businessId, getClientIp(req), {
        planCode: parsed.data.planCode,
        billingCycle: parsed.data.billingCycle,
        amountTzs,
        reference: ref,
      });
    }

    res.status(201).json({ ok: true, reference: ref, amountTzs, planCode: parsed.data.planCode });
  });

  app.get('/api/locations', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const locations = db
      .prepare(`
        SELECT l.id, l.name, l.region, l.address, l.contact_name as contactName, l.is_active as isActive,
               l.created_at as createdAt,
               (SELECT COUNT(*) FROM routers r WHERE r.location_id = l.id) as routerCount,
               (SELECT COUNT(*) FROM subscriptions s WHERE s.location_id = l.id AND s.status = 'ACTIVE') as activeSubscriptions
        FROM locations l
        WHERE l.business_id = ?
        ORDER BY l.created_at ASC
      `)
      .all(scope.businessId);
    res.json({ locations });
  });

  app.post('/api/locations', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES, 'NETWORK_OPERATOR'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const parsed = locationSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid location payload', issues: parsed.error.issues });
    }

    const dup = db
      .prepare('SELECT id FROM locations WHERE business_id = ? AND LOWER(name) = LOWER(?)')
      .get(scope.businessId, parsed.data.name.trim());
    if (dup) {
      return res.status(409).json({ error: 'A location with this name already exists in your workspace' });
    }

    const id = generateId('loc');
    const nowIso = new Date().toISOString();
    db.prepare(`
      INSERT INTO locations (id, business_id, name, region, address, contact_name, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      id,
      scope.businessId,
      parsed.data.name.trim(),
      parsed.data.region.trim(),
      parsed.data.address?.trim() || null,
      parsed.data.contactName?.trim() || null,
      nowIso,
      nowIso
    );

    if (req.actor) {
      recordAuditLog(db, req.actor, 'LOCATION_CREATED', 'Location', id, getClientIp(req), {
        name: parsed.data.name.trim(),
      });
    }
    const created = db
      .prepare('SELECT id, name, region, address, contact_name as contactName, is_active as isActive, created_at as createdAt FROM locations WHERE id = ?')
      .get(id);
    res.status(201).json({ location: created });
  });

  app.delete('/api/locations/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT id, business_id FROM locations WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Location not found' });
    if (existing.business_id !== scope.businessId) {
      return res.status(403).json({ error: 'Cross-tenant access denied' });
    }

    db.prepare('DELETE FROM locations WHERE id = ? AND business_id = ?').run(req.params.id, scope.businessId);
    res.json({ ok: true });
  });

  // =========================================================================
  // SUBSCRIPTIONS & OFFLINE ROUTER RETRY QUEUE
  // =========================================================================
  app.get('/api/subscriptions', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const subscriptions = db
      .prepare(`
        SELECT s.id, s.radius_username as radiusUsername, s.status, s.provisioning_status as provisioningStatus,
               s.download_kbps as downloadKbps, s.upload_kbps as uploadKbps, s.data_limit_mb as dataLimitMb,
               s.starts_at as startsAt, s.expires_at as expiresAt, s.revoked_at as revokedAt, s.created_at as createdAt,
               pk.name as packageName, c.full_name as customerName, l.name as locationName,
               (SELECT id FROM provisioning_jobs pj WHERE pj.subscription_id = s.id AND pj.status = 'FAILED_RETRYING' LIMIT 1) as pendingJobId
        FROM subscriptions s
        JOIN packages pk ON pk.id = s.package_id
        LEFT JOIN customers c ON c.id = s.customer_id
        LEFT JOIN locations l ON l.id = s.location_id
        WHERE s.business_id = ?
        ORDER BY s.created_at DESC
        LIMIT 250
      `)
      .all(scope.businessId);

    const provisioningJobs = db
      .prepare(`
        SELECT pj.id, pj.subscription_id as subscriptionId, pj.router_id as routerId, pj.action,
               pj.status, pj.attempts, pj.max_attempts as maxAttempts, pj.last_error as lastError,
               pj.next_retry_at as nextRetryAt, pj.completed_at as completedAt, pj.created_at as createdAt,
               r.name as routerName
        FROM provisioning_jobs pj
        LEFT JOIN routers r ON r.id = pj.router_id
        WHERE pj.business_id = ?
        ORDER BY pj.created_at DESC
        LIMIT 100
      `)
      .all(scope.businessId);

    res.json({ subscriptions, provisioningJobs });
  });

  app.post('/api/subscriptions', requireAuth, requireRole(...FINANCE_ROLES), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const schema = z.object({
      packageId: z.string().min(1).max(64),
      customerId: z.string().min(1).max(64).optional().nullable(),
      locationId: z.string().min(1).max(64).optional().nullable(),
      username: z.string().min(3).max(64).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid subscription payload', issues: parsed.error.issues });
    }

    const pkg = db
      .prepare('SELECT id, business_id, duration_minutes FROM packages WHERE id = ?')
      .get(parsed.data.packageId) as { id: string; business_id: string; duration_minutes: number } | undefined;
    if (!pkg) return res.status(404).json({ error: 'Package not found' });
    if (pkg.business_id !== scope.businessId) return res.status(403).json({ error: 'Cross-tenant access denied' });

    const nowIso = new Date().toISOString();
    const expiresAtIso = new Date(Date.now() + pkg.duration_minutes * 60_000).toISOString();
    const username = (parsed.data.username?.trim() || generateReference('TRX')).replace(/[^A-Z0-9_-]/gi, '').toUpperCase();
    const secretVal = crypto.randomBytes(6).toString('hex').toUpperCase();

    const result = await provisionSubscriptionForActivation(db, {
      businessId: scope.businessId,
      locationId: parsed.data.locationId ?? null,
      customerId: parsed.data.customerId ?? null,
      packageId: pkg.id,
      radiusUsername: username,
      radiusSecretValue: secretVal,
      startsAtIso: nowIso,
      expiresAtIso,
    });

    if (req.actor) {
      recordAuditLog(db, req.actor, 'SUBSCRIPTION_PROVISIONED', 'Subscription', result.subscriptionId, getClientIp(req), {
        provisioningStatus: result.provisioningStatus,
      });
    }
    res.status(201).json({ subscription: result });
  });

  app.post('/api/subscriptions/:id/suspend', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES, 'NETWORK_OPERATOR'), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    try {
      await suspendSubscriptionAndDisconnect(db, req.params.id, scope.businessId, 'Suspended by tenant operator');
      res.json({ ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to suspend subscription';
      return res.status(msg === 'CROSS_TENANT_FORBIDDEN' ? 403 : 404).json({ error: msg });
    }
  });

  app.post('/api/provisioning-jobs/:id/retry', requireAuth, requireRole(...NETWORK_ROLES), async (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    try {
      const result = await retryProvisioningJob(db, req.params.id, scope.businessId);
      res.json({ result });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Retry failed';
      return res.status(msg === 'CROSS_TENANT_FORBIDDEN' ? 403 : 404).json({ error: msg });
    }
  });

  // =========================================================================
  // SUPPORT TICKETS & WIREGUARD SNIPPETS
  // =========================================================================
  app.get('/api/support-tickets', requireAuth, requireRole(...ALL_BUSINESS_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const tickets = db
      .prepare(`
        SELECT id, phone, subject, message, status, reply, created_at as createdAt, updated_at as updatedAt
        FROM support_tickets
        WHERE business_id = ?
        ORDER BY created_at DESC LIMIT 100
      `)
      .all(scope.businessId);
    res.json({ tickets });
  });

  app.patch('/api/support-tickets/:id', requireAuth, requireRole(...BUSINESS_MANAGEMENT_ROLES, 'SUPPORT_STAFF'), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const existing = db.prepare('SELECT id, business_id FROM support_tickets WHERE id = ?').get(req.params.id) as
      | { id: string; business_id: string }
      | undefined;
    if (!existing) return res.status(404).json({ error: 'Ticket not found' });
    if (existing.business_id !== scope.businessId) return res.status(403).json({ error: 'Cross-tenant access denied' });

    const schema = z.object({
      status: z.enum(['OPEN', 'IN_PROGRESS', 'RESOLVED']).optional(),
      reply: z.string().max(1000).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid ticket update' });

    db.prepare(`
      UPDATE support_tickets
      SET status = COALESCE(?, status),
          reply = COALESCE(?, reply),
          updated_at = ?
      WHERE id = ? AND business_id = ?
    `).run(parsed.data.status ?? null, parsed.data.reply?.trim() ?? null, new Date().toISOString(), req.params.id, scope.businessId);
    res.json({ ok: true });
  });

  app.get('/api/routers/:id/wireguard-snippet', requireAuth, requireRole(...NETWORK_ROLES), (req: AuthedRequest, res) => {
    const scope = resolveTenantScope(db, req);
    if ('error' in scope) return res.status(scope.status).json({ error: scope.error });

    const router = db.prepare('SELECT * FROM routers WHERE id = ?').get(req.params.id) as Record<string, unknown> | undefined;
    if (!router) return res.status(404).json({ error: 'Router not found' });
    if (String(router.business_id) !== scope.businessId) return res.status(403).json({ error: 'Cross-tenant access denied' });

    const snippet = generateMikrotikWireguardSnippet({
      routerName: String(router.name),
      cloudWgPublicKey: process.env.WIREGUARD_CLOUD_PUBKEY?.trim() || '<CLOUD_WG_PUBLIC_KEY>',
      cloudWgEndpoint: process.env.WIREGUARD_ENDPOINT?.trim() || '<CLOUD_VPS_IP>:51820',
      routerTunnelCidr: '10.66.0.10/24',
      cloudRadiusIp: '10.66.0.1',
      radiusSecret: String(router.radius_secret || process.env.RADIUS_SHARED_SECRET || '<RADIUS_SHARED_SECRET>'),
      hotspotServer: String(router.hotspot_server || ''),
    });

    res.json({ snippet, routerOsFamily: String(router.router_os_family || 'ROUTEROS_V7') });
  });
}
