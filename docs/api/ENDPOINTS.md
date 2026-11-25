# TRAX LINK — REST API Reference

All tenant endpoints derive `businessId` from the authenticated user's JWT/session record on the server (`resolveTenantScope`), never blindly from request bodies. Only `SUPER_ADMIN` may pass `x-tenant-id` to inspect another tenant workspace.

## Public Customer Portal
- `GET /api/system/mode` — Returns active mode (`STANDALONE_MODE` / `MIKROTIK_MODE`), router counts, and Airtel Pocket WiFi disclaimer.
- `GET /api/portal/businesses` — Lists active ISP/WiFi business workspaces for portal selection.
- `GET /api/portal/packages?business=<id|slug>` — Lists active WiFi plans.
- `POST /api/portal/validate` — Validates a voucher code (`UNUSED`, `ACTIVE`, `EXPIRED`, `REVOKED`) without redeeming it.
- `POST /api/portal/redeem` — Atomically consumes an `UNUSED` voucher once, locking it to `deviceLabel` + `deviceFingerprint`.
- `GET /api/portal/session` — Fetches live remaining seconds & bandwidth policy via `X-Portal-Session`.
- `POST /api/portal/logout` — Terminates active session and expires the single-use voucher.
- `POST /api/portal/payments/initiate` — Initiates `MPESA`, `AIRTEL_MONEY`, `TIGO_PESA`, `HALOPESA`, or `CARD` checkout.
- `POST /api/portal/payments/:reference/confirm-test` — Completes standalone test checkout when gateway credentials are absent (`is_test = 1`).
- `GET /api/portal/account?phone=...&reference=...` — Customer purchase history and unredeemed token lookup.
- `POST /api/portal/support` — Submits a customer support ticket scoped to the selected business.

## Authentication & Onboarding
- `GET /api/auth/bootstrap-status` — Checks whether initial `SUPER_ADMIN` setup is needed.
- `POST /api/auth/bootstrap` — Creates the initial `SUPER_ADMIN` account (one-time).
- `POST /api/auth/register-business` — Self-service onboarding creating a `businesses` workspace, primary `locations` site, `TRIAL` SaaS subscription, and `BUSINESS_OWNER` account.
- `POST /api/auth/login` / `POST /api/auth/logout` / `GET /api/auth/me`
- `POST /api/auth/forgot-password` / `POST /api/auth/reset-password`

## Tenant Workspace Operations
- `GET /api/dashboard/summary` — Real KPIs, verified revenue (`is_test = 0`), router health, activity feed.
- `GET|POST|PATCH|DELETE /api/customers`
- `GET|POST|PATCH|DELETE /api/packages`
- `GET /api/vouchers`, `POST /api/vouchers/generate`, `POST /api/vouchers/:id/revoke`, `GET /api/vouchers/:id/redemptions`, `GET /api/vouchers/export/csv`
- `GET|POST /api/locations`, `DELETE /api/locations/:id`
- `GET|POST /api/subscriptions`, `POST /api/subscriptions/:id/suspend`, `POST /api/provisioning-jobs/:id/retry`
- `GET /api/sessions`, `POST /api/sessions/:id/terminate`, `POST /api/sessions/expire-sweep`
- `GET /api/payments`, `GET /api/payments/providers`, `POST /api/payments/:id/refund`, `POST /api/payments/webhook/:provider`
- `GET|POST|PATCH|DELETE /api/routers`, `POST /api/routers/:id/test`, `GET /api/routers/:id/interfaces`, `POST /api/routers/:id/sync-profiles`, `GET /api/routers/:id/wireguard-snippet`
- `GET /api/support-tickets`, `PATCH /api/support-tickets/:id`
- `GET /api/business/subscription`, `POST /api/business/subscription/checkout`
- `GET|POST|PATCH /api/staff`, `GET /api/staff/sessions`, `POST /api/staff/sessions/:id/revoke`, `GET /api/audit-logs`

## FreeRADIUS Adapter
- `POST /api/radius/authorize` — Authenticated via `X-Radius-Secret`; returns `Access-Accept` with `Mikrotik-Rate-Limit`, `Session-Timeout`, and `Mikrotik-Total-Limit` or `401 Access-Reject`.
- `POST /api/radius/accounting` — Authenticated via `X-Radius-Secret`; processes `Start`, `Interim-Update`, and `Stop` octets & session timers.

## TRAX Super Admin Platform Console
- `GET /api/superadmin/overview`
- `GET /api/superadmin/businesses`, `PATCH /api/superadmin/businesses/:id/status`
- `GET|POST /api/superadmin/plans`
- `GET /api/superadmin/saas-payments`
