# NETCO Network Management System — Deployment & Operations Guide

## 1. Local & Container Quick Start

### Environment Variables
Copy `.env.example` to `.env` and set strong random secrets:
- `NETCO_MODE`: Operating mode default — `STANDALONE_MODE` (default, no MikroTik router required) or `MIKROTIK_MODE` (for live MikroTik RouterOS API control).
- `ROUTER_ENCRYPTION_KEY`: 32-byte hex or base64 secret (`openssl rand -hex 32`) used for AES-256-GCM encryption of MikroTik RouterOS credentials and voucher codes.
- `ADMIN_INITIAL_PASSCODE`: Initial bootstrap passcode for the first Super Admin (or use the first-run setup UI / Firebase Google Sign-In).
- `MPESA_*`, `AIRTEL_*`, `TIGO_*`, `HALOPESA_*`: Mobile money merchant credentials & webhook HMAC secrets. Without live credentials, NETCO supports Standalone Test Checkout for Voucher Tokens (`is_test = 1`), excluded from verified revenue reports.

### Commands
```bash
npm install
npm run lint
npm test
npm run build
npm run dev
```

## 2. Operating Modes (Standalone vs. MikroTik Hardware)

- **Standalone Mode (`STANDALONE_MODE`, default)**:
  - Runs all software billing, customer portal, voucher token generation/validation, single-device session locking, expiry enforcement, and reporting using SQLite without needing any router hardware.
  - **Airtel Pocket WiFi Limitation**: Consumer MiFi / Pocket WiFi devices do not support MikroTik RouterOS API or walled-garden captive portal rules. Standalone Mode tracks sessions in the database only and does not block/throttle WiFi traffic on an Airtel Pocket WiFi.
- **MikroTik Mode (`MIKROTIK_MODE`)**:
  - Enable once a MikroTik RouterOS unit is connected via the optional **Connect Router** screen.

## 3. Docker & PostgreSQL Production Deployment

1. Configure `.env` with `POSTGRES_PASSWORD`, `ROUTER_ENCRYPTION_KEY`, and mobile money keys.
2. Start PostgreSQL + NETCO:
   ```bash
   docker compose up -d --build
   ```
3. Run Prisma PostgreSQL migrations against `prisma/schema.prisma`:
   ```bash
   npx prisma migrate deploy --schema=prisma/schema.prisma
   ```

## 4. MikroTik RouterOS Hardware Requirements & Controls

- **Minimum RouterOS Version**: RouterOS v6.43+ or RouterOS v7.x (API port `8728` or API-SSL port `8729`).
- **Required RouterOS Services**: Enable `/ip service enable api` (or `api-ssl` with a valid certificate on LAN/VPN).
- **Recommended Network Topology**: Connect NETCO server to the MikroTik router over WireGuard VPN or dedicated management VLAN—never expose raw port `8728` unencrypted over public WAN.
- **Hotspot Walled Garden**: Add the NETCO portal domain/IP to `/ip hotspot walled-garden ip` so unauthenticated WiFi clients can reach the captive portal and mobile money prompts.
- **Network Controls Requiring RouterOS**:
  - Packet-level bandwidth queues (`rx/tx rate-limit` via `/ip/hotspot/user/profile`)
  - Layer-2/Layer-3 firewall drop/termination (`/ip/hotspot/active/remove`)
  - Real-time byte counters & interface telemetry (`/interface/print`, `/ip/hotspot/active/print`)
  - Note: Client phone Wi-Fi hotspot sharing cannot be disabled via software APIs; NETCO enforces one active authenticated session per voucher and supports RouterOS TTL/firewall mangle rules when configured on the router.

## 5. Backup & Restore

### SQLite Operational Database Backup
```bash
sqlite3 data/netco.db ".backup data/netco-backup-$(date +%F).db"
```

### PostgreSQL Backup & Restore
```bash
# Backup
docker compose exec postgres pg_dump -U netco -F c netco > netco_backup.dump

# Restore
docker compose exec -T postgres pg_restore -U netco -d netco --clean < netco_backup.dump
```
