import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { Check, Copy, Eye, EyeOff, Key, KeyRound, Plus, Shield, X } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { MobileModal, MobilePageTransition } from './ui/MotionPrimitives.tsx';

type StaffRoleValue =
  | 'SUPER_ADMIN'
  | 'BUSINESS_OWNER'
  | 'ADMIN'
  | 'ACCOUNTANT'
  | 'NETWORK_OPERATOR'
  | 'SUPPORT_STAFF'
  | 'CASHIER';

interface StaffMember {
  id: string;
  email: string;
  fullName: string;
  role: StaffRoleValue;
  isActive: number;
  staffCode: string | null;
  department: string | null;
  isSuspended: number | null;
  lastLoginAt: string | null;
}

interface StaffSession {
  id: string;
  ipAddress: string | null;
  email: string;
  fullName: string;
  role: string;
  expiresAt: string;
  revokedAt: string | null;
  createdAt: string;
}

interface AuditItem {
  id: string;
  actor_email: string;
  actor_role: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  ip_address: string | null;
  created_at: string;
}

interface Props {
  token: string;
  currentRole: string;
}

export function StaffAuditView({ token, currentRole }: Props) {
  const [subTab, setSubTab] = useState<'staff' | 'sessions' | 'audit'>('staff');
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [sessions, setSessions] = useState<StaffSession[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [createOpen, setCreateOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<StaffRoleValue>('CASHIER');
  const [department, setDepartment] = useState('Operations');
  const [saving, setSaving] = useState(false);

  const [resetTarget, setResetTarget] = useState<StaffMember | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [showCreatePassword, setShowCreatePassword] = useState(false);
  const [showResetPassword, setShowResetPassword] = useState(false);
  const [issuedRecovery, setIssuedRecovery] = useState<{
    email: string;
    code: string;
    expiresAt: string;
  } | null>(null);
  const [copiedRecovery, setCopiedRecovery] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    setError(null);
    try {
      const [sRes, ssRes, aRes] = await Promise.all([
        apiRequest<{ staff: StaffMember[] }>('/api/staff', { token }),
        apiRequest<{ sessions: StaffSession[] }>('/api/staff/sessions', { token }),
        apiRequest<{ logs: AuditItem[] }>('/api/audit-logs', { token }),
      ]);
      setStaff(sRes.staff);
      setSessions(ssRes.sessions);
      setAuditLogs(aRes.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Restricted to Admin / Super Admin roles');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAll();
  }, [token]);

  const handleCreateStaff = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/api/staff', {
        method: 'POST',
        token,
        body: { email, fullName, password, role, department },
      });
      setCreateOpen(false);
      setEmail('');
      setFullName('');
      setPassword('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create staff account');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleSuspend = async (m: StaffMember) => {
    try {
      await apiRequest(`/api/staff/${m.id}`, {
        method: 'PATCH',
        token,
        body: { isSuspended: !m.isSuspended },
      });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update staff status');
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetTarget) return;
    try {
      await apiRequest(`/api/staff/${resetTarget.id}/reset-password`, {
        method: 'POST',
        token,
        body: { newPassword },
      });
      setResetTarget(null);
      setNewPassword('');
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password');
    }
  };

  const handleRevokeSession = async (id: string) => {
    try {
      setError(null);
      await apiRequest(`/api/staff/sessions/${id}/revoke`, { method: 'POST', token });
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to revoke staff session');
    }
  };

  const handleIssueRecoveryCode = async (m: StaffMember) => {
    setError(null);
    setCopiedRecovery(false);
    try {
      const res = await apiRequest<{ code: string; expiresAt: string; email: string }>(
        `/api/staff/${m.id}/recovery-code`,
        { method: 'POST', token }
      );
      setIssuedRecovery(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate recovery code');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="btn-tab-group">
          <button
            type="button"
            onClick={() => setSubTab('staff')}
            className={subTab === 'staff' ? 'btn-tab-active' : 'btn-tab'}
          >
            Staff & Roles
          </button>
          <button
            type="button"
            onClick={() => setSubTab('sessions')}
            className={subTab === 'sessions' ? 'btn-tab-active' : 'btn-tab'}
          >
            Staff Sessions
          </button>
          <button
            type="button"
            onClick={() => setSubTab('audit')}
            className={subTab === 'audit' ? 'btn-tab-active' : 'btn-tab'}
          >
            Audit Logs
          </button>
        </div>

        {(currentRole === 'SUPER_ADMIN' || currentRole === 'BUSINESS_OWNER' || currentRole === 'ADMIN') && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="btn-primary text-xs"
          >
            <Plus className="w-4 h-4" />
            Add Staff Account
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {issuedRecovery && (
        <div className="p-3.5 rounded-xl border border-[#FFD400]/35 bg-[#FFD400]/10 text-xs flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-slate-900 dark:text-white">
              One-Time Recovery Code for {issuedRecovery.email}
            </p>
            <p className="text-slate-600 dark:text-[#8793A5] mt-0.5">
              Code:{' '}
              <span className="font-mono font-bold text-[#9A7B00] dark:text-[#FFD400] tracking-wider">
                {issuedRecovery.code}
              </span>{' '}
              · Expires {new Date(issuedRecovery.expiresAt).toLocaleTimeString()}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                await navigator.clipboard.writeText(issuedRecovery.code).catch(() => {});
                setCopiedRecovery(true);
                setTimeout(() => setCopiedRecovery(false), 2000);
              }}
              className="btn-primary min-h-[34px] px-3 py-1 text-xs"
            >
              {copiedRecovery ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              {copiedRecovery ? 'Copied' : 'Copy'}
            </button>
            <button
              type="button"
              onClick={() => setIssuedRecovery(null)}
              aria-label="Dismiss recovery code"
              className="btn-icon min-h-[34px] min-w-[34px] p-1"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-xs text-slate-500">Loading administration records...</div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <MobilePageTransition key={subTab}>
      {subTab === 'staff' ? (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
              <tr>
                <th className="py-3 px-4 font-medium">Staff Member</th>
                <th className="py-3 px-4 font-medium">Role</th>
                <th className="py-3 px-4 font-medium">Department</th>
                <th className="py-3 px-4 font-medium">Status</th>
                <th className="py-3 px-4 font-medium text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
              {staff.map((m) => (
                <tr key={m.id}>
                  <td className="py-3 px-4">
                    <div className="font-semibold">{m.fullName}</div>
                    <div className="font-mono text-slate-500 dark:text-[#8793A5]">
                      {m.email} {m.staffCode ? `· ${m.staffCode}` : ''}
                    </div>
                  </td>
                  <td className="py-3 px-4 font-mono">
                    <span className="inline-flex items-center gap-1">
                      <Shield className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400]" />
                      {m.role}
                    </span>
                  </td>
                  <td className="py-3 px-4">{m.department || 'Operations'}</td>
                  <td className="py-3 px-4 font-mono">
                    <span className={m.isSuspended || !m.isActive ? 'text-red-500' : 'text-emerald-500'}>
                      {m.isSuspended || !m.isActive ? 'SUSPENDED' : 'ACTIVE'}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right whitespace-nowrap">
                    <div className="inline-flex items-center justify-end gap-1.5">
                      <button
                        type="button"
                        onClick={() => handleIssueRecoveryCode(m)}
                        className="btn-chip-neutral"
                      >
                        <KeyRound className="w-3.5 h-3.5" />
                        Recovery Code
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowResetPassword(false);
                          setResetTarget(m);
                        }}
                        className="btn-chip-accent"
                      >
                        <Key className="w-3.5 h-3.5" />
                        Reset Password
                      </button>
                      <button
                        type="button"
                        onClick={() => handleToggleSuspend(m)}
                        className="btn-chip-warn"
                      >
                        {m.isSuspended ? 'Reactivate' : 'Suspend'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : subTab === 'sessions' ? (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
              <tr>
                <th className="py-3 px-4 font-medium">Staff</th>
                <th className="py-3 px-4 font-medium">IP Address</th>
                <th className="py-3 px-4 font-medium">Expires</th>
                <th className="py-3 px-4 font-medium">State</th>
                <th className="py-3 px-4 font-medium text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {sessions.map((s) => (
                <tr key={s.id}>
                  <td className="py-3 px-4 font-sans">
                    <div className="font-medium">{s.fullName}</div>
                    <div className="text-slate-500 font-mono">{s.email}</div>
                  </td>
                  <td className="py-3 px-4">{s.ipAddress || '—'}</td>
                  <td className="py-3 px-4 tabular-nums">{new Date(s.expiresAt).toLocaleString()}</td>
                  <td className="py-3 px-4">{s.revokedAt ? 'REVOKED' : 'ACTIVE'}</td>
                  <td className="py-3 px-4 text-right">
                    {!s.revokedAt && (
                      <button
                        type="button"
                        onClick={() => handleRevokeSession(s.id)}
                        className="btn-chip-danger font-sans"
                      >
                        Revoke
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500">
              <tr>
                <th className="py-3 px-4 font-medium">Timestamp</th>
                <th className="py-3 px-4 font-medium">Actor</th>
                <th className="py-3 px-4 font-medium">Action</th>
                <th className="py-3 px-4 font-medium">Entity</th>
                <th className="py-3 px-4 font-medium">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100 dark:divide-slate-800 font-mono">
              {auditLogs.map((l) => (
                <tr key={l.id}>
                  <td className="py-2.5 px-4 tabular-nums">{new Date(l.created_at).toLocaleString()}</td>
                  <td className="py-2.5 px-4">
                    {l.actor_email} · {l.actor_role}
                  </td>
                  <td className="py-2.5 px-4 font-semibold">{l.action}</td>
                  <td className="py-2.5 px-4">
                    {l.entity_type} {l.entity_id ? `(${l.entity_id})` : ''}
                  </td>
                  <td className="py-2.5 px-4">{l.ip_address || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
          </MobilePageTransition>
        </AnimatePresence>
      )}

      <MobileModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        maxWidthClass="max-w-md"
        panelClassName="space-y-4"
        ariaLabel="Create Staff Account"
      >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Create Staff Account</h3>
              <button
                type="button"
                onClick={() => setCreateOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateStaff} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Password (Min 8 chars)</label>
                <div className="relative">
                  <input
                    type={showCreatePassword ? 'text' : 'password'}
                    required
                    minLength={8}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full pl-3 pr-9 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowCreatePassword((v) => !v)}
                    aria-label={showCreatePassword ? 'Hide password' : 'Show password'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                  >
                    {showCreatePassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">Role</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as StaffRoleValue)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  >
                    <option value="CASHIER">Cashier</option>
                    <option value="SUPPORT_STAFF">Support Staff</option>
                    <option value="NETWORK_OPERATOR">Network Operator</option>
                    <option value="ACCOUNTANT">Accountant</option>
                    <option value="ADMIN">Business Administrator</option>
                    <option value="BUSINESS_OWNER">Business Owner</option>
                    {currentRole === 'SUPER_ADMIN' && <option value="SUPER_ADMIN">TRAX Super Admin</option>}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">Department</label>
                  <input
                    type="text"
                    required
                    value={department}
                    onChange={(e) => setDepartment(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  />
                </div>
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setCreateOpen(false)}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-primary text-xs"
                >
                  {saving ? 'Creating...' : 'Create Account'}
                </button>
              </div>
            </form>
      </MobileModal>

      <MobileModal
        open={Boolean(resetTarget)}
        onClose={() => setResetTarget(null)}
        maxWidthClass="max-w-sm"
        panelClassName="space-y-4"
        ariaLabel="Reset Staff Password"
      >
        {resetTarget && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Reset Password — {resetTarget.fullName}</h3>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleResetPassword} className="space-y-3 text-xs">
              <div className="relative">
                <input
                  type={showResetPassword ? 'text' : 'password'}
                  required
                  minLength={8}
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  placeholder="New password (min 8 chars)"
                  className="w-full pl-3 pr-9 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
                <button
                  type="button"
                  onClick={() => setShowResetPassword((v) => !v)}
                  aria-label={showResetPassword ? 'Hide password' : 'Show password'}
                  className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                >
                  {showResetPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                </button>
              </div>
              <div className="flex justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button type="submit" className="btn-primary text-xs">
                  Update Password
                </button>
              </div>
            </form>
          </>
        )}
      </MobileModal>
    </div>
  );
}
