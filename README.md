# TRAX LINK — Multi-Tenant WiFi Billing & MikroTik Management SaaS

**`CONNECT. MANAGE. GROW.`**

TRAX LINK is a full-stack multi-tenant WiFi billing, voucher token, Tanzanian mobile money + card checkout, and MikroTik RouterOS / WireGuard / FreeRADIUS management platform designed for ISPs, hotspot operators, and standalone Pocket WiFi businesses.

---

## Key Capabilities

### 1. Customer Captive Portal (`/`)
- **Multi-Tenant Workspace Picker**: Customers pick their WiFi provider workspace before browsing plans or submitting support requests.
- **Mobile Money & Card Checkout**: Supports **M-Pesa**, **Airtel Money**, **Yas / Tigo Pesa**, **HaloPesa**, and **Visa / Mastercard** (`CARD`). Confirmed payments issue an immediate single-use **Voucher Token** (`NTC-XXXX-XXXX`).
- **Strict Single-Use & 1-Device-Name Lock**: Every voucher redeems once (`UNUSED` → `ACTIVE`) and locks to an explicit **Device Name** + device fingerprint in an atomic database transaction.
- **Customer Account & Support**: Customers can look up past purchases/tokens by phone or payment reference and send support tickets directly to their WiFi provider.
- **Bilingual (`EN` / `SW` Flags) & Dark/Light Mode**: Built-in English and Kiswahili switching across portal and admin workspaces.

### 2. Multi-Tenant Business & Super Admin Console (`/#admin`)
- **Self-Service Business Registration**: Independent WiFi businesses can sign up directly via **Register Business**, automatically creating an isolated workspace, default location, SaaS trial subscription, and `BUSINESS_OWNER` account.
- **TRAX Super Admin Console**: Manage all registered businesses (Approve / Activate / Suspend), inspect tenant workspaces, create SaaS pricing plans, monitor system health, and track platform SaaS revenue separately from tenant WiFi payments.
- **7-Role Backend RBAC**: `SUPER_ADMIN`, `BUSINESS_OWNER`, `ADMIN`, `ACCOUNTANT`, `NETWORK_OPERATOR`, `SUPPORT_STAFF`, and `CASHIER`.
- **Locations, Routers & WireGuard + RADIUS**: Manage multiple sites per business, register RouterOS v6/v7 gateways, generate ready-to-paste **WireGuard + FreeRADIUS** scripts, and retry failed router provisioning jobs.

---

## Operating Modes

| Mode | Default | Hardware Needed | Capabilities |
| :--- | :--- | :--- | :--- |
| **`STANDALONE_MODE`** | **Yes** | None (software or Airtel Pocket WiFi) | Multi-tenant workspaces, packages, single-use + 1-device vouchers, payment records, CSV/PDF reports, support tickets, and audit logs. |
| **`MIKROTIK_MODE`** | Optional | MikroTik RouterOS v6.43+ or v7.x | Adds RouterOS API telemetry, Hotspot profile sync, WireGuard + RADIUS integration, and router session disconnects. |

> **Hardware Note**: Consumer Pocket WiFi hotspots (e.g., Airtel Pocket WiFi) do not expose RouterOS API packet enforcement. In `STANDALONE_MODE`, TRAX LINK manages voucher tokens, payments, and session timers in software only.

---

## Quick Start (Local Development)

### Prerequisites
- **Python `3.11+`** (zero external pip dependencies required — pure standard library billing engine in `python_backend/`)
- **Node.js `22.x` or newer** + **npm** (Vite frontend & Socket.IO gateway)

### Setup & Run
```bash
npm install
cp .env.example .env
npm run dev
```

You can also run the Python WiFi Billing API directly:
```bash
python3 -m python_backend --host 127.0.0.1 --port 8001
```

Open:
- **Customer WiFi Portal (Default Landing)**: `http://localhost:3000/`
- **Business & Super Admin Console**: `http://localhost:3000/#admin`

---

## Testing & Verification

```bash
python3 -m unittest discover -s python_backend/tests -v
npm run lint
npm test
npx eslint firestore.rules
npm run build
```

See [`DEVELOPMENT_STATUS.md`](./DEVELOPMENT_STATUS.md) and [`docs/`](./docs/architecture/OVERVIEW.md) for architecture, API reference, security isolation, and production Docker deployment details.
