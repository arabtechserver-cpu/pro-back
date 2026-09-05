import { Router } from 'express';
import { getAccountInfo, getImeiServiceList } from '../utils/dhru-api';
import { isAdmin } from '../middleware/auth';

const router = Router();

router.get('/account', isAdmin, async (req, res) => {
  try {
    const info = await getAccountInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Dhru account info' });
  }
});

import { prisma } from "../utils/prisma";

import { syncDhruServices, cleanServiceName } from '../scripts/syncDhruServices';
import { serializeAdminServiceCategories, serializePricingServiceCategories } from "../utils/admin-service-response";
import { getServiceQuantityConfig, enrichCustomFieldsWithQuantity } from '../utils/provider-quantity';

// In-memory cache for ultra-fast pricing responses without database re-querying
let pricingCache: { data: any; timestamp: number; etag: string } | null = null;
const PRICING_CACHE_TTL = 60 * 1000; // 60 seconds TTL

export function invalidateDhruServicesCache() {
  pricingCache = null;
}

router.get('/services', (req, res, next) => {
  if (req.query.all === 'true') return isAdmin(req, res, next);
  return next();
}, async (req, res) => {
  try {
    const { all } = req.query;
    const isPricingView = req.query.view === "pricing";

    // Instant in-memory cache check for pricing view
    if (isPricingView && all !== 'true' && pricingCache && (Date.now() - pricingCache.timestamp < PRICING_CACHE_TTL)) {
      const clientEtag = req.headers['if-none-match'];
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.setHeader('ETag', pricingCache.etag);
      if (clientEtag && clientEtag === pricingCache.etag) {
        return res.status(304).end();
      }
      return res.json(pricingCache.data);
    }

    const categories = await prisma.dhruCategory.findMany({
      select: {
        id: true,
        name: true,
        dhruServices: {
          where: all === 'true' ? {} : { isActive: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            dhruId: true,
            name: true,
            originalName: true,
            groupName: true,
            credit: true,
            time: true,
            info: true,
            isActive: true,
            margin: true,
            requiresCustom: true,
            supportsQty: true,
            minQty: true,
            maxQty: true,
            originalPrice: true
          }
        }
      },
    });

    const cleanedCategories = isPricingView
      ? serializePricingServiceCategories(categories, cleanServiceName)
      : serializeAdminServiceCategories(categories, cleanServiceName);

    if (isPricingView && all !== 'true') {
      const etag = `"${Buffer.from(`${Date.now()}_${cleanedCategories.length}`).toString('base64')}"`;
      pricingCache = {
        data: cleanedCategories,
        timestamp: Date.now(),
        etag
      };
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
      res.setHeader('ETag', etag);
    }

    res.json(cleanedCategories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Dhru services from DB' });
  }
});

// POST /api/dhru/services/toggle - Toggle single service visibility
router.post('/services/toggle', isAdmin, async (req, res) => {
  try {
    const { serviceId, isActive } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: 'serviceId is required' });
    }

    const currentService = await prisma.dhruService.findUnique({ where: { id: serviceId } });
    if (!currentService) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const nextState = typeof isActive === 'boolean' ? isActive : !currentService.isActive;
    const updated = await prisma.dhruService.update({
      where: { id: serviceId },
      data: { isActive: nextState }
    });

    invalidateDhruServicesCache();
    res.json({ success: true, service: updated, message: nextState ? 'تم إظهار الخدمة للعملاء' : 'تم إخفاء الخدمة عن العملاء' });
  } catch (error) {
    console.error('Toggle service error:', error);
    res.status(500).json({ error: 'Failed to toggle service visibility' });
  }
});

// POST /api/dhru/services/toggle-group - Toggle or hide/show entire package group
router.post('/services/toggle-group', isAdmin, async (req, res) => {
  try {
    const { groupName, categoryId, isActive } = req.body;
    if (!groupName) {
      return res.status(400).json({ error: 'groupName is required' });
    }

    const whereClause: any = { groupName };
    if (categoryId) {
      whereClause.categoryId = categoryId;
    }

    const nextState = typeof isActive === 'boolean' ? isActive : false;

    const result = await prisma.dhruService.updateMany({
      where: whereClause,
      data: { isActive: nextState }
    });

    invalidateDhruServicesCache();
    res.json({
      success: true,
      count: result.count,
      message: nextState ? `تم إظهار جميع خدمات (${groupName}) للعملاء` : `تم إخفاء جميع خدمات (${groupName}) عن العملاء`
    });
  } catch (error) {
    console.error('Toggle group error:', error);
    res.status(500).json({ error: 'Failed to toggle group visibility' });
  }
});

// POST /api/dhru/services/update - Edit service custom name, base credit, and profit margin
router.post('/services/update', isAdmin, async (req, res) => {
  try {
    const { serviceId, name, margin, credit, isActive, requiresCustom } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: 'serviceId is required' });
    }

    const updateData: any = {};
    if (name !== undefined && name.trim() !== '') {
      updateData.name = name.trim();
    }
    if (margin !== undefined) {
      updateData.margin = parseFloat(margin) || 0;
    }
    if (credit !== undefined && !isNaN(parseFloat(credit))) {
      updateData.credit = Math.max(0, parseFloat(credit));
    }
    if (isActive !== undefined) {
      updateData.isActive = Boolean(isActive);
    }
    // دعم تعديل الحقول المخصصة للخدمة من لوحة الأدمن
    if (requiresCustom !== undefined) {
      if (requiresCustom === null || requiresCustom === '') {
        updateData.requiresCustom = null;
      } else if (typeof requiresCustom === 'string') {
        // تحقق من أن الـ JSON صالح قبل الحفظ
        try {
          JSON.parse(requiresCustom);
          updateData.requiresCustom = requiresCustom;
        } catch {
          return res.status(400).json({ error: 'requiresCustom must be valid JSON' });
        }
      } else if (typeof requiresCustom === 'object') {
        updateData.requiresCustom = JSON.stringify(requiresCustom);
      }
    }

    if (req.body.supportsQty !== undefined || req.body.minQty !== undefined || req.body.maxQty !== undefined) {
      let existingFields: any[] = [];
      const current = updateData.requiresCustom || (await prisma.dhruService.findUnique({ where: { id: serviceId } }))?.requiresCustom;
      if (current) {
        try {
          const parsed = typeof current === 'string' ? JSON.parse(current) : current;
          existingFields = Array.isArray(parsed) ? parsed : Object.entries(parsed).map(([k, v]: any) => ({ ...v, field_id: k }));
        } catch {}
      }
      const supportsQty = req.body.supportsQty !== undefined ? Boolean(req.body.supportsQty) : undefined;
      const minQty = req.body.minQty !== undefined ? Math.max(1, parseInt(req.body.minQty) || 1) : undefined;
      const maxQty = req.body.maxQty !== undefined ? Math.max(0, parseInt(req.body.maxQty) || 0) : undefined;
      
      const qtyLimits = {
        supportsQty: supportsQty ?? (minQty !== undefined || maxQty !== undefined),
        minQty: minQty ?? 1,
        maxQty: maxQty ?? 0
      };
      if (qtyLimits.supportsQty) {
        existingFields = enrichCustomFieldsWithQuantity(existingFields, qtyLimits);
        updateData.requiresCustom = JSON.stringify(existingFields);
      }
    }

    const updated = await prisma.dhruService.update({
      where: { id: serviceId },
      data: updateData
    });

    invalidateDhruServicesCache();
    res.json({ success: true, service: updated, message: 'تم حفظ تعديلات الخدمة بنجاح' });
  } catch (error) {
    console.error('Update service error:', error);
    res.status(500).json({ error: 'Failed to update service' });
  }
});

router.get('/services/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const service = await prisma.dhruService.findFirst({
      where: {
        OR: [
          { id },
          { dhruId: id }
        ]
      },
      include: {
        dhruCategory: true
      }
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const credit = typeof service.credit === 'number' ? service.credit : parseFloat(service.credit as any) || 0;
    const margin = typeof service.margin === 'number' ? service.margin : parseFloat(service.margin as any) || 0;
    const finalPrice = Number((credit + margin).toFixed(2));

    let sanitizedRequiresCustom: string | null = service.requiresCustom;
    if (sanitizedRequiresCustom) {
      try {
        const parsed = typeof sanitizedRequiresCustom === "string" ? JSON.parse(sanitizedRequiresCustom) : sanitizedRequiresCustom;
        if (Array.isArray(parsed)) {
          const filtered = parsed.filter((f: any) => f && f.synthetic_quantity !== true && f.field_id !== "custom_QNT");
          sanitizedRequiresCustom = JSON.stringify(filtered);
        }
      } catch {}
    }

    const qtyConfig = getServiceQuantityConfig({
      ...service,
      categoryName: service.dhruCategory?.name,
      requiresCustom: sanitizedRequiresCustom
    });

    let finalRequiresCustom = sanitizedRequiresCustom;
    if (qtyConfig.supportsQty) {
      try {
        let parsed = typeof sanitizedRequiresCustom === "string" ? JSON.parse(sanitizedRequiresCustom) : (sanitizedRequiresCustom || []);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          parsed = Object.entries(parsed).map(([key, val]: any) => ({
            ...(val && typeof val === 'object' ? val : {}),
            id: val?.id || key,
            field_id: val?.field_id || val?.reqid || key,
            name: val?.name || val?.fieldname || key
          }));
        }
        const enriched = enrichCustomFieldsWithQuantity(Array.isArray(parsed) ? parsed : [], qtyConfig);
        finalRequiresCustom = JSON.stringify(enriched);
      } catch {}
    }

    const cleanedService = {
      ...service,
      requiresCustom: finalRequiresCustom,
      credit,
      margin,
      price: finalPrice,
      finalPrice,
      sellingPrice: finalPrice,
      name: cleanServiceName(service.name, service.info || '', service.groupName || ''),
      supportsQty: qtyConfig.supportsQty,
      supports_quantity: qtyConfig.supportsQty,
      minQty: qtyConfig.minQty,
      maxQty: qtyConfig.maxQty,
      min_quantity: qtyConfig.min_quantity,
      max_quantity: qtyConfig.max_quantity
    };

    res.json(cleanedService);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

router.post('/sync', isAdmin, async (req, res) => {
  try {
    const result = await syncDhruServices();
    res.json(result);
  } catch (error: any) {
    console.error('Dhru sync error:', error);
    res.status(500).json({ 
      success: false, 
      error: error?.message || 'فشل في مزامنة الخدمات من المزود' 
    });
  }
});

import { broadcastNewItemToSubscribers } from './newsletter';

// POST /api/dhru/services/notify - Admin notify subscribers about a specific service or tool
router.post('/services/notify', isAdmin, async (req, res) => {
  try {
    const { serviceId, customMessage } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: 'serviceId is required' });
    }

    const service = await prisma.dhruService.findFirst({
      where: {
        OR: [{ id: serviceId }, { dhruId: serviceId }]
      }
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const credit = typeof service.credit === 'number' ? service.credit : parseFloat(service.credit as any) || 0;
    const margin = typeof service.margin === 'number' ? service.margin : parseFloat(service.margin as any) || 0;
    const price = (credit + margin).toFixed(2);

    const title = `خدمة وتفعيل جديد: ${service.name}`;
    const message = customMessage || `يسرنا إعلامكم بتوفر خدمة وتفعيل (${service.name}) عبر سيرفر عرب تك برو بسعر $${price} USD وبتسليم فوري.\n\nتفضل بطلب الخدمة الآن عبر المنصة.`;

    const result = await broadcastNewItemToSubscribers({
      title,
      message,
      category: 'Service Update',
      actionUrl: `https://arabtechproserver.tech/ar/pricing?search=${encodeURIComponent(service.name)}`,
      actionText: 'طلب الخدمة الآن'
    });

    res.json({
      success: true,
      message: `تم إرسال إشعار الخدمة بنجاح إلى ${result.count} مشترك!`,
      sentCount: result.count
    });
  } catch (error) {
    console.error('Notify service error:', error);
    res.status(500).json({ error: 'Failed to broadcast service notification' });
  }
});

// POST /api/dhru/services/delete-all - Delete all services & categories
router.post('/services/delete-all', isAdmin, async (req, res) => {
  try {
    const deletedServices = await prisma.dhruService.deleteMany({});
    const deletedCategories = await prisma.dhruCategory.deleteMany({});

    invalidateDhruServicesCache();
    return res.json({
      success: true,
      servicesCount: deletedServices.count,
      categoriesCount: deletedCategories.count,
      message: `تم حذف كافة الخدمات (${deletedServices.count} خدمة) والأقسام بنجاح.`
    });
  } catch (error: any) {
    console.error('Delete all services error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء حذف الخدمات' });
  }
});

// POST /api/dhru/services/bulk-margin - Bulk apply profit margin to all services
router.post('/services/bulk-margin', isAdmin, async (req, res) => {
  try {
    const { type, value, applyTo, categoryId } = req.body;
    const numVal = parseFloat(value);

    if (isNaN(numVal) || numVal < 0) {
      return res.status(400).json({ error: 'قيمة الهامش غير صالحة' });
    }

    const whereClause: any = {};
    if (applyTo === 'active') {
      whereClause.isActive = true;
    }
    if (categoryId) {
      whereClause.categoryId = categoryId;
    }

    const allServices = await prisma.dhruService.findMany({ where: whereClause });

    if (type === 'replace') {
      // Set fixed margin directly
      const result = await prisma.dhruService.updateMany({
        where: whereClause,
        data: { margin: numVal }
      });
      invalidateDhruServicesCache();
      return res.json({
        success: true,
        updatedCount: result.count,
        message: `تم تعيين هامش ربح بقيمة $${numVal.toFixed(2)} لـ ${result.count} خدمة بنجاح!`
      });
    }

    // Process individual calculations for fixed addition or percentage
    let updatedCount = 0;
    for (const service of allServices) {
      const credit = typeof service.credit === 'number' ? service.credit : parseFloat(service.credit as any) || 0;
      const currentMargin = typeof service.margin === 'number' ? service.margin : parseFloat(service.margin as any) || 0;

      let newMargin = currentMargin;
      if (type === 'fixed') {
        newMargin = Math.max(0, parseFloat((currentMargin + numVal).toFixed(2)));
      } else if (type === 'percentage') {
        // Calculate margin as percentage of base credit
        newMargin = Math.max(0, parseFloat(((credit * numVal) / 100).toFixed(2)));
      }

      await prisma.dhruService.update({
        where: { id: service.id },
        data: { margin: newMargin }
      });
      updatedCount++;
    }

    invalidateDhruServicesCache();
    return res.json({
      success: true,
      updatedCount,
      message: type === 'percentage'
        ? `تم تطبيق نسبة ربح ${numVal}% على سعر التكلفة لـ ${updatedCount} خدمة بنجاح!`
        : `تمت إضافة $${numVal.toFixed(2)} لهامش الربح لـ ${updatedCount} خدمة بنجاح!`
    });
  } catch (error: any) {
    console.error('Bulk margin error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحديث هوامش الربح' });
  }
});

export default router;
