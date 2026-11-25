import React, { useEffect, useState } from 'react';
import { Activity, Check, Copy, KeyRound, Plus, RefreshCw, Router as RouterIcon, ShieldAlert, Trash2, Wifi, X } from 'lucide-react';
import { apiRequest, formatBytes } from '../lib/api.ts';

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
  const [switchingMode, setSwitchingMode] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [imgFailed, setImgFailed] = useState(false);

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

  const load = async () => {
    setLoading(true);
    try {
      const [res, mRes, locRes] = await Promise.all([
        apiRequest<{ routers: RouterItem[] }>('/api/routers', { token }),
        apiRequest<SystemModeInfo>('/api/system/mode'),
        apiRequest<{ locations: LocationOption[] }>('/api/locations', { token }).catch(() => ({ locations: [] })),
      ]);
      setRouters(res.routers);
      setModeInfo(mRes);
      setLocations(locRes.locations);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load routers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, [token, refreshTrigger]);

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

  const handleDelete = async (id: string) => {
    try {
      await apiRequest(`/api/routers/${id}`, { method: 'DELETE', token });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to remove router');
    }
  };

  const operatingMode = modeInfo?.operatingMode || 'STANDALONE_MODE';

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
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {routers.map((r) => (
            <div
              key={r.id}
              className="p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4"
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-bold">{r.name}</h3>
                    <span
                      className={
                        r.status === 'CONNECTED'
                          ? 'text-xs font-mono text-emerald-600 dark:text-emerald-400 font-semibold'
                          : 'text-xs font-mono text-amber-600 dark:text-amber-400 font-semibold'
                      }
                    >
                      {r.status === 'CONNECTED' ? 'CONNECTED' : 'No MikroTik router connected'}
                    </span>
                  </div>
                  <p className="text-xs font-mono text-slate-500 dark:text-[#8793A5] mt-0.5">
                    {r.host ? `${r.host}:${r.apiPort} ${r.useTls ? 'TLS' : 'TCP'}` : 'Host not configured'}
                    {r.locationName ? ` · Site: ${r.locationName}` : ''}
                    {r.routerOsFamily ? ` · ${r.routerOsFamily.replace('ROUTEROS_', 'ROS ')}` : ''}
                    {r.username ? ` · User: ${r.username}` : ''}
                    {r.hotspotServer ? ` · Server: ${r.hotspotServer}` : ''}
                  </p>
                </div>

                {canDelete && (
                  <button
                    type="button"
                    onClick={() => handleDelete(r.id)}
                    className="btn-chip-danger p-1.5"
                    title="Remove Router"
                    aria-label="Remove Router"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>

              {r.status === 'CONNECTED' ? (
                <div className="grid grid-cols-3 gap-3 p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 text-xs tabular-nums">
                  <div>
                    <span className="text-slate-500 dark:text-[#8793A5] block">CPU Load</span>
                    <span className="font-mono font-bold text-sm">{r.cpuLoad ?? 0}%</span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-[#8793A5] block">Memory</span>
                    <span className="font-mono font-bold text-sm">
                      {r.memoryUsedBytes !== null ? formatBytes(r.memoryUsedBytes) : '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-slate-500 dark:text-[#8793A5] block">Uptime</span>
                    <span className="font-mono font-bold text-sm">{r.uptime || '—'}</span>
                  </div>
                </div>
              ) : (
                <div className="p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200 dark:border-white/10 text-xs text-slate-500 dark:text-[#8793A5]">
                  {r.lastError || 'Standalone Mode active — run a connection test once MikroTik RouterOS hardware is reachable.'}
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
          ))}
        </div>
      )}

      {modalOpen && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-md w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl p-6 space-y-4 max-h-[90vh] overflow-y-auto">
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
          </div>
        </div>
      )}

      {selectedIfaces && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-xl w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl p-6 space-y-4">
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
          </div>
        </div>
      )}

      {snippetModal && (
        <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="max-w-2xl w-full bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 rounded-xl p-6 space-y-4">
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
          </div>
        </div>
      )}
    </div>
  );
}
