import type { NetcoDb } from '../db.ts';
import { expireStaleRecords, getOperatingMode, withTransaction } from '../db.ts';
import { computeNextRetryDelayMs, computeSubscriptionPolicy } from '../../../packages/billing-engine/index.ts';
import { pushHotspotProfileToRouter, terminateRouterSession } from './mikrotik.ts';
import { generateId } from '../utils/crypto.ts';

export interface ProvisionResult {
  subscriptionId: string;
  radiusUsername: string;
  status: string;
  provisioningStatus: 'STANDALONE' | 'PROVISIONED' | 'FAILED_RETRYING';
  jobId: string | null;
  detail: string;
}

export async function provisionSubscriptionForActivation(
  db: NetcoDb,
  params: {
    businessId: string;
    locationId?: string | null;
    customerId?: string | null;
    packageId: string;
    paymentId?: string | null;
    voucherId?: string | null;
    radiusUsername: string;
    radiusSecretValue: string;
    startsAtIso: string;
    expiresAtIso: string;
  }
): Promise<ProvisionResult> {
  const pkg = db
    .prepare(
      `SELECT id, name, duration_minutes, download_kbps, upload_kbps, data_limit_mb, simultaneous_sessions
       FROM packages WHERE id = ? AND business_id = ?`
    )
    .get(params.packageId, params.businessId) as Record<string, unknown> | undefined;

  if (!pkg) {
    throw new Error('Package not found in tenant workspace for subscription provisioning');
  }

  const downloadKbps = Number(pkg.download_kbps);
  const uploadKbps = Number(pkg.upload_kbps);
  const dataLimitMb = pkg.data_limit_mb !== null ? Number(pkg.data_limit_mb) : null;
  const simultaneousUse = Number(pkg.simultaneous_sessions || 1);
  const durationSeconds = Math.max(
    60,
    Math.floor((new Date(params.expiresAtIso).getTime() - new Date(params.startsAtIso).getTime()) / 1000)
  );

  const policy = computeSubscriptionPolicy({
    username: params.radiusUsername,
    downloadKbps,
    uploadKbps,
    sessionTimeoutSeconds: durationSeconds,
    dataLimitMb,
    simultaneousUse,
  });

  const subId = generateId('sub');
  const nowIso = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare(`
      INSERT INTO subscriptions (
        id, business_id, location_id, customer_id, package_id, payment_id, voucher_id,
        radius_username, status, provisioning_status, download_kbps, upload_kbps, data_limit_mb,
        starts_at, expires_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'PENDING', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      subId,
      params.businessId,
      params.locationId ?? null,
      params.customerId ?? null,
      params.packageId,
      params.paymentId ?? null,
      params.voucherId ?? null,
      params.radiusUsername,
      downloadKbps,
      uploadKbps,
      dataLimitMb,
      params.startsAtIso,
      params.expiresAtIso,
      nowIso,
      nowIso
    );

    // Upsert radcheck authentication entry
    db.prepare(`
      INSERT INTO radcheck (id, business_id, username, attribute, op, value, expires_at, is_active, created_at)
      VALUES (?, ?, ?, 'Cleartext-Password', ':=', ?, ?, 1, ?)
      ON CONFLICT(business_id, username, attribute) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at,
        is_active = 1
    `).run(
      generateId('rc'),
      params.businessId,
      params.radiusUsername,
      params.radiusSecretValue,
      params.expiresAtIso,
      nowIso
    );

    // Upsert radreply enforcement attributes
    const upsertReply = db.prepare(`
      INSERT INTO radreply (id, business_id, username, attribute, op, value, created_at)
      VALUES (?, ?, ?, ?, ':=', ?, ?)
      ON CONFLICT(business_id, username, attribute) DO UPDATE SET value = excluded.value
    `);

    upsertReply.run(generateId('rr'), params.businessId, params.radiusUsername, 'Mikrotik-Rate-Limit', policy.mikrotikRateLimit, nowIso);
    upsertReply.run(generateId('rr'), params.businessId, params.radiusUsername, 'Session-Timeout', String(policy.sessionTimeoutSeconds), nowIso);
    upsertReply.run(generateId('rr'), params.businessId, params.radiusUsername, 'Simultaneous-Use', String(policy.simultaneousUse), nowIso);
    if (policy.dataLimitBytes !== null) {
      upsertReply.run(
        generateId('rr'),
        params.businessId,
        params.radiusUsername,
        'Mikrotik-Total-Limit',
        String(policy.dataLimitBytes),
        nowIso
      );
    }
  });

  // Check if MIKROTIK_MODE and the business has routers configured
  const mode = getOperatingMode(db);
  const routerRow = db
    .prepare(
      `SELECT id, name, host FROM routers
       WHERE business_id = ? AND host != '' AND username != '' AND password_encrypted != ''
       ORDER BY CASE WHEN status = 'CONNECTED' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`
    )
    .get(params.businessId) as { id: string; name: string; host: string } | undefined;

  if (mode === 'STANDALONE_MODE' || !routerRow) {
    db.prepare("UPDATE subscriptions SET provisioning_status = 'STANDALONE', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      subId
    );
    return {
      subscriptionId: subId,
      radiusUsername: params.radiusUsername,
      status: 'ACTIVE',
      provisioningStatus: 'STANDALONE',
      jobId: null,
      detail: 'Subscription active with RADIUS policy ready (Standalone Mode).',
    };
  }

  // Attempt live MikroTik profile sync; on failure, queue retry safely without failing payment/subscription
  const syncRes = await pushHotspotProfileToRouter(
    db,
    routerRow.id,
    `trax-${params.packageId}`,
    downloadKbps,
    uploadKbps
  );

  if (syncRes.synced) {
    db.prepare("UPDATE subscriptions SET provisioning_status = 'PROVISIONED', updated_at = ? WHERE id = ?").run(
      new Date().toISOString(),
      subId
    );
    return {
      subscriptionId: subId,
      radiusUsername: params.radiusUsername,
      status: 'ACTIVE',
      provisioningStatus: 'PROVISIONED',
      jobId: null,
      detail: syncRes.message,
    };
  }

  const jobId = generateId('job');
  const nextRetryAt = new Date(Date.now() + computeNextRetryDelayMs(1)).toISOString();
  const retryNow = new Date().toISOString();

  withTransaction(db, () => {
    db.prepare("UPDATE subscriptions SET provisioning_status = 'FAILED_RETRYING', updated_at = ? WHERE id = ?").run(
      retryNow,
      subId
    );
    db.prepare(`
      INSERT INTO provisioning_jobs (
        id, business_id, subscription_id, router_id, action, status,
        attempts, max_attempts, last_error, next_retry_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'PROVISION_SUBSCRIPTION', 'FAILED_RETRYING', 1, 5, ?, ?, ?, ?)
    `).run(jobId, params.businessId, subId, routerRow.id, syncRes.message, nextRetryAt, retryNow, retryNow);

    db.prepare(`
      INSERT INTO notifications (id, business_id, type, severity, title, message, metadata)
      VALUES (?, ?, 'PROVISIONING_RETRY', 'WARNING', ?, ?, ?)
    `).run(
      generateId('ntf'),
      params.businessId,
      `Router Provisioning Queued (${routerRow.name})`,
      `Router ${routerRow.name} was unreachable. Provisioning job ${jobId} scheduled for automatic retry.`,
      JSON.stringify({ subscriptionId: subId, routerId: routerRow.id, jobId, error: syncRes.message })
    );
  });

  return {
    subscriptionId: subId,
    radiusUsername: params.radiusUsername,
    status: 'ACTIVE',
    provisioningStatus: 'FAILED_RETRYING',
    jobId,
    detail: `Router offline — queued retry job ${jobId}: ${syncRes.message}`,
  };
}

export async function retryProvisioningJob(
  db: NetcoDb,
  jobId: string,
  expectedBusinessId?: string
): Promise<{
  jobId: string;
  subscriptionId: string;
  status: string;
  provisioningStatus: string;
  synced: boolean;
  message: string;
}> {
  const job = db
    .prepare(`
      SELECT j.*, s.package_id, s.download_kbps, s.upload_kbps, s.business_id as sub_business_id
      FROM provisioning_jobs j
      JOIN subscriptions s ON s.id = j.subscription_id
      WHERE j.id = ?
    `)
    .get(jobId) as Record<string, unknown> | undefined;

  if (!job) {
    throw new Error('Provisioning job not found');
  }
  if (expectedBusinessId && String(job.business_id) !== expectedBusinessId) {
    throw new Error('CROSS_TENANT_FORBIDDEN');
  }

  const businessId = String(job.business_id);
  const routerId = job.router_id ? String(job.router_id) : null;
  const nowIso = new Date().toISOString();

  if (String(job.status) === 'COMPLETED') {
    return {
      jobId,
      subscriptionId: String(job.subscription_id),
      status: 'COMPLETED',
      provisioningStatus: 'PROVISIONED',
      synced: true,
      message: 'Provisioning already completed.',
    };
  }

  if (!routerId) {
    db.prepare("UPDATE provisioning_jobs SET status = 'COMPLETED', completed_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso,
      nowIso,
      jobId
    );
    db.prepare("UPDATE subscriptions SET provisioning_status = 'STANDALONE', updated_at = ? WHERE id = ?").run(
      nowIso,
      String(job.subscription_id)
    );
    return {
      jobId,
      subscriptionId: String(job.subscription_id),
      status: 'COMPLETED',
      provisioningStatus: 'STANDALONE',
      synced: true,
      message: 'No router bound; switched to Standalone RADIUS policy.',
    };
  }

  const syncRes = await pushHotspotProfileToRouter(
    db,
    routerId,
    `trax-${String(job.package_id)}`,
    Number(job.download_kbps),
    Number(job.upload_kbps)
  );

  if (syncRes.synced) {
    withTransaction(db, () => {
      db.prepare(`
        UPDATE provisioning_jobs
        SET status = 'COMPLETED', attempts = attempts + 1, last_error = NULL,
            completed_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nowIso, nowIso, jobId);
      db.prepare("UPDATE subscriptions SET provisioning_status = 'PROVISIONED', updated_at = ? WHERE id = ?").run(
        nowIso,
        String(job.subscription_id)
      );
    });
    return {
      jobId,
      subscriptionId: String(job.subscription_id),
      status: 'COMPLETED',
      provisioningStatus: 'PROVISIONED',
      synced: true,
      message: syncRes.message,
    };
  }

  const nextAttempts = Number(job.attempts || 0) + 1;
  const maxAttempts = Number(job.max_attempts || 5);
  const nextRetryAt =
    nextAttempts >= maxAttempts ? null : new Date(Date.now() + computeNextRetryDelayMs(nextAttempts)).toISOString();

  db.prepare(`
    UPDATE provisioning_jobs
    SET status = 'FAILED_RETRYING', attempts = ?, last_error = ?, next_retry_at = ?, updated_at = ?
    WHERE id = ? AND business_id = ?
  `).run(nextAttempts, syncRes.message, nextRetryAt, nowIso, jobId, businessId);

  return {
    jobId,
    subscriptionId: String(job.subscription_id),
    status: 'FAILED_RETRYING',
    provisioningStatus: 'FAILED_RETRYING',
    synced: false,
    message: syncRes.message,
  };
}

export async function processDueProvisioningJobs(db: NetcoDb, limit = 10): Promise<number> {
  const nowIso = new Date().toISOString();
  const due = db
    .prepare(
      `SELECT id FROM provisioning_jobs
       WHERE status = 'FAILED_RETRYING' AND attempts < max_attempts
         AND (next_retry_at IS NULL OR next_retry_at <= ?)
       ORDER BY updated_at ASC LIMIT ?`
    )
    .all(nowIso, limit) as Array<{ id: string }>;

  let completed = 0;
  for (const job of due) {
    try {
      const res = await retryProvisioningJob(db, job.id);
      if (res.synced) completed++;
    } catch {
      // Keep running for remaining jobs
    }
  }
  return completed;
}

export function authorizeRadiusRequest(
  db: NetcoDb,
  params: { username: string; password?: string | null; nasIpAddress?: string | null }
): {
  authorized: boolean;
  reason?: string;
  businessId?: string;
  replyAttributes?: Record<string, string | number>;
} {
  expireStaleRecords(db);

  const rawUsername = params.username.trim();
  if (!rawUsername) {
    return { authorized: false, reason: 'Missing RADIUS username' };
  }
  const normalizedUsername = rawUsername.replace(/[^A-Z0-9]/gi, '').toUpperCase();

  const check = db
    .prepare(`
      SELECT rc.business_id, rc.username, rc.value, rc.expires_at, rc.is_active,
             b.status as business_status,
             s.status as sub_status, s.expires_at as sub_expires_at
      FROM radcheck rc
      JOIN businesses b ON b.id = rc.business_id
      LEFT JOIN subscriptions s ON s.radius_username = rc.username AND s.business_id = rc.business_id
      WHERE (rc.username = ? OR rc.username = ?) AND rc.attribute = 'Cleartext-Password'
      LIMIT 1
    `)
    .get(rawUsername, normalizedUsername) as Record<string, unknown> | undefined;

  if (!check) {
    return { authorized: false, reason: 'Unknown RADIUS subscriber' };
  }
  const username = String(check.username);
  if (!check.is_active) {
    return { authorized: false, reason: 'Subscriber access revoked or expired' };
  }
  if (String(check.business_status) === 'SUSPENDED') {
    return { authorized: false, reason: 'Tenant workspace is suspended' };
  }
  if (check.sub_status && String(check.sub_status) !== 'ACTIVE') {
    return { authorized: false, reason: `Subscription status is ${check.sub_status}` };
  }

  const nowIso = new Date().toISOString();
  if ((check.expires_at && String(check.expires_at) <= nowIso) || (check.sub_expires_at && String(check.sub_expires_at) <= nowIso)) {
    db.prepare('UPDATE radcheck SET is_active = 0 WHERE username = ?').run(username);
    db.prepare("UPDATE subscriptions SET status = 'EXPIRED', updated_at = ? WHERE radius_username = ?").run(
      nowIso,
      username
    );
    return { authorized: false, reason: 'Subscription time limit expired' };
  }

  if (params.password !== undefined && params.password !== null && params.password !== String(check.value)) {
    return { authorized: false, reason: 'Invalid voucher/subscriber credentials' };
  }

  const replies = db
    .prepare('SELECT attribute, value FROM radreply WHERE username = ? AND business_id = ?')
    .all(username, String(check.business_id)) as Array<{ attribute: string; value: string }>;

  const replyAttributes: Record<string, string | number> = {};
  for (const r of replies) {
    replyAttributes[r.attribute] = /^\d+$/.test(r.value) ? Number(r.value) : r.value;
  }

  // Recompute remaining Session-Timeout dynamically based on expires_at
  const expIso = String(check.sub_expires_at || check.expires_at || '');
  if (expIso) {
    const remainingSec = Math.max(1, Math.floor((new Date(expIso).getTime() - Date.now()) / 1000));
    replyAttributes['Session-Timeout'] = remainingSec;
  }

  return {
    authorized: true,
    businessId: String(check.business_id),
    replyAttributes,
  };
}

export function ingestRadiusAccounting(
  db: NetcoDb,
  params: {
    acctSessionId: string;
    username: string;
    statusType: 'Start' | 'Interim-Update' | 'Stop';
    nasIpAddress?: string | null;
    framedIpAddress?: string | null;
    callingStationId?: string | null;
    acctInputOctets?: number;
    acctOutputOctets?: number;
    acctSessionTime?: number;
    terminateCause?: string | null;
  }
) {
  const rawAcctUser = params.username.trim();
  const normAcctUser = rawAcctUser.replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const sub = db
    .prepare('SELECT id, business_id, radius_username, voucher_id, data_limit_mb FROM subscriptions WHERE radius_username = ? OR radius_username = ? LIMIT 1')
    .get(rawAcctUser, normAcctUser) as
    | { id: string; business_id: string; radius_username: string; voucher_id: string | null; data_limit_mb: number | null }
    | undefined;

  if (!sub) {
    throw new Error('RADIUS accounting username not found');
  }
  const acctUsername = sub.radius_username;

  const nowIso = new Date().toISOString();
  const rx = Math.max(0, Number(params.acctInputOctets || 0));
  const tx = Math.max(0, Number(params.acctOutputOctets || 0));
  const sesTime = Math.max(0, Number(params.acctSessionTime || 0));

  return withTransaction(db, () => {
    db.prepare(`
      INSERT INTO radacct (
        id, business_id, acct_session_id, username, nas_ip_address, framed_ip_address,
        calling_station_id, acct_input_octets, acct_output_octets, acct_session_time,
        acct_start_time, acct_stop_time, terminate_cause
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(acct_session_id) DO UPDATE SET
        acct_input_octets = excluded.acct_input_octets,
        acct_output_octets = excluded.acct_output_octets,
        acct_session_time = excluded.acct_session_time,
        acct_stop_time = CASE WHEN excluded.acct_stop_time IS NOT NULL THEN excluded.acct_stop_time ELSE radacct.acct_stop_time END,
        terminate_cause = COALESCE(excluded.terminate_cause, radacct.terminate_cause)
    `).run(
      generateId('rac'),
      sub.business_id,
      params.acctSessionId,
      acctUsername,
      params.nasIpAddress ?? null,
      params.framedIpAddress ?? null,
      params.callingStationId ?? null,
      rx,
      tx,
      sesTime,
      nowIso,
      params.statusType === 'Stop' ? nowIso : null,
      params.terminateCause ?? null
    );

    if (sub.voucher_id) {
      db.prepare(`
        UPDATE sessions
        SET bytes_in = ?, bytes_out = ?
        WHERE voucher_id = ? AND status = 'ACTIVE'
      `).run(rx, tx, sub.voucher_id);
    }

    // Data cap enforcement
    let quotaExceeded = false;
    if (sub.data_limit_mb !== null && sub.data_limit_mb > 0) {
      const limitBytes = sub.data_limit_mb * 1024 * 1024;
      if (rx + tx >= limitBytes) {
        quotaExceeded = true;
        db.prepare("UPDATE subscriptions SET status = 'EXPIRED', updated_at = ? WHERE id = ?").run(nowIso, sub.id);
        db.prepare('UPDATE radcheck SET is_active = 0 WHERE username = ? AND business_id = ?').run(
          acctUsername,
          sub.business_id
        );
      }
    }

    return { ok: true, quotaExceeded, businessId: sub.business_id };
  });
}

export async function suspendSubscriptionAndDisconnect(
  db: NetcoDb,
  subscriptionId: string,
  businessId: string,
  reason = 'Suspended by administrator'
) {
  const sub = db
    .prepare('SELECT * FROM subscriptions WHERE id = ?')
    .get(subscriptionId) as Record<string, unknown> | undefined;

  if (!sub) {
    throw new Error('Subscription not found');
  }
  if (String(sub.business_id) !== businessId) {
    throw new Error('CROSS_TENANT_FORBIDDEN');
  }

  const nowIso = new Date().toISOString();
  withTransaction(db, () => {
    db.prepare("UPDATE subscriptions SET status = 'SUSPENDED', revoked_at = ?, updated_at = ? WHERE id = ?").run(
      nowIso,
      nowIso,
      subscriptionId
    );
    db.prepare('UPDATE radcheck SET is_active = 0 WHERE username = ? AND business_id = ?').run(
      String(sub.radius_username),
      businessId
    );
    if (sub.voucher_id) {
      db.prepare(`
        UPDATE vouchers SET status = 'REVOKED', revoked_at = ?, revoked_reason = ?, updated_at = ?
        WHERE id = ? AND status != 'REVOKED'
      `).run(nowIso, reason, nowIso, String(sub.voucher_id));
      db.prepare(`
        UPDATE sessions SET status = 'TERMINATED', ended_at = ?, end_reason = ?
        WHERE voucher_id = ? AND status = 'ACTIVE'
      `).run(nowIso, reason, String(sub.voucher_id));
    }
  });

  if (sub.voucher_id) {
    const activeSess = db
      .prepare("SELECT router_id, ip_address FROM sessions WHERE voucher_id = ? AND router_id IS NOT NULL")
      .all(String(sub.voucher_id)) as Array<{ router_id: string | null; ip_address: string | null }>;
    for (const s of activeSess) {
      if (s.router_id && s.ip_address) {
        await terminateRouterSession(db, s.router_id, s.ip_address);
      }
    }
  }
}
