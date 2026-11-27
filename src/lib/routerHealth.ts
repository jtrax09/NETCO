export const ROUTER_CPU_WARN_PCT = 75;
export const ROUTER_CPU_CRIT_PCT = 90;
export const ROUTER_MEM_WARN_PCT = 80;
export const ROUTER_MEM_CRIT_PCT = 92;

export type RouterHealthLevel = 'HEALTHY' | 'WARNING' | 'CRITICAL' | 'OFFLINE';

export interface RouterTelemetryInput {
  status: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  cpuLoad: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  lastError?: string | null;
}

export interface RouterHealthAssessment {
  level: RouterHealthLevel;
  label: string;
  cpuPct: number | null;
  memPct: number | null;
  cpuState: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
  memState: 'NORMAL' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';
  exceededReasons: string[];
  summary: string;
}

export function evaluateRouterHealth(router: RouterTelemetryInput): RouterHealthAssessment {
  const cpuPct =
    router.cpuLoad !== null && Number.isFinite(router.cpuLoad)
      ? Math.max(0, Math.min(100, Math.round(router.cpuLoad)))
      : null;

  const memPct =
    router.memoryUsedBytes !== null &&
    router.memoryTotalBytes !== null &&
    router.memoryTotalBytes > 0 &&
    Number.isFinite(router.memoryUsedBytes) &&
    Number.isFinite(router.memoryTotalBytes)
      ? Math.max(0, Math.min(100, Math.round((router.memoryUsedBytes / router.memoryTotalBytes) * 100)))
      : null;

  if (router.status === 'ERROR') {
    return {
      level: 'CRITICAL',
      label: 'Connection Error',
      cpuPct,
      memPct,
      cpuState: 'UNKNOWN',
      memState: 'UNKNOWN',
      exceededReasons: [router.lastError || 'RouterOS API connection failed'],
      summary: router.lastError || 'RouterOS API connection failed.',
    };
  }

  if (router.status !== 'CONNECTED') {
    return {
      level: 'OFFLINE',
      label: 'No MikroTik router connected',
      cpuPct: null,
      memPct: null,
      cpuState: 'UNKNOWN',
      memState: 'UNKNOWN',
      exceededReasons: [],
      summary: 'Standalone Mode active — awaiting MikroTik RouterOS hardware.',
    };
  }

  const cpuState =
    cpuPct === null
      ? 'UNKNOWN'
      : cpuPct >= ROUTER_CPU_CRIT_PCT
      ? 'CRITICAL'
      : cpuPct >= ROUTER_CPU_WARN_PCT
      ? 'WARNING'
      : 'NORMAL';

  const memState =
    memPct === null
      ? 'UNKNOWN'
      : memPct >= ROUTER_MEM_CRIT_PCT
      ? 'CRITICAL'
      : memPct >= ROUTER_MEM_WARN_PCT
      ? 'WARNING'
      : 'NORMAL';

  const exceededReasons: string[] = [];
  if (cpuState === 'CRITICAL' && cpuPct !== null) {
    exceededReasons.push(`CPU load at ${cpuPct}% (critical >= ${ROUTER_CPU_CRIT_PCT}%)`);
  } else if (cpuState === 'WARNING' && cpuPct !== null) {
    exceededReasons.push(`CPU load at ${cpuPct}% (warning >= ${ROUTER_CPU_WARN_PCT}%)`);
  }

  if (memState === 'CRITICAL' && memPct !== null) {
    exceededReasons.push(`Memory usage at ${memPct}% (critical >= ${ROUTER_MEM_CRIT_PCT}%)`);
  } else if (memState === 'WARNING' && memPct !== null) {
    exceededReasons.push(`Memory usage at ${memPct}% (warning >= ${ROUTER_MEM_WARN_PCT}%)`);
  }

  if (cpuState === 'CRITICAL' || memState === 'CRITICAL') {
    return {
      level: 'CRITICAL',
      label: 'Critical Load Warning',
      cpuPct,
      memPct,
      cpuState,
      memState,
      exceededReasons,
      summary: exceededReasons.join(' · '),
    };
  }

  if (cpuState === 'WARNING' || memState === 'WARNING') {
    return {
      level: 'WARNING',
      label: 'High Load Warning',
      cpuPct,
      memPct,
      cpuState,
      memState,
      exceededReasons,
      summary: exceededReasons.join(' · '),
    };
  }

  return {
    level: 'HEALTHY',
    label: 'Healthy',
    cpuPct,
    memPct,
    cpuState,
    memState,
    exceededReasons: [],
    summary: 'CPU and memory telemetry within normal operating thresholds.',
  };
}
