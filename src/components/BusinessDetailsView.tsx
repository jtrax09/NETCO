import React, { useEffect, useState } from 'react';
import {
  Building2,
  CheckCircle2,
  Clock,
  ExternalLink,
  Globe,
  Layers,
  Mail,
  MapPin,
  Package,
  Pencil,
  Phone,
  Radio,
  Router,
  Save,
  ShieldCheck,
  Users,
  Wifi,
  X,
} from 'lucide-react';
import { apiRequest, formatDurationMinutes, formatSpeed, formatTzs } from '../lib/api.ts';
import { TraxMark } from './NetcoLogo.tsx';
import { WifiConnectCard } from './WifiConnectCard.tsx';

interface BusinessDetailsResponse {
  business: {
    id: string;
    name: string;
    slug: string;
    email: string;
    phone: string;
    country: string;
    currency: 'TZS' | 'USD' | 'KES' | 'UGX';
    status: 'PENDING' | 'ACTIVE' | 'SUSPENDED';
    timezone: string;
    hotspotTitle: string | null;
    hotspotSupportPhone: string | null;
    description: string | null;
    physicalAddress: string | null;
    city: string | null;
    websiteUrl: string | null;
    supportHours: string | null;
    wifiSsid?: string | null;
    wifiGatewayIp?: string | null;
    wifiGatewayType?: string | null;
    autoSyncProfiles: boolean;
    createdAt: string;
    updatedAt: string;
  };
  operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
  plan: {
    planCode: string;
    planName: string;
    priceTzs: number;
    maxRouters: number;
    maxLocations: number;
    maxActiveCustomers: number;
    subscriptionStatus: string;
    billingCycle: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
  } | null;
  metrics: {
    locationsCount: number;
    routersCount: number;
    connectedRoutersCount: number;
    activePackagesCount: number;
    totalPackagesCount: number;
    activeCustomersCount: number;
    totalVouchersCount: number;
    activeSessionsCount: number;
    teamCount: number;
  };
  locations: Array<{
    id: string;
    name: string;
    region: string;
    address: string | null;
    gpsCoordinates: string | null;
    routerCount: number;
  }>;
  packagesSummary: Array<{
    id: string;
    name: string;
    category: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
    packageType: string;
    priceTzs: number;
    currency: string;
    durationMinutes: number;
    downloadKbps: number;
    uploadKbps: number;
    isActive: number;
  }>;
}

interface Props {
  token: string;
  canManage: boolean;
  refreshTrigger: number;
  onNavigate: (section: string) => void;
  onSaved: () => void;
}

function safeExternalUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}

export function BusinessDetailsView({ token, canManage, refreshTrigger, onNavigate, onSaved }: Props) {
  const [data, setData] = useState<BusinessDetailsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  const [physicalAddress, setPhysicalAddress] = useState('');
  const [hotspotTitle, setHotspotTitle] = useState('');
  const [hotspotSupportPhone, setHotspotSupportPhone] = useState('');
  const [supportHours, setSupportHours] = useState('');
  const [websiteUrl, setWebsiteUrl] = useState('');
  const [description, setDescription] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiRequest<BusinessDetailsResponse>('/api/business/details', { token });
      setData(res);
      const b = res.business;
      setName(b.name || '');
      setEmail(b.email || '');
      setPhone(b.phone || '');
      setCountry(b.country || 'Tanzania');
      setCity(b.city || '');
      setPhysicalAddress(b.physicalAddress || '');
      setHotspotTitle(b.hotspotTitle || '');
      setHotspotSupportPhone(b.hotspotSupportPhone || '');
      setSupportHours(b.supportHours || '');
      setWebsiteUrl(b.websiteUrl || '');
      setDescription(b.description || '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load business details');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  const handleSaveDetails = async (e: React.FormEvent) => {
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
          city: city.trim() || null,
          physicalAddress: physicalAddress.trim() || null,
          hotspotTitle: hotspotTitle.trim() || null,
          hotspotSupportPhone: hotspotSupportPhone.trim() || null,
          supportHours: supportHours.trim() || null,
          websiteUrl: websiteUrl.trim() || null,
          description: description.trim() || null,
        },
      });
      setEditing(false);
      setNotice('Business page details updated and published to the Customer Portal.');
      onSaved();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to save business details');
    } finally {
      setSaving(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="p-8 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 text-center text-xs text-slate-500 dark:text-[#8793A5]">
        Loading business details...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="p-6 rounded-xl bg-white dark:bg-[#161618] border border-red-300 dark:border-red-900/60 text-xs text-red-700 dark:text-red-300">
        {error || 'Business profile unavailable.'}
      </div>
    );
  }

  const { business, metrics, plan, locations, packagesSummary, operatingMode } = data;
  const safeWebsite = safeExternalUrl(business.websiteUrl);
  const locationParts = [business.city, business.country].filter(Boolean).join(', ');

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

      {/* Business Identity Hero */}
      <section className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 flex flex-col lg:flex-row lg:items-center justify-between gap-5">
        <div className="flex items-start gap-4 min-w-0">
          <TraxMark className="w-14 h-14 shrink-0" />
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-xl sm:text-2xl font-display font-bold tracking-tight text-slate-900 dark:text-white truncate">
                {business.name}
              </h1>
              <span
                className={`text-[11px] font-mono font-semibold ${
                  business.status === 'ACTIVE'
                    ? 'text-emerald-600 dark:text-emerald-400'
                    : 'text-amber-600 dark:text-amber-400'
                }`}
              >
                {business.status}
              </span>
              <span className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5]">
                /{business.slug}
              </span>
            </div>

            <p className="text-xs sm:text-sm text-slate-600 dark:text-zinc-300 max-w-2xl leading-relaxed">
              {business.description ||
                'Manage your ISP storefront identity, customer support contact points, coverage zones, and published WiFi plans from one place.'}
            </p>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 pt-1 text-xs text-slate-500 dark:text-[#8793A5] tabular-nums">
              <span className="inline-flex items-center gap-1.5">
                <Wifi className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400]" />
                Portal: <strong className="text-slate-900 dark:text-white">{business.hotspotTitle || business.name}</strong>
              </span>
              {locationParts && (
                <span className="inline-flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  {locationParts}
                </span>
              )}
              <span className="inline-flex items-center gap-1.5 font-mono">
                <Globe className="w-3.5 h-3.5" />
                {business.currency} · {business.timezone}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {canManage && (
            <button
              type="button"
              onClick={() => setEditing((v) => !v)}
              className="btn-primary text-xs"
            >
              {editing ? <X className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
              {editing ? 'Cancel Edit' : 'Edit Business Details'}
            </button>
          )}
          <button
            type="button"
            onClick={() => onNavigate('settings')}
            className="btn-secondary text-xs"
          >
            Workspace Settings
          </button>
        </div>
      </section>

      {/* Inline Edit Drawer */}
      {editing && canManage && (
        <form
          onSubmit={handleSaveDetails}
          className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-[#FFD400]/45 space-y-4 text-xs"
        >
          <div className="flex items-center justify-between border-b border-stone-100 dark:border-white/10 pb-3">
            <div>
              <h2 className="text-sm font-bold text-slate-900 dark:text-white">Edit Business Page Details</h2>
              <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
                Updates appear immediately in this console and on the public Customer Portal.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block font-medium mb-1">Business Name</label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              />
            </div>
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
              <label className="block font-medium mb-1">Contact Email</label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
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
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
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
              <label className="block font-medium mb-1">Country</label>
              <input
                type="text"
                required
                value={country}
                onChange={(e) => setCountry(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
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
              <label className="block font-medium mb-1">Website (https://)</label>
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

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
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
              <label className="block font-medium mb-1">About / Business Description</label>
              <input
                type="text"
                maxLength={400}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="High-speed prepaid WiFi zones for campuses, offices, and residences."
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              />
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setEditing(false)} className="btn-secondary text-xs">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary text-xs">
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save Business Details'}
            </button>
          </div>
        </form>
      )}

      {/* Workspace Operational KPIs */}
      <section className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 tabular-nums">
        <div className="p-4 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <span className="text-xs text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Package className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400]" />
            Active Packages
          </span>
          <p className="text-xl font-bold font-mono mt-1.5">
            {metrics.activePackagesCount}
            <span className="text-xs font-normal text-slate-500 dark:text-[#8793A5]"> / {metrics.totalPackagesCount}</span>
          </p>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <span className="text-xs text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5 text-sky-500" />
            Service Locations
          </span>
          <p className="text-xl font-bold font-mono mt-1.5">{metrics.locationsCount}</p>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <span className="text-xs text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Router className="w-3.5 h-3.5 text-emerald-500" />
            MikroTik Routers
          </span>
          <p className="text-xl font-bold font-mono mt-1.5">
            {metrics.connectedRoutersCount}
            <span className="text-xs font-normal text-slate-500 dark:text-[#8793A5]"> / {metrics.routersCount}</span>
          </p>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10">
          <span className="text-xs text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5 text-violet-500" />
            Subscribers
          </span>
          <p className="text-xl font-bold font-mono mt-1.5">
            {metrics.activeCustomersCount}
            <span className="text-xs font-normal text-slate-500 dark:text-[#8793A5]"> · {metrics.activeSessionsCount} live</span>
          </p>
        </div>

        <div className="p-4 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 col-span-2 sm:col-span-1">
          <span className="text-xs text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-amber-500" />
            Team & Vouchers
          </span>
          <p className="text-xl font-bold font-mono mt-1.5">
            {metrics.teamCount}
            <span className="text-xs font-normal text-slate-500 dark:text-[#8793A5]"> staff · {metrics.totalVouchersCount} codes</span>
          </p>
        </div>
      </section>

      {/* Main Details Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Contact & Coverage Locations */}
        <div className="lg:col-span-7 space-y-6">
          <section className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-stone-100 dark:border-white/10">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <Building2 className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
                Business Contact & Storefront Information
              </h2>
              <span className="font-mono text-[11px] text-slate-500 dark:text-[#8793A5]">
                Since {new Date(business.createdAt).toLocaleDateString()}
              </span>
            </div>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
              <div className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <dt className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                  <Mail className="w-3.5 h-3.5" />
                  Primary Email
                </dt>
                <dd className="font-mono font-semibold text-slate-900 dark:text-white mt-1 break-all">
                  {business.email}
                </dd>
              </div>

              <div className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <dt className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                  <Phone className="w-3.5 h-3.5" />
                  Business & Support Phone
                </dt>
                <dd className="font-mono font-semibold text-slate-900 dark:text-white mt-1 tabular-nums">
                  {business.phone}
                  {business.hotspotSupportPhone && business.hotspotSupportPhone !== business.phone
                    ? ` · Support: ${business.hotspotSupportPhone}`
                    : ''}
                </dd>
              </div>

              <div className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <dt className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" />
                  Office / Physical Address
                </dt>
                <dd className="font-medium text-slate-900 dark:text-white mt-1">
                  {business.physicalAddress || locationParts || 'Not specified'}
                </dd>
              </div>

              <div className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <dt className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5" />
                  Customer Support Hours
                </dt>
                <dd className="font-medium text-slate-900 dark:text-white mt-1">
                  {business.supportHours || 'Mon–Sun · Standard Business Hours'}
                </dd>
              </div>

              <div className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10 sm:col-span-2">
                <dt className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
                  <Globe className="w-3.5 h-3.5" />
                  Official Website
                </dt>
                <dd className="mt-1 font-mono">
                  {safeWebsite ? (
                    <a
                      href={safeWebsite}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 font-semibold text-[#9A7B00] dark:text-[#FFD400] hover:underline break-all"
                    >
                      <span>{safeWebsite}</span>
                      <ExternalLink className="w-3.5 h-3.5 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-slate-500 dark:text-[#8793A5] font-sans">
                      No website configured
                    </span>
                  )}
                </dd>
              </div>
            </dl>
          </section>

          <section className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-stone-100 dark:border-white/10">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <MapPin className="w-4 h-4 text-sky-500" />
                Hotspot Coverage Locations ({locations.length})
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('locations')}
                className="text-xs font-semibold text-[#9A7B00] dark:text-[#FFD400] hover:underline"
              >
                Manage Locations
              </button>
            </div>

            {locations.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5] py-2">
                No coverage zones added yet. Add sites in Locations to organize routers and customer traffic.
              </p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                {locations.map((loc) => (
                  <div
                    key={loc.id}
                    className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10 space-y-1"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-slate-900 dark:text-white truncate">{loc.name}</span>
                      <span className="font-mono text-[11px] text-slate-500 dark:text-[#8793A5] tabular-nums shrink-0">
                        {loc.routerCount} router(s)
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
                      {loc.region}{loc.address ? ` · ${loc.address}` : ''}
                    </p>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: Active WiFi Plans, SaaS Subscription & Hardware Sync */}
        <div className="lg:col-span-5 space-y-6">
          <section className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4">
            <div className="flex items-center justify-between gap-2 pb-3 border-b border-stone-100 dark:border-white/10">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <Package className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
                Published WiFi Plans ({packagesSummary.length})
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('packages')}
                className="text-xs font-semibold text-[#9A7B00] dark:text-[#FFD400] hover:underline"
              >
                Manage Plans
              </button>
            </div>

            {packagesSummary.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                No active WiFi packages published to the Customer Portal yet.
              </p>
            ) : (
              <div className="divide-y divide-stone-100 dark:divide-white/10 text-xs tabular-nums">
                {packagesSummary.slice(0, 6).map((pkg) => (
                  <div key={pkg.id} className="py-2.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-white truncate">{pkg.name}</p>
                      <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
                        {formatDurationMinutes(pkg.durationMinutes)} · {formatSpeed(pkg.downloadKbps)}
                      </p>
                    </div>
                    <span className="font-mono font-bold text-[#9A7B00] dark:text-[#FFD400] shrink-0">
                      {formatTzs(pkg.priceTzs)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {plan && (
            <section className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4 text-xs tabular-nums">
              <div className="flex items-center justify-between gap-2 pb-3 border-b border-stone-100 dark:border-white/10">
                <h2 className="text-sm font-bold flex items-center gap-2">
                  <ShieldCheck className="w-4 h-4 text-emerald-500" />
                  SaaS Plan: {plan.planName}
                </h2>
                <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                  {plan.subscriptionStatus}
                </span>
              </div>
              <div className="space-y-2.5">
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-[#8793A5]">Locations Quota</span>
                  <span className="font-mono font-semibold">
                    {metrics.locationsCount} / {plan.maxLocations}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-[#8793A5]">Routers Quota</span>
                  <span className="font-mono font-semibold">
                    {metrics.routersCount} / {plan.maxRouters}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500 dark:text-[#8793A5]">Subscribers Quota</span>
                  <span className="font-mono font-semibold">
                    {metrics.activeCustomersCount} / {plan.maxActiveCustomers}
                  </span>
                </div>
                <div className="flex justify-between pt-2 border-t border-stone-100 dark:border-white/10">
                  <span className="text-slate-500 dark:text-[#8793A5]">Billing Cycle</span>
                  <span className="font-mono font-semibold">{plan.billingCycle}</span>
                </div>
              </div>
            </section>
          )}

          <section className="p-5 sm:p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-sm font-bold flex items-center gap-2">
                <Radio className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
                Network & Profile Automation
              </h2>
              <button
                type="button"
                onClick={() => onNavigate('routers')}
                className="text-xs font-semibold text-[#9A7B00] dark:text-[#FFD400] hover:underline"
              >
                Open Routers
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 pt-1">
              <div className="p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <span className="text-[11px] text-slate-500 dark:text-[#8793A5] block">Operating Mode</span>
                <span className="font-mono font-semibold mt-0.5 block">
                  {operatingMode === 'MIKROTIK_MODE' ? 'MikroTik Mode' : 'Standalone Mode'}
                </span>
              </div>
              <div className="p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <span className="text-[11px] text-slate-500 dark:text-[#8793A5] block">Auto-Sync Profiles</span>
                <span
                  className={`font-mono font-semibold mt-0.5 block ${
                    business.autoSyncProfiles
                      ? 'text-emerald-600 dark:text-emerald-400'
                      : 'text-slate-600 dark:text-zinc-300'
                  }`}
                >
                  {business.autoSyncProfiles ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
            {business.wifiSsid && (
              <div className="p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10">
                <span className="text-[11px] text-slate-500 dark:text-[#8793A5] block">Linked WiFi Network</span>
                <span className="font-mono font-semibold mt-0.5 block text-emerald-600 dark:text-emerald-400">
                  {business.wifiSsid}
                  {business.wifiGatewayIp ? ` · ${business.wifiGatewayIp}` : ''}
                </span>
              </div>
            )}
          </section>

          <WifiConnectCard
            token={token}
            canManage={canManage}
            refreshTrigger={refreshTrigger}
            compact={true}
            onConnected={() => {
              onSaved();
              void load();
            }}
          />
        </div>
      </div>
    </div>
  );
}
