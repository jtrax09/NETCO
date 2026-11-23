import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import type { NetcoDb } from '../db.ts';
import { decryptSecret, generateId } from '../utils/crypto.ts';

export interface RouterConnectionConfig {
  id: string;
  name: string;
  host: string;
  apiPort: number;
  useTls: boolean;
  username: string;
  password: string;
  hotspotServer: string;
}

export interface RouterTelemetryResult {
  connected: boolean;
  error?: string;
  cpuLoad?: number;
  memoryUsedBytes?: number;
  memoryTotalBytes?: number;
  uptime?: string;
  routerOsVersion?: string;
  boardName?: string;
  interfaces: Array<{
    name: string;
    type: string;
    running: boolean;
    disabled: boolean;
    rxBytes: number;
    txBytes: number;
  }>;
  activeHotspotCount: number;
}

// Encode a single RouterOS API word with length prefix per MikroTik API specification
function encodeWord(word: string): Buffer {
  const buf = Buffer.from(word, 'utf8');
  const len = buf.length;
  let lenBuf: Buffer;
  if (len < 0x80) {
    lenBuf = Buffer.from([len]);
  } else if (len < 0x4000) {
    const val = len | 0x8000;
    lenBuf = Buffer.from([(val >> 8) & 0xff, val & 0xff]);
  } else if (len < 0x200000) {
    const val = len | 0xc00000;
    lenBuf = Buffer.from([(val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
  } else {
    const val = len | 0xe0000000;
    lenBuf = Buffer.from([(val >> 24) & 0xff, (val >> 16) & 0xff, (val >> 8) & 0xff, val & 0xff]);
  }
  return Buffer.concat([lenBuf, buf]);
}

function encodeSentence(words: string[]): Buffer {
  return Buffer.concat([...words.map(encodeWord), Buffer.from([0x00])]);
}

function decodeLength(buffer: Buffer, offset: number): { length: number; bytesRead: number } | null {
  if (offset >= buffer.length) return null;
  const b0 = buffer[offset];
  if ((b0 & 0x80) === 0) {
    return { length: b0, bytesRead: 1 };
  }
  if ((b0 & 0xc0) === 0x80) {
    if (offset + 1 >= buffer.length) return null;
    return { length: ((b0 & ~0xc0) << 8) + buffer[offset + 1], bytesRead: 2 };
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (offset + 2 >= buffer.length) return null;
    return {
      length: ((b0 & ~0xe0) << 16) + (buffer[offset + 1] << 8) + buffer[offset + 2],
      bytesRead: 3,
    };
  }
  if ((b0 & 0xf0) === 0xe0) {
    if (offset + 3 >= buffer.length) return null;
    return {
      length:
        ((b0 & ~0xf0) << 24) +
        (buffer[offset + 1] << 16) +
        (buffer[offset + 2] << 8) +
        buffer[offset + 3],
      bytesRead: 4,
    };
  }
  return null;
}

class RouterOsClient {
  private socket: net.Socket | tls.TLSSocket | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private pendingSentences: string[][] = [];
  private waiters: Array<(sentence: string[]) => void> = [];

  async connect(host: string, port: number, useTls: boolean, timeoutMs = 4500): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onTimeout = () => {
        cleanup();
        this.socket?.destroy();
        reject(new Error(`Connection timed out after ${timeoutMs}ms (${host}:${port})`));
      };
      const onConnect = () => {
        cleanup();
        resolve();
      };
      const cleanup = () => {
        this.socket?.off('error', onError);
        this.socket?.off('timeout', onTimeout);
        this.socket?.off('connect', onConnect);
        this.socket?.off('secureConnect', onConnect);
      };

      this.socket = useTls
        ? tls.connect({ host, port, rejectUnauthorized: false })
        : net.connect({ host, port });

      this.socket.setTimeout(timeoutMs);
      this.socket.on('error', onError);
      this.socket.on('timeout', onTimeout);
      this.socket.on(useTls ? 'secureConnect' : 'connect', onConnect);
      this.socket.on('data', (chunk: Buffer) => this.onData(chunk));
    });
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let currentSentence: string[] = [];
    let offset = 0;

    while (offset < this.buffer.length) {
      const lenInfo = decodeLength(this.buffer, offset);
      if (!lenInfo) break;
      if (lenInfo.length === 0) {
        offset += lenInfo.bytesRead;
        const done = currentSentence;
        currentSentence = [];
        const waiter = this.waiters.shift();
        if (waiter) {
          waiter(done);
        } else {
          this.pendingSentences.push(done);
        }
        this.buffer = this.buffer.subarray(offset);
        offset = 0;
        continue;
      }
      if (offset + lenInfo.bytesRead + lenInfo.length > this.buffer.length) {
        break;
      }
      const word = this.buffer
        .subarray(offset + lenInfo.bytesRead, offset + lenInfo.bytesRead + lenInfo.length)
        .toString('utf8');
      currentSentence.push(word);
      offset += lenInfo.bytesRead + lenInfo.length;
    }
  }

  private nextSentence(timeoutMs = 4500): Promise<string[]> {
    const queued = this.pendingSentences.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.indexOf(onSentence);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error('RouterOS API response timeout'));
      }, timeoutMs);
      const onSentence = (s: string[]) => {
        clearTimeout(timer);
        resolve(s);
      };
      this.waiters.push(onSentence);
    });
  }

  async command(words: string[]): Promise<Array<Record<string, string>>> {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('RouterOS socket not connected');
    }
    this.socket.write(encodeSentence(words));
    const records: Array<Record<string, string>> = [];

    while (true) {
      const sentence = await this.nextSentence();
      const tag = sentence[0];
      const parsed: Record<string, string> = {};
      for (const word of sentence.slice(1)) {
        if (word.startsWith('=')) {
          const eqIdx = word.indexOf('=', 1);
          if (eqIdx > 1) {
            parsed[word.slice(1, eqIdx)] = word.slice(eqIdx + 1);
          }
        }
      }
      if (tag === '!re') {
        records.push(parsed);
      } else if (tag === '!done') {
        if (Object.keys(parsed).length > 0) records.push(parsed);
        return records;
      } else if (tag === '!trap' || tag === '!fatal') {
        throw new Error(parsed.message || 'RouterOS API command rejected');
      }
    }
  }

  async login(username: string, password: string): Promise<void> {
    const res = await this.command(['/login', `=name=${username}`, `=password=${password}`]);
    const ret = res[0]?.ret;
    if (ret) {
      // Legacy pre-6.43 challenge login
      const challenge = Buffer.from(ret, 'hex');
      const md5 = crypto
        .createHash('md5')
        .update(Buffer.concat([Buffer.from([0]), Buffer.from(password, 'utf8'), challenge]))
        .digest('hex');
      await this.command(['/login', `=name=${username}`, `=response=00${md5}`]);
    }
  }

  close(): void {
    this.socket?.end();
    this.socket?.destroy();
    this.socket = null;
  }
}

export async function testRouterConnection(config: RouterConnectionConfig): Promise<RouterTelemetryResult> {
  const client = new RouterOsClient();
  try {
    await client.connect(config.host, config.apiPort, config.useTls, 4000);
    await client.login(config.username, config.password);

    const resources = await client.command(['/system/resource/print']);
    const ifaces = await client.command(['/interface/print']);
    const hotspotActive = await client.command(['/ip/hotspot/active/print']);

    const res = resources[0] || {};
    const totalMem = Number(res['total-memory'] || 0);
    const freeMem = Number(res['free-memory'] || 0);

    return {
      connected: true,
      cpuLoad: Number(res['cpu-load'] || 0),
      memoryTotalBytes: totalMem,
      memoryUsedBytes: Math.max(0, totalMem - freeMem),
      uptime: res.uptime || undefined,
      routerOsVersion: res.version || undefined,
      boardName: res['board-name'] || res.platform || undefined,
      interfaces: ifaces.slice(0, 24).map((iface) => ({
        name: iface.name || 'ether',
        type: iface.type || 'ether',
        running: iface.running === 'true',
        disabled: iface.disabled === 'true',
        rxBytes: Number(iface['rx-byte'] || 0),
        txBytes: Number(iface['tx-byte'] || 0),
      })),
      activeHotspotCount: hotspotActive.length,
    };
  } catch (err) {
    return {
      connected: false,
      error: err instanceof Error ? err.message : 'Unable to reach MikroTik RouterOS API',
      interfaces: [],
      activeHotspotCount: 0,
    };
  } finally {
    client.close();
  }
}

export async function syncRouterTelemetry(db: NetcoDb, routerId: string): Promise<RouterTelemetryResult> {
  const row = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as Record<string, unknown> | undefined;
  if (!row) {
    throw new Error('Router not found');
  }

  const host = String(row.host || '').trim();
  const username = String(row.username || '').trim();
  const encryptedPass = String(row.password_encrypted || '').trim();

  let result: RouterTelemetryResult;
  if (!host || !username || !encryptedPass) {
    result = {
      connected: false,
      error: 'No MikroTik router connected — host or credentials not configured (Standalone Mode).',
      interfaces: [],
      activeHotspotCount: 0,
    };
  } else if (host === '8.8.8.8') {
    result = {
      connected: false,
      error: '8.8.8.8 is not a valid MikroTik router address.',
      interfaces: [],
      activeHotspotCount: 0,
    };
  } else {
    const password = decryptSecret(encryptedPass);
    result = await testRouterConnection({
      id: String(row.id),
      name: String(row.name),
      host,
      apiPort: Number(row.api_port || 8728),
      useTls: Boolean(row.use_tls),
      username,
      password,
      hotspotServer: String(row.hotspot_server || ''),
    });
  }

  const nowIso = new Date().toISOString();
  const prevStatus = String(row.status);
  const nextStatus = result.connected ? 'CONNECTED' : 'NOT_CONNECTED';

  db.prepare(`
    UPDATE routers
    SET status = ?,
        cpu_load = ?,
        memory_used_bytes = ?,
        memory_total_bytes = ?,
        uptime = ?,
        router_os_version = ?,
        board_name = ?,
        last_error = ?,
        last_checked_at = ?,
        updated_at = ?
    WHERE id = ?
  `).run(
    nextStatus,
    result.connected ? result.cpuLoad ?? null : null,
    result.connected ? result.memoryUsedBytes ?? null : null,
    result.connected ? result.memoryTotalBytes ?? null : null,
    result.connected ? result.uptime ?? null : null,
    result.connected ? result.routerOsVersion ?? null : null,
    result.connected ? result.boardName ?? null : null,
    result.connected ? null : result.error || 'Router unreachable',
    nowIso,
    nowIso,
    routerId
  );

  if (result.connected && result.interfaces.length > 0) {
    const upsertIface = db.prepare(`
      INSERT INTO router_interfaces (id, router_id, name, type, running, disabled, rx_bytes, tx_bytes, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(router_id, name) DO UPDATE SET
        type = excluded.type,
        running = excluded.running,
        disabled = excluded.disabled,
        rx_bytes = excluded.rx_bytes,
        tx_bytes = excluded.tx_bytes,
        updated_at = excluded.updated_at
    `);
    for (const iface of result.interfaces) {
      upsertIface.run(
        generateId('rif'),
        routerId,
        iface.name,
        iface.type,
        iface.running ? 1 : 0,
        iface.disabled ? 1 : 0,
        iface.rxBytes,
        iface.txBytes,
        nowIso
      );
    }
  }

  if (prevStatus !== nextStatus) {
    db.prepare(`
      INSERT INTO notifications (id, type, severity, title, message, metadata)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      generateId('ntf'),
      result.connected ? 'ROUTER_ONLINE' : 'ROUTER_OFFLINE',
      result.connected ? 'INFO' : 'WARNING',
      result.connected ? `Router ${row.name} Online` : `Router ${row.name} Not Connected`,
      result.connected
        ? `Connected to MikroTik RouterOS (${result.boardName || row.host}).`
        : result.error || `Router ${row.host}:${row.api_port} is unreachable.`,
      JSON.stringify({ routerId, host: row.host })
    );
  }

  return result;
}

export async function pushHotspotProfileToRouter(
  db: NetcoDb,
  routerId: string,
  profileName: string,
  downloadKbps: number,
  uploadKbps: number
): Promise<{ synced: boolean; message: string }> {
  const row = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as Record<string, unknown> | undefined;
  if (!row) return { synced: false, message: 'Router not found' };
  const host = String(row.host || '').trim();
  const username = String(row.username || '').trim();
  const encryptedPass = String(row.password_encrypted || '').trim();
  if (!host || !username || !encryptedPass || host === '8.8.8.8') {
    return { synced: false, message: 'No MikroTik router connected (credentials not configured)' };
  }

  const client = new RouterOsClient();
  try {
    const password = decryptSecret(encryptedPass);
    await client.connect(host, Number(row.api_port || 8728), Boolean(row.use_tls), 4000);
    await client.login(username, password);
    const rateLimit = `${uploadKbps}k/${downloadKbps}k`;
    await client.command([
      '/ip/hotspot/user/profile/add',
      `=name=${profileName}`,
      `=rate-limit=${rateLimit}`,
      '=shared-users=1',
    ]);
    return { synced: true, message: `Synced profile ${profileName} (${rateLimit}, shared-users=1)` };
  } catch (err) {
    return {
      synced: false,
      message: err instanceof Error ? err.message : 'RouterOS profile sync skipped (router unreachable)',
    };
  } finally {
    client.close();
  }
}

export async function terminateRouterSession(
  db: NetcoDb,
  routerId: string,
  ipAddress?: string | null
): Promise<{ removed: boolean; detail: string }> {
  const row = db.prepare('SELECT * FROM routers WHERE id = ?').get(routerId) as Record<string, unknown> | undefined;
  if (!row || !ipAddress || !row.host || !row.username || !row.password_encrypted) {
    return { removed: false, detail: 'No connected router binding for session' };
  }
  const client = new RouterOsClient();
  try {
    const password = decryptSecret(String(row.password_encrypted));
    await client.connect(String(row.host), Number(row.api_port || 8728), Boolean(row.use_tls), 3500);
    await client.login(String(row.username), password);
    const active = await client.command(['/ip/hotspot/active/print', `?address=${ipAddress}`]);
    for (const item of active) {
      if (item['.id']) {
        await client.command(['/ip/hotspot/active/remove', `=.id=${item['.id']}`]);
      }
    }
    return { removed: active.length > 0, detail: `Removed ${active.length} active RouterOS hotspot session(s)` };
  } catch (err) {
    return {
      removed: false,
      detail: err instanceof Error ? err.message : 'RouterOS API unreachable',
    };
  } finally {
    client.close();
  }
}
