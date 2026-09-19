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
    const deviceToken = (req.headers['x-device-token'] || req.headers['x-admin-device-token'] || (req as any).cookies?.['admin_device_token']) as string | undefined;
    const localIp = (req.headers['x-client-local-ip'] || req.headers['x-local-ip']) as string | undefined;
    const accessResult = await checkIpAccess(clientIp, deviceToken);

    if (accessResult.allowed) {
      return next();
    }

    const userAgent = typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : undefined;
    await logDashboardAccess({
      userId: req.user?.id,
      username: req.user?.username,
      ipAddress: clientIp,
      localIp,
      deviceToken,
      userAgent,
      status: 'blocked',
      reason: 'Unauthorized dashboard IP or device',
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
