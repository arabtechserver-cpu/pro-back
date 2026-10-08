import crypto from 'crypto';

const processSecret = crypto.randomBytes(32);

export function digestOtp(context: string, code: string): string {
  return crypto.createHmac('sha256', processSecret).update(context).update('\0').update(code).digest('hex');
}

export function matchesOtp(context: string, input: unknown, digest: string): boolean {
  const code = typeof input === 'string' ? input.trim() : '';
  if (!/^\d{6}$/.test(code)) return false;
  return crypto.timingSafeEqual(Buffer.from(digestOtp(context, code), 'hex'), Buffer.from(digest, 'hex'));
}
