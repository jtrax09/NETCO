import React, { useEffect, useState } from 'react';
import { Building2, CheckCircle2, Globe, Phone, Radio, Save, ShieldCheck, Wifi } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';

interface BusinessSettingsData {
  settings: {
    id: string;
    name: string;
    slug: string;
    email: string;
    phone: string;
    country: string;
    currency: 'TZS' | 'USD' | 'KES' | 'UGX';
    status: string;
    timezone: string;
    hotspotTitle: string | null;
    hotspotSupportPhone: string | null;
    description?: string | null;
    physicalAddress?: string | null;
    city?: string | null;
    websiteUrl?: string | null;
    supportHours?: string | null;
    autoSyncProfiles?: boolean;
    createdAt: string;
    updatedAt: string;
  };
  operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
  plan: {
    planCode: string;
    planName: string;
    maxRouters: number;
    maxLocations: number;
    maxActiveCustomers: number;
    subscriptionStatus: string;
  } | null;
  usage: {
    routers: number;
    locations: number;
    customers: number;
  };
}

interface Props {
  token: string;
  userRole: string;
  refreshTrigger: number;
  onSaved: () => void;
}

const TIMEZONE_OPTIONS = [
  'Africa/Dar_es_Salaam',
  'Africa/Nairobi',
  'Africa/Kampala',
  'Africa/Kigali',
  'UTC',
];

export function SettingsView({ token, userRole, refreshTrigger, onSaved }: Props) {
  const [data, setData] = useState<BusinessSettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('Tanzania');
  const [currency, setCurrency] = useState<'TZS' | 'USD' | 'KES' | 'UGX'>('TZS');
  const [timezone, setTimezone] = useState('Africa/Dar_es_Salaam');
  const [hotspotTitle, setHotspotTitle] = useState('');
  const [hotspotSupportPhone, setHotspotSupportPhone] = useState('');
  const [description, setDescription] = useState('');
  const [physicalAddress, setPhysicalAddress] = useState('');
  const [city, setCity] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [supportHours, setSupportHours] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<BusinessSettingsData>('/api/business/settings', { token });
      setData(res);
      setName(res.settings.name || '');
      setEmail(res.settings.email || '');
      setPhone(res.settings.phone || '');
      setCountry(res.settings.country || 'Tanzania');
      setCurrency((res.settings.currency as 'TZS' | 'USD' | 'KES' | 'UGX') || 'TZS');
      setTimezone(res.settings.timezone || 'Africa/Dar_es_Salaam');
      setHotspotTitle(res.settings.hotspotTitle || '');
      setHotspotSupportPhone(res.settings.hotspotSupportPhone || '');
      setDescription(res.settings.description || '');
      setPhysicalAddress(res.settings.physicalAddress || '');
      setCity(res.settings.city || '');
      setWebsiteUrl(res.settings.websiteUrl || '');
      setSupportHours(res.settings.supportHours || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load business settings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/api/business/settings', {
        method: 'PATCH',
        token,
        body: {
          name: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          country: country.trim(),
          currency,
          timezone: timezone.trim(),
          hotspotTitle: hotspotTitle.trim() || null,
          hotspotSupportPhone: hotspotSupportPhone.trim() || null,
          description: description.trim() || null,
          physicalAddress: physicalAddress.trim() || null,
          city: city.trim() || null,
          websiteUrl: websiteUrl.trim() || null,
          supportHours: supportHours.trim() || null,
        },
      });
      setNotice('Business settings saved and synchronized with the Customer Portal.');
      onSaved();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update business settings');
    } finally {
      setSaving(false);
    }
  };

  const handleOperatingModeChange = async (mode: 'STANDALONE_MODE' | 'MIKROTIK_MODE') => {
    setSwitchingMode(true);
    setError(null);
    setNotice(null);
    try {
      await apiRequest('/api/system/mode', {
        method: 'PATCH',
        token,
        body: { operatingMode: mode },
      });
      setNotice(
        mode === 'MIKROTIK_MODE'
          ? 'Platform operating mode switched to MikroTik Mode.'
          : 'Platform operating mode switched to Standalone Mode.'
      );
      onSaved();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update operating mode');
    } finally {
      setSwitchingMode(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="p-8 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 text-center text-xs text-slate-500 dark:text-[#8793A5]">
        Loading business settings...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-lg border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300 flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{notice}</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <form
          onSubmit={handleSave}
          className="lg:col-span-8 p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-5"
        >
          <div className="flex flex-wrap items-center justify-between gap-2 pb-4 border-b border-stone-100 dark:border-white/10">
            <div>
              <h2 className="text-base font-bold">Workspace Profile & Captive Portal Branding</h2>
              <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-0.5">
                Configure your ISP identity, billing currency, timezone, and WiFi customer storefront branding.
              </p>
            </div>
            {data && (
              <span className="font-mono text-xs text-slate-500 dark:text-[#8793A5]">
                Slug: {data.settings.slug} · {data.settings.status}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
            <div>
              <label className="block font-medium mb-1">Business / ISP Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="TRAX LINK Tanzania"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              />
            </div>

            <div>
              <label className="block font-medium mb-1">Contact Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="ops@traxlink.co.tz"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              />
            </div>

            <div>
              <label className="block font-medium mb-1">Business Phone</label>
              <input
                type="tel"
                required
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="+255 754 000 000"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              />
            </div>

            <div>
              <label className="block font-medium mb-1">Country</label>
              <input
                type="text"
                required
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                placeholder="Tanzania"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              />
            </div>

            <div>
              <label className="block font-medium mb-1">Default Billing Currency</label>
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value as 'TZS' | 'USD' | 'KES' | 'UGX')}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              >
                <option value="TZS">TZS (Tanzanian Shilling)</option>
                <option value="KES">KES (Kenyan Shilling)</option>
                <option value="UGX">UGX (Ugandan Shilling)</option>
                <option value="USD">USD (US Dollar)</option>
              </select>
            </div>

            <div>
              <label className="block font-medium mb-1">Timezone</label>
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              >
                {TIMEZONE_OPTIONS.map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="pt-4 border-t border-stone-100 dark:border-white/10 space-y-4 text-xs">
            <div>
              <h3 className="text-sm font-semibold">Customer Captive Portal Display</h3>
              <p className="text-slate-500 dark:text-[#8793A5] mt-0.5">
                Displayed directly on the customer voucher storefront when visitors select your hotspot network.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block font-medium mb-1">Hotspot Portal Title</label>
                <input
                  type="text"
                  maxLength={80}
                  value={hotspotTitle}
                  onChange={(e) => setHotspotTitle(e.target.value)}
                  placeholder={name || 'TRAX LINK WiFi'}
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">Customer Support Phone</label>
                <input
                  type="tel"
                  maxLength={24}
                  value={hotspotSupportPhone}
                  onChange={(e) => setHotspotSupportPhone(e.target.value)}
                  placeholder="0754 123 456"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">City / Region</label>
                <input
                  type="text"
                  maxLength={80}
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Dar es Salaam"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">Support Hours</label>
                <input
                  type="text"
                  maxLength={100}
                  value={supportHours}
                  onChange={(e) => setSupportHours(e.target.value)}
                  placeholder="Mon–Sun · 07:00 – 22:00 EAT"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">Physical Address</label>
                <input
                  type="text"
                  maxLength={180}
                  value={physicalAddress}
                  onChange={(e) => setPhysicalAddress(e.target.value)}
                  placeholder="Samora Ave, Plot 14"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>

              <div>
                <label className="block font-medium mb-1">Business Website (https://)</label>
                <input
                  type="url"
                  maxLength={240}
                  value={websiteUrl}
                  onChange={(e) => setWebsiteUrl(e.target.value)}
                  placeholder="https://example.co.tz"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
            </div>

            <div>
              <label className="block font-medium mb-1">About / Business Page Description</label>
              <textarea
                rows={2}
                maxLength={400}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Fast, reliable prepaid WiFi coverage across campuses, lounges, and residential zones."
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              />
            </div>
          </div>

          <div className="flex justify-end pt-2">
            <button type="submit" disabled={saving} className="btn-primary text-xs">
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving Settings...' : 'Save Business Settings'}
            </button>
          </div>
        </form>

        <div className="lg:col-span-4 space-y-4">
          {/* Live Storefront Branding Preview */}
          <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-3 text-xs">
            <div className="flex items-center gap-2 text-slate-500 dark:text-[#8793A5]">
              <Wifi className="w-4 h-4 text-[#B8860B] dark:text-[#FFD400]" />
              <span className="font-semibold text-slate-900 dark:text-white">Portal Header Preview</span>
            </div>
            <div className="p-4 rounded-xl bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 space-y-2">
              <p className="text-sm font-bold text-slate-900 dark:text-white truncate">
                {hotspotTitle.trim() || name.trim() || 'TRAX LINK WiFi'}
              </p>
              <p className="text-[11px] text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5 shrink-0" />
                <span className="truncate">{name.trim() || 'Business Workspace'}</span>
              </p>
              {(hotspotSupportPhone.trim() || phone.trim()) && (
                <p className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5 shrink-0" />
                  <span>Support: {hotspotSupportPhone.trim() || phone.trim()}</span>
                </p>
              )}
              <p className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                <Globe className="w-3.5 h-3.5 shrink-0" />
                <span>{country || 'Tanzania'} · {currency}</span>
              </p>
            </div>
          </div>

          {/* SaaS Plan Quota Usage */}
          {data?.plan && (
            <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-3 text-xs tabular-nums">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <ShieldCheck className="w-4 h-4 text-[#B8860B] dark:text-[#FFD400]" />
                  {data.plan.planName}
                </span>
                <span className="font-mono text-emerald-600 dark:text-emerald-400 font-semibold">
                  {data.plan.subscriptionStatus}
                </span>
              </div>
              <div className="space-y-2 pt-2 border-t border-stone-100 dark:border-white/10">
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-[#8793A5]">Locations Used</span>
                  <span className="font-mono font-semibold">
                    {data.usage.locations} / {data.plan.maxLocations}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-[#8793A5]">MikroTik Routers</span>
                  <span className="font-mono font-semibold">
                    {data.usage.routers} / {data.plan.maxRouters}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-[#8793A5]">Subscriber Profiles</span>
                  <span className="font-mono font-semibold">
                    {data.usage.customers} / {data.plan.maxActiveCustomers}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* System Operating Mode */}
          {data && (
            <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-3 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-1.5">
                  <Radio className="w-4 h-4 text-[#B8860B] dark:text-[#FFD400]" />
                  Network Mode
                </span>
                <span className="font-mono text-[11px] font-semibold text-[#9A7B00] dark:text-[#FFD400]">
                  {data.operatingMode === 'MIKROTIK_MODE' ? 'MIKROTIK' : 'STANDALONE'}
                </span>
              </div>
              <p className="text-slate-500 dark:text-[#8793A5] leading-relaxed">
                {data.operatingMode === 'MIKROTIK_MODE'
                  ? 'MikroTik Mode activates RouterOS binary API profile sync, live session termination, and WireGuard + FreeRADIUS enforcement.'
                  : 'Standalone Mode operates without MikroTik RouterOS hardware, managing voucher tokens and timers in software.'}
              </p>
              {userRole === 'SUPER_ADMIN' && (
                <div className="btn-tab-group w-full grid grid-cols-2">
                  <button
                    type="button"
                    disabled={switchingMode}
                    onClick={() => handleOperatingModeChange('STANDALONE_MODE')}
                    className={data.operatingMode === 'STANDALONE_MODE' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    Standalone
                  </button>
                  <button
                    type="button"
                    disabled={switchingMode}
                    onClick={() => handleOperatingModeChange('MIKROTIK_MODE')}
                    className={data.operatingMode === 'MIKROTIK_MODE' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    MikroTik
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
