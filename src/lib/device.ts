// Generates a stable device fingerprint in memory + subtle hardware signals
// without relying solely on MAC addresses.

let cachedFingerprint: string | null = null;

export async function getDeviceFingerprint(): Promise<string> {
  if (cachedFingerprint) return cachedFingerprint;

  const seed = [
    navigator.userAgent,
    navigator.language,
    `${screen.width}x${screen.height}x${screen.colorDepth}`,
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    String(navigator.hardwareConcurrency || 0),
  ].join('|');

  const encoder = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(seed));
  const hex = Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

  cachedFingerprint = `dev-${hex.slice(0, 24)}`;
  return cachedFingerprint;
}

export function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'Android Mobile';
  if (/iPhone/i.test(ua)) return 'Apple iPhone';
  if (/iPad/i.test(ua)) return 'Apple iPad';
  if (/Windows/i.test(ua)) return 'Windows Workstation';
  if (/Macintosh/i.test(ua)) return 'macOS Device';
  if (/Linux/i.test(ua)) return 'Linux Terminal';
  return 'Web Client Device';
}
