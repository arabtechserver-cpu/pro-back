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

  // 1. Authorization header: Bearer <token>
  const authHeader = req.headers['authorization'];
  if (authHeader && typeof authHeader === 'string') {
    const parts = authHeader.split(' ');
    const rawVal = parts.length > 1 ? parts[1] : parts[0];
    const clean = rawVal ? rawVal.replace(/^["']|["']$/g, '').trim() : '';
    if (clean && clean !== 'null' && clean !== 'undefined' && clean !== 'false' && clean !== '[object' && clean !== 'Bearer') {
      tokens.push(clean);
    }
  }

  // 2. Cookies
  if (req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const parts = cookie.trim().split('=');
      const name = parts[0]?.trim();
      const val = parts.slice(1).join('=').trim();
      if (name && val) {
        if (['admin_token', 'user_token', 'token', 'session'].includes(name)) {
          const clean = val.replace(/^["']|["']$/g, '').trim();
          if (clean && clean !== 'null' && clean !== 'undefined' && clean !== 'false' && !tokens.includes(clean)) {
            if (name === 'admin_token') {
              tokens.unshift(clean);
            } else {
              tokens.push(clean);
            }
          }
        }
      }
    }
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
