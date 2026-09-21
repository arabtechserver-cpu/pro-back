import { Request, Response, NextFunction } from 'express';

/** Private receipt files must never reach any public static-file handler. */
export function publicFileGuard(req: Request, res: Response, next: NextFunction) {
  let pathname: string;
  try {
    // Express static decodes once too. Reject residual escapes so another proxy
    // or handler cannot reinterpret a double-encoded private path later.
    pathname = decodeURIComponent(req.path).replace(/\\/g, '/').toLowerCase();
  } catch {
    return res.status(400).json({ error: 'Invalid file path' });
  }

  if (pathname.includes('%') || pathname.includes('\0')) {
    return res.status(400).json({ error: 'Invalid file path' });
  }
  if (pathname.split('/').some(segment => segment.includes('receipt'))) {
    res.setHeader('Cache-Control', 'private, no-store');
    return res.status(403).json({ error: 'Receipts require authenticated transaction access' });
  }
  return next();
}
