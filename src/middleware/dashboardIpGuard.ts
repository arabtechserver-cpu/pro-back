import { Response, NextFunction } from 'express';
import { AuthRequest } from './auth';
import { extractClientIp } from '../utils/ipUtils';
import { checkIpAccess, logDashboardAccess } from '../services/ipAccessService';

export async function dashboardIpGuard(
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const clientIp = extractClientIp(req);
    const accessResult = await checkIpAccess(clientIp);

    if (accessResult.allowed) {
      return next();
    }

    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    await logDashboardAccess({
      userId: req.user?.id,
      username: req.user?.username,
      ipAddress: clientIp,
      userAgent,
      status: 'blocked',
      reason: 'Unauthorized dashboard IP',
    });

    res.status(403).json({
      success: false,
      code: 'IP_NOT_ALLOWED',
      error: 'Access to the dashboard is not allowed from this network.',
      clientIp,
      currentIp: clientIp,
    });
  } catch (error) {
    console.error('Error in dashboardIpGuard:', error);
    res.status(500).json({
      success: false,
      error: 'Internal authorization error while checking IP access.',
    });
  }
}
