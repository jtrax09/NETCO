# TRAX LINK — Acceptance & Integration Test Matrix

All backend integration tests execute against an in-memory SQLite instance (`src/server/__tests__/netco.test.ts`) and Firebase rules unit checks (`firestore.rules.test.ts`).

## Covered Verification Scenarios
1. **Admin Auth & Session Lifecycle**: Bootstrap once, reject duplicate bootstrap (`409`), reject invalid passwords (`401`), revoke session token on logout.
2. **Role-Based Access Control (RBAC)**: Restrict package creation/modification from `CASHIER`, validate payloads (`400`), support 7 SaaS roles.
3. **Single-Use + 1-Device-Name Vouchers**: Require `deviceLabel`, allow first redemption once (`UNUSED` -> `ACTIVE`), reject second device (`409`), reject different device name (`409`), reject duplicate redemption (`409`), permanently consume on logout (`403`).
4. **Expiration & Revocation**: Revoked vouchers blocked (`403`); expired session sweep marks stale vouchers `EXPIRED`.
5. **HMAC Webhook Verification & Idempotency**: Unsigned webhooks rejected (`401`), valid `sha256=` signature provisions `RCP-...` receipt + `NTC-...` voucher + active subscription, duplicate `externalEventId` does not duplicate vouchers.
6. **Password Recovery**: Unauthenticated `/forgot-password` never leaks codes; one-time recovery codes update password, revoke prior sessions, and reject reuse.
7. **Standalone Mode Safety**: Defaults to `STANDALONE_MODE`, reports `No MikroTik router connected`, rejects `8.8.8.8`, permits optional router configs without inventing `hotspot1`.
8. **Test vs Verified Revenue Isolation**: Standalone test tokens (`is_test = 1`) work end-to-end but remain excluded from verified real revenue metrics.
9. **Multi-Tenant Isolation**: Self-service registration (`POST /api/auth/register-business`) isolates tenants; cross-tenant edits and spoofed `x-tenant-id` headers return `403` and log `CROSS_TENANT_ACCESS_BLOCKED`.
10. **RADIUS & Offline Router Retry Queue**: `/api/radius/authorize` returns `Access-Accept` for active subscriptions and `401 Access-Reject` after suspension; unreachable MikroTik router queues `FAILED_RETRYING` in `provisioning_jobs` cleanly.
11. **SaaS vs WiFi Ledger Separation**: Business SaaS plan upgrades populate `saas_payments` without inflating tenant WiFi revenue.

## Commands
```bash
npm run lint
npm test
npx eslint firestore.rules
npm run build
```
