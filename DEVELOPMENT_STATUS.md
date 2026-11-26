# TRAX LINK — Development & Readiness Status

> **`CONNECT. MANAGE. GROW.`**

This document provides an exact breakdown of what is implemented and verified in automated SQLite/API integration tests versus what depends on external physical infrastructure, cloud deployment, or live merchant credentials.

---

## 1. Verified & Working (Tested in Python 3.11 Billing Engine + SQLite + Vite)

| Module | Implementation Status | Automated Test Coverage |
| :--- | :--- | :--- |
| **Python WiFi Billing Engine (`python_backend/`)** | Pure Python 3.11+ `ThreadingHTTPServer` (`python3 -m python_backend`), supervised by Node/Vite gateway (`server.ts`) | `test_billing_system.py` + `netco.test.ts` (live subprocess HTTP suite) |
| **Operating Modes (`STANDALONE_MODE` / `MIKROTIK_MODE`)** | Default `STANDALONE_MODE`; boots with zero MikroTik credentials; no fake router statuses or `8.8.8.8` / `hotspot1` stubs | `netco.test.ts` (mode switching, `8.8.8.8` rejection, optional router profile) |
| **Multi-Tenant Business Isolation** | Every business workspace has isolated `business_id` scope across packages, customers, vouchers, sessions, payments, invoices, locations, routers, subscriptions, tickets, and audit logs | `test_billing_system.py` + `netco.test.ts` (cross-tenant `403`, spoofed `x-tenant-id` block + audit logging) |
| **7-Role Backend RBAC** | `SUPER_ADMIN`, `BUSINESS_OWNER`, `ADMIN`, `ACCOUNTANT`, `NETWORK_OPERATOR`, `SUPPORT_STAFF`, `CASHIER` enforced in `python_backend/auth.py` | `netco.test.ts` (RBAC checks across roles, Super Admin governance) |
| **Super Admin SaaS Console** | Platform overview, Business Approve/Suspend/Activate, Workspace inspection, SaaS Plans CRUD, separate SaaS revenue ledger (`saas_payments`) | `netco.test.ts` + `SuperAdminView.tsx` |
| **Single-Use + 1-Device-Name Vouchers** | Atomic SQLite `BEGIN IMMEDIATE` redemption; requires `deviceLabel`; blocks second device, different device name, and post-logout reuse | `test_billing_system.py` + `netco.test.ts` |
| **Tanzanian Payments, Invoices & Webhooks** | `MPESA`, `AIRTEL_MONEY`, `TIGO_PESA`, `HALOPESA`, `CARD` endpoints; HMAC-SHA256 webhooks; sequential `INV-YYYYMM-...` invoices (`/api/invoices`); strict test revenue isolation | `test_billing_system.py` + `netco.test.ts` |
| **RADIUS Auth, Accounting & RFC 5176 UDP CoA** | `/api/radius/authorize`, `/api/radius/accounting` (data-cap auto-expiry), and real RFC 5176 UDP Disconnect-Request (`port 3799`) logged in `coa_disconnect_logs` | `test_billing_system.py` (UDP NAS ACK check) + `netco.test.ts` |
| **MikroTik RouterOS Binary Client** | Pure Python TCP/TLS RouterOS v6/v7 binary protocol client (`RouterOsClient`) with profile sync, user add, telemetry, and active session removal | `test_billing_system.py` (mock TCP RouterOS handshake) |
| **Customer-First iPhone-Style Portal (`/`)** | Opens directly to customer portal with frosted iOS top/bottom tab bar, category filters, Apple Wallet-style voucher pass, `EN`/`SW` flag switcher, and Light/Dark mode | Verified via `tsc --noEmit` & Vite production build |

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
