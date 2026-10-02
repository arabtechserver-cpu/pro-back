import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { authenticateToken, isAdmin } from '../middleware/auth';
import {
  getFoxreloadSettings,
  updateFoxreloadSettings,
  getFoxreloadLiveBalance,
  getFoxreloadFullCatalog,
  getFoxreloadCategoryProducts,
  searchFoxreloadProducts,
  clearCatalogCache,
  callFoxreloadApi,
  createAndDispatchFoxreloadOrder,
  computeClientPrice,
} from '../services/foxreloadService';

const router = Router();

// GET /api/foxreload/catalog - Public Catalog for Customer Storefront
router.get('/catalog', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const catalog = await getFoxreloadFullCatalog(forceRefresh);
    return res.json({ success: true, ...catalog });
  } catch (error: any) {
    console.error('FoxReload catalog error:', error);
    return res.status(500).json({ error: 'تعذر جلب كتالوج الألعاب والخدمات حالياً' });
  }
});

// GET /api/foxreload/category/:id/products - Products for specific country/region category
router.get('/category/:id/products', async (req, res) => {
  try {
    const categoryId = req.params.id;
    const forceRefresh = req.query.refresh === 'true';
    const products = await getFoxreloadCategoryProducts(categoryId, forceRefresh);
    return res.json({ success: true, categoryId, products });
  } catch (error: any) {
    console.error('FoxReload category products error:', error);
    return res.status(500).json({ error: 'تعذر جلب باقات الفئة المحددة حالياً' });
  }
});

// GET /api/foxreload/search - Live Product / Game Search
router.get('/search', async (req, res) => {
  try {
    const query = String(req.query.q || req.query.query || '').trim();
    if (!query) {
      return res.json({ success: true, products: [] });
    }
    const products = await searchFoxreloadProducts(query);
    return res.json({ success: true, products });
  } catch (error: any) {
    console.error('FoxReload search error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء البحث' });
  }
});

// GET /api/foxreload/product/:id - Single Product Details
router.get('/product/:id', async (req, res) => {
  try {
    const productId = req.params.id;
    const apiRes = await callFoxreloadApi(`/api/products/${productId}`, 'GET');
    if (!apiRes.ok || !apiRes.data) {
      return res.status(404).json({ error: 'المنتج المطلوب غير موجود أو غير متاح' });
    }

    const settings = await getFoxreloadSettings();
    const cost = parseFloat(apiRes.data.price || '0') || 0;
    const { finalPrice, marginAmount, marginPercent } = computeClientPrice(cost, productId, settings);

    return res.json({
      success: true,
      product: {
        ...apiRes.data,
        costPrice: cost,
        price: finalPrice,
        marginAmount,
        marginPercent,
        currency: 'USD',
        isHidden: settings.hiddenItems.includes(productId),
      },
    });
  } catch (error: any) {
    console.error('FoxReload product details error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب تفاصيل المنتج' });
  }
});

// POST /api/foxreload/order - Customer Purchase Request
router.post('/order', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'يرجى تسجيل الدخول أولاً لإتمام عملية الشراء' });
    }

    const { productId, quantity = 1, targetInput, notes = {} } = req.body;
    if (!productId) {
      return res.status(400).json({ error: 'معرف المنتج مطلوب' });
    }

    const qty = Math.max(1, parseInt(String(quantity), 10) || 1);

    const settings = await getFoxreloadSettings();
    if (!settings.isEnabled) {
      return res.status(403).json({ error: 'خدمات شحن الألعاب والترفيه متوقفة حالياً للصيانة' });
    }

    if (settings.hiddenItems.includes(productId)) {
      return res.status(404).json({ error: 'هذه الباقة غير متاحة للطلب حالياً' });
    }

    const prodRes = await callFoxreloadApi(`/api/products/${productId}`, 'GET');
    if (!prodRes.ok || !prodRes.data) {
      return res.status(404).json({ error: 'تعذر التحقق من بيانات المنتج لدى المزود' });
    }

    const product = prodRes.data;
    const cost = parseFloat(product.price || '0') || 0;
    const { finalPrice } = computeClientPrice(cost, productId, settings);
    const totalPrice = Number((finalPrice * qty).toFixed(2));

    const dbUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, balance: true, fullName: true, email: true },
    });

    if (!dbUser) {
      return res.status(404).json({ error: 'المستخدم غير موجود' });
    }

    if (dbUser.balance < totalPrice) {
      return res.status(400).json({
        error: `رصيد محفظتك غير كافٍ. المطلوب: $${totalPrice.toFixed(2)} USD، الرصيد المتاح: $${dbUser.balance.toFixed(2)} USD. يرجى شحن محفظتك أولاً.`,
      });
    }

    const normalizedTarget = targetInput ? String(targetInput).trim() : 'Digital Voucher / Code';

    const orderResult = await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { balance: { decrement: totalPrice } },
      });

      await tx.walletTransaction.create({
        data: {
          userId,
          amount: totalPrice,
          type: 'purchase',
          status: 'completed',
        },
      });

      const newOrder = await tx.order.create({
        data: {
          userId,
          serviceName: product.name || 'FoxReload Service',
          serviceId: `foxreload:${productId}`,
          targetInput: normalizedTarget,
          quantity: qty,
          price: totalPrice,
          status: 'pending',
          source: 'foxreload',
          notes: JSON.stringify({
            provider: 'foxreload',
            productId,
            costPrice: cost,
            unitPrice: finalPrice,
            productSlug: product.slug,
            deliveryType: product.deliveryType,
            requiredNoteFields: product.requiredNoteFields,
            userNotes: notes,
            purchasedAt: new Date().toISOString(),
          }),
        },
      });

      return newOrder;
    });

    if (settings.autoFulfill) {
      try {
        const dispatchResult = await createAndDispatchFoxreloadOrder({
          productId,
          quantity: qty,
          notes,
        });

        if (dispatchResult.success) {
          const codesText = dispatchResult.codes && dispatchResult.codes.length > 0 ? dispatchResult.codes.join('\n') : null;
          const updated = await prisma.order.update({
            where: { id: orderResult.id },
            data: {
              apiOrderId: dispatchResult.orderId,
              status: dispatchResult.status === 'completed' || dispatchResult.status === 'finished' ? 'completed' : 'processing',
              reply: codesText || (dispatchResult.status === 'completed' ? 'تم الشحن والتفعيل بنجاح' : 'جاري التنفيذ لدى المزود'),
            },
          });
          return res.json({
            success: true,
            orderId: updated.id,
            status: updated.status,
            reply: updated.reply,
            codes: dispatchResult.codes,
            message: 'تم استلام الطلب وتنفيذه بنجاح',
          });
        }
      } catch (dispatchErr: any) {
        console.error('Auto fulfill dispatch error:', dispatchErr);
      }
    }

    return res.json({
      success: true,
      orderId: orderResult.id,
      status: orderResult.status,
      message: 'تم استلام طلبك وخصم المبلغ من محفظتك بنجاح، وهو قيد المعالجة والاعتماد.',
    });
  } catch (error: any) {
    console.error('FoxReload order error:', error);
    return res.status(500).json({ error: error.message || 'حدث خطأ أثناء معالجة الطلب' });
  }
});

// Admin Routes (Guarded with isAdmin)
router.use('/admin', isAdmin);

// GET /api/foxreload/admin/overview - Admin Dashboard Stats & Live Balance
router.get('/admin/overview', async (_req, res) => {
  try {
    const [settings, liveBalance, pendingOrdersCount, totalOrdersCount] = await Promise.all([
      getFoxreloadSettings(),
      getFoxreloadLiveBalance(),
      prisma.order.count({ where: { source: 'foxreload', status: 'pending' } }),
      prisma.order.count({ where: { source: 'foxreload' } }),
    ]);

    return res.json({
      success: true,
      settings,
      liveBalance,
      pendingOrdersCount,
      totalOrdersCount,
    });
  } catch (error: any) {
    console.error('FoxReload admin overview error:', error);
    return res.status(500).json({ error: 'فشل جلب بيانات لوحة التحكم' });
  }
});

// GET /api/foxreload/admin/catalog - Full Catalog for Admin Management
router.get('/admin/catalog', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === 'true';
    const catalog = await getFoxreloadFullCatalog(forceRefresh);
    return res.json({ success: true, catalog });
  } catch (error: any) {
    console.error('FoxReload admin catalog error:', error);
    return res.status(500).json({ error: 'فشل جلب كتالوج الإدارة' });
  }
});

// GET /api/foxreload/admin/category/:id/products - Products for a category in Admin
router.get('/admin/category/:id/products', async (req, res) => {
  try {
    const categoryId = req.params.id;
    const forceRefresh = req.query.refresh === 'true';
    const products = await getFoxreloadCategoryProducts(categoryId, forceRefresh);
    return res.json({ success: true, categoryId, products });
  } catch (error: any) {
    return res.status(500).json({ error: 'فشل جلب باقات الفئة للإدارة' });
  }
});

// GET /api/foxreload/admin/settings - Read current settings
router.get('/admin/settings', async (_req, res) => {
  try {
    const settings = await getFoxreloadSettings();
    return res.json({ success: true, settings });
  } catch (error: any) {
    return res.status(500).json({ error: 'فشل قراءة الإعدادات' });
  }
});

// POST /api/foxreload/admin/settings - Save settings
router.post('/admin/settings', async (req, res) => {
  try {
    const updated = await updateFoxreloadSettings(req.body);
    return res.json({ success: true, settings: updated, message: 'تم حفظ الإعدادات بنجاح' });
  } catch (error: any) {
    return res.status(500).json({ error: 'فشل حفظ الإعدادات' });
  }
});

// POST /api/foxreload/admin/toggle-all - Master Visibility Toggle
router.post('/admin/toggle-all', async (req, res) => {
  try {
    const { isEnabled } = req.body;
    const updated = await updateFoxreloadSettings({ isEnabled: Boolean(isEnabled) });
    return res.json({
      success: true,
      isEnabled: updated.isEnabled,
      message: updated.isEnabled ? 'تم إظهار جميع خدمات FoxReload بنجاح' : 'تم إخفاء جميع خدمات FoxReload عن الموقع',
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'فشل تغيير حالة الظهور العامة' });
  }
});

// POST /api/foxreload/admin/toggle-item - Toggle individual item visibility
router.post('/admin/toggle-item', async (req, res) => {
  try {
    const { itemId, isHidden } = req.body;
    if (!itemId) {
      return res.status(400).json({ error: 'معرف العنصر مطلوب' });
    }

    const settings = await getFoxreloadSettings();
    const currentHidden = new Set(settings.hiddenItems);

    if (isHidden) {
      currentHidden.add(itemId);
    } else {
      currentHidden.delete(itemId);
    }

    const updated = await updateFoxreloadSettings({ hiddenItems: Array.from(currentHidden) });
    return res.json({
      success: true,
      itemId,
      isHidden: updated.hiddenItems.includes(itemId),
      message: isHidden ? 'تم إخفاء الباقة عن العرض' : 'تم إظهار الباقة بنجاح',
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'فشل تحديث حالة إظهار الباقة' });
  }
});

// POST /api/foxreload/admin/update-pricing - Set global profit margin or custom price
router.post('/admin/update-pricing', async (req, res) => {
  try {
    const { defaultProfitMarginPercent, itemId, customPrice, customMargin } = req.body;
    const settings = await getFoxreloadSettings();

    const updates: any = {};

    if (defaultProfitMarginPercent !== undefined && defaultProfitMarginPercent !== null) {
      const parsedMargin = Number(defaultProfitMarginPercent);
      if (!isNaN(parsedMargin)) {
        updates.defaultProfitMarginPercent = Math.max(0, parsedMargin);
      }
    }

    if (itemId) {
      if (customPrice !== undefined) {
        const prices = { ...settings.customPrices };
        const numPrice = Number(customPrice);
        if (!isNaN(numPrice) && numPrice > 0) {
          prices[itemId] = numPrice;
        } else {
          delete prices[itemId];
        }
        updates.customPrices = prices;
      }

      if (customMargin !== undefined) {
        const margins = { ...settings.customMargins };
        const numMargin = Number(customMargin);
        if (!isNaN(numMargin) && numMargin > 0) {
          margins[itemId] = numMargin;
        } else {
          delete margins[itemId];
        }
        updates.customMargins = margins;
      }
    }

    const updated = await updateFoxreloadSettings(updates);
    return res.json({ success: true, settings: updated, message: 'تم تحديث التسعير بنجاح' });
  } catch (error: any) {
    return res.status(500).json({ error: 'فشل تحديث التسعير' });
  }
});

// GET /api/foxreload/admin/orders - FoxReload Orders List
router.get('/admin/orders', async (req, res) => {
  try {
    const { status, limit = 100 } = req.query;
    const whereClause: any = { source: 'foxreload' };
    if (status && status !== 'all') {
      whereClause.status = String(status);
    }

    const orders = await prisma.order.findMany({
      where: whereClause,
      take: Math.min(200, parseInt(String(limit), 10) || 100),
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, username: true, balance: true },
        },
      },
    });

    return res.json({ success: true, orders });
  } catch (error: any) {
    console.error('FoxReload admin orders error:', error);
    return res.status(500).json({ error: 'فشل جلب قائمة الطلبات' });
  }
});

// POST /api/foxreload/admin/orders/:id/approve - Approve & Dispatch Pending Order
router.post('/admin/orders/:id/approve', async (req, res) => {
  try {
    const orderId = req.params.id;
    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true },
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    if (order.status !== 'pending' && order.status !== 'processing') {
      return res.status(400).json({ error: `لا يمكن اعتماد طلب بحالة: ${order.status}` });
    }

    let parsedNotes: any = {};
    try {
      parsedNotes = order.notes ? JSON.parse(order.notes) : {};
    } catch {}

    const rawProductId = (order.serviceId || '').replace(/^foxreload:/, '');
    const userNotes = parsedNotes.userNotes || {};

    const dispatchRes = await createAndDispatchFoxreloadOrder({
      productId: rawProductId,
      quantity: order.quantity,
      notes: userNotes,
    });

    if (!dispatchRes.success) {
      return res.status(400).json({
        error: `فشل التنفيذ لدى FoxReload: ${dispatchRes.error || 'خطأ غير معروف'}`,
      });
    }

    const codesText = dispatchRes.codes && dispatchRes.codes.length > 0 ? dispatchRes.codes.join('\n') : null;
    const isCompleted = dispatchRes.status === 'completed' || dispatchRes.status === 'finished';

    const updated = await prisma.order.update({
      where: { id: orderId },
      data: {
        apiOrderId: dispatchRes.orderId,
        status: isCompleted ? 'completed' : 'processing',
        reply: codesText || (isCompleted ? 'تم إرسال الكود والشحن بنجاح' : 'جاري المعالجة لدى المزود'),
      },
    });

    return res.json({
      success: true,
      order: updated,
      codes: dispatchRes.codes,
      message: 'تم إرسال الطلب واعتماده بنجاح لدى المزود',
    });
  } catch (error: any) {
    console.error('Approve order error:', error);
    return res.status(500).json({ error: error.message || 'حدث خطأ أثناء اعتماد الطلب' });
  }
});

// POST /api/foxreload/admin/orders/:id/reject - Reject & Refund Order
router.post('/admin/orders/:id/reject', async (req, res) => {
  try {
    const orderId = req.params.id;
    const { reason = 'تم الرفض بواسطة الإدارة واسترجاع الرصيد' } = req.body;

    const order = await prisma.order.findUnique({
      where: { id: orderId },
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    if (order.status === 'completed' || order.status === 'refunded') {
      return res.status(400).json({ error: 'لا يمكن رفض طلب مكتمل أو مسترجع مسبقاً' });
    }

    await prisma.$transaction(async (tx) => {
      if (order.userId) {
        await tx.user.update({
          where: { id: order.userId },
          data: { balance: { increment: order.price } },
        });

        await tx.walletTransaction.create({
          data: {
            userId: order.userId,
            amount: order.price,
            type: 'refund',
            status: 'completed',
          },
        });
      }

      await tx.order.update({
        where: { id: orderId },
        data: {
          status: 'rejected',
          reply: reason,
          refundedAt: new Date(),
        },
      });
    });

    return res.json({ success: true, message: 'تم رفض الطلب واسترجاع المبلغ لمحفظة العميل' });
  } catch (error: any) {
    console.error('Reject order error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء رفض الطلب' });
  }
});

// POST /api/foxreload/admin/test-connection - Diagnostic Connection Test
router.post('/admin/test-connection', async (req, res) => {
  try {
    const { apiKey } = req.body || {};
    const live = await getFoxreloadLiveBalance(apiKey);
    if (!live.success) {
      return res.status(400).json({
        success: false,
        error: live.error || 'فشل الاتصال بـ FoxReload API',
        details: live.details,
      });
    }

    return res.json({
      success: true,
      message: 'الاتصال بـ FoxReload API يعمل بكفاءة تامة',
      account: {
        email: live.email,
        isActive: live.isActive,
        balances: live.balances,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'خطأ في فحص الاتصال' });
  }
});

// POST /api/foxreload/admin/test-order - Create Test Order
router.post('/admin/test-order', async (req, res) => {
  try {
    const { simulate = true } = req.body;

    if (simulate) {
      return res.json({
        success: true,
        simulated: true,
        message: 'تمت محاكاة فحص إنشاء الطلب بنجاح (وضع الاختبار الآمن)',
        details: {
          endpoint: 'POST https://public-api.foxreload.com/api/orders/',
          expectedPayload: {
            items: [{ itemId: 'product_01m0baj23wew8rjxvjwahz8fdf', quantity: 1 }],
          },
          status: 'ready',
        },
      });
    }

    const testProductId = 'product_01m0baj23wew8rjxvjwahz8fdf';
    const result = await createAndDispatchFoxreloadOrder({
      productId: testProductId,
      quantity: 1,
    });

    return res.json({
      success: result.success,
      orderId: result.orderId,
      status: result.status,
      codes: result.codes,
      error: result.error,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'خطأ في فحص الطلب التجريبي' });
  }
});

export default router;
