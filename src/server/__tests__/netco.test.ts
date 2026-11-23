import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { createDatabase, type NetcoDb } from '../db.ts';
import { createApp } from '../app.ts';

interface TestServer {
  baseUrl: string;
  close: () => Promise<void>;
}

async function startTestServer(db: NetcoDb): Promise<TestServer> {
  const app = createApp(db);
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind test server');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

async function api(
  baseUrl: string,
  path: string,
  options: { method?: string; token?: string; body?: unknown; headers?: Record<string, string> } = {}
) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json, headers: res.headers };
}

describe('NETCO Network Management System — End-to-End Backend Suite', () => {
  let db: NetcoDb;
  let srv: TestServer;
  let adminToken: string;

  beforeEach(async () => {
    delete process.env.ADMIN_INITIAL_PASSCODE;
    process.env.MPESA_WEBHOOK_SECRET = 'test_mpesa_secret_key_2026';
    db = createDatabase(':memory:');
    srv = await startTestServer(db);

    const boot = await api(srv.baseUrl, '/api/auth/bootstrap', {
      method: 'POST',
      body: {
        email: 'superadmin@netco.co.tz',
        fullName: 'NETCO Chief Admin',
        password: 'StrongPassword#2026',
      },
    });
    expect(boot.status).toBe(201);
    adminToken = String(boot.json.token);
  });

  afterEach(async () => {
    await srv.close();
    db.close();
  });

  it('authenticates admin, blocks duplicate bootstrap, and revokes session on logout', async () => {
    const dupBoot = await api(srv.baseUrl, '/api/auth/bootstrap', {
      method: 'POST',
      body: { email: 'other@netco.co.tz', fullName: 'Attacker', password: 'Password123!' },
    });
    expect(dupBoot.status).toBe(409);

    const badLogin = await api(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'superadmin@netco.co.tz', password: 'WrongPassword' },
    });
    expect(badLogin.status).toBe(401);

    const goodLogin = await api(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'superadmin@netco.co.tz', password: 'StrongPassword#2026' },
    });
    expect(goodLogin.status).toBe(200);
    const loginToken = String(goodLogin.json.token);

    const meBefore = await api(srv.baseUrl, '/api/auth/me', { token: loginToken });
    expect(meBefore.status).toBe(200);

    await api(srv.baseUrl, '/api/auth/logout', { method: 'POST', token: loginToken });
    const meAfter = await api(srv.baseUrl, '/api/auth/me', { token: loginToken });
    expect(meAfter.status).toBe(401);
  });

  it('enforces RBAC permissions for Cashier vs Super Admin and validates payloads', async () => {
    const createCashier = await api(srv.baseUrl, '/api/staff', {
      method: 'POST',
      token: adminToken,
      body: {
        email: 'cashier@netco.co.tz',
        fullName: 'Front Desk Cashier',
        password: 'CashierPass#2026',
        role: 'CASHIER',
        department: 'POS Desk',
      },
    });
    expect(createCashier.status).toBe(201);

    const cashierLogin = await api(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'cashier@netco.co.tz', password: 'CashierPass#2026' },
    });
    const cashierToken = String(cashierLogin.json.token);

    // Cashier cannot create packages
    const pkgAttempt = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: cashierToken,
      body: {
        name: 'Unauthorized Pkg',
        category: 'DAILY',
        priceTzs: 1000,
        durationMinutes: 1440,
        downloadKbps: 5000,
        uploadKbps: 2000,
      },
    });
    expect(pkgAttempt.status).toBe(403);

    // Validation rejects negative price
    const badPkg = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Bad',
        category: 'DAILY',
        priceTzs: -50,
        durationMinutes: 60,
        downloadKbps: 2000,
        uploadKbps: 1000,
      },
    });
    expect(badPkg.status).toBe(400);
  });

  it('generates unique voucher batches and enforces strict single-use + one device name per voucher', async () => {
    const pkgRes = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: '24H Fast Fiber',
        description: 'Unlimited 24-hour hotspot access',
        category: 'DAILY',
        priceTzs: 2000,
        durationMinutes: 1440,
        downloadKbps: 10000,
        uploadKbps: 5000,
      },
    });
    expect(pkgRes.status).toBe(201);
    const packageId = String((pkgRes.json.package as Record<string, unknown>).id);

    const batchRes = await api(srv.baseUrl, '/api/vouchers/generate', {
      method: 'POST',
      token: adminToken,
      body: { packageId, count: 25 },
    });
    expect(batchRes.status).toBe(201);
    const vouchers = batchRes.json.vouchers as Array<{ id: string; code: string }>;
    expect(vouchers).toHaveLength(25);
    const uniqueCodes = new Set(vouchers.map((v) => v.code));
    expect(uniqueCodes.size).toBe(25);

    const voucherCode = vouchers[0].code;

    // Missing Device Name -> REJECTED 400
    const missingName = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: voucherCode,
        deviceFingerprint: 'device-fp-alpha-11111111',
      },
    });
    expect(missingName.status).toBe(400);
    expect(missingName.json.code).toBe('DEVICE_NAME_REQUIRED');

    // Device 1 redeems voucher -> succeeds once
    const d1 = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: voucherCode,
        deviceFingerprint: 'device-fp-alpha-11111111',
        deviceLabel: 'Pixel 8',
      },
    });
    expect(d1.status).toBe(200);
    const d1Session = d1.json.session as Record<string, unknown>;
    expect(d1Session.reconnected).toBe(false);
    expect(d1Session.deviceLabel).toBe('Pixel 8');

    // Validation now reports single-use already consumed & bound to Pixel 8
    const valAfter = await api(srv.baseUrl, '/api/portal/validate', {
      method: 'POST',
      body: { code: voucherCode },
    });
    expect(valAfter.status).toBe(200);
    const vInfo = valAfter.json.validation as Record<string, unknown>;
    expect(vInfo.valid).toBe(false);
    expect(vInfo.status).toBe('ACTIVE');
    expect(vInfo.boundDeviceName).toBe('Pixel 8');

    // Active session token restore continues to work cleanly without re-redeeming code
    const activeCheck = await api(srv.baseUrl, '/api/portal/session', {
      headers: { 'X-Portal-Session': String(d1Session.sessionToken) },
    });
    expect(activeCheck.status).toBe(200);
    expect((activeCheck.json.session as Record<string, unknown>).deviceLabel).toBe('Pixel 8');

    // Device 2 tries to redeem SAME voucher -> REJECTED 409
    const d2 = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: voucherCode,
        deviceFingerprint: 'device-fp-beta-22222222',
        deviceLabel: 'iPhone 15',
      },
    });
    expect(d2.status).toBe(409);
    expect(d2.json.code).toBe('DEVICE_LIMIT_REACHED');

    // Same device trying a DIFFERENT device name -> REJECTED 409
    const diffNameAttempt = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: voucherCode,
        deviceFingerprint: 'device-fp-alpha-11111111',
        deviceLabel: 'Pixel 8 Pro',
      },
    });
    expect(diffNameAttempt.status).toBe(409);
    expect(diffNameAttempt.json.code).toBe('DEVICE_LIMIT_REACHED');

    // Same device & same device name trying to redeem code a SECOND time -> REJECTED 409 (single-use)
    const secondRedeemSameDevice = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: voucherCode,
        deviceFingerprint: 'device-fp-alpha-11111111',
        deviceLabel: 'Pixel 8',
      },
    });
    expect(secondRedeemSameDevice.status).toBe(409);
    expect(secondRedeemSameDevice.json.code).toBe('VOUCHER_ALREADY_USED');

    // Device 1 logs out -> code is permanently consumed and cannot be redeemed again
    const logoutRes = await api(srv.baseUrl, '/api/portal/logout', {
      method: 'POST',
      headers: { 'X-Portal-Session': String(d1Session.sessionToken) },
    });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: voucherCode,
        deviceFingerprint: 'device-fp-alpha-11111111',
        deviceLabel: 'Pixel 8',
      },
    });
    expect(afterLogout.status).toBe(403);
    expect(afterLogout.json.code).toBe('VOUCHER_EXPIRED');
  });

  it('rejects expired and revoked vouchers and handles session expiration sweeps', async () => {
    const pkgRes = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: '1H Quick Pass',
        category: 'HOURLY',
        priceTzs: 500,
        durationMinutes: 60,
        downloadKbps: 4000,
        uploadKbps: 2000,
      },
    });
    const packageId = String((pkgRes.json.package as Record<string, unknown>).id);

    const genRes = await api(srv.baseUrl, '/api/vouchers/generate', {
      method: 'POST',
      token: adminToken,
      body: { packageId, count: 2 },
    });
    const [v1, v2] = genRes.json.vouchers as Array<{ id: string; code: string }>;

    // Revoke v1
    const revRes = await api(srv.baseUrl, `/api/vouchers/${v1.id}/revoke`, {
      method: 'POST',
      token: adminToken,
      body: { reason: 'Issued in error' },
    });
    expect(revRes.status).toBe(200);

    const redeemRevoked = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: { code: v1.code, deviceFingerprint: 'device-fp-test-999999', deviceLabel: 'Pixel 7' },
    });
    expect(redeemRevoked.status).toBe(403);
    expect(redeemRevoked.json.code).toBe('VOUCHER_REVOKED');

    // Redeem v2 then backdate expiry to test expiration sweep
    const redeemV2 = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: { code: v2.code, deviceFingerprint: 'device-fp-test-888888', deviceLabel: 'Tecno Spark' },
    });
    expect(redeemV2.status).toBe(200);

    const pastIso = new Date(Date.now() - 60_000).toISOString();
    db.prepare('UPDATE sessions SET expires_at = ? WHERE voucher_id = ?').run(pastIso, v2.id);
    db.prepare('UPDATE vouchers SET expires_at = ? WHERE id = ?').run(pastIso, v2.id);

    const sweep = await api(srv.baseUrl, '/api/sessions/expire-sweep', {
      method: 'POST',
      token: adminToken,
    });
    expect(sweep.status).toBe(200);
    expect(sweep.json.expiredSessions).toBe(1);

    const redeemExpired = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: { code: v2.code, deviceFingerprint: 'device-fp-test-888888', deviceLabel: 'Tecno Spark' },
    });
    expect(redeemExpired.status).toBe(403);
    expect(redeemExpired.json.code).toBe('VOUCHER_EXPIRED');
  });

  it('verifies mobile money HMAC webhooks, blocks duplicates, and issues voucher only after server verification', async () => {
    const pkgRes = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Weekly Pro',
        category: 'WEEKLY',
        priceTzs: 10000,
        durationMinutes: 10080,
        downloadKbps: 15000,
        uploadKbps: 8000,
      },
    });
    const packageId = String((pkgRes.json.package as Record<string, unknown>).id);

    const initRes = await api(srv.baseUrl, '/api/portal/payments/initiate', {
      method: 'POST',
      body: {
        packageId,
        provider: 'MPESA',
        phoneNumber: '0754123456',
      },
    });
    expect(initRes.status).toBe(201);
    const payment = initRes.json.payment as Record<string, unknown>;
    const reference = String(payment.reference);
    expect(payment.status).toBe('PENDING');

    // Unsigned webhook rejected
    const badWebhook = await api(srv.baseUrl, '/api/payments/webhook/MPESA', {
      method: 'POST',
      body: {
        externalEventId: 'evt-100',
        reference,
        externalTxId: 'MPESA-TX-100',
        status: 'COMPLETED',
        amountTzs: 10000,
      },
    });
    expect(badWebhook.status).toBe(401);

    // Valid HMAC signed webhook creates voucher & receipt
    const payloadObj = {
      externalEventId: 'evt-100',
      reference,
      externalTxId: 'MPESA-TX-100',
      status: 'COMPLETED',
      amountTzs: 10000,
    };
    const rawPayload = JSON.stringify(payloadObj);
    const signature = crypto
      .createHmac('sha256', process.env.MPESA_WEBHOOK_SECRET!)
      .update(rawPayload)
      .digest('hex');

    const goodWebhook = await fetch(`${srv.baseUrl}/api/payments/webhook/MPESA`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
      },
      body: rawPayload,
    });
    expect(goodWebhook.status).toBe(200);
    const goodJson = (await goodWebhook.json()) as { outcome: { duplicate: boolean; issuedVoucherCode: string; receiptNumber: string } };
    expect(goodJson.outcome.duplicate).toBe(false);
    expect(goodJson.outcome.issuedVoucherCode).toMatch(/^NTC-/);
    expect(goodJson.outcome.receiptNumber).toMatch(/^RCP-/);

    // Duplicate callback is idempotent and does not issue a second voucher
    const dupWebhook = await fetch(`${srv.baseUrl}/api/payments/webhook/MPESA`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Webhook-Signature': `sha256=${signature}`,
      },
      body: rawPayload,
    });
    expect(dupWebhook.status).toBe(200);
    const dupJson = (await dupWebhook.json()) as { outcome: { duplicate: boolean } };
    expect(dupJson.outcome.duplicate).toBe(true);

    // Payment lookup reveals issued voucher
    const statusLookup = await api(srv.baseUrl, `/api/portal/payments/${reference}`);
    expect(statusLookup.status).toBe(200);
    expect((statusLookup.json.payment as Record<string, unknown>).voucherCode).toBe(goodJson.outcome.issuedVoucherCode);
  });

  it('supports forgot-password alerts, one-time recovery codes, and session revocation on reset', async () => {
    const createRes = await api(srv.baseUrl, '/api/staff', {
      method: 'POST',
      token: adminToken,
      body: {
        email: 'operator@netco.co.tz',
        fullName: 'Field Operator',
        password: 'OldPassword#2026',
        role: 'NETWORK_OPERATOR',
        department: 'NOC',
      },
    });
    expect(createRes.status).toBe(201);
    const staffId = String((createRes.json.staff as Record<string, unknown>).id);

    const loginBefore = await api(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'operator@netco.co.tz', password: 'OldPassword#2026' },
    });
    expect(loginBefore.status).toBe(200);
    const oldToken = String(loginBefore.json.token);

    // Unauthenticated forgot-password request never leaks recovery code
    const forgotRes = await api(srv.baseUrl, '/api/auth/forgot-password', {
      method: 'POST',
      body: { email: 'operator@netco.co.tz' },
    });
    expect(forgotRes.status).toBe(200);
    expect(forgotRes.json.code).toBeUndefined();

    // Admin issues a one-time recovery code
    const recRes = await api(srv.baseUrl, `/api/staff/${staffId}/recovery-code`, {
      method: 'POST',
      token: adminToken,
    });
    expect(recRes.status).toBe(200);
    const code = String(recRes.json.code);

    // Wrong code is rejected
    const badReset = await api(srv.baseUrl, '/api/auth/reset-password', {
      method: 'POST',
      body: { email: 'operator@netco.co.tz', code: 'WRONG-CODE', newPassword: 'NewPassword#2026' },
    });
    expect(badReset.status).toBe(400);

    // Valid code updates password and revokes existing session
    const goodReset = await api(srv.baseUrl, '/api/auth/reset-password', {
      method: 'POST',
      body: { email: 'operator@netco.co.tz', code, newPassword: 'NewPassword#2026' },
    });
    expect(goodReset.status).toBe(200);

    const meOld = await api(srv.baseUrl, '/api/auth/me', { token: oldToken });
    expect(meOld.status).toBe(401);

    // Reusing the same one-time code fails
    const reuseReset = await api(srv.baseUrl, '/api/auth/reset-password', {
      method: 'POST',
      body: { email: 'operator@netco.co.tz', code, newPassword: 'AnotherPass#2026' },
    });
    expect(reuseReset.status).toBe(400);

    // Login with new password succeeds
    const loginAfter = await api(srv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { email: 'operator@netco.co.tz', password: 'NewPassword#2026' },
    });
    expect(loginAfter.status).toBe(200);
  });

  it('defaults to STANDALONE_MODE, allows optional router configs without hotspot1, and rejects 8.8.8.8', async () => {
    const modeRes = await api(srv.baseUrl, '/api/system/mode');
    expect(modeRes.status).toBe(200);
    expect(modeRes.json.operatingMode).toBe('STANDALONE_MODE');
    expect(modeRes.json.routerStatusMessage).toBe('No MikroTik router connected');

    // Switch mode and back
    const switchRes = await api(srv.baseUrl, '/api/system/mode', {
      method: 'PATCH',
      token: adminToken,
      body: { operatingMode: 'MIKROTIK_MODE' },
    });
    expect(switchRes.status).toBe(200);
    expect(switchRes.json.operatingMode).toBe('MIKROTIK_MODE');

    await api(srv.baseUrl, '/api/system/mode', {
      method: 'PATCH',
      token: adminToken,
      body: { operatingMode: 'STANDALONE_MODE' },
    });

    // Reject 8.8.8.8
    const badIp = await api(srv.baseUrl, '/api/routers', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Bad DNS Router', host: '8.8.8.8' },
    });
    expect(badIp.status).toBe(400);

    // Optional fields without host/username/password or invented hotspot1 default
    const optRouter = await api(srv.baseUrl, '/api/routers', {
      method: 'POST',
      token: adminToken,
      body: { name: 'Future MikroTik Node' },
    });
    expect(optRouter.status).toBe(201);
    const created = optRouter.json.router as Record<string, unknown>;
    expect(created.host).toBe('');
    expect(created.hotspotServer).toBe('');
    expect(created.status).toBe('NOT_CONNECTED');

    // Testing unconfigured router returns NOT_CONNECTED cleanly without crashing
    const testOpt = await api(srv.baseUrl, `/api/routers/${created.id}/test`, {
      method: 'POST',
      token: adminToken,
    });
    expect(testOpt.status).toBe(200);
    expect((testOpt.json.telemetry as Record<string, unknown>).connected).toBe(false);
  });

  it('issues trackable Voucher Tokens on standalone customer payment, validates tokens, enforces 1 device, and excludes test revenue', async () => {
    const pkgRes = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Pocket WiFi Daily',
        category: 'DAILY',
        priceTzs: 1500,
        durationMinutes: 1440,
        downloadKbps: 6000,
        uploadKbps: 3000,
      },
    });
    expect(pkgRes.status).toBe(201);
    const packageId = String((pkgRes.json.package as Record<string, unknown>).id);

    // Clear provider creds for HALOPESA to ensure STANDALONE_TEST flow
    delete process.env.HALOPESA_MERCHANT_CODE;
    delete process.env.HALOPESA_API_SECRET;
    delete process.env.HALOPESA_WEBHOOK_SECRET;

    const initRes = await api(srv.baseUrl, '/api/portal/payments/initiate', {
      method: 'POST',
      body: {
        packageId,
        provider: 'HALOPESA',
        phoneNumber: '0622123456',
      },
    });
    expect(initRes.status).toBe(201);
    const pending = initRes.json.payment as Record<string, unknown>;
    expect(pending.providerConfigured).toBe(false);
    expect(pending.isTest).toBe(true);

    // Confirm standalone checkout to issue Voucher Token
    const confirmRes = await api(
      srv.baseUrl,
      `/api/portal/payments/${pending.reference}/confirm-test`,
      { method: 'POST' }
    );
    expect(confirmRes.status).toBe(200);
    const confirmed = confirmRes.json.payment as Record<string, unknown>;
    expect(confirmed.status).toBe('COMPLETED');
    expect(confirmed.isTest).toBe(true);
    expect(String(confirmed.receiptNumber)).toMatch(/^TST-/);
    const issuedToken = String(confirmed.voucherCode);
    expect(issuedToken).toMatch(/^NTC-/);

    // Dashboard & reports real verified revenue MUST exclude standalone/test checkout tokens
    const dashRes = await api(srv.baseUrl, '/api/dashboard/summary', { token: adminToken });
    expect(dashRes.status).toBe(200);
    const dashStats = dashRes.json.stats as Record<string, unknown>;
    expect(dashStats.monthlyRevenueTzs).toBe(0);
    expect(dashStats.testPaymentsCount).toBe(1);

    const repRes = await api(srv.baseUrl, '/api/reports/overview', { token: adminToken });
    expect(repRes.status).toBe(200);
    expect((repRes.json.revenueByProvider as unknown[]).length).toBe(0);
    expect((repRes.json.testSummary as Record<string, unknown>).testTokensIssued).toBe(1);

    // Customer validates the issued Voucher Token
    const valRes = await api(srv.baseUrl, '/api/portal/validate', {
      method: 'POST',
      body: { code: issuedToken },
    });
    expect(valRes.status).toBe(200);
    const validation = valRes.json.validation as Record<string, unknown>;
    expect(validation.valid).toBe(true);
    expect(validation.status).toBe('UNUSED');
    expect(validation.isTest).toBe(true);
    expect(validation.packageName).toBe('Pocket WiFi Daily');

    // Customer redeems the Voucher Token on Device A -> succeeds; Device B -> rejected 409
    const redeemA = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: issuedToken,
        deviceFingerprint: 'airtel-pocket-device-A-111111',
        deviceLabel: 'Galaxy A54',
      },
    });
    expect(redeemA.status).toBe(200);

    const redeemB = await api(srv.baseUrl, '/api/portal/redeem', {
      method: 'POST',
      body: {
        code: issuedToken,
        deviceFingerprint: 'airtel-pocket-device-B-222222',
        deviceLabel: 'Laptop',
      },
    });
    expect(redeemB.status).toBe(409);
    expect(redeemB.json.code).toBe('DEVICE_LIMIT_REACHED');

    // Admin issues dev test voucher batch
    const devTestGen = await api(srv.baseUrl, '/api/vouchers/generate', {
      method: 'POST',
      token: adminToken,
      body: {
        packageId,
        count: 2,
        isTest: true,
        testNote: 'QA Pocket WiFi check',
      },
    });
    expect(devTestGen.status).toBe(201);
    const devVouchers = devTestGen.json.vouchers as Array<{ isTest: boolean }>;
    expect(devVouchers).toHaveLength(2);
    expect(devVouchers[0].isTest).toBe(true);
  });
});
