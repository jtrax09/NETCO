import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  BellRing,
  Check,
  CheckCircle2,
  CheckSquare,
  Clock,
  Copy,
  Gauge,
  KeyRound,
  Pause,
  Plus,
  Radar,
  Radio,
  RefreshCw,
  Router as RouterIcon,
  ShieldAlert,
  Square,
  Terminal,
  Trash2,
  Wifi,
  X,
} from 'lucide-react';
import { apiRequest, formatBytes } from '../lib/api.ts';
import {
  type BulkCommandType,
  evaluatePingLatency,
  evaluateRouterHealth,
  findNewlyDetectedRouters,
  ROUTER_AUTO_SCAN_INTERVAL_MS,
  ROUTER_CPU_WARN_PCT,
  ROUTER_MEM_WARN_PCT,
  ROUTER_RTT_ALERT_MS,
  toggleRouterIdSelection,
} from '../lib/routerHealth.ts';
import { RouterAnalyticsView } from './RouterAnalyticsView.tsx';
import { WifiConnectCard } from './WifiConnectCard.tsx';
import { MobileModal, NATIVE_SPRING } from './ui/MotionPrimitives.tsx';

interface RouterItem {
  id: string;
  locationId?: string | null;
  locationName?: string | null;
  name: string;
  host: string;
  apiPort: number;
  useTls: number;
  username: string;
  hotspotServer: string;
  routerOsFamily?: 'ROUTEROS_V6' | 'ROUTEROS_V7';
  status: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  cpuLoad: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  uptime: string | null;
  routerOsVersion: string | null;
  boardName: string | null;
  lastError: string | null;
  lastCheckedAt: string | null;
}

interface LocationOption {
  id: string;
  name: string;
  region: string;
}

interface RouterInterface {
  id: string;
  name: string;
  type: string;
  running: number;
  disabled: number;
  rxBytes: number;
  txBytes: number;
}

interface SystemModeInfo {
  operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
  routerCount: number;
  connectedRouterCount: number;
  routerStatusMessage: string;
  airtelPocketWifiNotice: string;
}

interface RouterBandwidthPoint {
  sampledAt: string;
  label: string;
  rxBytes: number;
  txBytes: number;
  totalBytes: number;
  rxMb: number;
  txMb: number;
  totalMb: number;
}

interface RouterBandwidthRow {
  routerId: string;
  name: string;
  status: 'CONNECTED' | 'NOT_CONNECTED' | 'ERROR';
  rxBytes: number;
  txBytes: number;
  totalBytes: number;
  interfaceCount: number;
  activeInterfaces: number;
}

interface RouterBandwidthOverview {
  summary: {
    totalRouters: number;
    connectedRouters: number;
    offlineRouters: number;
    totalRxBytes: number;
    totalTxBytes: number;
    totalBandwidthBytes: number;
    totalInterfaces: number;
    activeInterfaces: number;
  };
  perRouterBandwidth: RouterBandwidthRow[];
  bandwidthSeries: RouterBandwidthPoint[];
}

interface RouterPingResult {
  routerId: string;
  routerName: string;
  host: string;
  port: number;
  reachable: boolean;
  roundTripMs: number | null;
  method: string;
  checkedAt: string;
  error: string | null;
}

interface DiscoveredRouter {
  host: string;
  apiPort: number;
  useTls: boolean;
  suggestedName: string;
  identity: string | null;
  boardName: string | null;
  routerOsVersion: string | null;
  macAddress: string | null;
  interfaceName: string | null;
  routerOsFamily: 'ROUTEROS_V6' | 'ROUTEROS_V7';
  discoveryMethods: string[];
  apiVerified: boolean;
  roundTripMs: number | null;
  alreadyAdded: boolean;
}

interface NetworkScanResult {
  ipRange: string;
  scannedHosts: number;
  durationMs: number;
  discovered: DiscoveredRouter[];
}

interface BulkCommandRouterResult {
  routerId: string;
  routerName: string;
  host: string;
  apiPort: number;
  commandType: BulkCommandType;
  success: boolean;
  summary: string | null;
  error: string | null;
}

interface BulkCommandResponse {
  commandType: BulkCommandType;
  totalRequested: number;
  succeededCount: number;
  failedCount: number;
  executedAt: string;
  results: BulkCommandRouterResult[];
}

interface Props {
  token: string;
  refreshTrigger: number;
  canManage: boolean;
  canDelete: boolean;
}

export function RoutersView({ token, refreshTrigger, canManage, canDelete }: Props) {
  const [routers, setRouters] = useState<RouterItem[]>([]);
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [modeInfo, setModeInfo] = useState<SystemModeInfo | null>(null);
  const [overview, setOverview] = useState<RouterBandwidthOverview | null>(null);
  const [livePolling, setLivePolling] = useState(true);
  const [pollingOverview, setPollingOverview] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [pingingId, setPingingId] = useState<string | null>(null);
  const [pingToast, setPingToast] = useState<RouterPingResult | null>(null);
  const [pingResultsByRouter, setPingResultsByRouter] = useState<Record<string, RouterPingResult>>({});
  const [analyticsRouterId, setAnalyticsRouterId] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [autoSyncProfiles, setAutoSyncProfiles] = useState(false);
  const [savingRouterSettings, setSavingRouterSettings] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  const [scanRange, setScanRange] = useState('192.168.88.0/24');
  const [scanPort, setScanPort] = useState('8728');
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<NetworkScanResult | null>(null);
  const [autoScanEnabled, setAutoScanEnabled] = useState(true);
  const [lastAutoScanAt, setLastAutoScanAt] = useState<string | null>(null);
  const [nextAutoScanAt, setNextAutoScanAt] = useState<number | null>(null);
  const [dismissedDetectedHosts, setDismissedDetectedHosts] = useState<string[]>([]);

  const scannerSectionRef = useRef<HTMLElement | null>(null);
  const scanRangeRef = useRef(scanRange);
  const scanPortRef = useRef(scanPort);
  const scanningRef = useRef(scanning);
  scanRangeRef.current = scanRange;
  scanPortRef.current = scanPort;
  scanningRef.current = scanning;

  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<RouterItem | null>(null);
  const [name, setName] = useState('');
  const [host, setHost] = useState('');
  const [apiPort, setApiPort] = useState('8728');
  const [useTls, setUseTls] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hotspotServer, setHotspotServer] = useState('');
  const [locationId, setLocationId] = useState('');
  const [routerOsFamily, setRouterOsFamily] = useState<'ROUTEROS_V6' | 'ROUTEROS_V7'>('ROUTEROS_V7');
  const [saving, setSaving] = useState(false);

  const [selectedIfaces, setSelectedIfaces] = useState<{
    routerName: string;
    interfaces: RouterInterface[];
  } | null>(null);

  const [snippetModal, setSnippetModal] = useState<{
    routerName: string;
    routerOsFamily: string;
    snippet: string;
  } | null>(null);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const [selectedRouterIds, setSelectedRouterIds] = useState<string[]>([]);
  const [bulkModalOpen, setBulkModalOpen] = useState(false);
  const [bulkCommandType, setBulkCommandType] = useState<BulkCommandType>('UPDATE_SSID');
  const [bulkSsid, setBulkSsid] = useState('TRAX-LINK-WIFI');
  const [bulkWifiIface, setBulkWifiIface] = useState('');
  const [bulkNtpPrimary, setBulkNtpPrimary] = useState('pool.ntp.org');
  const [bulkNtpSecondary, setBulkNtpSecondary] = useState('time.cloudflare.com');
  const [bulkNtpEnabled, setBulkNtpEnabled] = useState(true);
  const [bulkDnsServers, setBulkDnsServers] = useState('1.1.1.1,8.8.8.8');
  const [bulkDnsRemote, setBulkDnsRemote] = useState(true);
  const [bulkTimezone, setBulkTimezone] = useState('Africa/Dar_es_Salaam');
  const [bulkSubmitting, setBulkSubmitting] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [bulkResult, setBulkResult] = useState<BulkCommandResponse | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [res, mRes, locRes, ovRes, rSetRes] = await Promise.all([
        apiRequest<{ routers: RouterItem[] }>('/api/routers', { token }),
        apiRequest<SystemModeInfo>('/api/system/mode'),
        apiRequest<{ locations: LocationOption[] }>('/api/locations', { token }).catch(() => ({ locations: [] })),
        apiRequest<RouterBandwidthOverview>('/api/routers/overview', { token }).catch(() => null),
        apiRequest<{ businessId: string; autoSyncProfiles: boolean }>('/api/routers/settings', { token }).catch(() => ({
          businessId: '',
          autoSyncProfiles: false,
        })),
      ]);
      setRouters(res.routers);
      setSelectedRouterIds((prev) =>
        prev.filter((id) => res.routers.some((router) => router.id === id))
      );
      setModeInfo(mRes);
      setLocations(locRes.locations);
      if (ovRes) setOverview(ovRes);
      setAutoSyncProfiles(Boolean(rSetRes.autoSyncProfiles));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load routers');
    } finally {
      setLoading(false);
    }
  };

  const pollOverview = async (liveSync = false) => {
    setPollingOverview(true);
    try {
      const suffix = liveSync && canManage ? '?poll=1&liveSync=1' : '?poll=1';
      const ovRes = await apiRequest<RouterBandwidthOverview>(`/api/routers/overview${suffix}`, { token });
      setOverview(ovRes);
      if (liveSync) {
        const res = await apiRequest<{ routers: RouterItem[] }>('/api/routers', { token });
        setRouters(res.routers);
      }
    } catch {
      // Keep existing overview snapshot visible on transient poll error
    } finally {
      setPollingOverview(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

  const connectedCount = useMemo(
    () => routers.filter((r) => r.status === 'CONNECTED').length,
    [routers]
  );

  useEffect(() => {
    if (!livePolling || connectedCount === 0) return;
    const timer = window.setInterval(() => {
      void pollOverview(canManage);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [livePolling, connectedCount, token, canManage]);

  useEffect(() => {
    if (!pingToast) return;
    const timer = window.setTimeout(() => setPingToast(null), 6000);
    return () => window.clearTimeout(timer);
  }, [pingToast]);

  const healthCounts = useMemo(() => {
    let healthy = 0;
    let warning = 0;
    let critical = 0;
    for (const r of routers) {
      const h = evaluateRouterHealth(r);
      if (h.level === 'HEALTHY') healthy += 1;
      else if (h.level === 'WARNING') warning += 1;
      else if (h.level === 'CRITICAL') critical += 1;
    }
    return { healthy, warning, critical };
  }, [routers]);

  const handleToggleOperatingMode = async (nextMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE') => {
    setSwitchingMode(true);
    setError(null);
    setSyncMsg(null);
    try {
      await apiRequest('/api/system/mode', {
        method: 'PATCH',
        token,
        body: { operatingMode: nextMode },
      });
      await load();
      setSyncMsg(
        nextMode === 'STANDALONE_MODE'
          ? 'Operating mode set to Standalone Mode (no MikroTik router required).'
          : 'Operating mode set to MikroTik Mode (RouterOS API integration enabled when hardware is connected).'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update operating mode');
    } finally {
      setSwitchingMode(false);
    }
  };

  const handleToggleAutoSyncProfiles = async () => {
    if (!canManage || savingRouterSettings) return;
    const nextValue = !autoSyncProfiles;
    setSavingRouterSettings(true);
    setError(null);
    setSyncMsg(null);
    try {
      const updated = await apiRequest<{ businessId: string; autoSyncProfiles: boolean }>('/api/routers/settings', {
        method: 'PATCH',
        token,
        body: { autoSyncProfiles: nextValue },
      });
      setAutoSyncProfiles(Boolean(updated.autoSyncProfiles));
      setSyncMsg(
        updated.autoSyncProfiles
          ? 'Auto-sync enabled: creating or updating a WiFi package will automatically push hotspot profiles to configured MikroTik routers.'
          : 'Auto-sync disabled: hotspot profiles will only sync manually from each router card.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update router settings');
    } finally {
      setSavingRouterSettings(false);
    }
  };

  const openCreate = () => {
    setEditing(null);
    setName('');
    setHost('');
    setApiPort('8728');
    setUseTls(false);
    setUsername('');
    setPassword('');
    setHotspotServer('');
    setLocationId(locations[0]?.id || '');
    setRouterOsFamily('ROUTEROS_V7');
    setError(null);
    setModalOpen(true);
  };

  const openCreateFromScan = (item: DiscoveredRouter) => {
    setEditing(null);
    setName(item.suggestedName);
    setHost(item.host);
    setApiPort(String(item.apiPort || 8728));
    setUseTls(Boolean(item.useTls));
    setUsername('');
    setPassword('');
    setHotspotServer('');
    setLocationId(locations[0]?.id || '');
    setRouterOsFamily(item.routerOsFamily || 'ROUTEROS_V7');
    setError(null);
    setModalOpen(true);
  };

  const executeNetworkScan = useCallback(
    async (mode: 'manual' | 'auto') => {
      if (scanningRef.current) return;
      const trimmedRange = scanRangeRef.current.trim();
      if (!trimmedRange) {
        if (mode === 'manual') {
          setScanError('Enter an IPv4 range or CIDR subnet to scan.');
        }
        return;
      }

      scanningRef.current = true;
      setScanning(true);
      if (mode === 'manual') {
        setScanError(null);
      }

      try {
        const parsedPort = Number(scanPortRef.current) || 8728;
        const res = await apiRequest<NetworkScanResult>('/api/routers/scan', {
          method: 'POST',
          token,
          body: {
            ipRange: trimmedRange,
            apiPort: parsedPort,
            includeMndp: true,
          },
        });
        setScanResult(res);
        setLastAutoScanAt(new Date().toISOString());
        if (mode === 'manual') {
          setDismissedDetectedHosts([]);
        }
      } catch (err) {
        if (mode === 'manual') {
          setScanError(err instanceof Error ? err.message : 'Network scan failed');
        }
      } finally {
        scanningRef.current = false;
        setScanning(false);
      }
    },
    [token]
  );

  useEffect(() => {
    if (!canManage || !autoScanEnabled) {
      setNextAutoScanAt(null);
      return;
    }

    setNextAutoScanAt(Date.now() + ROUTER_AUTO_SCAN_INTERVAL_MS);
    const timer = window.setInterval(() => {
      setNextAutoScanAt(Date.now() + ROUTER_AUTO_SCAN_INTERVAL_MS);
      void executeNetworkScan('auto');
    }, ROUTER_AUTO_SCAN_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [canManage, autoScanEnabled, executeNetworkScan]);

  const newlyDetectedRouters = useMemo(() => {
    if (!scanResult) return [];
    return findNewlyDetectedRouters(
      scanResult.discovered,
      routers,
      new Set(dismissedDetectedHosts)
    );
  }, [scanResult, routers, dismissedDetectedHosts]);

  const handleDismissDetected = () => {
    const hosts = newlyDetectedRouters.map((r) => r.host.trim().toLowerCase()).filter(Boolean);
    if (hosts.length === 0) return;
    setDismissedDetectedHosts((prev) => Array.from(new Set([...prev, ...hosts])));
  };

  const handleScanNetwork = async (e: React.FormEvent) => {
    e.preventDefault();
    await executeNetworkScan('manual');
  };

  const openEdit = (r: RouterItem) => {
    setEditing(r);
    setName(r.name);
    setHost(r.host);
    setApiPort(String(r.apiPort || 8728));
    setUseTls(Boolean(r.useTls));
    setUsername(r.username);
    setPassword('');
    setHotspotServer(r.hotspotServer);
    setLocationId(r.locationId || '');
    setRouterOsFamily(r.routerOsFamily || 'ROUTEROS_V7');
    setError(null);
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const trimmedHost = host.trim();
    if (trimmedHost === '8.8.8.8') {
      setError('8.8.8.8 is a public DNS IP and cannot be used as a MikroTik router address.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const parsedPort = Number(apiPort) || 8728;
      if (editing) {
        await apiRequest(`/api/routers/${editing.id}`, {
          method: 'PATCH',
          token,
          body: {
            name: name.trim(),
            host: trimmedHost,
            apiPort: parsedPort,
            useTls,
            username: username.trim(),
            ...(password.trim() ? { password: password.trim() } : {}),
            hotspotServer: hotspotServer.trim(),
            locationId: locationId || null,
            routerOsFamily,
          },
        });
      } else {
        await apiRequest('/api/routers', {
          method: 'POST',
          token,
          body: {
            name: name.trim(),
            host: trimmedHost,
            apiPort: parsedPort,
            useTls,
            username: username.trim(),
            password: password.trim(),
            hotspotServer: hotspotServer.trim(),
            locationId: locationId || null,
            routerOsFamily,
          },
        });
      }
      setModalOpen(false);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save router');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async (id: string) => {
    setTestingId(id);
    setSyncMsg(null);
    setError(null);
    try {
      const res = await apiRequest<{
        router: RouterItem;
        telemetry: { connected: boolean; error?: string; activeHotspotCount: number };
      }>(`/api/routers/${id}/test`, { method: 'POST', token });

      setSyncMsg(
        res.telemetry.connected
          ? `Connected to ${res.router.name} · ${res.telemetry.activeHotspotCount} active hotspot session(s)`
          : `${res.router.name}: No MikroTik router connected (${res.telemetry.error || 'Unreachable'})`
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
    } finally {
      setTestingId(null);
    }
  };

  const handlePing = async (router: RouterItem) => {
    setPingingId(router.id);
    try {
      const res = await apiRequest<{ ping: RouterPingResult }>(`/api/routers/${router.id}/ping`, {
        method: 'POST',
        token,
      });
      setPingToast(res.ping);
      setPingResultsByRouter((prev) => ({ ...prev, [router.id]: res.ping }));
    } catch (err) {
      const failed: RouterPingResult = {
        routerId: router.id,
        routerName: router.name,
        host: router.host,
        port: router.apiPort || 8728,
        reachable: false,
        roundTripMs: null,
        method: router.useTls ? 'TCP_TLS' : 'TCP',
        checkedAt: new Date().toISOString(),
        error: err instanceof Error ? err.message : 'Ping diagnostic failed',
      };
      setPingToast(failed);
      setPingResultsByRouter((prev) => ({ ...prev, [router.id]: failed }));
    } finally {
      setPingingId(null);
    }
  };

  const handleSyncProfiles = async (id: string) => {
    setSyncMsg(null);
    try {
      const res = await apiRequest<{ results: Array<{ packageName: string; synced: boolean; message: string }> }>(
        `/api/routers/${id}/sync-profiles`,
        { method: 'POST', token }
      );
      const okCount = res.results.filter((r) => r.synced).length;
      setSyncMsg(`Profile sync: ${okCount}/${res.results.length} synced to RouterOS.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Profile sync failed');
    }
  };

  const handleViewInterfaces = async (r: RouterItem) => {
    try {
      const res = await apiRequest<{ interfaces: RouterInterface[] }>(`/api/routers/${r.id}/interfaces`, {
        token,
      });
      setSelectedIfaces({ routerName: r.name, interfaces: res.interfaces });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load interfaces');
    }
  };

  const handleViewSnippet = async (r: RouterItem) => {
    try {
      setCopiedSnippet(false);
      const res = await apiRequest<{ snippet: string; routerOsFamily: string }>(
        `/api/routers/${r.id}/wireguard-snippet`,
        { token }
      );
      setSnippetModal({
        routerName: r.name,
        routerOsFamily: res.routerOsFamily,
        snippet: res.snippet,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to generate WireGuard + RADIUS script');
    }
  };

  const selectedRouters = useMemo(
    () => routers.filter((r) => selectedRouterIds.includes(r.id)),
    [routers, selectedRouterIds]
  );

  const toggleSelectRouter = (id: string) => {
    setSelectedRouterIds((prev) => toggleRouterIdSelection(prev, id));
  };

  const selectAllRouters = () => {
    setSelectedRouterIds(routers.map((r) => r.id));
  };

  const clearSelectedRouters = () => {
    setSelectedRouterIds([]);
  };

  const openBulkCommandModal = () => {
    setBulkError(null);
    setBulkResult(null);
    setBulkModalOpen(true);
  };

  const handleRunBulkCommand = async (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedRouterIds.length === 0) {
      setBulkError('Select at least one router to execute a bulk command.');
      return;
    }

    setBulkSubmitting(true);
    setBulkError(null);
    setBulkResult(null);
    try {
      let params: Record<string, unknown> = {};
      if (bulkCommandType === 'UPDATE_SSID') {
        params = {
          ssid: bulkSsid.trim(),
          interfaceName: bulkWifiIface.trim(),
        };
      } else if (bulkCommandType === 'UPDATE_NTP') {
        params = {
          primaryServer: bulkNtpPrimary.trim(),
          secondaryServer: bulkNtpSecondary.trim(),
          enabled: bulkNtpEnabled,
        };
      } else if (bulkCommandType === 'SET_DNS_SERVERS') {
        params = {
          servers: bulkDnsServers.trim(),
          allowRemoteRequests: bulkDnsRemote,
        };
      } else {
        params = {
          timezone: bulkTimezone.trim(),
        };
      }

      const res = await apiRequest<BulkCommandResponse>('/api/routers/bulk-command', {
        method: 'POST',
        token,
        body: {
          routerIds: selectedRouterIds,
          commandType: bulkCommandType,
          params,
        },
      });
      setBulkResult(res);
      setSyncMsg(
        `Bulk command ${res.commandType} pushed to ${res.totalRequested} router(s): ${res.succeededCount} succeeded, ${res.failedCount} failed.`
      );
    } catch (err) {
      setBulkError(err instanceof Error ? err.message : 'Bulk command execution failed');
    } finally {
      setBulkSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/api/routers/${id}`, { method: 'DELETE', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove router');
    }
  };

  const operatingMode = modeInfo?.operatingMode || 'STANDALONE_MODE';

  if (analyticsRouterId) {
    return (
      <RouterAnalyticsView
        token={token}
        routers={routers}
        initialRouterId={analyticsRouterId}
        canManage={canManage}
        onBack={() => setAnalyticsRouterId(null)}
        onTelemetryRefreshed={() => void load()}
      />
    );
  }

  return (
    <div className="space-y-6">
      {/* Operating Mode & Status Header */}
      <div className="p-4 sm:p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`px-2.5 py-1 rounded-md text-xs font-mono font-semibold ${
                operatingMode === 'STANDALONE_MODE'
                  ? 'bg-[#FFD400]/15 text-[#9A7B00] dark:text-[#FFD400] border border-[#FFD400]/30'
                  : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30'
              }`}
            >
              {operatingMode === 'STANDALONE_MODE' ? 'Standalone Mode' : 'MikroTik Mode'}
            </span>
            <span className="text-xs font-mono text-amber-600 dark:text-amber-400 font-semibold">
              {modeInfo?.routerStatusMessage || 'No MikroTik router connected'}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-[#8793A5]">
            {modeInfo?.airtelPocketWifiNotice ||
              'TRAX LINK operates fully in Standalone Mode without MikroTik hardware. RouterOS credentials are optional and stored encrypted.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {canManage && newlyDetectedRouters.length > 0 && (
            <button
              type="button"
              onClick={() => scannerSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
              className="inline-flex items-center gap-2 px-3 py-1.5 rounded-lg bg-[#FFD400]/15 text-[#9A7B00] dark:text-[#FFD400] border border-[#FFD400]/45 text-xs font-semibold hover:bg-[#FFD400]/25 transition-colors whitespace-nowrap shrink-0"
              aria-label={`New Router Detected (${newlyDetectedRouters.length})`}
            >
              <BellRing className="w-3.5 h-3.5 shrink-0" />
              <span>New Router Detected</span>
              <span className="font-mono tabular-nums font-bold">({newlyDetectedRouters.length})</span>
            </button>
          )}
          {canManage && (
            <div className="btn-tab-group">
              <button
                type="button"
                disabled={switchingMode}
                onClick={() => handleToggleOperatingMode('STANDALONE_MODE')}
                className={operatingMode === 'STANDALONE_MODE' ? 'btn-tab-active' : 'btn-tab'}
              >
                Standalone Mode
              </button>
              <button
                type="button"
                disabled={switchingMode}
                onClick={() => handleToggleOperatingMode('MIKROTIK_MODE')}
                className={operatingMode === 'MIKROTIK_MODE' ? 'btn-tab-active' : 'btn-tab'}
              >
                MikroTik Mode
              </button>
            </div>
          )}
          {canManage && (
            <button
              type="button"
              onClick={openCreate}
              className="btn-primary text-xs"
            >
              <Plus className="w-4 h-4" />
              Connect Router
            </button>
          )}
        </div>
      </div>

      {/* Router Settings: Auto-Sync Hotspot Profiles */}
      <section
        aria-label="Router Settings"
        className="p-4 sm:p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-4"
      >
        <div className="space-y-1 max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">Router Settings</h2>
            <span
              className={`font-mono text-[11px] font-semibold ${
                autoSyncProfiles
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-slate-500 dark:text-[#8793A5]'
              }`}
            >
              {autoSyncProfiles ? 'Auto-Sync ON' : 'Auto-Sync OFF'}
            </span>
          </div>
          <p className="text-xs text-slate-500 dark:text-[#8793A5]">
            Automatically synchronize MikroTik hotspot speed profiles whenever a WiFi package is created or updated.
          </p>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            role="switch"
            aria-checked={autoSyncProfiles}
            aria-label="Automatically sync hotspot profiles to MikroTik hardware on package create or update"
            disabled={!canManage || savingRouterSettings}
            onClick={handleToggleAutoSyncProfiles}
            className={`relative inline-flex h-7 w-12 shrink-0 items-center rounded-full border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#FFD400] ${
              autoSyncProfiles
                ? 'bg-[#FFD400] border-[#D9B400]'
                : 'bg-stone-200 dark:bg-zinc-800 border-stone-300 dark:border-white/15'
            } ${!canManage || savingRouterSettings ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}`}
          >
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white dark:bg-[#101010] shadow-sm transition-transform ${
                autoSyncProfiles ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
          <span className="text-xs font-semibold text-slate-700 dark:text-zinc-200 min-w-[68px]">
            {savingRouterSettings ? 'Saving...' : autoSyncProfiles ? 'Enabled' : 'Disabled'}
          </span>
        </div>
      </section>

      <WifiConnectCard
        token={token}
        canManage={canManage}
        refreshTrigger={refreshTrigger}
        compact={true}
        onConnected={() => void load()}
      />

      {syncMsg && (
        <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-[#101827] text-xs font-mono">
          {syncMsg}
        </div>
      )}

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Router Overview Dashboard */}
      <section
        aria-label="Router Overview"
        className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-5"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-bold">Router Overview</h2>
            <p className="text-xs text-slate-500 dark:text-[#8793A5]">
              Aggregate live interface bandwidth and operational health across all connected routers.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <button
              type="button"
              onClick={() => setLivePolling((p) => !p)}
              className="btn-secondary min-h-[36px] px-3 py-1.5 text-xs"
              aria-pressed={livePolling}
            >
              {livePolling ? <Radio className="w-3.5 h-3.5 text-emerald-500" /> : <Pause className="w-3.5 h-3.5" />}
              {livePolling ? 'Live Auto-Poll' : 'Polling Paused'}
            </button>
            <button
              type="button"
              disabled={pollingOverview}
              onClick={() => pollOverview(true)}
              className="btn-secondary min-h-[36px] px-3 py-1.5 text-xs"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${pollingOverview ? 'animate-spin' : ''}`} />
              {pollingOverview ? 'Sampling...' : 'Refresh Bandwidth'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 text-xs tabular-nums">
          <div className="p-4 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10">
            <span className="text-slate-500 dark:text-[#8793A5] block">Connected Routers</span>
            <span className="text-xl font-bold font-mono mt-1 block">
              {overview?.summary.connectedRouters ?? connectedCount} / {overview?.summary.totalRouters ?? routers.length}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-[#8793A5] mt-1 block">
              {healthCounts.healthy} healthy · {healthCounts.warning + healthCounts.critical} warnings
            </span>
          </div>

          <div className="p-4 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10">
            <span className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
              <ArrowDownToLine className="w-3.5 h-3.5 text-emerald-500" />
              Total Download (RX)
            </span>
            <span className="text-xl font-bold font-mono mt-1 block text-emerald-600 dark:text-emerald-400">
              {formatBytes(overview?.summary.totalRxBytes ?? 0)}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-[#8793A5] mt-1 block">
              Across connected router interfaces
            </span>
          </div>

          <div className="p-4 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10">
            <span className="text-slate-500 dark:text-[#8793A5] flex items-center gap-1.5">
              <ArrowUpFromLine className="w-3.5 h-3.5 text-sky-500" />
              Total Upload (TX)
            </span>
            <span className="text-xl font-bold font-mono mt-1 block text-sky-600 dark:text-sky-400">
              {formatBytes(overview?.summary.totalTxBytes ?? 0)}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-[#8793A5] mt-1 block">
              Across connected router interfaces
            </span>
          </div>

          <div className="p-4 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10">
            <span className="text-slate-500 dark:text-[#8793A5] block">Combined Bandwidth</span>
            <span className="text-xl font-bold font-mono mt-1 block text-[#9A7B00] dark:text-[#FFD400]">
              {formatBytes(overview?.summary.totalBandwidthBytes ?? 0)}
            </span>
            <span className="text-[11px] text-slate-500 dark:text-[#8793A5] mt-1 block">
              {overview?.summary.activeInterfaces ?? 0} / {overview?.summary.totalInterfaces ?? 0} active interfaces
            </span>
          </div>
        </div>

        <div className="space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-slate-900 dark:text-white">
              Live Connected Router Bandwidth Usage (MB)
            </span>
            <span className="font-mono text-[11px] text-slate-500 dark:text-[#8793A5]">
              {overview?.bandwidthSeries.length
                ? `${overview.bandwidthSeries.length} telemetry samples`
                : 'Awaiting connected router telemetry'}
            </span>
          </div>

          {!overview || overview.bandwidthSeries.length === 0 ? (
            <div className="h-56 rounded-lg border border-dashed border-stone-200 dark:border-white/10 flex flex-col items-center justify-center text-center px-4 text-xs text-slate-500 dark:text-[#8793A5] gap-1.5">
              <Activity className="w-5 h-5 opacity-60" />
              <p className="font-medium text-slate-700 dark:text-zinc-300">
                No connected router bandwidth samples recorded yet
              </p>
              <p className="max-w-md text-[11px]">
                Run a connection test on a reachable MikroTik router to stream live RX, TX, and total interface bandwidth telemetry onto this chart.
              </p>
            </div>
          ) : (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={overview.bandwidthSeries} margin={{ top: 8, right: 16, left: 0, bottom: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#27272A" opacity={0.35} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#9CA3AF' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#9CA3AF' }} unit=" MB" />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: '#161618',
                      borderColor: '#27272A',
                      color: '#ffffff',
                      fontSize: '12px',
                      borderRadius: '8px',
                    }}
                    formatter={(value: unknown, name: unknown) => [
                      `${Number(value ?? 0).toLocaleString()} MB`,
                      String(name ?? ''),
                    ]}
                  />
                  <Legend wrapperStyle={{ fontSize: '11px' }} />
                  <Line
                    type="monotone"
                    dataKey="totalMb"
                    name="Total (MB)"
                    stroke="#FFD400"
                    strokeWidth={2.2}
                    dot={{ r: 2.5 }}
                    activeDot={{ r: 4.5 }}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="rxMb"
                    name="Download RX (MB)"
                    stroke="#10B981"
                    strokeWidth={1.8}
                    dot={false}
                    isAnimationActive={false}
                  />
                  <Line
                    type="monotone"
                    dataKey="txMb"
                    name="Upload TX (MB)"
                    stroke="#0EA5E9"
                    strokeWidth={1.8}
                    dot={false}
                    isAnimationActive={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </section>

      {canManage && (
        <section
          ref={scannerSectionRef}
          id="network-router-scanner"
          aria-label="Network Scanner"
          className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <h2 className="text-base font-bold flex items-center gap-2">
                <Radar className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
                Network Router Scanner
              </h2>
              <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                Discover active MikroTik routers across a local subnet or WireGuard tunnel via RouterOS API (8728/8729) and MNDP (UDP 5678).
              </p>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500 dark:text-[#8793A5] font-mono tabular-nums">
                <span className="inline-flex items-center gap-1">
                  <Clock className="w-3 h-3 shrink-0" />
                  {autoScanEnabled ? 'Auto-scan every 5 min' : 'Periodic auto-scan paused'}
                </span>
                {lastAutoScanAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Last scan {new Date(lastAutoScanAt).toLocaleTimeString()}</span>
                  </>
                )}
                {autoScanEnabled && nextAutoScanAt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span>Next scan {new Date(nextAutoScanAt).toLocaleTimeString()}</span>
                  </>
                )}
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
              <button
                type="button"
                onClick={() => setAutoScanEnabled((prev) => !prev)}
                aria-pressed={autoScanEnabled}
                className="btn-secondary min-h-[32px] px-2.5 py-1 text-[11px] font-sans font-semibold whitespace-nowrap shrink-0"
              >
                {autoScanEnabled ? (
                  <Radio className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <Pause className="w-3.5 h-3.5" />
                )}
                {autoScanEnabled ? 'Auto-Scan (5m)' : 'Auto-Scan Paused'}
              </button>
              {['192.168.88.0/24', '10.66.0.0/28', '192.168.1.0/24'].map((preset) => (
                <button
                  key={preset}
                  type="button"
                  onClick={() => setScanRange(preset)}
                  className="btn-chip-neutral"
                >
                  {preset}
                </button>
              ))}
            </div>
          </div>

          {newlyDetectedRouters.length > 0 && (
            <div
              role="status"
              className="p-3.5 rounded-lg border border-[#FFD400]/45 bg-[#FFD400]/10 flex flex-wrap items-center justify-between gap-3 text-xs"
            >
              <div className="flex items-start gap-2.5 min-w-0">
                <BellRing className="w-4 h-4 shrink-0 mt-0.5 text-[#9A7B00] dark:text-[#FFD400]" />
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900 dark:text-white">
                    New Router Detected ({newlyDetectedRouters.length})
                  </p>
                  <p className="text-[11px] text-slate-600 dark:text-zinc-300 mt-0.5 font-mono truncate">
                    {newlyDetectedRouters
                      .map((item) => `${item.suggestedName} (${item.host}:${item.apiPort})`)
                      .join(' · ')}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => openCreateFromScan(newlyDetectedRouters[0])}
                  className="btn-primary min-h-[32px] px-3 py-1 text-xs"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add {newlyDetectedRouters.length === 1 ? 'Router' : 'First Router'}
                </button>
                <button
                  type="button"
                  onClick={handleDismissDetected}
                  className="btn-secondary min-h-[32px] px-2.5 py-1 text-xs"
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleScanNetwork} className="grid grid-cols-1 sm:grid-cols-12 gap-3 items-end text-xs">
            <div className="sm:col-span-7">
              <label htmlFor="scanner-ip-range" className="block font-medium mb-1">
                IPv4 Range or CIDR (Max /24)
              </label>
              <input
                id="scanner-ip-range"
                type="text"
                required
                value={scanRange}
                onChange={(e) => setScanRange(e.target.value)}
                placeholder="192.168.88.0/24 or 192.168.88.1-192.168.88.50"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              />
            </div>
            <div className="sm:col-span-2">
              <label htmlFor="scanner-api-port" className="block font-medium mb-1">
                API Port
              </label>
              <input
                id="scanner-api-port"
                type="number"
                min={1}
                max={65535}
                value={scanPort}
                onChange={(e) => setScanPort(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              />
            </div>
            <div className="sm:col-span-3">
              <button
                type="submit"
                disabled={scanning}
                className="btn-primary w-full text-xs"
              >
                <Radar className={`w-3.5 h-3.5 ${scanning ? 'animate-spin' : ''}`} />
                {scanning ? 'Scanning Subnet...' : 'Scan Network'}
              </button>
            </div>
          </form>

          {scanError && (
            <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
              {scanError}
            </div>
          )}

          {scanResult && (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums text-slate-500 dark:text-[#8793A5]">
                <span>
                  Scanned {scanResult.scannedHosts} host(s) in {scanResult.ipRange} ({scanResult.durationMs} ms)
                </span>
                <span className="font-semibold text-slate-900 dark:text-white">
                  {scanResult.discovered.length} active MikroTik device(s) found
                </span>
              </div>

              {scanResult.discovered.length === 0 ? (
                <div className="p-4 rounded-lg border border-dashed border-stone-200 dark:border-white/10 text-xs text-slate-500 dark:text-[#8793A5]">
                  No active MikroTik RouterOS API or MNDP responders found in <span className="font-mono">{scanResult.ipRange}</span>. Ensure RouterOS API (<span className="font-mono">8728/8729</span>) or MNDP (<span className="font-mono">UDP 5678</span>) is reachable over LAN or WireGuard.
                </div>
              ) : (
                <div className="divide-y divide-stone-200 dark:divide-white/10 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]">
                  {scanResult.discovered.map((item) => {
                    const alreadyExists =
                      item.alreadyAdded || routers.some((existing) => existing.host === item.host);
                    return (
                      <div
                        key={`${item.host}:${item.apiPort}`}
                        className="p-3.5 flex flex-wrap items-center justify-between gap-3 text-xs"
                      >
                        <div className="space-y-1 min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-bold text-slate-900 dark:text-white">
                              {item.suggestedName}
                            </span>
                            <span className="px-2 py-0.5 rounded bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 font-mono text-[11px] font-semibold">
                              {item.discoveryMethods.join(' + ')}
                            </span>
                            {item.roundTripMs !== null && (
                              <span className="font-mono tabular-nums text-[11px] text-slate-500 dark:text-[#8793A5]">
                                {item.roundTripMs.toFixed(2)} ms
                              </span>
                            )}
                          </div>
                          <p className="font-mono text-[11px] text-slate-500 dark:text-[#8793A5]">
                            {item.host}:{item.apiPort} ({item.useTls ? 'TLS' : 'TCP'})
                            {item.boardName ? ` · Board: ${item.boardName}` : ''}
                            {item.routerOsVersion ? ` · ROS ${item.routerOsVersion}` : ''}
                            {item.macAddress ? ` · MAC ${item.macAddress}` : ''}
                          </p>
                        </div>

                        {alreadyExists ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-stone-200/70 dark:bg-white/10 text-slate-600 dark:text-zinc-300 font-mono text-[11px] font-semibold">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />
                            Already in Dashboard
                          </span>
                        ) : (
                          <button
                            type="button"
                            onClick={() => openCreateFromScan(item)}
                            className="btn-primary min-h-[34px] px-3 py-1.5 text-xs"
                          >
                            <Plus className="w-3.5 h-3.5" />
                            Add to Dashboard
                          </button>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </section>
      )}

      {loading ? (
        <div className="p-8 text-center text-xs text-slate-500 dark:text-[#8793A5]">Loading router configuration...</div>
      ) : routers.length === 0 ? (
        <div className="p-6 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 grid grid-cols-1 md:grid-cols-12 gap-6 items-center">
          <div className="md:col-span-4 aspect-square max-h-56 w-full rounded-xl overflow-hidden bg-[#101010] border border-white/10">
            {!imgFailed ? (
              <img
                src="/src/assets/images/mikrotik_router_unit_1795279657733.jpg"
                alt="Optional future MikroTik rackmount router hardware"
                referrerPolicy="no-referrer"
                onError={() => setImgFailed(true)}
                className="w-full h-full object-cover"
              />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-[#FFD400]">
                <RouterIcon className="w-12 h-12" />
              </div>
            )}
          </div>
          <div className="md:col-span-8 space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-mono font-semibold text-amber-600 dark:text-amber-400">
                No MikroTik router connected
              </span>
              <span className="px-2 py-0.5 rounded bg-[#FFD400]/15 text-[#9A7B00] dark:text-[#FFD400] text-[11px] font-mono font-semibold">
                Standalone Mode Active
              </span>
            </div>
            <h3 className="text-lg font-bold">No MikroTik Router Configured — Running in Standalone Mode</h3>
            <p className="text-xs text-slate-500 dark:text-[#8793A5] leading-relaxed">
              TRAX LINK does not require MikroTik credentials, IP addresses, or RouterOS hardware to operate. Multi-tenant customers, packages, voucher tokens, single-device session limits, payment records, and analytics all work natively with your workspace database.
            </p>

            <div className="p-3 rounded-lg bg-amber-500/10 border border-amber-500/25 text-xs text-amber-800 dark:text-amber-200 flex items-start gap-2">
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5 text-amber-500" />
              <div>
                <p className="font-semibold">Using an Airtel Pocket WiFi?</p>
                <p className="text-[11px] opacity-90 mt-0.5">
                  Consumer pocket WiFi hotspots do not expose RouterOS API packet enforcement. When you later connect a MikroTik router (e.g. hAP ac2, RB750Gr3, or CCR2004), use &ldquo;Connect Router&rdquo; to enable automated captive-portal bandwidth queues, WireGuard VPN, and RADIUS session enforcement.
                </p>
              </div>
            </div>

            {canManage && (
              <button
                type="button"
                onClick={openCreate}
                className="btn-primary text-xs"
              >
                <Wifi className="w-3.5 h-3.5" />
                Connect Router (Optional for Future Use)
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          {canManage && (
            <div className="p-3.5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5 text-xs">
                <span className="font-semibold text-slate-900 dark:text-white flex items-center gap-2">
                  <Terminal className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
                  Managed Routers ({routers.length})
                </span>
                <span aria-hidden="true" className="text-slate-400">·</span>
                <span className="font-mono tabular-nums text-slate-500 dark:text-[#8793A5]">
                  {selectedRouterIds.length} of {routers.length} selected for bulk push
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2 text-xs">
                <button
                  type="button"
                  onClick={selectedRouterIds.length === routers.length ? clearSelectedRouters : selectAllRouters}
                  className="btn-secondary min-h-[34px] px-3 py-1.5 text-xs whitespace-nowrap"
                >
                  {selectedRouterIds.length === routers.length ? (
                    <CheckSquare className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400]" />
                  ) : (
                    <Square className="w-3.5 h-3.5" />
                  )}
                  {selectedRouterIds.length === routers.length ? 'Clear All' : 'Select All'}
                </button>
                {selectedRouterIds.length > 0 && selectedRouterIds.length < routers.length && (
                  <button
                    type="button"
                    onClick={clearSelectedRouters}
                    className="btn-secondary min-h-[34px] px-2.5 py-1.5 text-xs whitespace-nowrap"
                  >
                    Clear Selection
                  </button>
                )}
                <button
                  type="button"
                  disabled={selectedRouterIds.length === 0}
                  onClick={openBulkCommandModal}
                  className="btn-primary min-h-[34px] px-3.5 py-1.5 text-xs whitespace-nowrap"
                >
                  <Terminal className="w-3.5 h-3.5" />
                  Bulk Command{selectedRouterIds.length > 0 ? ` (${selectedRouterIds.length})` : ''}
                </button>
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {routers.map((r) => {
            const health = evaluateRouterHealth(r);
            const lastPing = pingResultsByRouter[r.id];
            const pingEval = lastPing ? evaluatePingLatency(lastPing) : null;
            const highLatency = Boolean(pingEval?.exceedsThreshold);
            const isSelected = selectedRouterIds.includes(r.id);

            const cardBorderClass =
              health.level === 'CRITICAL' || highLatency
                ? 'border-red-500/75 dark:border-red-500/60'
                : isSelected
                ? 'border-[#FFD400]/80 dark:border-[#FFD400]/70'
                : health.level === 'WARNING'
                ? 'border-amber-400/70 dark:border-amber-500/45'
                : 'border-stone-200 dark:border-white/10';

            const cpuBarClass =
              health.cpuState === 'CRITICAL'
                ? 'bg-red-500'
                : health.cpuState === 'WARNING'
                ? 'bg-amber-500'
                : 'bg-emerald-500';

            const memBarClass =
              health.memState === 'CRITICAL'
                ? 'bg-red-500'
                : health.memState === 'WARNING'
                ? 'bg-amber-500'
                : 'bg-emerald-500';

            return (
              <div
                key={r.id}
                className={`p-5 rounded-xl bg-white dark:bg-[#161618] border ${cardBorderClass} space-y-4`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-start gap-2.5 min-w-0">
                    {canManage && (
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isSelected}
                        aria-label={`Select ${r.name} for bulk command`}
                        onClick={() => toggleSelectRouter(r.id)}
                        className={`mt-0.5 p-1 rounded-md border transition-colors shrink-0 ${
                          isSelected
                            ? 'bg-[#FFD400]/15 border-[#FFD400]/60 text-[#9A7B00] dark:text-[#FFD400]'
                            : 'bg-stone-50 dark:bg-[#101010] border-stone-200 dark:border-white/15 text-slate-400 hover:text-slate-700 dark:hover:text-zinc-200'
                        }`}
                      >
                        {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                      </button>
                    )}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-bold">{r.name}</h3>
                      <span
                        className={`inline-flex items-center gap-1.5 text-xs font-mono font-semibold ${
                          health.level === 'HEALTHY'
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : health.level === 'CRITICAL'
                            ? 'text-red-600 dark:text-red-400'
                            : health.level === 'WARNING'
                            ? 'text-amber-600 dark:text-amber-400'
                            : 'text-slate-500 dark:text-[#8793A5]'
                        }`}
                      >
                        {health.level === 'HEALTHY' && <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
                        {health.level === 'WARNING' && <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
                        {health.level === 'CRITICAL' && <ShieldAlert className="w-3.5 h-3.5 shrink-0" />}
                        {health.level === 'OFFLINE' && <Wifi className="w-3.5 h-3.5 shrink-0" />}
                        {r.status === 'CONNECTED'
                          ? `CONNECTED · ${health.label}`
                          : health.level === 'CRITICAL'
                          ? health.label
                          : 'No MikroTik router connected'}
                      </span>
                      {lastPing && lastPing.reachable && lastPing.roundTripMs !== null && (
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono tabular-nums font-bold border ${
                            highLatency
                              ? 'bg-red-500/15 text-red-600 dark:text-red-400 border-red-500/35'
                              : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 border-emerald-500/30'
                          }`}
                        >
                          <Gauge className="w-3 h-3" />
                          RTT {lastPing.roundTripMs.toFixed(2)} ms{highLatency ? ` (> ${ROUTER_RTT_ALERT_MS}ms)` : ''}
                        </span>
                      )}
                      {lastPing && !lastPing.reachable && (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[11px] font-mono font-semibold bg-amber-500/12 text-amber-700 dark:text-amber-300 border border-amber-500/30">
                          Ping Unreachable
                        </span>
                      )}
                    </div>
                    <p className="text-xs font-mono text-slate-500 dark:text-[#8793A5] mt-0.5">
                      {r.host ? `${r.host}:${r.apiPort} ${r.useTls ? 'TLS' : 'TCP'}` : 'Host not configured'}
                      {r.locationName ? ` · Site: ${r.locationName}` : ''}
                      {r.routerOsFamily ? ` · ${r.routerOsFamily.replace('ROUTEROS_', 'ROS ')}` : ''}
                      {r.username ? ` · User: ${r.username}` : ''}
                      {r.hotspotServer ? ` · Server: ${r.hotspotServer}` : ''}
                    </p>
                  </div>
                  </div>

                  {canDelete && (
                    <button
                      type="button"
                      onClick={() => handleDelete(r.id)}
                      className="btn-chip-danger p-1.5 shrink-0"
                      title="Remove Router"
                      aria-label="Remove Router"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {r.status === 'CONNECTED' ? (
                  <div className="space-y-2.5">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 text-xs tabular-nums">
                      <div>
                        <div className="flex items-center justify-between text-slate-500 dark:text-[#8793A5]">
                          <span>CPU Load</span>
                          <span className="text-[10px] font-mono">Max {ROUTER_CPU_WARN_PCT}%</span>
                        </div>
                        <div className="flex items-baseline justify-between mt-0.5">
                          <span
                            className={`font-mono font-bold text-sm ${
                              health.cpuState === 'CRITICAL'
                                ? 'text-red-600 dark:text-red-400'
                                : health.cpuState === 'WARNING'
                                ? 'text-amber-600 dark:text-amber-400'
                                : ''
                            }`}
                          >
                            {health.cpuPct ?? 0}%
                          </span>
                          {health.cpuState !== 'NORMAL' && health.cpuState !== 'UNKNOWN' && (
                            <span
                              className={`text-[10px] font-mono font-semibold ${
                                health.cpuState === 'CRITICAL'
                                  ? 'text-red-600 dark:text-red-400'
                                  : 'text-amber-600 dark:text-amber-400'
                              }`}
                            >
                              {health.cpuState}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-stone-200 dark:bg-zinc-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${cpuBarClass}`}
                            style={{ width: `${health.cpuPct ?? 0}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <div className="flex items-center justify-between text-slate-500 dark:text-[#8793A5]">
                          <span>Memory</span>
                          <span className="text-[10px] font-mono">Max {ROUTER_MEM_WARN_PCT}%</span>
                        </div>
                        <div className="flex items-baseline justify-between gap-1 mt-0.5">
                          <span
                            className={`font-mono font-bold text-sm truncate ${
                              health.memState === 'CRITICAL'
                                ? 'text-red-600 dark:text-red-400'
                                : health.memState === 'WARNING'
                                ? 'text-amber-600 dark:text-amber-400'
                                : ''
                            }`}
                          >
                            {health.memPct !== null
                              ? `${health.memPct}%`
                              : r.memoryUsedBytes !== null
                              ? formatBytes(r.memoryUsedBytes)
                              : '—'}
                          </span>
                          {r.memoryUsedBytes !== null && r.memoryTotalBytes !== null && (
                            <span className="text-[10px] font-mono text-slate-500 dark:text-[#8793A5] shrink-0">
                              {formatBytes(r.memoryUsedBytes)} / {formatBytes(r.memoryTotalBytes)}
                            </span>
                          )}
                        </div>
                        <div className="mt-1.5 h-1.5 w-full rounded-full bg-stone-200 dark:bg-zinc-800 overflow-hidden">
                          <div
                            className={`h-full rounded-full transition-all duration-300 ${memBarClass}`}
                            style={{ width: `${health.memPct ?? 0}%` }}
                          />
                        </div>
                      </div>

                      <div>
                        <span className="text-slate-500 dark:text-[#8793A5] block">Uptime</span>
                        <span className="font-mono font-bold text-sm mt-0.5 block">
                          {r.uptime || '—'}
                        </span>
                        {r.routerOsVersion && (
                          <span className="text-[10px] font-mono text-slate-500 dark:text-[#8793A5] block mt-1 truncate">
                            RouterOS {r.routerOsVersion}
                          </span>
                        )}
                      </div>
                    </div>

                    {(health.level === 'WARNING' || health.level === 'CRITICAL') && (
                      <div
                        role="status"
                        className={`p-3 rounded-lg border text-xs flex items-start gap-2 ${
                          health.level === 'CRITICAL'
                            ? 'border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-red-700 dark:text-red-300'
                            : 'border-amber-300 dark:border-amber-800/60 bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200'
                        }`}
                      >
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div>
                          <p className="font-semibold">
                            {health.level === 'CRITICAL' ? 'Critical Resource Threshold Exceeded' : 'Telemetry Warning'}
                          </p>
                          <p className="text-[11px] font-mono mt-0.5">{health.summary}</p>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 text-xs text-slate-500 dark:text-[#8793A5]">
                    {r.lastError || 'Standalone Mode active — run a connection test once MikroTik RouterOS hardware is reachable.'}
                  </div>
                )}

                {highLatency && lastPing?.roundTripMs !== null && lastPing?.roundTripMs !== undefined && (
                  <div
                    role="alert"
                    className="p-3 rounded-lg border border-red-400/70 dark:border-red-500/50 bg-red-50 dark:bg-red-950/35 text-xs text-red-700 dark:text-red-300 flex items-start gap-2"
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-red-500" />
                    <div>
                      <p className="font-semibold">Unstable Connection Latency Alert</p>
                      <p className="text-[11px] font-mono tabular-nums mt-0.5">
                        Ping RTT {lastPing.roundTripMs.toFixed(2)} ms exceeds {ROUTER_RTT_ALERT_MS} ms threshold ({lastPing.host}:{lastPing.port}).
                      </p>
                    </div>
                  </div>
                )}

              <div className="flex flex-wrap items-center justify-between gap-2 pt-1 text-xs">
                <div className="flex items-center gap-2">
                  {canManage && (
                    <>
                      <button
                        type="button"
                        disabled={testingId === r.id}
                        onClick={() => handleTest(r.id)}
                        className="btn-primary min-h-[36px] px-3 py-1.5 text-xs"
                      >
                        <RefreshCw className={`w-3.5 h-3.5 ${testingId === r.id ? 'animate-spin' : ''}`} />
                        {testingId === r.id ? 'Testing...' : 'Test Connection'}
                      </button>
                      <button
                        type="button"
                        onClick={() => handleSyncProfiles(r.id)}
                        className="btn-secondary min-h-[36px] px-3 py-1.5 text-xs"
                      >
                        Sync Profiles
                      </button>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => handleViewSnippet(r)}
                      className="btn-chip-accent"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      WireGuard + RADIUS
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={pingingId === r.id}
                    onClick={() => handlePing(r)}
                    title="Run diagnostic ping test"
                    aria-label={`Ping ${r.name}`}
                    className="btn-chip-neutral"
                  >
                    <Gauge className={`w-3.5 h-3.5 ${pingingId === r.id ? 'animate-spin' : ''}`} />
                    {pingingId === r.id ? 'Pinging...' : 'Ping'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setAnalyticsRouterId(r.id)}
                    title="View 24-hour CPU & memory analytics"
                    aria-label={`24h Analytics for ${r.name}`}
                    className="btn-chip-accent"
                  >
                    <BarChart3 className="w-3.5 h-3.5" />
                    Analytics
                  </button>
                  <button
                    type="button"
                    onClick={() => handleViewInterfaces(r)}
                    className="btn-chip-accent"
                  >
                    <Activity className="w-3.5 h-3.5" />
                    Interfaces
                  </button>
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => openEdit(r)}
                      className="btn-chip-neutral"
                    >
                      Edit
                    </button>
                  )}
                </div>
              </div>
            </div>
            );
          })}
          </div>
        </div>
      )}

      <MobileModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        maxWidthClass="max-w-md"
        panelClassName="space-y-4"
        ariaLabel={editing ? 'Edit MikroTik Router' : 'Connect MikroTik Router (Optional)'}
      >
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{editing ? 'Edit MikroTik Router' : 'Connect MikroTik Router (Optional)'}</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                aria-label="Close modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-[11px] text-slate-500 dark:text-[#8793A5]">
              Host IP, API Port, RouterOS credentials, and Hotspot Server are optional in Standalone Mode and can be completed later when hardware arrives.
            </p>
            <form onSubmit={handleSave} className="space-y-3.5 text-xs">
              <div>
                <label className="block font-medium mb-1">Router Name</label>
                <input
                  type="text"
                  required
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Dar Main Gateway CCR2004"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">Location (Optional)</label>
                  <select
                    value={locationId}
                    onChange={(e) => setLocationId(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  >
                    <option value="">Unassigned</option>
                    {locations.map((loc) => (
                      <option key={loc.id} value={loc.id}>
                        {loc.name} ({loc.region})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block font-medium mb-1">RouterOS Family</label>
                  <select
                    value={routerOsFamily}
                    onChange={(e) => setRouterOsFamily(e.target.value as 'ROUTEROS_V6' | 'ROUTEROS_V7')}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  >
                    <option value="ROUTEROS_V7">RouterOS v7.x</option>
                    <option value="ROUTEROS_V6">RouterOS v6.43+</option>
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className="block font-medium mb-1">Host / VPN IP (Optional)</label>
                  <input
                    type="text"
                    value={host}
                    onChange={(e) => setHost(e.target.value)}
                    placeholder="e.g. 10.66.0.10 or 192.168.88.1"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">API Port</label>
                  <input
                    type="number"
                    value={apiPort}
                    onChange={(e) => setApiPort(e.target.value)}
                    placeholder="8728"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-medium mb-1">RouterOS Username (Optional)</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">
                    {editing ? 'New Password (Blank = keep)' : 'RouterOS Password (Optional)'}
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2 items-center">
                <div>
                  <label className="block font-medium mb-1">Hotspot Server (Optional)</label>
                  <input
                    type="text"
                    value={hotspotServer}
                    onChange={(e) => setHotspotServer(e.target.value)}
                    placeholder="Optional"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <label className="flex items-center gap-2 pt-5 cursor-pointer">
                  <input type="checkbox" checked={useTls} onChange={(e) => setUseTls(e.target.checked)} />
                  <span>Use API-SSL (TLS)</span>
                </label>
              </div>
              <div className="flex justify-end gap-2.5 pt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="btn-primary text-xs"
                >
                  {saving ? 'Saving...' : 'Save Router'}
                </button>
              </div>
            </form>
      </MobileModal>

      <MobileModal
        open={Boolean(selectedIfaces)}
        onClose={() => setSelectedIfaces(null)}
        maxWidthClass="max-w-xl"
        panelClassName="space-y-4"
        ariaLabel="Router Interfaces"
      >
        {selectedIfaces && (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">{selectedIfaces.routerName} — Interfaces</h3>
              <button
                type="button"
                onClick={() => setSelectedIfaces(null)}
                aria-label="Close interfaces modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            {selectedIfaces.interfaces.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-[#8793A5] py-6 text-center">
                No interface telemetry cached yet. Test connection when MikroTik RouterOS hardware is reachable.
              </p>
            ) : (
              <div className="overflow-x-auto max-h-80">
                <table className="w-full text-left text-xs">
                  <thead className="border-b border-stone-200 dark:border-white/10 text-slate-500">
                    <tr>
                      <th className="py-2">Interface</th>
                      <th className="py-2">Type</th>
                      <th className="py-2">State</th>
                      <th className="py-2 text-right">RX</th>
                      <th className="py-2 text-right">TX</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-stone-100 dark:divide-white/10 font-mono tabular-nums">
                    {selectedIfaces.interfaces.map((i) => (
                      <tr key={i.id}>
                        <td className="py-2 font-medium">{i.name}</td>
                        <td className="py-2">{i.type}</td>
                        <td className="py-2">{i.running ? 'RUNNING' : 'DOWN'}</td>
                        <td className="py-2 text-right">{formatBytes(i.rxBytes)}</td>
                        <td className="py-2 text-right">{formatBytes(i.txBytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </MobileModal>

      <MobileModal
        open={Boolean(snippetModal)}
        onClose={() => setSnippetModal(null)}
        maxWidthClass="max-w-2xl"
        panelClassName="space-y-4"
        ariaLabel="WireGuard + FreeRADIUS Script"
      >
        {snippetModal && (
          <>
            <div className="flex items-center justify-between gap-3">
              <div>
                <h3 className="text-base font-semibold">
                  {snippetModal.routerName} — WireGuard + FreeRADIUS Script
                </h3>
                <p className="text-xs text-slate-500 dark:text-[#8793A5]">
                  Target: {snippetModal.routerOsFamily} · Paste into MikroTik Terminal once hardware is connected.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setSnippetModal(null)}
                aria-label="Close WireGuard snippet modal"
                className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <pre className="p-4 rounded-xl bg-[#101010] border border-white/10 text-[11px] font-mono text-zinc-100 overflow-x-auto max-h-96 whitespace-pre">
              {snippetModal.snippet}
            </pre>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={async () => {
                  await navigator.clipboard.writeText(snippetModal.snippet).catch(() => {});
                  setCopiedSnippet(true);
                  setTimeout(() => setCopiedSnippet(false), 2000);
                }}
                className="btn-primary text-xs"
              >
                {copiedSnippet ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedSnippet ? 'Copied Script' : 'Copy RouterOS Script'}
              </button>
            </div>
          </>
        )}
      </MobileModal>

      <MobileModal
        open={bulkModalOpen}
        onClose={() => setBulkModalOpen(false)}
        maxWidthClass="max-w-xl"
        panelClassName="space-y-4"
        ariaLabel="Bulk Command Configuration Push"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400]" />
              Bulk Command Push
            </h3>
            <p className="text-xs text-slate-500 dark:text-[#8793A5] mt-0.5">
              Push a shared RouterOS configuration update simultaneously to {selectedRouters.length} selected router(s).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setBulkModalOpen(false)}
            aria-label="Close bulk command modal"
            className="btn-icon min-h-[34px] min-w-[34px] p-1.5"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="text-[11px] font-mono text-slate-600 dark:text-zinc-300 p-2.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10">
          Targets: {selectedRouters.map((r) => `${r.name}${r.host ? ` (${r.host})` : ''}`).join(' · ') || 'None selected'}
        </div>

        <div className="btn-tab-group flex-wrap">
          {(
            [
              { id: 'UPDATE_SSID', label: 'Update SSID' },
              { id: 'UPDATE_NTP', label: 'NTP Server' },
              { id: 'SET_DNS_SERVERS', label: 'DNS Servers' },
              { id: 'SET_TIMEZONE', label: 'Timezone' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setBulkCommandType(tab.id);
                setBulkError(null);
              }}
              className={bulkCommandType === tab.id ? 'btn-tab-active' : 'btn-tab'}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={handleRunBulkCommand} className="space-y-3.5 text-xs">
          {bulkCommandType === 'UPDATE_SSID' && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="bulk-ssid" className="block font-medium mb-1">
                  Shared WiFi SSID
                </label>
                <input
                  id="bulk-ssid"
                  type="text"
                  required
                  maxLength={32}
                  value={bulkSsid}
                  onChange={(e) => setBulkSsid(e.target.value)}
                  placeholder="TRAX-LINK-WIFI"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
              <div>
                <label htmlFor="bulk-wifi-iface" className="block font-medium mb-1">
                  Wireless Interface (Optional)
                </label>
                <input
                  id="bulk-wifi-iface"
                  type="text"
                  value={bulkWifiIface}
                  onChange={(e) => setBulkWifiIface(e.target.value)}
                  placeholder="Blank = all wireless/wifi interfaces"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
            </div>
          )}

          {bulkCommandType === 'UPDATE_NTP' && (
            <div className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label htmlFor="bulk-ntp-primary" className="block font-medium mb-1">
                    Primary NTP Server
                  </label>
                  <input
                    id="bulk-ntp-primary"
                    type="text"
                    required
                    value={bulkNtpPrimary}
                    onChange={(e) => setBulkNtpPrimary(e.target.value)}
                    placeholder="pool.ntp.org"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
                <div>
                  <label htmlFor="bulk-ntp-secondary" className="block font-medium mb-1">
                    Secondary NTP Server (Optional)
                  </label>
                  <input
                    id="bulk-ntp-secondary"
                    type="text"
                    value={bulkNtpSecondary}
                    onChange={(e) => setBulkNtpSecondary(e.target.value)}
                    placeholder="time.cloudflare.com"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bulkNtpEnabled}
                  onChange={(e) => setBulkNtpEnabled(e.target.checked)}
                />
                <span>Enable RouterOS NTP Client</span>
              </label>
            </div>
          )}

          {bulkCommandType === 'SET_DNS_SERVERS' && (
            <div className="space-y-3">
              <div>
                <label htmlFor="bulk-dns-servers" className="block font-medium mb-1">
                  DNS Servers (Comma-Separated IPs)
                </label>
                <input
                  id="bulk-dns-servers"
                  type="text"
                  required
                  value={bulkDnsServers}
                  onChange={(e) => setBulkDnsServers(e.target.value)}
                  placeholder="1.1.1.1,8.8.8.8"
                  className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={bulkDnsRemote}
                  onChange={(e) => setBulkDnsRemote(e.target.checked)}
                />
                <span>Allow Remote DNS Requests</span>
              </label>
            </div>
          )}

          {bulkCommandType === 'SET_TIMEZONE' && (
            <div>
              <label htmlFor="bulk-timezone" className="block font-medium mb-1">
                RouterOS Timezone Name
              </label>
              <input
                id="bulk-timezone"
                type="text"
                required
                value={bulkTimezone}
                onChange={(e) => setBulkTimezone(e.target.value)}
                placeholder="Africa/Dar_es_Salaam"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              />
            </div>
          )}

          {bulkError && (
            <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
              {bulkError}
            </div>
          )}

          {bulkResult && (
            <div className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono tabular-nums">
                <span className="font-semibold text-slate-900 dark:text-white">
                  Execution Summary ({bulkResult.commandType})
                </span>
                <span>
                  <span className="text-emerald-600 dark:text-emerald-400 font-bold">
                    {bulkResult.succeededCount} succeeded
                  </span>
                  <span className="mx-1.5 text-slate-400">·</span>
                  <span className={bulkResult.failedCount > 0 ? 'text-red-600 dark:text-red-400 font-bold' : 'text-slate-500'}>
                    {bulkResult.failedCount} failed
                  </span>
                </span>
              </div>
              <div className="max-h-48 overflow-y-auto divide-y divide-stone-200 dark:divide-white/10 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]">
                {bulkResult.results.map((item) => (
                  <div key={item.routerId} className="p-2.5 flex items-start justify-between gap-2 text-xs">
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 dark:text-white truncate">
                        {item.routerName}
                        {item.host ? ` (${item.host}:${item.apiPort})` : ''}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500 dark:text-[#8793A5] mt-0.5 break-words">
                        {item.success ? item.summary : item.error}
                      </p>
                    </div>
                    <span
                      className={`inline-flex items-center gap-1 font-mono text-[11px] font-bold shrink-0 ${
                        item.success
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {item.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
                      {item.success ? 'OK' : 'FAILED'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2.5 pt-1">
            <button
              type="button"
              onClick={() => setBulkModalOpen(false)}
              className="btn-secondary text-xs"
            >
              Close
            </button>
            <button
              type="submit"
              disabled={bulkSubmitting || selectedRouterIds.length === 0}
              className="btn-primary text-xs"
            >
              <Terminal className={`w-3.5 h-3.5 ${bulkSubmitting ? 'animate-spin' : ''}`} />
              {bulkSubmitting
                ? 'Pushing Configuration...'
                : `Push to ${selectedRouterIds.length} Router(s)`}
            </button>
          </div>
        </form>
      </MobileModal>

      <AnimatePresence>
        {pingToast && (() => {
          const toastLatency = evaluatePingLatency(pingToast);
          const isHighLatency = toastLatency.exceedsThreshold;
          return (
            <motion.div
              key={pingToast.checkedAt + pingToast.routerId}
              initial={{ opacity: 0, y: 16, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 12, scale: 0.96 }}
              transition={NATIVE_SPRING}
              role="status"
              aria-live="polite"
              className={`no-print fixed bottom-5 right-5 z-50 w-[min(92vw,22rem)] rounded-xl border px-3.5 py-2.5 shadow-lg bg-white dark:bg-[#161618] ${
                isHighLatency
                  ? 'border-red-500/65'
                  : pingToast.reachable
                  ? 'border-emerald-500/40'
                  : 'border-amber-500/45'
              }`}
            >
              <div className="flex items-start justify-between gap-2.5">
                <div className="flex items-start gap-2.5 min-w-0">
                  <div
                    className={`mt-0.5 p-1.5 rounded-lg shrink-0 ${
                      isHighLatency
                        ? 'bg-red-500/15 text-red-600 dark:text-red-400'
                        : pingToast.reachable
                        ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
                        : 'bg-amber-500/15 text-amber-600 dark:text-amber-400'
                    }`}
                  >
                    {isHighLatency ? <AlertTriangle className="w-4 h-4" /> : <Gauge className="w-4 h-4" />}
                  </div>
                  <div className="min-w-0 text-xs">
                    <p
                      className={`font-semibold truncate ${
                        isHighLatency
                          ? 'text-red-600 dark:text-red-400'
                          : 'text-slate-900 dark:text-white'
                      }`}
                    >
                      {isHighLatency
                        ? `High Latency · ${pingToast.routerName}`
                        : pingToast.reachable
                        ? `Ping OK · ${pingToast.routerName}`
                        : `Ping Unreachable · ${pingToast.routerName}`}
                    </p>
                    {pingToast.reachable && pingToast.roundTripMs !== null ? (
                      <p
                        className={`font-mono tabular-nums font-bold mt-0.5 ${
                          isHighLatency
                            ? 'text-red-600 dark:text-red-400'
                            : 'text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        RTT {pingToast.roundTripMs.toFixed(2)} ms
                        {isHighLatency ? ` (> ${ROUTER_RTT_ALERT_MS}ms)` : ''}
                        <span className="font-normal text-slate-500 dark:text-[#8793A5] ml-1.5">
                          ({pingToast.host}:{pingToast.port})
                        </span>
                      </p>
                    ) : (
                      <p className="text-[11px] text-slate-500 dark:text-[#8793A5] mt-0.5 break-words">
                        {pingToast.error || 'Target host did not respond'}
                      </p>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setPingToast(null)}
                  aria-label="Dismiss ping status"
                  className="btn-icon min-h-[26px] min-w-[26px] p-1 shrink-0"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </motion.div>
          );
        })()}
      </AnimatePresence>
    </div>
  );
}
