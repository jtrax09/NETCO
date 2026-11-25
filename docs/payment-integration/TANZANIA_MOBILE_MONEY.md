# TRAX LINK — Tanzanian Mobile Money & Card Payments

## Supported Payment Channels
- **Vodacom M-Pesa** (`MPESA`)
- **Airtel Money** (`AIRTEL_MONEY`)
- **Yas / Tigo Pesa** (`TIGO_PESA`)
- **HaloPesa** (`HALOPESA`)
- **Visa / Mastercard** (`CARD`)

## Checkout & Verification Lifecycle
1. Customer selects a Business Workspace and WiFi Package on `/` and submits phone/email via `POST /api/portal/payments/initiate`.
2. **Configured Gateway (`is_test = 0`)**:
   - Payment remains `PENDING`.
   - Only when the provider sends a valid HMAC-SHA256 signed callback to `POST /api/payments/webhook/:provider` with `status = COMPLETED` does TRAX LINK mark the payment `COMPLETED`, issue a receipt (`RCP-...`), generate a single-use Voucher Token (`NTC-XXXX-XXXX`), and provision an active RADIUS subscription.
   - Duplicate webhook deliveries (`external_event_id`) are safely deduplicated.
3. **Standalone / Unconfigured Gateway (`is_test = 1`)**:
   - When provider credentials are blank in `.env`, customers can complete standalone test checkout (`POST /api/portal/payments/:reference/confirm-test`) to receive a test Voucher Token (`TST-...` receipt).
   - **Strict Ledger Isolation**: Every `is_test = 1` payment is excluded from verified real revenue KPIs and provider revenue reports.
4. **SaaS Platform Billing Separation**:
   - Business plan upgrades (`POST /api/business/subscription/checkout`) write to `saas_payments`, strictly separated from tenant customer WiFi revenue (`payments`).
