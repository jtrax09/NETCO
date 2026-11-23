import React, { useEffect, useState } from 'react';
import { signInWithPopup } from 'firebase/auth';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  Mail,
  ShieldCheck,
  User,
} from 'lucide-react';
import { auth, googleAuthProvider } from '../lib/firebase.ts';
import { apiRequest } from '../lib/api.ts';
import { TRANSLATIONS, type AppLanguage } from '../lib/i18n.ts';
import { LanguageSwitcher } from './LanguageSwitcher.tsx';
import { NetcoLogo } from './NetcoLogo.tsx';

export interface AuthUser {
  id: string;
  email: string;
  fullName: string;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'NETWORK_OPERATOR' | 'CASHIER';
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

  const [mode, setMode] = useState<'login' | 'bootstrap' | 'forgot'>('login');
  const [forgotStep, setForgotStep] = useState<'request' | 'verify'>('request');

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [setupPasscode, setSetupPasscode] = useState('');

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
    <div className="min-h-screen bg-slate-50 dark:bg-[#080B12] flex flex-col justify-center px-3.5 sm:px-4 py-6 sm:py-12">
      <div className="max-w-md w-full mx-auto space-y-5 sm:space-y-6">
        <div className="flex flex-col items-center gap-3">
          <div className="w-full flex items-center justify-between gap-2">
            <span className="text-[11px] font-mono uppercase tracking-wider text-slate-500 dark:text-[#8793A5]">
              {t.staffConsole}
            </span>
            <div className="flex items-center gap-2">
              <LanguageSwitcher lang={lang} onToggleLang={onToggleLang} />
              <button
                type="button"
                onClick={onSwitchToPortal}
                className="btn-secondary min-h-[38px] px-3 text-xs"
              >
                {t.buyVoucher}
                <ArrowRight className="w-3.5 h-3.5 text-[#16B8FF]" />
              </button>
            </div>
          </div>
          <NetcoLogo variant="banner" className="py-1" />
        </div>

        <div className="bg-white dark:bg-[#101827] border border-slate-200 dark:border-slate-800 rounded-2xl p-5 sm:p-6 space-y-5 shadow-sm">
          <div>
            <h2 className="text-lg font-semibold text-slate-900 dark:text-white">
              {mode === 'bootstrap'
                ? t.claimTitle
                : mode === 'forgot'
                ? t.resetTitle
                : t.signInTitle}
            </h2>
            <p className="text-sm text-slate-500 dark:text-[#8793A5] mt-1">
              {mode === 'bootstrap'
                ? t.claimSubtitle
                : mode === 'forgot'
                ? forgotStep === 'request'
                  ? t.resetReqSubtitle
                  : t.resetVerifySubtitle
                : t.signInSubtitle}
            </p>
          </div>

          {bootstrapStatus && mode !== 'forgot' && (
            <div className="btn-tab-group w-full">
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
              {(bootstrapStatus.needsPasswordBootstrap || bootstrapStatus.envPasscodeConfigured) && (
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
            <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
              {error}
            </div>
          )}

          {infoMessage && (
            <div className="p-3 rounded-lg border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{infoMessage}</span>
            </div>
          )}

          {mode === 'forgot' ? (
            forgotStep === 'request' ? (
              <form onSubmit={handleRequestReset} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.emailLabel}
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full min-h-[46px] text-sm"
                >
                  {loading ? t.sendingBtn : t.requestCodeBtn}
                </button>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <button
                    type="button"
                    onClick={backToLogin}
                    className="inline-flex items-center gap-1.5 font-medium text-slate-600 dark:text-[#8793A5] hover:text-slate-900 dark:hover:text-white cursor-pointer"
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
                    className="font-medium text-[#0284C7] dark:text-[#16B8FF] hover:underline cursor-pointer"
                  >
                    {t.alreadyHaveCode}
                  </button>
                </div>
              </form>
            ) : (
              <form onSubmit={handleResetPassword} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.emailLabel}
                  </label>
                  <div className="relative">
                    <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder={t.emailPlaceholder}
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.recoveryCodeLabel}
                  </label>
                  <div className="relative">
                    <KeyRound className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={resetCode}
                      onChange={(e) => setResetCode(e.target.value.toUpperCase())}
                      placeholder="XXXX-XXXX"
                      className="w-full pl-9 pr-3 py-2 text-sm font-mono tracking-wider rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.newPasswordLabel}
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showNewPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      placeholder={t.min8Placeholder}
                      className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowNewPassword((v) => !v)}
                      aria-label={showNewPassword ? t.hidePassword : t.showPassword}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                    >
                      {showNewPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.confirmPasswordLabel}
                  </label>
                  <div className="relative">
                    <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type={showConfirmPassword ? 'text' : 'password'}
                      required
                      minLength={8}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder={t.repeatPasswordPlaceholder}
                      className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                    <button
                      type="button"
                      onClick={() => setShowConfirmPassword((v) => !v)}
                      aria-label={showConfirmPassword ? t.hidePassword : t.showPassword}
                      className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                    >
                      {showConfirmPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={loading}
                  className="btn-primary w-full min-h-[46px] text-sm"
                >
                  {loading ? t.updatingBtn : t.updatePasswordBtn}
                </button>

                <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                  <button
                    type="button"
                    onClick={backToLogin}
                    className="inline-flex items-center gap-1.5 font-medium text-slate-600 dark:text-[#8793A5] hover:text-slate-900 dark:hover:text-white cursor-pointer"
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
                    className="font-medium text-[#0284C7] dark:text-[#16B8FF] hover:underline cursor-pointer"
                  >
                    {t.requestNewCode}
                  </button>
                </div>
              </form>
            )
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              {mode === 'bootstrap' && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.fullNameLabel}
                  </label>
                  <div className="relative">
                    <User className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      required
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="Chief Network Administrator"
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                  {t.emailAddressLabel}
                </label>
                <div className="relative">
                  <Mail className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder={t.emailPlaceholder}
                    className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                  />
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between gap-2 mb-1.5">
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                    {t.passwordLabel}
                  </label>
                  {mode === 'login' && (
                    <button
                      type="button"
                      onClick={openForgotPassword}
                      className="text-xs font-medium text-[#0284C7] dark:text-[#16B8FF] hover:underline cursor-pointer"
                    >
                      {t.forgotPassword}
                    </button>
                  )}
                </div>
                <div className="relative">
                  <Lock className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type={showPassword ? 'text' : 'password'}
                    required
                    minLength={mode === 'bootstrap' ? 8 : 1}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder={mode === 'bootstrap' ? t.min8Placeholder : t.passwordPlaceholder}
                    className="w-full pl-9 pr-10 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword((v) => !v)}
                    aria-label={showPassword ? t.hidePassword : t.showPassword}
                    title={showPassword ? t.hidePassword : t.showPassword}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md text-slate-400 hover:text-slate-700 dark:hover:text-white cursor-pointer"
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              {mode === 'bootstrap' && bootstrapStatus?.envPasscodeConfigured && (
                <div>
                  <label className="block text-xs font-medium text-slate-700 dark:text-slate-300 mb-1.5">
                    {t.setupPasscodeLabel}
                  </label>
                  <div className="relative">
                    <ShieldCheck className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="password"
                      required
                      value={setupPasscode}
                      onChange={(e) => setSetupPasscode(e.target.value)}
                      placeholder="ADMIN_INITIAL_PASSCODE"
                      className="w-full pl-9 pr-3 py-2 text-sm rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-[#080B12] text-slate-900 dark:text-white focus:outline-none focus:border-[#16B8FF]"
                    />
                  </div>
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full min-h-[46px] text-sm"
              >
                {loading
                  ? t.signingInBtn
                  : mode === 'bootstrap'
                  ? t.createAdminBtn
                  : t.signInBtn}
              </button>
            </form>
          )}

          <div className="relative flex items-center py-1">
            <div className="flex-grow border-t border-slate-200 dark:border-slate-800" />
            <span className="px-3 text-xs text-slate-400 dark:text-[#8793A5]">{t.orDivider}</span>
            <div className="flex-grow border-t border-slate-200 dark:border-slate-800" />
          </div>

          <button
            type="button"
            disabled={loading}
            onClick={handleGoogleSignIn}
            className="btn-secondary w-full min-h-[46px] text-sm"
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
        </div>
      </div>
    </div>
  );
}
