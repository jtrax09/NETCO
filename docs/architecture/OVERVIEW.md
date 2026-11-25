# TRAX LINK — System Architecture Overview

> **`CONNECT. MANAGE. GROW.`**

TRAX LINK is a modular, multi-tenant WiFi billing, voucher management, and MikroTik network operations SaaS platform.

## 1. High-Level Topology

```text
[WiFi Customer / Captive Portal (/)]
       │  Select Business Workspace · Buy Package (M-Pesa / Airtel / Yas / HaloPesa / Card)
       │  Validate & Redeem Single-Use Voucher Token (Locked to 1 Device Name)
       ▼
[Express + Socket.IO API Server (server.ts / src/server/app.ts)]
   ├── Auth & 7-Role RBAC (src/server/middleware/auth.ts)
   ├── Multi-Tenant Routes (src/server/routes/saasRoutes.ts)
   ├── Voucher Engine (src/server/services/vouchers.ts)
   ├── Payment & Webhook Verifier (src/server/services/payments.ts)
   ├── Subscription & RADIUS Policy Engine (src/server/services/billing.ts)
   ├── MikroTik RouterOS Service (src/server/services/mikrotik.ts)
   └── SQLite DB / Prisma PostgreSQL (src/server/db.ts, prisma/schema.prisma)
       │
       ├── STANDALONE_MODE (Default: No MikroTik hardware required)
       └── MIKROTIK_MODE (Optional: WireGuard + FreeRADIUS + RouterOS API)
```

## 2. Shared Domain Packages (`/packages`)
- `packages/shared`: Canonical TypeScript domain types (`StaffRole`, `OperatingMode`, `BusinessSummary`, `PackagePolicy`).
- `packages/validation`: Zod request schemas shared across routes (`businessRegistrationSchema`, `locationSchema`, `packagePayloadSchema`, `saasPlanSchema`).
- `packages/billing-engine`: Subscription policy computation (`computeSubscriptionPolicy`) and FreeRADIUS reply attribute builders.
- `packages/router-adapters`: RouterOS v6/v7 compatibility command generators and WireGuard + RADIUS MikroTik terminal snippet builder (`generateMikrotikWireguardSnippet`).

## 3. Infrastructure & Operations (`/infrastructure`, `/scripts`)
- `docker-compose.yml`: Multi-service stack (App, PostgreSQL, Redis, FreeRADIUS, Nginx).
- `infrastructure/freeradius/`: `rlm_rest` integration pointing to `/api/radius/authorize` and `/api/radius/accounting`.
- `infrastructure/wireguard/` & `infrastructure/nginx/`: Reverse proxy and VPN peer templates.
- `scripts/backup.sh` & `scripts/restore.sh`: PostgreSQL/SQLite backup & restore scripts.
