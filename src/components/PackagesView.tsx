import React, { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { apiRequest, formatDurationMinutes, formatSpeed, formatTzs } from '../lib/api.ts';
import { syncPublicPackageToFirestore } from '../lib/firebase.ts';

interface PackageItem {
  id: string;
  name: string;
  description: string | null;
  category: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  priceTzs: number;
  durationMinutes: number;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
  validityDays: number;
  isActive: number;
}

interface Props {
  token: string;
  canManage: boolean;
}

export function PackagesView({ token, canManage }: Props) {
  const [packages, setPackages] = useState<PackageItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [categoryFilter, setCategoryFilter] = useState<string>('ALL');

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<PackageItem | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY'>('DAILY');
  const [priceTzs, setPriceTzs] = useState('2000');
  const [durationMinutes, setDurationMinutes] = useState('1440');
  const [downloadKbps, setDownloadKbps] = useState('10000');
  const [uploadKbps, setUploadKbps] = useState('5000');
  const [dataLimitMb, setDataLimitMb] = useState('');
  const [validityDays, setValidityDays] = useState('30');
  const [saving, setSaving] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<{ packages: PackageItem[] }>('/api/packages', { token });
      setPackages(res.packages);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load packages');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setDescription('');
    setCategory('DAILY');
    setPriceTzs('2000');
    setDurationMinutes('1440');
    setDownloadKbps('10000');
    setUploadKbps('5000');
    setDataLimitMb('');
    setValidityDays('30');
    setModalOpen(true);
  };

  const openEdit = (pkg: PackageItem) => {
    setEditing(pkg);
    setName(pkg.name);
    setDescription(pkg.description || '');
    setCategory(pkg.category);
    setPriceTzs(String(pkg.priceTzs));
    setDurationMinutes(String(pkg.durationMinutes));
    setDownloadKbps(String(pkg.downloadKbps));
    setUploadKbps(String(pkg.uploadKbps));
    setDataLimitMb(pkg.dataLimitMb ? String(pkg.dataLimitMb) : '');
    setValidityDays(String(pkg.validityDays));
    setModalOpen(true);
  };

  const applyCategoryPreset = (cat: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY') => {
    setCategory(cat);
    if (!editing) {
      if (cat === 'HOURLY') setDurationMinutes('60');
      if (cat === 'DAILY') setDurationMinutes('1440');
      if (cat === 'WEEKLY') setDurationMinutes('10080');
      if (cat === 'MONTHLY') setDurationMinutes('43200');
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = {
        name,
        description: description || null,
        category,
        priceTzs: Number(priceTzs),
        durationMinutes: Number(durationMinutes),
        downloadKbps: Number(downloadKbps),
        uploadKbps: Number(uploadKbps),
        dataLimitMb: dataLimitMb.trim() ? Number(dataLimitMb) : null,
        validityDays: Number(validityDays),
      };
      const res = editing
        ? await apiRequest<{ package: PackageItem }>(`/api/packages/${editing.id}`, {
            method: 'PATCH',
            token,
            body,
          })
        : await apiRequest<{ package: PackageItem }>('/api/packages', {
            method: 'POST',
            token,
            body,
          });

      await syncPublicPackageToFirestore({
        ...res.package,
        isActive: Boolean(res.package.isActive),
      });
      setModalOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save package');
    } finally {
      setSaving(false);
    }
  };

  const handleToggle = async (pkg: PackageItem) => {
    try {
      const res = await apiRequest<{ package: PackageItem }>(`/api/packages/${pkg.id}`, {
        method: 'PATCH',
        token,
        body: { isActive: !pkg.isActive },
      });
      await syncPublicPackageToFirestore({
        ...res.package,
        isActive: Boolean(res.package.isActive),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update package status');
    }
  };

  const visible = packages.filter((p) => categoryFilter === 'ALL' || p.category === categoryFilter);

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="btn-tab-group overflow-x-auto">
          {(['ALL', 'HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCategoryFilter(c)}
              className={categoryFilter === c ? 'btn-tab-active' : 'btn-tab'}
            >
              {c === 'ALL' ? 'All Plans' : c[0] + c.slice(1).toLowerCase()}
            </button>
          ))}
        </div>

        {canManage && (
          <button
            type="button"
            onClick={openCreate}
            className="btn-primary text-xs"
          >
            <Plus className="w-4 h-4" />
            Create Package
          </button>
        )}
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {loading ? (
        <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading packages...</div>
      ) : visible.length === 0 ? (
        <div className="p-10 bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl text-center space-y-2">
          <p className="text-sm font-medium">No WiFi packages configured</p>
          <p className="text-xs text-slate-500 dark:text-[#8793A5]">
            Create hourly, daily, weekly, or monthly hotspot plans priced in TZS with download/upload speed limits.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {visible.map((pkg) => (
            <div
              key={pkg.id}
              className="p-5 rounded-xl bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 flex flex-col justify-between space-y-4"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                      {pkg.category} · {pkg.isActive ? 'Active' : 'Inactive'}
                    </p>
                    <h3 className="text-base font-bold mt-0.5">{pkg.name}</h3>
                  </div>
                  <p className="font-mono font-bold text-base tabular-nums text-[#0284C7] dark:text-[#16B8FF]">
                    {formatTzs(pkg.priceTzs)}
                  </p>
                </div>
                {pkg.description && (
                  <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-2">{pkg.description}</p>
                )}
              </div>

              <div className="pt-3 border-t border-slate-100 dark:border-slate-800 grid grid-cols-2 gap-2 text-xs tabular-nums">
                <div>
                  <span className="text-slate-500 dark:text-[#8793A5]">Duration: </span>
                  <span className="font-mono font-medium">{formatDurationMinutes(pkg.durationMinutes)}</span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-[#8793A5]">Data Cap: </span>
                  <span className="font-mono font-medium">
                    {pkg.dataLimitMb ? `${pkg.dataLimitMb} MB` : 'Unlimited'}
                  </span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-[#8793A5]">Download: </span>
                  <span className="font-mono font-medium">{formatSpeed(pkg.downloadKbps)}</span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-[#8793A5]">Upload: </span>
                  <span className="font-mono font-medium">{formatSpeed(pkg.uploadKbps)}</span>
                </div>
              </div>

              {canManage && (
                <div className="pt-2 flex items-center justify-end gap-2 text-xs">
                  <button
                    type="button"
                    onClick={() => openEdit(pkg)}
                    className="btn-chip-accent"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => handleToggle(pkg)}
                    className={pkg.isActive ? 'btn-chip-warn' : 'btn-chip-neutral'}
                  >
                    {pkg.isActive ? 'Disable' : 'Enable'}
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-lg w-full bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{editing ? 'Edit WiFi Package' : 'Create WiFi Package'}</h3>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">Package Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="24H Express Fiber"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12]"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Cadence</label>
                  <select
                    value={category}
                    onChange={(e) => applyCategoryPreset(e.target.value as 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY')}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12]"
                  >
                    <option value="HOURLY">Hourly</option>
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block font-medium mb-1">Description</label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="High-speed wireless access for 1 device"
                  className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block font-medium mb-1">Price (TZS)</label>
                  <input
                    type="number"
                    min={0}
                    required
                    value={priceTzs}
                    onChange={(e) => setPriceTzs(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Duration (Minutes)</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={durationMinutes}
                    onChange={(e) => setDurationMinutes(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Download Limit (Kbps)</label>
                  <input
                    type="number"
                    min={64}
                    required
                    value={downloadKbps}
                    onChange={(e) => setDownloadKbps(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Upload Limit (Kbps)</label>
                  <input
                    type="number"
                    min={64}
                    required
                    value={uploadKbps}
                    onChange={(e) => setUploadKbps(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Data Limit MB (Optional)</label>
                  <input
                    type="number"
                    min={1}
                    value={dataLimitMb}
                    onChange={(e) => setDataLimitMb(e.target.value)}
                    placeholder="Unlimited"
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Validity Window (Days)</label>
                  <input
                    type="number"
                    min={1}
                    required
                    value={validityDays}
                    onChange={(e) => setValidityDays(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] font-mono"
                  />
                </div>
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
                  {saving ? 'Saving...' : 'Save Package'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
