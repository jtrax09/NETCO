import React, { useEffect, useState } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  ArrowLeft,
  Cpu,
  HardDrive,
  RefreshCw,
  Router as RouterIcon,
  Users,
} from 'lucide-react';
import { apiRequest, formatBytes } from '../lib/api.ts';
import {
  evaluateRouterHealth,
  ROUTER_CPU_CRIT_PCT,
  ROUTER_CPU_WARN_PCT,
  ROUTER_MEM_CRIT_PCT,
  ROUTER_MEM_WARN_PCT,
} from '../lib/routerHealth.ts';

export interface AnalyticsRouterOption {
  id: string;
  name: string;
  host: string;
  apiPort: number;
  status: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  cpuLoad: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  uptime: string | null;
  routerOsVersion: string | null;
  boardName: string | null;
}

interface TelemetrySample {
  recordedAt: string;
  label: string;
  cpuLoad: number | null;
  memoryPct: number | null;
  memoryUsedMb: number | null;
  memoryTotalMb: number | null;
  activeHotspotCount: number;
}

interface TelemetryHistoryResponse {
  router: AnalyticsRouterOption;
  summary: {
    windowHours: number;
    sampleCount: number;
    latestCpuPct: number | null;
    avgCpuPct: number | null;
    peakCpuPct: number | null;
    latestMemoryPct: number | null;
    avgMemoryPct: number | null;
    peakMemoryPct: number | null;
    latestHotspotCount: number;
  };
  samples: TelemetrySample[];
}

interface Props {
  token: string;
  routers: AnalyticsRouterOption[];
  initialRouterId: string;
  canManage: boolean;
  onBack: () => void;
  onTelemetryRefreshed?: () => void;
}

export function RouterAnalyticsView({
  token,
  routers,
  initialRouterId,
  canManage,
  onBack,
  onTelemetryRefreshed,
}: Props) {
  const [selectedId, setSelectedId] = useState(initialRouterId);
  const [data, setData] = useState<TelemetryHistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedId(initialRouterId);
  }, [initialRouterId]);

  const fetchTelemetry = async (routerId: string, livePoll = false) => {
    if (!routerId) return;
    if (livePoll) setPolling(true);
    else setLoading(true);
    setError(null);
    try {
      const suffix = livePoll && canManage ? '?hours=24&poll=1' : '?hours=24';
      const res = await apiRequest<TelemetryHistoryResponse>(
        `/api/routers/${encodeURIComponent(routerId)}/telemetry${suffix}`,
        { token }
      );
      setData(res);
      if (livePoll && onTelemetryRefreshed) {
        onTelemetryRefreshed();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load router telemetry history');
    } finally {
      setLoading(false);
      setPolling(false);
    }
  };

  useEffect(() => {
    void fetchTelemetry(selectedId, false);
  }, [selectedId, token]);

  const activeRouter = data?.router || routers.find((r) => r.id === selectedId) || null;
  const health = activeRouter ? evaluateRouterHealth(activeRouter) : null;
  const summary = data?.summary;
  const samples = data?.samples ?? [];

  return (
    <div className="space-y-5">
      {/* Header Toolbar */}
      <div className="p-4 sm:p-5 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="btn-secondary min-h-[38px] px-3 py-1.5 text-xs"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            Back to Routers
          </button>

          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold tracking-tight">
                Router 24h Telemetry Analytics
              </h2>
              {health && (
                <span
                  className={`px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold ${
                    health.level === 'HEALTHY'
                      ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                      : health.level === 'WARNING'
                      ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                      : health.level === 'CRITICAL'
                      ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                      : 'bg-stone-200/70 dark:bg-white/10 text-slate-500 dark:text-[#8793A5]'
                  }`}
                >
                  {health.label}
                </span>
              )}
            </div>
            <p className="text-xs font-mono text-slate-500 dark:text-[#8793A5] mt-0.5 truncate">
              {activeRouter
                ? `${activeRouter.host || 'Unconfigured'}:${activeRouter.apiPort}${
                    activeRouter.boardName ? ` · ${activeRouter.boardName}` : ''
                  }${activeRouter.routerOsVersion ? ` · ROS ${activeRouter.routerOsVersion}` : ''}`
                : 'Select a router to inspect telemetry'}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="flex items-center gap-2">
            <RouterIcon className="w-3.5 h-3.5 text-slate-400 shrink-0" />
            <select
              aria-label="Select router for telemetry analytics"
              value={selectedId}
              onChange={(e) => setSelectedId(e.target.value)}
              className="px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#0D0F14] font-medium text-xs"
            >
              {routers.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.host || 'Standalone'})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            disabled={polling || loading}
            onClick={() => fetchTelemetry(selectedId, canManage)}
            className="btn-primary min-h-[38px] px-3.5 py-1.5 text-xs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${polling ? 'animate-spin' : ''}`} />
            {polling ? 'Sampling...' : canManage ? 'Sample Live Telemetry' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* 24h Telemetry Summary KPIs */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 text-xs tabular-nums">
        <div className="p-4 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10">
          <span className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Cpu className="w-3.5 h-3.5 text-[#D9A700] dark:text-[#FFD400]" />
            CPU Load (24h)
          </span>
          <span className="text-xl font-bold font-mono mt-1 block">
            {summary?.latestCpuPct !== null && summary?.latestCpuPct !== undefined
              ? `${summary.latestCpuPct}%`
              : '—'}
          </span>
          <span className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] mt-1 block">
            Avg {summary?.avgCpuPct !== null && summary?.avgCpuPct !== undefined ? `${summary.avgCpuPct}%` : '—'} · Peak{' '}
            {summary?.peakCpuPct !== null && summary?.peakCpuPct !== undefined ? `${summary.peakCpuPct}%` : '—'}
          </span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10">
          <span className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-sky-500" />
            Memory Utilization (24h)
          </span>
          <span className="text-xl font-bold font-mono mt-1 block text-sky-600 dark:text-sky-400">
            {summary?.latestMemoryPct !== null && summary?.latestMemoryPct !== undefined
              ? `${summary.latestMemoryPct}%`
              : '—'}
          </span>
          <span className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] mt-1 block">
            Avg {summary?.avgMemoryPct !== null && summary?.avgMemoryPct !== undefined ? `${summary.avgMemoryPct}%` : '—'} · Peak{' '}
            {summary?.peakMemoryPct !== null && summary?.peakMemoryPct !== undefined ? `${summary.peakMemoryPct}%` : '—'}
          </span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10">
          <span className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-emerald-500" />
            Active Hotspot Users
          </span>
          <span className="text-xl font-bold font-mono mt-1 block text-emerald-600 dark:text-emerald-400">
            {summary?.latestHotspotCount ?? 0}
          </span>
          <span className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] mt-1 block">
            {activeRouter?.uptime ? `Uptime ${activeRouter.uptime}` : 'Latest recorded session count'}
          </span>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10">
          <span className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5 text-violet-500" />
            24h Telemetry Samples
          </span>
          <span className="text-xl font-bold font-mono mt-1 block">
            {summary?.sampleCount ?? 0}
          </span>
          <span className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] mt-1 block">
            {activeRouter?.memoryTotalBytes
              ? `Total RAM ${formatBytes(activeRouter.memoryTotalBytes)}`
              : 'Recorded from live RouterOS checks'}
          </span>
        </div>
      </div>

      {loading ? (
        <div className="p-10 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10 text-center text-xs text-slate-500 dark:text-[#8793A5]">
          Loading 24-hour telemetry history...
        </div>
      ) : samples.length === 0 ? (
        <div className="p-10 rounded-xl bg-white dark:bg-[#13151A] border border-dashed border-stone-200 dark:border-white/15 flex flex-col items-center justify-center text-center gap-2 text-xs text-slate-500 dark:text-[#8793A5]">
          <Activity className="w-6 h-6 opacity-60" />
          <p className="font-semibold text-slate-800 dark:text-zinc-200">
            No historical CPU or memory telemetry recorded in the last 24 hours
          </p>
          <p className="max-w-md text-[11px]">
            Click &ldquo;Sample Live Telemetry&rdquo; when this MikroTik router is reachable to record real CPU load and memory snapshots onto the 24-hour timeline.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
          {/* CPU Usage Chart */}
          <section className="p-5 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-sm font-bold">CPU Usage Trend (24h)</h3>
                <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
                  Warning at {ROUTER_CPU_WARN_PCT}% · Critical at {ROUTER_CPU_CRIT_PCT}%
                </p>
              </div>
              <span className="font-mono text-xs font-bold text-[#9A7B00] dark:text-[#FFD400] tabular-nums">
                {summary?.latestCpuPct ?? 0}% now
              </span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={samples} margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272A" opacity={0.35} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#13151A',
                      borderColor: '#27272A',
                      color: '#ffffff',
                      fontSize: '12px',
                      borderRadius: '8px',
                    }}
                    formatter={(value: unknown) => [`${Number(value ?? 0)}%`, 'CPU Load']}
                  />
                  <ReferenceLine
                    y={ROUTER_CPU_WARN_PCT}
                    stroke="#F59E0B"
                    strokeDasharray="4 4"
                    opacity={0.7}
                  />
                  <ReferenceLine
                    y={ROUTER_CPU_CRIT_PCT}
                    stroke="#EF4444"
                    strokeDasharray="4 4"
                    opacity={0.7}
                  />
                  <Line
                    type="monotone"
                    dataKey="cpuLoad"
                    name="CPU Load (%)"
                    stroke="#FFD400"
                    strokeWidth={2.3}
                    dot={{ r: 2.5 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>

          {/* Memory Usage Chart */}
          <section className="p-5 rounded-xl bg-white dark:bg-[#13151A] border border-stone-200 dark:border-white/10 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <h3 className="font-display text-sm font-bold">Memory Utilization Trend (24h)</h3>
                <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
                  Warning at {ROUTER_MEM_WARN_PCT}% · Critical at {ROUTER_MEM_CRIT_PCT}%
                </p>
              </div>
              <span className="font-mono text-xs font-bold text-sky-600 dark:text-sky-400 tabular-nums">
                {summary?.latestMemoryPct !== null && summary?.latestMemoryPct !== undefined
                  ? `${summary.latestMemoryPct}%`
                  : '—'}
              </span>
            </div>
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={samples} margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272A" opacity={0.35} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#13151A',
                      borderColor: '#27272A',
                      color: '#ffffff',
                      fontSize: '12px',
                      borderRadius: '8px',
                    }}
                    formatter={(value: unknown) => [`${Number(value ?? 0)}%`, 'Memory Used']}
                  />
                  <ReferenceLine
                    y={ROUTER_MEM_WARN_PCT}
                    stroke="#F59E0B"
                    strokeDasharray="4 4"
                    opacity={0.7}
                  />
                  <ReferenceLine
                    y={ROUTER_MEM_CRIT_PCT}
                    stroke="#EF4444"
                    strokeDasharray="4 4"
                    opacity={0.7}
                  />
                  <Line
                    type="monotone"
                    dataKey="memoryPct"
                    name="Memory (%)"
                    stroke="#0EA5E9"
                    strokeWidth={2.3}
                    dot={{ r: 2.5 }}
                    activeDot={{ r: 5 }}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
