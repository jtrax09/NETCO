import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  KeyRound,
  LogOut,
  Moon,
  Phone,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Sun,
  Ticket,
  Wifi,
} from 'lucide-react';
import {
  apiRequest,
  formatCountdown,
  formatSpeed,
  formatTzs,
} from '../lib/api.ts';
import { formatDurationLocalized, TRANSLATIONS, type AppLanguage } from '../lib/i18n.ts';
import { PAYMENT_PROVIDER_BRANDS } from '../lib/paymentProviders.ts';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';
import { NetcoLogo } from './NetcoLogo.tsx';

interface PortalPackage {
  id: string;
  name: string;
  description: string | null;
  category: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  priceTzs: number;
  durationMinutes: number;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
}

interface ProviderInfo {
  provider: 'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA';
  displayName: string;
  configured: boolean;
  missingCredentials: string[];
}

interface PendingPayment {
  reference: string;
  provider: string;
  phoneNumber: string;
  packageName: string;
  amountTzs: number;
  status: string;
  isTest?: boolean;
  paymentMode?: string;
  providerConfigured: boolean;
  missingCredentials: string[];
  message: string;
  receiptNumber?: string | null;
  voucherCode?: string | null;
}

interface VoucherValidation {
  valid: boolean;
  status: string;
  codeMasked: string;
  packageName: string;
  category: string;
  priceTzs: number;
  durationMinutes: number;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
  isBoundToDevice: boolean;
  boundDeviceName?: string | null;
  isTest: boolean;
  testNote: string | null;
  createdAt: string;
  activatedAt: string | null;
  expiresAt: string | null;
  revokedReason: string | null;
}

interface ActiveCustomerSession {
  sessionId: string;
  sessionToken?: string;
  status: string;
  codeMasked: string;
  packageName: string;
  category: string;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
  startedAt: string;
  expiresAt: string;
  endedAt?: string | null;
  endReason?: string | null;
  remainingSeconds?: number;
  deviceLabel?: string;
  isTest?: boolean;
  operatingMode?: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
}

interface Props {
  onSwitchToAdmin: () => void;
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
  lang: AppLanguage;
  onToggleLang: () => void;
}

function getOrCreateDeviceFingerprint(): string {
  const storageKey = 'netco_device_fp';
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing && existing.length >= 12) return existing;
    const rand =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const screenInfo = typeof window !== 'undefined' ? `${window.screen?.width || 0}x${window.screen?.height || 0}` : '0x0';
    const fp = `ncd-${rand}-${screenInfo}`;
    window.localStorage.setItem(storageKey, fp);
    return fp;
  } catch {
    return `ncd-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

export function PortalView({ onSwitchToAdmin, theme, onToggleTheme, lang, onToggleLang }: Props) {
  const t = TRANSLATIONS[lang].portal;
  const [activeTab, setActiveTab] = useState<'buy' | 'connect'>('buy');
  const [operatingMode, setOperatingMode] = useState<'STANDALONE_MODE' | 'MIKROTIK_MODE'>('STANDALONE_MODE');

  const [packages, setPackages] = useState<PortalPackage[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadingPkgs, setLoadingPkgs] = useState(true);

  // Buy Voucher State
  const [selectedPkgId, setSelectedPkgId] = useState<string>('');
  const [provider, setProvider] = useState<'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA'>('MPESA');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [paying, setPaying] = useState(false);
  const [confirmingTest, setConfirmingTest] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null);
  const [lookupRef, setLookupRef] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);
  const [heroImgFailed, setHeroImgFailed] = useState(false);

  // Use / Validate Token & Customer Session State
  const [voucherInput, setVoucherInput] = useState('');
  const [deviceLabel, setDeviceLabel] = useState('');
  const [validating, setValidating] = useState(false);
  const [activating, setActivating] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [tokenNotice, setTokenNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<VoucherValidation | null>(null);
  const [portalSession, setPortalSession] = useState<ActiveCustomerSession | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);

  const loadPortalCatalog = async () => {
    setLoadingPkgs(true);
    try {
      const [pkgRes, provRes, modeRes] = await Promise.all([
        apiRequest<{ packages: PortalPackage[] }>('/api/portal/packages'),
        apiRequest<{ providers: ProviderInfo[] }>('/api/portal/providers'),
        apiRequest<{ operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE' }>('/api/system/mode').catch(() => ({
          operatingMode: 'STANDALONE_MODE' as const,
        })),
      ]);
      setPackages(pkgRes.packages);
      setProviders(provRes.providers);
      setOperatingMode(modeRes.operatingMode);
      if (pkgRes.packages.length > 0 && !selectedPkgId) {
        setSelectedPkgId(pkgRes.packages[0].id);
      }
    } catch (err) {
      console.error('Failed loading portal catalog', err);
    } finally {
      setLoadingPkgs(false);
    }
  };

  const restoreExistingSession = async () => {
    try {
      const savedToken = window.localStorage.getItem('netco_portal_session');
      if (!savedToken) return;
      const res = await apiRequest<{ session: ActiveCustomerSession }>('/api/portal/session', {
        headers: { 'X-Portal-Session': savedToken },
      });
      if (res.session.status === 'ACTIVE') {
        setPortalSession({ ...res.session, sessionToken: savedToken });
      } else {
        window.localStorage.removeItem('netco_portal_session');
      }
    } catch {
      try {
        window.localStorage.removeItem('netco_portal_session');
      } catch {
        // ignore
      }
    }
  };

  useEffect(() => {
    void loadPortalCatalog();
    void restoreExistingSession();
  }, []);

  // Countdown tick for active customer session
  useEffect(() => {
    if (!portalSession || portalSession.status !== 'ACTIVE') {
      setRemainingSeconds(0);
      return;
    }
    const updateTick = () => {
      const diff = Math.max(0, Math.floor((new Date(portalSession.expiresAt).getTime() - Date.now()) / 1000));
      setRemainingSeconds(diff);
      if (diff <= 0) {
        setPortalSession((prev) => (prev ? { ...prev, status: 'EXPIRED' } : null));
        try {
          window.localStorage.removeItem('netco_portal_session');
        } catch {
          // ignore
        }
      }
    };
    updateTick();
    const timer = window.setInterval(updateTick, 1000);
    return () => window.clearInterval(timer);
  }, [portalSession?.expiresAt, portalSession?.status]);

  // Auto-poll payment status when live gateway webhook is awaited
  useEffect(() => {
    if (!pendingPayment || pendingPayment.status !== 'PENDING' || !pendingPayment.providerConfigured) {
      return;
    }
    const timer = window.setInterval(async () => {
      try {
        const res = await apiRequest<{ payment: PendingPayment }>(
          `/api/portal/payments/${encodeURIComponent(pendingPayment.reference)}`
        );
        if (res.payment.status !== 'PENDING') {
          setPendingPayment({
            ...res.payment,
            providerConfigured: true,
            missingCredentials: [],
            message:
              res.payment.status === 'COMPLETED' && res.payment.voucherCode
                ? t.verifiedMsg
                : t.statusMsg(res.payment.status),
          });
        }
      } catch {
        // ignore transient poll errors
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [pendingPayment?.reference, pendingPayment?.status, pendingPayment?.providerConfigured, lang]);

  const handleInitiatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setPaymentError(null);
    setPaying(true);
    try {
      const res = await apiRequest<{ payment: PendingPayment }>('/api/portal/payments/initiate', {
        method: 'POST',
        body: {
          packageId: selectedPkgId,
          provider,
          phoneNumber,
        },
      });
      setPendingPayment(res.payment);
      setLookupRef(res.payment.reference);
      setCopiedCode(false);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : 'Unable to initiate payment');
    } finally {
      setPaying(false);
    }
  };

  const handleConfirmStandalonePayment = async (reference: string) => {
    setConfirmingTest(true);
    setPaymentError(null);
    try {
      const res = await apiRequest<{
        payment: {
          reference: string;
          provider: string;
          phoneNumber: string;
          packageName: string;
          amountTzs: number;
          status: string;
          isTest: boolean;
          receiptNumber: string | null;
          voucherCode: string | null;
        };
      }>(`/api/portal/payments/${encodeURIComponent(reference)}/confirm-test`, {
        method: 'POST',
      });
      setPendingPayment({
        ...res.payment,
        providerConfigured: false,
        missingCredentials: [],
        paymentMode: 'STANDALONE_TEST',
        message: t.verifiedMsg,
      });
      setCopiedCode(false);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : 'Unable to confirm payment');
    } finally {
      setConfirmingTest(false);
    }
  };

  const handleCheckPaymentStatus = async (refCode?: string) => {
    const targetRef = (refCode ?? lookupRef).trim();
    if (!targetRef) return;
    setPaymentError(null);
    try {
      const res = await apiRequest<{ payment: PendingPayment }>(
        `/api/portal/payments/${encodeURIComponent(targetRef)}`
      );
      const provConfigured = Boolean(providers.find((p) => p.provider === res.payment.provider)?.configured);
      setPendingPayment({
        ...res.payment,
        providerConfigured: provConfigured,
        missingCredentials: [],
        message:
          res.payment.status === 'COMPLETED' && res.payment.voucherCode
            ? t.verifiedMsg
            : t.statusMsg(res.payment.status),
      });
      setCopiedCode(false);
    } catch (err) {
      setPaymentError(err instanceof Error ? err.message : 'Reference not found');
    }
  };

  const handleCopyVoucher = async (code: string) => {
    try {
      await navigator.clipboard.writeText(code);
      setCopiedCode(true);
      setTimeout(() => setCopiedCode(false), 2000);
    } catch {
      setCopiedCode(false);
    }
  };

  const handleValidateVoucher = async (codeOverride?: string) => {
    const target = (codeOverride ?? voucherInput).trim();
    if (!target) return;
    setValidating(true);
    setTokenError(null);
    setTokenNotice(null);
    try {
      const res = await apiRequest<{ validation: VoucherValidation }>('/api/portal/validate', {
        method: 'POST',
        body: { code: target },
      });
      setValidation(res.validation);
    } catch (err) {
      setValidation(null);
      setTokenError(err instanceof Error ? err.message : 'Unable to validate voucher token');
    } finally {
      setValidating(false);
    }
  };

  const handleRedeemVoucher = async (codeOverride?: string) => {
    const target = (codeOverride ?? voucherInput).trim();
    if (!target) return;
    const cleanName = deviceLabel.trim();
    if (cleanName.length < 2) {
      setTokenError(t.deviceNameRequiredError);
      return;
    }
    setActivating(true);
    setTokenError(null);
    setTokenNotice(null);
    try {
      const fp = getOrCreateDeviceFingerprint();
      const res = await apiRequest<{ session: ActiveCustomerSession }>('/api/portal/redeem', {
        method: 'POST',
        body: {
          code: target,
          deviceFingerprint: fp,
          deviceLabel: cleanName,
        },
      });
      setPortalSession(res.session);
      if (res.session.sessionToken) {
        try {
          window.localStorage.setItem('netco_portal_session', res.session.sessionToken);
        } catch {
          // ignore
        }
      }
      void handleValidateVoucher(target);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Unable to activate voucher token');
    } finally {
      setActivating(false);
    }
  };

  const handleActivateTokenDirectly = async (code: string) => {
    setVoucherInput(code);
    setActiveTab('connect');
    setTokenError(null);
    if (deviceLabel.trim().length >= 2) {
      await handleRedeemVoucher(code);
    } else {
      setTokenNotice(t.deviceNameRequiredError);
      void handleValidateVoucher(code);
    }
  };

  const handlePortalLogout = async () => {
    const sessionTok = portalSession?.sessionToken || window.localStorage.getItem('netco_portal_session');
    if (!sessionTok) return;
    setDisconnecting(true);
    setTokenError(null);
    try {
      await apiRequest('/api/portal/logout', {
        method: 'POST',
        headers: { 'X-Portal-Session': sessionTok },
      });
      try {
        window.localStorage.removeItem('netco_portal_session');
      } catch {
        // ignore
      }
      setPortalSession(null);
      setTokenNotice(t.disconnectedSuccess);
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : 'Unable to disconnect session');
    } finally {
      setDisconnecting(false);
    }
  };

  const selectedPackage = packages.find((p) => p.id === selectedPkgId) || null;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white flex flex-col">
      {/* Compact Sticky Top Bar */}
      <header className="sticky top-0 z-30 h-14 sm:h-16 px-3 sm:px-6 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#080B12]/95 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-4">
        <NetcoLogo variant="compact" />

        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs font-mono text-[#0284C7] dark:text-[#16B8FF] px-2.5 py-1 rounded-lg bg-[#16B8FF]/10 border border-[#16B8FF]/20">
            <Ticket className="w-3.5 h-3.5" />
            {operatingMode === 'STANDALONE_MODE' ? t.standaloneModeLabel : t.mikrotikModeLabel}
          </span>
          <LanguageSwitcher lang={lang} onToggleLang={onToggleLang} />
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="Toggle Light or Dark Mode"
            className="btn-secondary min-h-[38px] sm:min-h-[40px] px-2.5 sm:px-3 text-xs"
          >
            {theme === 'dark' ? (
              <Sun className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            ) : (
              <Moon className="w-4 h-4 sm:w-3.5 sm:h-3.5" />
            )}
            <span className="hidden sm:inline">{theme === 'dark' ? t.light : t.dark}</span>
          </button>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-3 sm:px-6 py-4 sm:py-10 pb-8 sm:pb-12">
        {/* Mobile Brand Showcase */}
        <div className="lg:hidden flex flex-col items-center text-center mb-4 px-2">
          <NetcoLogo variant="banner" className="max-w-[210px]" />
          <p className="text-[11px] font-mono tracking-wider text-[#0284C7] dark:text-[#16B8FF] mt-1">
            {t.mobileSub}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-8 items-stretch">
          {/* Branded Hero Column */}
          <div className="order-2 lg:order-1 lg:col-span-5 flex flex-col justify-between bg-[#101827] text-white rounded-2xl overflow-hidden border border-slate-800">
            <div className="relative min-h-[210px] sm:min-h-[260px] lg:min-h-[280px] p-5 flex flex-col justify-between overflow-hidden bg-[#080B12]">
              {!heroImgFailed ? (
                <img
                  src="/assets/aistudio/Illuminated_Network_Switch_with_Ethernet_Cables_Providing_Connectivity_for_Data_Transmission_fc6d8a5b.jpeg"
                  alt="NETCO illuminated network switch with high-speed Ethernet connectivity"
                  referrerPolicy="no-referrer"
                  onError={() => setHeroImgFailed(true)}
                  className="absolute inset-0 w-full h-full object-cover"
                />
              ) : (
                <div className="absolute inset-0 w-full h-full bg-gradient-to-br from-[#080B12] via-[#101827] to-[#16B8FF]/25 flex items-center justify-center">
                  <Wifi className="w-14 h-14 text-[#16B8FF]/70" />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-[#101827] via-[#080B12]/60 to-[#080B12]/40" />

              <div className="relative z-10 hidden lg:flex justify-start">
                <NetcoLogo variant="banner" className="max-w-[210px]" />
              </div>

              <div className="relative z-10 mt-auto pt-4">
                <p className="text-xs font-mono tracking-wider text-[#16B8FF]">{t.heroTag}</p>
                <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-white mt-1 text-balance">
                  CONNECT. CONTROL. EXPERIENCE.
                </h1>
              </div>
            </div>

            <div className="p-5 sm:p-6 space-y-5 flex-1 flex flex-col justify-between">
              <div className="space-y-4">
                <p className="text-sm text-slate-300 leading-relaxed">{t.heroDesc}</p>
                <div className="space-y-3 pt-2 border-t border-slate-800 text-xs text-slate-300">
                  <div className="flex items-start gap-2.5">
                    <Smartphone className="w-4 h-4 text-[#16B8FF] shrink-0 mt-0.5" />
                    <span>{t.heroPoint1}</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <ShieldCheck className="w-4 h-4 text-[#16B8FF] shrink-0 mt-0.5" />
                    <span>{t.heroPoint2}</span>
                  </div>
                </div>

                {operatingMode === 'STANDALONE_MODE' && (
                  <div className="p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-200 space-y-1">
                    <div className="flex items-center gap-1.5 font-semibold text-amber-300">
                      <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                      <span>{t.airtelNoticeTitle}</span>
                    </div>
                    <p className="text-[11px] leading-relaxed text-amber-100/85">{t.airtelNoticeBody}</p>
                  </div>
                )}
              </div>

              <div className="pt-4 border-t border-slate-800 flex items-center justify-between text-xs text-[#8793A5]">
                <span>{t.heroFooter}</span>
                <button
                  type="button"
                  onClick={onSwitchToAdmin}
                  className="text-[11px] text-[#8793A5]/65 hover:text-slate-300 transition-colors cursor-pointer"
                >
                  {t.staffLink}
                </button>
              </div>
            </div>
          </div>

          {/* Customer Interactive Portal Column */}
          <div className="order-1 lg:order-2 lg:col-span-7 flex flex-col">
            <div className="bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-7 space-y-5 flex-1 shadow-sm">
              {/* Tab Switcher: Buy Voucher vs Use / Check Token */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-200 dark:border-slate-800">
                <div className="btn-tab-group">
                  <button
                    type="button"
                    onClick={() => setActiveTab('buy')}
                    className={activeTab === 'buy' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    <Ticket className="w-3.5 h-3.5 inline mr-1.5" />
                    {t.tabBuy}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('connect')}
                    className={activeTab === 'connect' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    <KeyRound className="w-3.5 h-3.5 inline mr-1.5" />
                    {t.tabConnect}
                    {portalSession?.status === 'ACTIVE' && (
                      <span className="ml-1.5 inline-block w-2 h-2 rounded-full bg-emerald-500" />
                    )}
                  </button>
                </div>

                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-mono font-medium bg-[#16B8FF]/10 text-[#0284C7] dark:text-[#16B8FF] border border-[#16B8FF]/25">
                  TZS
                </span>
              </div>

              {activeTab === 'buy' ? (
                <>
                  <div>
                    <h2 className="text-lg sm:text-xl font-semibold">{t.buyTitle}</h2>
                    <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-1">{t.buySubtitle}</p>
                  </div>

                  {loadingPkgs ? (
                    <div className="space-y-3">
                      <div className="h-20 rounded-xl bg-slate-100 dark:bg-[#080B12] animate-pulse" />
                      <div className="h-20 rounded-xl bg-slate-100 dark:bg-[#080B12] animate-pulse" />
                    </div>
                  ) : packages.length === 0 ? (
                    <div className="p-6 rounded-xl border border-dashed border-slate-300 dark:border-slate-700 text-center text-sm text-slate-500 dark:text-[#8793A5]">
                      {t.noPackages}
                    </div>
                  ) : (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        {packages.map((pkg) => {
                          const selected = pkg.id === selectedPkgId;
                          return (
                            <button
                              key={pkg.id}
                              type="button"
                              onClick={() => setSelectedPkgId(pkg.id)}
                              className={`text-left p-4 rounded-xl border transition-all duration-150 cursor-pointer active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16B8FF]/65 ${
                                selected
                                  ? 'border-[#16B8FF] bg-[#16B8FF]/10 ring-1 ring-[#16B8FF]/40 shadow-xs'
                                  : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#080B12] hover:border-slate-300 dark:hover:border-slate-700 hover:bg-white dark:hover:bg-[#0f1624]'
                              }`}
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="font-semibold text-sm">{pkg.name}</span>
                                <span className="font-mono font-bold text-sm tabular-nums text-[#0284C7] dark:text-[#16B8FF]">
                                  {formatTzs(pkg.priceTzs)}
                                </span>
                              </div>
                              <div className="text-xs text-slate-500 dark:text-[#8793A5] mt-1.5 flex flex-wrap items-center gap-1.5 tabular-nums">
                                <span>{formatDurationLocalized(pkg.durationMinutes, lang)}</span>
                                <span>·</span>
                                <span>{formatSpeed(pkg.downloadKbps)}</span>
                                <span>·</span>
                                <span>{pkg.dataLimitMb ? `${pkg.dataLimitMb} MB` : t.unlimited}</span>
                              </div>
                            </button>
                          );
                        })}
                      </div>

                      {selectedPackage && (
                        <form onSubmit={handleInitiatePayment} className="space-y-4 pt-3 border-t border-slate-200 dark:border-slate-800">
                          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                            {(['MPESA', 'AIRTEL_MONEY', 'TIGO_PESA', 'HALOPESA'] as const).map((p) => {
                              const info = providers.find((x) => x.provider === p);
                              const brand = PAYMENT_PROVIDER_BRANDS[p];
                              const active = provider === p;
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  onClick={() => setProvider(p)}
                                  className={`relative min-h-[84px] px-2.5 py-2.5 rounded-xl border text-xs font-medium flex flex-col items-center justify-center gap-1.5 text-center transition-all duration-150 cursor-pointer active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#16B8FF]/65 ${
                                    active
                                      ? 'border-[#16B8FF] bg-[#16B8FF]/15 text-slate-900 dark:text-white ring-1 ring-[#16B8FF]/35 shadow-xs'
                                      : 'border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-[#080B12] text-slate-600 dark:text-[#8793A5] hover:border-slate-300 dark:hover:border-slate-700'
                                  }`}
                                >
                                  {active && (
                                    <Check className="w-3.5 h-3.5 text-[#0284C7] dark:text-[#16B8FF] absolute top-1.5 right-1.5" />
                                  )}
                                  <span className="w-11 h-10 rounded-lg bg-transparent overflow-hidden flex items-center justify-center shrink-0">
                                    <img
                                      src={brand.logoUrl}
                                      alt={brand.alt}
                                      className="w-full h-full object-contain"
                                    />
                                  </span>
                                  <div className="leading-tight">
                                    <div className="font-semibold text-[11px]">{t.providerLabels[p]}</div>
                                    <div className="text-[10px] opacity-75">
                                      {info?.configured ? t.active : t.integrationReady}
                                    </div>
                                  </div>
                                </button>
                              );
                            })}
                          </div>

                          <div>
                            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                              {t.phoneLabel}
                            </label>
                            <div className="relative">
                              <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                              <input
                                type="tel"
                                required
                                value={phoneNumber}
                                onChange={(e) => setPhoneNumber(e.target.value)}
                                placeholder="0754 123 456"
                                className="w-full min-h-[48px] pl-10 pr-4 py-2 text-sm font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                              />
                            </div>
                          </div>

                          {paymentError && (
                            <div className="p-3 rounded-xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                              {paymentError}
                            </div>
                          )}

                          <button
                            type="submit"
                            disabled={paying}
                            className="btn-primary w-full min-h-[48px] text-sm"
                          >
                            <Ticket className="w-4 h-4" />
                            {paying ? t.initiating : t.buyButton(formatTzs(selectedPackage.priceTzs))}
                          </button>
                        </form>
                      )}
                    </>
                  )}

                  {/* Payment Reference Verification & Issued Voucher Token */}
                  <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
                    <p className="text-xs font-medium text-slate-700 dark:text-slate-300">{t.verifyTitle}</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={lookupRef}
                        onChange={(e) => setLookupRef(e.target.value)}
                        placeholder="NTC-PAY-..."
                        className="flex-1 min-h-[44px] px-3 py-2 text-xs font-mono rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12]"
                      />
                      <button
                        type="button"
                        onClick={() => handleCheckPaymentStatus()}
                        className="btn-secondary min-h-[44px] text-xs w-full sm:w-auto"
                      >
                        {t.checkStatus}
                      </button>
                    </div>

                    {pendingPayment && (
                      <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#080B12] border border-slate-200 dark:border-slate-800 text-xs space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                          <span className="font-semibold truncate">{pendingPayment.reference}</span>
                          <div className="flex items-center gap-2">
                            {pendingPayment.isTest && (
                              <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-semibold">
                                {t.testTokenBadge}
                              </span>
                            )}
                            <span
                              className={
                                pendingPayment.status === 'COMPLETED'
                                  ? 'text-emerald-600 dark:text-emerald-400 font-semibold shrink-0'
                                  : 'text-amber-600 dark:text-amber-400 font-semibold shrink-0'
                              }
                            >
                              {pendingPayment.status}
                            </span>
                          </div>
                        </div>

                        <p className="text-slate-600 dark:text-[#8793A5]">{pendingPayment.message}</p>

                        {/* Standalone / Test Gateway Payment Confirmation Step -> Issues Voucher Token */}
                        {pendingPayment.status === 'PENDING' && !pendingPayment.providerConfigured && (
                          <button
                            type="button"
                            disabled={confirmingTest}
                            onClick={() => handleConfirmStandalonePayment(pendingPayment.reference)}
                            className="btn-primary w-full min-h-[44px] text-xs"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            {confirmingTest ? t.confirmingTestBtn : t.confirmTestBtn}
                          </button>
                        )}

                        {pendingPayment.status === 'PENDING' && pendingPayment.providerConfigured && (
                          <p className="text-[11px] font-mono text-[#0284C7] dark:text-[#16B8FF] animate-pulse">
                            {t.awaitingWebhookHint}
                          </p>
                        )}

                        {pendingPayment.voucherCode && (
                          <div className="pt-3 border-t border-slate-200 dark:border-slate-800 space-y-3">
                            <div className="p-3.5 rounded-xl bg-white dark:bg-[#101827] border border-[#16B8FF]/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2 mb-0.5">
                                  <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 dark:text-[#8793A5]">
                                    {pendingPayment.isTest ? t.testTokenBadge : t.liveTokenBadge}
                                  </span>
                                  {pendingPayment.receiptNumber && (
                                    <span className="text-[10px] font-mono text-slate-400">
                                      · {t.receiptLabel} {pendingPayment.receiptNumber}
                                    </span>
                                  )}
                                </div>
                                <div className="text-[11px] text-slate-500">{t.issuedVoucher}</div>
                                <div className="font-mono font-bold text-lg tracking-wider text-[#0284C7] dark:text-[#16B8FF] mt-0.5 select-all">
                                  {pendingPayment.voucherCode}
                                </div>
                              </div>
                              <div className="flex flex-wrap sm:flex-nowrap gap-2">
                                <button
                                  type="button"
                                  onClick={() => handleCopyVoucher(pendingPayment.voucherCode!)}
                                  className="btn-secondary min-h-[38px] px-3 py-1.5 text-xs rounded-lg flex-1 sm:flex-initial"
                                >
                                  {copiedCode ? (
                                    <>
                                      <Check className="w-3.5 h-3.5" />
                                      {t.copied}
                                    </>
                                  ) : (
                                    <>
                                      <Copy className="w-3.5 h-3.5" />
                                      {t.copyCode}
                                    </>
                                  )}
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleActivateTokenDirectly(pendingPayment.voucherCode!)}
                                  className="btn-primary min-h-[38px] px-3.5 py-1.5 text-xs rounded-lg flex-1 sm:flex-initial"
                                >
                                  <KeyRound className="w-3.5 h-3.5" />
                                  {t.activateNowBtn}
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                /* TAB 2: Use / Check Voucher Token + Customer Portal Session Tracker */
                <div className="space-y-5">
                  <div>
                    <h2 className="text-lg sm:text-xl font-semibold">{t.connectTitle}</h2>
                    <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-1">{t.connectSubtitle}</p>
                  </div>

                  {/* Active Session Status Card */}
                  {portalSession && portalSession.status === 'ACTIVE' && (
                    <div className="p-4 sm:p-5 rounded-xl bg-emerald-500/10 border border-emerald-500/35 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                          <div>
                            <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
                              {t.activeSessionTitle}
                            </h3>
                            <p className="text-xs font-mono text-slate-600 dark:text-slate-300">
                              {portalSession.codeMasked} · {portalSession.packageName}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-slate-500 dark:text-slate-400 block">
                            {t.remainingTimeLabel}
                          </span>
                          <span className="font-mono font-bold text-lg text-emerald-600 dark:text-emerald-400 tabular-nums inline-flex items-center gap-1.5">
                            <Clock className="w-4 h-4" />
                            {formatCountdown(remainingSeconds)}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-emerald-500/20 text-xs">
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.sessionStatusLabel}</span>
                          <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            {portalSession.status}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.speedLabel}</span>
                          <span className="font-mono font-semibold">
                            {formatSpeed(portalSession.downloadKbps)}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.authorizedDeviceLabel}</span>
                          <span className="font-mono font-semibold truncate block">
                            {portalSession.deviceLabel || 'Device #1'}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.expiresAtLabel}</span>
                          <span className="font-mono text-[11px]">
                            {new Date(portalSession.expiresAt).toLocaleTimeString()}
                          </span>
                        </div>
                      </div>

                      <div className="flex justify-end">
                        <button
                          type="button"
                          disabled={disconnecting}
                          onClick={handlePortalLogout}
                          className="btn-secondary text-xs min-h-[40px]"
                        >
                          <LogOut className="w-3.5 h-3.5" />
                          {disconnecting ? t.disconnectingBtn : t.disconnectBtn}
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Voucher Token Input & Validation/Redemption Controls */}
                  <div className="space-y-3.5">
                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        {t.tokenInputLabel}
                      </label>
                      <input
                        type="text"
                        value={voucherInput}
                        onChange={(e) => setVoucherInput(e.target.value.toUpperCase())}
                        placeholder={t.tokenInputPlaceholder}
                        className="w-full min-h-[48px] px-4 py-2 text-sm font-mono uppercase tracking-wider rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                        {t.deviceLabelInput} <span className="text-red-500">*</span>
                      </label>
                      <input
                        type="text"
                        required
                        minLength={2}
                        maxLength={120}
                        value={deviceLabel}
                        onChange={(e) => setDeviceLabel(e.target.value)}
                        placeholder={t.deviceLabelPlaceholder}
                        className="w-full min-h-[44px] px-4 py-2 text-xs rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                      />
                    </div>

                    {tokenError && (
                      <div className="p-3 rounded-xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{tokenError}</span>
                      </div>
                    )}

                    {tokenNotice && (
                      <div className="p-3 rounded-xl border border-sky-300 dark:border-sky-900/60 bg-sky-50 dark:bg-sky-950/30 text-xs text-sky-800 dark:text-sky-200">
                        {tokenNotice}
                      </div>
                    )}

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        disabled={validating || !voucherInput.trim()}
                        onClick={() => handleValidateVoucher()}
                        className="btn-secondary min-h-[46px] text-xs w-full"
                      >
                        <ShieldCheck className="w-4 h-4" />
                        {validating ? t.validatingBtn : t.validateBtn}
                      </button>
                      <button
                        type="button"
                        disabled={activating || !voucherInput.trim()}
                        onClick={() => handleRedeemVoucher()}
                        className="btn-primary min-h-[46px] text-xs w-full"
                      >
                        <Wifi className="w-4 h-4" />
                        {activating ? t.activatingBtn : t.activateBtn}
                      </button>
                    </div>
                  </div>

                  {/* Validation Result Card */}
                  {validation && (
                    <div className="p-4 rounded-xl bg-slate-50 dark:bg-[#080B12] border border-slate-200 dark:border-slate-800 space-y-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-bold text-sm">{validation.codeMasked}</span>
                        <div className="flex items-center gap-2">
                          {validation.isTest && (
                            <span className="px-2 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 text-[10px] font-mono font-semibold">
                              {t.testTokenBadge}
                            </span>
                          )}
                          <span
                            className={`px-2 py-0.5 rounded font-mono text-[10px] font-semibold ${
                              validation.valid
                                ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                                : 'bg-red-500/15 text-red-600 dark:text-red-400'
                            }`}
                          >
                            {validation.valid ? t.validBadge : `${t.invalidBadge} (${validation.status})`}
                          </span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-slate-200 dark:border-slate-800">
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.packageLabel}</span>
                          <span className="font-semibold">{validation.packageName}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.priceLabel}</span>
                          <span className="font-mono font-semibold">{formatTzs(validation.priceTzs)}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.durationLabel}</span>
                          <span className="font-semibold">{formatDurationLocalized(validation.durationMinutes, lang)}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.speedLabel}</span>
                          <span className="font-mono">{formatSpeed(validation.downloadKbps)}</span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.dataCapLabel}</span>
                          <span className="font-mono">
                            {validation.dataLimitMb ? `${validation.dataLimitMb} MB` : t.unlimited}
                          </span>
                        </div>
                        <div>
                          <span className="text-slate-500 dark:text-[#8793A5] block">{t.deviceLockLabel}</span>
                          <span className="font-mono font-semibold">
                            {validation.boundDeviceName
                              ? validation.boundDeviceName
                              : validation.isBoundToDevice
                              ? t.boundDeviceYes
                              : t.boundDeviceNo}
                          </span>
                        </div>
                      </div>

                      {validation.revokedReason && (
                        <p className="text-red-600 dark:text-red-400 font-mono text-[11px]">
                          {validation.revokedReason}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}

