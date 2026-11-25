import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import express from 'express';
import { Server as SocketIOServer } from 'socket.io';
import {
  createDatabase,
  DEFAULT_BUSINESS_ID,
  expireStaleRecords,
  withTransaction,
  type NetcoDb,
} from './src/server/db.ts';
import { createApp } from './src/server/app.ts';
import { processDueProvisioningJobs } from './src/server/services/billing.ts';
import { generateId, generateReference, hashPassword } from './src/server/utils/crypto.ts';

const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const DEFAULT_STAFF_ACCOUNTS = [
  { email: 'undergodmusic255@gmail.com', fullName: 'UNDER GOD MUSIC', code: 'STF-001' },
  { email: 'mlingwajastine277@gmail.com', fullName: 'TRAX LINK Platform Admin', code: 'STF-002' },
];
const DEFAULT_STAFF_PASSWORD_HASH =
  'scrypt:5eda2d3d4bca4af575be144081e79c08:a17d12d23968499072b046c640d4264ff370ed1d9c407ab777a1820f7074d337d4096e4b269d82ef71b2c0e0a7e9f682a75fe4946cdb153522195eccd615fe00';

function ensurePrimaryStaffAccount(db: NetcoDb) {
  const customEmail = process.env.STAFF_EMAIL?.trim().toLowerCase();
  const passwordHash = process.env.STAFF_PASSWORD?.trim()
    ? hashPassword(process.env.STAFF_PASSWORD.trim())
    : DEFAULT_STAFF_PASSWORD_HASH;
  const accounts = customEmail
    ? [{ email: customEmail, fullName: 'TRAX LINK Platform Admin', code: 'STF-001' }, ...DEFAULT_STAFF_ACCOUNTS]
    : DEFAULT_STAFF_ACCOUNTS;
  const nowIso = new Date().toISOString();

  withTransaction(db, () => {
    for (const acct of accounts) {
      const existing = db
        .prepare('SELECT id, password_hash FROM admin_users WHERE LOWER(email) = ?')
        .get(acct.email) as { id: string; password_hash: string | null } | undefined;

      if (existing) {
        if (!existing.password_hash) {
          db.prepare('UPDATE admin_users SET password_hash = ?, is_active = 1, updated_at = ? WHERE id = ?').run(
            passwordHash,
            nowIso,
            existing.id
          );
        }
        continue;
      }

      const adminId = generateId('adm');
      const codeExists = db.prepare('SELECT id FROM staff WHERE staff_code = ?').get(acct.code);
      const staffCode = codeExists ? generateReference('STF') : acct.code;

      db.prepare(`
        INSERT INTO admin_users (id, business_id, email, full_name, password_hash, role, is_active, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'SUPER_ADMIN', 1, ?, ?)
      `).run(adminId, DEFAULT_BUSINESS_ID, acct.email, acct.fullName, passwordHash, nowIso, nowIso);

      db.prepare(`
        INSERT INTO staff (id, business_id, admin_user_id, staff_code, department, role, is_suspended)
        VALUES (?, ?, ?, ?, 'Executive Operations', 'SUPER_ADMIN', 0)
      `).run(generateId('stf'), DEFAULT_BUSINESS_ID, adminId, staffCode);
    }
  });
}

async function startServer() {
  const db = createDatabase();
  ensurePrimaryStaffAccount(db);
  const httpServer = http.createServer();

  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: true,
      credentials: true,
    },
  });

  io.on('connection', (socket) => {
    socket.emit('netco:connected', { timestamp: new Date().toISOString(), brand: 'TRAX LINK' });
  });

  const app = createApp(db, io);

  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    if (fs.existsSync(distDir)) {
      app.use(express.static(distDir));
      app.get('*', (req, res, next) => {
        if (req.path.startsWith('/api')) return next();
        res.sendFile(path.join(distDir, 'index.html'));
      });
    }
  }

  httpServer.on('request', app);

  // Periodic background sweep for expired sessions/vouchers/subscriptions + offline router retries
  const sweepTimer = setInterval(async () => {
    try {
      const res = expireStaleRecords(db);
      if (res.expiredSessions > 0 || res.expiredSubscriptions > 0) {
        io.emit('session:ended', {
          expiredCount: res.expiredSessions,
          expiredSubscriptions: res.expiredSubscriptions,
        });
      }
      await processDueProvisioningJobs(db, 10);
    } catch (err) {
      console.error('Background sweep error:', err);
    }
  }, 30_000);
  sweepTimer.unref();

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`TRAX LINK Platform listening on http://0.0.0.0:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start TRAX LINK server:', err);
  process.exit(1);
});
