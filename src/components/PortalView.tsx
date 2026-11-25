import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Building2,
  Check,
  CheckCircle2,
  Clock,
  Copy,
  CreditCard,
  KeyRound,
  LifeBuoy,
  LogOut,
  Moon,
  Phone,
  Search,
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
import { TraxLogo } from './NetcoLogo.tsx';

interface PortalBusiness {
  id: string;
  name: string;
  slug: string;
  hotspotTitle: string | null;
  hotspotSupportPhone: string | null;
  country: string;
  currency: string;
}

interface PortalPackage {
  id: string;
  businessId?: string;
  name: string;
  description: string | null;
  category: 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';
  packageType?: string;
  priceTzs: number;
  durationMinutes: number;
  downloadKbps: number;
  uploadKbps: number;
  dataLimitMb: number | null;
}

interface ProviderInfo {
  provider: 'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA' | 'CARD';
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

interface PurchaseRecord {
  reference: string;
  receiptNumber: string | null;
  provider: string;
  phoneNumber: string;
  amountTzs: number;
  status: string;
  isTest: boolean;
  createdAt: string;
  packageName: string;
  businessName: string;
  voucherMasked: string | null;
  voucherStatus: string | null;
  voucherCode: string | null;
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
  const [activeTab, setActiveTab] = useState<'buy' | 'connect' | 'account'>('buy');
  const [operatingMode, setOperatingMode] = useState<'STANDALONE_MODE' | 'MIKROTIK_MODE'>('STANDALONE_MODE');

  const [businesses, setBusinesses] = useState<PortalBusiness[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>('');
  const [packages, setPackages] = useState<PortalPackage[]>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadingPkgs, setLoadingPkgs] = useState(true);

  // Buy Voucher State
  const [selectedPkgId, setSelectedPkgId] = useState<string>('');
  const [provider, setProvider] = useState<'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA' | 'CARD'>('MPESA');
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

  // Account Lookup & Support Ticket State
  const [accountQuery, setAccountQuery] = useState('');
  const [purchases, setPurchases] = useState<PurchaseRecord[]>([]);
  const [searchingAccount, setSearchingAccount] = useState(false);
  const [accountError, setAccountError] = useState<string | null>(null);
  const [supportPhone, setSupportPhone] = useState('');
  const [supportSubject, setSupportSubject] = useState('');
  const [supportMessage, setSupportMessage] = useState('');
  const [sendingSupport, setSendingSupport] = useState(false);
  const [supportNotice, setSupportNotice] = useState<string | null>(null);

  const loadPortalCatalog = async (bizId?: string) => {
    setLoadingPkgs(true);
    try {
      const targetBiz = bizId ?? selectedBusinessId;
      const pkgUrl = targetBiz
        ? `/api/portal/packages?businessId=${encodeURIComponent(targetBiz)}`
        : '/api/portal/packages';

      const [bizRes, pkgRes, provRes, modeRes] = await Promise.all([
        apiRequest<{ businesses: PortalBusiness[] }>('/api/portal/businesses').catch(() => ({
          businesses: [] as PortalBusiness[],
        })),
        apiRequest<{ packages: PortalPackage[] }>(pkgUrl),
        apiRequest<{ providers: ProviderInfo[] }>('/api/portal/providers'),
        apiRequest<{ operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE' }>('/api/system/mode').catch(() => ({
          operatingMode: 'STANDALONE_MODE' as const,
        })),
      ]);

      setBusinesses(bizRes.businesses);
      if (!targetBiz && bizRes.businesses.length > 0) {
        setSelectedBusinessId(bizRes.businesses[0].id);
      }
      setPackages(pkgRes.packages);
      setProviders(provRes.providers);
      setOperatingMode(modeRes.operatingMode);
      if (pkgRes.packages.length > 0) {
        setSelectedPkgId((prev) =>
          pkgRes.packages.some((p) => p.id === prev) ? prev : pkgRes.packages[0].id
        );
      } else {
        setSelectedPkgId('');
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

  const handleWorkspaceChange = (bizId: string) => {
    setSelectedBusinessId(bizId);
    setPendingPayment(null);
    setPaymentError(null);
    void loadPortalCatalog(bizId);
  };

  const handleInitiatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setPaymentError(null);
    setPaying(true);
    try {
      const res = await apiRequest<{ payment: PendingPayment }>('/api/portal/payments/initiate', {
        method: 'POST',
        body: {
          businessId: selectedBusinessId || undefined,
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

  const handleLookupAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    const q = accountQuery.trim();
    if (!q) return;
    setSearchingAccount(true);
    setAccountError(null);
    try {
      const isRef = q.toUpperCase().startsWith('TRX') || q.toUpperCase().startsWith('NTC') || /[A-Z]/i.test(q);
      const url = isRef
        ? `/api/portal/account?reference=${encodeURIComponent(q)}`
        : `/api/portal/account?phone=${encodeURIComponent(q)}`;
      const res = await apiRequest<{ purchases: PurchaseRecord[] }>(url);
      setPurchases(res.purchases);
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Lookup failed');
    } finally {
      setSearchingAccount(false);
    }
  };

  const handleSubmitSupport = async (e: React.FormEvent) => {
    e.preventDefault();
    setSendingSupport(true);
    setAccountError(null);
    setSupportNotice(null);
    try {
      await apiRequest('/api/portal/support', {
        method: 'POST',
        body: {
          businessId: selectedBusinessId || undefined,
          phone: supportPhone,
          subject: supportSubject,
          message: supportMessage,
        },
      });
      setSupportNotice(t.supportSuccess);
      setSupportSubject('');
      setSupportMessage('');
    } catch (err) {
      setAccountError(err instanceof Error ? err.message : 'Unable to submit support ticket');
    } finally {
      setSendingSupport(false);
    }
  };

  const selectedPackage = packages.find((p) => p.id === selectedPkgId) || null;
  const currentBusiness = businesses.find((b) => b.id === selectedBusinessId) || null;

  return (
    <div className="min-h-screen bg-stone-100 dark:bg-[#101010] text-[#101010] dark:text-[#FAFAFA] flex flex-col">
      {/* Top Bar */}
      <header className="sticky top-0 z-30 h-14 sm:h-16 px-3 sm:px-6 border-b border-stone-200 dark:border-zinc-800 bg-white/95 dark:bg-[#101010]/95 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-4">
        <TraxLogo variant="compact" />

        <div className="flex items-center gap-2 shrink-0">
          <span className="hidden md:inline-flex items-center gap-1.5 text-xs font-mono text-[#9A7B00] dark:text-[#FFD400] px-2.5 py-1 rounded-lg bg-[#FFD400]/12 border border-[#FFD400]/30">
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
        <div className="lg:hidden flex flex-col items-center text-center mb-4 px-2">
          <div className="px-4 py-2.5 rounded-xl bg-[#161618] border border-zinc-800">
            <TraxLogo variant="banner" />
          </div>
          <p className="text-[11px] font-mono tracking-wider text-[#B8860B] dark:text-[#FFD400] mt-2">
            {t.mobileSub}
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 sm:gap-8 items-stretch">
          {/* Branded Hero Column */}
          <div className="order-2 lg:order-1 lg:col-span-5 flex flex-col justify-between bg-[#161618] text-white rounded-2xl overflow-hidden border border-zinc-800">
            <div className="relative min-h-[210px] sm:min-h-[250px] p-5 flex flex-col justify-between overflow-hidden bg-[#101010]">
              {!heroImgFailed ? (
                <img
                  src="/assets/aistudio/Illuminated_Network_Switch_with_Ethernet_Cables_Providing_Connectivity_for_Data_Transmission_fc6d8a5b.jpeg"
                  alt="TRAX LINK high-speed wireless and Ethernet infrastructure"
                  referrerPolicy="no-referrer"
                  onError={() => setHeroImgFailed(true)}
                  className="absolute inset-0 w-full h-full object-cover opacity-55"
                />
              ) : (
                <div className="absolute inset-0 w-full h-full bg-gradient-to-br from-[#101010] via-[#161618] to-[#FFD400]/20 flex items-center justify-center">
                  <Wifi className="w-14 h-14 text-[#FFD400]/70" />
                </div>
              )}
              <div className="absolute inset-0 bg-gradient-to-t from-[#161618] via-[#101010]/70 to-[#101010]/45" />

              <div className="relative z-10 hidden lg:flex justify-start">
                <TraxLogo variant="banner" />
              </div>

              <div className="relative z-10 mt-auto pt-4">
                <p className="text-xs font-mono tracking-wider text-[#FFD400]">
                  {currentBusiness?.hotspotTitle || t.heroTag}
                </p>
                <h1 className="text-xl sm:text-2xl lg:text-3xl font-bold tracking-tight text-white mt-1 text-balance">
                  CONNECT. MANAGE. GROW.
                </h1>
              </div>
            </div>

            <div className="p-5 sm:p-6 space-y-5 flex-1 flex flex-col justify-between">
              <div className="space-y-4">
                <p className="text-sm text-zinc-300 leading-relaxed">{t.heroDesc}</p>
                <div className="space-y-3 pt-2 border-t border-zinc-800 text-xs text-zinc-300">
                  <div className="flex items-start gap-2.5">
                    <Smartphone className="w-4 h-4 text-[#FFD400] shrink-0 mt-0.5" />
                    <span>{t.heroPoint1}</span>
                  </div>
                  <div className="flex items-start gap-2.5">
                    <ShieldCheck className="w-4 h-4 text-[#FFD400] shrink-0 mt-0.5" />
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

              <div className="pt-4 border-t border-zinc-800 flex items-center justify-between text-xs text-zinc-400">
                <span>{t.heroFooter}</span>
                <button
                  type="button"
                  onClick={onSwitchToAdmin}
                  className="text-xs font-medium text-[#FFD400] hover:underline transition-colors cursor-pointer"
                >
                  {t.staffLink}
                </button>
              </div>
            </div>
          </div>

          {/* Customer Interactive Portal Column */}
          <div className="order-1 lg:order-2 lg:col-span-7 flex flex-col">
            <div className="bg-white dark:bg-[#161618] border border-stone-200 dark:border-zinc-800 rounded-2xl p-5 sm:p-7 space-y-5 flex-1 shadow-sm">
              {/* Tabs + Currency */}
              <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-stone-200 dark:border-zinc-800">
                <div className="btn-tab-group overflow-x-auto max-w-full">
                  <button
                    type="button"
                    onClick={() => setActiveTab('buy')}
                    className={activeTab === 'buy' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    <Ticket className="w-3.5 h-3.5 inline mr-1" />
                    {t.tabBuy}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('connect')}
                    className={activeTab === 'connect' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    <KeyRound className="w-3.5 h-3.5 inline mr-1" />
                    {t.tabConnect}
                  </button>
                  <button
                    type="button"
                    onClick={() => setActiveTab('account')}
                    className={activeTab === 'account' ? 'btn-tab-active' : 'btn-tab'}
                  >
                    <LifeBuoy className="w-3.5 h-3.5 inline mr-1" />
                    {t.tabAccount}
                  </button>
                </div>

                <span className="text-xs font-mono font-semibold text-[#B8860B] dark:text-[#FFD400]">
                  {currentBusiness?.currency || 'TZS'}
                </span>
              </div>

              {/* Multi-Tenant Workspace Selector */}
              {businesses.length > 1 && (
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-stone-100 dark:border-zinc-800/80 text-xs">
                  <label className="flex items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-400">
                    <Building2 className="w-3.5 h-3.5 text-[#B8860B] dark:text-[#FFD400]" />
                    {t.workspaceLabel}
                  </label>
                  <select
                    value={selectedBusinessId}
                    onChange={(e) => handleWorkspaceChange(e.target.value)}
                    className="px-3 py-1.5 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-medium"
                  >
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.country})
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {activeTab === 'buy' ? (
                <>
                  <div>
                    <h2 className="text-lg sm:text-xl font-semibold">{t.buyTitle}</h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.buySubtitle}</p>
                  </div>

                  {loadingPkgs ? (
                    <div className="space-y-3">
                      <div className="h-20 rounded-xl bg-stone-100 dark:bg-[#101010] animate-pulse" />
                      <div className="h-20 rounded-xl bg-stone-100 dark:bg-[#101010] animate-pulse" />
                    </div>
                  ) : packages.length === 0 ? (
                    <div className="p-6 rounded-xl border border-dashed border-stone-300 dark:border-zinc-700 text-center text-sm text-zinc-500 dark:text-zinc-400">
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
                              className={`text-left p-4 rounded-xl border transition-all duration-150 cursor-pointer active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD400]/75 ${
                                selected
                                  ? 'border-[#FFD400] bg-[#FFD400]/12 ring-1 ring-[#FFD400]/45 shadow-xs'
                                  : 'border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-[#101010] hover:border-stone-300 dark:hover:border-zinc-700'
                              }`}
                            >
                              <div className="flex items-baseline justify-between gap-2">
                                <span className="font-semibold text-sm">{pkg.name}</span>
                                <span className="font-mono font-bold text-sm tabular-nums text-[#9A7B00] dark:text-[#FFD400]">
                                  {formatTzs(pkg.priceTzs)}
                                </span>
                              </div>
                              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1.5 flex flex-wrap items-center gap-1.5 tabular-nums">
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
                        <form onSubmit={handleInitiatePayment} className="space-y-4 pt-3 border-t border-stone-200 dark:border-zinc-800">
                          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                            {(['MPESA', 'AIRTEL_MONEY', 'TIGO_PESA', 'HALOPESA', 'CARD'] as const).map((p) => {
                              const info = providers.find((x) => x.provider === p);
                              const brand = PAYMENT_PROVIDER_BRANDS[p];
                              const active = provider === p;
                              return (
                                <button
                                  key={p}
                                  type="button"
                                  onClick={() => setProvider(p)}
                                  className={`relative min-h-[82px] px-2 py-2 rounded-xl border text-xs font-medium flex flex-col items-center justify-center gap-1.5 text-center transition-all duration-150 cursor-pointer active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD400]/75 ${
                                    active
                                      ? 'border-[#FFD400] bg-[#FFD400]/15 text-[#101010] dark:text-white ring-1 ring-[#FFD400]/40 shadow-xs'
                                      : 'border-stone-200 dark:border-zinc-800 bg-stone-50 dark:bg-[#101010] text-zinc-600 dark:text-zinc-400 hover:border-stone-300 dark:hover:border-zinc-700'
                                  }`}
                                >
                                  {active && (
                                    <Check className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400] absolute top-1.5 right-1.5" />
                                  )}
                                  {brand.logoUrl ? (
                                    <span className="w-10 h-9 rounded-lg bg-transparent overflow-hidden flex items-center justify-center shrink-0">
                                      <img
                                        src={brand.logoUrl}
                                        alt={brand.alt}
                                        className="w-full h-full object-contain"
                                      />
                                    </span>
                                  ) : (
                                    <span className="w-10 h-9 rounded-lg flex items-center justify-center text-[#9A7B00] dark:text-[#FFD400]">
                                      <CreditCard className="w-6 h-6" />
                                    </span>
                                  )}
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
                            <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                              {t.phoneLabel}
                            </label>
                            <div className="relative">
                              <Phone className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                              <input
                                type="tel"
                                required
                                value={phoneNumber}
                                onChange={(e) => setPhoneNumber(e.target.value)}
                                placeholder="0754 123 456"
                                className="w-full min-h-[48px] pl-10 pr-4 py-2 text-sm font-mono rounded-xl border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
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
                  <div className="pt-4 border-t border-stone-200 dark:border-zinc-800 space-y-3">
                    <p className="text-xs font-medium text-zinc-700 dark:text-zinc-300">{t.verifyTitle}</p>
                    <div className="flex flex-col sm:flex-row gap-2">
                      <input
                        type="text"
                        value={lookupRef}
                        onChange={(e) => setLookupRef(e.target.value)}
                        placeholder="TRX-PAY-..."
                        className="flex-1 min-h-[44px] px-3 py-2 text-xs font-mono rounded-xl border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
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
                      <div className="p-4 rounded-xl bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-zinc-800 text-xs space-y-3">
                        <div className="flex flex-wrap items-center justify-between gap-2 font-mono">
                          <span className="font-semibold truncate">{pendingPayment.reference}</span>
                          <div className="flex items-center gap-2">
                            {pendingPayment.isTest && (
                              <span className="text-[10px] font-semibold text-amber-600 dark:text-amber-400">
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

                        <p className="text-zinc-600 dark:text-zinc-400">{pendingPayment.message}</p>

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
                          <p className="text-[11px] font-mono text-[#B8860B] dark:text-[#FFD400]">
                            {t.awaitingWebhookHint}
                          </p>
                        )}

                        {pendingPayment.voucherCode && (
                          <div className="pt-3 border-t border-stone-200 dark:border-zinc-800 space-y-3">
                            <div className="p-3.5 rounded-xl bg-white dark:bg-[#161618] border border-[#FFD400]/50 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                              <div>
                                <div className="flex items-center gap-2 mb-0.5 text-[10px] font-mono text-zinc-500">
                                  <span>{pendingPayment.isTest ? t.testTokenBadge : t.liveTokenBadge}</span>
                                  {pendingPayment.receiptNumber && (
                                    <span>· {t.receiptLabel} {pendingPayment.receiptNumber}</span>
                                  )}
                                </div>
                                <div className="text-[11px] text-zinc-500">{t.issuedVoucher}</div>
                                <div className="font-mono font-bold text-lg tracking-wider text-[#9A7B00] dark:text-[#FFD400] mt-0.5 select-all">
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
              ) : activeTab === 'connect' ? (
                /* TAB 2: Use / Check Voucher Token + Customer Portal Session Tracker */
                <div className="space-y-5">
                  <div>
                    <h2 className="text-lg sm:text-xl font-semibold">{t.connectTitle}</h2>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.connectSubtitle}</p>
                  </div>

                  {portalSession && portalSession.status === 'ACTIVE' && (
                    <div className="p-4 sm:p-5 rounded-xl bg-emerald-500/10 border border-emerald-500/35 space-y-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <CheckCircle2 className="w-5 h-5 text-emerald-500" />
                          <div>
                            <h3 className="text-sm font-bold text-emerald-700 dark:text-emerald-300">
                              {t.activeSessionTitle}
                            </h3>
                            <p className="text-xs font-mono text-zinc-600 dark:text-zinc-300">
                              {portalSession.codeMasked} · {portalSession.packageName}
                            </p>
                          </div>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400 block">
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
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.sessionStatusLabel}</span>
                          <span className="font-mono font-semibold text-emerald-600 dark:text-emerald-400">
                            {portalSession.status}
                          </span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.speedLabel}</span>
                          <span className="font-mono font-semibold">
                            {formatSpeed(portalSession.downloadKbps)}
                          </span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.authorizedDeviceLabel}</span>
                          <span className="font-mono font-semibold truncate block">
                            {portalSession.deviceLabel || 'Device #1'}
                          </span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.expiresAtLabel}</span>
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

                  <div className="space-y-3.5">
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                        {t.tokenInputLabel}
                      </label>
                      <input
                        type="text"
                        value={voucherInput}
                        onChange={(e) => setVoucherInput(e.target.value.toUpperCase())}
                        placeholder={t.tokenInputPlaceholder}
                        className="w-full min-h-[48px] px-4 py-2 text-sm font-mono uppercase tracking-wider rounded-xl border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
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
                        className="w-full min-h-[44px] px-4 py-2 text-xs rounded-xl border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                      />
                    </div>

                    {tokenError && (
                      <div className="p-3 rounded-xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{tokenError}</span>
                      </div>
                    )}

                    {tokenNotice && (
                      <div className="p-3 rounded-xl border border-[#FFD400]/40 bg-[#FFD400]/10 text-xs text-[#9A7B00] dark:text-[#FFD400]">
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

                  {validation && (
                    <div className="p-4 rounded-xl bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-zinc-800 space-y-3 text-xs">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-mono font-bold text-sm">{validation.codeMasked}</span>
                        <span
                          className={`font-mono font-semibold ${
                            validation.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                          }`}
                        >
                          {validation.valid ? t.validBadge : `${t.invalidBadge} (${validation.status})`}
                        </span>
                      </div>

                      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 pt-2 border-t border-stone-200 dark:border-zinc-800">
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.packageLabel}</span>
                          <span className="font-semibold">{validation.packageName}</span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.priceLabel}</span>
                          <span className="font-mono font-semibold">{formatTzs(validation.priceTzs)}</span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.durationLabel}</span>
                          <span className="font-semibold">{formatDurationLocalized(validation.durationMinutes, lang)}</span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.speedLabel}</span>
                          <span className="font-mono">{formatSpeed(validation.downloadKbps)}</span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.dataCapLabel}</span>
                          <span className="font-mono">
                            {validation.dataLimitMb ? `${validation.dataLimitMb} MB` : t.unlimited}
                          </span>
                        </div>
                        <div>
                          <span className="text-zinc-500 dark:text-zinc-400 block">{t.deviceLockLabel}</span>
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
              ) : (
                /* TAB 3: Customer Self-Service Account Lookup & Support Ticket */
                <div className="space-y-6">
                  {accountError && (
                    <div className="p-3 rounded-xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                      {accountError}
                    </div>
                  )}

                  <div className="space-y-3">
                    <div>
                      <h2 className="text-lg font-semibold">{t.accountLookupTitle}</h2>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.accountLookupSubtitle}</p>
                    </div>
                    <form onSubmit={handleLookupAccount} className="flex flex-col sm:flex-row gap-2">
                      <div className="relative flex-1">
                        <Search className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          required
                          value={accountQuery}
                          onChange={(e) => setAccountQuery(e.target.value)}
                          placeholder={t.lookupPhonePlaceholder}
                          className="w-full min-h-[44px] pl-9 pr-3 py-2 text-xs font-mono rounded-xl border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                        />
                      </div>
                      <button type="submit" disabled={searchingAccount} className="btn-primary min-h-[44px] text-xs">
                        {t.lookupBtn}
                      </button>
                    </form>

                    {purchases.length > 0 && (
                      <div className="divide-y divide-stone-100 dark:divide-zinc-800 border border-stone-200 dark:border-zinc-800 rounded-xl bg-stone-50 dark:bg-[#101010]">
                        {purchases.map((p) => (
                          <div key={p.reference} className="p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs">
                            <div>
                              <div className="font-semibold">
                                {p.packageName} · {p.businessName}
                              </div>
                              <div className="font-mono text-zinc-500 text-[11px]">
                                {p.reference} · {p.status} · {formatTzs(p.amountTzs)}
                              </div>
                            </div>
                            {p.voucherCode ? (
                              <button
                                type="button"
                                onClick={() => handleActivateTokenDirectly(p.voucherCode!)}
                                className="btn-chip-accent font-mono"
                              >
                                {p.voucherCode} · Use
                              </button>
                            ) : (
                              <span className="font-mono text-zinc-500">{p.voucherMasked || '—'}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="pt-5 border-t border-stone-200 dark:border-zinc-800 space-y-3">
                    <div>
                      <h3 className="text-base font-semibold">{t.supportTitle}</h3>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.supportSubtitle}</p>
                    </div>
                    {supportNotice && (
                      <div className="p-3 rounded-xl border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300">
                        {supportNotice}
                      </div>
                    )}
                    <form onSubmit={handleSubmitSupport} className="space-y-3 text-xs">
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                        <div>
                          <label className="block font-medium mb-1">{t.phoneLabel}</label>
                          <input
                            type="tel"
                            required
                            value={supportPhone}
                            onChange={(e) => setSupportPhone(e.target.value)}
                            placeholder="0754 123 456"
                            className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] font-mono"
                          />
                        </div>
                        <div>
                          <label className="block font-medium mb-1">{t.supportSubjectLabel}</label>
                          <input
                            type="text"
                            required
                            value={supportSubject}
                            onChange={(e) => setSupportSubject(e.target.value)}
                            placeholder="Voucher / Connection help"
                            className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                          />
                        </div>
                      </div>
                      <div>
                        <label className="block font-medium mb-1">{t.supportMessageLabel}</label>
                        <textarea
                          rows={2}
                          required
                          value={supportMessage}
                          onChange={(e) => setSupportMessage(e.target.value)}
                          placeholder="Describe your issue or payment reference..."
                          className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                        />
                      </div>
                      <button type="submit" disabled={sendingSupport} className="btn-secondary text-xs">
                        {t.supportSubmitBtn}
                      </button>
                    </form>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
