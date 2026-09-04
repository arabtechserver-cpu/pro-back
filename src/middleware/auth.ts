import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from "../utils/prisma";

export interface AuthRequest extends Request {
  user?: any;
}

const JWT_SECRET = process.env.JWT_SECRET;

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 characters');
}

function extractCandidateTokens(req: Request): string[] {
  const tokens: string[] = [];

  const authHeader = req.headers['authorization'];
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

  if (req.headers.cookie) {
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

  // If request explicitly asks for all orders or admin operations, prioritize admin_token cookie!
  const isExplicitAdminQuery = req.query.all === 'true' || req.query.all === '1' || (req.originalUrl && req.originalUrl.includes('all=true'));

  if (isExplicitAdminQuery && cookieAdminToken) {
    tokens.push(cookieAdminToken);
  }

  if (headerToken && !tokens.includes(headerToken)) {
    tokens.push(headerToken);
  }

  if (cookieAdminToken && !tokens.includes(cookieAdminToken)) {
    tokens.push(cookieAdminToken);
  }

  if (cookieUserToken && !tokens.includes(cookieUserToken)) {
    tokens.push(cookieUserToken);
  }

  return tokens;
}

export const authenticateToken = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const candidateTokens = extractCandidateTokens(req);

  for (const token of candidateTokens) {
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET);
      if (decoded && (decoded.id || decoded.email)) {
        let user = null;
        if (decoded.id) {
          user = await prisma.user.findUnique({ where: { id: decoded.id } });
        }
        if (!user && decoded.email) {
          user = await prisma.user.findUnique({ where: { email: String(decoded.email).trim().toLowerCase() } });
        }

        if (user) {
          if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Account is suspended' });
          }
          req.user = user;
          return next();
        }
      }
    } catch (e) {
      // Continue to next candidate token
    }
  }

  return res.status(401).json({ error: 'Access denied: Authentication token required' });
};

export const optionalAuth = async (req: AuthRequest, res: Response, next: NextFunction) => {
  const candidateTokens = extractCandidateTokens(req);

  for (const token of candidateTokens) {
    try {
      const decoded: any = jwt.verify(token, JWT_SECRET);
      if (decoded && (decoded.id || decoded.email)) {
        let user = null;
        if (decoded.id) {
          user = await prisma.user.findUnique({ where: { id: decoded.id } });
        }
        if (!user && decoded.email) {
          user = await prisma.user.findUnique({ where: { email: String(decoded.email).trim().toLowerCase() } });
        }

        if (user) {
          if (user.status === 'suspended') {
            return res.status(403).json({ error: 'Account is suspended' });
          }
          req.user = user;
          return next();
        }
      }
    } catch (e) {
      // Continue to next candidate token
    }
  }

  // If token is missing/expired, proceed anyway so endpoint can inspect userId/email
  return next();
};

export const generateToken = (payload: any) => {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '30d' });
};

export const isAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  authenticateToken(req, res, () => {
    if (req.user && ['admin', 'super_admin'].includes(req.user.role)) {
      return next();
    }
    return res.status(403).json({ error: 'Access denied: Admins only' });
  });
};
