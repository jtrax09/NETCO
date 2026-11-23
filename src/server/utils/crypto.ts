import crypto from 'node:crypto';

let ephemeralKey: Buffer | null = null;

function getEncryptionKey(): Buffer {
  const configured = process.env.ROUTER_ENCRYPTION_KEY?.trim();
  if (configured && configured.length >= 16) {
    return crypto.createHash('sha256').update(configured).digest();
  }
  if (!ephemeralKey) {
    // Deterministic per-process fallback only when ROUTER_ENCRYPTION_KEY is not configured in dev
    ephemeralKey = crypto.createHash('sha256').update(process.env.APP_URL || 'netco-dev-fallback-key').digest();
  }
  return ephemeralKey;
}

export function generateId(prefix = ''): string {
  const raw = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  return prefix ? `${prefix}_${raw}` : raw;
}

export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt:${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') {
    return false;
  }
  const [, salt, hexDigest] = parts;
  const derived = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(hexDigest, 'hex');
  if (derived.length !== expected.length) {
    return false;
  }
  return crypto.timingSafeEqual(derived, expected);
}

export function encryptSecret(plaintext: string): string {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptSecret(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted secret format');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const key = getEncryptionKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}

const VOUCHER_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export function generateVoucherCode(): string {
  const bytes = crypto.randomBytes(8);
  let chars = '';
  for (let i = 0; i < 8; i++) {
    chars += VOUCHER_ALPHABET[bytes[i] % VOUCHER_ALPHABET.length];
  }
  return `NTC-${chars.slice(0, 4)}-${chars.slice(4, 8)}`;
}

export function normalizeVoucherCode(code: string): string {
  return code.trim().toUpperCase().replace(/\s+/g, '');
}

export function maskVoucherCode(code: string): string {
  const norm = normalizeVoucherCode(code);
  if (norm.length <= 8) return `${norm.slice(0, 4)}****`;
  return `${norm.slice(0, 8)}-****`;
}

export function generateReference(prefix: string): string {
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  const ts = Date.now().toString(36).toUpperCase();
  return `${prefix}-${ts}-${rand}`;
}

export function generateSessionToken(): string {
  return crypto.randomBytes(32).toString('hex');
}
