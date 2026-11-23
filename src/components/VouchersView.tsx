import React, { useEffect, useState } from 'react';
import { Download, FileText, Plus, Printer, Search, X } from 'lucide-react';
import { apiRequest, formatDurationMinutes, formatTzs } from '../lib/api.ts';
import { exportVouchersPdf } from '../lib/pdfExport.ts';

interface VoucherItem {
  id: string;
  code: string | null;
  codeMasked: string;
  batchId: string | null;
  packageId: string;
  packageName: string;
  priceTzs: number;
  durationMinutes: number;
  status: 'UNUSED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED';
  isTest?: boolean;
  testNote?: string | null;
  boundDeviceName?: string | null;
  customerName: string | null;
  activatedAt: string | null;
  expiresAt: string | null;
  revokedReason: string | null;
  createdAt: string;
}

interface RedemptionLog {
  id: string;
  ipAddress: string | null;
  success: number;
  reason: string | null;
  redeemedAt: string;
  deviceLabel: string | null;
  deviceFingerprint: string;
}

interface Props {
  token: string;
  refreshTrigger: number;
  canGenerate: boolean;
  canRevoke: boolean;
}

export function VouchersView({ token, refreshTrigger, canGenerate, canRevoke }: Props) {
  const [vouchers, setVouchers] = useState<VoucherItem[]>([]);
  const [packages, setPackages] = useState<Array<{ id: string; name: string; priceTzs: number }>>([]);
  const [customers, setCustomers] = useState<Array<{ id: string; full_name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'UNUSED' | 'ACTIVE' | 'EXPIRED' | 'REVOKED'>('ALL');
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [genOpen, setGenOpen] = useState(false);
  const [packageId, setPackageId] = useState('');
  const [customerId, setCustomerId] = useState('');
  const [count, setCount] = useState('10');
  const [isTest, setIsTest] = useState(false);
  const [testNote, setTestNote] = useState('');
  const [generating, setGenerating] = useState(false);

  const [redemptionsModal, setRedemptionsModal] = useState<{
    voucher: VoucherItem;
    logs: RedemptionLog[];
  } | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [vRes, pRes, cRes] = await Promise.all([
        apiRequest<{ vouchers: VoucherItem[] }>(
          `/api/vouchers?status=${statusFilter}&q=${encodeURIComponent(search)}`,
          { token }
        ),
        apiRequest<{ packages: Array<{ id: string; name: string; priceTzs: number }> }>('/api/packages', { token }),
        apiRequest<{ customers: Array<{ id: string; full_name: string }> }>('/api/customers', { token }),
      ]);
      setVouchers(vRes.vouchers);
      setPackages(pRes.packages);
      setCustomers(cRes.customers);
      if (pRes.packages.length > 0 && !packageId) {
        setPackageId(pRes.packages[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vouchers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, statusFilter, refreshTrigger]);

  const handleGenerate = async (e: React.FormEvent) => {
    e.preventDefault();
    setGenerating(true);
    setError(null);
    try {
      await apiRequest('/api/vouchers/generate', {
        method: 'POST',
        token,
        body: {
          packageId,
          count: Number(count),
          customerId: customerId || null,
          isTest,
          ...(isTest && testNote.trim() ? { testNote: testNote.trim() } : {}),
        },
      });
      setGenOpen(false);
      setIsTest(false);
      setTestNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate vouchers');
    } finally {
      setGenerating(false);
    }
  };

  const handleRevoke = async (v: VoucherItem) => {
    try {
      await apiRequest(`/api/vouchers/${v.id}/revoke`, {
        method: 'POST',
        token,
        body: { reason: 'Administrative revocation' },
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke voucher');
    }
  };

  const openHistory = async (v: VoucherItem) => {
    try {
      const res = await apiRequest<{ redemptions: RedemptionLog[] }>(`/api/vouchers/${v.id}/redemptions`, {
        token,
      });
      setRedemptionsModal({ voucher: v, logs: res.redemptions });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load redemption history');
    }
  };

  const handleDownloadCsv = async () => {
    try {
      setError(null);
      const res = await fetch(`/api/vouchers/export/csv?status=${statusFilter}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error || `Export failed (${res.status})`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'netco-vouchers.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to export vouchers CSV');
    }
  };

  return (
    <div className="space-y-5">
      <div className="no-print flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void load();
            }}
            className="relative w-full sm:w-auto sm:min-w-[200px]"
          >
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search batch, package, masked code..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-[#101827] focus:outline-none focus:border-[#16B8FF]"
            />
          </form>

          <div className="btn-tab-group max-w-full overflow-x-auto">
            {(['ALL', 'UNUSED', 'ACTIVE', 'EXPIRED', 'REVOKED'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={statusFilter === s ? 'btn-tab-active' : 'btn-tab'}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => window.print()}
            className="btn-secondary text-xs"
          >
            <Printer className="w-3.5 h-3.5" />
            Print
          </button>
          <button
            type="button"
            onClick={handleDownloadCsv}
            className="btn-secondary text-xs"
          >
            <Download className="w-3.5 h-3.5" />
            CSV
          </button>
          <button
            type="button"
            onClick={() => exportVouchersPdf(vouchers)}
            className="btn-secondary text-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            PDF
          </button>
          {canGenerate && (
            <button
              type="button"
              onClick={() => setGenOpen(true)}
              className="btn-primary text-xs"
            >
              <Plus className="w-4 h-4" />
              Generate Vouchers
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Printable Voucher Sheet (hidden on screen unless printing, or standard table on screen) */}
      <div className="hidden print-only space-y-4">
        <h2 className="text-lg font-bold">NETCO WiFi Vouchers</h2>
        <div className="grid grid-cols-3 gap-3">
          {vouchers.filter((v) => v.status === 'UNUSED').map((v) => (
            <div key={v.id} className="border border-black p-3 rounded">
              <div className="text-xs font-bold">NETCO HOTSPOT</div>
              <div className="font-mono text-base font-bold my-1">{v.code || v.codeMasked}</div>
              <div className="text-[11px]">
                {v.packageName} · {formatTzs(v.priceTzs)} · 1 Device
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="no-print bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading vouchers...</div>
        ) : vouchers.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-medium">No vouchers match this filter</p>
            <p className="text-xs text-slate-500 dark:text-[#8793A5]">
              Generate single or batch vouchers assigned to a WiFi package.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-[#8793A5]">
                <tr>
                  <th className="py-3 px-4 font-medium">Voucher Code</th>
                  <th className="py-3 px-4 font-medium">Package</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Batch / Customer</th>
                  <th className="py-3 px-4 font-medium">Expires</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {vouchers.map((v) => (
                  <tr key={v.id} className="hover:bg-slate-50 dark:hover:bg-[#080B12]/50">
                    <td className="py-3 px-4 font-mono font-semibold">
                      <div>{v.code || v.codeMasked}</div>
                      {v.isTest && (
                        <span className="inline-block mt-1 px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold">
                          TEST / DEV ONLY
                        </span>
                      )}
                    </td>
                    <td className="py-3 px-4">
                      <div>{v.packageName}</div>
                      <div className="text-slate-500 dark:text-[#8793A5] tabular-nums">
                        {formatTzs(v.priceTzs)} · {formatDurationMinutes(v.durationMinutes)}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono">
                      <span
                        className={
                          v.status === 'ACTIVE'
                            ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                            : v.status === 'UNUSED'
                            ? 'text-[#0284C7] dark:text-[#16B8FF] font-semibold'
                            : v.status === 'REVOKED'
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : 'text-slate-500 dark:text-[#8793A5]'
                        }
                      >
                        {v.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-slate-600 dark:text-[#8793A5]">
                      <div>{v.customerName || v.batchId || 'Single Issue'}</div>
                      {v.boundDeviceName && (
                        <div className="text-[11px] font-mono text-[#0284C7] dark:text-[#16B8FF]">
                          Locked: {v.boundDeviceName}
                        </div>
                      )}
                      {v.testNote && (
                        <div className="text-[11px] text-amber-600 dark:text-amber-400">{v.testNote}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-[#8793A5]">
                      {v.expiresAt ? new Date(v.expiresAt).toLocaleString() : 'On first login'}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openHistory(v)}
                          className="btn-chip-accent"
                        >
                          History
                        </button>
                        {canRevoke && (v.status === 'UNUSED' || v.status === 'ACTIVE') && (
                          <button
                            type="button"
                            onClick={() => handleRevoke(v)}
                            className="btn-chip-danger"
                          >
                            Revoke
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Generate Batch Modal */}
      {genOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Generate Vouchers</h3>
              <button
                type="button"
                onClick={() => setGenOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleGenerate} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-medium mb-1">Assign Package</label>
                <select
                  required
                  value={packageId}
                  onChange={(e) => setPackageId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12]"
                >
                  {packages.length === 0 && <option value="">Create a package first</option>}
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({formatTzs(p.priceTzs)})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Quantity (1–500)</label>
                <input
                  type="number"
                  min={1}
                  max={500}
                  required
                  value={count}
                  onChange={(e) => setCount(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Assign to Customer (Optional)</label>
                <select
                  value={customerId}
                  onChange={(e) => setCustomerId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12]"
                >
                  <option value="">Walk-in / General Batch</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.full_name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="p-3 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-2">
                <label className="flex items-center gap-2 cursor-pointer font-medium text-amber-800 dark:text-amber-300">
                  <input
                    type="checkbox"
                    checked={isTest}
                    onChange={(e) => setIsTest(e.target.checked)}
                  />
                  <span>Issue Test Voucher (Development Only — Not Paid Revenue)</span>
                </label>
                {isTest && (
                  <input
                    type="text"
                    value={testNote}
                    onChange={(e) => setTestNote(e.target.value)}
                    placeholder="Optional test note (e.g. Airtel Pocket WiFi QA)"
                    className="w-full px-3 py-1.5 rounded-lg border border-amber-500/30 bg-white dark:bg-[#080B12] text-xs"
                  />
                )}
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setGenOpen(false)}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={generating || !packageId}
                  className="btn-primary text-xs"
                >
                  {generating ? 'Generating...' : 'Generate'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Redemption History Modal */}
      {redemptionsModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold">Voucher Redemption History</h3>
                <p className="text-xs font-mono text-slate-500 dark:text-[#8793A5]">
                  {redemptionsModal.voucher.code || redemptionsModal.voucher.codeMasked}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setRedemptionsModal(null)}
                aria-label="Close history modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {redemptionsModal.logs.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5] py-6 text-center">
                This voucher has no redemption attempts yet.
              </p>
            ) : (
              <div className="divide-y divide-slate-100 dark:divide-slate-800 max-h-72 overflow-y-auto text-xs">
                {redemptionsModal.logs.map((l) => (
                  <div key={l.id} className="py-2.5 flex items-start justify-between gap-3">
                    <div>
                      <p className={l.success ? 'text-emerald-500 font-medium' : 'text-red-400 font-medium'}>
                        {l.success ? 'Allowed' : 'Blocked'} · {l.reason}
                      </p>
                      <p className="text-slate-500 dark:text-[#8793A5] font-mono">
                        {l.deviceLabel || l.deviceFingerprint} · IP {l.ipAddress || 'N/A'}
                      </p>
                    </div>
                    <span className="font-mono text-[11px] text-slate-500 shrink-0">
                      {new Date(l.redeemedAt).toLocaleString()}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
