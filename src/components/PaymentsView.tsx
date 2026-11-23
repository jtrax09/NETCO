import React, { useEffect, useState } from 'react';
import { Receipt, RotateCcw, X } from 'lucide-react';
import { apiRequest, formatTzs } from '../lib/api.ts';
import { getProviderBrand } from '../lib/paymentProviders.ts';

interface ProviderStatus {
  provider: string;
  displayName: string;
  configured: boolean;
  missingCredentials: string[];
  webhookPath: string;
}

interface PaymentItem {
  id: string;
  reference: string;
  receiptNumber: string | null;
  provider: string;
  phoneNumber: string;
  amountTzs: number;
  status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED';
  isTest?: boolean;
  paymentMode?: string;
  externalTxId: string | null;
  verifiedAt: string | null;
  refundedAt: string | null;
  createdAt: string;
  packageName: string;
  voucherMasked: string | null;
  customerName: string | null;
}

interface Props {
  token: string;
  refreshTrigger: number;
  canRefund: boolean;
}

export function PaymentsView({ token, refreshTrigger, canRefund }: Props) {
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED'>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [receiptModal, setReceiptModal] = useState<PaymentItem | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [provRes, payRes] = await Promise.all([
        apiRequest<{ providers: ProviderStatus[] }>('/api/payments/providers', { token }),
        apiRequest<{ payments: PaymentItem[] }>(`/api/payments?status=${statusFilter}`, { token }),
      ]);
      setProviders(provRes.providers);
      setPayments(payRes.payments);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payments');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, statusFilter, refreshTrigger]);

  const handleRefund = async (p: PaymentItem) => {
    try {
      await apiRequest(`/api/payments/${p.id}/refund`, { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to mark refunded');
    }
  };

  return (
    <div className="space-y-6">
      {/* Mobile Money Provider Status Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {providers.map((prov) => {
          const brand = getProviderBrand(prov.provider);
          return (
            <div
              key={prov.provider}
              className="p-4 rounded-xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  {brand && (
                    <span className="w-10 h-9 rounded-lg bg-transparent overflow-hidden flex items-center justify-center shrink-0">
                      <img
                        src={brand.logoUrl}
                        alt={brand.alt}
                        className="w-full h-full object-contain"
                      />
                    </span>
                  )}
                  <span className="text-xs font-semibold truncate">{brand?.label || prov.displayName}</span>
                </div>
                <span
                  className={
                    prov.configured
                      ? 'text-[10px] font-mono text-emerald-600 dark:text-emerald-400 font-semibold shrink-0'
                      : 'text-[10px] font-mono text-amber-600 dark:text-amber-400 font-semibold shrink-0'
                  }
                >
                  {prov.configured ? 'CONFIGURED' : 'INTEGRATION READY'}
                </span>
              </div>
              <p className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] break-all">
                Webhook: {prov.webhookPath}
              </p>
              {!prov.configured && (
                <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
                  Missing env: {prov.missingCredentials.join(', ')}
                </p>
              )}
            </div>
          );
        })}
      </div>

      {/* Filter */}
      <div className="btn-tab-group w-fit overflow-x-auto">
        {(['ALL', 'PENDING', 'COMPLETED', 'FAILED', 'REFUNDED'] as const).map((s) => (
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

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading payments...</div>
        ) : payments.length === 0 ? (
          <div className="p-10 text-center space-y-1.5">
            <p className="text-sm font-medium">No mobile money transactions yet</p>
            <p className="text-xs text-slate-500 dark:text-[#8793A5]">
              Customer payment initiations from the captive portal and verified provider webhook callbacks appear here.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-[#8793A5]">
                <tr>
                  <th className="py-3 px-4 font-medium">Reference / Receipt</th>
                  <th className="py-3 px-4 font-medium">Provider & Phone</th>
                  <th className="py-3 px-4 font-medium">Package</th>
                  <th className="py-3 px-4 font-medium text-right">Amount</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {payments.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50 dark:hover:bg-[#080B12]/50">
                    <td className="py-3 px-4">
                      <div className="font-mono font-medium">{p.reference}</div>
                      <div className="font-mono text-slate-500 dark:text-[#8793A5]">
                        {p.receiptNumber || 'Awaiting verification'}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="flex items-center gap-2">
                        {(() => {
                          const brand = getProviderBrand(p.provider);
                          return brand ? (
                            <span className="w-7 h-6 rounded-md bg-transparent overflow-hidden flex items-center justify-center shrink-0">
                              <img src={brand.logoUrl} alt={brand.alt} className="w-full h-full object-contain" />
                            </span>
                          ) : null;
                        })()}
                        <div>
                          <div>{getProviderBrand(p.provider)?.label || p.provider.replace('_', ' ')}</div>
                          <div className="font-mono text-slate-500 dark:text-[#8793A5]">{p.phoneNumber}</div>
                        </div>
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div>{p.packageName}</div>
                      {p.voucherMasked && (
                        <div className="font-mono text-slate-500 dark:text-[#8793A5]">{p.voucherMasked}</div>
                      )}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                      {formatTzs(p.amountTzs)}
                    </td>
                    <td className="py-3 px-4 font-mono">
                      <div className="flex flex-col gap-1">
                        <span
                          className={
                            p.status === 'COMPLETED'
                              ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                              : p.status === 'PENDING'
                              ? 'text-amber-600 dark:text-amber-400 font-semibold'
                              : 'text-red-600 dark:text-red-400 font-semibold'
                          }
                        >
                          {p.status}
                        </span>
                        {p.isTest && (
                          <span className="inline-block w-fit px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold">
                            TEST / STANDALONE
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => setReceiptModal(p)}
                          className="btn-chip-accent"
                        >
                          <Receipt className="w-3.5 h-3.5" />
                          Receipt
                        </button>
                        {canRefund && p.status === 'COMPLETED' && (
                          <button
                            type="button"
                            onClick={() => handleRefund(p)}
                            className="btn-chip-danger"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Refund
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

      {receiptModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">NETCO Payment Receipt</h3>
              <button
                type="button"
                onClick={() => setReceiptModal(null)}
                aria-label="Close receipt modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 rounded-lg bg-slate-50 dark:bg-[#080B12] border border-slate-200 dark:border-slate-800 space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Reference</span>
                <span>{receiptModal.reference}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Receipt No</span>
                <span>{receiptModal.receiptNumber || 'Pending'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Provider</span>
                <span>{receiptModal.provider}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">MSISDN</span>
                <span>{receiptModal.phoneNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Plan</span>
                <span>{receiptModal.packageName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Verification</span>
                <span>{receiptModal.isTest ? 'TEST / STANDALONE (Not Real Revenue)' : 'LIVE PROVIDER WEBHOOK'}</span>
              </div>
              <div className="flex justify-between font-bold text-sm pt-2 border-t border-slate-200 dark:border-slate-800">
                <span>Total</span>
                <span>{formatTzs(receiptModal.amountTzs)}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => window.print()}
                className="btn-primary text-xs"
              >
                Print Receipt
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
