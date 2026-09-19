import { Router } from 'express';
import { isAdmin, AuthRequest } from '../middleware/auth';
import { extractClientIp, normalizeIp, isValidIp, areIpsEqual } from '../utils/ipUtils';
import {
  MAX_ALLOWED_IPS,
  isIpRestrictionEnabled,
  setIpRestrictionEnabled,
  getAllowedIps,
  addAllowedIp,
  updateAllowedIp,
  deleteAllowedIp,
  getDashboardIpStats,
  getAccessLogs,
  verifyAdminCanToggleProtection
} from '../services/ipAccessService';

const router = Router();

// All IP management endpoints require admin/super_admin privileges
router.use(isAdmin);

// GET /status - Retrieve restriction status and current client IP
router.get('/status', async (req: AuthRequest, res) => {
  try {
    const currentIp = extractClientIp(req);
    const [isRestrictionEnabledState, allowedIps] = await Promise.all([
      isIpRestrictionEnabled(),
      getAllowedIps()
    ]);

    const activeAllowedIps = allowedIps.filter((item) => item.isActive);
    const isCurrentIpAllowed = activeAllowedIps.some((item) =>
      areIpsEqual(item.ipAddress, currentIp)
    );

    return res.json({
      success: true,
      enabled: isRestrictionEnabledState,
      isRestrictionEnabled: isRestrictionEnabledState,
      currentIp,
      isCurrentIpAllowed,
      allowedIpsCount: allowedIps.length,
      allowedCount: allowedIps.length,
      maxAllowedIps: MAX_ALLOWED_IPS,
      maxAllowed: MAX_ALLOWED_IPS,
      canAddMore: allowedIps.length < MAX_ALLOWED_IPS
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'خطأ في جلب حالة حماية الـ IP' });
  }
});

// GET /my-ip & /current-ip - Returns detected client IP and allowed status
const getMyIpHandler = async (req: AuthRequest, res: any) => {
  try {
    const clientIp = extractClientIp(req);
    const allowedIps = await getAllowedIps();
    const matched = allowedIps.find((item) => areIpsEqual(item.ipAddress, clientIp));

    return res.json({
      success: true,
      ip: clientIp,
      currentIp: clientIp,
      isAllowed: Boolean(matched && matched.isActive),
      label: matched?.label || null,
      isActive: matched?.isActive ?? null
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'خطأ في استخراج عنوان الـ IP الحالي' });
  }
};
router.get('/my-ip', getMyIpHandler);
router.get('/current-ip', getMyIpHandler);

// GET /allowed-ips & /allowed - List all allowed IPs
const getAllowedHandler = async (_req: AuthRequest, res: any) => {
  try {
    const items = await getAllowedIps();
    return res.json({
      success: true,
      allowedIps: items,
      count: items.length,
      allowedCount: items.length,
      maxLimit: MAX_ALLOWED_IPS,
      maxAllowed: MAX_ALLOWED_IPS
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'خطأ في جلب قائمة الـ IP المسموحة' });
  }
};
router.get('/allowed-ips', getAllowedHandler);
router.get('/allowed', getAllowedHandler);

// POST /allowed-ips & /allowed - Add a new allowed IP
const addAllowedHandler = async (req: AuthRequest, res: any) => {
  try {
    const { label, useCurrentIp } = req.body;
    let targetIp = req.body.ipAddress;

    if (useCurrentIp) {
      targetIp = extractClientIp(req);
    }

    if (!targetIp || typeof targetIp !== 'string') {
      return res.status(400).json({ success: false, error: 'عنوان الـ IP مطلوب' });
    }

    const normalized = normalizeIp(targetIp);
    if (!isValidIp(normalized)) {
      return res.status(400).json({ success: false, error: 'صيغة عنوان الـ IP غير صالحة' });
    }

    const createdBy = req.user?.username || req.user?.email || 'Super Admin';
    const record = await addAllowedIp({
      ipAddress: normalized,
      label,
      createdBy
    });

    return res.status(201).json({
      success: true,
      message: 'تم إضافة عنوان الـ IP بنجاح',
      allowedIp: record
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message || 'فشل في إضافة عنوان الـ IP' });
  }
};
router.post('/allowed-ips', addAllowedHandler);
router.post('/allowed', addAllowedHandler);

// PATCH /allowed-ips/:id - Update label or active status
router.patch('/allowed-ips/:id', async (req: AuthRequest, res) => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const { label, isActive } = req.body;
    const currentAdminIp = extractClientIp(req);

    const updated = await updateAllowedIp(
      id,
      { label, isActive },
      currentAdminIp
    );

    return res.json({
      success: true,
      message: 'تم تحديث بيانات عنوان الـ IP بنجاح',
      allowedIp: updated
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message || 'فشل في تحديث عنوان الـ IP' });
  }
});

// DELETE /allowed-ips/:id & /allowed/:id - Delete an allowed IP
const deleteAllowedHandler = async (req: AuthRequest, res: any) => {
  try {
    const rawId = req.params.id;
    const id = Array.isArray(rawId) ? rawId[0] : rawId;
    const currentAdminIp = extractClientIp(req);

    await deleteAllowedIp(id, currentAdminIp);

    return res.json({
      success: true,
      message: 'تم حذف عنوان الـ IP من القائمة المسموحة بنجاح'
    });
  } catch (error: any) {
    return res.status(400).json({ success: false, error: error.message || 'فشل في حذف عنوان الـ IP' });
  }
};
router.delete('/allowed-ips/:id', deleteAllowedHandler);
router.delete('/allowed/:id', deleteAllowedHandler);

// POST /toggle-restriction & /toggle - Toggle Master Protection Switch
const toggleHandler = async (req: AuthRequest, res: any) => {
  try {
    const { enabled } = req.body;
    if (typeof enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'حالة الحماية مطلوبة (true/false)' });
    }

    const currentAdminIp = extractClientIp(req);
    const verification = await verifyAdminCanToggleProtection(currentAdminIp, enabled);

    if (!verification.ok) {
      return res.status(400).json({
        success: false,
        error: verification.reason,
        lockoutPrevented: true
      });
    }

    await setIpRestrictionEnabled(enabled);

    return res.json({
      success: true,
      enabled,
      isRestrictionEnabled: enabled,
      message: enabled ? 'تم تفعيل حماية لوحة التحكم بنجاح' : 'تم تعطيل حماية الـ IP للوحة التحكم'
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'فشل في تغيير حالة حماية الـ IP' });
  }
};
router.post('/toggle-restriction', toggleHandler);
router.post('/toggle', toggleHandler);

// GET /stats - Aggregate stats for cards
router.get('/stats', async (_req: AuthRequest, res) => {
  try {
    const stats = await getDashboardIpStats();
    return res.json({ success: true, stats });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'خطأ في جلب الإحصائيات' });
  }
});

// GET /logs - Paginated dashboard access logs
router.get('/logs', async (req: AuthRequest, res) => {
  try {
    const pageVal = req.query.page;
    const limitVal = req.query.limit;
    const statusVal = req.query.status;
    const searchVal = req.query.search;

    const page = pageVal ? Number(Array.isArray(pageVal) ? pageVal[0] : pageVal) : 1;
    const limit = limitVal ? Number(Array.isArray(limitVal) ? limitVal[0] : limitVal) : 20;
    const status = statusVal ? String(Array.isArray(statusVal) ? statusVal[0] : statusVal) : undefined;
    const search = searchVal ? String(Array.isArray(searchVal) ? searchVal[0] : searchVal) : undefined;

    const logsData = await getAccessLogs({
      page,
      limit,
      status,
      search
    });

    return res.json({ success: true, ...logsData });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: error.message || 'خطأ في جلب سجلات الدخول' });
  }
});

// GET /check - Guarded lightweight access check
router.get('/check', (req: AuthRequest, res) => {
  const clientIp = extractClientIp(req);
  return res.json({
    success: true,
    allowed: true,
    clientIp
  });
});

export default router;
