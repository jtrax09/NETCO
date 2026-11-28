import React, { useEffect, useState } from 'react';
import { AnimatePresence } from 'motion/react';
import { signInWithPopup } from 'firebase/auth';
import {
  ArrowLeft,
  ArrowRight,
  Building2,
  CheckCircle2,
  CreditCard,
  Eye,
  EyeOff,
  Globe,
  KeyRound,
  Lock,
  Mail,
  MapPin,
  Phone,
  ShieldCheck,
  User,
  Wifi,
} from 'lucide-react';
import { auth, googleAuthProvider } from '../lib/firebase.ts';
import { apiRequest } from '../lib/api.ts';
import { TRANSLATIONS, type AppLanguage } from '../lib/i18n.ts';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';
import { TraxLogo } from './NetcoLogo.tsx';
import { MobilePageTransition } from './ui/MotionPrimitives.tsx';

export interface AuthUser {
  id: string;
  businessId?: string;
  businessName?: string | null;
  businessStatus?: string;
  email: string;
  fullName: string;
  role:
    | 'SUPER_ADMIN'
    | 'BUSINESS_OWNER'
    | 'ADMIN'
    | 'ACCOUNTANT'
    | 'NETWORK_OPERATOR'
    | 'SUPPORT_STAFF'
    | 'CASHIER';
}

interface Props {
  onAuthenticated: (token: string, user: AuthUser, source: 'SESSION' | 'FIREBASE') => void;
  onSwitchToPortal: () => void;
  lang: AppLanguage;
  onToggleLang: () => void;
}

export function AdminAuthGate({ onAuthenticated, onSwitchToPortal, lang, onToggleLang }: Props) {
  const t = TRANSLATIONS[lang].auth;
  const [bootstrapStatus, setBootstrapStatus] = useState<{
    needsPasswordBootstrap: boolean;
    envPasscodeConfigured: boolean;
  } | null>(null);

  const [mode, setMode] = useState<'login' | 'register' | 'bootstrap' | 'forgot'>('login');
  const [forgotStep, setForgotStep] = useState<'request' | 'verify'>('request');

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [setupPasscode, setSetupPasscode] = useState('');

  // Business self-service registration state
  const [businessName, setBusinessName] = useState('');
  const [phone, setPhone] = useState('');
  const [country, setCountry] = useState('Tanzania');
  const [region, setRegion] = useState('Dar es Salaam');
  const [planCode, setPlanCode] = useState<'STARTER' | 'GROWTH' | 'ENTERPRISE'>('STARTER');

  const [resetCode, setResetCode] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNewPassword, setShowNewPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [infoMessage, setInfoMessage] = useState<string | null>(null);

  useEffect(() => {
    apiRequest<{ needsPasswordBootstrap: boolean; envPasscodeConfigured: boolean }>(
      '/api/auth/bootstrap-status'
    )
      .then((res) => {
        setBootstrapStatus(res);
        if (res.needsPasswordBootstrap) {
          setMode('bootstrap');
        }
      })
      .catch(() => {
        setBootstrapStatus({ needsPasswordBootstrap: false, envPasscodeConfigured: false });
      });
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      if (mode === 'bootstrap') {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/bootstrap', {
          method: 'POST',
          body: { email, fullName, password, setupPasscode: setupPasscode || undefined },
        });
        onAuthenticated(res.token, res.user, 'SESSION');
      } else if (mode === 'register') {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/register-business', {
          method: 'POST',
          body: {
            businessName,
            ownerName: fullName,
            ownerEmail: email,
            phone,
            password,
            country,
            region,
            planCode,
          },
        });
        onAuthenticated(res.token, res.user, 'SESSION');
      } else {
        const res = await apiRequest<{ token: string; user: AuthUser }>('/api/auth/login', {
          method: 'POST',
          body: { email, password },
        });
        onAuthenticated(res.token, res.user, 'SESSION');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  const handleRequestReset = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const res = await apiRequest<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
        method: 'POST',
        body: { email },
      });
      setInfoMessage(res.message);
      setForgotStep('verify');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to request password reset');
    } finally {
      setLoading(false);
    }
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfoMessage(null);
    if (newPassword !== confirmPassword) {
      setError(t.passwordMismatch);
      return;
    }
    setLoading(true);
    try {
      await apiRequest<{ ok: boolean; message: string }>('/api/auth/reset-password', {
        method: 'POST',
        body: { email, code: resetCode, newPassword },
      });
      setMode('login');
      setForgotStep('request');
      setPassword('');
      setResetCode('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPassword(false);
      setShowNewPassword(false);
      setShowConfirmPassword(false);
      setInfoMessage(t.resetSuccess);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset password');
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setInfoMessage(null);
    setLoading(true);
    try {
      const cred = await signInWithPopup(auth, googleAuthProvider);
      const idToken = await cred.user.getIdToken();
      const me = await apiRequest<{ user: AuthUser }>('/api/auth/me', { token: idToken });
      onAuthenticated(idToken, me.user, 'FIREBASE');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google Sign-In failed');
    } finally {
      setLoading(false);
    }
  };

  const openForgotPassword = () => {
    setMode('forgot');
    setForgotStep('request');
    setError(null);
    setInfoMessage(null);
  };

  const backToLogin = () => {
    setMode('login');
    setForgotStep('request');
    setError(null);
    setInfoMessage(null);
  };

  return (
    <div className="min-h-[100dvh] bg-stone-100 dark:bg-[#08090C] cinematic-backdrop flex flex-col justify-center px-3.5 sm:px-6 py-4 sm:py-6">
      <div className="max-w-5xl w-full mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 lg:gap-8 items-center">
        {/* Desktop Cinematic Brand Showcase */}
        <aside className="hidden lg:flex lg:col-span-6 flex-col justify-between p-7 rounded-3xl bg-gradient-to-br from-[#101219] via-[#131722] to-[#0A0C10] border border-[#FFD400]/22 shadow-[0_24px_64px_-24px_rgba(0,0,0,0.85)] text-white relative overflow-hidden min-h-[470px]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -top-24 -right-24 w-64 h-64 rounded-full bg-[#FFD400]/12 blur-3xl"
          />
          <div className="relative z-10 space-y-6">
            <TraxLogo variant="banner" />
            <div className="space-y-2.5 pt-2">
              <span className="inline-flex items-center gap-1.5 font-futuristic text-[10px] uppercase tracking-[0.2em] text-[#FFD400]">
                {t.staffConsole}
              </span>
              <h1 className="font-display text-3xl font-bold tracking-tight leading-tight text-white text-balance">
                WiFi Billing &amp; Network Command Center
              </h1>
              <p className="text-xs sm:text-sm text-zinc-400 leading-relaxed max-w-md">
                Operate voucher hotspots, mobile money &amp; card checkouts, FreeRADIUS policies, and MikroTik gateways from one unified console.
              </p>
            </div>
          </div>

          <div className="relative z-10 space-y-2.5 pt-6 border-t border-white/10 text-xs">
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <Wifi className="w-4 h-4 text-[#FFD400] shrink-0" />
              <span className="text-zinc-200">Standalone Mode &amp; MikroTik RouterOS API + MNDP discovery</span>
            </div>
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <CreditCard className="w-4 h-4 text-emerald-400 shrink-0" />
              <span className="text-zinc-200">M-Pesa, Airtel Money, Tigo Pesa, HaloPesa &amp; Card billing</span>
            </div>
            <div className="flex items-center gap-3 p-2.5 rounded-xl bg-white/[0.04] border border-white/[0.06]">
              <ShieldCheck className="w-4 h-4 text-sky-400 shrink-0" />
              <span className="text-zinc-200">Multi-tenant workspace isolation &amp; role-based access</span>
            </div>
          </div>
        </aside>

        {/* Fitted Auth Panel */}
        <div className="lg:col-span-6 w-full max-w-[430px] mx-auto space-y-3.5">
          <div className="flex items-center justify-between gap-2">
            <span className="lg:hidden text-[11px] font-futuristic uppercase tracking-[0.14em] text-zinc-500 dark:text-zinc-400">
              {t.staffConsole}
            </span>
            <span className="hidden lg:inline text-[11px] font-mono text-zinc-500 dark:text-zinc-400">
              Secure Operator Access
            </span>
            <div className="flex items-center gap-2">
              <LanguageSwitcher lang={lang} onToggleLang={onToggleLang} />
              <button
                type="button"
                onClick={onSwitchToPortal}
                className="btn-secondary min-h-[36px] px-3 py-1.5 text-xs"
              >
                {t.buyVoucher}
                <ArrowRight className="w-3.5 h-3.5 text-[#B8860B] dark:text-[#FFD400]" />
              </button>
            </div>
          </div>

          <div className="lg:hidden flex justify-center">
            <div className="w-full flex justify-center p-3 rounded-2xl bg-[#101217] border border-[#FFD400]/25 shadow-[0_12px_32px_-16px_rgba(255,212,0,0.28)]">
              <TraxLogo variant="banner" />
            </div>
          </div>

          <div className="bg-white/95 dark:bg-[#12141A]/95 backdrop-blur-xl border border-stone-200 dark:border-white/12 rounded-2xl p-4 sm:p-5 space-y-3.5 shadow-xl">
            <div>
              <h2 className="font-display text-lg font-bold tracking-tight text-[#101010] dark:text-white">
                {mode === 'bootstrap'
                  ? t.claimTitle
                  : mode === 'register'
                  ? t.registerTitle
                  : mode === 'forgot'
                  ? t.resetTitle
                  : t.signInTitle}
              </h2>
              <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
                {mode === 'bootstrap'
                  ? t.claimSubtitle
                  : mode === 'register'
                  ? t.registerSubtitle
                  : mode === 'forgot'
                  ? forgotStep === 'request'
                    ? t.resetReqSubtitle
                    : t.resetVerifySubtitle
                  : t.signInSubtitle}
              </p>
            </div>

            {mode !== 'forgot' && (
              <div className="btn-tab-group w-full overflow-x-auto">
                <button
                  type="button"
                  onClick={() => {
                    setMode('login');
                    setError(null);
                    setInfoMessage(null);
                  }}
                  className={`flex-1 ${mode === 'login' ? 'btn-tab-active' : 'btn-tab'}`}
                >
                  {t.tabLogin}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode('register');
                    setError(null);
                    setInfoMessage(null);
                  }}
                  className={`flex-1 ${mode === 'register' ? 'btn-tab-active' : 'btn-tab'}`}
                >
                  {t.tabRegister}
                </button>
                {bootstrapStatus && (bootstrapStatus.needsPasswordBootstrap || bootstrapStatus.envPasscodeConfigured) && (
                  <button
                    type="button"
                    onClick={() => {
                      setMode('bootstrap');
                      setError(null);
                      setInfoMessage(null);
                    }}
                    className={`flex-1 ${mode === 'bootstrap' ? 'btn-tab-active' : 'btn-tab'}`}
                  >
                    {t.tabBootstrap}
                  </button>
                )}
              </div>
            )}

            {error && (
              <div className="p-2.5 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
                {error}
              </div>
            )}

            {infoMessage && (
              <div className="p-2.5 rounded-lg border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
                <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
                <span>{infoMessage}</span>
              </div>
            )}

            <AnimatePresence mode="wait" initial={false}>
              <MobilePageTransition key={`${mode}-${forgotStep}`}>
          {mode === 'forgot' ? (
            forgotStep === 'request' ? (
              <form onSubmit={handleRequestReset} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.emailLabel}
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                  </div>
                </div>

                <button type="submit" disabled={loading} className="btn-primary w-full min-h-[46px] text-sm">
                  {loading ? t.sendingBtn : t.requestCodeBtn}
                </button>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <button
                    type="button"
                    onClick={backToLogin}
                    className="inline-flex items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-400 hover:text-[#101010] dark:hover:text-white cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    {t.backToSignIn}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setForgotStep('verify');
                    }}
                    className="font-medium text-[#B8860B] dark:text-[#FFD400] hover:underline cursor-pointer"
                  >
                    {t.alreadyHaveCode}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.emailLabel}
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.recoveryCodeLabel}
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.toUpperCase())}
                      placeholder="XXXX-XXXX"
                      className="w-full pl-9 pr-3 py-2 text-sm font-mono tracking-wider rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.newPasswordLabel}
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={t.min8Placeholder}
                      className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((v) => !v)}
                      aria-label={showNewPassword ? t.hidePassword : t.showPassword}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-zinc-400 hover:text-[#101010] dark:hover:text-white cursor-pointer"
                    >
                      {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.confirmPasswordLabel}
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder={t.repeatPasswordPlaceholder}
                      className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      aria-label={showConfirmPassword ? t.hidePassword : t.showPassword}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-zinc-400 hover:text-[#101010] dark:hover:text-white cursor-pointer"
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button type="submit" disabled={loading} className="btn-primary w-full min-h-[46px] text-sm">
                  {loading ? t.updatingBtn : t.updatePasswordBtn}
                </button>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <button
                    type="button"
                    onClick={backToLogin}
                    className="inline-flex items-center gap-1.5 font-medium text-zinc-600 dark:text-zinc-400 hover:text-[#101010] dark:hover:text-white cursor-pointer"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    {t.backToSignIn}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setError(null);
                      setForgotStep('request');
                    }}
                    className="font-medium text-[#B8860B] dark:text-[#FFD400] hover:underline cursor-pointer"
                  >
                    {t.requestNewCode}
                  </button>
                </div>
              </form>
            )
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3.5">
              {mode === 'register' && (
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.businessNameLabel}
                  </label>
                  <div className="relative">
                    <Building2 className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={businessName}
                      onChange={(e) => setBusinessName(e.target.value)}
                      placeholder={t.businessNamePlaceholder}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                  </div>
                </div>
              )}

              {(mode === 'bootstrap' || mode === 'register') && (
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.fullNameLabel}
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder={mode === 'bootstrap' ? 'TRAX LINK Platform Super Admin' : 'Juma Hassan'}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                  </div>
                </div>
              )}

              {mode === 'register' && (
                <>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                        {t.phoneLabel}
                      </label>
                      <div className="relative">
                        <Phone className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="tel"
                          required
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="+255 754 000 111"
                          className="w-full pl-9 pr-3 py-2 text-sm font-mono rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                        {t.planLabel}
                      </label>
                      <select
                        value={planCode}
                        onChange={(e) => setPlanCode(e.target.value as typeof planCode)}
                        className="w-full px-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                      >
                        <option value="STARTER">Starter (25k TZS/mo)</option>
                        <option value="GROWTH">Growth (65k TZS/mo)</option>
                        <option value="ENTERPRISE">Enterprise (180k TZS/mo)</option>
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-2.5">
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                        {t.countryLabel}
                      </label>
                      <div className="relative">
                        <Globe className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          required
                          value={country}
                          onChange={(e) => setCountry(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                        {t.regionLabel}
                      </label>
                      <div className="relative">
                        <MapPin className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                        <input
                          type="text"
                          required
                          value={region}
                          onChange={(e) => setRegion(e.target.value)}
                          className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010]"
                        />
                      </div>
                    </div>
                  </div>
                </>
              )}

              <div>
                <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                  {t.emailAddressLabel}
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t.emailPlaceholder}
                    className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300">
                    {t.passwordLabel}
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={openForgotPassword}
                      className="text-xs font-medium text-[#B8860B] dark:text-[#FFD400] hover:underline cursor-pointer"
                    >
                      {t.forgotPassword}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={mode === 'bootstrap' || mode === 'register' ? 8 : 1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={
                      mode === 'bootstrap' || mode === 'register' ? t.min8Placeholder : t.passwordPlaceholder
                    }
                    className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t.hidePassword : t.showPassword}
                    title={showPassword ? t.hidePassword : t.showPassword}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-zinc-400 hover:text-[#101010] dark:hover:text-white cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'bootstrap' && bootstrapStatus?.envPasscodeConfigured && (
                <div>
                  <label className="block text-xs font-medium text-zinc-700 dark:text-zinc-300 mb-1.5">
                    {t.setupPasscodeLabel}
                  </label>
                  <div className="relative">
                    <ShieldCheck className="w-4 h-4 text-zinc-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      required
                      value={setupPasscode}
                      onChange={(e) => setSetupPasscode(e.target.value)}
                      placeholder="ADMIN_INITIAL_PASSCODE"
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-stone-200 dark:border-zinc-700 bg-stone-50 dark:bg-[#101010] text-[#101010] dark:text-white focus:outline-none focus:border-[#FFD400]"
                    />
                  </div>
                </div>
              )}

              <button type="submit" disabled={loading} className="btn-primary w-full min-h-[46px] text-sm">
                {loading
                  ? mode === 'register'
                    ? t.creatingBusinessBtn
                    : t.signingInBtn
                  : mode === 'bootstrap'
                  ? t.createAdminBtn
                  : mode === 'register'
                  ? t.createBusinessBtn
                  : t.signInBtn}
              </button>
            </form>
          )}
            </MobilePageTransition>
          </AnimatePresence>

          {mode !== 'register' && (
            <>
              <div className="relative flex items-center py-1">
                <div className="flex-grow border-t border-stone-200 dark:border-zinc-800" />
                <span className="px-3 text-xs text-zinc-400">{t.orDivider}</span>
                <div className="flex-grow border-t border-stone-200 dark:border-zinc-800" />
              </div>

              <button
                type="button"
                disabled={loading}
                onClick={handleGoogleSignIn}
                className="btn-secondary w-full min-h-[42px] text-sm"
              >
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    fill="#4285F4"
                    d="M23.745 12.27c0-.7-.06-1.4-.19-2.07H12v4.51h6.6c-.29 1.52-1.14 2.82-2.4 3.68v3.05h3.88c2.27-2.09 3.665-5.17 3.665-9.17Z"
                  />
                  <path
                    fill="#34A853"
                    d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.88-3.05c-1.08.72-2.45 1.16-4.05 1.16-3.12 0-5.77-2.11-6.72-4.96H1.29v3.14C3.26 21.3 7.31 24 12 24Z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M5.28 14.24c-.24-.72-.38-1.49-.38-2.24s.14-1.52.38-2.24V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.99-3.14Z"
                  />
                  <path
                    fill="#EA4335"
                    d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.7 1.29 6.62l3.99 3.14c.95-2.85 3.6-4.96 6.72-4.96Z"
                  />
                </svg>
                {t.googleBtn}
              </button>
            </>
          )}
          </div>
        </div>
      </div>
    </div>
  );
}
