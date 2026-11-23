import React, { useEffect, useState } from 'react';
import { RefreshCw, ShieldOff } from 'lucide-react';
import { apiRequest, formatBytes, formatSpeed } from '../lib/api.ts';

interface SessionItem {
  id: string;
  status: 'ACTIVE' | 'EXPIRED' | 'TERMINATED';
  ipAddress: string | null;
  bytesIn: number;
  bytesOut: number;
  startedAt: string;
  expiresAt: string;
  endedAt: string | null;
  endReason: string | null;
  codeMasked: string;
  packageName: string;
  downloadKbps: number;
  uploadKbps: number;
  deviceFingerprint: string;
  deviceLabel: string | null;
  customerName: string | null;
  routerName: string | null;
}

interface Props {
  token: string;
  refreshTrigger: number;
  canControl: boolean;
}

export function SessionsView({ token, refreshTrigger, canControl }: Props) {
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'EXPIRED' | 'TERMINATED'>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ sessions: SessionItem[] }>(`/api/sessions?status=${statusFilter}`, {
        token,
      });
      setSessions(res.sessions);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, statusFilter, refreshTrigger]);

  const handleTerminate = async (id: string) => {
    try {
      await apiRequest(`/api/sessions/${id}/terminate`, { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to terminate session');
    }
  };

  const handleSweep = async () => {
    try {
      await apiRequest('/api/sessions/expire-sweep', { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sweep failed');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="btn-tab-group max-w-full overflow-x-auto">
          {(['ALL', 'ACTIVE', 'EXPIRED', 'TERMINATED'] as const).map((s) => (
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

        {canControl && (
          <button
            type="button"
            onClick={handleSweep}
            className="btn-secondary text-xs"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            Sweep Expired Sessions
          </button>
        )}
      </div>

      <div className="p-4 rounded-xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 text-xs text-slate-600 dark:text-[#8793A5] space-y-1">
        <p className="font-semibold text-slate-900 dark:text-white">
          Network Access Control & One-Device Enforcement Scope
        </p>
        <p>
          NETCO binds each voucher to a single authenticated device session in an atomic database transaction. Packet-level bandwidth queues, MAC/IP firewall drops, and hotspot active-list termination are enforced on MikroTik hardware when a RouterOS device is connected. Software portals cannot disable a smartphone&apos;s built-in tethering toggle.
        </p>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-500 dark:text-[#8793A5]">
            No hotspot sessions recorded for this filter.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-[#8793A5]">
                <tr>
                  <th className="py-3 px-4 font-medium">Device & IP</th>
                  <th className="py-3 px-4 font-medium">Voucher / Package</th>
                  <th className="py-3 px-4 font-medium">Speed Limit</th>
                  <th className="py-3 px-4 font-medium">Traffic</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium">Expires</th>
                  <th className="py-3 px-4 font-medium text-right">Control</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {sessions.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 dark:hover:bg-[#080B12]/50">
                    <td className="py-3 px-4">
                      <div className="font-medium">{s.deviceLabel || 'Device'}</div>
                      <div className="font-mono text-slate-500 dark:text-[#8793A5]">
                        {s.ipAddress || 'Portal Client'} · {s.deviceFingerprint.slice(0, 14)}
                      </div>
                    </td>
                    <td className="py-3 px-4">
                      <div className="font-mono font-medium">{s.codeMasked}</div>
                      <div className="text-slate-500 dark:text-[#8793A5]">{s.packageName}</div>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {formatSpeed(s.downloadKbps)} / {formatSpeed(s.uploadKbps)}
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums">
                      {formatBytes(s.bytesIn + s.bytesOut)}
                    </td>
                    <td className="py-3 px-4 font-mono">
                      <span
                        className={
                          s.status === 'ACTIVE'
                            ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                            : s.status === 'TERMINATED'
                            ? 'text-red-500 font-semibold'
                            : 'text-slate-500 dark:text-[#8793A5]'
                        }
                      >
                        {s.status}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-mono tabular-nums text-slate-500 dark:text-[#8793A5]">
                      {new Date(s.expiresAt).toLocaleString()}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {canControl && s.status === 'ACTIVE' && (
                        <button
                          type="button"
                          onClick={() => handleTerminate(s.id)}
                          className="btn-chip-danger"
                        >
                          <ShieldOff className="w-3.5 h-3.5" />
                          Terminate
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
