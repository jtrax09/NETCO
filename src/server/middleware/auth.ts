import type { Request, Response, NextFunction } from 'express';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../../firebase-applet-config.json' with { type: 'json' };
import { DEFAULT_BUSINESS_ID, type NetcoDb } from '../db.ts';
import { generateId, generateReference, sha256 } from '../utils/crypto.ts';

export type StaffRole =
  | 'SUPER_ADMIN'
  | 'BUSINESS_OWNER'
  | 'ADMIN'
  | 'ACCOUNTANT'
  | 'NETWORK_OPERATOR'
  | 'SUPPORT_STAFF'
  | 'CASHIER';

export const BUSINESS_MANAGEMENT_ROLES: StaffRole[] = ['SUPER_ADMIN', 'BUSINESS_OWNER', 'ADMIN'];
export const FINANCE_ROLES: StaffRole[] = ['SUPER_ADMIN', 'BUSINESS_OWNER', 'ADMIN', 'ACCOUNTANT', 'CASHIER'];
export const NETWORK_ROLES: StaffRole[] = ['SUPER_ADMIN', 'BUSINESS_OWNER', 'ADMIN', 'NETWORK_OPERATOR'];
export const ALL_BUSINESS_ROLES: StaffRole[] = [
  'SUPER_ADMIN',
  'BUSINESS_OWNER',
  'ADMIN',
  'ACCOUNTANT',
  'NETWORK_OPERATOR',
  'SUPPORT_STAFF',
  'CASHIER',
];

export interface AuthenticatedActor {
  id: string;
  businessId: string;
  businessName: string;
  businessStatus: string;
  email: string;
  fullName: string;
  role: StaffRole;
  authSource: 'SESSION' | 'FIREBASE';
}

export interface AuthedRequest extends Request {
  actor?: AuthenticatedActor;
}

const BOOTSTRAP_SUPER_ADMIN_EMAILS = new Set([
  'undergodmusic255@gmail.com',
  'mlingwajastine277@gmail.com',
]);

if (!getApps().length && firebaseConfig.projectId && firebaseConfig.projectId !== 'remixed-project-id') {
  initializeApp({ projectId: firebaseConfig.projectId });
}

export function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip || req.socket.remoteAddress || '0.0.0.0';
}

export function recordAuditLog(
  db: NetcoDb,
  actor: AuthenticatedActor | { id?: string; businessId?: string | null; email: string; role: string },
  action: string,
  entityType: string,
  entityId: string | null,
  ipAddress: string | null,
  details?: Record<string, unknown>
) {
  const businessId = 'businessId' in actor ? actor.businessId ?? null : null;
  db.prepare(`
    INSERT INTO audit_logs (id, business_id, actor_id, actor_email, actor_role, action, entity_type, entity_id, ip_address, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId('aud'),
    businessId,
    actor.id ?? null,
    actor.email,
    actor.role,
    action,
    entityType,
    entityId,
    ipAddress,
    details ? JSON.stringify(details) : null
  );
}

/**
 * Resolves the authoritative tenant businessId for a request.
 * Non-SUPER_ADMIN actors are strictly locked to req.actor.businessId; any attempt to spoof
 * another businessId in headers/query/body is rejected and audited as CROSS_TENANT_ACCESS_BLOCKED.
 */
export function resolveTenantScope(
  db: NetcoDb,
  req: AuthedRequest
): { businessId: string } | { error: string; status: number } {
  if (!req.actor) {
    return { error: 'Authentication required', status: 401 };
  }

  const headerTenant = typeof req.headers['x-tenant-id'] === 'string' ? req.headers['x-tenant-id'].trim() : '';
  const queryTenant = typeof req.query.businessId === 'string' ? req.query.businessId.trim() : '';
  const bodyObj = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : null;
  const bodyTenant = bodyObj && typeof bodyObj.businessId === 'string' ? bodyObj.businessId.trim() : '';

  const requestedTenant = headerTenant || queryTenant || bodyTenant;

  if (req.actor.role === 'SUPER_ADMIN') {
    const targetId = requestedTenant || req.actor.businessId || DEFAULT_BUSINESS_ID;
    const biz = db.prepare('SELECT id FROM businesses WHERE id = ?').get(targetId) as { id: string } | undefined;
    if (!biz) {
      return { error: 'Target business workspace not found', status: 404 };
    }
    return { businessId: biz.id };
  }

  if (requestedTenant && requestedTenant !== req.actor.businessId) {
    recordAuditLog(db, req.actor, 'CROSS_TENANT_ACCESS_BLOCKED', 'Business', requestedTenant, getClientIp(req), {
      actorBusinessId: req.actor.businessId,
      attemptedBusinessId: requestedTenant,
      path: req.originalUrl,
    });
    return { error: 'Cross-tenant access denied', status: 403 };
  }

  return { businessId: req.actor.businessId };
}

export function createAuthMiddleware(db: NetcoDb) {
  const requireAuth = async (req: AuthedRequest, res: Response, next: NextFunction) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const token = authHeader.slice('Bearer '.length).trim();
    if (!token) {
      return res.status(401).json({ error: 'Invalid authorization token' });
    }

    // 1. Check server-issued staff session token first
    const tokenHash = sha256(token);
    const nowIso = new Date().toISOString();
    const sessionRow = db
      .prepare(`
        SELECT s.id as session_id, s.expires_at, s.revoked_at,
               u.id as user_id, u.business_id, u.email, u.full_name, u.role, u.is_active,
               st.is_suspended,
               b.name as business_name, b.status as business_status
        FROM staff_sessions s
        JOIN admin_users u ON u.id = s.admin_user_id
        LEFT JOIN staff st ON st.admin_user_id = u.id
        LEFT JOIN businesses b ON b.id = u.business_id
        WHERE s.token_hash = ?
      `)
      .get(tokenHash) as Record<string, unknown> | undefined;

    if (sessionRow) {
      if (sessionRow.revoked_at || String(sessionRow.expires_at) <= nowIso) {
        return res.status(401).json({ error: 'Session expired or revoked' });
      }
      if (!sessionRow.is_active || sessionRow.is_suspended) {
        return res.status(403).json({ error: 'Account is suspended or deactivated' });
      }
      const role = String(sessionRow.role) as StaffRole;
      const bizStatus = String(sessionRow.business_status || 'ACTIVE');
      if (role !== 'SUPER_ADMIN' && bizStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'Business workspace is suspended. Contact TRAX LINK support.' });
      }
      req.actor = {
        id: String(sessionRow.user_id),
        businessId: String(sessionRow.business_id || DEFAULT_BUSINESS_ID),
        businessName: String(sessionRow.business_name || 'TRAX LINK Primary Hotspot'),
        businessStatus: bizStatus,
        email: String(sessionRow.email),
        fullName: String(sessionRow.full_name),
        role,
        authSource: 'SESSION',
      };
      return next();
    }

    // 2. Fallback: verify Firebase ID token (needs no IAM)
    try {
      if (!getApps().length) {
        return res.status(401).json({ error: 'Invalid session token' });
      }
      const decoded = await getAuth().verifyIdToken(token);
      if (!decoded.email || !decoded.email_verified) {
        return res.status(403).json({ error: 'Verified email required' });
      }

      const emailLower = decoded.email.toLowerCase();
      let adminRow = db
        .prepare(`
          SELECT u.*, st.is_suspended, b.name as business_name, b.status as business_status
          FROM admin_users u
          LEFT JOIN staff st ON st.admin_user_id = u.id
          LEFT JOIN businesses b ON b.id = u.business_id
          WHERE LOWER(u.email) = ?
        `)
        .get(emailLower) as Record<string, unknown> | undefined;

      if (!adminRow && BOOTSTRAP_SUPER_ADMIN_EMAILS.has(emailLower)) {
        const newId = generateId('adm');
        const displayName = decoded.name || 'TRAX LINK Super Admin';
        db.prepare(`
          INSERT INTO admin_users (id, business_id, firebase_uid, email, full_name, role, is_active, last_login_at)
          VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 1, ?)
        `).run(newId, DEFAULT_BUSINESS_ID, decoded.uid, emailLower, displayName, nowIso);
        const codeExists = db.prepare('SELECT id FROM staff WHERE staff_code = ?').get('STF-001');
        const staffCode = codeExists ? generateReference('STF') : 'STF-001';
        db.prepare(`
          INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, role)
          VALUES (?, ?, ?, ?, 'Executive Operations', 'SUPER_ADMIN')
        `).run(generateId('stf'), DEFAULT_BUSINESS_ID, newId, staffCode);
        adminRow = db
          .prepare(`
            SELECT u.*, st.is_suspended, b.name as business_name, b.status as business_status
            FROM admin_users u
            LEFT JOIN staff st ON st.admin_user_id = u.id
            LEFT JOIN businesses b ON b.id = u.business_id
            WHERE u.id = ?
          `)
          .get(newId) as Record<string, unknown>;
      }

      if (!adminRow) {
        return res.status(403).json({ error: 'Account is not authorized as TRAX LINK staff' });
      }
      if (!adminRow.is_active || adminRow.is_suspended) {
        return res.status(403).json({ error: 'Staff account is suspended or deactivated' });
      }
      const role = String(adminRow.role) as StaffRole;
      const bizStatus = String(adminRow.business_status || 'ACTIVE');
      if (role !== 'SUPER_ADMIN' && bizStatus === 'SUSPENDED') {
        return res.status(403).json({ error: 'Business workspace is suspended. Contact TRAX LINK support.' });
      }

      if (!adminRow.firebase_uid) {
        db.prepare('UPDATE admin_users SET firebase_uid = ?, last_login_at = ? WHERE id = ?').run(
          decoded.uid,
          nowIso,
          String(adminRow.id)
        );
      }

      req.actor = {
        id: String(adminRow.id),
        businessId: String(adminRow.business_id || DEFAULT_BUSINESS_ID),
        businessName: String(adminRow.business_name || 'TRAX LINK Primary Hotspot'),
        businessStatus: bizStatus,
        email: String(adminRow.email),
        fullName: String(adminRow.full_name),
        role,
        authSource: 'FIREBASE',
      };
      return next();
    } catch {
      return res.status(401).json({ error: 'Invalid or expired authentication token' });
    }
  };

  const requireRole = (...allowedRoles: StaffRole[]) => {
    return (req: AuthedRequest, res: Response, next: NextFunction) => {
      if (!req.actor) {
        return res.status(401).json({ error: 'Authentication required' });
      }
      if (!allowedRoles.includes(req.actor.role)) {
        return res.status(403).json({
          error: `Insufficient permissions. Required role: ${allowedRoles.join(' or ')}`,
        });
      }
      next();
    };
  };

  return { requireAuth, requireRole };
}
