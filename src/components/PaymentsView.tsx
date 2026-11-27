import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { CheckCircle2, CreditCard, FileText, Receipt, RotateCcw, X } from 'lucide-react';
import { apiRequest, formatTzs } from '../lib/api.ts';
import { getProviderBrand } from '../lib/paymentProviders.ts';
import { MobileModal, MobilePageTransition } from './ui/MotionPrimitives.tsx';

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

interface InvoiceItem {
  id: string;
  invoiceNumber: string;
  ledgerType: string;
  paymentReference: string;
  customerName: string | null;
  phoneNumber: string | null;
  itemDescription: string;
  subtotalTzs: number;
  taxTzs: number;
  totalTzs: number;
  currency: string;
  isTest: boolean;
  status: string;
  issuedAt: string;
}

interface Props {
  token: string;
  refreshTrigger: number;
  canRefund: boolean;
}

export function PaymentsView({ token, refreshTrigger, canRefund }: Props) {
  const [subTab, setSubTab] = useState<'transactions' | 'invoices'>('transactions');
  const [providers, setProviders] = useState<ProviderStatus[]>([]);
  const [payments, setPayments] = useState<PaymentItem[]>([]);
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'PENDING' | 'COMPLETED' | 'FAILED' | 'REFUNDED'>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [receiptModal, setReceiptModal] = useState<PaymentItem | null>(null);
  const [invoiceModal, setInvoiceModal] = useState<InvoiceItem | null>(null);
  const [reconcileTarget, setReconcileTarget] = useState<PaymentItem | null>(null);
  const [reconcileTxId, setReconcileTxId] = useState('');
  const [reconcileNote, setReconcileNote] = useState('');
  const [reconciling, setReconciling] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const [provRes, payRes, invRes] = await Promise.all([
        apiRequest<{ providers: ProviderStatus[] }>('/api/payments/providers', { token }),
        apiRequest<{ payments: PaymentItem[] }>(`/api/payments?status=${statusFilter}`, { token }),
        apiRequest<{ invoices: InvoiceItem[] }>('/api/invoices', { token }).catch(() => ({ invoices: [] })),
      ]);
      setProviders(provRes.providers);
      setPayments(payRes.payments);
      setInvoices(invRes.invoices);
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
      setError(null);
      setNotice(null);
      await apiRequest(`/api/payments/${p.id}/refund`, { method: 'POST', token });
      setNotice(`Payment ${p.reference} marked refunded and voucher revoked.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to mark refunded');
    }
  };

  const handleReconcile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reconcileTarget) return;
    setReconciling(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ ok: boolean; outcome: { receiptNumber?: string; reference?: string } }>(
        `/api/payments/${reconcileTarget.id}/reconcile`,
        {
          method: 'POST',
          token,
          body: {
            externalTxId: reconcileTxId.trim(),
            note: reconcileNote.trim() || undefined,
          },
        }
      );
      setNotice(
        `Reconciled ${reconcileTarget.reference} (${res.outcome.receiptNumber || 'Verified'}) — voucher & invoice issued.`
      );
      setReconcileTarget(null);
      setReconcileTxId('');
      setReconcileNote('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reconcile payment');
    } finally {
      setReconciling(false);
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
              className="p-4 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-2.5"
            >
              <div className="flex items-center justify-between gap-2.5">
                <div className="flex items-center gap-2.5 min-w-0">
                  {brand && brand.logoUrl ? (
                    <span className="w-10 h-9 rounded-lg bg-transparent overflow-hidden flex items-center justify-center shrink-0">
                      <img
                        src={brand.logoUrl}
                        alt={brand.alt}
                        className="w-full h-full object-contain"
                      />
                    </span>
                  ) : (
                    <span className="w-10 h-9 rounded-lg bg-[#FFD400]/15 text-[#9A7B00] dark:text-[#FFD400] flex items-center justify-center shrink-0">
                      <CreditCard className="w-4 h-4" />
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

      {/* Ledger Switch + Status Filter */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="btn-tab-group w-fit">
          <button
            type="button"
            onClick={() => setSubTab('transactions')}
            className={subTab === 'transactions' ? 'btn-tab-active' : 'btn-tab'}
          >
            Transactions ({payments.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('invoices')}
            className={subTab === 'invoices' ? 'btn-tab-active' : 'btn-tab'}
          >
            Invoices ({invoices.length})
          </button>
        </div>

        {subTab === 'transactions' && (
          <div className="btn-tab-group w-fit overflow-x-auto max-w-full">
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
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-lg border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300">
          {notice}
        </div>
      )}

      <AnimatePresence mode="wait" initial={false}>
        <MobilePageTransition key={subTab}>
          {subTab === 'transactions' ? (
            <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl overflow-hidden">
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
                                return brand && brand.logoUrl ? (
                                  <span className="w-7 h-6 rounded-md bg-transparent overflow-hidden flex items-center justify-center shrink-0">
                                    <img src={brand.logoUrl} alt={brand.alt} className="w-full h-full object-contain" />
                                  </span>
                                ) : (
                                  <span className="w-7 h-6 rounded-md bg-[#FFD400]/15 text-[#9A7B00] dark:text-[#FFD400] flex items-center justify-center shrink-0">
                                    <CreditCard className="w-3.5 h-3.5" />
                                  </span>
                                );
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
                                <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                                  TEST / STANDALONE
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <div className="inline-flex items-center justify-end gap-1.5">
                              {canRefund && p.status === 'PENDING' && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    setReconcileTarget(p);
                                    setReconcileTxId('');
                                    setReconcileNote('');
                                  }}
                                  className="btn-chip-accent"
                                >
                                  <CheckCircle2 className="w-3.5 h-3.5" />
                                  Reconcile
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setReceiptModal(p)}
                                className="btn-chip-neutral"
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
          ) : (
            <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl overflow-hidden">
              {loading ? (
                <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading invoices...</div>
              ) : invoices.length === 0 ? (
                <div className="p-10 text-center space-y-1.5">
                  <p className="text-sm font-medium">No invoices generated yet</p>
                  <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                    Sequential TRAX LINK invoices (INV-YYYYMM-...) are automatically generated for every completed WiFi or SaaS payment.
                  </p>
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-[#8793A5]">
                      <tr>
                        <th className="py-3 px-4 font-medium">Invoice No</th>
                        <th className="py-3 px-4 font-medium">Ledger & Reference</th>
                        <th className="py-3 px-4 font-medium">Description</th>
                        <th className="py-3 px-4 font-medium text-right">Total</th>
                        <th className="py-3 px-4 font-medium">Status</th>
                        <th className="py-3 px-4 font-medium text-right">Issued</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                      {invoices.map((inv) => (
                        <tr key={inv.id} className="hover:bg-slate-50 dark:hover:bg-[#080B12]/50">
                          <td className="py-3 px-4 font-mono font-semibold">{inv.invoiceNumber}</td>
                          <td className="py-3 px-4">
                            <div className="font-mono">{inv.paymentReference}</div>
                            <div className="text-slate-500 dark:text-[#8793A5]">
                              {inv.ledgerType} {inv.phoneNumber ? `· ${inv.phoneNumber}` : ''}
                            </div>
                          </td>
                          <td className="py-3 px-4">
                            <div>{inv.itemDescription}</div>
                            {inv.isTest && (
                              <span className="text-[10px] font-mono text-amber-600 dark:text-amber-400">
                                TEST / STANDALONE
                              </span>
                            )}
                          </td>
                          <td className="py-3 px-4 text-right font-mono tabular-nums font-semibold">
                            {formatTzs(inv.totalTzs)}
                          </td>
                          <td className="py-3 px-4 font-mono">
                            <span
                              className={
                                inv.status === 'PAID' || inv.status === 'COMPLETED'
                                  ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                                  : 'text-red-600 dark:text-red-400 font-semibold'
                              }
                            >
                              {inv.status}
                            </span>
                          </td>
                          <td className="py-3 px-4 text-right whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => setInvoiceModal(inv)}
                              className="btn-chip-accent"
                            >
                              <FileText className="w-3.5 h-3.5" />
                              View
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}
        </MobilePageTransition>
      </AnimatePresence>

      {/* Receipt Modal */}
      <MobileModal
        open={Boolean(receiptModal)}
        onClose={() => setReceiptModal(null)}
        maxWidthClass="max-w-md"
        panelClassName="space-y-4"
        ariaLabel="TRAX LINK Payment Receipt"
      >
        {receiptModal && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">TRAX LINK Payment Receipt</h3>
              <button
                type="button"
                onClick={() => setReceiptModal(null)}
                aria-label="Close receipt modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Reference</span>
                <span>{receiptModal.reference}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Receipt No</span>
                <span>{receiptModal.receiptNumber || 'Pending'}</span>
              </div>
              {receiptModal.externalTxId && (
                <div className="flex justify-between">
                  <span className="text-slate-500">External Tx</span>
                  <span>{receiptModal.externalTxId}</span>
                </div>
              )}
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
                <span>{receiptModal.isTest ? 'TEST / STANDALONE (Not Real Revenue)' : 'VERIFIED PAYMENT'}</span>
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
          </>
        )}
      </MobileModal>

      {/* Invoice Modal */}
      <MobileModal
        open={Boolean(invoiceModal)}
        onClose={() => setInvoiceModal(null)}
        maxWidthClass="max-w-md"
        panelClassName="space-y-4"
        ariaLabel="TRAX LINK Invoice"
      >
        {invoiceModal && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Invoice {invoiceModal.invoiceNumber}</h3>
              <button
                type="button"
                onClick={() => setInvoiceModal(null)}
                aria-label="Close invoice modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 space-y-2 text-xs font-mono">
              <div className="flex justify-between">
                <span className="text-slate-500">Invoice Number</span>
                <span>{invoiceModal.invoiceNumber}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Payment Ref</span>
                <span>{invoiceModal.paymentReference}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Ledger</span>
                <span>{invoiceModal.ledgerType}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Item</span>
                <span className="text-right font-sans">{invoiceModal.itemDescription}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Issued At</span>
                <span>{new Date(invoiceModal.issuedAt).toLocaleString()}</span>
              </div>
              <div className="flex justify-between font-bold text-sm pt-2 border-t border-slate-200 dark:border-slate-800">
                <span>Total ({invoiceModal.currency})</span>
                <span>{formatTzs(invoiceModal.totalTzs)}</span>
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => window.print()} className="btn-primary text-xs">
                Print Invoice
              </button>
            </div>
          </>
        )}
      </MobileModal>

      {/* Payment Reconciliation Modal */}
      <MobileModal
        open={Boolean(reconcileTarget)}
        onClose={() => setReconcileTarget(null)}
        maxWidthClass="max-w-md"
        panelClassName="space-y-4"
        ariaLabel="Reconcile Pending Payment"
      >
        {reconcileTarget && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Reconcile Pending Payment</h3>
              <button
                type="button"
                onClick={() => setReconcileTarget(null)}
                aria-label="Close reconcile modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-xs text-slate-500 dark:text-[#8793A5]">
              Enter the verified provider transaction ID for <span className="font-mono font-semibold">{reconcileTarget.reference}</span> ({formatTzs(reconcileTarget.amountTzs)}). This atomically issues the customer voucher, creates the invoice, and activates RADIUS access.
            </p>
            <form onSubmit={handleReconcile} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Provider External Transaction ID</label>
                <input
                  type="text"
                  required
                  minLength={4}
                  value={reconcileTxId}
                  onChange={(e) => setReconcileTxId(e.target.value)}
                  placeholder="e.g. MPESA-9X82KQ71"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Accountant Reconciliation Note (Optional)</label>
                <input
                  type="text"
                  maxLength={240}
                  value={reconcileNote}
                  onChange={(e) => setReconcileNote(e.target.value)}
                  placeholder="Verified against Vodacom M-Pesa statement"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setReconcileTarget(null)} className="btn-secondary text-xs">
                  Cancel
                </button>
                <button type="submit" disabled={reconciling} className="btn-primary text-xs">
                  {reconciling ? 'Reconciling...' : 'Confirm & Issue Voucher'}
                </button>
              </div>
            </form>
          </>
        )}
      </MobileModal>
    </div>
  );
}
