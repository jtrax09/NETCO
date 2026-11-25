# TRAX LINK — Development & Readiness Status

> **`CONNECT. MANAGE. GROW.`**

This document provides an exact breakdown of what is implemented and verified in automated SQLite/API integration tests versus what depends on external physical infrastructure, cloud deployment, or live merchant credentials.

---

## 1. Verified & Working (Tested in Local SQLite + Express + Vite Build)

| Module | Implementation Status | Automated Test Coverage |
| :--- | :--- | :--- |
| **Operating Modes (`STANDALONE_MODE` / `MIKROTIK_MODE`)** | Default `STANDALONE_MODE`; boots with zero MikroTik credentials; no fake router statuses or `8.8.8.8` / `hotspot1` stubs | `netco.test.ts` (mode switching, `8.8.8.8` rejection, optional router profile) |
| **Multi-Tenant Business Isolation** | Every business workspace has isolated `business_id` scope across packages, customers, vouchers, sessions, payments, locations, routers, subscriptions, tickets, and audit logs | `netco.test.ts` (self-service registration, cross-tenant `403`, spoofed `x-tenant-id` block + audit logging) |
| **7-Role Backend RBAC** | `SUPER_ADMIN`, `BUSINESS_OWNER`, `ADMIN`, `ACCOUNTANT`, `NETWORK_OPERATOR`, `SUPPORT_STAFF`, `CASHIER` enforced via `requireRole()` + `resolveTenantScope()` | `netco.test.ts` (RBAC checks across roles, Super Admin governance) |
| **Super Admin SaaS Console** | Platform overview, Business Approve/Suspend/Activate, Workspace inspection, SaaS Plans CRUD, separate SaaS revenue ledger (`saas_payments`) | `netco.test.ts` + `SuperAdminView.tsx` |
| **Single-Use + 1-Device-Name Vouchers** | Atomic SQLite `BEGIN IMMEDIATE` redemption; requires `deviceLabel`; blocks second device, different device name, and post-logout reuse | `netco.test.ts` (concurrent/duplicate/logout checks) |
| **Tanzanian Payments & Bank Card Interface** | `MPESA`, `AIRTEL_MONEY`, `TIGO_PESA`, `HALOPESA`, `CARD` endpoints; HMAC-SHA256 webhook verification; strict revenue isolation (`is_test = 0` vs `is_test = 1`) | `netco.test.ts` (HMAC verification, idempotency, test exclusion) |
| **RADIUS REST Adapter & Subscription Engine** | `/api/radius/authorize` (`Access-Accept` / `Access-Reject`) and `/api/radius/accounting` (`Start` / `Interim-Update` / `Stop`) | `netco.test.ts` (webhook provisions active RADIUS user; suspend triggers `401 Access-Reject`) |
| **Offline Router Retry Queue** | Unreachable MikroTik router during `MIKROTIK_MODE` activation does not fail payment; queues `provisioning_jobs` (`FAILED_RETRYING`) with `/retry` action | `netco.test.ts` |
| **Bilingual Portal & Admin Console** | `EN` / `SW` flags, Light/Dark mode, Workspace switcher, Purchase History & Active Token lookup, Customer Support Tickets, WireGuard + RADIUS script generator | Verified via TypeScript `tsc --noEmit` & Vite production bundle |

---

## 2. Requires External Infrastructure / Hardware Verification

The following artifacts and adapters are built in code/configs but **cannot be live-tested inside this sandbox** without external infrastructure or real hardware:

1. **Physical MikroTik RouterOS Hardware / CHR (`MIKROTIK_MODE`)**:
   - Real RouterOS v6.43+ / v7.x API calls (`/ip/hotspot/user/profile`, `/ip/hotspot/active/remove`, interface counters) require a reachable MikroTik router (e.g., hAP ac2, RB750Gr3, CCR2004, or Cloud Hosted Router).
   - **Airtel Pocket WiFi**: Consumer Pocket WiFi hotspots do not expose RouterOS API or packet-level firewall control. In `STANDALONE_MODE`, TRAX LINK manages voucher tokens, payments, and session timers in software only.
2. **FreeRADIUS Server + WireGuard VPN Tunnel**:
   - Container definitions and config templates live in `/infrastructure/freeradius/`, `/infrastructure/wireguard/`, and `/docker-compose.yml`. Live NAS-to-Cloud `rlm_rest` calls and WireGuard peer handshakes require a cloud VPS with UDP port `51820` open.
3. **PostgreSQL & Redis / BullMQ**:
   - `prisma/schema.prisma`, `infrastructure/postgresql/`, and `docker-compose.yml` target production PostgreSQL + Redis deployments. Local development and Vitest run against `node:sqlite` (`src/server/db.ts`).
4. **Live Tanzanian Mobile Money & Card Merchant APIs**:
   - Vodacom M-Pesa OpenAPI, Airtel Money OpenAPI, Mixx by Yas / Tigo Pesa, HaloPesa, and Bank Card gateways require merchant API keys and public HTTPS webhook endpoints configured in `.env`.
