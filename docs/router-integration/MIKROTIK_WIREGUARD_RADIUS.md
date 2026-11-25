# TRAX LINK — MikroTik, WireGuard & FreeRADIUS Integration Guide

## 1. Operating Mode Boundary
- **`STANDALONE_MODE` (Default)**: Requires **no MikroTik hardware**. Runs fully with an Airtel Pocket WiFi or no router at all. Note that consumer pocket WiFi devices do not support RouterOS API firewall/bandwidth rules.
- **`MIKROTIK_MODE` (Optional)**: Enable when you deploy MikroTik RouterOS hardware (`v6.43+` or `v7.x`).

## 2. Connecting a MikroTik Router via WireGuard + RADIUS
1. In the TRAX LINK Admin Console (`#admin` -> **Routers**), click **Connect Router** and register your router (selecting its **Location** and **RouterOS Family**: `v7.x` or `v6.43+`).
2. Click **WireGuard + RADIUS** on the router card to generate the exact RouterOS script (`GET /api/routers/:id/wireguard-snippet`) containing:
   - WireGuard interface & cloud peer setup (`10.66.0.10/24` -> Cloud `10.66.0.1`)
   - `/radius add service=hotspot address=10.66.0.1 secret=<RADIUS_SHARED_SECRET>`
   - Hotspot RADIUS + accounting interim-update configuration
   - Walled-garden allowlist rules for your TRAX LINK portal URL
3. Paste the generated script into WinBox / MikroTik Terminal and click **Test Connection**.

## 3. Offline Router Resilience (`provisioning_jobs`)
If a MikroTik router is temporarily offline when a customer completes payment:
- Payment verification **does not fail** or double-charge.
- The customer's subscription and voucher token are committed cleanly in the database.
- A `FAILED_RETRYING` entry is queued in `provisioning_jobs` so an operator can click **Retry Provision** in the **Subscriptions & Support** tab once the router tunnel comes back online.
