export type MobileMoneyProviderKey = 'MPESA' | 'AIRTEL_MONEY' | 'TIGO_PESA' | 'HALOPESA';

export interface ProviderBrandMeta {
  key: MobileMoneyProviderKey;
  label: string;
  logoUrl: string;
  alt: string;
}

export const PAYMENT_PROVIDER_BRANDS: Record<MobileMoneyProviderKey, ProviderBrandMeta> = {
  MPESA: {
    key: 'MPESA',
    label: 'M-Pesa',
    logoUrl: '/assets/aistudio/mpesa_logo.png',
    alt: 'Vodacom M-Pesa',
  },
  AIRTEL_MONEY: {
    key: 'AIRTEL_MONEY',
    label: 'Airtel Money',
    logoUrl: '/assets/aistudio/airtel_money_logo.png',
    alt: 'Airtel Money',
  },
  TIGO_PESA: {
    key: 'TIGO_PESA',
    label: 'Yas / Tigo Pesa',
    logoUrl: '/assets/aistudio/yas_logo.png',
    alt: 'Yas (Mixx by Yas / Tigo Pesa)',
  },
  HALOPESA: {
    key: 'HALOPESA',
    label: 'HaloPesa',
    logoUrl: '/assets/aistudio/halopesa_logo.png',
    alt: 'HaloPesa Tanzania',
  },
};

export function getProviderBrand(provider: string): ProviderBrandMeta | null {
  if (provider in PAYMENT_PROVIDER_BRANDS) {
    return PAYMENT_PROVIDER_BRANDS[provider as MobileMoneyProviderKey];
  }
  return null;
}
