import { Request, Response, NextFunction } from 'express';

export function getAllowedOrigins(): string[] {
  const configured = [
    'https://arabtechproserver.tech', 'https://www.arabtechproserver.tech',
    'https://borai.store', 'https://www.borai.store',
    ...(process.env.FRONTEND_URL || '').split(','),
    ...(process.env.ADDITIONAL_ALLOWED_ORIGINS || '').split(',')
  ];
  if (process.env.NODE_ENV !== 'production') configured.push('http://localhost:3000', 'http://127.0.0.1:3000');
  return configured.map(origin => origin.trim()).filter(origin => {
    if (!origin) return false;
    try {
      const url = new URL(origin);
      return url.origin === origin && (process.env.NODE_ENV !== 'production' || url.protocol === 'https:');
    } catch { return false; }
  });
}

// CORS controls response reading, not whether a browser may submit a form.
// Reject untrusted browser writes before parsing bodies or changing any state.
export function browserWriteGuard(req: Request, res: Response, next: NextFunction) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if ((origin && !getAllowedOrigins().includes(origin)) || (!origin && req.headers['sec-fetch-site'] === 'cross-site')) {
    return res.status(403).json({ error: 'Untrusted request origin', code: 'UNTRUSTED_ORIGIN' });
  }
  // Browser cookie authentication must carry a verifiable origin. Non-browser
  // API consumers and signed payment webhooks have no session cookies.
  if (!origin && /(?:^|;\s*)(?:admin_token|user_token|token|session)=/.test(req.headers.cookie || '')) {
    return res.status(403).json({ error: 'Origin required for session requests', code: 'ORIGIN_REQUIRED' });
  }
  return next();
}
