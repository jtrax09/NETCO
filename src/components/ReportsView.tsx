import React, { useEffect, useState } from 'react';
import { Download, FileText } from 'lucide-react';
import { apiRequest, formatBytes, formatTzs } from '../lib/api.ts';
import { exportReportPdf } from '../lib/pdfExport.ts';

interface ReportOverview {
  revenueByProvider: Array<{ provider: string; txCount: number; totalTzs: number }>;
  testSummary?: {
    testVouchersCount: number;
    testTokensIssued: number;
    testNominalTzs: number;
  };
  packageSales: Array<{
    packageName: string;
    category: string;
    unitPriceTzs: number;
    vouchersIssued: number;
    vouchersRedeemed: number;
  }>;
  sessionStats: Array<{
    status: string;
    count: number;
    totalRxBytes: number;
    totalTxBytes: number;
  }>;
}

interface Props {
  token: string;
}

export function ReportsView({ token }: Props) {
  const [data, setData] = useState<ReportOverview | null>(null);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const fromIso = fromDate ? `${fromDate}T00:00:00.000Z` : '';
      const toIso = toDate ? `${toDate}T23:59:59.999Z` : '';
      const res = await apiRequest<ReportOverview>(
        `/api/reports/overview?from=${encodeURIComponent(fromIso)}&to=${encodeURIComponent(toIso)}`,
        { token }
      );
      setData(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load reports');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const downloadCsv = async (type: 'payments' | 'sessions') => {
    try {
      setError(null);
      const res = await fetch(`/api/reports/export/csv?type=${type}`, {
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
      a.download = `netco-${type}-report.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to export report CSV');
    }
  };

  const handleExportPdf = () => {
    if (!data) return;
    exportReportPdf({
      title: 'Operational Sales & Revenue Report',
      subtitle: fromDate || toDate ? `Range: ${fromDate || 'Start'} to ${toDate || 'Now'}` : 'All Time',
      headers: ['Package', 'Category', 'Price (TZS)', 'Issued', 'Redeemed'],
      rows: data.packageSales.map((p) => [
        p.packageName,
        p.category,
        String(p.unitPriceTzs),
        String(p.vouchersIssued),
        String(p.vouchersRedeemed),
      ]),
      filename: 'netco-sales-report.pdf',
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4 bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl p-4">
        <div className="flex flex-wrap items-end gap-3 text-xs w-full sm:w-auto">
          <div className="flex-1 sm:flex-initial min-w-[130px]">
            <label className="block text-slate-500 dark:text-[#8793A5] mb-1">From Date</label>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
            />
          </div>
          <div className="flex-1 sm:flex-initial min-w-[130px]">
            <label className="block text-slate-500 dark:text-[#8793A5] mb-1">To Date</label>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
            />
          </div>
          <button
            type="button"
            onClick={load}
            className="btn-primary min-h-[38px] text-xs w-full sm:w-auto"
          >
            Apply Filter
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            onClick={() => downloadCsv('payments')}
            className="btn-secondary text-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Payments CSV
          </button>
          <button
            type="button"
            onClick={() => downloadCsv('sessions')}
            className="btn-secondary text-xs"
          >
            <Download className="w-3.5 h-3.5" />
            Sessions CSV
          </button>
          <button
            type="button"
            onClick={handleExportPdf}
            className="btn-secondary text-xs"
          >
            <FileText className="w-3.5 h-3.5" />
            Export PDF
          </button>
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading || !data ? (
        <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Building reports...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="p-5 rounded-xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-sm font-semibold">Verified Revenue by Mobile Money Provider</h3>
            {data.revenueByProvider.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5] py-6 text-center">
                No verified live provider payments in selected period.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <tr>
                    <th className="py-2">Provider</th>
                    <th className="py-2 text-right">Transactions</th>
                    <th className="py-2 text-right">Revenue</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono tabular-nums">
                  {data.revenueByProvider.map((r) => (
                    <tr key={r.provider}>
                      <td className="py-2.5">{r.provider.replace('_', ' ')}</td>
                      <td className="py-2.5 text-right">{r.txCount}</td>
                      <td className="py-2.5 text-right font-semibold">{formatTzs(r.totalTzs)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {data.testSummary && (data.testSummary.testVouchersCount > 0 || data.testSummary.testTokensIssued > 0) && (
              <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[11px] text-amber-800 dark:text-amber-300">
                Test / Standalone Tokens Excluded from Real Revenue: {data.testSummary.testTokensIssued} standalone token checkouts ({formatTzs(data.testSummary.testNominalTzs)} nominal), {data.testSummary.testVouchersCount} test vouchers.
              </div>
            )}
          </div>

          <div className="p-5 rounded-xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-sm font-semibold">Session & Traffic Summary</h3>
            {data.sessionStats.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5] py-6 text-center">
                No sessions recorded in selected period.
              </p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <tr>
                    <th className="py-2">Status</th>
                    <th className="py-2 text-right">Sessions</th>
                    <th className="py-2 text-right">Total Traffic</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono tabular-nums">
                  {data.sessionStats.map((s) => (
                    <tr key={s.status}>
                      <td className="py-2.5">{s.status}</td>
                      <td className="py-2.5 text-right">{s.count}</td>
                      <td className="py-2.5 text-right">{formatBytes(s.totalRxBytes + s.totalTxBytes)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="lg:col-span-2 p-5 rounded-xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 space-y-3">
            <h3 className="text-sm font-semibold">Package Sales & Voucher Redemptions</h3>
            {data.packageSales.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5] py-6 text-center">No package sales data yet.</p>
            ) : (
              <table className="w-full text-left text-xs">
                <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
                  <tr>
                    <th className="py-2">Package</th>
                    <th className="py-2">Cadence</th>
                    <th className="py-2 text-right">Unit Price</th>
                    <th className="py-2 text-right">Vouchers Issued</th>
                    <th className="py-2 text-right">Redeemed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-slate-800 tabular-nums">
                  {data.packageSales.map((p) => (
                    <tr key={p.packageName}>
                      <td className="py-2.5 font-medium">{p.packageName}</td>
                      <td className="py-2.5 font-mono">{p.category}</td>
                      <td className="py-2.5 text-right font-mono">{formatTzs(p.unitPriceTzs)}</td>
                      <td className="py-2.5 text-right font-mono">{p.vouchersIssued}</td>
                      <td className="py-2.5 text-right font-mono">{p.vouchersRedeemed || 0}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
