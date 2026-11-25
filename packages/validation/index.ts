import { z } from 'zod';

export const businessRegistrationSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  ownerName: z.string().trim().min(2).max(120),
  ownerEmail: z.string().trim().email(),
  phone: z.string().trim().min(9).max(24),
  password: z.string().min(8).max(128),
  country: z.string().trim().min(2).max(80).default('Tanzania'),
  region: z.string().trim().min(2).max(80).default('Dar es Salaam'),
  planCode: z.string().trim().min(2).max(40).default('STARTER'),
});

export const locationSchema = z.object({
  name: z.string().trim().min(2).max(100),
  region: z.string().trim().min(2).max(80).default('Dar es Salaam'),
  address: z.string().trim().max(200).optional().nullable(),
  contactName: z.string().trim().max(120).optional().nullable(),
});

export const packagePayloadSchema = z.object({
  name: z.string().trim().min(2).max(100),
  description: z.string().max(300).optional().nullable(),
  category: z.enum(['HOURLY', 'DAILY', 'WEEKLY', 'MONTHLY']),
  packageType: z
    .enum(['TIME_BASED', 'DATA_BASED', 'TIME_AND_DATA', 'UNLIMITED_FUP'])
    .optional()
    .default('TIME_BASED'),
  priceTzs: z.number().int().min(0).max(50_000_000),
  durationMinutes: z.number().int().min(1).max(525_600),
  downloadKbps: z.number().int().min(64).max(10_000_000),
  uploadKbps: z.number().int().min(64).max(10_000_000),
  dataLimitMb: z.number().int().min(1).optional().nullable(),
  deviceLimit: z.number().int().min(1).max(20).optional().default(1),
  simultaneousSessions: z.number().int().min(1).max(20).optional().default(1),
  validityDays: z.number().int().min(1).max(3650).default(30),
  fupPolicy: z.string().max(240).optional().nullable(),
  currency: z.string().trim().min(3).max(6).optional().default('TZS'),
});

export const saasPlanSchema = z.object({
  code: z.string().trim().min(2).max(40),
  name: z.string().trim().min(2).max(80),
  priceMonthlyTzs: z.number().int().min(0).max(100_000_000),
  priceYearlyTzs: z.number().int().min(0).max(1_000_000_000),
  maxRouters: z.number().int().min(1).max(10000),
  maxLocations: z.number().int().min(1).max(10000),
  maxActiveCustomers: z.number().int().min(1).max(1_000_000),
  commissionBps: z.number().int().min(0).max(5000).default(0),
});
