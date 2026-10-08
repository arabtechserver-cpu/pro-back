import { Request, Response, NextFunction } from 'express';
import { RequestScheduler } from '../utils/request-scheduler';

export function createResourceGuard(maxActive = 16, maxHeavy = 2, queueCapacity = 128, waitMs = 22000) {
  const scheduler = new RequestScheduler(maxActive, maxHeavy, queueCapacity, waitMs);
  return async (req: Request, res: Response, next: NextFunction) => {
    if (req.path === '/api/health') return next();
    const heavy = !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (
      /^\/api\/(upload|transactions|backup|providers|api-providers)(\/|$)/.test(req.path) ||
      Number(req.headers?.['content-length']) > 1024 * 1024 || Boolean(req.headers?.['transfer-encoding'])
    );
    const controller = new AbortController();
    const abort = () => controller.abort();
    req.once('aborted', abort); res.once('close', abort);
    let release: () => void;
    try { release = await scheduler.acquire(heavy, controller.signal); }
    catch (error: any) {
      req.removeListener('aborted', abort); res.removeListener('close', abort);
      if (res.destroyed || controller.signal.aborted) return;
      res.setHeader('Retry-After', '2');
      return res.status(error?.code === 'QUEUE_TIMEOUT' ? 504 : 503).json({ error: 'Request queue is busy. Please retry shortly.', code: error?.code || 'SERVER_BUSY' });
    }
    req.removeListener('aborted', abort); res.removeListener('close', abort);
    if (res.destroyed) { release(); return; }
    res.once('finish', release);
    res.once('close', () => { if (res.writableFinished || !req.complete) release(); });
    const originalEnd = res.end;
    res.end = function (...args: any[]) {
      try { return (originalEnd as any).apply(res, args); }
      finally { if (res.destroyed) release(); }
    } as typeof res.end;
    next();
  };
}
