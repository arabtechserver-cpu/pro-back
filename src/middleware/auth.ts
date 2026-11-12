import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from "../utils/prisma";
import { dashboardIpGuard } from './dashboardIpGuard';
import {
  isUserSessionIdleExpired,
  shouldTouchUserActivity
} from '../utils/userSessionPolicy';

export interface AuthRequest extends Request {
  user?: any;
}

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters');
}

function isExplicitAdminRequest(req: Request): boolean {
  const isClientUserRoute = Boolean(req.originalUrl && (
    req.originalUrl.includes('/users/profile') ||
    req.originalUrl.includes('/users/request-api') ||
    req.originalUrl.includes('/users/regenerate-api-key') ||
    req.originalUrl.includes('/users/balance') ||
    req.originalUrl.includes('/orders/my-orders') ||
    req.originalUrl.includes('/wallet')
  ));
  if (isClientUserRoute) return false;

  const referer = String(req.headers?.['referer'] || req.headers?.['referrer'] || '');
  const isFromAdminDashboard = referer.includes('/admin');

  return (
    isFromAdminDashboard ||
    req.headers?.['x-admin-request'] === 'true' ||
    Boolean(req.headers?.['x-admin-token']) ||
    req.query?.all === 'true' ||
    req.query?.all === '1' ||
    req.query?.admin === 'true' ||
    Boolean(req.originalUrl && (
      req.originalUrl.includes('all=true') ||
      req.originalUrl.includes('admin=true') ||
      req.originalUrl.includes('/analytics') ||
      req.originalUrl.includes('/admin') ||
      req.originalUrl.includes('telegram-admin') ||
      req.originalUrl.includes('/providers') ||
      req.originalUrl.includes('/settings') ||
      req.originalUrl.includes('/currencies') ||
      req.originalUrl.includes('/backup') ||
      (req.originalUrl.includes('/transactions') && (
        req.originalUrl.includes('limit=') ||
        req.originalUrl.includes('status=') ||
        req.originalUrl.includes('cursor=') ||
        req.originalUrl.includes('search=')
      ))
    ))
  );
}

function isStrictAdminOnlyContext(req: Request): boolean {
  const referer = String(req.headers?.['referer'] || req.headers?.['referrer'] || '');
  return (
    referer.includes('/admin') ||
    req.headers?.['x-admin-request'] === 'true' ||
    Boolean(req.headers?.['x-admin-token']) ||
    req.query?.all === 'true' ||
    req.query?.all === '1' ||
    req.query?.admin === 'true' ||
    Boolean(req.originalUrl && (
      req.originalUrl.includes('all=true') ||
      req.originalUrl.includes('admin=true')
    ))
  );
}

function extractCandidateTokens(req: Request): string[] {
  const tokens: string[] = [];

  const authHeader = req.headers?.['authorization'];
  let headerToken = '';
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    const rawVal = parts.length > 1 ? parts[1] : parts[0];
    const clean = rawVal ? rawVal.replace(/^["']|["']$/g, '').trim() : '';
    if (clean && clean !== 'null' && clean !== 'undefined' && clean !== 'false' && clean !== '[object' && clean !== 'Bearer') {
      headerToken = clean;
    }
  }

  let cookieAdminToken = '';
  let cookieUserToken = '';

  if (req.headers?.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const parts = cookie.trim().split('=');
      const name = parts[0]?.trim();
      const val = parts.slice(1).join('=').trim();
      if (name && val) {
        const clean = val.replace(/^["']|["']$/g, '').trim();
        if (clean && clean !== 'null' && clean !== 'undefined' && clean !== 'false') {
          if (name === 'admin_token') cookieAdminToken = clean;
          if (['user_token', 'token', 'session'].includes(name)) cookieUserToken = clean;
        }
      }
    }
  }

  const isExplicitAdminQuery = isExplicitAdminRequest(req);

  if (isExplicitAdminQuery && cookieAdminToken) {
    tokens.push(cookieAdminToken);
  }

  if (headerToken && !tokens.includes(headerToken)) {
    tokens.push(headerToken);
  }

  if (cookieUserToken && !tokens.includes(cookieUserToken)) {
    tokens.push(cookieUserToken);
  }

  if (cookieAdminToken && !tokens.includes(cookieAdminToken)) {
    tokens.push(cookieAdminToken);
  }

  return tokens;
}

function isPassiveActivityRequest(req: Request): boolean {
  return req.headers?.['x-passive-request'] === 'true' || req.headers?.['x-passive-poll'] === 'true';
}

function scheduleUserActivityTouch(
  user: { id?: string; role?: string; lastActivityAt?: Date | string | number | null },
  tokenIssuedAtSec: unknown,
  req: Request,
  nowMs: number
) {
  if (!user.id || typeof (prisma as any)?.user?.update !== 'function') return;
  if (!shouldTouchUserActivity(user.role, user.lastActivityAt, tokenIssuedAtSec, isPassiveActivityRequest(req), nowMs)) {
    return;
  }
  const nextActivity = new Date(nowMs);
  user.lastActivityAt = nextActivity;
  void Promise.resolve(
    prisma.user.update({
      where: { id: user.id },
      data: { lastActivityAt: nextActivity }
    })
  ).catch(() => {});
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const candidateTokens = extractCandidateTokens(req);
  const requireAdminRole = isStrictAdminOnlyContext(req);
  const nowMs = Date.now();
  let idleExpired = false;

  for (const token of candidateTokens) {
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded && (decoded.id || decoded.email)) {
        let user = null;
        try {
          if (decoded.id) {
            user = await prisma.user.findUnique({ where: { id: decoded.id } });
          } else if (decoded.email) {
            user = await prisma.user.findUnique({ where: { email: String(decoded.email).trim().toLowerCase() } });
          }
        } catch (error: any) {
          console.error('[Authentication] User lookup failed', { code: error?.code || 'UNKNOWN' });
          res.setHeader?.('Retry-After', '2');
          return res.status(503).json({ error: 'Authentication temporarily unavailable', code: 'AUTH_UNAVAILABLE' });
        }

        if (user) {
          if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Account is suspended' });
          }
          const expectedVersion = user.tokenVersion || 1;
          if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== expectedVersion) {
            continue;
          }
          if (requireAdminRole && !['admin', 'super_admin'].includes(user.role)) {
            continue;
          }
          if (isUserSessionIdleExpired(user.role, user.lastActivityAt, decoded.iat, nowMs)) {
            idleExpired = true;
            continue;
          }
          scheduleUserActivityTouch(user, decoded.iat, req, nowMs);
          req.user = user;
          res.setHeader?.('Cache-Control', 'private, no-store');
          return next();
        }
      }
    } catch (e) {
      // Continue to next candidate token
    }
  }

  if (idleExpired) {
    res.clearCookie?.('user_token', { path: '/' });
    return res.status(401).json({
      error: 'انتهت جلسة الدخول تلقائياً لعدم النشاط لمدة 30 دقيقة. يرجى تسجيل الدخول مجدداً.',
      code: 'SESSION_IDLE_EXPIRED'
    });
  }

  return res.status(401).json({ error: 'Access denied: Authentication token required or session expired', code: 'INVALID_SESSION' });
};

export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const candidateTokens = extractCandidateTokens(req);
  const nowMs = Date.now();

  for (const token of candidateTokens) {
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
      if (decoded && (decoded.id || decoded.email)) {
        let user = null;
        if (decoded.id) {
          user = await prisma.user.findUnique({ where: { id: decoded.id } });
        } else if (decoded.email) {
          user = await prisma.user.findUnique({ where: { email: String(decoded.email).trim().toLowerCase() } });
        }

        if (user) {
          if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Account is suspended' });
          }
          const expectedVersion = user.tokenVersion || 1;
          if (!Number.isInteger(decoded.tokenVersion) || decoded.tokenVersion !== expectedVersion) {
            continue;
          }
          if (isUserSessionIdleExpired(user.role, user.lastActivityAt, decoded.iat, nowMs)) {
            res.clearCookie?.('user_token', { path: '/' });
            continue;
          }
          scheduleUserActivityTouch(user, decoded.iat, req, nowMs);
          req.user = user;
          res.setHeader?.('Cache-Control', 'private, no-store');
          return next();
        }
      }
    } catch (e) {
      // Continue to next candidate token
    }
  }

  return next();
};

export const generateToken = (payload: any, customExpiresIn?: string | number) => {
  const defaultExpiry = (payload && typeof payload === 'object' && ['admin', 'super_admin'].includes(payload.role))
    ? '12h'
    : '7d';
  const expiresIn = customExpiresIn || defaultExpiry;
  const tokenPayload = (payload && typeof payload === 'object')
    ? { tokenVersion: 1, ...payload }
    : payload;
  return jwt.sign(tokenPayload, JWT_SECRET as jwt.Secret, { expiresIn } as jwt.SignOptions);
};

export const isAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  authenticateToken(req, res, async () => {
    if (req.user && ['admin', 'super_admin'].includes(req.user.role)) {
      return dashboardIpGuard(req, res, next);
    }

    // Fallback: If user has an active admin_token cookie, authenticate with admin privileges
    if (req.headers.cookie) {
      const cookies = req.headers.cookie.split(';');
      for (const cookie of cookies) {
        const parts = cookie.trim().split('=');
        if (parts[0]?.trim() === 'admin_token') {
          const val = parts.slice(1).join('=').trim().replace(/^["']|["']$/g, '');
          if (val) {
            try {
              const decoded: any = jwt.verify(val, JWT_SECRET, { algorithms: ['HS256'] });
              if (decoded && (decoded.id || decoded.email)) {
                const adminUser = decoded.id
                  ? await prisma.user.findUnique({ where: { id: decoded.id } })
                  : await prisma.user.findUnique({ where: { email: String(decoded.email).trim().toLowerCase() } });
                if (adminUser && ['admin', 'super_admin'].includes(adminUser.role) && adminUser.status !== 'suspended') {
                  const expectedVersion = adminUser.tokenVersion || 1;
                  if (!decoded.tokenVersion || decoded.tokenVersion === expectedVersion) {
                    req.user = adminUser;
                    return dashboardIpGuard(req, res, next);
                  }
                }
              }
            } catch (_) {}
          }
        }
      }
    }

    return res.status(403).json({ error: 'Access denied: Admins only' });
  });
};
