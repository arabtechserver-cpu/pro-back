import crypto from 'crypto';
import { digestOtp, matchesOtp } from './otp-security';

interface RecoveryChallenge {
  adminId: string;
  adminUsername: string;
  adminEmail: string;
  codeDigest: string;
  attempts: number;
  expiresAt: number;
}

const recoveryChallenges = new Map<string, RecoveryChallenge>();
const ipAttempts = new Map<string, { count: number; lockedUntil: number }>();

const RECOVERY_SALT = process.env.ADMIN_RECOVERY_SALT || 'arad_admin_master_recovery_secure_salt_2026';
// Pre-computed HMAC-SHA256 for the master recovery PIN with RECOVERY_SALT
const DEFAULT_PIN_HASH = '83094b3acea883fae9b0222fd4c19e5e287a4746cef7dad951c3f0603d93ffc8';

setInterval(() => {
  const now = Date.now();
  for (const [token, ch] of recoveryChallenges.entries()) {
    if (now > ch.expiresAt) recoveryChallenges.delete(token);
  }
  for (const [ip, data] of ipAttempts.entries()) {
    if (now > data.lockedUntil && data.count >= 5) ipAttempts.delete(ip);
  }
}, 60 * 1000).unref();

export function verifyMasterRecoveryPin(inputPin: string, clientIp: string): { valid: boolean; error?: string } {
  const now = Date.now();
  const ipData = ipAttempts.get(clientIp) || { count: 0, lockedUntil: 0 };

  if (now < ipData.lockedUntil) {
    const remainingMins = Math.ceil((ipData.lockedUntil - now) / 60000);
    return {
      valid: false,
      error: `تم حظر المحاولات مؤقتاً لتجاوز الحد المسموح. يرجى المحاولة بعد ${remainingMins} دقيقة.`
    };
  }

  const cleanPin = String(inputPin || '').trim();
  if (!cleanPin) {
    return { valid: false, error: 'يرجى إدخال رمز الأمان السري' };
  }

  const inputHash = crypto.createHmac('sha256', RECOVERY_SALT).update(cleanPin).digest('hex');
  const targetHash = (process.env.ADMIN_RECOVERY_PIN_HASH || DEFAULT_PIN_HASH).toLowerCase();

  const isMatch =
    inputHash.length === targetHash.length &&
    crypto.timingSafeEqual(Buffer.from(inputHash, 'utf8'), Buffer.from(targetHash, 'utf8'));

  if (!isMatch) {
    ipData.count += 1;
    if (ipData.count >= 5) {
      ipData.lockedUntil = now + 15 * 60 * 1000;
      ipAttempts.set(clientIp, ipData);
      return {
        valid: false,
        error: 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. تم قفل المحاولات لمدة 15 دقيقة.'
      };
    }
    ipAttempts.set(clientIp, ipData);
    const remaining = 5 - ipData.count;
    return {
      valid: false,
      error: `رمز الأمان السري غير صحيح. المحاولات المتبقية: ${remaining}`
    };
  }

  ipAttempts.delete(clientIp);
  return { valid: true };
}

export function createRecoveryChallenge(admin: { id: string; username: string; email: string }): { challengeToken: string; code: string } {
  for (const [token, ch] of recoveryChallenges.entries()) {
    if (ch.adminId === admin.id) recoveryChallenges.delete(token);
  }

  const challengeToken = crypto.randomBytes(32).toString('hex');
  const code = crypto.randomInt(100000, 1000000).toString();
  const now = Date.now();

  recoveryChallenges.set(challengeToken, {
    adminId: admin.id,
    adminUsername: admin.username,
    adminEmail: admin.email,
    codeDigest: digestOtp(challengeToken, code),
    attempts: 0,
    expiresAt: now + 5 * 60 * 1000
  });

  return { challengeToken, code };
}

export function verifyRecoveryOtp(
  challengeToken: string,
  inputCode: string
): { success: boolean; error?: string; admin?: { id: string; username: string; email: string } } {
  const challenge = recoveryChallenges.get(challengeToken);
  const now = Date.now();

  if (!challenge) {
    return { success: false, error: 'انتهت صلاحية جلسة الاستعادة، يرجى البدء من جديد' };
  }

  if (now > challenge.expiresAt) {
    recoveryChallenges.delete(challengeToken);
    return { success: false, error: 'انتهت صلاحية الرمز، يرجى طلب رمز جديد' };
  }

  if (challenge.attempts >= 5) {
    recoveryChallenges.delete(challengeToken);
    return { success: false, error: 'تم تجاوز الحد الأقصى للمحاولات الخاطئة للرمز' };
  }

  const cleanCode = String(inputCode || '').trim();
  if (!matchesOtp(challengeToken, cleanCode, challenge.codeDigest)) {
    challenge.attempts += 1;
    const remaining = 5 - challenge.attempts;
    if (remaining <= 0) {
      recoveryChallenges.delete(challengeToken);
      return { success: false, error: 'تم تجاوز الحد الأقصى للمحاولات، تم إلغاء جلسة الاستعادة' };
    }
    return { success: false, error: `رمز التحقق غير صحيح، المحاولات المتبقية: ${remaining}` };
  }

  return {
    success: true,
    admin: {
      id: challenge.adminId,
      username: challenge.adminUsername,
      email: challenge.adminEmail
    }
  };
}

export function consumeRecoveryChallenge(challengeToken: string): void {
  recoveryChallenges.delete(challengeToken);
}
