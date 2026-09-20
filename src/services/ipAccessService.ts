import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { normalizeIp, isValidIp, areIpsEqual, isPrivateOrLocalIp } from '../utils/ipUtils';

export const MAX_ALLOWED_IPS = 2;
export const IP_RESTRICTION_SETTING_KEY = 'dashboard_ip_restriction_enabled';

interface CachedSettings {
  enabled: boolean;
  cachedAt: number;
}

let cachedRestrictionState: CachedSettings | null = null;
const CACHE_TTL_MS = 5000;

// Throttle lastAccessAt updates to avoid unnecessary write load
const lastAccessUpdateMap = new Map<string, number>();

export async function isIpRestrictionEnabled(): Promise<boolean> {
  const now = Date.now();
  if (cachedRestrictionState && (now - cachedRestrictionState.cachedAt) < CACHE_TTL_MS) {
    return cachedRestrictionState.enabled;
  }

  try {
    const setting = await prisma.setting.findUnique({
      where: { key: IP_RESTRICTION_SETTING_KEY }
    });

    const isEnabled = setting?.value === 'true' || setting?.value === '1';
    cachedRestrictionState = { enabled: isEnabled, cachedAt: now };
    return isEnabled;
  } catch (err) {
    console.error('[IP Access] Error reading IP restriction setting from DB:', err);
    // Fail-closed in production
    return process.env.NODE_ENV === 'production';
  }
}

export async function setIpRestrictionEnabled(enabled: boolean): Promise<void> {
  await prisma.setting.upsert({
    where: { key: IP_RESTRICTION_SETTING_KEY },
    create: { key: IP_RESTRICTION_SETTING_KEY, value: enabled ? 'true' : 'false' },
    update: { value: enabled ? 'true' : 'false' }
  });

  cachedRestrictionState = { enabled, cachedAt: Date.now() };
}

export async function getAllowedIps() {
  return prisma.allowedDashboardIP.findMany({
    orderBy: { createdAt: 'desc' }
  });
}

export const MAX_ALLOWED_DEVICES = 5;

export async function getAllowedDevices() {
  try {
    return await prisma.allowedDashboardDevice.findMany({
      orderBy: { createdAt: 'desc' }
    });
  } catch {
    return [];
  }
}

export async function checkIpAccess(
  clientIp: string,
  deviceToken?: string
): Promise<{
  allowed: boolean;
  matchedRecord?: any;
  matchedDevice?: any;
  allowedBy: 'none' | 'device' | 'ip';
  restrictionEnabled: boolean;
}> {
  const restrictionEnabled = await isIpRestrictionEnabled();
  if (!restrictionEnabled) {
    return { allowed: true, restrictionEnabled: false, allowedBy: 'none' };
  }

  // 1. Check if Device Token is authorized
  if (deviceToken && typeof deviceToken === 'string' && deviceToken.trim()) {
    try {
      const activeDevice = await prisma.allowedDashboardDevice.findFirst({
        where: { deviceToken: deviceToken.trim(), isActive: true }
      });

      if (activeDevice) {
        const lastUpdate = lastAccessUpdateMap.get(`dev_${activeDevice.id}`) || 0;
        const now = Date.now();
        if (now - lastUpdate > 60000) {
          lastAccessUpdateMap.set(`dev_${activeDevice.id}`, now);
          prisma.allowedDashboardDevice.update({
            where: { id: activeDevice.id },
            data: { lastAccessAt: new Date(), lastIp: normalizeIp(clientIp) }
          }).catch(() => {});
        }

        return {
          allowed: true,
          matchedDevice: activeDevice,
          allowedBy: 'device',
          restrictionEnabled: true
        };
      }
    } catch (_) {}
  }

  // 2. Check if Client IP is whitelisted
  const normalizedClient = normalizeIp(clientIp);
  const activeIps = await prisma.allowedDashboardIP.findMany({
    where: { isActive: true }
  });

  const matched = activeIps.find((record) =>
    areIpsEqual(record.ipAddress, normalizedClient)
  );

  if (matched) {
    // Throttled lastAccessAt update
    const lastUpdate = lastAccessUpdateMap.get(matched.id) || 0;
    const now = Date.now();
    if (now - lastUpdate > 60000) {
      lastAccessUpdateMap.set(matched.id, now);
      prisma.allowedDashboardIP.update({
        where: { id: matched.id },
        data: { lastAccessAt: new Date() }
      }).catch(() => {});
    }

    return { allowed: true, matchedRecord: matched, allowedBy: 'ip', restrictionEnabled: true };
  }

  return { allowed: false, restrictionEnabled: true, allowedBy: 'none' };
}

export async function addAllowedIp(params: {
  ipAddress: string;
  label?: string;
  createdBy?: string;
}) {
  const normalized = normalizeIp(params.ipAddress);
  if (!isValidIp(normalized)) {
    throw new Error('عنوان الـ IP غير صالح');
  }

  if (isPrivateOrLocalIp(normalized)) {
    throw new Error('عنوان الـ IP المدخل هو عنوان محلي داخلي للجهاز (مثل 192.168 أو 10.x). لا يمكن استخدامه لأن السيرفر لا يرى إلا عنوان الـ IP العام لشبكة الاتصال (Public IP).');
  }

  const currentCount = await prisma.allowedDashboardIP.count();
  if (currentCount >= MAX_ALLOWED_IPS) {
    throw new Error(`تم الوصول للحد الأقصى لعناوين الـ IP المسموحة (${MAX_ALLOWED_IPS} كحد أقصى)`);
  }

  const allRecords = await prisma.allowedDashboardIP.findMany();
  const duplicate = allRecords.some((item) => areIpsEqual(item.ipAddress, normalized));
  if (duplicate) {
    throw new Error('عنوان الـ IP هذا مسجل بالفعل');
  }

  const newRecord = await prisma.allowedDashboardIP.create({
    data: {
      ipAddress: normalized,
      label: params.label?.trim() || null,
      isActive: true,
      createdBy: params.createdBy || 'Super Admin'
    }
  });

  return newRecord;
}

export async function updateAllowedIp(
  id: string,
  params: { label?: string; isActive?: boolean },
  currentAdminIp?: string
) {
  const record = await prisma.allowedDashboardIP.findUnique({ where: { id } });
  if (!record) {
    throw new Error('لم يتم العثور على عنوان الـ IP المحدد');
  }

  // Lockout check on deactivation
  if (params.isActive === false) {
    const isEnabled = await isIpRestrictionEnabled();
    if (isEnabled && currentAdminIp && areIpsEqual(record.ipAddress, currentAdminIp)) {
      throw new Error('لا يمكن تعطيل عنوان IP الحالي الخاص بك أثناء تفعيل حماية الـ IP لتجنب قفل لوحة التحكم.');
    }
  }

  return prisma.allowedDashboardIP.update({
    where: { id },
    data: {
      label: params.label !== undefined ? (params.label?.trim() || null) : record.label,
      isActive: params.isActive !== undefined ? params.isActive : record.isActive
    }
  });
}

export async function deleteAllowedIp(id: string, currentAdminIp?: string) {
  const record = await prisma.allowedDashboardIP.findUnique({ where: { id } });
  if (!record) {
    throw new Error('لم يتم العثور على عنوان الـ IP المحدد');
  }

  const isEnabled = await isIpRestrictionEnabled();
  if (isEnabled && currentAdminIp && areIpsEqual(record.ipAddress, currentAdminIp)) {
    throw new Error('لا يمكن حذف عنوان IP الحالي الخاص بك أثناء تفعيل حماية الـ IP لتجنب قفل لوحة التحكم.');
  }

  return prisma.allowedDashboardIP.delete({ where: { id } });
}

export async function addAllowedDevice(params: {
  deviceToken: string;
  fingerprint?: string;
  label?: string;
  localIp?: string;
  lastIp?: string;
  createdBy?: string;
}) {
  if (!params.deviceToken || typeof params.deviceToken !== 'string') {
    throw new Error('رمز الجهاز (Device Token) مطلوب');
  }

  const existing = await prisma.allowedDashboardDevice.findUnique({
    where: { deviceToken: params.deviceToken.trim() }
  });

  if (existing) {
    return prisma.allowedDashboardDevice.update({
      where: { id: existing.id },
      data: {
        isActive: true,
        label: params.label?.trim() || existing.label,
        localIp: params.localIp?.trim() || existing.localIp,
        lastIp: params.lastIp ? normalizeIp(params.lastIp) : existing.lastIp,
        fingerprint: params.fingerprint || existing.fingerprint,
        lastAccessAt: new Date()
      }
    });
  }

  const currentCount = await prisma.allowedDashboardDevice.count();
  if (currentCount >= MAX_ALLOWED_DEVICES) {
    throw new Error(`تم الوصول للحد الأقصى للأجهزة المعتمدة (${MAX_ALLOWED_DEVICES} أجهزة كحد أقصى)`);
  }

  return prisma.allowedDashboardDevice.create({
    data: {
      deviceToken: params.deviceToken.trim(),
      label: params.label?.trim() || 'هاتف المشرف المعتمد',
      localIp: params.localIp?.trim() || null,
      lastIp: params.lastIp ? normalizeIp(params.lastIp) : null,
      fingerprint: params.fingerprint || null,
      createdBy: params.createdBy || 'Admin',
      isActive: true,
      lastAccessAt: new Date()
    }
  });
}

export async function updateAllowedDevice(id: string, data: { label?: string; isActive?: boolean }) {
  const device = await prisma.allowedDashboardDevice.findUnique({ where: { id } });
  if (!device) throw new Error('الجهاز غير موجود');

  return prisma.allowedDashboardDevice.update({
    where: { id },
    data: {
      ...(typeof data.label === 'string' ? { label: data.label.trim() } : {}),
      ...(typeof data.isActive === 'boolean' ? { isActive: data.isActive } : {})
    }
  });
}

export async function deleteAllowedDevice(id: string) {
  const device = await prisma.allowedDashboardDevice.findUnique({ where: { id } });
  if (!device) throw new Error('الجهاز غير موجود');

  return prisma.allowedDashboardDevice.delete({ where: { id } });
}

export async function logDashboardAccess(params: {
  userId?: string;
  username?: string;
  ipAddress: string;
  localIp?: string;
  deviceToken?: string;
  userAgent?: string;
  status: 'allowed' | 'blocked';
  reason?: string;
}): Promise<void> {
  try {
    await prisma.dashboardAccessLog.create({
      data: {
        userId: params.userId || null,
        username: params.username || null,
        ipAddress: normalizeIp(params.ipAddress),
        localIp: params.localIp ? normalizeIp(params.localIp) : null,
        deviceToken: params.deviceToken
          ? crypto.createHash('sha256').update(params.deviceToken.trim()).digest('hex').slice(0, 16) + '...'
          : null,
        userAgent: params.userAgent || null,
        status: params.status,
        reason: params.reason || null
      }
    });
  } catch (err) {
    // Non-blocking log failure
    console.error('Failed to log dashboard access:', err);
  }
}

export async function getDashboardIpStats() {
  const [
    allowedCount,
    devicesCount,
    successfulAccess,
    blockedAttempts,
    activeAdmins,
    isRestrictionEnabledState
  ] = await Promise.all([
    prisma.allowedDashboardIP.count(),
    prisma.allowedDashboardDevice.count().catch(() => 0),
    prisma.dashboardAccessLog.count({ where: { status: 'allowed' } }),
    prisma.dashboardAccessLog.count({ where: { status: 'blocked' } }),
    prisma.user.count({
      where: {
        status: 'active',
        role: { in: ['admin', 'super_admin'] }
      }
    }),
    isIpRestrictionEnabled()
  ]);

  return {
    allowedCount,
    maxLimit: MAX_ALLOWED_IPS,
    devicesCount,
    maxDevices: MAX_ALLOWED_DEVICES,
    successfulAccess,
    blockedAttempts,
    activeAdmins,
    isRestrictionEnabled: isRestrictionEnabledState
  };
}

export async function getAccessLogs(params: {
  page?: number;
  limit?: number;
  status?: string;
  search?: string;
}) {
  const page = Math.max(1, Number(params.page) || 1);
  const limit = Math.min(100, Math.max(5, Number(params.limit) || 20));
  const skip = (page - 1) * limit;

  const where: any = {};
  if (params.status && params.status !== 'all') {
    where.status = params.status;
  }

  if (params.search && params.search.trim()) {
    const searchStr = params.search.trim();
    where.OR = [
      { ipAddress: { contains: searchStr, mode: 'insensitive' } },
      { username: { contains: searchStr, mode: 'insensitive' } },
      { localIp: { contains: searchStr, mode: 'insensitive' } }
    ];
  }

  const [logs, total] = await Promise.all([
    prisma.dashboardAccessLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit
    }),
    prisma.dashboardAccessLog.count({ where })
  ]);

  return {
    logs,
    total,
    pages: Math.ceil(total / limit) || 1,
    page,
    limit
  };
}

export async function verifyAdminCanToggleProtection(
  currentAdminIp: string,
  enable: boolean,
  currentDeviceToken?: string
): Promise<{ ok: boolean; reason?: string }> {
  if (!enable) {
    return { ok: true };
  }

  if (currentDeviceToken) {
    const activeDevice = await prisma.allowedDashboardDevice.findFirst({
      where: { deviceToken: currentDeviceToken, isActive: true }
    }).catch(() => null);
    if (activeDevice) {
      return { ok: true };
    }
  }

  const [activeIps, activeDevices] = await Promise.all([
    prisma.allowedDashboardIP.findMany({ where: { isActive: true } }),
    prisma.allowedDashboardDevice.findMany({ where: { isActive: true } }).catch(() => [])
  ]);

  if (activeIps.length === 0 && activeDevices.length === 0) {
    return {
      ok: false,
      reason: 'لا يمكن تفعيل الحماية بدون وجود عنوان IP مسموح أو جهاز معتمد ونشط واحد على الأقل.'
    };
  }

  const normalizedAdmin = normalizeIp(currentAdminIp);
  const isCurrentIpPresent = activeIps.some((record) =>
    areIpsEqual(record.ipAddress, normalizedAdmin)
  );

  if (!isCurrentIpPresent && activeDevices.length === 0) {
    return {
      ok: false,
      reason: 'يجب إضافة وتفعيل عنوان الـ IP الحالي أو اعتماد هذا الجهاز أولاً قبل تفعيل حماية لوحة التحكم لتجنب قفل الحساب على نفسك.'
    };
  }

  return { ok: true };
}
