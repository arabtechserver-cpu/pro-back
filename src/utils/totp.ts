import crypto from 'crypto';
import QRCode from 'qrcode';

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_STEP_SECONDS = 30;
const TOTP_DIGITS = 6;
const SETUP_TTL_MS = 10 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGE_ATTEMPTS = 5;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const clean = String(input || '').trim().toUpperCase().replace(/=+$/g, '').replace(/[\s-]+/g, '');
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (let i = 0; i < clean.length; i++) {
    const idx = BASE32_ALPHABET.indexOf(clean[i]);
    if (idx === -1) {
      throw new Error('Invalid Base32 character in TOTP secret');
    }
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(byteLength = 20): string {
  return base32Encode(crypto.randomBytes(byteLength));
}

export function generateTotpCode(secret: string, timestampMs = Date.now(), stepOffset = 0): string {
  const key = base32Decode(secret);
  const counter = Math.floor(timestampMs / 1000 / TOTP_STEP_SECONDS) + stepOffset;
  const counterBuf = Buffer.alloc(8);
  counterBuf.writeBigUInt64BE(BigInt(counter));

  const hmac = crypto.createHmac('sha1', key).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);

  const otp = binary % 10 ** TOTP_DIGITS;
  return String(otp).padStart(TOTP_DIGITS, '0');
}

export function verifyTotpCode(secret: string, inputCode: string, timestampMs = Date.now()): boolean {
  const clean = String(inputCode || '').trim().replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;

  for (const offset of [-1, 0, 1]) {
    const expected = generateTotpCode(secret, timestampMs, offset);
    if (crypto.timingSafeEqual(Buffer.from(clean, 'utf8'), Buffer.from(expected, 'utf8'))) {
      return true;
    }
  }
  return false;
}

export function buildOtpAuthUri(accountName: string, secret: string, issuer = 'Arab Tech Pro Server'): string {
  const cleanAccount = String(accountName || 'user').trim();
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(cleanAccount)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS)
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

export async function generateOtpAuthQrSvg(otpauthUrl: string): Promise<string> {
  return QRCode.toString(otpauthUrl, {
    type: 'svg',
    margin: 2,
    width: 220,
    color: {
      dark: '#0f172a',
      light: '#ffffff'
    }
  });
}

function getTotpEncryptionKey(): Buffer {
  const rawSecret = (process.env.JWT_SECRET || 'arab-tech-totp-fallback-secret').trim();
  return crypto.createHash('sha256').update(`totp-key:${rawSecret}`).digest();
}

export function encryptTotpSecret(plainSecret: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getTotpEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plainSecret, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

export function decryptTotpSecret(encryptedPayload: string): string {
  const parts = String(encryptedPayload || '').split(':');
  if (parts.length !== 3) {
    throw new Error('Malformed encrypted TOTP secret');
  }
  const [ivHex, tagHex, dataHex] = parts;
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    getTotpEncryptionKey(),
    Buffer.from(ivHex, 'hex')
  );
  decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(dataHex, 'hex')),
    decipher.final()
  ]);
  return decrypted.toString('utf8');
}

function normalizeBackupCode(code: string): string {
  return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function digestBackupCode(userId: string, cleanCode: string): string {
  const key = crypto.createHash('sha256').update(`2fa-backup-hmac:${(process.env.JWT_SECRET || 'arab-tech-totp-fallback-secret').trim()}`).digest();
  return crypto.createHmac('sha256', key).update(userId).update('\0').update(cleanCode).digest('hex');
}

export function generateBackupCodes(userId: string, count = 8): { plainCodes: string[]; hashesJson: string } {
  const plainCodes: string[] = [];
  const hashes: string[] = [];

  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(4).toString('hex').toUpperCase();
    const formatted = `${raw.slice(0, 4)}-${raw.slice(4, 8)}`;
    plainCodes.push(formatted);
    hashes.push(digestBackupCode(userId, raw));
  }

  return { plainCodes, hashesJson: JSON.stringify(hashes) };
}

export function countRemainingBackupCodes(hashesJson: string | null | undefined): number {
  if (!hashesJson) return 0;
  try {
    const parsed = JSON.parse(hashesJson);
    return Array.isArray(parsed) ? parsed.filter((h) => typeof h === 'string' && h.length > 0).length : 0;
  } catch {
    return 0;
  }
}

export function consumeBackupCode(
  userId: string,
  hashesJson: string | null | undefined,
  inputCode: string
): { matched: boolean; remainingHashesJson: string; remainingCount: number } {
  const clean = normalizeBackupCode(inputCode);
  let hashes: string[] = [];
  try {
    const parsed = JSON.parse(hashesJson || '[]');
    if (Array.isArray(parsed)) hashes = parsed.filter((h) => typeof h === 'string' && h.length > 0);
  } catch {
    hashes = [];
  }

  if (!clean || hashes.length === 0) {
    return { matched: false, remainingHashesJson: JSON.stringify(hashes), remainingCount: hashes.length };
  }

  const candidateHex = digestBackupCode(userId, clean);
  const candidateBuf = Buffer.from(candidateHex, 'hex');
  const matchIdx = hashes.findIndex((digest) => {
    try {
      const digestBuf = Buffer.from(digest, 'hex');
      return digestBuf.length === candidateBuf.length && crypto.timingSafeEqual(candidateBuf, digestBuf);
    } catch {
      return false;
    }
  });
  if (matchIdx === -1) {
    return { matched: false, remainingHashesJson: JSON.stringify(hashes), remainingCount: hashes.length };
  }

  const next = hashes.filter((_, idx) => idx !== matchIdx);
  return {
    matched: true,
    remainingHashesJson: JSON.stringify(next),
    remainingCount: next.length
  };
}

interface PendingSetupRecord {
  secret: string;
  expiresAt: number;
}

interface User2faChallengeRecord {
  userId: string;
  email: string;
  attempts: number;
  expiresAt: number;
}

const pendingSetupStore = new Map<string, PendingSetupRecord>();
const challengeStore = new Map<string, User2faChallengeRecord>();

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of pendingSetupStore.entries()) {
    if (v.expiresAt <= now) pendingSetupStore.delete(k);
  }
  for (const [k, v] of challengeStore.entries()) {
    if (v.expiresAt <= now) challengeStore.delete(k);
  }
}, 60 * 1000).unref();

export function createPending2faSetup(userId: string, secret: string): void {
  const now = Date.now();
  for (const [k, v] of pendingSetupStore.entries()) {
    if (v.expiresAt <= now) pendingSetupStore.delete(k);
  }
  if (!pendingSetupStore.has(userId) && pendingSetupStore.size >= 1000) {
    const firstKey = pendingSetupStore.keys().next().value;
    if (firstKey) pendingSetupStore.delete(firstKey);
  }
  pendingSetupStore.set(userId, { secret, expiresAt: now + SETUP_TTL_MS });
}

export function getPending2faSetup(userId: string): string | null {
  const rec = pendingSetupStore.get(userId);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt) {
    pendingSetupStore.delete(userId);
    return null;
  }
  return rec.secret;
}

export function clearPending2faSetup(userId: string): void {
  pendingSetupStore.delete(userId);
}

export function createUser2faChallenge(user: { id: string; email: string }): string {
  const now = Date.now();
  for (const [k, v] of challengeStore.entries()) {
    if (v.expiresAt <= now) challengeStore.delete(k);
  }
  if (challengeStore.size >= 2000) {
    const firstKey = challengeStore.keys().next().value;
    if (firstKey) challengeStore.delete(firstKey);
  }
  const token = crypto.randomBytes(24).toString('hex');
  challengeStore.set(token, {
    userId: user.id,
    email: user.email,
    attempts: 0,
    expiresAt: now + CHALLENGE_TTL_MS
  });
  return token;
}

export function getUser2faChallenge(token: string): { userId: string; email: string } | null {
  const rec = challengeStore.get(token);
  if (!rec) return null;
  if (Date.now() > rec.expiresAt || rec.attempts >= MAX_CHALLENGE_ATTEMPTS) {
    challengeStore.delete(token);
    return null;
  }
  return { userId: rec.userId, email: rec.email };
}

export function recordUser2faFailure(token: string): { locked: boolean; remainingAttempts: number } {
  const rec = challengeStore.get(token);
  if (!rec) return { locked: true, remainingAttempts: 0 };
  rec.attempts += 1;
  const remaining = Math.max(0, MAX_CHALLENGE_ATTEMPTS - rec.attempts);
  if (remaining <= 0) {
    challengeStore.delete(token);
    return { locked: true, remainingAttempts: 0 };
  }
  return { locked: false, remainingAttempts: remaining };
}

export function consumeUser2faChallenge(token: string): void {
  challengeStore.delete(token);
}
