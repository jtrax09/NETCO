import React, { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { apiRequest, formatBytes, formatTzs } from '../lib/api.ts';

interface DashboardSummary {
  operatingMode?: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
  stats: {
    totalCustomers: number;
    onlineCustomers: number;
    offlineCustomers: number;
    activeSessionsCount: number;
    activeVouchers: number;
    unusedVouchers: number;
    expiredVouchers: number;
    revokedVouchers: number;
    testVouchersCount?: number;
    testPaymentsCount?: number;
    dailyRevenueTzs: number;
    weeklyRevenueTzs: number;
    monthlyRevenueTzs: number;
    totalRxBytes: number;
    totalTxBytes: number;
  };
  routers: Array<{
    id: string;
    name: string;
    host: string;
    apiPort: number;
    status: string;
    cpuLoad: number | null;
    memoryUsedBytes: number | null;
    memoryTotalBytes: number | null;
    uptime: string | null;
    lastError: string | null;
  }>;
  recentActivities: Array<{
    id: string;
    actorEmail: string;
    actorRole: string;
    action: string;
    entityType: string;
    createdAt: string;
  }>;
  dailySeries: Array<{
    day: string;
    revenueTzs: number;
    txCount: number;
  }>;
}

interface Props {
  token: string;
  refreshTrigger: number;
  onNavigate: (section: string) => void;
}

export function DashboardView({ token, refreshTrigger, onNavigate }: Props) {
  const [data, setData] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      setError(null);
      const res = await apiRequest<DashboardSummary>('/api/dashboard/summary', { token });
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load dashboard');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  if (loading && !data) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 animate-pulse" />
          ))}
        </div>
        <div className="h-72 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 animate-pulse" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-6 rounded-xl bg-white dark:bg-[#101827] border border-red-200 dark:border-red-900/50 text-sm text-red-600 dark:text-red-300">
        {error || 'Unable to load dashboard metrics.'}
      </div>
    );
  }

  const { stats, routers, recentActivities, dailySeries } = data;
  const voucherDistribution = [
    { name: 'Active', count: stats.activeVouchers },
    { name: 'Unused', count: stats.unusedVouchers },
    { name: 'Expired', count: stats.expiredVouchers },
    { name: 'Revoked', count: stats.revokedVouchers },
  ];

  return (
    <div className="space-y-6">
      {/* Primary KPI Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <p className="text-xs font-medium text-slate-500 dark:text-[#8793A5]">Customers</p>
          <p className="text-2xl font-bold tabular-nums mt-2">{stats.totalCustomers}</p>
          <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-2 tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400 font-medium">{stats.onlineCustomers} online</span>
            {' · '}
            <span>{stats.offlineCustomers} offline</span>
          </p>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <p className="text-xs font-medium text-slate-500 dark:text-[#8793A5]">Vouchers</p>
          <p className="text-2xl font-bold tabular-nums mt-2">{stats.activeVouchers + stats.unusedVouchers}</p>
          <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-2 tabular-nums">
            {stats.activeVouchers} active · {stats.unusedVouchers} unused · {stats.expiredVouchers} expired
            {stats.testVouchersCount ? ` · ${stats.testVouchersCount} test` : ''}
          </p>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <p className="text-xs font-medium text-slate-500 dark:text-[#8793A5]">Monthly Verified Revenue</p>
          <p className="text-2xl font-bold tabular-nums mt-2 text-[#9A7B00] dark:text-[#FFD400]">
            {formatTzs(stats.monthlyRevenueTzs)}
          </p>
          <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-2 tabular-nums">
            Today {formatTzs(stats.dailyRevenueTzs)} · 7d {formatTzs(stats.weeklyRevenueTzs)}
          </p>
        </div>

        <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <p className="text-xs font-medium text-slate-500 dark:text-[#8793A5]">Network Bandwidth</p>
          <p className="text-2xl font-bold tabular-nums mt-2">
            {formatBytes(stats.totalRxBytes + stats.totalTxBytes)}
          </p>
          <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-2 tabular-nums">
            RX {formatBytes(stats.totalRxBytes)} · TX {formatBytes(stats.totalTxBytes)} · {stats.activeSessionsCount} live sessions
          </p>
        </div>
      </div>

      {/* Analytics Row */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-7 p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">7-Day Verified Revenue (TZS)</h3>
              <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                Calculated strictly from live provider-verified payments (test tokens excluded)
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="btn-chip-accent"
            >
              Open Reports
            </button>
          </div>
          {dailySeries.length === 0 ? (
            <div className="h-56 flex items-center justify-center text-xs text-slate-500 dark:text-[#8793A5] border border-dashed border-slate-200 dark:border-slate-800 rounded-lg">
              No verified payments recorded in the past 7 days.
            </div>
          ) : (
            <div className="h-56">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailySeries}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272A" opacity={0.45} />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#161618',
                      borderColor: '#27272A',
                      color: '#ffffff',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="revenueTzs" fill="#FFD400" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="lg:col-span-5 p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="text-sm font-semibold">Voucher Inventory</h3>
              <p className="text-xs text-slate-500 dark:text-[#8793A5]">Live database distribution</p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('vouchers')}
              className="btn-chip-accent"
            >
              Manage Vouchers
            </button>
          </div>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={voucherDistribution}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272A" opacity={0.45} />
                <XAxis dataKey="name" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#161618',
                    borderColor: '#27272A',
                    color: '#ffffff',
                    fontSize: '12px',
                  }}
                />
                <Bar dataKey="count" fill="#FFD400" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Router Health & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        <div className="lg:col-span-6 p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">MikroTik Router Health</h3>
            <button
              type="button"
              onClick={() => onNavigate('routers')}
              className="btn-chip-accent"
            >
              Configure Routers
            </button>
          </div>
          {routers.length === 0 ? (
            <div className="p-6 rounded-lg border border-dashed border-slate-200 dark:border-slate-800 text-center space-y-2">
              <div className="flex items-center justify-center gap-2">
                <span className="text-xs font-mono font-semibold text-amber-600 dark:text-amber-400">
                  No MikroTik router connected
                </span>
                <span className="px-2 py-0.5 rounded bg-[#FFD400]/15 text-[#9A7B00] dark:text-[#FFD400] text-[11px] font-mono font-semibold">
                  {data.operatingMode === 'MIKROTIK_MODE' ? 'MikroTik Mode' : 'Standalone Mode'}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                TRAX LINK is running natively in Standalone Mode. Connect a MikroTik RouterOS device optionally when hardware is available.
              </p>
              <button
                type="button"
                onClick={() => onNavigate('routers')}
                className="btn-primary text-xs"
              >
                Connect Router
              </button>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {routers.map((r) => (
                <div key={r.id} className="py-3 flex items-center justify-between gap-4 text-xs">
                  <div>
                    <p className="font-semibold text-sm">{r.name}</p>
                    <p className="text-slate-500 dark:text-[#8793A5] font-mono">
                      {r.host}:{r.apiPort} · {r.status === 'CONNECTED' ? r.uptime || 'Online' : r.lastError || 'NOT CONNECTED'}
                    </p>
                  </div>
                  <div className="text-right tabular-nums">
                    <p
                      className={
                        r.status === 'CONNECTED'
                          ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                          : 'text-amber-600 dark:text-amber-400 font-semibold'
                      }
                    >
                      {r.status === 'CONNECTED' ? 'CONNECTED' : 'NOT CONNECTED'}
                    </p>
                    {r.status === 'CONNECTED' && r.cpuLoad !== null && (
                      <p className="text-slate-500 dark:text-[#8793A5]">CPU {r.cpuLoad}%</p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="lg:col-span-6 p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold">Recent System Activities</h3>
            <button
              type="button"
              onClick={() => onNavigate('staff')}
              className="btn-chip-accent"
            >
              Audit Logs
            </button>
          </div>
          {recentActivities.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-[#8793A5] py-8 text-center">
              No administrative activity recorded yet.
            </p>
          ) : (
            <div className="divide-y divide-slate-100 dark:divide-slate-800">
              {recentActivities.slice(0, 6).map((act) => (
                <div key={act.id} className="py-2.5 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <p className="font-medium truncate">{act.action.replace(/_/g, ' ')}</p>
                    <p className="text-slate-500 dark:text-[#8793A5] truncate">
                      {act.actorEmail} · {act.entityType}
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 dark:text-[#8793A5] shrink-0 tabular-nums">
                    {new Date(act.createdAt).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
