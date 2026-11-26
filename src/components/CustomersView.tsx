import React, { useEffect, useState } from 'react';
import { Plus, Search, UserCheck, UserX, X } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';
import { MobileDrawer, MobileModal } from './ui/MotionPrimitives.tsx';

interface Customer {
  id: string;
  customer_code: string;
  full_name: string;
  phone: string;
  email: string | null;
  notes: string | null;
  is_active: number;
  package_id: string | null;
  package_name: string | null;
  active_session_count: number;
  voucher_count: number;
  created_at: string;
}

interface PackageOption {
  id: string;
  name: string;
}

interface CustomerProfile {
  customer: Customer;
  vouchers: Array<{
    id: string;
    codeMasked: string;
    status: string;
    packageName: string;
    createdAt: string;
    expiresAt: string | null;
  }>;
  sessions: Array<{
    id: string;
    status: string;
    ipAddress: string | null;
    deviceLabel: string | null;
    startedAt: string;
    expiresAt: string;
  }>;
}

interface Props {
  token: string;
  canEdit: boolean;
  canDelete: boolean;
}

export function CustomersView({ token, canEdit, canDelete }: Props) {
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [packages, setPackages] = useState<PackageOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'ACTIVE' | 'INACTIVE'>('ALL');
  const [error, setError] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<Customer | null>(null);
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [packageId, setPackageId] = useState('');
  const [notes, setNotes] = useState('');
  const [saving, setSaving] = useState(false);

  const [profile, setProfile] = useState<CustomerProfile | null>(null);

  const loadData = async () => {
    setLoading(true);
    try {
      const [custRes, pkgRes] = await Promise.all([
        apiRequest<{ customers: Customer[] }>(
          `/api/customers?q=${encodeURIComponent(search)}&status=${statusFilter}`,
          { token }
        ),
        apiRequest<{ packages: PackageOption[] }>('/api/packages', { token }),
      ]);
      setCustomers(custRes.customers);
      setPackages(pkgRes.packages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load customers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadData();
  }, [token, statusFilter]);

  const openCreate = () => {
    setEditing(null);
    setFullName('');
    setPhone('');
    setEmail('');
    setPackageId('');
    setNotes('');
    setModalOpen(true);
  };

  const openEdit = (c: Customer) => {
    setEditing(c);
    setFullName(c.full_name);
    setPhone(c.phone);
    setEmail(c.email || '');
    setPackageId(c.package_id || '');
    setNotes(c.notes || '');
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const payload = {
        fullName,
        phone,
        email: email || null,
        packageId: packageId || null,
        notes: notes || null,
      };
      if (editing) {
        await apiRequest(`/api/customers/${editing.id}`, { method: 'PATCH', token, body: payload });
      } else {
        await apiRequest('/api/customers', { method: 'POST', token, body: payload });
      }
      setModalOpen(false);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save customer');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (c: Customer) => {
    try {
      await apiRequest(`/api/customers/${c.id}`, {
        method: 'PATCH',
        token,
        body: { isActive: !c.is_active },
      });
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update customer status');
    }
  };

  const handleDelete = async (c: Customer) => {
    try {
      await apiRequest(`/api/customers/${c.id}`, { method: 'DELETE', token });
      if (profile?.customer.id === c.id) setProfile(null);
      await loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete customer');
    }
  };

  const openProfile = async (id: string) => {
    try {
      const res = await apiRequest<CustomerProfile>(`/api/customers/${id}`, { token });
      setProfile(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load profile');
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-2 flex-1">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void loadData();
            }}
            className="relative w-full sm:w-auto sm:flex-1 sm:min-w-[220px] sm:max-w-sm"
          >
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name, phone, ID..."
              className="w-full pl-9 pr-3 py-2 text-xs rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#161618] focus:outline-none focus:border-[#FFD400]"
            />
          </form>

          <div className="btn-tab-group max-w-full overflow-x-auto">
            {(['ALL', 'ACTIVE', 'INACTIVE'] as const).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={statusFilter === s ? 'btn-tab-active' : 'btn-tab'}
              >
                {s === 'ALL' ? 'All' : s === 'ACTIVE' ? 'Active' : 'Inactive'}
              </button>
            ))}
          </div>
        </div>

        {canEdit && (
          <button
            type="button"
            onClick={openCreate}
            className="btn-primary text-xs"
          >
            <Plus className="w-4 h-4" />
            Add Customer
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading customers...</div>
        ) : customers.length === 0 ? (
          <div className="p-10 text-center space-y-2">
            <p className="text-sm font-medium">No customers found</p>
            <p className="text-xs text-slate-500 dark:text-[#8793A5]">
              Create subscriber profiles to track assigned plans, voucher history, and live sessions.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-[#8793A5]">
                <tr>
                  <th className="py-3 px-4 font-medium">Customer ID</th>
                  <th className="py-3 px-4 font-medium">Name & Contact</th>
                  <th className="py-3 px-4 font-medium">Assigned Package</th>
                  <th className="py-3 px-4 font-medium">Status</th>
                  <th className="py-3 px-4 font-medium text-right">Vouchers</th>
                  <th className="py-3 px-4 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 dark:divide-slate-800/80">
                {customers.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50 dark:hover:bg-[#080B12]/50">
                    <td className="py-3 px-4 font-mono tabular-nums">{c.customer_code}</td>
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => openProfile(c.id)}
                        className="font-semibold text-slate-900 dark:text-white hover:text-[#9A7B00] dark:hover:text-[#FFD400] text-left"
                      >
                        {c.full_name}
                      </button>
                      <div className="text-slate-500 dark:text-[#8793A5] font-mono">
                        {c.phone} {c.email ? `· ${c.email}` : ''}
                      </div>
                    </td>
                    <td className="py-3 px-4">{c.package_name || 'Unassigned'}</td>
                    <td className="py-3 px-4">
                      <span
                        className={
                          c.active_session_count > 0
                            ? 'text-emerald-600 dark:text-emerald-400 font-medium'
                            : c.is_active
                            ? 'text-slate-700 dark:text-slate-300'
                            : 'text-amber-600 dark:text-amber-400'
                        }
                      >
                        {c.active_session_count > 0 ? 'Online' : c.is_active ? 'Active' : 'Deactivated'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums">{c.voucher_count}</td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center justify-end gap-1.5">
                        <button
                          type="button"
                          onClick={() => openProfile(c.id)}
                          className="btn-chip-accent"
                        >
                          Profile
                        </button>
                        {canEdit && (
                          <>
                            <button
                              type="button"
                              onClick={() => openEdit(c)}
                              className="btn-chip-neutral"
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleActive(c)}
                              className="btn-chip-warn"
                            >
                              {c.is_active ? 'Deactivate' : 'Activate'}
                            </button>
                          </>
                        )}
                        {canDelete && (
                          <button
                            type="button"
                            onClick={() => handleDelete(c)}
                            className="btn-chip-danger"
                          >
                            Remove
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

      {/* Create / Edit Modal */}
      <MobileModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        maxWidthClass="max-w-md"
        panelClassName="space-y-4"
        ariaLabel={editing ? 'Edit Customer' : 'Add Customer'}
      >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{editing ? 'Edit Customer' : 'Add Customer'}</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleSave} className="space-y-3.5 text-xs">
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
                <label className="block font-medium mb-1">Phone Number</label>
                <input
                  type="tel"
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="0754123456"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Email (Optional)</label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Assigned Package</label>
                <select
                  value={packageId}
                  onChange={(e) => setPackageId(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                >
                  <option value="">None</option>
                  {packages.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block font-medium mb-1">Notes</label>
                <textarea
                  rows={2}
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-primary text-xs"
                >
                  {saving ? 'Saving...' : 'Save Customer'}
                </button>
              </div>
            </form>
      </MobileModal>

      {/* Customer Profile Drawer */}
      <MobileDrawer
        open={Boolean(profile)}
        onClose={() => setProfile(null)}
        side="right"
        panelClassName="max-w-lg w-full h-full bg-white dark:bg-[#161618] border-l border-stone-200 dark:border-white/10 p-6 overflow-y-auto space-y-6"
        ariaLabel="Customer Profile Drawer"
      >
        {profile && (
          <>
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs font-mono text-[#9A7B00] dark:text-[#FFD400]">{profile.customer.customer_code}</p>
                <h3 className="text-lg font-bold mt-0.5">{profile.customer.full_name}</h3>
                <p className="text-xs text-slate-500 dark:text-[#8793A5] font-mono">
                  {profile.customer.phone} {profile.customer.email ? `· ${profile.customer.email}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setProfile(null)}
                aria-label="Close customer profile"
                className="btn-icon min-h-[36px] min-w-[36px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 rounded-xl bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-[#8793A5]">Assigned Package</span>
                <span className="font-medium">{profile.customer.package_name || 'None'}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500 dark:text-[#8793A5]">Account Status</span>
                <span className="inline-flex items-center gap-1 font-medium">
                  {profile.customer.is_active ? (
                    <>
                      <UserCheck className="w-3.5 h-3.5 text-emerald-500" /> Active
                    </>
                  ) : (
                    <>
                      <UserX className="w-3.5 h-3.5 text-amber-500" /> Inactive
                    </>
                  )}
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8793A5]">
                Voucher History ({profile.vouchers.length})
              </h4>
              {profile.vouchers.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-[#8793A5]">No vouchers assigned.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl px-3">
                  {profile.vouchers.map((v) => (
                    <div key={v.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div>
                        <p className="font-mono font-medium">{v.codeMasked}</p>
                        <p className="text-slate-500 dark:text-[#8793A5]">{v.packageName}</p>
                      </div>
                      <span className="font-mono">{v.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-500 dark:text-[#8793A5]">
                Connection History ({profile.sessions.length})
              </h4>
              {profile.sessions.length === 0 ? (
                <p className="text-xs text-slate-500 dark:text-[#8793A5]">No session history yet.</p>
              ) : (
                <div className="divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-xl px-3">
                  {profile.sessions.map((s) => (
                    <div key={s.id} className="py-2.5 flex items-center justify-between text-xs">
                      <div>
                        <p className="font-medium">{s.deviceLabel || 'Device'}</p>
                        <p className="text-slate-500 dark:text-[#8793A5] font-mono">
                          {s.ipAddress || 'Unknown IP'} · {new Date(s.startedAt).toLocaleString()}
                        </p>
                      </div>
                      <span className="font-mono">{s.status}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </MobileDrawer>
    </div>
  );
}
