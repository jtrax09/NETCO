import React, { useEffect, useState } from 'react';
import { MessageSquare, Plus, RefreshCw, ShieldOff, X } from 'lucide-react';
import { apiRequest, formatSpeed } from '../lib/api.ts';

interface SubscriptionItem {
  id: string;
  radiusUsername: string;
  status: string;
  provisioningStatus: string;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
  startsAt: string;
  expiresAt: string;
  packageName: string;
  customerName: string | null;
  locationName: string | null;
  pendingJobId: string | null;
}

interface ProvisioningJobItem {
  id: string;
  subscriptionId: string;
  routerId: string | null;
  routerName: string | null;
  action: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  nextRetryAt: string | null;
  completedAt: string | null;
}

interface SupportTicketItem {
  id: string;
  phone: string;
  subject: string;
  message: string;
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  reply: string | null;
  createdAt: string;
}

interface Props {
  token: string;
  refreshTrigger: number;
  canManage: boolean;
  canSupport: boolean;
}

export function SubscriptionsView({ token, refreshTrigger, canManage, canSupport }: Props) {
  const [subTab, setSubTab] = useState<'subscriptions' | 'queue' | 'tickets'>('subscriptions');
  const [subscriptions, setSubscriptions] = useState<SubscriptionItem[]>([]);
  const [jobs, setJobs] = useState<ProvisioningJobItem[]>([]);
  const [tickets, setTickets] = useState<SupportTicketItem[]>([]);
  const [packages, setPackages] = useState<Array<{ id: string; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [packageId, setPackageId] = useState('');
  const [username, setUsername] = useState('');
  const [creating, setCreating] = useState(false);

  const [replyTicket, setReplyTicket] = useState<SupportTicketItem | null>(null);
  const [replyText, setReplyText] = useState('');
  const [ticketStatus, setTicketStatus] = useState<'OPEN' | 'IN_PROGRESS' | 'RESOLVED'>('RESOLVED');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [subRes, tktRes, pkgRes] = await Promise.all([
        apiRequest<{ subscriptions: SubscriptionItem[]; provisioningJobs: ProvisioningJobItem[] }>(
          '/api/subscriptions',
          { token }
        ),
        apiRequest<{ tickets: SupportTicketItem[] }>('/api/support-tickets', { token }),
        apiRequest<{ packages: Array<{ id: string; name: string }> }>('/api/packages', { token }),
      ]);
      setSubscriptions(subRes.subscriptions);
      setJobs(subRes.provisioningJobs);
      setTickets(tktRes.tickets);
      setPackages(pkgRes.packages);
      if (pkgRes.packages.length > 0 && !packageId) {
        setPackageId(pkgRes.packages[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load subscriptions & queue');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  const handleProvision = async (e: React.FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setError(null);
    try {
      await apiRequest('/api/subscriptions', {
        method: 'POST',
        token,
        body: {
          packageId,
          ...(username.trim() ? { username: username.trim() } : {}),
        },
      });
      setCreateOpen(false);
      setUsername('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Provisioning failed');
    } finally {
      setCreating(false);
    }
  };

  const handleSuspend = async (id: string) => {
    try {
      setError(null);
      await apiRequest(`/api/subscriptions/${id}/suspend`, { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to suspend subscription');
    }
  };

  const handleRetryJob = async (jobId: string) => {
    try {
      setError(null);
      await apiRequest(`/api/provisioning-jobs/${jobId}/retry`, { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Retry failed');
    }
  };

  const handleUpdateTicket = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!replyTicket) return;
    try {
      setError(null);
      await apiRequest(`/api/support-tickets/${replyTicket.id}`, {
        method: 'PATCH',
        token,
        body: { status: ticketStatus, reply: replyText },
      });
      setReplyTicket(null);
      setReplyText('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update ticket');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="btn-tab-group overflow-x-auto max-w-full">
          <button
            type="button"
            onClick={() => setSubTab('subscriptions')}
            className={subTab === 'subscriptions' ? 'btn-tab-active' : 'btn-tab'}
          >
            Subscriptions ({subscriptions.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('queue')}
            className={subTab === 'queue' ? 'btn-tab-active' : 'btn-tab'}
          >
            Provisioning Queue ({jobs.length})
          </button>
          <button
            type="button"
            onClick={() => setSubTab('tickets')}
            className={subTab === 'tickets' ? 'btn-tab-active' : 'btn-tab'}
          >
            Support Tickets ({tickets.length})
          </button>
        </div>

        <div className="flex items-center gap-2">
          <button type="button" onClick={load} className="btn-secondary text-xs">
            <RefreshCw className="w-3.5 h-3.5" />
            Refresh
          </button>
          {canManage && (
            <button type="button" onClick={() => setCreateOpen(true)} className="btn-primary text-xs">
              <Plus className="w-4 h-4" />
              Provision RADIUS Account
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
        <div className="p-8 text-center text-xs text-zinc-500">Loading subscriptions...</div>
      ) : subTab === 'subscriptions' ? (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl overflow-x-auto">
          {subscriptions.length === 0 ? (
            <div className="p-10 text-center text-xs text-zinc-500">
              No RADIUS / WiFi subscriptions provisioned yet. Verified payments automatically provision records here.
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-stone-200 dark:border-zinc-800 text-zinc-500">
                <tr>
                  <th className="py-3 px-4 font-medium">RADIUS Username</th>
                  <th className="py-3 px-4 font-medium">Package / Speed</th>
                  <th className="py-3 px-4 font-medium">Provisioning</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Expires</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-zinc-800">
                {subscriptions.map((s) => (
                  <tr key={s.id}>
                    <td className="py-3 px-4">
                      <div className="font-mono font-semibold">{s.radiusUsername}</div>
                      <div className="text-zinc-500 dark:text-zinc-400">
                        {s.customerName || 'Prepaid User'} {s.locationName ? `· ${s.locationName}` : ''}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div>{s.packageName}</div>
                      <div className="font-mono text-zinc-500 tabular-nums">
                        {formatSpeed(s.downloadKbps)} / {formatSpeed(s.uploadKbps)}
                      </div>
                    </td>
                    <td className="py-3 px-4 font-mono">{s.provisioningStatus}</td>
                    <td className="py-3 px-4 font-mono">
                      <span
                        className={
                          s.status === 'ACTIVE'
                            ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                            : s.status === 'SUSPENDED'
                            ? 'text-red-600 dark:text-red-400 font-semibold'
                            : 'text-zinc-500'
                        }
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-zinc-500">
                      {new Date(s.expiresAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-1.5">
                        {s.pendingJobId && canManage && (
                          <button
                            type="button"
                            onClick={() => handleRetryJob(s.pendingJobId!)}
                            className="btn-chip-accent"
                          >
                            Retry Router Sync
                          </button>
                        )}
                        {s.status === 'ACTIVE' && canManage && (
                          <button
                            type="button"
                            onClick={() => handleSuspend(s.id)}
                            className="btn-chip-danger"
                          >
                            <ShieldOff className="w-3.5 h-3.5" />
                            Suspend
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : subTab === 'queue' ? (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl overflow-x-auto">
          {jobs.length === 0 ? (
            <div className="p-10 text-center text-xs text-zinc-500">
              No queued or retrying MikroTik provisioning jobs.
            </div>
          ) : (
            <table className="w-full text-left text-xs">
              <thead className="border-b border-stone-200 dark:border-zinc-800 text-zinc-500">
                <tr>
                  <th className="py-3 px-4 font-medium">Action</th>
                  <th className="py-3 px-4 font-medium">Router</th>
                  <th className="py-3 px-4 font-medium">Attempts</th>
                  <th className="py-3 px-4 font-medium">State</th>
                  <th className="py-3 px-4 font-medium">Last Error</th>
                  <th className="py-3 px-4 font-medium text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stone-100 dark:divide-zinc-800 font-mono">
                {jobs.map((j) => (
                  <tr key={j.id}>
                    <td className="py-3 px-4 font-semibold">{j.action}</td>
                    <td className="py-3 px-4 font-sans">{j.routerName || 'All Routers'}</td>
                    <td className="py-3 px-4 tabular-nums">
                      {j.attempts} / {j.maxAttempts}
                    </td>
                    <td className="py-3 px-4">{j.status}</td>
                    <td className="py-3 px-4 font-sans text-zinc-500 max-w-xs truncate">{j.lastError || '—'}</td>
                    <td className="py-3 px-4 text-right">
                      {j.status === 'FAILED_RETRYING' && canManage && (
                        <button
                          type="button"
                          onClick={() => handleRetryJob(j.id)}
                          className="btn-chip-accent font-sans"
                        >
                          Retry Now
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl divide-y divide-stone-100 dark:divide-zinc-800">
          {tickets.length === 0 ? (
            <div className="p-10 text-center text-xs text-zinc-500">No customer support tickets submitted yet.</div>
          ) : (
            tickets.map((t) => (
              <div key={t.id} className="p-4 flex items-start justify-between gap-4 text-xs">
                <div className="space-y-1">
                  <div className="flex items-center gap-2 font-mono">
                    <span className="font-semibold text-[#B8860B] dark:text-[#FFD400]">{t.status}</span>
                    <span>·</span>
                    <span>{t.phone}</span>
                    <span>·</span>
                    <span className="text-zinc-500">{new Date(t.createdAt).toLocaleString()}</span>
                  </div>
                  <p className="text-sm font-semibold">{t.subject}</p>
                  <p className="text-zinc-600 dark:text-zinc-300">{t.message}</p>
                  {t.reply && (
                    <p className="text-emerald-600 dark:text-emerald-400 font-mono text-[11px] pt-1">
                      Operator Reply: {t.reply}
                    </p>
                  )}
                </div>
                {canSupport && (
                  <button
                    type="button"
                    onClick={() => {
                      setReplyTicket(t);
                      setReplyText(t.reply || '');
                      setTicketStatus(t.status === 'OPEN' ? 'RESOLVED' : t.status);
                    }}
                    className="btn-chip-accent shrink-0"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    Respond
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      )}

      {createOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Provision RADIUS Subscription</h3>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleProvision} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Internet Package</label>
                <select
                  required
                  value={packageId}
                  onChange={(e) => setPackageId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                >
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">RADIUS Username (Optional)</label>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  placeholder="Auto-generated if blank"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setCreateOpen(false)} className="btn-secondary text-xs">
                  Cancel
                </button>
                <button type="submit" disabled={creating || !packageId} className="btn-primary text-xs">
                  {creating ? 'Provisioning...' : 'Provision'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {replyTicket && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Reply to Support Ticket</h3>
              <button
                type="button"
                onClick={() => setReplyTicket(null)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleUpdateTicket} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Status</label>
                <select
                  value={ticketStatus}
                  onChange={(e) => setTicketStatus(e.target.value as typeof ticketStatus)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                >
                  <option value="OPEN">OPEN</option>
                  <option value="IN_PROGRESS">IN_PROGRESS</option>
                  <option value="RESOLVED">RESOLVED</option>
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Operator Reply</label>
                <textarea
                  rows={3}
                  required
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setReplyTicket(null)} className="btn-secondary text-xs">
                  Cancel
                </button>
                <button type="submit" className="btn-primary text-xs">
                  Save Reply
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
