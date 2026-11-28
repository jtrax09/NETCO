import React, { useEffect, useState } from 'react';
import { CheckCircle2, Link2Off, Radio, Router, ShieldAlert, Wifi } from 'lucide-react';
import { apiRequest } from '../lib/api.ts';

type GatewayType = 'MIKROTIK' | 'POCKET_WIFI' | 'STANDARD_ROUTER';

interface WifiStatusResponse {
  businessId: string;
  businessName: string;
  hotspotTitle: string | null;
  wifiSsid: string | null;
  wifiGatewayIp: string | null;
  wifiGatewayType: GatewayType | null;
  operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
  linkedRouter: {
    id: string;
    name: string;
    host: string;
    apiPort: number;
    status: string;
    lastError: string | null;
  } | null;
  updatedAt: string | null;
}

interface WifiConnectResponse {
  businessId: string;
  wifiSsid: string;
  wifiGatewayIp: string | null;
  wifiGatewayType: GatewayType;
  operatingMode: 'STANDALONE_MODE' | 'MIKROTIK_MODE';
  gatewayProbe: {
    reachable: boolean;
    port: number | null;
    roundTripMs: number | null;
    error: string | null;
  };
  telemetry: {
    connected: boolean;
    error?: string | null;
  } | null;
  message: string;
}

interface Props {
  token: string;
  canManage: boolean;
  refreshTrigger?: number;
  compact?: boolean;
  onConnected?: () => void;
}

const GATEWAY_PRESETS: Array<{ label: string; ip: string; type: GatewayType }> = [
  { label: 'MikroTik (192.168.88.1)', ip: '192.168.88.1', type: 'MIKROTIK' },
  { label: 'Pocket WiFi (192.168.8.1)', ip: '192.168.8.1', type: 'POCKET_WIFI' },
  { label: 'Router (192.168.1.1)', ip: '192.168.1.1', type: 'STANDARD_ROUTER' },
  { label: 'TP-Link (192.168.0.1)', ip: '192.168.0.1', type: 'STANDARD_ROUTER' },
];

export function WifiConnectCard({ token, canManage, refreshTrigger = 0, compact = false, onConnected }: Props) {
  const [status, setStatus] = useState<WifiStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(!compact);
  const [submitting, setSubmitting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultMsg, setResultMsg] = useState<string | null>(null);
  const [probeInfo, setProbeInfo] = useState<WifiConnectResponse['gatewayProbe'] | null>(null);

  const [wifiSsid, setWifiSsid] = useState('');
  const [gatewayType, setGatewayType] = useState<GatewayType>('POCKET_WIFI');
  const [gatewayIp, setGatewayIp] = useState('');
  const [apiPort, setApiPort] = useState('8728');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [hotspotServer, setHotspotServer] = useState('');
  const [updateRouterSsid, setUpdateRouterSsid] = useState(false);

  const loadStatus = async () => {
    setLoading(true);
    try {
      const res = await apiRequest<WifiStatusResponse>('/api/wifi/status', { token });
      setStatus(res);
      if (res.wifiSsid) setWifiSsid(res.wifiSsid);
      if (res.wifiGatewayIp) setGatewayIp(res.wifiGatewayIp);
      if (res.wifiGatewayType) setGatewayType(res.wifiGatewayType);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load WiFi status');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadStatus();
  }, [token, refreshTrigger]);

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canManage || submitting) return;
    setSubmitting(true);
    setError(null);
    setResultMsg(null);
    try {
      const res = await apiRequest<WifiConnectResponse>('/api/wifi/connect', {
        method: 'POST',
        token,
        body: {
          wifiSsid: wifiSsid.trim(),
          gatewayType,
          gatewayIp: gatewayIp.trim(),
          apiPort: Number(apiPort) || 8728,
          username: username.trim(),
          password: password.trim(),
          hotspotServer: hotspotServer.trim(),
          updateRouterSsid,
        },
      });
      setResultMsg(res.message);
      setProbeInfo(res.gatewayProbe);
      setPassword('');
      await loadStatus();
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to connect to WiFi');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDisconnect = async () => {
    if (!canManage || disconnecting) return;
    setDisconnecting(true);
    setError(null);
    setResultMsg(null);
    try {
      await apiRequest('/api/wifi/connect', { method: 'DELETE', token });
      setWifiSsid('');
      setGatewayIp('');
      setProbeInfo(null);
      setResultMsg('WiFi network unlinked from this workspace.');
      await loadStatus();
      onConnected?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to unlink WiFi');
    } finally {
      setDisconnecting(false);
    }
  };

  const hasLinkedWifi = Boolean(status?.wifiSsid);

  return (
    <section
      aria-label="Connect Admin WiFi"
      className="p-4 sm:p-5 rounded-xl bg-white dark:bg-[#161618] border border-stone-200 dark:border-white/10 space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="space-y-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Wifi className="w-4 h-4 text-[#9A7B00] dark:text-[#FFD400] shrink-0" />
            <h2 className="text-sm font-bold text-slate-900 dark:text-white">
              Connect to Your WiFi Network
            </h2>
            {hasLinkedWifi ? (
              <span className="font-mono text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">
                Linked: {status?.wifiSsid}
                {status?.wifiGatewayIp ? ` (${status.wifiGatewayIp})` : ''}
              </span>
            ) : (
              <span className="font-mono text-[11px] text-slate-500 dark:text-[#8793A5]">
                Not Linked
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 dark:text-[#8793A5]">
            Link your MikroTik router, Airtel Pocket WiFi, or local router SSID directly to this TRAX LINK workspace.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {hasLinkedWifi && canManage && (
            <button
              type="button"
              disabled={disconnecting}
              onClick={handleDisconnect}
              className="btn-secondary min-h-[34px] px-3 py-1.5 text-xs"
            >
              <Link2Off className="w-3.5 h-3.5" />
              {disconnecting ? 'Unlinking...' : 'Unlink WiFi'}
            </button>
          )}
          {compact && (
            <button
              type="button"
              onClick={() => setExpanded((v) => !v)}
              className="btn-primary min-h-[34px] px-3 py-1.5 text-xs"
            >
              <Radio className="w-3.5 h-3.5" />
              {expanded ? 'Hide WiFi Setup' : hasLinkedWifi ? 'Change WiFi' : 'Connect My WiFi'}
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="p-3 rounded-lg border border-red-300 dark:border-red-900/60 bg-red-50 dark:bg-red-950/30 text-xs text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {resultMsg && (
        <div className="p-3 rounded-lg border border-emerald-300 dark:border-emerald-900/60 bg-emerald-50 dark:bg-emerald-950/30 text-xs text-emerald-700 dark:text-emerald-300 flex items-start gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
          <div className="space-y-0.5">
            <p>{resultMsg}</p>
            {probeInfo && probeInfo.reachable && probeInfo.roundTripMs !== null && (
              <p className="font-mono text-[11px]">
                Gateway port {probeInfo.port} responded in {probeInfo.roundTripMs} ms
              </p>
            )}
          </div>
        </div>
      )}

      {expanded && !loading && (
        <form onSubmit={handleConnect} className="space-y-4 pt-2 border-t border-stone-100 dark:border-white/10 text-xs">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-slate-500 dark:text-[#8793A5] mr-1">Quick gateway presets:</span>
            {GATEWAY_PRESETS.map((preset) => (
              <button
                key={preset.ip}
                type="button"
                disabled={!canManage}
                onClick={() => {
                  setGatewayIp(preset.ip);
                  setGatewayType(preset.type);
                }}
                className="btn-chip-neutral font-mono"
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block font-medium mb-1">WiFi Name (SSID)</label>
              <input
                type="text"
                required
                maxLength={32}
                disabled={!canManage}
                value={wifiSsid}
                onChange={(e) => setWifiSsid(e.target.value)}
                placeholder="e.g. TRAX-LINK-WIFI"
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              />
            </div>

            <div>
              <label className="block font-medium mb-1">WiFi Hardware Type</label>
              <select
                disabled={!canManage}
                value={gatewayType}
                onChange={(e) => setGatewayType(e.target.value as GatewayType)}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010]"
              >
                <option value="POCKET_WIFI">Pocket WiFi / MiFi (Standalone)</option>
                <option value="STANDARD_ROUTER">Standard WiFi Router (Standalone)</option>
                <option value="MIKROTIK">MikroTik RouterOS Gateway</option>
              </select>
            </div>

            <div>
              <label className="block font-medium mb-1">
                Gateway IP {gatewayType === 'MIKROTIK' ? '(Required)' : '(Optional)'}
              </label>
              <input
                type="text"
                disabled={!canManage}
                required={gatewayType === 'MIKROTIK'}
                value={gatewayIp}
                onChange={(e) => setGatewayIp(e.target.value)}
                placeholder={gatewayType === 'MIKROTIK' ? '192.168.88.1' : '192.168.8.1'}
                className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-stone-50 dark:bg-[#101010] font-mono"
              />
            </div>
          </div>

          {gatewayType === 'MIKROTIK' ? (
            <div className="p-3.5 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10 space-y-3">
              <div className="flex items-center gap-2 text-[11px] font-semibold text-slate-700 dark:text-zinc-200">
                <Router className="w-3.5 h-3.5 text-[#9A7B00] dark:text-[#FFD400]" />
                MikroTik RouterOS Credentials (Tested Over API Port)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
                <div>
                  <label className="block font-medium mb-1">API Port</label>
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    disabled={!canManage}
                    value={apiPort}
                    onChange={(e) => setApiPort(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#161618] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Username</label>
                  <input
                    type="text"
                    disabled={!canManage}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="admin"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#161618] font-mono"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Password</label>
                  <input
                    type="password"
                    disabled={!canManage}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#161618]"
                  />
                </div>
                <div>
                  <label className="block font-medium mb-1">Hotspot Server (Opt.)</label>
                  <input
                    type="text"
                    disabled={!canManage}
                    value={hotspotServer}
                    onChange={(e) => setHotspotServer(e.target.value)}
                    placeholder="hotspot1"
                    className="w-full px-3 py-2 rounded-lg border border-stone-200 dark:border-white/10 bg-white dark:bg-[#161618] font-mono"
                  />
                </div>
              </div>
              <label className="inline-flex items-center gap-2 text-[11px] text-slate-600 dark:text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  disabled={!canManage}
                  checked={updateRouterSsid}
                  onChange={(e) => setUpdateRouterSsid(e.target.checked)}
                />
                <span>Also push this SSID name to the MikroTik wireless interface once connected</span>
              </label>
            </div>
          ) : (
            <div className="p-3 rounded-lg bg-stone-50 dark:bg-[#101010] border border-stone-200/80 dark:border-white/10 flex items-start gap-2 text-[11px] text-slate-600 dark:text-zinc-300">
              <ShieldAlert className="w-4 h-4 shrink-0 text-[#9A7B00] dark:text-[#FFD400] mt-0.5" />
              <span>
                Standalone WiFi Mode links your SSID and gateway reference to your Customer Portal and workspace. Consumer Pocket WiFi routers do not expose a MikroTik packet-control API.
              </span>
            </div>
          )}

          {canManage && (
            <div className="flex justify-end">
              <button type="submit" disabled={submitting} className="btn-primary text-xs">
                <Wifi className="w-3.5 h-3.5" />
                {submitting ? 'Connecting WiFi...' : 'Connect WiFi to Workspace'}
              </button>
            </div>
          )}
        </form>
      )}
    </section>
  );
}
