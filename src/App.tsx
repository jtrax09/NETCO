import React, { useEffect, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { signOut } from 'firebase/auth';
import { AnimatePresence, MotionConfig } from 'motion/react';
import {
  Activity,
  BarChart3,
  Bell,
  Briefcase,
  Building2,
  CreditCard,
  Layers,
  LayoutDashboard,
  LogOut,
  MapPin,
  Menu,
  Moon,
  Package,
  Router,
  Settings,
  Shield,
  Sun,
  Ticket,
  Users,
  X,
} from 'lucide-react';
import { ErrorBoundary } from './components/ErrorBoundary.tsx';
import { LanguageSwitcher } from './components/LanguageSwitcher.tsx';
import { TraxMark } from './components/NetcoLogo.tsx';
import { AdminAuthGate, type AuthUser } from './components/AdminAuthGate.tsx';
import { PortalView } from './components/PortalView.tsx';
import { SuperAdminView } from './components/SuperAdminView.tsx';
import { DashboardView } from './components/DashboardView.tsx';
import { CustomersView } from './components/CustomersView.tsx';
import { PackagesView } from './components/PackagesView.tsx';
import { VouchersView } from './components/VouchersView.tsx';
import { SubscriptionsView } from './components/SubscriptionsView.tsx';
import { SessionsView } from './components/SessionsView.tsx';
import { PaymentsView } from './components/PaymentsView.tsx';
import { LocationsView } from './components/LocationsView.tsx';
import { RoutersView } from './components/RoutersView.tsx';
import { ReportsView } from './components/ReportsView.tsx';
import { NotificationsView } from './components/NotificationsView.tsx';
import { StaffAuditView } from './components/StaffAuditView.tsx';
import { BusinessDetailsView } from './components/BusinessDetailsView.tsx';
import { SettingsView } from './components/SettingsView.tsx';
import {
  LiquidGlassExpandableSidebar,
  type GlassNavGroup,
  type GlassNavItem,
} from './components/ui/liquid-glass-expandable-sidebar.tsx';
import { MobileDrawer, MobilePageTransition } from './components/ui/MotionPrimitives.tsx';
import { apiRequest, setActiveTenantId } from './lib/api.ts';
import { auth, syncWorkspacePreference } from './lib/firebase.ts';
import { getInitialLanguage, saveLanguage, TRANSLATIONS, type AppLanguage } from './lib/i18n.ts';

type AdminSection =
  | 'superadmin'
  | 'dashboard'
  | 'customers'
  | 'packages'
  | 'vouchers'
  | 'subscriptions'
  | 'sessions'
  | 'payments'
  | 'locations'
  | 'routers'
  | 'reports'
  | 'notifications'
  | 'staff'
  | 'business'
  | 'settings';

const VALID_SECTIONS = new Set<AdminSection>([
  'superadmin',
  'dashboard',
  'customers',
  'packages',
  'vouchers',
  'subscriptions',
  'sessions',
  'payments',
  'locations',
  'routers',
  'reports',
  'notifications',
  'staff',
  'business',
  'settings',
]);

function TraxLinkWorkspace() {
  const [surface, setSurface] = useState<'admin' | 'portal'>(() =>
    window.location.pathname === '/admin' || window.location.hash === '#admin' ? 'admin' : 'portal'
  );
  const [theme, setTheme] = useState<'dark' | 'light'>('dark');
  const [lang, setLang] = useState<AppLanguage>(() => getInitialLanguage());
  const [token, setToken] = useState<string | null>(null);
  const [authSource, setAuthSource] = useState<'SESSION' | 'FIREBASE' | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);

  const [activeTenantId, setLocalTenantId] = useState<string | null>(null);
  const [activeTenantName, setActiveTenantName] = useState<string | null>(null);

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
    setActiveTenantId(null);
    setLocalTenantId(null);
    setActiveTenantName(authUser.businessName || null);
    setToken(newToken);
    setUser(authUser);
    setAuthSource(source);
    setSection(authUser.role === 'SUPER_ADMIN' ? 'superadmin' : 'dashboard');
  };

  const handleLogout = async () => {
    if (token) {
      await apiRequest('/api/auth/logout', { method: 'POST', token }).catch(() => {});
    }
    if (authSource === 'FIREBASE') {
      await signOut(auth).catch(() => {});
    }
    setActiveTenantId(null);
    setLocalTenantId(null);
    setActiveTenantName(null);
    setToken(null);
    setUser(null);
    setAuthSource(null);
    setMobileMenuOpen(false);
  };

  const handleSelectTenantWorkspace = (businessId: string, businessName: string) => {
    setActiveTenantId(businessId);
    setLocalTenantId(businessId);
    setActiveTenantName(businessName);
    setSection('dashboard');
    setRefreshTrigger((n) => n + 1);
  };

  const handleClearTenantOverride = () => {
    setActiveTenantId(null);
    setLocalTenantId(null);
    setActiveTenantName(user?.businessName || null);
    setRefreshTrigger((n) => n + 1);
  };

  if (surface === 'portal') {
    return (
      <AnimatePresence mode="wait" initial={false}>
        <MobilePageTransition key="surface-portal">
          <PortalView
            theme={theme}
            onToggleTheme={toggleTheme}
            lang={lang}
            onToggleLang={toggleLang}
            onSwitchToAdmin={() => {
              setSurface('admin');
            }}
          />
        </MobilePageTransition>
      </AnimatePresence>
    );
  }

  if (!token || !user) {
    return (
      <AnimatePresence mode="wait" initial={false}>
        <MobilePageTransition key="surface-auth">
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
        </MobilePageTransition>
      </AnimatePresence>
    );
  }

  const isSuperAdmin = user.role === 'SUPER_ADMIN';
  const isBusinessManager = ['SUPER_ADMIN', 'BUSINESS_OWNER', 'ADMIN'].includes(user.role);
  const isFinance = isBusinessManager || user.role === 'ACCOUNTANT';
  const isOperator = isBusinessManager || user.role === 'NETWORK_OPERATOR';
  const isCashier = isBusinessManager || user.role === 'CASHIER' || user.role === 'ACCOUNTANT';
  const isSupport = isBusinessManager || user.role === 'SUPPORT_STAFF';

  const selectSection = (id: AdminSection) => {
    setSection(id);
    setMobileMenuOpen(false);
  };

  const handleSidebarNavigate = (item: GlassNavItem, event: React.MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    if (VALID_SECTIONS.has(item.id as AdminSection)) {
      selectSection(item.id as AdminSection);
    }
  };

  const tAdmin = TRANSLATIONS[lang].admin;

  const navGroups: GlassNavGroup[] = [
    ...(isSuperAdmin
      ? [
          {
            label: tAdmin.groups.platform,
            items: [
              { id: 'superadmin', label: tAdmin.shortSections.superadmin, href: '#superadmin', icon: <Building2 /> },
            ],
          },
        ]
      : []),
    {
      label: tAdmin.groups.operations,
      items: [
        { id: 'dashboard', label: tAdmin.sections.dashboard, href: '#dashboard', icon: <LayoutDashboard /> },
        { id: 'customers', label: tAdmin.sections.customers, href: '#customers', icon: <Users /> },
        { id: 'packages', label: tAdmin.sections.packages, href: '#packages', icon: <Package /> },
        { id: 'vouchers', label: tAdmin.sections.vouchers, href: '#vouchers', icon: <Ticket /> },
        { id: 'subscriptions', label: tAdmin.shortSections.subscriptions, href: '#subscriptions', icon: <Layers /> },
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
        { id: 'locations', label: tAdmin.shortSections.locations, href: '#locations', icon: <MapPin /> },
        { id: 'routers', label: tAdmin.sections.routers, href: '#routers', icon: <Router /> },
        { id: 'reports', label: tAdmin.shortSections.reports, href: '#reports', icon: <BarChart3 /> },
      ],
    },
    {
      label: tAdmin.groups.administration,
      items: [
        { id: 'notifications', label: tAdmin.sections.notifications, href: '#notifications', icon: <Bell /> },
        { id: 'business', label: tAdmin.shortSections.business, href: '#business', icon: <Briefcase /> },
        ...(isBusinessManager
          ? [
              { id: 'staff', label: tAdmin.shortSections.staff, href: '#staff', icon: <Shield /> },
              { id: 'settings', label: tAdmin.shortSections.settings, href: '#settings', icon: <Settings /> },
            ]
          : []),
      ],
    },
  ];

  const userInitials =
    user.fullName
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'TL';

  const sidebarAccount = {
    id: isBusinessManager ? 'staff' : 'dashboard',
    name: user.fullName,
    detail: user.role.replace(/_/g, ' '),
    initials: userInitials,
    href: isBusinessManager ? '#staff' : '#dashboard',
  };

  const brandIcon = <TraxMark className="w-6 h-6" />;
  const glassMaterial = {
    blur: 14,
    opacity: 0.72,
    saturation: 1.4,
    edge: 0.85,
    distortion: 18,
  };

  return (
    <div className="relative min-h-screen bg-stone-100 dark:bg-[#08090C] cinematic-backdrop text-[#101010] dark:text-[#FAFAFA] flex">
      {/* Desktop Liquid Glass Expandable Sidebar */}
      <div className="no-print hidden lg:flex shrink-0 sticky top-3 self-start ml-3 my-3 z-20">
        <LiquidGlassExpandableSidebar
          brand="TRAX LINK"
          brandDetail={activeTenantName || tAdmin.brandDetail}
          brandIcon={brandIcon}
          groups={navGroups}
          activeId={section}
          accent="#FFD400"
          glass={glassMaterial}
          account={sidebarAccount}
          onNavigate={handleSidebarNavigate}
          style={{ '--gn-sidebar-inset': '24px' } as React.CSSProperties}
        />
      </div>

      {/* Mobile Sidebar Overlay */}
      <MobileDrawer
        open={mobileMenuOpen}
        onClose={() => setMobileMenuOpen(false)}
        side="left"
        wrapperClassName="lg:hidden"
        panelClassName="flex flex-col gap-2.5 p-3 max-w-[90vw] h-full"
        ariaLabel="Mobile navigation menu"
      >
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
            brand="TRAX LINK"
            brandDetail={activeTenantName || tAdmin.brandDetail}
            brandIcon={brandIcon}
            groups={navGroups}
            activeId={section}
            defaultExpanded={true}
            accent="#FFD400"
            glass={glassMaterial}
            account={sidebarAccount}
            onNavigate={handleSidebarNavigate}
            style={{ '--gn-sidebar-inset': '132px' } as React.CSSProperties}
          />
        </div>
        <button type="button" onClick={handleLogout} className="btn-secondary w-full text-xs shadow-md">
          <LogOut className="w-3.5 h-3.5" />
          {tAdmin.signOut}
        </button>
      </MobileDrawer>

      {/* Main Content Area */}
      <div className="relative z-10 flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="no-print h-14 sm:h-16 px-3 sm:px-6 border-b border-stone-200 dark:border-zinc-800 bg-white/90 dark:bg-[#161618]/90 backdrop-blur-md flex items-center justify-between gap-2 sm:gap-4 sticky top-0 z-10">
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
              <span className="hidden sm:inline font-futuristic text-[11px] tracking-[0.12em] uppercase text-zinc-400">
                {activeTenantName || user.businessName || 'TRAX LINK'}
              </span>
              <span className="hidden sm:inline mx-2 text-zinc-600">/</span>
              <span className="font-display font-bold tracking-tight text-[#101010] dark:text-white">{tAdmin.sections[section]}</span>
            </div>
            {isSuperAdmin && activeTenantId && (
              <button
                type="button"
                onClick={handleClearTenantOverride}
                className="hidden md:inline-flex btn-chip-warn text-[11px]"
              >
                Exit Tenant Scope
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 sm:gap-2.5 shrink-0">
            <span className="hidden xl:inline-flex items-center px-2 py-1 rounded-md text-[11px] font-mono bg-[#FFD400]/12 text-[#9A7B00] dark:text-[#FFD400] border border-[#FFD400]/30">
              {operatingMode === 'STANDALONE_MODE' ? tAdmin.standaloneBadge : tAdmin.mikrotikBadge}
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

        <main className="flex-1 p-3.5 sm:p-6 max-w-[1440px] w-full mx-auto overflow-x-clip">
          <AnimatePresence mode="wait" initial={false}>
            <MobilePageTransition key={section}>
              {section === 'superadmin' && isSuperAdmin && (
                <SuperAdminView
                  token={token}
                  refreshTrigger={refreshTrigger}
                  activeTenantId={activeTenantId}
                  onSelectTenant={handleSelectTenantWorkspace}
                />
              )}
              {section === 'dashboard' && (
                <DashboardView
                  token={token}
                  refreshTrigger={refreshTrigger}
                  canManageWifi={isOperator}
                  onNavigate={(s) => setSection(s as AdminSection)}
                />
              )}
              {section === 'customers' && (
                <CustomersView token={token} canEdit={isCashier} canDelete={isBusinessManager} />
              )}
              {section === 'packages' && <PackagesView token={token} canManage={isBusinessManager} />}
              {section === 'vouchers' && (
                <VouchersView
                  token={token}
                  refreshTrigger={refreshTrigger}
                  canGenerate={isCashier}
                  canRevoke={isBusinessManager}
                />
              )}
              {section === 'subscriptions' && (
                <SubscriptionsView
                  token={token}
                  refreshTrigger={refreshTrigger}
                  canManage={isOperator || isFinance}
                  canSupport={isSupport}
                />
              )}
              {section === 'sessions' && (
                <SessionsView token={token} refreshTrigger={refreshTrigger} canControl={isOperator} />
              )}
              {section === 'payments' && (
                <PaymentsView token={token} refreshTrigger={refreshTrigger} canRefund={isFinance} />
              )}
              {section === 'locations' && (
                <LocationsView token={token} refreshTrigger={refreshTrigger} canManage={isBusinessManager} />
              )}
              {section === 'routers' && (
                <RoutersView
                  token={token}
                  refreshTrigger={refreshTrigger}
                  canManage={isOperator}
                  canDelete={isBusinessManager}
                />
              )}
              {section === 'reports' && <ReportsView token={token} />}
              {section === 'notifications' && (
                <NotificationsView token={token} refreshTrigger={refreshTrigger} />
              )}
              {section === 'staff' && <StaffAuditView token={token} currentRole={user.role} />}
              {section === 'business' && (
                <BusinessDetailsView
                  token={token}
                  canManage={isBusinessManager}
                  refreshTrigger={refreshTrigger}
                  onNavigate={(s) => setSection(s as AdminSection)}
                  onSaved={() => setRefreshTrigger((n) => n + 1)}
                />
              )}
              {section === 'settings' && isBusinessManager && (
                <SettingsView
                  token={token}
                  userRole={user.role}
                  refreshTrigger={refreshTrigger}
                  onSaved={() => setRefreshTrigger((n) => n + 1)}
                />
              )}
            </MobilePageTransition>
          </AnimatePresence>
        </main>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <MotionConfig reducedMotion="user">
      <ErrorBoundary>
        <TraxLinkWorkspace />
      </ErrorBoundary>
    </MotionConfig>
  );
}
