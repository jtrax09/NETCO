import React, { useEffect, useState } from 'react';
import { CreditCard, MapPin, Plus, Trash2, X } from 'lucide-react';
import { apiRequest, formatTzs } from '../lib/api.ts';

interface LocationItem {
  id: string;
  name: string;
  region: string;
  address: string | null;
  contactName: string | null;
  isActive: number;
  routerCount: number;
  activeSubscriptions: number;
  createdAt: string;
}

interface BusinessSubData {
  business: {
    id: string;
    name: string;
    slug: string;
    email: string;
    phone: string;
    country: string;
    currency: string;
    status: string;
  };
  subscription: {
    id: string;
    status: string;
    billingCycle: string;
    currentPeriodStart: string;
    currentPeriodEnd: string;
    planCode: string;
    planName: string;
    priceMonthlyTzs: number;
    priceYearlyTzs: number;
    maxRouters: number;
    maxLocations: number;
    maxActiveCustomers: number;
  } | null;
  plans: Array<{
    id: string;
    code: string;
    name: string;
    priceMonthlyTzs: number;
    priceYearlyTzs: number;
    maxRouters: number;
    maxLocations: number;
    maxActiveCustomers: number;
  }>;
  saasPayments: Array<{
    id: string;
    reference: string;
    amountTzs: number;
    provider: string;
    status: string;
    paidAt: string | null;
    createdAt: string;
  }>;
}

interface Props {
  token: string;
  refreshTrigger: number;
  canManage: boolean;
}

export function LocationsView({ token, refreshTrigger, canManage }: Props) {
  const [locations, setLocations] = useState<LocationItem[]>([]);
  const [subData, setSubData] = useState<BusinessSubData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState('');
  const [region, setRegion] = useState('Dar es Salaam');
  const [address, setAddress] = useState('');
  const [contactName, setContactName] = useState('');
  const [saving, setSaving] = useState(false);

  const [billingCycle, setBillingCycle] = useState<'MONTHLY' | 'YEARLY'>('MONTHLY');
  const [payProvider, setPayProvider] = useState<'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA' | 'CARD'>('MPESA');
  const [checkingOut, setCheckingOut] = useState(false);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const [locRes, subRes] = await Promise.all([
        apiRequest<{ locations: LocationItem[] }>('/api/locations', { token }),
        apiRequest<BusinessSubData>('/api/business/subscription', { token }),
      ]);
      setLocations(locRes.locations);
      setSubData(subRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load locations & SaaS plan');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  const handleCreateLocation = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await apiRequest('/api/locations', {
        method: 'POST',
        token,
        body: {
          name: name.trim(),
          region: region.trim(),
          address: address.trim() || null,
          contactName: contactName.trim() || null,
        },
      });
      setModalOpen(false);
      setName('');
      setAddress('');
      setContactName('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to create location');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteLocation = async (id: string) => {
    try {
      setError(null);
      await apiRequest(`/api/locations/${id}`, { method: 'DELETE', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove location');
    }
  };

  const handleUpgradePlan = async (planCode: string) => {
    setCheckingOut(true);
    setError(null);
    setNotice(null);
    try {
      const res = await apiRequest<{ reference: string; amountTzs: number; planCode: string }>(
        '/api/business/subscription/checkout',
        {
          method: 'POST',
          token,
          body: { planCode, billingCycle, provider: payProvider },
        }
      );
      setNotice(`Subscription updated to ${res.planCode} (${formatTzs(res.amountTzs)} · Ref ${res.reference}).`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Plan checkout failed');
    } finally {
      setCheckingOut(false);
    }
  };

  return (
    <div className="space-y-6">
      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}
      {notice && (
        <div className="p-3 rounded-lg border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300 font-mono">
          {notice}
        </div>
      )}

      {/* Hotspot Locations Section */}
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">Hotspot Sites & Locations</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Segment MikroTik gateways, vouchers, and active subscriptions across physical hotspot branches.
            </p>
          </div>
          {canManage && (
            <button type="button" onClick={() => setModalOpen(true)} className="btn-primary text-xs">
              <Plus className="w-4 h-4" />
              Add Location
            </button>
          )}
        </div>

        {loading ? (
          <div className="p-6 text-center text-xs text-zinc-500">Loading locations...</div>
        ) : locations.length === 0 ? (
          <div className="p-8 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 text-center text-xs text-zinc-500">
            No hotspot locations configured yet.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {locations.map((loc) => (
              <div
                key={loc.id}
                className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 space-y-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="flex items-center gap-1.5">
                      <MapPin className="w-4 h-4 text-[#B8860B] dark:text-[#FFD400]" />
                      <h3 className="text-sm font-bold">{loc.name}</h3>
                    </div>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                      {loc.region} {loc.address ? `· ${loc.address}` : ''}
                    </p>
                  </div>
                  {canManage && locations.length > 1 && (
                    <button
                      type="button"
                      onClick={() => handleDeleteLocation(loc.id)}
                      aria-label="Remove location"
                      className="btn-chip-danger p-1.5"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <div className="pt-3 border-t border-stone-100 dark:border-zinc-800 flex items-center justify-between text-xs tabular-nums">
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {loc.routerCount} router(s) · {loc.activeSubscriptions} active sub(s)
                  </span>
                  {loc.contactName && <span className="font-mono text-zinc-500">{loc.contactName}</span>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* SaaS Subscription & Upgrade Section */}
      {subData && (
        <div className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 space-y-5">
          <div className="flex flex-wrap items-center justify-between gap-4 border-b border-stone-100 dark:border-zinc-800 pb-4">
            <div>
              <p className="text-xs font-mono text-[#B8860B] dark:text-[#FFD400]">
                {subData.business.name} · {subData.subscription?.status || 'TRIAL'}
              </p>
              <h3 className="text-base font-bold mt-0.5">
                Current TRAX LINK Plan: {subData.subscription?.planName || 'Starter'}
              </h3>
              {subData.subscription && (
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 tabular-nums">
                  Limits: {subData.subscription.maxRouters} routers · {subData.subscription.maxLocations} locations ·{' '}
                  {subData.subscription.maxActiveCustomers} customers · Period ends{' '}
                  {new Date(subData.subscription.currentPeriodEnd).toLocaleDateString()}
                </p>
              )}
            </div>

            {canManage && (
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <div className="btn-tab-group">
                  <button
                    type="button"
                    onClick={() => setBillingCycle('MONTHLY')}
                    className={billingCycle === 'MONTHLY' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    Monthly
                  </button>
                  <button
                    type="button"
                    onClick={() => setBillingCycle('YEARLY')}
                    className={billingCycle === 'YEARLY' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    Yearly
                  </button>
                </div>
                <select
                  value={payProvider}
                  onChange={(e) => setPayProvider(e.target.value as typeof payProvider)}
                  className="px-3 py-2 rounded-xl border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-xs"
                >
                  <option value="MPESA">M-Pesa</option>
                  <option value="AIRTEL_MONEY">Airtel Money</option>
                  <option value="TIGO_PESA">Yas / Tigo Pesa</option>
                  <option value="HALOPESA">HaloPesa</option>
                  <option value="CARD">Bank Card</option>
                </select>
              </div>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {subData.plans.map((pl) => {
              const price = billingCycle === 'YEARLY' ? pl.priceYearlyTzs : pl.priceMonthlyTzs;
              const isCurrent = subData.subscription?.planCode === pl.code;
              return (
                <div
                  key={pl.id}
                  className={`p-4 rounded-xl border space-y-3 ${
                    isCurrent
                      ? 'border-[#FFD400] bg-[#FFD400]/5'
                      : 'border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-[#101010]'
                  }`}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-bold text-sm">{pl.name}</span>
                    <span className="font-mono font-bold text-sm tabular-nums text-[#B8860B] dark:text-[#FFD400]">
                      {formatTzs(price)}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 tabular-nums">
                    Up to {pl.maxRouters} routers · {pl.maxLocations} sites · {pl.maxActiveCustomers} users
                  </p>
                  {canManage && (
                    <button
                      type="button"
                      disabled={checkingOut}
                      onClick={() => handleUpgradePlan(pl.code)}
                      className={isCurrent ? 'btn-secondary w-full text-xs' : 'btn-primary w-full text-xs'}
                    >
                      <CreditCard className="w-3.5 h-3.5" />
                      {isCurrent ? 'Renew Plan' : `Switch to ${pl.name}`}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-xl p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">Add Hotspot Location</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateLocation} className="space-y-3 text-xs">
              <div>
                <label className="block font-medium mb-1">Site Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Kariakoo Plaza WiFi"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Region / City</label>
                <input
                  type="text"
                  required
                  value={region}
                  onChange={(e) => setRegion(e.target.value)}
                  placeholder="Dar es Salaam"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Street Address (Optional)</label>
                <input
                  type="text"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="Msimbazi St"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div>
                <label className="block font-medium mb-1">Site Manager Contact (Optional)</label>
                <input
                  type="text"
                  value={contactName}
                  onChange={(e) => setContactName(e.target.value)}
                  placeholder="Juma Hassan"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setModalOpen(false)} className="btn-secondary text-xs">
                  Cancel
                </button>
                <button type="submit" disabled={saving} className="btn-primary text-xs">
                  {saving ? 'Saving...' : 'Create Location'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
