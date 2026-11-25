export type OperatingMode = 'STANDALONE_MODE' | 'MIKROTIK_MODE';

export type StaffRole =
  | 'SUPER_ADMIN'
  | 'BUSINESS_OWNER'
  | 'ADMIN'
  | 'ACCOUNTANT'
  | 'NETWORK_OPERATOR'
  | 'SUPPORT_STAFF'
  | 'CASHIER';

export type BusinessStatus = 'PENDING' | 'ACTIVE' | 'SUSPENDED';

export type PackageType = 'TIME_BASED' | 'DATA_BASED' | 'TIME_AND_DATA' | 'UNLIMITED_FUP';

export type MobileMoneyProvider = 'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA' | 'CARD';

export type SubscriptionStatus =
  | 'PENDING_PROVISIONING'
  | 'ACTIVE'
  | 'EXPIRED'
  | 'SUSPENDED'
  | 'CANCELLED';

export type ProvisioningStatus =
  | 'QUEUED'
  | 'PROCESSING'
  | 'COMPLETED'
  | 'FAILED_RETRYING'
  | 'NO_ROUTER';

export interface TenantContext {
  businessId: string;
  actorId: string;
  actorEmail: string;
  actorRole: StaffRole;
}

export function formatCurrency(amount: number, currency = 'TZS'): string {
  return `${Math.round(amount).toLocaleString()} ${currency}`;
}
