import React, { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, LayoutGroup, motion } from 'motion/react';
import {
  AlertCircle,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Clock,
  Copy,
  CreditCard,
  ExternalLink,
  Globe,
  Info,
  KeyRound,
  LifeBuoy,
  Lock,
  LogOut,
  MapPin,
  Moon,
  Phone,
  Search,
  ShieldCheck,
  Smartphone,
  Sun,
  Ticket,
  UserCircle2,
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
import { MobilePageTransition, NATIVE_SPRING } from './ui/MotionPrimitives.tsx';

interface PortalBusiness {
  id: string;
  name: string;
  slug: string;
  hotspotTitle: string | null;
  hotspotSupportPhone: string | null;
  description?: string | null;
  physicalAddress?: string | null;
  city?: string | null;
  websiteUrl?: string | null;
  supportHours?: string | null;
  wifiSsid?: string | null;
  country: string;
  currency: string;
}

function getSafePortalUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
  } catch {
    return null;
  }
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

type CategoryFilter = 'ALL' | 'HOURLY' | 'DAILY' | 'WEEKLY' | 'MONTHLY';

function getOrCreateDeviceFingerprint(): string {
  const storageKey = 'netco_device_fp';
  try {
    const existing = window.localStorage.getItem(storageKey);
    if (existing && existing.length >= 12) return existing;
    const rand =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
    const screenInfo =
      typeof window !== 'undefined' ? `${window.screen?.width || 0}x${window.screen?.height || 0}` : '0x0';
    const fp = `ncd-${rand}-${screenInfo}`;
    window.localStorage.setItem(storageKey, fp);
    return fp;
  } catch {
    return `ncd-session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

function detectCardBrand(digits: string): 'VISA' | 'MASTERCARD' | 'AMEX' | 'CARD' {
  if (/^4/.test(digits)) return 'VISA';
  if (/^(5[1-5]|2(2[2-9][1-9]|2[3-9]\d|[3-6]\d\d|7([01]\d|20)))/.test(digits)) return 'MASTERCARD';
  if (/^3[47]/.test(digits)) return 'AMEX';
  return 'CARD';
}

function isValidLuhn(digits: string): boolean {
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let doubleDigit = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = Number(digits[i]);
    if (doubleDigit) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    doubleDigit = !doubleDigit;
  }
  return sum % 10 === 0;
}

function formatCardNumber(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 19);
  return digits.replace(/(\d{4})(?=\d)/g, '$1 ');
}

function formatCardExpiry(raw: string): string {
  const digits = raw.replace(/\D/g, '').slice(0, 4);
  if (digits.length <= 2) return digits;
  return `${digits.slice(0, 2)}/${digits.slice(2)}`;
}

function isValidFutureExpiry(mmYy: string): boolean {
  const m = /^(\d{2})\/(\d{2})$/.exec(mmYy.trim());
  if (!m) return false;
  const month = Number(m[1]);
  const year = 2000 + Number(m[2]);
  if (month < 1 || month > 12) return false;
  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = now.getMonth() + 1;
  return year > currentYear || (year === currentYear && month >= currentMonth);
}

export function PortalView({ onSwitchToAdmin, theme, onToggleTheme, lang, onToggleLang }: Props) {
  const t = TRANSLATIONS[lang].portal;
  const [activeTab, setActiveTab] = useState<'buy' | 'connect' | 'account'>('buy');
  const [tabDirection, setTabDirection] = useState<number>(0);
  const [operatingMode, setOperatingMode] = useState<'STANDALONE_MODE' | 'MIKROTIK_MODE'>('STANDALONE_MODE');

  const switchTab = (next: 'buy' | 'connect' | 'account') => {
    const order = ['buy', 'connect', 'account'] as const;
    setTabDirection(order.indexOf(next) >= order.indexOf(activeTab) ? 1 : -1);
    setActiveTab(next);
  };

  const [businesses, setBusinesses] = useState<PortalBusiness[]>([]);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>('');
  const [packages, setPackages] = useState<PortalPackage[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('ALL');
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loadingPkgs, setLoadingPkgs] = useState(true);

  // Buy Voucher State
  const [selectedPkgId, setSelectedPkgId] = useState<string>('');
  const [provider, setProvider] = useState<'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA' | 'CARD'>('MPESA');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [cardHolder, setCardHolder] = useState('');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpiry, setCardExpiry] = useState('');
  const [cardCvv, setCardCvv] = useState('');
  const [paying, setPaying] = useState(false);
  const [confirmingTest, setConfirmingTest] = useState(false);
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [pendingPayment, setPendingPayment] = useState<PendingPayment | null>(null);
  const [showRefLookup, setShowRefLookup] = useState(false);
  const [lookupRef, setLookupRef] = useState('');
  const [copiedCode, setCopiedCode] = useState(false);

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
  const [showHardwareInfo, setShowHardwareInfo] = useState(false);

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

  const availableCategories = useMemo(() => {
    const cats = new Set<PortalPackage['category']>(packages.map((p) => p.category));
    return (['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY'] as const).filter((c) => cats.has(c));
  }, [packages]);

  const filteredPackages = useMemo(() => {
    if (categoryFilter === 'ALL') return packages;
    return packages.filter((p) => p.category === categoryFilter);
  }, [packages, categoryFilter]);

  useEffect(() => {
    if (filteredPackages.length > 0 && !filteredPackages.some((p) => p.id === selectedPkgId)) {
      setSelectedPkgId(filteredPackages[0].id);
    }
  }, [filteredPackages, selectedPkgId]);

  const handleWorkspaceChange = (bizId: string) => {
    setSelectedBusinessId(bizId);
    setCategoryFilter('ALL');
    setPendingPayment(null);
    setPaymentError(null);
    void loadPortalCatalog(bizId);
  };

  const handleInitiatePayment = async (e: React.FormEvent) => {
    e.preventDefault();
    setPaymentError(null);

    let cardSummary:
      | { cardBrand: string; cardLast4: string; cardExpiry: string; cardHolder: string }
      | undefined;

    if (provider === 'CARD') {
      const cleanHolder = cardHolder.trim();
      const digits = cardNumber.replace(/\D/g, '');
      const cleanCvv = cardCvv.replace(/\D/g, '');
      if (cleanHolder.length < 2) {
        setPaymentError(t.cardInvalidHolder);
        return;
      }
      if (!isValidLuhn(digits)) {
        setPaymentError(t.cardInvalidNumber);
        return;
      }
      if (!isValidFutureExpiry(cardExpiry)) {
        setPaymentError(t.cardInvalidExpiry);
        return;
      }
      if (cleanCvv.length < 3 || cleanCvv.length > 4) {
        setPaymentError(t.cardInvalidCvv);
        return;
      }
      cardSummary = {
        cardBrand: detectCardBrand(digits),
        cardLast4: digits.slice(-4),
        cardExpiry: cardExpiry.trim(),
        cardHolder: cleanHolder,
      };
    }

    setPaying(true);
    try {
      const res = await apiRequest<{ payment: PendingPayment }>('/api/portal/payments/initiate', {
        method: 'POST',
        body: {
          businessId: selectedBusinessId || undefined,
          packageId: selectedPkgId,
          provider,
          phoneNumber,
          ...(cardSummary ? { cardSummary } : {}),
        },
      });
      setPendingPayment(res.payment);
      setLookupRef(res.payment.reference);
      setCopiedCode(false);
      if (provider === 'CARD') {
        setCardNumber('');
        setCardCvv('');
      }
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
  const isSessionActive = portalSession?.status === 'ACTIVE';

  const catLabel = (cat: PortalPackage['category']) => {
    if (cat === 'HOURLY') return t.catHourly;
    if (cat === 'DAILY') return t.catDaily;
    if (cat === 'WEEKLY') return t.catWeekly;
    return t.catMonthly;
  };

  return (
    <div className="min-h-screen bg-[#F2F2F7] dark:bg-[#08090C] cinematic-backdrop text-[#111113] dark:text-[#F5F5F7] flex flex-col">
      {/* Compact iOS Frosted Top Navigation Bar */}
      <header className="sticky top-0 z-30 h-[52px] sm:h-16 px-4 sm:px-6 border-b ios-glass-bar flex items-center justify-between gap-4">
        <TraxLogo variant="compact" />

        {/* Desktop iOS Segmented Tab Bar */}
        <LayoutGroup id="portalDesktopNav">
          <nav
            aria-label="Customer sections"
            className="hidden md:flex items-center p-1 rounded-2xl bg-black/[0.06] dark:bg-white/[0.08] border border-black/[0.05] dark:border-white/[0.06]"
          >
            {(['buy', 'connect', 'account'] as const).map((tabKey) => {
              const label =
                tabKey === 'buy' ? t.tabBuy : tabKey === 'connect' ? t.tabConnect : t.tabAccount;
              const isActive = activeTab === tabKey;
              return (
                <button
                  key={tabKey}
                  type="button"
                  onClick={() => switchTab(tabKey)}
                  className={`relative px-4 py-1.5 rounded-xl text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-colors duration-150 ${
                    isActive
                      ? 'text-[#111113] dark:text-[#FFD400]'
                      : 'text-zinc-600 dark:text-zinc-400 hover:text-[#111113] dark:hover:text-white'
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="portalDesktopTabPill"
                      transition={NATIVE_SPRING}
                      className="absolute inset-0 rounded-xl bg-white dark:bg-[#232327] shadow-xs"
                      aria-hidden="true"
                    />
                  )}
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </nav>
        </LayoutGroup>

        <div className="flex items-center gap-2 shrink-0">
          <LanguageSwitcher lang={lang} onToggleLang={onToggleLang} />
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label="Toggle Light or Dark Mode"
            className="inline-flex items-center justify-center min-h-[40px] min-w-[40px] rounded-full bg-black/[0.05] dark:bg-white/[0.08] border border-black/[0.06] dark:border-white/[0.08] text-zinc-700 dark:text-zinc-200 hover:bg-black/[0.09] dark:hover:bg-white/[0.14] transition-all duration-150 active:scale-95 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD400]/75"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
        </div>
      </header>

      {/* Main Content Workspace */}
      <main className="flex-1 w-full max-w-6xl mx-auto px-3.5 sm:px-6 pt-4 sm:pt-7 pb-24 md:pb-12 space-y-5">
        {/* Dynamic Connection / Greeting Card */}
        {isSessionActive && portalSession ? (
          <section className="ios-surface p-5 sm:p-6 bg-gradient-to-br from-[#101217] via-[#151820] to-[#1A1D26] text-white border border-emerald-500/35 shadow-[0_18px_48px_-22px_rgba(16,185,129,0.45)]">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="flex items-start gap-3.5">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/18 border border-emerald-400/35 flex items-center justify-center shrink-0">
                  <Wifi className="w-6 h-6 text-emerald-400" />
                </div>
                <div>
                  <div className="flex items-center gap-2 text-[11px] font-futuristic uppercase tracking-[0.14em] text-emerald-400">
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>{t.activeSessionTitle}</span>
                  </div>
                  <h1 className="text-lg sm:text-xl font-bold tracking-tight text-white mt-0.5">
                    {portalSession.packageName}
                  </h1>
                  <div className="text-xs text-zinc-300 mt-1 flex flex-wrap items-center gap-1.5 tabular-nums">
                    <span className="font-mono">{portalSession.codeMasked}</span>
                    <span aria-hidden="true">·</span>
                    <span>{portalSession.deviceLabel || '1 Device'}</span>
                    <span aria-hidden="true">·</span>
                    <span>{formatSpeed(portalSession.downloadKbps)}</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between sm:justify-end gap-4 pt-3 sm:pt-0 border-t sm:border-t-0 border-white/10">
                <div className="sm:text-right">
                  <span className="text-[11px] text-zinc-400 block">{t.remainingTimeLabel}</span>
                  <span className="font-futuristic font-bold text-2xl sm:text-3xl tracking-[0.06em] text-emerald-400 tabular-nums drop-shadow-[0_0_12px_rgba(52,211,153,0.35)]">
                    {formatCountdown(remainingSeconds)}
                  </span>
                </div>
                <button
                  type="button"
                  disabled={disconnecting}
                  onClick={handlePortalLogout}
                  className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-2xl text-xs font-semibold bg-red-500/20 text-red-200 border border-red-400/35 hover:bg-red-500/30 active:scale-[0.98] transition-all cursor-pointer whitespace-nowrap shrink-0"
                >
                  <LogOut className="w-4 h-4" />
                  {disconnecting ? t.disconnectingBtn : t.disconnectBtn}
                </button>
              </div>
            </div>
          </section>
        ) : (
          <section className="relative overflow-hidden ios-surface px-5 py-5 sm:px-7 sm:py-6 flex flex-col sm:flex-row sm:items-center justify-between gap-4 border border-black/[0.07] dark:border-[#FFD400]/18">
            <div className="space-y-1.5 max-w-2xl">
              <div className="flex items-center gap-2 text-[11px] font-futuristic uppercase tracking-[0.16em] text-[#9A7B00] dark:text-[#FFD400]">
                <Wifi className="w-4 h-4 shrink-0" />
                <span>{currentBusiness?.hotspotTitle || currentBusiness?.name || 'TRAX LINK WiFi'}</span>
              </div>
              <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-balance">
                {t.readyGreeting}
              </h1>
              <p className="text-xs sm:text-sm text-zinc-600 dark:text-zinc-400 leading-relaxed">
                {t.readySub}
              </p>
              <div className="pt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                <span>1. {t.step1Label}</span>
                <span aria-hidden="true">·</span>
                <span>2. {t.step2Label}</span>
                <span aria-hidden="true">·</span>
                <span>3. {t.step3Label}</span>
              </div>
            </div>

            {businesses.length > 1 && (
              <div className="shrink-0 sm:min-w-[230px]">
                <label className="block text-[11px] font-medium text-zinc-500 dark:text-zinc-400 mb-1">
                  {t.workspaceLabel}
                </label>
                <div className="relative">
                  <Building2 className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <select
                    value={selectedBusinessId}
                    onChange={(e) => handleWorkspaceChange(e.target.value)}
                    className="w-full min-h-[44px] pl-9 pr-8 py-2 rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20] text-xs font-semibold appearance-none cursor-pointer focus:outline-none focus:ring-2 focus:ring-[#FFD400]/75"
                  >
                    {businesses.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name} ({b.country})
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-zinc-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
            )}
          </section>
        )}

        <AnimatePresence mode="wait" initial={false} custom={tabDirection}>
          <MobilePageTransition key={activeTab} direction={tabDirection}>
        {/* TAB 1: BUY WIFI VOUCHER */}
        {activeTab === 'buy' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            {/* Plans Grid */}
            <div className="lg:col-span-7 ios-surface p-4 sm:p-6 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-lg font-bold tracking-tight">{t.buyTitle}</h2>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">{t.buySubtitle}</p>
                </div>

                {availableCategories.length > 1 && (
                  <div className="inline-flex items-center gap-1 p-1 rounded-xl bg-[#F2F2F7] dark:bg-[#101012] border border-black/[0.05] dark:border-white/[0.06] overflow-x-auto max-w-full">
                    <button
                      type="button"
                      onClick={() => setCategoryFilter('ALL')}
                      className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-all ${
                        categoryFilter === 'ALL'
                          ? 'bg-white dark:bg-[#242428] text-[#111113] dark:text-[#FFD400] shadow-xs'
                          : 'text-zinc-600 dark:text-zinc-400 hover:text-[#111113] dark:hover:text-white'
                      }`}
                    >
                      {t.catAll}
                    </button>
                    {availableCategories.map((cat) => (
                      <button
                        key={cat}
                        type="button"
                        onClick={() => setCategoryFilter(cat)}
                        className={`px-3 py-1.5 rounded-lg text-xs font-semibold whitespace-nowrap shrink-0 cursor-pointer transition-all ${
                          categoryFilter === cat
                            ? 'bg-white dark:bg-[#242428] text-[#111113] dark:text-[#FFD400] shadow-xs'
                            : 'text-zinc-600 dark:text-zinc-400 hover:text-[#111113] dark:hover:text-white'
                        }`}
                      >
                        {catLabel(cat)}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {loadingPkgs ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="h-28 rounded-3xl bg-[#F2F2F7] dark:bg-[#1D1D20] animate-pulse" />
                  <div className="h-28 rounded-3xl bg-[#F2F2F7] dark:bg-[#1D1D20] animate-pulse" />
                  <div className="h-28 rounded-3xl bg-[#F2F2F7] dark:bg-[#1D1D20] animate-pulse" />
                  <div className="h-28 rounded-3xl bg-[#F2F2F7] dark:bg-[#1D1D20] animate-pulse" />
                </div>
              ) : filteredPackages.length === 0 ? (
                <div className="p-8 rounded-3xl border border-dashed border-black/15 dark:border-white/15 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  {t.noPackages}
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {filteredPackages.map((pkg) => {
                    const selected = pkg.id === selectedPkgId;
                    return (
                      <button
                        key={pkg.id}
                        type="button"
                        onClick={() => setSelectedPkgId(pkg.id)}
                        className={`group relative text-left p-4 sm:p-5 rounded-3xl border transition-all duration-150 ios-spring cursor-pointer active:scale-[0.985] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD400]/80 ${
                          selected
                            ? 'bg-[#FFD400]/14 dark:bg-[#FFD400]/12 border-[#FFD400] ring-1 ring-[#FFD400]/55 shadow-sm'
                            : 'ios-grouped-cell hover:bg-[#ECECF0] dark:hover:bg-[#232327]'
                        }`}
                      >
                        <div className="flex items-start justify-between gap-2">
                          <div className="min-w-0">
                            <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 block">
                              {catLabel(pkg.category)}
                            </span>
                            <span className="font-bold text-base tracking-tight block truncate mt-0.5">
                              {pkg.name}
                            </span>
                          </div>

                          <div
                            className={`w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-colors ${
                              selected
                                ? 'bg-[#FFD400] text-[#111113]'
                                : 'bg-black/[0.06] dark:bg-white/[0.08] text-transparent'
                            }`}
                          >
                            <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                          </div>
                        </div>

                        <div className="mt-4 flex items-baseline justify-between gap-2">
                          <span className="font-mono font-extrabold text-xl tabular-nums text-[#9A7B00] dark:text-[#FFD400]">
                            {formatTzs(pkg.priceTzs)}
                          </span>
                          <span className="text-xs font-medium text-zinc-600 dark:text-zinc-300 tabular-nums">
                            {formatDurationLocalized(pkg.durationMinutes, lang)}
                          </span>
                        </div>

                        <div className="mt-2 pt-2.5 border-t border-black/[0.06] dark:border-white/[0.07] text-xs text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5 tabular-nums">
                          <span>{formatSpeed(pkg.downloadKbps)}</span>
                          <span aria-hidden="true">·</span>
                          <span>{pkg.dataLimitMb ? `${pkg.dataLimitMb} MB` : t.unlimited}</span>
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Checkout Sheet & Instant Voucher Pass */}
            <div className="lg:col-span-5 space-y-4 lg:sticky lg:top-20">
              {selectedPackage && (
                <section className="ios-surface p-4 sm:p-6 space-y-4">
                  <div className="ios-grouped-cell p-3.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 block">
                        {t.selectedPlanLabel}
                      </span>
                      <span className="font-bold text-sm truncate block">{selectedPackage.name}</span>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">
                        {formatDurationLocalized(selectedPackage.durationMinutes, lang)} ·{' '}
                        {formatSpeed(selectedPackage.downloadKbps)}
                      </span>
                    </div>
                    <div className="text-right shrink-0">
                      <span className="font-mono font-extrabold text-lg tabular-nums text-[#9A7B00] dark:text-[#FFD400]">
                        {formatTzs(selectedPackage.priceTzs)}
                      </span>
                    </div>
                  </div>

                  <form onSubmit={handleInitiatePayment} className="space-y-4">
                    <div>
                      <span className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-2">
                        {t.paymentMethodLabel}
                      </span>
                      <div className="grid grid-cols-3 sm:grid-cols-5 lg:grid-cols-3 gap-2">
                        {(['MPESA', 'AIRTEL_MONEY', 'TIGO_PESA', 'HALOPESA', 'CARD'] as const).map((p) => {
                          const info = providers.find((x) => x.provider === p);
                          const brand = PAYMENT_PROVIDER_BRANDS[p];
                          const active = provider === p;
                          return (
                            <button
                              key={p}
                              type="button"
                              onClick={() => {
                                setProvider(p);
                                setPaymentError(null);
                              }}
                              className={`relative min-h-[78px] px-2 py-2 rounded-2xl border text-xs font-medium flex flex-col items-center justify-center gap-1.5 text-center transition-all duration-150 ios-spring cursor-pointer active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD400]/80 ${
                                active
                                  ? 'border-[#FFD400] bg-[#FFD400]/15 text-[#111113] dark:text-white ring-1 ring-[#FFD400]/45 shadow-xs'
                                  : 'ios-grouped-cell text-zinc-600 dark:text-zinc-400 hover:bg-[#ECECF0] dark:hover:bg-[#232327]'
                              }`}
                            >
                              {brand.logoUrl ? (
                                <span className="w-9 h-8 rounded-lg overflow-hidden flex items-center justify-center shrink-0">
                                  <img
                                    src={brand.logoUrl}
                                    alt={brand.alt}
                                    className="w-full h-full object-contain"
                                  />
                                </span>
                              ) : (
                                <span className="w-9 h-8 rounded-lg flex items-center justify-center text-[#9A7B00] dark:text-[#FFD400]">
                                  <CreditCard className="w-5 h-5" />
                                </span>
                              )}
                              <div className="leading-tight">
                                <div className="font-semibold text-[11px] whitespace-nowrap">
                                  {t.providerLabels[p]}
                                </div>
                                <div className="text-[10px] opacity-70 truncate max-w-[84px]">
                                  {info?.configured ? t.active : t.integrationReady}
                                </div>
                              </div>
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <AnimatePresence initial={false}>
                      {provider === 'CARD' && (
                        <motion.div
                          key="bank-card-panel"
                          initial={{ opacity: 0, y: 12, scale: 0.985 }}
                          animate={{ opacity: 1, y: 0, scale: 1 }}
                          exit={{ opacity: 0, y: -8, scale: 0.985 }}
                          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                          className="ios-grouped-cell p-3.5 sm:p-4 space-y-3"
                        >
                        <div className="flex items-center justify-between gap-2">
                          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#111113] dark:text-white">
                            <Lock className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400]" />
                            {t.cardDetailsTitle}
                          </span>
                          <span className="text-[11px] font-semibold text-zinc-500 dark:text-zinc-400">
                            {(() => {
                              const detected = detectCardBrand(cardNumber.replace(/\D/g, ''));
                              if (detected === 'VISA') return 'Visa';
                              if (detected === 'MASTERCARD') return 'Mastercard';
                              if (detected === 'AMEX') return 'AMEX';
                              return 'Visa · Mastercard';
                            })()}
                          </span>
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300 mb-1">
                            {t.cardHolderLabel}
                          </label>
                          <input
                            type="text"
                            required
                            autoComplete="cc-name"
                            value={cardHolder}
                            onChange={(e) => setCardHolder(e.target.value)}
                            placeholder={t.cardHolderPlaceholder}
                            className="w-full min-h-[46px] px-3.5 py-2 text-sm rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-white dark:bg-[#161618] text-[#111113] dark:text-white uppercase placeholder:normal-case focus:outline-none focus:ring-2 focus:ring-[#FFD400]/70"
                          />
                        </div>

                        <div>
                          <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300 mb-1">
                            {t.cardNumberLabel}
                          </label>
                          <div className="relative">
                            <CreditCard className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                            <input
                              type="text"
                              inputMode="numeric"
                              required
                              autoComplete="cc-number"
                              maxLength={23}
                              value={cardNumber}
                              onChange={(e) => setCardNumber(formatCardNumber(e.target.value))}
                              placeholder={t.cardNumberPlaceholder}
                              className="w-full min-h-[48px] pl-10 pr-4 py-2 text-sm font-mono tabular-nums rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-white dark:bg-[#161618] text-[#111113] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD400]/70"
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2.5">
                          <div>
                            <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300 mb-1">
                              {t.cardExpiryLabel}
                            </label>
                            <input
                              type="text"
                              inputMode="numeric"
                              required
                              autoComplete="cc-exp"
                              maxLength={5}
                              value={cardExpiry}
                              onChange={(e) => setCardExpiry(formatCardExpiry(e.target.value))}
                              placeholder={t.cardExpiryPlaceholder}
                              className="w-full min-h-[46px] px-3.5 py-2 text-sm font-mono tabular-nums rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-white dark:bg-[#161618] text-[#111113] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD400]/70"
                            />
                          </div>
                          <div>
                            <label className="block text-[11px] font-medium text-zinc-600 dark:text-zinc-300 mb-1">
                              {t.cardCvvLabel}
                            </label>
                            <input
                              type="password"
                              inputMode="numeric"
                              required
                              autoComplete="cc-csc"
                              maxLength={4}
                              value={cardCvv}
                              onChange={(e) => setCardCvv(e.target.value.replace(/\D/g, '').slice(0, 4))}
                              placeholder={t.cardCvvPlaceholder}
                              className="w-full min-h-[46px] px-3.5 py-2 text-sm font-mono tabular-nums rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-white dark:bg-[#161618] text-[#111113] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD400]/70"
                            />
                          </div>
                        </div>

                        <p className="text-[11px] leading-relaxed text-zinc-500 dark:text-zinc-400">
                          {t.cardSecurityNote}
                        </p>
                      </motion.div>
                      )}
                    </AnimatePresence>

                    <div>
                      <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                        {provider === 'CARD' ? t.cardReceiptPhoneLabel : t.phoneLabel}
                      </label>
                      <div className="relative">
                        <Phone className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                        <input
                          type="tel"
                          required
                          value={phoneNumber}
                          onChange={(e) => setPhoneNumber(e.target.value)}
                          placeholder="0754 123 456"
                          className="w-full min-h-[48px] pl-10 pr-4 py-2 text-sm font-mono rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20] text-[#111113] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD400]/70"
                        />
                      </div>
                    </div>

                    {paymentError && (
                      <div className="p-3 rounded-2xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                        <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                        <span>{paymentError}</span>
                      </div>
                    )}

                    <button
                      type="submit"
                      disabled={paying}
                      className="btn-primary w-full min-h-[50px] rounded-2xl text-sm font-bold"
                    >
                      <Ticket className="w-4 h-4" />
                      {paying ? t.initiating : t.buyButton(formatTzs(selectedPackage.priceTzs))}
                    </button>
                  </form>

                  {/* Pending / Issued Apple-Wallet Style Pass */}
                  {pendingPayment && (
                    <div className="pt-4 border-t border-black/[0.07] dark:border-white/[0.08] space-y-3">
                      <div className="ios-grouped-cell p-4 space-y-3 text-xs">
                        <div className="flex items-center justify-between gap-2 font-mono">
                          <span className="font-semibold truncate">{pendingPayment.reference}</span>
                          <span
                            className={`font-semibold shrink-0 ${
                              pendingPayment.status === 'COMPLETED'
                                ? 'text-emerald-600 dark:text-emerald-400'
                                : 'text-amber-600 dark:text-amber-400'
                            }`}
                          >
                            {pendingPayment.status}
                          </span>
                        </div>

                        <p className="text-zinc-600 dark:text-zinc-400 leading-relaxed">
                          {pendingPayment.message}
                        </p>

                        {pendingPayment.status === 'PENDING' && !pendingPayment.providerConfigured && (
                          <button
                            type="button"
                            disabled={confirmingTest}
                            onClick={() => handleConfirmStandalonePayment(pendingPayment.reference)}
                            className="btn-primary w-full min-h-[46px] rounded-2xl text-xs"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                            {confirmingTest ? t.confirmingTestBtn : t.confirmTestBtn}
                          </button>
                        )}

                        {pendingPayment.status === 'PENDING' && pendingPayment.providerConfigured && (
                          <p className="text-[11px] font-mono text-[#9A7B00] dark:text-[#FFD400]">
                            {t.awaitingWebhookHint}
                          </p>
                        )}

                        {pendingPayment.voucherCode && (
                          <div className="p-4 rounded-2xl bg-[#111113] text-white border border-[#FFD400]/50 space-y-3">
                            <div className="flex items-center justify-between gap-2 text-[10px] font-mono text-zinc-400">
                              <span>
                                {pendingPayment.isTest ? t.testTokenBadge : t.liveTokenBadge}
                              </span>
                              {pendingPayment.receiptNumber && (
                                <span>
                                  {t.receiptLabel} {pendingPayment.receiptNumber}
                                </span>
                              )}
                            </div>

                            <div>
                              <span className="text-[11px] text-zinc-400 block">{t.issuedVoucher}</span>
                              <div className="font-mono font-extrabold text-xl tracking-wider text-[#FFD400] mt-0.5 select-all tabular-nums">
                                {pendingPayment.voucherCode}
                              </div>
                            </div>

                            <div className="grid grid-cols-2 gap-2">
                              <button
                                type="button"
                                onClick={() => handleCopyVoucher(pendingPayment.voucherCode!)}
                                className="inline-flex items-center justify-center gap-1.5 min-h-[42px] px-3 rounded-xl text-xs font-semibold bg-white/10 hover:bg-white/15 text-white cursor-pointer active:scale-[0.98] transition-all"
                              >
                                {copiedCode ? (
                                  <>
                                    <Check className="w-3.5 h-3.5 text-emerald-400" />
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
                                className="btn-primary min-h-[42px] px-3 rounded-xl text-xs"
                              >
                                <KeyRound className="w-3.5 h-3.5" />
                                {t.activateNowBtn}
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Collapsible Payment Reference Check */}
                  <div className="pt-2 border-t border-black/[0.06] dark:border-white/[0.07]">
                    <button
                      type="button"
                      onClick={() => setShowRefLookup((prev) => !prev)}
                      className="w-full min-h-[40px] flex items-center justify-between text-xs font-medium text-zinc-600 dark:text-zinc-400 hover:text-[#111113] dark:hover:text-white cursor-pointer"
                    >
                      <span>{t.verifyTitle}</span>
                      <ChevronRight
                        className={`w-4 h-4 transition-transform duration-150 ${showRefLookup ? 'rotate-90' : ''}`}
                      />
                    </button>

                    {showRefLookup && (
                      <div className="mt-2.5 flex flex-col sm:flex-row gap-2">
                        <input
                          type="text"
                          value={lookupRef}
                          onChange={(e) => setLookupRef(e.target.value)}
                          placeholder="TRX-PAY-..."
                          className="flex-1 min-h-[44px] px-3.5 py-2 text-xs font-mono rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20]"
                        />
                        <button
                          type="button"
                          onClick={() => handleCheckPaymentStatus()}
                          className="btn-secondary min-h-[44px] rounded-2xl text-xs"
                        >
                          {t.checkStatus}
                        </button>
                      </div>
                    )}
                  </div>
                </section>
              )}
            </div>
          </div>
        )}

        {/* TAB 2: REDEEM & VALIDATE VOUCHER TOKEN */}
        {activeTab === 'connect' && (
          <section className="max-w-2xl mx-auto ios-surface p-5 sm:p-7 space-y-5">
            <div>
              <h2 className="text-xl font-bold tracking-tight">{t.connectTitle}</h2>
              <p className="text-xs sm:text-sm text-zinc-500 dark:text-zinc-400 mt-1 leading-relaxed">
                {t.connectSubtitle}
              </p>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  {t.tokenInputLabel}
                </label>
                <input
                  type="text"
                  value={voucherInput}
                  onChange={(e) => setVoucherInput(e.target.value.toUpperCase())}
                  placeholder={t.tokenInputPlaceholder}
                  className="w-full min-h-[52px] px-4 py-2 text-base font-mono font-bold uppercase tracking-widest rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20] text-[#111113] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD400]/75"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-zinc-700 dark:text-zinc-300 mb-1.5">
                  {t.deviceLabelInput} <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <Smartphone className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    minLength={2}
                    maxLength={120}
                    value={deviceLabel}
                    onChange={(e) => setDeviceLabel(e.target.value)}
                    placeholder={t.deviceLabelPlaceholder}
                    className="w-full min-h-[48px] pl-10 pr-4 py-2 text-sm rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20] text-[#111113] dark:text-white focus:outline-none focus:ring-2 focus:ring-[#FFD400]/75"
                  />
                </div>
              </div>

              {tokenError && (
                <div className="p-3.5 rounded-2xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{tokenError}</span>
                </div>
              )}

              {tokenNotice && (
                <div className="p-3.5 rounded-2xl border border-[#FFD400]/45 bg-[#FFD400]/12 text-xs text-[#9A7B00] dark:text-[#FFD400]">
                  {tokenNotice}
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
                <button
                  type="button"
                  disabled={validating || !voucherInput.trim()}
                  onClick={() => handleValidateVoucher()}
                  className="btn-secondary min-h-[48px] rounded-2xl text-xs w-full"
                >
                  <ShieldCheck className="w-4 h-4" />
                  {validating ? t.validatingBtn : t.validateBtn}
                </button>
                <button
                  type="button"
                  disabled={activating || !voucherInput.trim()}
                  onClick={() => handleRedeemVoucher()}
                  className="btn-primary min-h-[48px] rounded-2xl text-xs w-full"
                >
                  <Wifi className="w-4 h-4" />
                  {activating ? t.activatingBtn : t.activateBtn}
                </button>
              </div>
            </div>

            {validation && (
              <div className="ios-grouped-cell p-4 space-y-3 text-xs">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2.5 border-b border-black/[0.06] dark:border-white/[0.07]">
                  <span className="font-mono font-bold text-sm">{validation.codeMasked}</span>
                  <span
                    className={`font-semibold ${
                      validation.valid ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500'
                    }`}
                  >
                    {validation.valid ? t.validBadge : `${t.invalidBadge} (${validation.status})`}
                  </span>
                </div>

                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 tabular-nums">
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
                    <span className="font-semibold">
                      {formatDurationLocalized(validation.durationMinutes, lang)}
                    </span>
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

            {operatingMode === 'STANDALONE_MODE' && (
              <div className="pt-2 border-t border-black/[0.06] dark:border-white/[0.07]">
                <button
                  type="button"
                  onClick={() => setShowHardwareInfo((prev) => !prev)}
                  className="w-full min-h-[40px] flex items-center justify-between text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-[#111113] dark:hover:text-white cursor-pointer"
                >
                  <span className="inline-flex items-center gap-1.5">
                    <Info className="w-3.5 h-3.5" />
                    {t.showNetworkNotice}
                  </span>
                  <ChevronDown
                    className={`w-4 h-4 transition-transform duration-150 ${showHardwareInfo ? 'rotate-180' : ''}`}
                  />
                </button>
                {showHardwareInfo && (
                  <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400 leading-relaxed ios-grouped-cell p-3.5">
                    {t.airtelNoticeBody}
                  </p>
                )}
              </div>
            )}
          </section>
        )}

        {/* TAB 3: ACCOUNT HISTORY & SUPPORT */}
        {activeTab === 'account' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-start">
            <section className="lg:col-span-6 ios-surface p-5 sm:p-6 space-y-4">
              <div>
                <h2 className="text-lg font-bold tracking-tight">{t.accountLookupTitle}</h2>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.accountLookupSubtitle}</p>
              </div>

              {accountError && (
                <div className="p-3 rounded-2xl border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300">
                  {accountError}
                </div>
              )}

              <form onSubmit={handleLookupAccount} className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-zinc-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    required
                    value={accountQuery}
                    onChange={(e) => setAccountQuery(e.target.value)}
                    placeholder={t.lookupPhonePlaceholder}
                    className="w-full min-h-[46px] pl-10 pr-3.5 py-2 text-xs font-mono rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={searchingAccount}
                  className="btn-primary min-h-[46px] rounded-2xl text-xs"
                >
                  {t.lookupBtn}
                </button>
              </form>

              {purchases.length > 0 ? (
                <div className="divide-y divide-black/[0.06] dark:divide-white/[0.07] ios-grouped-cell overflow-hidden">
                  {purchases.map((p) => (
                    <div
                      key={p.reference}
                      className="p-3.5 flex flex-wrap items-center justify-between gap-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold truncate">
                          {p.packageName} · {p.businessName}
                        </div>
                        <div className="font-mono text-zinc-500 text-[11px] tabular-nums">
                          {p.reference} · {p.status} · {formatTzs(p.amountTzs)}
                        </div>
                      </div>
                      {p.voucherCode ? (
                        <button
                          type="button"
                          onClick={() => handleActivateTokenDirectly(p.voucherCode!)}
                          className="btn-chip-accent font-mono min-h-[36px]"
                        >
                          {p.voucherCode} · {t.useCodeBtn}
                        </button>
                      ) : (
                        <span className="font-mono text-zinc-500">{p.voucherMasked || '—'}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-zinc-500 dark:text-zinc-400 py-2">{t.purchasesEmpty}</p>
              )}
            </section>

            <section className="lg:col-span-6 ios-surface p-5 sm:p-6 space-y-4">
              <div>
                <h3 className="text-lg font-bold tracking-tight">{t.supportTitle}</h3>
                <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">{t.supportSubtitle}</p>
              </div>

              {supportNotice && (
                <div className="p-3 rounded-2xl border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/35 text-xs text-emerald-700 dark:text-emerald-300">
                  {supportNotice}
                </div>
              )}

              <form onSubmit={handleSubmitSupport} className="space-y-3 text-xs">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div>
                    <label className="block font-semibold mb-1.5">{t.phoneLabel}</label>
                    <input
                      type="tel"
                      required
                      value={supportPhone}
                      onChange={(e) => setSupportPhone(e.target.value)}
                      placeholder="0754 123 456"
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20] font-mono"
                    />
                  </div>
                  <div>
                    <label className="block font-semibold mb-1.5">{t.supportSubjectLabel}</label>
                    <input
                      type="text"
                      required
                      value={supportSubject}
                      onChange={(e) => setSupportSubject(e.target.value)}
                      placeholder="Voucher / Connection help"
                      className="w-full min-h-[44px] px-3.5 py-2 rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20]"
                    />
                  </div>
                </div>
                <div>
                  <label className="block font-semibold mb-1.5">{t.supportMessageLabel}</label>
                  <textarea
                    rows={3}
                    required
                    value={supportMessage}
                    onChange={(e) => setSupportMessage(e.target.value)}
                    placeholder="Describe your issue or payment reference..."
                    className="w-full px-3.5 py-2.5 rounded-2xl border border-black/[0.08] dark:border-white/[0.1] bg-[#F5F5F7] dark:bg-[#1D1D20]"
                  />
                </div>
                <button
                  type="submit"
                  disabled={sendingSupport}
                  className="btn-secondary min-h-[46px] rounded-2xl text-xs w-full sm:w-auto"
                >
                  <LifeBuoy className="w-4 h-4" />
                  {t.supportSubmitBtn}
                </button>
              </form>
            </section>

            {currentBusiness && (
              <section className="lg:col-span-12 ios-surface p-5 sm:p-6 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-2 pb-3 border-b border-black/[0.06] dark:border-white/[0.07]">
                  <div>
                    <h3 className="text-lg font-bold tracking-tight flex items-center gap-2">
                      <Building2 className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
                      {t.businessDetailsTitle}
                    </h3>
                    <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">
                      {currentBusiness.description || t.aboutProviderDefault}
                    </p>
                  </div>
                  <span className="font-mono text-xs text-zinc-500 dark:text-zinc-400">
                    {currentBusiness.name} ({currentBusiness.currency})
                  </span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 text-xs">
                  <div className="ios-grouped-cell p-3.5 space-y-1">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5" />
                      {t.contactLabel}
                    </span>
                    <p className="font-mono font-semibold text-zinc-900 dark:text-white">
                      {currentBusiness.hotspotSupportPhone || '—'}
                    </p>
                  </div>

                  <div className="ios-grouped-cell p-3.5 space-y-1">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      {t.supportHoursLabel}
                    </span>
                    <p className="font-medium text-zinc-900 dark:text-white">
                      {currentBusiness.supportHours || 'Mon–Sun'}
                    </p>
                  </div>

                  <div className="ios-grouped-cell p-3.5 space-y-1">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5" />
                      {t.addressLabel}
                    </span>
                    <p className="font-medium text-zinc-900 dark:text-white">
                      {[currentBusiness.physicalAddress, currentBusiness.city, currentBusiness.country]
                        .filter(Boolean)
                        .join(', ')}
                    </p>
                  </div>

                  <div className="ios-grouped-cell p-3.5 space-y-1">
                    <span className="text-[11px] text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
                      <Globe className="w-3.5 h-3.5" />
                      {t.websiteLabel}
                    </span>
                    {getSafePortalUrl(currentBusiness.websiteUrl) ? (
                      <a
                        href={getSafePortalUrl(currentBusiness.websiteUrl)!}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 font-mono font-semibold text-[#9A7B00] dark:text-[#FFD400] hover:underline break-all"
                      >
                        <span>{getSafePortalUrl(currentBusiness.websiteUrl)}</span>
                        <ExternalLink className="w-3 h-3 shrink-0" />
                      </a>
                    ) : (
                      <p className="font-mono text-zinc-600 dark:text-zinc-300">
                        {currentBusiness.wifiSsid ? `WiFi: ${currentBusiness.wifiSsid}` : currentBusiness.country}
                      </p>
                    )}
                  </div>
                </div>
              </section>
            )}
          </div>
        )}

          </MobilePageTransition>
        </AnimatePresence>

        {/* Quiet Customer Footer with Discreet Operator Link */}
        <footer className="pt-4 border-t border-black/[0.06] dark:border-white/[0.07] flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500 dark:text-zinc-500">
          <span>
            {currentBusiness?.name || 'TRAX LINK'} · CONNECT. MANAGE. GROW.
            {currentBusiness?.hotspotSupportPhone ? ` · Support: ${currentBusiness.hotspotSupportPhone}` : ''}
          </span>
          <button
            type="button"
            onClick={onSwitchToAdmin}
            className="text-xs font-medium text-zinc-500 dark:text-zinc-400 hover:text-[#111113] dark:hover:text-[#FFD400] transition-colors cursor-pointer"
          >
            {t.staffLink}
          </button>
        </footer>
      </main>

      {/* Fixed iPhone-Style Frosted Bottom Tab Bar (Mobile Only) */}
      <LayoutGroup id="portalMobileNav">
        <nav
          aria-label="Customer bottom navigation"
          className="md:hidden fixed bottom-0 left-0 right-0 z-40 border-t ios-glass-bar pb-safe"
        >
          <div className="grid grid-cols-3 h-[56px] items-center max-w-md mx-auto">
            {(
              [
                { key: 'buy', label: t.tabBuyShort, Icon: Wifi },
                { key: 'connect', label: t.tabConnectShort, Icon: KeyRound },
                { key: 'account', label: t.tabAccountShort, Icon: UserCircle2 },
              ] as const
            ).map(({ key, label, Icon }) => {
              const isActive = activeTab === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => switchTab(key)}
                  className={`relative min-h-[44px] flex flex-col items-center justify-center gap-0.5 cursor-pointer transition-colors ${
                    isActive
                      ? 'text-[#9A7B00] dark:text-[#FFD400]'
                      : 'text-zinc-500 dark:text-zinc-400'
                  }`}
                >
                  {isActive && (
                    <motion.span
                      layoutId="portalMobileTabIndicator"
                      transition={NATIVE_SPRING}
                      className="absolute top-0.5 w-8 h-0.5 rounded-full bg-[#FFD400]"
                      aria-hidden="true"
                    />
                  )}
                  <Icon className="w-5 h-5" />
                  <span className="text-[11px] font-semibold tracking-tight whitespace-nowrap">
                    {label}
                  </span>
                </button>
              );
            })}
          </div>
        </nav>
      </LayoutGroup>
    </div>
  );
}
