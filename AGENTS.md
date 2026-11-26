# TRAX LINK — Engineering & Agent Guidelines

## 1. Architecture Overview
TRAX LINK (`CONNECT. MANAGE. GROW.`) is a multi-tenant SaaS WiFi voucher billing, customer portal, Tanzanian mobile money + card checkout, FreeRADIUS adapter, and MikroTik RouterOS management platform built with:
- **Frontend**: React 19, Vite 8, TypeScript, Tailwind CSS v4, Lucide icons, Recharts, Socket.IO client, Firebase Auth/Firestore (defaults to the customer portal at `/`).
- **Python WiFi Billing Engine (`python_backend/`)**: Pure Python 3.11+ standard-library `ThreadingHTTPServer` (`python3 -m python_backend`) backed by SQLite (`python_backend/db.py`), real FreeRADIUS `radcheck`/`radreply`/`radacct` policy & RFC 5176 UDP CoA Disconnect (`python_backend/services/billing.py`), MikroTik RouterOS binary TCP/TLS API client (`python_backend/services/mikrotik.py`), Tanzanian mobile money/card gateway & HMAC webhook processor (`python_backend/services/payments.py`), and invoice generation.
- **Node/Vite Gateway (`server.ts`)**: Supervises the Python billing process on `PYTHON_API_PORT`, proxies `/api/*` requests, bridges `X-Trax-Events` to Socket.IO, and serves Vite on port `3000`.

## 2. Multi-Tenant Isolation & RBAC
- Every business-owned record (`customers`, `packages`, `vouchers`, `sessions`, `payments`, `invoices`, `routers`, `locations`, `subscriptions`, `support_tickets`, `notifications`, `audit_logs`) is strictly scoped by `business_id`.
- Always resolve tenant scope server-side via `resolve_tenant_scope` in `python_backend/auth.py`. Never trust a client-supplied `businessId` or `x-tenant-id` without verifying role authorization (`SUPER_ADMIN` only for cross-tenant inspection).
- Supported roles: `SUPER_ADMIN`, `BUSINESS_OWNER`, `ADMIN`, `ACCOUNTANT`, `NETWORK_OPERATOR`, `SUPPORT_STAFF`, `CASHIER`.

## 3. Operating Modes (`STANDALONE_MODE` vs `MIKROTIK_MODE`)
- **`STANDALONE_MODE` (Default)**:
  - Active automatically via `system_settings.operating_mode` (`NETCO_MODE` env var optional override).
  - Requires **zero** MikroTik router credentials, IP addresses, or RouterOS hardware to boot or operate.
  - **Important hardware boundary**: When a site only has a consumer Airtel Pocket WiFi (and no MikroTik gateway), standalone mode manages voucher tokens and session states in software only—it cannot enforce packet-level firewall/bandwidth blocks on an Airtel Pocket WiFi.
  - Never create fake connected router statuses, never use `8.8.8.8` as a router IP, and never invent default Hotspot Server names (keep `hotspot_server` empty unless entered by an operator).
- **`MIKROTIK_MODE`**:
  - Activated optionally when MikroTik RouterOS hardware (v6.43+ / v7.x, API port `8728` / TLS `8729`) is available.
  - Router telemetry, hotspot profile pushing, WireGuard + RADIUS snippet generation, and retryable provisioning (`provisioning_jobs`) never silently fail payments or invent connected states.

## 4. Payment, Voucher & Revenue Rules
- **Live Gateway Webhooks**: Payments initiated with configured provider credentials stay `PENDING` until a valid HMAC-SHA256 webhook callback confirms completion (`is_test = 0`).
- **Standalone / Development Test Tokens**:
  - When gateway credentials are not yet configured, customers can complete standalone test checkout (`POST /api/portal/payments/:reference/confirm-test`) to receive an immediate Voucher Token (`NTC-XXXX-XXXX`, `is_test = 1`, `TST-...` receipt).
  - **Strict Revenue Isolation**: All `is_test = 1` payments and vouchers are excluded from verified real revenue metrics (`/api/dashboard/summary`, `/api/reports/overview`, `payments WHERE is_test = 0`). SaaS plan payments (`saas_payments`) remain strictly isolated from tenant WiFi revenue (`payments`).
- **Single-Use & One Device Name Per Voucher**: Every voucher code is strictly single-use (`UNUSED` -> `ACTIVE` once only; any second redemption attempt or post-logout reuse is blocked) and locked to one required `bound_device_name` + multi-signal `device_fingerprint` inside SQLite `BEGIN IMMEDIATE` transactions.

## 5. Security & Verification Standards
- Never hardcode plaintext passwords, API keys, or private credentials in code.
- Always run before finishing code changes:
  - `npm run lint`
  - `npm test`
  - `npx eslint firestore.rules`
  - `npm run build`
