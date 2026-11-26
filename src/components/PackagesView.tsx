import React, { useEffect, useState } from 'react';
import { Plus, X } from 'lucide-react';
import { apiRequest, formatDurationMinutes, formatSpeed, formatTzs } from '../lib/api.ts';
import { syncPublicPackageToFirestore } from '../lib/firebase.ts';
import { MobileModal } from './ui/MotionPrimitives.tsx';

type PackageType = 'TIME_BASED' | 'DATA_BASED' | 'HYBRID' | 'BANDWIDTH_PROFILE';

interface PackageItem {
  id: string;
  name: string;
  description: string | null;
  category: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  packageType?: PackageType;
  priceTzs: number;
  durationMinutes: number;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
  deviceLimit?: number;
  simultaneousSessions?: number;
  fupPolicy?: string | null;
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
  const [packageType, setPackageType] = useState<PackageType>('TIME_BASED');
  const [priceTzs, setPriceTzs] = useState('2000');
  const [durationMinutes, setDurationMinutes] = useState('1440');
  const [downloadKbps, setDownloadKbps] = useState('10000');
  const [uploadKbps, setUploadKbps] = useState('5000');
  const [dataLimitMb, setDataLimitMb] = useState('');
  const [deviceLimit, setDeviceLimit] = useState('1');
  const [simultaneousSessions, setSimultaneousSessions] = useState('1');
  const [fupPolicy, setFupPolicy] = useState('');
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
    setPackageType('TIME_BASED');
    setPriceTzs('2000');
    setDurationMinutes('1440');
    setDownloadKbps('10000');
    setUploadKbps('5000');
    setDataLimitMb('');
    setDeviceLimit('1');
    setSimultaneousSessions('1');
    setFupPolicy('');
    setValidityDays('30');
    setModalOpen(true);
  };

  const openEdit = (pkg: PackageItem) => {
    setEditing(pkg);
    setName(pkg.name);
    setDescription(pkg.description || '');
    setCategory(pkg.category);
    setPackageType(pkg.packageType || 'TIME_BASED');
    setPriceTzs(String(pkg.priceTzs));
    setDurationMinutes(String(pkg.durationMinutes));
    setDownloadKbps(String(pkg.downloadKbps));
    setUploadKbps(String(pkg.uploadKbps));
    setDataLimitMb(pkg.dataLimitMb ? String(pkg.dataLimitMb) : '');
    setDeviceLimit(String(pkg.deviceLimit ?? 1));
    setSimultaneousSessions(String(pkg.simultaneousSessions ?? 1));
    setFupPolicy(pkg.fupPolicy || '');
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
        packageType,
        priceTzs: Number(priceTzs),
        durationMinutes: Number(durationMinutes),
        downloadKbps: Number(downloadKbps),
        uploadKbps: Number(uploadKbps),
        dataLimitMb: dataLimitMb.trim() ? Number(dataLimitMb) : null,
        deviceLimit: Math.max(1, Number(deviceLimit) || 1),
        simultaneousSessions: Math.max(1, Number(simultaneousSessions) || 1),
        fupPolicy: fupPolicy.trim() || null,
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
        <div className="p-10 bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl text-center space-y-2">
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
              className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 flex flex-col justify-between space-y-4"
            >
              <div>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                      {pkg.category} · {(pkg.packageType || 'TIME_BASED').replace('_', ' ')} · {pkg.isActive ? 'Active' : 'Inactive'}
                    </p>
                    <h3 className="text-base font-bold mt-0.5">{pkg.name}</h3>
                  </div>
                  <p className="font-mono font-bold text-base tabular-nums text-[#9A7B00] dark:text-[#FFD400]">
                    {formatTzs(pkg.priceTzs)}
                  </p>
                </div>
                {pkg.description && (
                  <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-2">{pkg.description}</p>
                )}
                {pkg.fupPolicy && (
                  <p className="text-[11px] font-mono text-amber-600 dark:text-amber-400 mt-1">
                    FUP: {pkg.fupPolicy}
                  </p>
                )}
              </div>

              <div className="pt-3 border-t border-stone-100 dark:border-white/10 grid grid-cols-2 gap-2 text-xs tabular-nums">
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
                <div>
                  <span className="text-slate-500 dark:text-[#8793A5]">Devices: </span>
                  <span className="font-mono font-medium">{pkg.deviceLimit ?? 1}</span>
                </div>
                <div>
                  <span className="text-slate-500 dark:text-[#8793A5]">Sessions: </span>
                  <span className="font-mono font-medium">{pkg.simultaneousSessions ?? 1}</span>
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

      <MobileModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        maxWidthClass="max-w-lg"
        panelClassName="space-y-4"
        ariaLabel={editing ? 'Edit WiFi Package' : 'Create WiFi Package'}
      >
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
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block font-medium mb-1">Package Name</label>
                  <input
                    type="text"
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder="24H Express Fiber"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Cadence</label>
                  <select
                    value={category}
                    onChange={(e) => applyCategoryPreset(e.target.value as 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY')}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  >
                    <option value="HOURLY">Hourly</option>
                    <option value="DAILY">Daily</option>
                    <option value="WEEKLY">Weekly</option>
                    <option value="MONTHLY">Monthly</option>
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">Policy Type</label>
                  <select
                    value={packageType}
                    onChange={(e) => setPackageType(e.target.value as PackageType)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  >
                    <option value="TIME_BASED">Time Based</option>
                    <option value="DATA_BASED">Data Based</option>
                    <option value="HYBRID">Hybrid (Time + Data)</option>
                    <option value="BANDWIDTH_PROFILE">Bandwidth Profile</option>
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
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
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
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
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
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
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
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
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
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
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
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
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
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Device Limit</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    required
                    value={deviceLimit}
                    onChange={(e) => setDeviceLimit(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Simultaneous Sessions</label>
                  <input
                    type="number"
                    min={1}
                    max={50}
                    required
                    value={simultaneousSessions}
                    onChange={(e) => setSimultaneousSessions(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
              </div>
              <div>
                <label className="block font-medium mb-1">Fair Usage Policy (Optional)</label>
                <input
                  type="text"
                  value={fupPolicy}
                  onChange={(e) => setFupPolicy(e.target.value)}
                  placeholder="e.g. Throttle to 2 Mbps after 20 GB"
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
                  {saving ? 'Saving...' : 'Save Package'}
                </button>
              </div>
            </form>
      </MobileModal>
    </div>
  );
}
