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

  it('registers independent business workspaces and strictly isolates cross-tenant access', async () => {
    const bizA = await api(srv.baseUrl, '/api/auth/register-business', {
      method: 'POST',
      body: {
        businessName: 'Kilimanjaro Fiber Ltd',
        ownerName: 'Amina Hassan',
        ownerEmail: 'amina@kilifiber.co.tz',
        password: 'KiliPassword#2026',
        phone: '+255754111222',
        country: 'Tanzania',
        region: 'Arusha',
        planCode: 'STARTER',
      },
    });
    expect(bizA.status).toBe(201);
    const tokenA = String(bizA.json.token);
    const idA = String((bizA.json.business as Record<string, unknown>).id);

    const bizB = await api(srv.baseUrl, '/api/auth/register-business', {
      method: 'POST',
      body: {
        businessName: 'Zanzibar Link Co',
        ownerName: 'Juma Ali',
        ownerEmail: 'juma@znzlink.co.tz',
        password: 'ZnzPassword#2026',
        phone: '+255777333444',
        country: 'Tanzania',
        region: 'Zanzibar',
        planCode: 'STARTER',
      },
    });
    expect(bizB.status).toBe(201);
    const tokenB = String(bizB.json.token);
    const idB = String((bizB.json.business as Record<string, unknown>).id);
    expect(idA).not.toBe(idB);

    // Business A creates a package and location
    const pkgA = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: tokenA,
      body: {
        name: 'Arusha Daily 5Mbps',
        category: 'DAILY',
        packageType: 'TIME_BASED',
        priceTzs: 2500,
        durationMinutes: 1440,
        downloadKbps: 5000,
        uploadKbps: 2500,
      },
    });
    expect(pkgA.status).toBe(201);
    const pkgAId = String((pkgA.json.package as Record<string, unknown>).id);

    // Business B cannot see Business A's package in its list
    const listB = await api(srv.baseUrl, '/api/packages', { token: tokenB });
    expect(listB.status).toBe(200);
    expect((listB.json.packages as Array<Record<string, unknown>>).some((p) => p.id === pkgAId)).toBe(false);

    // Business B cannot patch or delete Business A's package
    const patchCross = await api(srv.baseUrl, `/api/packages/${pkgAId}`, {
      method: 'PATCH',
      token: tokenB,
      body: { priceTzs: 100 },
    });
    expect(patchCross.status).toBe(403);

    // Business B attempting to spoof x-tenant-id header for Business A is blocked 403 and audited
    const spoofRes = await api(srv.baseUrl, '/api/packages', {
      token: tokenB,
      headers: { 'x-tenant-id': idA },
    });
    expect(spoofRes.status).toBe(403);

    const blockedAudit = db
      .prepare("SELECT COUNT(*) as c FROM audit_logs WHERE action = 'CROSS_TENANT_ACCESS_BLOCKED'")
      .get() as { c: number };
    expect(blockedAudit.c).toBeGreaterThanOrEqual(1);
  });

  it('provisions RADIUS subscriptions on verified payment, enforces expiry, and queues offline router retries', async () => {
    process.env.RADIUS_SHARED_SECRET = 'radius_test_secret_2026';

    // Switch to MIKROTIK_MODE and register an unreachable router so retry queue runs cleanly without crashing payment
    await api(srv.baseUrl, '/api/system/mode', {
      method: 'PATCH',
      token: adminToken,
      body: { operatingMode: 'MIKROTIK_MODE' },
    });
    const rtr = await api(srv.baseUrl, '/api/routers', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'Offline Edge RB750',
        host: '198.51.100.42',
        apiPort: 8728,
        username: 'apiuser',
        password: 'apipassword',
        routerOsFamily: 'ROUTEROS_V7',
      },
    });
    expect(rtr.status).toBe(201);

    const pkgRes = await api(srv.baseUrl, '/api/packages', {
      method: 'POST',
      token: adminToken,
      body: {
        name: 'RADIUS Gold Daily',
        category: 'DAILY',
        packageType: 'HYBRID',
        priceTzs: 3000,
        durationMinutes: 1440,
        downloadKbps: 12000,
        uploadKbps: 6000,
        dataLimitMb: 5120,
      },
    });
    expect(pkgRes.status).toBe(201);
    const packageId = String((pkgRes.json.package as Record<string, unknown>).id);

    // Initiate M-Pesa payment
    const initRes = await api(srv.baseUrl, '/api/portal/payments/initiate', {
      method: 'POST',
      body: {
        packageId,
        provider: 'MPESA',
        phoneNumber: '0754987654',
      },
    });
    expect(initRes.status).toBe(201);
    const reference = String((initRes.json.payment as Record<string, unknown>).reference);

    // Failed webhook must NOT provision active subscription
    const failPayload = JSON.stringify({
      externalEventId: 'evt-fail-1',
      reference,
      externalTxId: 'MPESA-FAIL-1',
      status: 'FAILED',
      amountTzs: 3000,
    });
    const failSig = crypto.createHmac('sha256', process.env.MPESA_WEBHOOK_SECRET!).update(failPayload).digest('hex');
    const failHook = await fetch(`${srv.baseUrl}/api/payments/webhook/MPESA`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': `sha256=${failSig}` },
      body: failPayload,
    });
    expect(failHook.status).toBe(200);
    expect((db.prepare('SELECT COUNT(*) as c FROM subscriptions').get() as { c: number }).c).toBe(0);

    // Create a fresh payment and confirm via valid COMPLETED webhook -> creates subscription + offline router retry job
    const init2 = await api(srv.baseUrl, '/api/portal/payments/initiate', {
      method: 'POST',
      body: {
        packageId,
        provider: 'MPESA',
        phoneNumber: '0754987654',
      },
    });
    const ref2 = String((init2.json.payment as Record<string, unknown>).reference);
    const okPayload = JSON.stringify({
      externalEventId: 'evt-ok-2',
      reference: ref2,
      externalTxId: 'MPESA-OK-2',
      status: 'COMPLETED',
      amountTzs: 3000,
    });
    const okSig = crypto.createHmac('sha256', process.env.MPESA_WEBHOOK_SECRET!).update(okPayload).digest('hex');
    const okHook = await fetch(`${srv.baseUrl}/api/payments/webhook/MPESA`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': `sha256=${okSig}` },
      body: okPayload,
    });
    expect(okHook.status).toBe(200);
    const okJson = (await okHook.json()) as { outcome: { issuedVoucherCode: string } };
    const voucherCode = okJson.outcome.issuedVoucherCode;

    // Subscriptions & offline router retry queue recorded
    const subsRes = await api(srv.baseUrl, '/api/subscriptions', { token: adminToken });
    expect(subsRes.status).toBe(200);
    const subs = subsRes.json.subscriptions as Array<{ id: string; radiusUsername: string; status: string }>;
    const jobs = subsRes.json.provisioningJobs as Array<{ id: string; status: string }>;
    expect(subs.length).toBeGreaterThanOrEqual(1);
    expect(subs[0].status).toBe('ACTIVE');
    expect(jobs.some((j) => j.status === 'FAILED_RETRYING')).toBe(true);

    // FreeRADIUS authorize endpoint returns Access-Accept when valid secret supplied
    const radOk = await api(srv.baseUrl, '/api/radius/authorize', {
      method: 'POST',
      headers: { 'x-radius-secret': process.env.RADIUS_SHARED_SECRET },
      body: { username: voucherCode },
    });
    expect(radOk.status).toBe(200);
    expect(radOk.json.access).toBe('Access-Accept');

    // Suspend subscription -> RADIUS authorize now returns 401 Access-Reject
    const suspendRes = await api(srv.baseUrl, `/api/subscriptions/${subs[0].id}/suspend`, {
      method: 'POST',
      token: adminToken,
    });
    expect(suspendRes.status).toBe(200);

    const radSuspended = await api(srv.baseUrl, '/api/radius/authorize', {
      method: 'POST',
      headers: { 'x-radius-secret': process.env.RADIUS_SHARED_SECRET },
      body: { username: voucherCode },
    });
    expect(radSuspended.status).toBe(401);
    expect(radSuspended.json.access).toBe('Access-Reject');
  });

  it('separates SaaS platform billing ledger from tenant WiFi payments and supports Super Admin governance', async () => {
    const biz = await api(srv.baseUrl, '/api/auth/register-business', {
      method: 'POST',
      body: {
        businessName: 'Mwanza Hotspot Co',
        ownerName: 'Neema Peter',
        ownerEmail: 'neema@mwanzahotspot.co.tz',
        password: 'MwanzaPassword#2026',
        phone: '+255765444555',
        country: 'Tanzania',
        region: 'Mwanza',
        planCode: 'STARTER',
      },
    });
    expect(biz.status).toBe(201);
    const ownerToken = String(biz.json.token);
    const bizId = String((biz.json.business as Record<string, unknown>).id);

    // Super Admin creates a custom SaaS plan
    const newPlan = await api(srv.baseUrl, '/api/superadmin/plans', {
      method: 'POST',
      token: adminToken,
      body: {
        code: 'ISP_GOLD',
        name: 'ISP Gold Tier',
        priceMonthlyTzs: 95000,
        priceYearlyTzs: 950000,
        maxRouters: 15,
        maxLocations: 8,
        maxActiveCustomers: 1500,
        commissionBps: 150,
      },
    });
    expect(newPlan.status).toBe(201);

    // Business Owner upgrades SaaS subscription via Card checkout
    const upgrade = await api(srv.baseUrl, '/api/business/subscription/checkout', {
      method: 'POST',
      token: ownerToken,
      body: {
        planCode: 'ISP_GOLD',
        billingCycle: 'MONTHLY',
        provider: 'CARD',
      },
    });
    expect(upgrade.status).toBe(201);
    expect(upgrade.json.amountTzs).toBe(95000);

    // Super Admin sees SaaS revenue in /api/superadmin/overview while WiFi revenue stays separate
    const overview = await api(srv.baseUrl, '/api/superadmin/overview', { token: adminToken });
    expect(overview.status).toBe(200);
    const stats = overview.json.stats as Record<string, unknown>;
    expect(stats.saasRevenueTzs).toBe(95000);
    expect(stats.totalWifiRevenueTzs).toBe(0);

    // Super Admin can suspend business and re-activate it
    const susp = await api(srv.baseUrl, `/api/superadmin/businesses/${bizId}/status`, {
      method: 'PATCH',
      token: adminToken,
      body: { status: 'SUSPENDED' },
    });
    expect(susp.status).toBe(200);
    expect(susp.json.status).toBe('SUSPENDED');
  });
});

