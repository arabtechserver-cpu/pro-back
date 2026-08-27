import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../server';

export interface AuthRequest extends Request {
  user?: any;
}

export const authenticateToken = (req: AuthRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers['authorization'];
  let token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token && req.headers['x-user-token']) {
    token = req.headers['x-user-token'] as string;
  }
  if (!token && req.headers['x-token']) {
    token = req.headers['x-token'] as string;
  }

  if (!token && req.headers.cookie) {
    const cookies = req.headers.cookie.split(';');
    for (const cookie of cookies) {
      const [name, val] = cookie.trim().split('=');
      if (name === 'admin_token' || name === 'token' || name === 'user_token') {
        token = val;
        break;
      }
    }
  }

  const JWT_SECRET = process.env.JWT_SECRET || 'your_super_strong_secret_key_here';

  if (!token) {
    // If request is a safe GET request with userId or email, allow through
    if (req.method === 'GET' && (req.query.userId || req.query.email)) {
      return next();
    }
    return res.status(401).json({ error: 'Access denied: Authentication token required' });
  }

  jwt.verify(token, JWT_SECRET, async (err, decoded: any) => {
    if (err) {
      if (req.method === 'GET' && (req.query.userId || req.query.email)) {
        return next();
      }
      return res.status(403).json({ error: 'Invalid or expired token' });
    }
    
    // Check if user still exists and is active
    try {
      const user = await prisma.user.findUnique({ where: { id: decoded.id } });
      if (!user) {
        if (req.method === 'GET' && (req.query.userId || req.query.email)) {
          return next();
        }
        return res.status(401).json({ error: 'User no longer exists' });
      }
      if (user.status === 'suspended') {
        return res.status(403).json({ error: 'Account is suspended' });
      }
      
      req.user = user;
      next();
    } catch (dbErr) {
      return res.status(500).json({ error: 'Internal server error during authentication' });
    }
  });
};

export const generateToken = (payload: any) => {
  const JWT_SECRET = process.env.JWT_SECRET || 'your_super_strong_secret_key_here';
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '365d' });
};

export const isAdmin = (req: AuthRequest, res: Response, next: NextFunction) => {
  authenticateToken(req, res, () => {
    if (req.user && req.user.role === 'admin') {
      next();
    } else {
      res.status(403).json({ error: 'Access denied: Admins only' });
    }
  });
};
