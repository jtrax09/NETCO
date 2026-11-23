import type { Request, Response, NextFunction } from 'express';
import { initializeApp, getApps } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import firebaseConfig from '../../../firebase-applet-config.json' with { type: 'json' };
import type { NetcoDb } from '../db.ts';
import { generateId, generateReference, sha256 } from '../utils/crypto.ts';

export type StaffRole = 'SUPER_ADMIN' | 'ADMIN' | 'NETWORK_OPERATOR' | 'CASHIER';

export interface AuthenticatedActor {
  id: string;
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
  actor: AuthenticatedActor | { id?: string; email: string; role: string },
  action: string,
  entityType: string,
  entityId: string | null,
  ipAddress: string | null,
  details?: Record<string, unknown>
) {
  db.prepare(`
    INSERT INTO audit_logs (id, actor_id, actor_email, actor_role, action, entity_type, entity_id, ip_address, details)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    generateId('aud'),
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
               u.id as user_id, u.email, u.full_name, u.role, u.is_active,
               st.is_suspended
        FROM staff_sessions s
        JOIN admin_users u ON u.id = s.admin_user_id
        LEFT JOIN staff st ON st.admin_user_id = u.id
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
      req.actor = {
        id: String(sessionRow.user_id),
        email: String(sessionRow.email),
        fullName: String(sessionRow.full_name),
        role: String(sessionRow.role) as StaffRole,
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
          SELECT u.*, st.is_suspended
          FROM admin_users u
          LEFT JOIN staff st ON st.admin_user_id = u.id
          WHERE LOWER(u.email) = ?
        `)
        .get(emailLower) as Record<string, unknown> | undefined;

      if (!adminRow && BOOTSTRAP_SUPER_ADMIN_EMAILS.has(emailLower)) {
        const newId = generateId('adm');
        const displayName = decoded.name || 'NETCO Super Admin';
        db.prepare(`
          INSERT INTO admin_users (id, firebase_uid, email, full_name, role, is_active, last_login_at)
          VALUES (?, ?, ?, ?, 'SUPER_ADMIN', 1, ?)
        `).run(newId, decoded.uid, emailLower, displayName, nowIso);
        const codeExists = db.prepare('SELECT id FROM staff WHERE staff_code = ?').get('STF-001');
        const staffCode = codeExists ? generateReference('STF') : 'STF-001';
        db.prepare(`
          INSERT INTO staff (id, admin_user_id, staff_code, department, role)
          VALUES (?, ?, ?, 'Executive Operations', 'SUPER_ADMIN')
        `).run(generateId('stf'), newId, staffCode);
        adminRow = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(newId) as Record<string, unknown>;
      }

      if (!adminRow) {
        return res.status(403).json({ error: 'Account is not authorized as NETCO staff' });
      }
      if (!adminRow.is_active || adminRow.is_suspended) {
        return res.status(403).json({ error: 'Staff account is suspended or deactivated' });
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
        email: String(adminRow.email),
        fullName: String(adminRow.full_name),
        role: String(adminRow.role) as StaffRole,
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
