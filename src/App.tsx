import React, { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { signOut } from 'firebase/auth';
import {
  Activity,
  BarChart3,
  Bell,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Menu,
  Moon,
  Package,
  Router,
  Shield,
  Sun,
  Ticket,
  Users,
  X,
} from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { LanguageSwitcher } from './components/LanguageSwitcher.tsx';
import { NETCO_LOGO_URL } from './components/NetcoLogo.tsx';
import { AdminAuthGate, type AuthUser } from './components/AdminAuthGate.tsx';
import { PortalView } from './components/PortalView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { CustomersView } from './components/CustomersView.tsx';
import { PackagesView } from './components/PackagesView.tsx';
import { VouchersView } from './components/VouchersView.tsx';
import { SessionsView } from './components/SessionsView.tsx';
import { PaymentsView } from './components/PaymentsView.tsx';
import { RoutersView } from './components/RoutersView.tsx';
import { ReportsView } from './components/ReportsView.tsx';
import { NotificationsView } from './components/NotificationsView.tsx';
import { StaffAuditView } from './components/StaffAuditView.tsx';
import {
  LiquidGlassExpandableSidebar,
  type GlassNavGroup,
  type GlassNavItem,
} from './components/ui/liquid-glass-expandable-sidebar.tsx';
import { apiRequest } from './lib/api.ts';
import { auth, syncWorkspacePreference } from './lib/firebase.ts';
import { getInitialLanguage, saveLanguage, TRANSLATIONS, type AppLanguage } from './lib/i18n.ts';

type AdminSection =
  | 'dashboard'
  | 'customers'
  | 'packages'
  | 'vouchers'
  | 'sessions'
  | 'payments'
  | 'routers'
  | 'reports'
  | 'notifications'
  | 'staff';

const SECTION_LABELS: Record<AdminSection, string> = {
  dashboard: 'Dashboard',
  customers: 'Customers',
  packages: 'Packages',
  vouchers: 'Vouchers',
  sessions: 'Active Sessions',
  payments: 'Payments',
  routers: 'MikroTik Routers',
  reports: 'Reports & Analytics',
  notifications: 'Notifications',
  staff: 'Staff & Audit Logs',
};

function NetcoWorkspace() {
  const [surface, setSurface] = useState<'admin' | 'portal'>(() =>
    window.location.pathname === '/admin' ? 'admin' : 'portal'
  );
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [lang, setLang] = useState<AppLanguage>(() => getInitialLanguage());
  const [token, setToken] = useState<string | null>(null);
  const [authSource, setAuthSource] = useState<'SESSION' | 'FIREBASE' | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [section, setSection] = useState<AdminSection>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [socketConnected, setSocketConnected] = useState(false);
  const [operatingMode, setOperatingMode] = useState<'STANDALONE_MODE' | 'MIKROTIK_MODE'>('STANDALONE_MODE');
  const [refreshTrigger, setRefreshTrigger] = useState(0);

  useEffect(() => {
    saveLanguage(lang);
  }, [lang]);

  const toggleLang = () => {
    setLang((prev) => (prev === 'en' ? 'sw' : 'en'));
  };

  useEffect(() => {
    const syncFromLocation = () => {
      if (window.location.hash === '#admin' || window.location.pathname === '/admin') {
        setSurface('admin');
      } else {
        setSurface('portal');
      }
    };
    window.addEventListener('hashchange', syncFromLocation);
    return () => window.removeEventListener('hashchange', syncFromLocation);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
  }, [theme]);

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    if (auth.currentUser) {
      void syncWorkspacePreference(auth.currentUser.uid, next, false).catch(() => {});
    }
  };

  useEffect(() => {
    if (!token) {
      setSocketConnected(false);
      return;
    }

    const socket: Socket = io({ transports: ['websocket', 'polling'] });
    socket.on('connect', () => setSocketConnected(true));
    socket.on('disconnect', () => setSocketConnected(false));

    const bump = () => setRefreshTrigger((n) => n + 1);
    socket.on('session:started', bump);
    socket.on('session:ended', bump);
    socket.on('voucher:updated', bump);
    socket.on('payment:updated', bump);
    socket.on('router:status', bump);
    socket.on('notification:new', bump);

    return () => {
      socket.disconnect();
    };
  }, [token]);

  useEffect(() => {
    if (!token) return;
    apiRequest<{ operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE' }>('/api/system/mode')
      .then((res) => setOperatingMode(res.operatingMode))
      .catch(() => {});
  }, [token, refreshTrigger]);

  const handleAuthenticated = (newToken: string, authUser: AuthUser, source: 'SESSION' | 'FIREBASE') => {
    setToken(newToken);
    setUser(authUser);
    setAuthSource(source);
    setSection('dashboard');
  };

  const handleLogout = async () => {
    if (token) {
      await apiRequest('/api/auth/logout', { method: 'POST', token }).catch(() => {});
    }
    if (authSource === 'FIREBASE') {
      await signOut(auth).catch(() => {});
    }
    setToken(null);
    setUser(null);
    setAuthSource(null);
    setMobileMenuOpen(false);
  };

  if (surface === 'portal') {
    return (
      <PortalView
        theme={theme}
        onToggleTheme={toggleTheme}
        lang={lang}
        onToggleLang={toggleLang}
        onSwitchToAdmin={() => {
          setSurface('admin');
        }}
      />
    );
  }

  if (!token || !user) {
    return (
      <AdminAuthGate
        lang={lang}
        onToggleLang={toggleLang}
        onAuthenticated={handleAuthenticated}
        onSwitchToPortal={() => {
          if (window.location.hash === '#admin') {
            window.location.hash = '';
          }
          setSurface('portal');
        }}
      />
    );
  }

  const isSuperOrAdmin = user.role === 'SUPER_ADMIN' || user.role === 'ADMIN';
  const isOperator = isSuperOrAdmin || user.role === 'NETWORK_OPERATOR';
  const isCashier = isSuperOrAdmin || user.role === 'CASHIER';

  const selectSection = (id: AdminSection) => {
    setSection(id);
    setMobileMenuOpen(false);
  };

  const handleSidebarNavigate = (item: GlassNavItem, event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (item.id in SECTION_LABELS) {
      selectSection(item.id as AdminSection);
    }
  };

  const tAdmin = TRANSLATIONS[lang].admin;

  const navGroups: GlassNavGroup[] = [
    {
      label: tAdmin.groups.operations,
      items: [
        { id: 'dashboard', label: tAdmin.sections.dashboard, href: '#dashboard', icon: <LayoutDashboard /> },
        { id: 'customers', label: tAdmin.sections.customers, href: '#customers', icon: <Users /> },
        { id: 'packages', label: tAdmin.sections.packages, href: '#packages', icon: <Package /> },
        { id: 'vouchers', label: tAdmin.sections.vouchers, href: '#vouchers', icon: <Ticket /> },
      ],
    },
    {
      label: tAdmin.groups.networkBilling,
      items: [
        {
          id: 'sessions',
          label: tAdmin.sections.sessions,
          href: '#sessions',
          icon: <Activity />,
          badge: socketConnected ? tAdmin.liveBadge : undefined,
        },
        { id: 'payments', label: tAdmin.sections.payments, href: '#payments', icon: <CreditCard /> },
        { id: 'routers', label: tAdmin.sections.routers, href: '#routers', icon: <Router /> },
        { id: 'reports', label: tAdmin.shortSections.reports, href: '#reports', icon: <BarChart3 /> },
      ],
    },
    {
      label: tAdmin.groups.administration,
      items: [
        { id: 'notifications', label: tAdmin.sections.notifications, href: '#notifications', icon: <Bell /> },
        ...(isSuperOrAdmin
          ? [{ id: 'staff', label: tAdmin.shortSections.staff, href: '#staff', icon: <Shield /> }]
          : []),
      ],
    },
  ];

  const userInitials = user.fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('') || 'NC';

  const sidebarAccount = {
    id: isSuperOrAdmin ? 'staff' : 'dashboard',
    name: user.fullName,
    detail: user.role.replace(/_/g, ' '),
    initials: userInitials,
    href: isSuperOrAdmin ? '#staff' : '#dashboard',
  };

  const brandIcon = <img src={NETCO_LOGO_URL} alt="NETCO" />;
  const glassMaterial = {
    blur: 14,
    opacity: 0.72,
    saturation: 1.4,
    edge: 0.85,
    distortion: 18,
  };

  return (
    <div className="relative min-h-screen bg-[#F4F7FB] dark:bg-[#080B12] text-slate-900 dark:text-white flex">
      {/* Subtle ambient backdrop behind glass surfaces */}
      <div
        aria-hidden="true"
        className="no-print pointer-events-none fixed inset-0 overflow-hidden z-0"
      >
        <div className="absolute -top-28 -left-24 w-96 h-96 rounded-full bg-[#16B8FF]/14 dark:bg-[#16B8FF]/12 blur-3xl" />
        <div className="absolute bottom-0 left-10 w-80 h-80 rounded-full bg-sky-500/10 dark:bg-blue-600/10 blur-3xl" />
      </div>

      {/* Desktop Liquid Glass Expandable Sidebar */}
      <div className="no-print hidden lg:flex shrink-0 sticky top-3 self-start ml-3 my-3 z-20">
        <LiquidGlassExpandableSidebar
          brand="NETCO"
          brandDetail={tAdmin.brandDetail}
          brandIcon={brandIcon}
          groups={navGroups}
          activeId={section}
          accent="#16B8FF"
          glass={glassMaterial}
          account={sidebarAccount}
          onNavigate={handleSidebarNavigate}
          style={{ '--gn-sidebar-inset': '24px' } as React.CSSProperties}
        />
      </div>

      {/* Mobile Sidebar Overlay */}
      {mobileMenuOpen && (
        <div className="no-print fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <div className="relative z-10 flex flex-col gap-2.5 p-3 max-w-[90vw] h-full">
            <div className="flex items-center justify-end">
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="Close navigation menu"
                className="btn-icon min-h-[38px] min-w-[38px] p-1.5 shadow-md"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 flex">
              <LiquidGlassExpandableSidebar
                brand="NETCO"
                brandDetail={tAdmin.brandDetail}
                brandIcon={brandIcon}
                groups={navGroups}
                activeId={section}
                defaultExpanded={true}
                accent="#16B8FF"
                glass={glassMaterial}
                account={sidebarAccount}
                onNavigate={handleSidebarNavigate}
                style={{ '--gn-sidebar-inset': '132px' } as React.CSSProperties}
              />
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="btn-secondary w-full text-xs shadow-md"
            >
              <LogOut className="w-3.5 h-3.5" />
              {tAdmin.signOut}
            </button>
          </div>
        </div>
      )}

      {/* Main Content Area */}
      <div className="relative z-10 flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="no-print h-14 sm:h-16 px-3 sm:px-6 border-b border-slate-200/80 dark:border-slate-800/90 bg-white/80 dark:bg-[#101827]/85 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-4 sticky top-0 z-10">
          <div className="flex items-center gap-2.5 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation menu"
              className="lg:hidden btn-icon min-h-[38px] min-w-[38px] p-1.5"
            >
              <Menu className="w-5 h-5" />
            </button>
            <div className="text-xs sm:text-sm font-medium truncate">
              <span className="hidden sm:inline text-slate-400 dark:text-[#8793A5]">NETCO</span>
              <span className="hidden sm:inline mx-2 text-slate-300 dark:text-slate-700">/</span>
              <span className="font-semibold text-slate-900 dark:text-white">{tAdmin.sections[section]}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <span className="hidden md:inline-flex items-center px-2 py-1 rounded-md text-[11px] font-mono bg-[#16B8FF]/10 text-[#0284C7] dark:text-[#16B8FF] border border-[#16B8FF]/25">
              {operatingMode === 'STANDALONE_MODE' ? tAdmin.standaloneBadge : tAdmin.mikrotikBadge}
            </span>
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-mono text-slate-500 dark:text-[#8793A5] mr-1">
              <span
                className={`w-2 h-2 rounded-full ${
                  socketConnected ? 'bg-emerald-500' : 'bg-slate-400'
                }`}
              />
              {socketConnected ? tAdmin.live : tAdmin.connecting}
            </span>

            <LanguageSwitcher lang={lang} onToggleLang={toggleLang} />

            <button
              type="button"
              onClick={toggleTheme}
              aria-label="Toggle Light or Dark Mode"
              className="btn-icon min-h-[38px] min-w-[38px] sm:min-h-[40px] sm:min-w-[40px]"
            >
              {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
            </button>

            <button
              type="button"
              onClick={() => {
                if (window.location.hash === '#admin') {
                  window.location.hash = '';
                }
                setSurface('portal');
              }}
              className="btn-primary min-h-[38px] sm:min-h-[40px] px-3 sm:px-4 text-xs"
            >
              <span className="sm:hidden">{tAdmin.voucherStoreShort}</span>
              <span className="hidden sm:inline">{tAdmin.voucherStore}</span>
            </button>

            <button
              type="button"
              onClick={handleLogout}
              aria-label={tAdmin.signOut}
              title={tAdmin.signOut}
              className="btn-secondary min-h-[38px] sm:min-h-[40px] px-2.5 sm:px-3.5 text-xs"
            >
              <LogOut className="w-3.5 h-3.5" />
              <span className="hidden md:inline">{tAdmin.signOut}</span>
            </button>
          </div>
        </header>

        <main className="flex-1 p-3.5 sm:p-6 max-w-[1440px] w-full mx-auto">
          {section === 'dashboard' && (
            <DashboardView token={token} refreshTrigger={refreshTrigger} onNavigate={(s) => setSection(s as AdminSection)} />
          )}
          {section === 'customers' && (
            <CustomersView token={token} canEdit={isCashier} canDelete={isSuperOrAdmin} />
          )}
          {section === 'packages' && <PackagesView token={token} canManage={isSuperOrAdmin} />}
          {section === 'vouchers' && (
            <VouchersView
              token={token}
              refreshTrigger={refreshTrigger}
              canGenerate={isCashier}
              canRevoke={isSuperOrAdmin}
            />
          )}
          {section === 'sessions' && (
            <SessionsView token={token} refreshTrigger={refreshTrigger} canControl={isOperator} />
          )}
          {section === 'payments' && (
            <PaymentsView token={token} refreshTrigger={refreshTrigger} canRefund={isSuperOrAdmin} />
          )}
          {section === 'routers' && (
            <RoutersView
              token={token}
              refreshTrigger={refreshTrigger}
              canManage={isOperator}
              canDelete={isSuperOrAdmin}
            />
          )}
          {section === 'reports' && <ReportsView token={token} />}
          {section === 'notifications' && <NotificationsView token={token} refreshTrigger={refreshTrigger} />}
          {section === 'staff' && <StaffAuditView token={token} currentRole={user.role} />}
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <NetcoWorkspace />
    </ErrorBoundary>
  );
}
