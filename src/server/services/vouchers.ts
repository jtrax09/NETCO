import type { NetcoDb } from '../db.ts';
import { expireStaleRecords, withTransaction } from '../db.ts';
import {
  decryptSecret,
  encryptSecret,
  generateId,
  generateReference,
  generateSessionToken,
  generateVoucherCode,
  maskVoucherCode,
  normalizeVoucherCode,
  sha256,
} from '../utils/crypto.ts';

export class VoucherError extends Error {
  statusCode: number;
  code: string;

  constructor(message: string, statusCode = 400, code = 'VOUCHER_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function createVoucherBatch(
  db: NetcoDb,
  params: {
    packageId: string;
    count: number;
    customerId?: string | null;
    createdById?: string | null;
    businessId?: string | null;
    isTest?: boolean;
    testNote?: string | null;
  }
) {
  if (params.count < 1 || params.count > 500) {
    throw new VoucherError('Batch count must be between 1 and 500', 400, 'INVALID_COUNT');
  }

  const pkg = db
    .prepare('SELECT id, business_id, name, is_active FROM packages WHERE id = ?')
    .get(params.packageId) as { id: string; business_id: string; name: string; is_active: number } | undefined;

  if (!pkg) {
    throw new VoucherError('Assigned package not found', 404, 'PACKAGE_NOT_FOUND');
  }
  if (params.businessId && pkg.business_id !== params.businessId) {
    throw new VoucherError('Package belongs to a different business workspace', 403, 'CROSS_TENANT_FORBIDDEN');
  }

  const tenantBusinessId = pkg.business_id;

  if (params.customerId) {
    const cust = db
      .prepare('SELECT id, business_id FROM customers WHERE id = ?')
      .get(params.customerId) as { id: string; business_id: string } | undefined;
    if (!cust) {
      throw new VoucherError('Assigned customer not found', 404, 'CUSTOMER_NOT_FOUND');
    }
    if (cust.business_id !== tenantBusinessId) {
      throw new VoucherError('Customer belongs to a different business workspace', 403, 'CROSS_TENANT_FORBIDDEN');
    }
  }

  const isTest = Boolean(params.isTest);
  const testNote = isTest ? params.testNote?.trim() || 'Admin-issued development test voucher' : null;
  const batchId = params.count > 1 ? generateReference(isTest ? 'TEST' : 'BATCH') : isTest ? generateReference('TEST') : null;
  const nowIso = new Date().toISOString();

  return withTransaction(db, () => {
    const insertStmt = db.prepare(`
      INSERT INTO vouchers (
        id, business_id, code_hash, code_encrypted, code_masked, batch_id,
        package_id, customer_id, status, is_test, test_note, created_by_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'UNUSED', ?, ?, ?, ?, ?)
    `);

    const created: Array<{
      id: string;
      businessId: string;
      code: string;
      codeMasked: string;
      batchId: string | null;
      packageId: string;
      packageName: string;
      status: string;
      isTest: boolean;
      createdAt: string;
    }> = [];

    for (let i = 0; i < params.count; i++) {
      let code = generateVoucherCode();
      let codeHash = sha256(code);
      while (db.prepare('SELECT 1 FROM vouchers WHERE code_hash = ?').get(codeHash)) {
        code = generateVoucherCode();
        codeHash = sha256(code);
      }

      const id = generateId('vch');
      const masked = maskVoucherCode(code);
      insertStmt.run(
        id,
        tenantBusinessId,
        codeHash,
        encryptSecret(code),
        masked,
        batchId,
        pkg.id,
        params.customerId ?? null,
        isTest ? 1 : 0,
        testNote,
        params.createdById ?? null,
        nowIso,
        nowIso
      );

      created.push({
        id,
        businessId: tenantBusinessId,
        code,
        codeMasked: masked,
        batchId,
        packageId: pkg.id,
        packageName: pkg.name,
        status: 'UNUSED',
        isTest,
        createdAt: nowIso,
      });
    }

    return { batchId, vouchers: created };
  });
}

export function validateVoucherCode(db: NetcoDb, code: string) {
  expireStaleRecords(db);
  const normalizedCode = normalizeVoucherCode(code);
  if (normalizedCode.length < 6) {
    throw new VoucherError('Enter a valid voucher code.', 400, 'INVALID_CODE');
  }

  const codeHash = sha256(normalizedCode);
  const row = db
    .prepare(`
      SELECT v.id, v.business_id, v.code_masked, v.status, v.bound_device_id, v.bound_device_name,
             v.is_test, v.test_note, v.created_at, v.activated_at, v.expires_at,
             v.revoked_at, v.revoked_reason,
             p.name as package_name, p.category, p.price_tzs, p.duration_minutes,
             p.download_kbps, p.upload_kbps, p.data_limit_mb,
             b.name as business_name
      FROM vouchers v
      JOIN packages p ON p.id = v.package_id
      LEFT JOIN businesses b ON b.id = v.business_id
      WHERE v.code_hash = ?
    `)
    .get(codeHash) as Record<string, unknown> | undefined;

  if (!row) {
    throw new VoucherError('Voucher code not recognized.', 404, 'VOUCHER_NOT_FOUND');
  }

  const status = String(row.status);
  const valid = status === 'UNUSED';

  return {
    valid,
    status,
    businessId: String(row.business_id),
    businessName: row.business_name ? String(row.business_name) : 'TRAX LINK Hotspot',
    codeMasked: String(row.code_masked),
    packageName: String(row.package_name),
    category: String(row.category),
    priceTzs: Number(row.price_tzs),
    durationMinutes: Number(row.duration_minutes),
    downloadKbps: Number(row.download_kbps),
    uploadKbps: Number(row.upload_kbps),
    dataLimitMb: row.data_limit_mb !== null ? Number(row.data_limit_mb) : null,
    isBoundToDevice: Boolean(row.bound_device_id),
    boundDeviceName: row.bound_device_name ? String(row.bound_device_name) : null,
    isTest: Boolean(row.is_test),
    testNote: row.test_note ? String(row.test_note) : null,
    createdAt: String(row.created_at),
    activatedAt: row.activated_at ? String(row.activated_at) : null,
    expiresAt: row.expires_at ? String(row.expires_at) : null,
    revokedReason: row.revoked_reason ? String(row.revoked_reason) : null,
  };
}

export function redeemVoucherForDevice(
  db: NetcoDb,
  params: {
    code: string;
    deviceFingerprint: string;
    macAddress?: string | null;
    userAgent?: string | null;
    deviceLabel?: string | null;
    ipAddress?: string | null;
    routerId?: string | null;
  }
) {
  expireStaleRecords(db);

  const normalizedCode = normalizeVoucherCode(params.code);
  if (normalizedCode.length < 6) {
    throw new VoucherError('Enter a valid voucher code.', 400, 'INVALID_CODE');
  }
  const fp = params.deviceFingerprint.trim();
  if (fp.length < 8 || fp.length > 256) {
    throw new VoucherError('Valid device identifier is required for one-device enforcement.', 400, 'INVALID_DEVICE');
  }
  const cleanDeviceName = (params.deviceLabel ?? '').trim();
  if (cleanDeviceName.length < 2 || cleanDeviceName.length > 120) {
    throw new VoucherError(
      'Device name is required (at least 2 characters). Each voucher code can only be used once on one device name.',
      400,
      'DEVICE_NAME_REQUIRED'
    );
  }

  const codeHash = sha256(normalizedCode);
  const now = new Date();
  const nowIso = now.toISOString();

  return withTransaction(db, () => {
    const voucher = db
      .prepare(`
        SELECT v.*, p.name as package_name, p.duration_minutes, p.download_kbps, p.upload_kbps, p.data_limit_mb, p.category,
               b.name as business_name
        FROM vouchers v
        JOIN packages p ON p.id = v.package_id
        LEFT JOIN businesses b ON b.id = v.business_id
        WHERE v.code_hash = ?
      `)
      .get(codeHash) as Record<string, unknown> | undefined;

    if (!voucher) {
      throw new VoucherError('Voucher code not recognized.', 404, 'VOUCHER_NOT_FOUND');
    }

    const businessId = String(voucher.business_id);

    let device = db
      .prepare('SELECT * FROM devices WHERE device_fingerprint = ?')
      .get(fp) as Record<string, unknown> | undefined;

    if (!device) {
      const deviceId = generateId('dev');
      db.prepare(`
        INSERT INTO devices (id, business_id, device_fingerprint, mac_address, user_agent, device_label, customer_id, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        deviceId,
        businessId,
        fp,
        params.macAddress ?? null,
        params.userAgent ?? null,
        cleanDeviceName,
        voucher.customer_id ? String(voucher.customer_id) : null,
        nowIso,
        nowIso
      );
      device = db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as Record<string, unknown>;
    } else {
      db.prepare(`
        UPDATE devices
        SET last_seen_at = ?,
            mac_address = COALESCE(?, mac_address),
            user_agent = COALESCE(?, user_agent),
            device_label = COALESCE(device_label, ?)
        WHERE id = ?
      `).run(
        nowIso,
        params.macAddress ?? null,
        params.userAgent ?? null,
        cleanDeviceName,
        String(device.id)
      );
    }

    const deviceId = String(device.id);
    const voucherId = String(voucher.id);
    const voucherStatus = String(voucher.status);

    const logRedemption = (success: boolean, reason: string) => {
      db.prepare(`
        INSERT INTO voucher_redemptions (id, voucher_id, device_id, ip_address, success, reason, redeemed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(generateId('red'), voucherId, deviceId, params.ipAddress ?? null, success ? 1 : 0, reason, nowIso);
    };

    if (voucherStatus === 'REVOKED') {
      logRedemption(false, 'Voucher revoked');
      throw new VoucherError('This voucher has been revoked by an administrator.', 403, 'VOUCHER_REVOKED');
    }

    if (voucherStatus === 'EXPIRED' || (voucher.expires_at && String(voucher.expires_at) <= nowIso)) {
      if (voucherStatus !== 'EXPIRED') {
        db.prepare("UPDATE vouchers SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(nowIso, voucherId);
      }
      logRedemption(false, 'Voucher expired / single-use already consumed');
      throw new VoucherError('This voucher has expired and can no longer be used.', 403, 'VOUCHER_EXPIRED');
    }

    if (voucherStatus !== 'UNUSED' || voucher.activated_at !== null) {
      const boundName = voucher.bound_device_name
        ? String(voucher.bound_device_name)
        : device.device_label
        ? String(device.device_label)
        : 'authorized device';
      const isDifferentDeviceOrName =
        (voucher.bound_device_id && String(voucher.bound_device_id) !== deviceId) ||
        (voucher.bound_device_name &&
          String(voucher.bound_device_name).trim().toLowerCase() !== cleanDeviceName.toLowerCase());

      logRedemption(
        false,
        `Rejected (${cleanDeviceName}): single-use voucher already used once and locked to "${boundName}"`
      );

      if (isDifferentDeviceOrName) {
        db.prepare(`
          INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
          VALUES (?, ?, 'SUSPICIOUS_ACTIVITY', 'WARNING', ?, ?, ?)
        `).run(
          generateId('ntf'),
          businessId,
          `Multi-Device / Reuse Attempt Blocked (${voucher.code_masked})`,
          `Device "${cleanDeviceName}" (${params.ipAddress || fp.slice(0, 10)}) tried to reuse a single-use voucher locked to "${boundName}".`,
          JSON.stringify({
            voucherId,
            attemptedDeviceId: deviceId,
            attemptedDeviceName: cleanDeviceName,
            boundDeviceId: voucher.bound_device_id,
            boundDeviceName: boundName,
          })
        );
        throw new VoucherError(
          `This voucher code has already been used once and is locked to "${boundName}". Only one device name is allowed.`,
          409,
          'DEVICE_LIMIT_REACHED'
        );
      }

      throw new VoucherError(
        `This voucher code can only be used once and has already been activated on "${boundName}".`,
        409,
        'VOUCHER_ALREADY_USED'
      );
    }

    const expiresAt = new Date(now.getTime() + Number(voucher.duration_minutes) * 60_000).toISOString();
    const sessionToken = generateSessionToken();
    const sessionId = generateId('ses');

    const updated = db
      .prepare(`
        UPDATE vouchers
        SET status = 'ACTIVE',
            bound_device_id = ?,
            bound_device_name = ?,
            activated_at = ?,
            expires_at = ?,
            updated_at = ?
        WHERE id = ? AND status = 'UNUSED' AND activated_at IS NULL
      `)
      .run(deviceId, cleanDeviceName, nowIso, expiresAt, nowIso, voucherId);

    if (Number(updated.changes || 0) !== 1) {
      throw new VoucherError('This voucher code has already been used.', 409, 'VOUCHER_ALREADY_USED');
    }

    db.prepare(`
      INSERT INTO sessions (
        id, business_id, session_token, voucher_id, device_id, customer_id, router_id,
        ip_address, status, started_at, expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
    `).run(
      sessionId,
      businessId,
      sessionToken,
      voucherId,
      deviceId,
      voucher.customer_id ? String(voucher.customer_id) : null,
      params.routerId ?? null,
      params.ipAddress ?? null,
      nowIso,
      expiresAt
    );

    logRedemption(true, `Single-use activation locked to device name "${cleanDeviceName}"`);

    db.prepare(`
      INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
      VALUES (?, ?, 'VOUCHER_ACTIVATED', 'INFO', ?, ?, ?)
    `).run(
      generateId('ntf'),
      businessId,
      `Voucher Activated (${voucher.code_masked})`,
      `Package ${voucher.package_name} activated once and locked to device "${cleanDeviceName}".`,
      JSON.stringify({ voucherId, sessionId, deviceId, boundDeviceName: cleanDeviceName })
    );

    return {
      reconnected: false,
      sessionId,
      sessionToken,
      businessId,
      businessName: voucher.business_name ? String(voucher.business_name) : 'TRAX LINK Hotspot',
      voucherId,
      codeMasked: String(voucher.code_masked),
      packageName: String(voucher.package_name),
      category: String(voucher.category),
      downloadKbps: Number(voucher.download_kbps),
      uploadKbps: Number(voucher.upload_kbps),
      dataLimitMb: voucher.data_limit_mb !== null ? Number(voucher.data_limit_mb) : null,
      deviceLabel: cleanDeviceName,
      startedAt: nowIso,
      expiresAt,
    };
  });
}

export function decryptVoucherCodeForAdmin(encryptedCode: string): string {
  return decryptSecret(encryptedCode);
}
