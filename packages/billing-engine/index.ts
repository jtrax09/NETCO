export interface BillingCalculationInput {
  username: string;
  downloadKbps: number;
  uploadKbps: number;
  sessionTimeoutSeconds: number;
  dataLimitMb: number | null;
  simultaneousUse: number;
}

export interface RadiusPolicyAttributes {
  mikrotikRateLimit: string;
  sessionTimeoutSeconds: number;
  simultaneousUse: number;
  dataLimitBytes: number | null;
}

export function computeSubscriptionPolicy(input: BillingCalculationInput): RadiusPolicyAttributes {
  const durationSec = Math.max(60, Math.round(input.sessionTimeoutSeconds));
  const dataLimitBytes =
    input.dataLimitMb !== null && input.dataLimitMb > 0
      ? Math.round(input.dataLimitMb * 1024 * 1024)
      : null;

  return {
    mikrotikRateLimit: `${input.uploadKbps}k/${input.downloadKbps}k`,
    sessionTimeoutSeconds: durationSec,
    simultaneousUse: Math.max(1, input.simultaneousUse || 1),
    dataLimitBytes,
  };
}

export function computeNextRetryDelayMs(attempt: number): number {
  const bounded = Math.min(Math.max(1, attempt), 6);
  return Math.pow(2, bounded) * 15_000;
}
