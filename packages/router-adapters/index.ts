export type RouterOsFamily = 'ROUTEROS_V6' | 'ROUTEROS_V7';

export interface RouterCompatibilityProfile {
  family: RouterOsFamily;
  supportsDirectPasswordLogin: boolean;
  hotspotProfilePath: string;
  hotspotActivePath: string;
  wireguardSupported: boolean;
}

export const ROUTEROS_ADAPTER_PROFILES: Record<RouterOsFamily, RouterCompatibilityProfile> = {
  ROUTEROS_V6: {
    family: 'ROUTEROS_V6',
    supportsDirectPasswordLogin: false,
    hotspotProfilePath: '/ip/hotspot/user/profile',
    hotspotActivePath: '/ip/hotspot/active',
    wireguardSupported: false,
  },
  ROUTEROS_V7: {
    family: 'ROUTEROS_V7',
    supportsDirectPasswordLogin: true,
    hotspotProfilePath: '/ip/hotspot/user/profile',
    hotspotActivePath: '/ip/hotspot/active',
    wireguardSupported: true,
  },
};

export function generateMikrotikWireguardSnippet(params: {
  routerName: string;
  cloudWgPublicKey: string;
  cloudWgEndpoint: string;
  routerTunnelCidr: string;
  cloudRadiusIp: string;
  radiusSecret: string;
  hotspotServer?: string;
}): string {
  const serverFilter = params.hotspotServer ? `name="${params.hotspotServer}"` : 'default=yes';
  return [
    `# TRAX LINK — MikroTik RouterOS Provisioning (${params.routerName})`,
    `/interface wireguard add listen-port=13231 name=wg-traxlink`,
    `/ip address add address=${params.routerTunnelCidr} interface=wg-traxlink`,
    `/interface wireguard peers add allowed-address=10.66.0.0/24 endpoint-address=${params.cloudWgEndpoint} interface=wg-traxlink persistent-keepalive=25s public-key="${params.cloudWgPublicKey}"`,
    `/radius add address=${params.cloudRadiusIp} secret="${params.radiusSecret}" service=hotspot timeout=3000ms`,
    `/ip hotspot profile set [find ${serverFilter}] use-radius=yes radius-accounting=yes radius-interim-update=00:05:00`,
  ].join('\n');
}
