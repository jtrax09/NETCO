import React, { useEffect, useState } from 'react';
import { Bell, CheckCheck } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';

interface NotificationItem {
  id: string;
  type: string;
  severity: string;
  title: string;
  message: string;
  isRead: number;
  createdAt: string;
}

interface Props {
  token: string;
  refreshTrigger: number;
}

export function NotificationsView({ token, refreshTrigger }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      setError(null);
      const res = await apiRequest<{ notifications: NotificationItem[] }>('/api/notifications', { token });
      setItems(res.notifications);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load alerts');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  const markRead = async (id: string) => {
    try {
      setError(null);
      await apiRequest(`/api/notifications/${id}/read`, { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to mark alert as read');
    }
  };

  const markAllRead = async () => {
    try {
      setError(null);
      await apiRequest('/api/notifications/read-all', { method: 'POST', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to mark alerts as read');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <p className="text-xs text-slate-500 dark:text-[#8793A5]">
          Real-time alerts for voucher activations, payment confirmations, router status transitions, and multi-device blocks.
        </p>
        <button
          type="button"
          onClick={markAllRead}
          className="btn-secondary text-xs self-start sm:self-auto"
        >
          <CheckCheck className="w-3.5 h-3.5" />
          Mark All Read
        </button>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl divide-y divide-slate-100 dark:divide-slate-800">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">Loading alerts...</div>
        ) : items.length === 0 ? (
          <div className="p-10 text-center space-y-2 text-xs text-slate-500 dark:text-[#8793A5]">
            <Bell className="w-6 h-6 mx-auto opacity-50" />
            <p>No network or billing alerts recorded yet.</p>
          </div>
        ) : (
          items.map((n) => (
            <div key={n.id} className="p-4 flex items-start justify-between gap-4 text-xs">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span
                    className={
                      n.severity === 'WARNING'
                        ? 'text-amber-600 dark:text-amber-400 font-semibold font-mono'
                        : 'text-[#0284C7] dark:text-[#16B8FF] font-semibold font-mono'
                    }
                  >
                    {n.type}
                  </span>
                  <span className="text-slate-400">·</span>
                  <span className="font-mono text-slate-500 dark:text-[#8793A5]">
                    {new Date(n.createdAt).toLocaleString()}
                  </span>
                </div>
                <p className="text-sm font-semibold text-slate-900 dark:text-white">{n.title}</p>
                <p className="text-slate-600 dark:text-[#8793A5]">{n.message}</p>
              </div>
              {!n.isRead && (
                <button
                  type="button"
                  onClick={() => markRead(n.id)}
                  className="btn-chip-accent"
                >
                  Mark Read
                </button>
              )}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
