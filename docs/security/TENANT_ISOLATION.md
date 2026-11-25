# TRAX LINK — Multi-Tenant Isolation & Security Model

## 1. Server-Derived Tenant Scoping (`resolveTenantScope`)
- Every authenticated staff session resolves `req.actor.businessId` and `req.actor.role` from the `admin_users` database row (`src/server/middleware/auth.ts`).
- Non-`SUPER_ADMIN` callers supplying a mismatched `x-tenant-id` header or attempting to mutate another tenant's `id` (`packages`, `customers`, `vouchers`, `routers`, `locations`, `subscriptions`, `support_tickets`) are rejected with `403 Cross-tenant access denied`.
- Spoofed `x-tenant-id` attempts automatically record a `CROSS_TENANT_ACCESS_BLOCKED` entry in `audit_logs`.

## 2. Role-Based Access Control (7 Roles)
- `SUPER_ADMIN`: Global platform governance, approve/suspend businesses, manage SaaS plans, inspect any tenant via explicit `x-tenant-id`.
- `BUSINESS_OWNER`: Full management of their business workspace, staff, routers, locations, packages, and SaaS subscription upgrades.
- `ADMIN`: Day-to-day business administration (customers, packages, vouchers, routers, reports, staff).
- `ACCOUNTANT`: Financial reports, payment reconciliation, refunds, voucher generation, CSV exports.
- `NETWORK_OPERATOR`: Router configuration, connection testing, WireGuard/RADIUS scripts, session termination, provisioning retries.
- `SUPPORT_STAFF`: Customer lookup, voucher/session visibility, and support ticket replies.
- `CASHIER`: Customer onboarding and POS voucher generation.

## 3. PostgreSQL Row-Level Security (RLS)
For containerized PostgreSQL deployments (`prisma/schema.prisma`), `infrastructure/postgresql/` defines tenant policies keyed off `current_setting('app.current_business_id', true)` as an extra defense-in-depth layer beneath API scoping.

## 4. Cryptographic Controls
- Staff passwords hashed with Node `crypto.scryptSync` + per-user random 16-byte salt.
- Voucher codes & RouterOS passwords encrypted at rest with AES-256-GCM (`ROUTER_ENCRYPTION_KEY`).
- Mobile money webhooks verified via HMAC-SHA256 with `crypto.timingSafeEqual`.
- FreeRADIUS REST endpoints require `X-Radius-Secret` verified with `crypto.timingSafeEqual`.
