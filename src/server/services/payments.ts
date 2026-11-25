import crypto from 'node:crypto';
import type { NetcoDb } from '../db.ts';
import { getOperatingMode, withTransaction } from '../db.ts';
import {
  decryptSecret,
  encryptSecret,
  generateId,
  generateReference,
  generateVoucherCode,
  maskVoucherCode,
  sha256,
} from '../utils/crypto.ts';
import { provisionSubscriptionForActivation } from './billing.ts';

export type MobileMoneyProvider = 'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA' | 'CARD';

export interface ProviderStatus {
  provider: MobileMoneyProvider;
  displayName: string;
  configured: boolean;
  missingCredentials: string[];
  webhookPath: string;
}

export function getProviderStatuses(): ProviderStatus[] {
  const checks: Array<{
    provider: MobileMoneyProvider;
    displayName: string;
    requiredEnv: string[];
    webhookPath: string;
  }> = [
    {
      provider: 'MPESA',
      displayName: 'Vodacom M-Pesa Tanzania',
      requiredEnv: ['MPESA_API_KEY', 'MPESA_PUBLIC_KEY', 'MPESA_SERVICE_PROVIDER_CODE', 'MPESA_WEBHOOK_SECRET'],
      webhookPath: '/api/payments/webhook/MPESA',
    },
    {
      provider: 'AIRTEL_MONEY',
      displayName: 'Airtel Money Tanzania',
      requiredEnv: ['AIRTEL_CLIENT_ID', 'AIRTEL_CLIENT_SECRET', 'AIRTEL_WEBHOOK_SECRET'],
      webhookPath: '/api/payments/webhook/AIRTEL_MONEY',
    },
    {
      provider: 'TIGO_PESA',
      displayName: 'Mixx by Yas (Tigo Pesa)',
      requiredEnv: ['TIGO_CLIENT_ID', 'TIGO_CLIENT_SECRET', 'TIGO_BILLER_CODE', 'TIGO_WEBHOOK_SECRET'],
      webhookPath: '/api/payments/webhook/TIGO_PESA',
    },
    {
      provider: 'HALOPESA',
      displayName: 'HaloPesa Tanzania',
      requiredEnv: ['HALOPESA_MERCHANT_CODE', 'HALOPESA_API_SECRET', 'HALOPESA_WEBHOOK_SECRET'],
      webhookPath: '/api/payments/webhook/HALOPESA',
    },
    {
      provider: 'CARD',
      displayName: 'Visa / Mastercard Gateway',
      requiredEnv: ['CARD_GATEWAY_KEY', 'CARD_WEBHOOK_SECRET'],
      webhookPath: '/api/payments/webhook/CARD',
    },
  ];

  return checks.map((c) => {
    const missingCredentials = c.requiredEnv.filter((key) => !process.env[key]?.trim());
    return {
      provider: c.provider,
      displayName: c.displayName,
      configured: missingCredentials.length === 0,
      missingCredentials,
      webhookPath: c.webhookPath,
    };
  });
}

export function getWebhookSecret(provider: MobileMoneyProvider): string | null {
  switch (provider) {
    case 'MPESA':
      return process.env.MPESA_WEBHOOK_SECRET?.trim() || null;
    case 'AIRTEL_MONEY':
      return process.env.AIRTEL_WEBHOOK_SECRET?.trim() || null;
    case 'TIGO_PESA':
      return process.env.TIGO_WEBHOOK_SECRET?.trim() || null;
    case 'HALOPESA':
      return process.env.HALOPESA_WEBHOOK_SECRET?.trim() || null;
    case 'CARD':
      return process.env.CARD_WEBHOOK_SECRET?.trim() || null;
  }
}

export function verifyWebhookSignature(
  provider: MobileMoneyProvider,
  rawPayload: string,
  signatureHeader: string | undefined
): { valid: boolean; reason?: string } {
  const secret = getWebhookSecret(provider);
  if (!secret) {
    return {
      valid: false,
      reason: `Webhook secret for ${provider} is not configured in server environment.`,
    };
  }
  if (!signatureHeader) {
    return { valid: false, reason: 'Missing X-Webhook-Signature header' };
  }
  const expected = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
  const provided = signatureHeader.replace(/^sha256=/i, '').trim();
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(provided, 'hex');
  if (a.length !== b.length || a.length === 0) {
    return { valid: false, reason: 'Invalid webhook signature format' };
  }
  if (!crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'Webhook HMAC signature mismatch' };
  }
  return { valid: true };
}

export function normalizeTanzaniaPhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('255') && digits.length === 12) return digits;
  if (digits.startsWith('0') && digits.length === 10) return `255${digits.slice(1)}`;
  if ((digits.startsWith('7') || digits.startsWith('6')) && digits.length === 9) return `255${digits}`;
  return null;
}

export function initiatePayment(
  db: NetcoDb,
  params: {
    packageId: string;
    provider: MobileMoneyProvider;
    phoneNumber: string;
    customerId?: string | null;
    businessId?: string | null;
  }
) {
  let contactValue = params.phoneNumber.trim();
  if (params.provider !== 'CARD') {
    const normalizedPhone = normalizeTanzaniaPhone(params.phoneNumber);
    if (!normalizedPhone) {
      throw new Error('Enter a valid Tanzanian mobile money number (e.g. 0712345678 or 255712345678).');
    }
    contactValue = normalizedPhone;
  } else if (contactValue.length < 4) {
    throw new Error('Enter a valid cardholder phone or billing email.');
  }

  const pkg = db
    .prepare('SELECT id, business_id, name, price_tzs, is_active FROM packages WHERE id = ?')
    .get(params.packageId) as
    | { id: string; business_id: string; name: string; price_tzs: number; is_active: number }
    | undefined;

  if (!pkg || !pkg.is_active) {
    throw new Error('Selected package is unavailable.');
  }
  if (params.businessId && pkg.business_id !== params.businessId) {
    throw new Error('Selected package does not belong to the chosen WiFi provider workspace.');
  }

  const businessId = pkg.business_id;
  const providerInfo = getProviderStatuses().find((p) => p.provider === params.provider);
  const providerConfigured = Boolean(providerInfo?.configured);
  const paymentMode = providerConfigured ? 'GATEWAY' : 'STANDALONE_TEST';
  const isTest = providerConfigured ? 0 : 1;
  const paymentId = generateId('pay');
  const reference = generateReference('TRX-PAY');
  const nowIso = new Date().toISOString();

  db.prepare(`
    INSERT INTO payments (
      id, business_id, reference, provider, phone_number, amount_tzs, status,
      is_test, payment_mode, package_id, customer_id, provider_payload, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    paymentId,
    businessId,
    reference,
    params.provider,
    contactValue,
    pkg.price_tzs,
    isTest,
    paymentMode,
    pkg.id,
    params.customerId ?? null,
    JSON.stringify({
      integrationMode: providerConfigured ? 'LIVE_GATEWAY' : 'STANDALONE_TEST_CHECKOUT',
      missingCredentials: providerInfo?.missingCredentials ?? [],
    }),
    nowIso,
    nowIso
  );

  return {
    paymentId,
    businessId,
    reference,
    provider: params.provider,
    phoneNumber: contactValue,
    packageName: pkg.name,
    amountTzs: pkg.price_tzs,
    status: 'PENDING' as const,
    isTest: Boolean(isTest),
    paymentMode,
    providerConfigured,
    missingCredentials: providerInfo?.missingCredentials ?? [],
    message: providerConfigured
      ? `Payment request ${reference} queued for ${params.provider}. Complete verification for ${contactValue}.`
      : `Transaction ${reference} created in Standalone Mode. Confirm payment below to receive your Voucher Token.`,
  };
}

export function confirmStandalonePaymentForToken(db: NetcoDb, reference: string) {
  return withTransaction(db, () => {
    const payment = db
      .prepare(`
        SELECT p.*, pk.name as package_name
        FROM payments p
        JOIN packages pk ON pk.id = p.package_id
        WHERE p.reference = ?
      `)
      .get(reference) as Record<string, unknown> | undefined;

    if (!payment) {
      throw new Error('Payment reference not found');
    }

    const providerStatus = getProviderStatuses().find((p) => p.provider === String(payment.provider));
    const mode = getOperatingMode(db);
    if (providerStatus?.configured && mode !== 'STANDALONE_MODE' && !payment.is_test) {
      throw new Error('Live payment gateway is active; voucher issuance requires verified provider webhook confirmation.');
    }

    if (String(payment.status) === 'COMPLETED' && payment.voucher_id) {
      const existingVoucher = db
        .prepare('SELECT code_encrypted FROM vouchers WHERE id = ?')
        .get(String(payment.voucher_id)) as { code_encrypted: string } | undefined;
      return {
        reference: String(payment.reference),
        businessId: String(payment.business_id),
        provider: String(payment.provider),
        phoneNumber: String(payment.phone_number),
        packageName: String(payment.package_name),
        amountTzs: Number(payment.amount_tzs),
        status: 'COMPLETED',
        isTest: Boolean(payment.is_test),
        receiptNumber: payment.receipt_number ? String(payment.receipt_number) : null,
        voucherCode: existingVoucher ? decryptSecret(existingVoucher.code_encrypted) : null,
      };
    }

    if (String(payment.status) !== 'PENDING') {
      throw new Error(`Cannot issue token for payment in status ${payment.status}`);
    }

    const voucherCode = generateVoucherCode();
    const voucherId = generateId('vch');
    const receiptNumber = generateReference('TST');
    const nowIso = new Date().toISOString();
    const businessId = String(payment.business_id);

    db.prepare(`
      INSERT INTO vouchers (
        id, business_id, code_hash, code_encrypted, code_masked, batch_id,
        package_id, customer_id, status, is_test, test_note, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', 1, ?, ?, ?)
    `).run(
      voucherId,
      businessId,
      sha256(voucherCode),
      encryptSecret(voucherCode),
      maskVoucherCode(voucherCode),
      `TOKEN-${String(payment.provider)}`,
      String(payment.package_id),
      payment.customer_id ? String(payment.customer_id) : null,
      `Standalone checkout token (${String(payment.reference)})`,
      nowIso,
      nowIso
    );

    db.prepare(`
      UPDATE payments
      SET status = 'COMPLETED',
          is_test = 1,
          payment_mode = 'STANDALONE_TEST',
          receipt_number = ?,
          voucher_id = ?,
          verified_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(receiptNumber, voucherId, nowIso, nowIso, String(payment.id));

    db.prepare(`
      INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
      VALUES (?, ?, 'STANDALONE_TOKEN_ISSUED', 'INFO', ?, ?, ?)
    `).run(
      generateId('ntf'),
      businessId,
      `[TEST MODE] Token Issued (${receiptNumber})`,
      `Standalone payment ${String(payment.reference)} issued dev/test voucher token for ${String(payment.package_name)} (excluded from verified revenue).`,
      JSON.stringify({ reference: String(payment.reference), receiptNumber, voucherId, isTest: true })
    );

    return {
      reference: String(payment.reference),
      businessId,
      provider: String(payment.provider),
      phoneNumber: String(payment.phone_number),
      packageName: String(payment.package_name),
      amountTzs: Number(payment.amount_tzs),
      status: 'COMPLETED',
      isTest: true,
      receiptNumber,
      voucherCode,
    };
  });
}

export async function processVerifiedPaymentCallback(
  db: NetcoDb,
  params: {
    provider: MobileMoneyProvider;
    externalEventId: string;
    reference: string;
    externalTxId: string;
    status: 'COMPLETED' | 'FAILED' | 'REFUNDED';
    amountTzs?: number;
    rawPayload: Record<string, unknown>;
  }
): Promise<{
  duplicate: boolean;
  paymentId: string;
  businessId: string;
  reference: string;
  status: string;
  receiptNumber?: string;
  issuedVoucherCode?: string;
  subscriptionId?: string;
  provisioningStatus?: string;
}> {
  const txResult = withTransaction(db, () => {
    const existingEvent = db
      .prepare('SELECT id FROM webhook_events WHERE provider = ? AND external_event_id = ?')
      .get(params.provider, params.externalEventId) as { id: string } | undefined;

    const payment = db
      .prepare(`
        SELECT p.*, pk.duration_minutes, pk.location_id
        FROM payments p
        JOIN packages pk ON pk.id = p.package_id
        WHERE p.reference = ?
      `)
      .get(params.reference) as Record<string, unknown> | undefined;

    if (!payment) {
      throw new Error(`Payment reference ${params.reference} not found`);
    }

    const businessId = String(payment.business_id);

    if (existingEvent) {
      return {
        duplicate: true,
        paymentId: String(payment.id),
        businessId,
        reference: String(payment.reference),
        status: String(payment.status),
        receiptNumber: payment.receipt_number ? String(payment.receipt_number) : undefined,
        shouldProvision: false,
      };
    }

    if (params.amountTzs !== undefined && Number(params.amountTzs) !== Number(payment.amount_tzs)) {
      throw new Error('Payment callback amount mismatch');
    }

    db.prepare(`
      INSERT INTO webhook_events (id, provider, external_event_id, payment_reference, payload)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      generateId('whk'),
      params.provider,
      params.externalEventId,
      params.reference,
      JSON.stringify(params.rawPayload)
    );

    const nowIso = new Date().toISOString();

    if (params.status === 'FAILED') {
      db.prepare(`
        UPDATE payments
        SET status = 'FAILED', external_tx_id = ?, provider_payload = ?, updated_at = ?
        WHERE id = ? AND status = 'PENDING'
      `).run(params.externalTxId, JSON.stringify(params.rawPayload), nowIso, String(payment.id));

      db.prepare(`
        INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
        VALUES (?, ?, 'PAYMENT_FAILED', 'WARNING', ?, ?, ?)
      `).run(
        generateId('ntf'),
        businessId,
        `Payment Failed (${params.reference})`,
        `${params.provider} payment for ${payment.phone_number} failed verification.`,
        JSON.stringify({ reference: params.reference, provider: params.provider })
      );

      return {
        duplicate: false,
        paymentId: String(payment.id),
        businessId,
        reference: String(payment.reference),
        status: 'FAILED',
        shouldProvision: false,
      };
    }

    if (params.status === 'REFUNDED') {
      db.prepare(`
        UPDATE payments
        SET status = 'REFUNDED', refunded_at = ?, provider_payload = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, JSON.stringify(params.rawPayload), nowIso, String(payment.id));

      if (payment.voucher_id) {
        db.prepare(`
          UPDATE vouchers
          SET status = 'REVOKED', revoked_at = ?, revoked_reason = 'Payment refunded', updated_at = ?
          WHERE id = ? AND status != 'REVOKED'
        `).run(nowIso, nowIso, String(payment.voucher_id));
      }

      db.prepare("UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE payment_id = ?").run(
        nowIso,
        nowIso,
        String(payment.id)
      );

      return {
        duplicate: false,
        paymentId: String(payment.id),
        businessId,
        reference: String(payment.reference),
        status: 'REFUNDED',
        receiptNumber: payment.receipt_number ? String(payment.receipt_number) : undefined,
        shouldProvision: false,
      };
    }

    // COMPLETED — only create voucher & subscription if not already issued
    if (String(payment.status) === 'COMPLETED' && payment.voucher_id) {
      return {
        duplicate: true,
        paymentId: String(payment.id),
        businessId,
        reference: String(payment.reference),
        status: 'COMPLETED',
        receiptNumber: payment.receipt_number ? String(payment.receipt_number) : undefined,
        shouldProvision: false,
      };
    }

    const voucherCode = generateVoucherCode();
    const voucherId = generateId('vch');
    const receiptNumber = generateReference('RCP');

    db.prepare(`
      INSERT INTO vouchers (
        id, business_id, code_hash, code_encrypted, code_masked, batch_id,
        package_id, customer_id, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', ?, ?)
    `).run(
      voucherId,
      businessId,
      sha256(voucherCode),
      encryptSecret(voucherCode),
      maskVoucherCode(voucherCode),
      `PAY-${params.provider}`,
      String(payment.package_id),
      payment.customer_id ? String(payment.customer_id) : null,
      nowIso,
      nowIso
    );

    db.prepare(`
      UPDATE payments
      SET status = 'COMPLETED',
          is_test = 0,
          receipt_number = ?,
          external_tx_id = ?,
          voucher_id = ?,
          provider_payload = ?,
          verified_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      receiptNumber,
      params.externalTxId,
      voucherId,
      JSON.stringify(params.rawPayload),
      nowIso,
      nowIso,
      String(payment.id)
    );

    db.prepare(`
      INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
      VALUES (?, ?, 'PAYMENT_SUCCESS', 'INFO', ?, ?, ?)
    `).run(
      generateId('ntf'),
      businessId,
      `Payment Verified (${receiptNumber})`,
      `${params.provider} payment of ${Number(payment.amount_tzs).toLocaleString()} TZS verified; voucher & RADIUS subscription issued.`,
      JSON.stringify({ reference: params.reference, receiptNumber, voucherId })
    );

    const expiresAtIso = new Date(Date.now() + Number(payment.duration_minutes) * 60_000).toISOString();
    return {
      duplicate: false,
      paymentId: String(payment.id),
      businessId,
      locationId: payment.location_id ? String(payment.location_id) : null,
      customerId: payment.customer_id ? String(payment.customer_id) : null,
      packageId: String(payment.package_id),
      voucherId,
      reference: String(payment.reference),
      status: 'COMPLETED',
      receiptNumber,
      issuedVoucherCode: voucherCode,
      startsAtIso: nowIso,
      expiresAtIso,
      shouldProvision: true,
    };
  });

  if (!txResult.shouldProvision || !txResult.issuedVoucherCode) {
    return {
      duplicate: txResult.duplicate,
      paymentId: txResult.paymentId,
      businessId: txResult.businessId,
      reference: txResult.reference,
      status: txResult.status,
      receiptNumber: txResult.receiptNumber,
    };
  }

  const radiusUsername = txResult.issuedVoucherCode.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const prov = await provisionSubscriptionForActivation(db, {
    businessId: txResult.businessId,
    locationId: txResult.locationId ?? null,
    customerId: txResult.customerId ?? null,
    packageId: txResult.packageId!,
    paymentId: txResult.paymentId,
    voucherId: txResult.voucherId!,
    radiusUsername,
    radiusSecretValue: txResult.issuedVoucherCode,
    startsAtIso: txResult.startsAtIso!,
    expiresAtIso: txResult.expiresAtIso!,
  });

  return {
    duplicate: false,
    paymentId: txResult.paymentId,
    businessId: txResult.businessId,
    reference: txResult.reference,
    status: 'COMPLETED',
    receiptNumber: txResult.receiptNumber,
    issuedVoucherCode: txResult.issuedVoucherCode,
    subscriptionId: prov.subscriptionId,
    provisioningStatus: prov.provisioningStatus,
  };
}
