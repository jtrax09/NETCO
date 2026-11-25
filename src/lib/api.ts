let activeTenantOverrideId: string | null = null;

export function setActiveTenantId(tenantId: string | null) {
  activeTenantOverrideId = tenantId && tenantId.trim() ? tenantId.trim() : null;
}

export function getActiveTenantId(): string | null {
  return activeTenantOverrideId;
}

export function getTenantHeaders(): Record<string, string> {
  return activeTenantOverrideId ? { 'x-tenant-id': activeTenantOverrideId } : {};
}

export async function apiRequest<T>(
  url: string,
  options: {
    method?: string;
    token?: string | null;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Promise<T> {
  const res = await fetch(url, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...getTenantHeaders(),
      ...(options.headers ?? {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { error: text || `HTTP ${res.status}` };
  }

  if (!res.ok) {
    const err = new Error(String(data.error || `Request failed (${res.status})`)) as Error & {
      status?: number;
      code?: string;
    };
    err.status = res.status;
    err.code = typeof data.code === 'string' ? data.code : undefined;
    throw err;
  }

  return data as T;
}

export function formatTzs(amount: number | null | undefined): string {
  const n = Number(amount || 0);
  return `${n.toLocaleString('en-US')} TZS`;
}

export function formatBytes(bytes: number | null | undefined): string {
  const b = Number(bytes || 0);
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 * 1024 * 1024) return `${(b / (1024 * 1024)).toFixed(1)} MB`;
  return `${(b / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatSpeed(kbps: number | null | undefined): string {
  const k = Number(kbps || 0);
  if (k >= 1000) {
    const mbps = k / 1000;
    return `${Number.isInteger(mbps) ? mbps : mbps.toFixed(1)} Mbps`;
  }
  return `${k} Kbps`;
}

export function formatDurationMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 1440) {
    const hrs = minutes / 60;
    return `${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)} hr${hrs === 1 ? '' : 's'}`;
  }
  const days = minutes / 1440;
  return `${Number.isInteger(days) ? days : days.toFixed(1)} day${days === 1 ? '' : 's'}`;
}

export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const mins = Math.floor((s % 3600) / 60);
  const secs = s % 60;
  const pad = (v: number) => String(v).padStart(2, '0');
  if (days > 0) return `${days}d ${pad(hours)}:${pad(mins)}:${pad(secs)}`;
  return `${pad(hours)}:${pad(mins)}:${pad(secs)}`;
}
