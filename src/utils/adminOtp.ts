import crypto from 'crypto';

interface OtpChallenge {
  userId: string;
  username: string;
  email: string;
  code: string;
  attempts: number;
  expiresAt: number;
  lastSentAt: number;
}

const challengeStore = new Map<string, OtpChallenge>();

const EXPIRATION_TIME_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;

setInterval(() => {
  const now = Date.now();
  for (const [token, challenge] of challengeStore.entries()) {
    if (now > challenge.expiresAt) {
      challengeStore.delete(token);
    }
  }
}, 60 * 1000);

export function createAdminOtpChallenge(user: { id: string; username: string; email: string }): { challengeToken: string; code: string } {
  const challengeToken = crypto.randomBytes(32).toString('hex');
  const code = crypto.randomInt(100000, 1000000).toString();
  const now = Date.now();

  challengeStore.set(challengeToken, {
    userId: user.id,
    username: user.username,
    email: user.email,
    code,
    attempts: 0,
    expiresAt: now + EXPIRATION_TIME_MS,
    lastSentAt: now
  });

  return { challengeToken, code };
}

export function verifyAdminOtp(
  challengeToken: string,
  inputCode: string
): { success: boolean; error?: string; user?: { id: string; username: string; email: string } } {
  const challenge = challengeStore.get(challengeToken);
  const now = Date.now();

  if (!challenge) {
    return { success: false, error: 'انتهت صلاحية جلسة التحقق، يرجى إعادة تسجيل الدخول' };
  }

  if (now > challenge.expiresAt) {
    challengeStore.delete(challengeToken);
    return { success: false, error: 'انتهت صلاحية الرمز، يرجى طلب كود جديد' };
  }

  if (challenge.attempts >= MAX_ATTEMPTS) {
    challengeStore.delete(challengeToken);
    return { success: false, error: 'تجاوزت الحد الأقصى للمحاولات الخاطئة، يرجى تسجيل الدخول مجدداً' };
  }

  const cleanInput = String(inputCode || '').trim();
  if (cleanInput !== challenge.code) {
    challenge.attempts += 1;
    const remaining = MAX_ATTEMPTS - challenge.attempts;
    if (remaining <= 0) {
      challengeStore.delete(challengeToken);
      return { success: false, error: 'تم تجاوز الحد الأقصى للمحاولات، تم إلغاء جلسة التحقق' };
    }
    return { success: false, error: `رمز التحقق غير صحيح، المحاولات المتبقية: ${remaining}` };
  }

  challengeStore.delete(challengeToken);
  return {
    success: true,
    user: {
      id: challenge.userId,
      username: challenge.username,
      email: challenge.email
    }
  };
}

export function resendAdminOtp(
  challengeToken: string
): { success: boolean; error?: string; code?: string; user?: { id: string; username: string; email: string } } {
  const challenge = challengeStore.get(challengeToken);
  const now = Date.now();

  if (!challenge || now > challenge.expiresAt) {
    if (challenge) challengeStore.delete(challengeToken);
    return { success: false, error: 'انتهت صلاحية جلسة التحقق، يرجى تسجيل الدخول مجدداً' };
  }

  const timeSinceLastSent = now - challenge.lastSentAt;
  if (timeSinceLastSent < RESEND_COOLDOWN_MS) {
    const remainingSeconds = Math.ceil((RESEND_COOLDOWN_MS - timeSinceLastSent) / 1000);
    return { success: false, error: `يرجى الانتظار ${remainingSeconds} ثانية قبل إعادة طلب الكود` };
  }

  const newCode = crypto.randomInt(100000, 1000000).toString();
  challenge.code = newCode;
  challenge.attempts = 0;
  challenge.expiresAt = now + EXPIRATION_TIME_MS;
  challenge.lastSentAt = now;

  return {
    success: true,
    code: newCode,
    user: {
      id: challenge.userId,
      username: challenge.username,
      email: challenge.email
    }
  };
}
