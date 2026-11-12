function parsePositiveMs(raw: string | undefined, fallbackMs: number): number {
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? num : fallbackMs;
}

export const USER_IDLE_TIMEOUT_MS = parsePositiveMs(process.env.USER_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
export const ACTIVITY_TOUCH_THROTTLE_MS = 60 * 1000;

export function isAdminRole(role?: string | null): boolean {
  return role === 'admin' || role === 'super_admin';
}

export function resolveEffectiveLastActivityMs(
  lastActivityAt: Date | string | number | null | undefined,
  tokenIssuedAtSec: unknown
): number | null {
  if (lastActivityAt instanceof Date) {
    const ms = lastActivityAt.getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  } else if (typeof lastActivityAt === 'string' || typeof lastActivityAt === 'number') {
    const ms = new Date(lastActivityAt).getTime();
    if (Number.isFinite(ms) && ms > 0) return ms;
  }

  const iatSec = Number(tokenIssuedAtSec);
  if (Number.isFinite(iatSec) && iatSec > 0) {
    return iatSec * 1000;
  }

  return null;
}

export function isUserSessionIdleExpired(
  role: string | null | undefined,
  lastActivityAt: Date | string | number | null | undefined,
  tokenIssuedAtSec: unknown,
  nowMs = Date.now(),
  idleTimeoutMs = USER_IDLE_TIMEOUT_MS
): boolean {
  if (isAdminRole(role)) return false;
  const effectiveMs = resolveEffectiveLastActivityMs(lastActivityAt, tokenIssuedAtSec);
  if (effectiveMs === null) return false;
  return nowMs - effectiveMs >= idleTimeoutMs;
}

export function shouldTouchUserActivity(
  role: string | null | undefined,
  lastActivityAt: Date | string | number | null | undefined,
  tokenIssuedAtSec: unknown,
  isPassiveRequest: boolean,
  nowMs = Date.now(),
  throttleMs = ACTIVITY_TOUCH_THROTTLE_MS
): boolean {
  if (isAdminRole(role) || isPassiveRequest) return false;
  const effectiveMs = resolveEffectiveLastActivityMs(lastActivityAt, tokenIssuedAtSec);
  if (effectiveMs === null) return true;
  return nowMs - effectiveMs >= throttleMs;
}
