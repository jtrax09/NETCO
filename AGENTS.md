# NETCO — Engineering & Agent Guidelines

## 1. Architecture Overview
NETCO (`CONNECT. CONTROL. EXPERIENCE.`) is a full-stack WiFi voucher billing, customer portal, Tanzanian mobile money integration, and MikroTik RouterOS management platform built with:
- **Frontend**: React 19, Vite 8, TypeScript, Tailwind CSS v4, Lucide icons, Recharts, Socket.IO client, Firebase Auth/Firestore.
- **Backend**: Express + Socket.IO + Node.js (`tsx server.ts`) backed by SQLite (`node:sqlite` via `src/server/db.ts`), with a Prisma PostgreSQL schema (`prisma/schema.prisma`) for containerized deployments.

## 2. Operating Modes (`STANDALONE_MODE` vs `MIKROTIK_MODE`)
- **`STANDALONE_MODE` (Default)**:
  - Active automatically via `system_settings.operating_mode` (`NETCO_MODE` env var optional override).
  - Requires **zero** MikroTik router credentials, IP addresses, or RouterOS hardware to boot or operate.
  - Supports full database-backed admin RBAC, customer records, packages, voucher generation/validation/redemption, atomic single-device session locking, session expiration/revocation, payment tracking, CSV/PDF reports, and audit logs.
  - **Important hardware boundary**: When a site only has a consumer Airtel Pocket WiFi (and no MikroTik gateway), standalone mode manages voucher tokens and session states in software only—it cannot enforce packet-level firewall/bandwidth blocks on an Airtel Pocket WiFi.
  - Never create fake connected router statuses, never use `8.8.8.8` as a router IP, and never invent default Hotspot Server names (keep `hotspot_server` empty unless entered by an operator).
- **`MIKROTIK_MODE`**:
  - Activated optionally when MikroTik RouterOS hardware (v6.43+ / v7.x, API port `8728` / TLS `8729`) is available.
  - Router telemetry, hotspot profile pushing (`/ip/hotspot/user/profile`), and active session termination (`/ip/hotspot/active/remove`) run only against verified reachable routers in `src/server/services/mikrotik.ts`.

## 3. Payment & Voucher Rules
- **Live Gateway Webhooks**: Payments initiated with configured provider credentials stay `PENDING` until a valid HMAC-SHA256 webhook callback confirms completion (`is_test = 0`).
- **Standalone / Development Test Tokens**:
  - When mobile money gateway credentials are not yet configured, customers can complete standalone test checkout (`POST /api/portal/payments/:reference/confirm-test`) to receive an immediate Voucher Token (`NTC-XXXX-XXXX`, `is_test = 1`, `TST-...` receipt).
  - Admins can issue dev test voucher batches (`isTest: true`).
  - **Strict Revenue Isolation**: All `is_test = 1` payments and vouchers are excluded from verified real revenue metrics (`/api/dashboard/summary`, `/api/reports/overview`, `payments WHERE is_test = 0`).
- **Single-Use & One Device Name Per Voucher**: Every voucher code is strictly single-use (`UNUSED` -> `ACTIVE` once only; any second redemption attempt or post-logout reuse is blocked) and locked to one required `bound_device_name` + multi-signal `device_fingerprint` inside SQLite `BEGIN IMMEDIATE` transactions.

## 4. Security & Verification Standards
- Never hardcode plaintext passwords, API keys, or private credentials in code.
- Always run before finishing code changes:
  - `npm run lint`
  - `npm test`
  - `npx eslint firestore.rules`
  - `npm run build`
