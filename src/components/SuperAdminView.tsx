import React, { useEffect, useState } from 'react';
import { ArrowRight, Building2, Plus, RefreshCw, X } from 'lucide-react';
import { apiRequest, formatTzs } from '../lib/api.ts';

interface PlatformOverview {
  stats: {
    totalBusinesses: number;
    activeBusinesses: number;
    suspendedBusinesses: number;
    pendingBusinesses: number;
    totalCustomers: number;
    totalRouters: number;
    onlineRouters: number;
    offlineRouters: number;
    activeSaasSubscriptions: number;
    saasRevenueTzs: number;
    totalWifiRevenueTzs: number;
    retryingProvisioningJobs: number;
  };
  systemHealth: {
    database: string;
    uptimeSeconds: number;
    nodeVersion: string;
    timestamp: string;
  };
}

interface TenantBusinessRow {
  id: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  country: string;
  currency: string;
  status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
  createdAt: string;
  planCode: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  routerCount: number;
  locationCount: number;
  customerCount: number;
  wifiRevenueTzs: number;
}

interface SaasPlanRow {
  id: string;
  code: string;
  name: string;
  priceMonthlyTzs: number;
  priceYearlyTzs: number;
  maxRouters: number;
  maxLocations: number;
  maxActiveCustomers: number;
  commissionBps: number;
  isActive: number;
}

interface SaasPaymentRow {
  id: string;
  reference: string;
  amountTzs: number;
  provider: string;
  status: string;
  paidAt: string | null;
  createdAt: string;
  businessName: string;
  planName: string;
}

interface Props {
  token: string;
  refreshTrigger: number;
  activeTenantId: string | null;
  onSelectTenant: (businessId: string, businessName: string) => void;
}

export function SuperAdminView({ token, refreshTrigger, activeTenantId, onSelectTenant }: Props) {
  const [subTab, setSubTab] = useState<'businesses' | 'plans' | 'billing' | 'health'>('businesses');
  const [overview, setOverview] = useState<PlatformOverview | null>(null);
  const [businesses, setBusinesses] = useState<TenantBusinessRow[]>([]);
  const [plans, setPlans] = useState<SaasPlanRow[]>([]);
  const [saasPayments, setSaasPayments] = useState<SaasPaymentRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [priceMonthlyTzs, setPriceMonthlyTzs] = useState('75000');
  const [priceYearlyTzs, setPriceYearlyTzs] = useState('750000');
  const [maxRouters, setMaxRouters] = useState('15');
  const [maxLocations, setMaxLocations] = useState('8');
  const [maxActiveCustomers, setMaxActiveCustomers] = useState('3000');
  const [commissionBps, setCommissionBps] = useState('100');
  const [savingPlan, setSavingPlan] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [ov, bz, pl, pay] = await Promise.all([
        apiRequest<PlatformOverview>('/api/superadmin/overview', { token }),
        apiRequest<{ businesses: TenantBusinessRow[] }>('/api/superadmin/businesses', { token }),
        apiRequest<{ plans: SaasPlanRow[] }>('/api/superadmin/plans', { token }),
        apiRequest<{ saasPayments: SaasPaymentRow[] }>('/api/superadmin/saas-payments', { token }),
      ]);
      setOverview(ov);
      setBusinesses(bz.businesses);
      setPlans(pl.plans);
      setSaasPayments(pay.saasPayments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load TRAX LINK platform metrics');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, [token, refreshTrigger]);

  const updateBusinessStatus = async (id: string, status: 'ACTIVE' | 'SUSPENDED') => {
    try {
      setError(null);
      await apiRequest(`/api/superadmin/businesses/${id}/status`, {
        method: 'PATCH',
        token,
        body: { status },
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update business status');
    }
  };

  const handleCreatePlan = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingPlan(true);
    setError(null);
    try {
      await apiRequest('/api/superadmin/plans', {
        method: 'POST',
        token,
        body: {
          code: code.trim().toUpperCase(),
          name: name.trim(),
          priceMonthlyTzs: Number(priceMonthlyTzs),
          priceYearlyTzs: Number(priceYearlyTzs),
          maxRouters: Number(maxRouters),
          maxLocations: Number(maxLocations),
          maxActiveCustomers: Number(maxActiveCustomers),
          commissionBps: Number(commissionBps),
        },
      });
      setPlanModalOpen(false);
      setCode('');
      setName('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create SaaS plan');
    } finally {
      setSavingPlan(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* KPI Metrics Row */}
      {overview && (
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Registered Businesses</p>
            <p className="text-2xl font-bold tabular-nums mt-2">{overview.stats.totalBusinesses}</p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 tabular-nums">
              {overview.stats.activeBusinesses} active · {overview.stats.suspendedBusinesses} suspended · {overview.stats.pendingBusinesses} pending
            </p>
          </div>

          <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Platform SaaS Revenue</p>
            <p className="text-2xl font-bold tabular-nums mt-2 text-[#B8860B] dark:text-[#FFD400]">
              {formatTzs(overview.stats.saasRevenueTzs)}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 tabular-nums">
              {overview.stats.activeSaasSubscriptions} active workspace subscriptions
            </p>
          </div>

          <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Tenant WiFi Ledger Volume</p>
            <p className="text-2xl font-bold tabular-nums mt-2">
              {formatTzs(overview.stats.totalWifiRevenueTzs)}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 tabular-nums">
              {overview.stats.totalCustomers} subscriber profiles across tenants
            </p>
          </div>

          <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800">
            <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">Connected Routers & Queue</p>
            <p className="text-2xl font-bold tabular-nums mt-2">
              {overview.stats.onlineRouters} / {overview.stats.totalRouters}
            </p>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 tabular-nums">
              {overview.stats.offlineRouters} offline · {overview.stats.retryingProvisioningJobs} retrying jobs
            </p>
          </div>
        </div>
      )}

      {/* Sub-navigation & Actions */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="btn-tab-group overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setSubTab('businesses')}
            className={subTab === 'businesses' ? 'btn-tab-active' : 'btn-tab'}
          >
            Businesses ({businesses.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('plans')}
            className={subTab === 'plans' ? 'btn-tab-active' : 'btn-tab'}
          >
            SaaS Plans ({plans.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('billing')}
            className={subTab === 'billing' ? 'btn-tab-active' : 'btn-tab'}
          >
            SaaS Ledger ({saasPayments.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('health')}
            className={subTab === 'health' ? 'btn-tab-active' : 'btn-tab'}
          >
            System Health
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={loadAll} className="btn-secondary text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          {subTab === 'plans' && (
            <button type="button" onClick={() => setPlanModalOpen(true)} className="btn-primary text-xs">
              <Plus className="w-4 h-4" />
              Create SaaS Plan
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-xs text-zinc-500">Loading platform administration data...</div>
      ) : subTab === 'businesses' ? (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-stone-200 dark:border-zinc-800 text-zinc-500 dark:text-zinc-400">
              <tr>
                <th className="py-3 px-4 font-medium">Business Workspace</th>
                <th className="py-3 px-4 font-medium">SaaS Plan</th>
                <th className="py-3 px-4 font-medium text-right">Sites / Routers / Users</th>
                <th className="py-3 px-4 font-medium text-right">WiFi Revenue</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stone-100 dark:divide-zinc-800/80">
              {businesses.map((b) => {
                const isSelected = activeTenantId === b.id;
                return (
                  <tr key={b.id} className="hover:bg-stone-50 dark:hover:bg-[#1C1C1F]">
                    <td className="py-3 px-4">
                      <div className="font-semibold flex items-center gap-1.5">
                        <Building2 className="w-3.5 h-3.5 text-[#B8860B] dark:text-[#FFD400] shrink-0" />
                        <span>{b.name}</span>
                        {isSelected && (
                          <span className="text-[10px] font-mono text-[#B8860B] dark:text-[#FFD400]">
                            · Inspecting
                          </span>
                        )}
                      </div>
                      <div className="font-mono text-zinc-500 dark:text-zinc-400 mt-0.5">
                        {b.email} · {b.phone} · {b.country}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-medium">{b.planName || 'Unassigned'}</div>
                      <div className="font-mono text-zinc-500 dark:text-zinc-400">
                        {b.planCode || '—'} · {b.subscriptionStatus || 'NONE'}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">
                      {b.locationCount} / {b.routerCount} / {b.customerCount}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                      {formatTzs(b.wifiRevenueTzs)}
                    </td>
                    <td className="py-3 px-4 font-mono">
                      <span
                        className={
                          b.status === 'ACTIVE'
                            ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                            : b.status === 'SUSPENDED'
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : 'text-amber-600 dark:text-amber-400 font-semibold'
                        }
                      >
                        {b.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => onSelectTenant(b.id, b.name)}
                          className="btn-chip-accent"
                        >
                          Enter Workspace
                          <ArrowRight className="w-3 h-3" />
                        </button>
                        {b.status !== 'ACTIVE' ? (
                          <button
                            type="button"
                            onClick={() => updateBusinessStatus(b.id, 'ACTIVE')}
                            className="btn-chip-neutral"
                          >
                            Approve / Activate
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => updateBusinessStatus(b.id, 'SUSPENDED')}
                            className="btn-chip-danger"
                          >
                            Suspend
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : subTab === 'plans' ? (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {plans.map((p) => (
            <div
              key={p.id}
              className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 space-y-4"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-mono text-zinc-500 dark:text-zinc-400">
                    {p.code} · {p.isActive ? 'ACTIVE' : 'INACTIVE'}
                  </p>
                  <h3 className="text-base font-bold mt-0.5">{p.name}</h3>
                </div>
                <p className="font-mono font-bold text-base tabular-nums text-[#B8860B] dark:text-[#FFD400]">
                  {formatTzs(p.priceMonthlyTzs)}/mo
                </p>
              </div>
              <div className="pt-3 border-t border-stone-100 dark:border-zinc-800 grid grid-cols-2 gap-2 text-xs tabular-nums">
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Yearly: </span>
                  <span className="font-mono font-medium">{formatTzs(p.priceYearlyTzs)}</span>
                </div>
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Routers Limit: </span>
                  <span className="font-mono font-medium">{p.maxRouters}</span>
                </div>
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Sites Limit: </span>
                  <span className="font-mono font-medium">{p.maxLocations}</span>
                </div>
                <div>
                  <span className="text-zinc-500 dark:text-zinc-400">Subscribers: </span>
                  <span className="font-mono font-medium">{p.maxActiveCustomers}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : subTab === 'billing' ? (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl overflow-x-auto">
          {saasPayments.length === 0 ? (
            <div className="p-8 text-center text-xs text-zinc-500">
              No SaaS subscription checkout invoices recorded yet.
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-stone-200 dark:border-zinc-800 text-zinc-500">
                <tr>
                  <th className="py-3 px-4 font-medium">Reference</th>
                  <th className="py-3 px-4 font-medium">Business</th>
                  <th className="py-3 px-4 font-medium">Plan</th>
                  <th className="py-3 px-4 font-medium">Provider</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-zinc-800 font-mono tabular-nums">
                {saasPayments.map((sp) => (
                  <tr key={sp.id}>
                    <td className="py-3 px-4 font-semibold">{sp.reference}</td>
                    <td className="py-3 px-4 font-sans font-medium">{sp.businessName}</td>
                    <td className="py-3 px-4 font-sans">{sp.planName}</td>
                    <td className="py-3 px-4">{sp.provider}</td>
                    <td className="py-3 px-4 text-right font-semibold">{formatTzs(sp.amountTzs)}</td>
                    <td className="py-3 px-4 text-emerald-600 dark:text-emerald-400 font-semibold">{sp.status}</td>
                    <td className="py-3 px-4 text-zinc-500">{new Date(sp.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        overview && (
          <div className="p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
            <div>
              <span className="text-zinc-500 dark:text-zinc-400 block">Database Engine</span>
              <span className="font-mono font-semibold text-sm text-emerald-600 dark:text-emerald-400">
                {overview.systemHealth.database} (SQLite WAL + Prisma Schema)
              </span>
            </div>
            <div>
              <span className="text-zinc-500 dark:text-zinc-400 block">API Process Uptime</span>
              <span className="font-mono font-semibold text-sm tabular-nums">
                {overview.systemHealth.uptimeSeconds}s
              </span>
            </div>
            <div>
              <span className="text-zinc-500 dark:text-zinc-400 block">Node Runtime</span>
              <span className="font-mono font-semibold text-sm">{overview.systemHealth.nodeVersion}</span>
            </div>
            <div>
              <span className="text-zinc-500 dark:text-zinc-400 block">Server Timestamp</span>
              <span className="font-mono font-semibold text-sm tabular-nums">
                {new Date(overview.systemHealth.timestamp).toLocaleString()}
              </span>
            </div>
          </div>
        )
      )}

      {planModalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Create SaaS Plan</h3>
              <button
                type="button"
                onClick={() => setPlanModalOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreatePlan} className="space-y-3 text-xs">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-medium mb-1">Plan Code</label>
                  <input
                    type="text"
                    required
                    value={code}
                    onChange={(e) => setCode(e.target.value.toUpperCase())}
                    placeholder="PRO_ISP"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="Pro ISP Tier"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-medium mb-1">Monthly (TZS)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={priceMonthlyTzs}
                    onChange={(e) => setPriceMonthlyTzs(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Yearly (TZS)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={priceYearlyTzs}
                    onChange={(e) => setPriceYearlyTzs(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Max Routers</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={maxRouters}
                    onChange={(e) => setMaxRouters(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Max Locations</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={maxLocations}
                    onChange={(e) => setMaxLocations(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Max Customers</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={maxActiveCustomers}
                    onChange={(e) => setMaxActiveCustomers(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Commission (BPS)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={commissionBps}
                    onChange={(e) => setCommissionBps(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setPlanModalOpen(false)} className="btn-secondary text-xs">
                  Cancel
                </button>
                <button type="submit" disabled={savingPlan} className="btn-primary text-xs">
                  {savingPlan ? 'Creating...' : 'Save Plan'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
