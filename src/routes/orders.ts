import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { placeImeiOrder, placeServerOrder, getImeiOrder, getServerOrder, normalizeProviderCustomFields } from '../utils/dhru-api';
import { getProviderRemoteServiceId } from '../utils/provider-service-id';
import { buildOrderFieldDetails, resolveOrderServiceType, parseOrderMetadata } from '../utils/order-response';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { sendOrderConfirmationEmail } from '../utils/emailService';
import { isAdmin, authenticateToken } from '../middleware/auth';

const router = Router();

// Helper to safely parse JSON
function safeJsonParse(val: any, fallback: any = null) {
  if (!val) return fallback;
  if (typeof val === 'object') return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

// Helper to enrich orders with Provider and Service information
async function enrichOrdersWithProviderData(orders: any[]) {
  if (!orders || orders.length === 0) return [];

  const serviceIds = Array.from(
    new Set(orders.map((o) => String(o.serviceId || '')).filter(Boolean))
  );

  const dhruServices = await prisma.dhruService.findMany({
    where: {
      OR: [
        { id: { in: serviceIds } },
        { dhruId: { in: serviceIds } }
      ]
    },
    include: {
      apiProvider: {
        select: { id: true, name: true, apiUrl: true, type: true, isActive: true, balance: true }
      },
      dhruCategory: {
        select: { id: true, name: true }
      }
    }
  });

  const serviceMap = new Map<string, any>();
  dhruServices.forEach((s) => {
    serviceMap.set(s.id, s);
    serviceMap.set(s.dhruId, s);
  });

  return orders.map((order) => {
    const srv = serviceMap.get(String(order.serviceId));
    const metadata = parseOrderMetadata(order.notes);

    const cost = srv?.credit || 0;
    const price = order.price || 0;
    const profit = Math.max(0, price - cost);

    return {
      ...order,
      notes: metadata.visibleNote,
      provider: srv?.apiProvider
        ? {
            id: srv.apiProvider.id,
            name: srv.apiProvider.name,
            apiUrl: srv.apiProvider.apiUrl,
            type: srv.apiProvider.type
          }
        : null,
      serviceDhruId: srv?.dhruId || null,
      providerServiceId: srv?.dhruId ? getProviderRemoteServiceId(srv.dhruId) : null,
      serviceCategory: srv?.dhruCategory?.name || null,
      serviceType: resolveOrderServiceType(srv?.apiServiceType, srv?.dhruCategory?.name, srv?.groupName),
      groupName: srv?.groupName || null,
      fieldDetails: buildOrderFieldDetails(srv?.requiresCustom, metadata.customFields),
      cost,
      profit,
      customFields: metadata.customFields,
      events: metadata.events,
      rawNotes: metadata.visibleNote
    };
  });
}

// GET /api/orders - Fetch customer order history or all orders for admin
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { userId, email } = req.query;

    let targetUserId = userId as string;

    if (!targetUserId && email) {
      const u = await prisma.user.findUnique({ where: { email: (email as string).trim().toLowerCase() } });
      if (u) targetUserId = u.id;
    }

    if (!targetUserId && (req as any).user) {
      if ((req as any).user.role === 'admin' || (req as any).user.role === 'super_admin') {
        // Admin request - fetch all orders
        const allOrders = await prisma.order.findMany({
          take: 200,
          orderBy: { createdAt: 'desc' },
          include: {
            user: {
              select: { id: true, fullName: true, email: true, username: true, phone: true, balance: true }
            }
          }
        });

        const enriched = await enrichOrdersWithProviderData(allOrders);
        return res.json({ success: true, orders: enriched });
      } else {
        targetUserId = (req as any).user.id;
      }
    }

    if (!targetUserId) {
      return res.json({ success: true, orders: [] });
    }

    // Customer request - fetch user's orders
    const userOrders = await prisma.order.findMany({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: { id: true, fullName: true, email: true, username: true, phone: true, balance: true }
        }
      }
    });

    const enriched = await enrichOrdersWithProviderData(userOrders);
    return res.json({ success: true, orders: enriched });
  } catch (error: any) {
    console.error('Error fetching orders:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل الطلبات' });
  }
});

// POST /api/orders - Create & Save New Order (Saved as PENDING - waiting for admin approval)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { userId, email, serviceId, serviceName, targetInput, rawImei, quantity, price, notes, customFields } = req.body;

    if (!serviceId || !serviceName || !targetInput) {
      return res.status(400).json({ error: 'يرجى تعبئة جميع بيانات الطلب (الخدمة والرقم المطلوب)' });
    }

    let targetUserId = userId;
    let dbUser: any = null;

    if (userId) {
      dbUser = await prisma.user.findUnique({ where: { id: userId }, include: { membershipTier: true } });
    } else if (email) {
      dbUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() }, include: { membershipTier: true } });
      if (dbUser) targetUserId = dbUser.id;
    }

    if (!targetUserId && (req as any).user) {
      targetUserId = (req as any).user.id;
      dbUser = await prisma.user.findUnique({ where: { id: targetUserId }, include: { membershipTier: true } });
    }

    if (!targetUserId || !dbUser) {
      const firstUser = await prisma.user.findFirst({ include: { membershipTier: true } });
      if (firstUser) {
        targetUserId = firstUser.id;
        dbUser = firstUser;
      }
    }

    if (!targetUserId || !dbUser) {
      return res.status(400).json({ error: 'الرجاء تسجيل الدخول أولاً لإرسال الطلب' });
    }

    const qty = Math.max(1, parseInt(quantity || 1));
    let unitPrice = parseFloat(price || 0);

    // Calculate membership / custom discount
    const discountPercent = Math.max(
      dbUser.customDiscount || 0,
      dbUser.membershipTier?.discountPercentage || 0
    );
    if (discountPercent > 0 && unitPrice > 0) {
      unitPrice = Number((unitPrice * (1 - discountPercent / 100)).toFixed(2));
    }

    const totalPrice = Number((unitPrice * qty).toFixed(2));

    // Check balance sufficiency
    if (dbUser.balance < totalPrice) {
      return res.status(400).json({
        error: `رصيد محفظتك غير كافٍ! التكلفة الإجمالية: $${totalPrice.toFixed(2)} USD ورصيدك الحالي: $${dbUser.balance.toFixed(2)} USD. يرجى شحن المحفظة أولاً.`
      });
    }

    // Look up Dhru service and provider
    const dhruService = await prisma.dhruService.findFirst({
      where: {
        OR: [{ id: String(serviceId) }, { dhruId: String(serviceId) }]
      },
      include: { dhruCategory: true, apiProvider: true }
    });

    const now = new Date();
    const timelineEvents = [
      {
        time: now.toISOString(),
        action: 'ORDER_CREATED',
        title: 'إنشاء الطلب وخصم الرصيد',
        desc: `تم استلام الطلب من العميل (${dbUser.fullName}) وخصم $${totalPrice.toFixed(2)} USD من رصيد المحفظة.`
      }
    ];

    if (dhruService?.apiProvider) {
      timelineEvents.push({
        time: now.toISOString(),
        action: 'PROVIDER_LINKED',
        title: 'ربط المزود',
        desc: `الخدمة مربوطة بالمزود (${dhruService.apiProvider.name}) برقم خدمة #${dhruService.dhruId}. الطلب في انتظار موافقة وإرسال الإدارة.`
      });
    }

    const structuredNotes = JSON.stringify({
      userNote: notes ? String(notes).trim() : null,
      rawImei: rawImei ? String(rawImei).trim() : null,
      customFields: customFields || null,
      events: timelineEvents
    });

    // 1. Create Order in DB with status: 'pending' (Does NOT auto-send to provider)
    const newOrder = await prisma.order.create({
      data: {
        userId: targetUserId,
        serviceId: String(serviceId),
        serviceName: String(serviceName).trim(),
        targetInput: String(targetInput).trim(),
        quantity: qty,
        price: totalPrice,
        status: 'pending',
        notes: structuredNotes,
        apiOrderId: null
      }
    });

    // 2. Deduct Balance from User
    const updatedUser = await prisma.user.update({
      where: { id: targetUserId },
      data: { balance: { decrement: totalPrice } }
    });

    // 3. Create Deduction Transaction Record
    await prisma.transaction.create({
      data: {
        userId: targetUserId,
        type: `خصم خدمة: ${serviceName.slice(0, 35)}`,
        amount: totalPrice,
        method: 'رصيد المحفظة',
        refNo: `ORD-#${newOrder.id.slice(-6)}`,
        status: 'completed'
      }
    });

    console.log(`[Order Created (Pending Approval)] Order #${newOrder.id.slice(-6)} for User ${updatedUser.username} - Total: $${totalPrice} - Remaining Balance: $${updatedUser.balance}`);

    // 4. Send Telegram Alert to Admin
    const providerName = dhruService?.apiProvider?.name || 'سيرفر محلي / يدوي';
    const caption = `
🛍️ <b>طلب خدمة جديد في انتظار موافقة الإدارة! (New Order Pending)</b>

💳 <b>رقم الطلب:</b> #${newOrder.id.slice(-6)}
👤 <b>العميل:</b> ${dbUser.fullName} (@${dbUser.username})
📧 <b>الإيميل:</b> <code>${dbUser.email}</code>
📱 <b>اسم الخدمة:</b> ${newOrder.serviceName}
🌐 <b>المزود المربوط:</b> ${providerName} (ID: ${dhruService?.dhruId || 'N/A'})
🔢 <b>البيانات / IMEI:</b> <code>${newOrder.targetInput}</code>
📦 <b>الكمية:</b> ${newOrder.quantity}
💰 <b>إجمالي التكلفة:</b> <code>$${newOrder.price.toFixed(2)} USD</code>
🏦 <b>رصيد العميل المتبقي:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
📅 <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}

⏳ <b>الحالة:</b> في انتظار الإرسال للمزود أو التنفيذ اليدوي
    `.trim();

    try {
      await sendTelegramPhotoNotification({ caption });
    } catch (telegramError: any) {
      console.error('[Order Telegram Notification Error]:', telegramError?.message || telegramError);
    }

    // 5. Send Order Confirmation Email to Customer
    if (dbUser.email) {
      sendOrderConfirmationEmail(dbUser.email, {
        orderId: newOrder.id.slice(-6),
        serviceName: newOrder.serviceName,
        targetInput: newOrder.targetInput,
        price: newOrder.price,
        remainingBalance: updatedUser.balance,
        username: dbUser.fullName
      }).catch((err) => console.error('[Order Email Error]:', err));
    }

    return res.json({
      success: true,
      message: `تم استلام وتأكيد طلبك بنجاح! رقم الطلب #${newOrder.id.slice(-6)} وهو الآن قيد المراجعة والتنفيذ.`,
      order: {
        ...newOrder,
        provider: dhruService?.apiProvider ? { name: dhruService.apiProvider.name } : null
      },
      newBalance: updatedUser.balance
    });
  } catch (error: any) {
    console.error('Error creating order:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء إرسال وحفظ الطلب' });
  }
});

// POST /api/orders/dispatch-provider - Admin Dispatch Order to Provider API
router.post('/dispatch-provider', isAdmin, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'معرف الطلب مطلوب' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true }
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    // Look up DhruService & Provider
    const dhruService = await prisma.dhruService.findFirst({
      where: {
        OR: [{ id: String(order.serviceId) }, { dhruId: String(order.serviceId) }]
      },
      include: { dhruCategory: true, apiProvider: true }
    });

    if (!dhruService || !dhruService.dhruId) {
      return res.status(400).json({
        error: 'عذراً، هذه الخدمة غير مربوطة بكود خدمة صحيح لدى المزود (Missing Dhru ID)'
      });
    }

    const providerConfig = dhruService.apiProvider
      ? {
          apiUrl: dhruService.apiProvider.apiUrl,
          username: dhruService.apiProvider.username,
          apiKey: dhruService.apiProvider.apiKey
        }
      : undefined;

    // Parse custom fields if stored in notes
    let customFields: Record<string, string> = {};
    let rawImei = '';
    let parsedNotes: any = {};
    try {
      if (order.notes) {
        parsedNotes = JSON.parse(order.notes);
        if (parsedNotes.customFields) customFields = parsedNotes.customFields;
        if (parsedNotes.rawImei) rawImei = parsedNotes.rawImei;
      }
    } catch {}

    let dhruResponse: any = null;
    let apiOrderId: string | null = null;
    const providerCustomFields = normalizeProviderCustomFields(customFields, dhruService.requiresCustom);

    const serviceType = resolveOrderServiceType(
      dhruService.apiServiceType,
      dhruService.dhruCategory?.name,
      dhruService.groupName
    );
    if (serviceType === 'imei') {
      const imeiToSend = rawImei ? String(rawImei).trim() : String(order.targetInput).trim();
      dhruResponse = await placeImeiOrder(getProviderRemoteServiceId(dhruService.dhruId), imeiToSend, providerCustomFields, providerConfig);
    } else {
      const inputToSend = String(order.targetInput).trim();
      dhruResponse = await placeServerOrder(getProviderRemoteServiceId(dhruService.dhruId), order.quantity, providerCustomFields, inputToSend, providerConfig);
    }

    if (!dhruResponse || dhruResponse.SUCCESS === false || dhruResponse.ERROR || dhruResponse.Error) {
      console.error('[Dispatch Provider Error]:', dhruResponse);
      const errMsg = dhruResponse?.Error || dhruResponse?.ERROR?.[0]?.MESSAGE || 'رفض المزود الطلب';
      return res.status(400).json({ error: `فشل الإرسال: ${errMsg}` });
    }

    if (dhruResponse.SUCCESS && dhruResponse.SUCCESS[0] && dhruResponse.SUCCESS[0].REFERENCEID) {
      apiOrderId = String(dhruResponse.SUCCESS[0].REFERENCEID);
    }

    // Add Timeline Event
    const now = new Date();
    const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
    events.push({
      time: now.toISOString(),
      action: 'DISPATCHED_TO_PROVIDER',
      title: 'تم الإرسال للمزود بنجاح',
      desc: `تم إرسال الطلب آلياً إلى سيرفر (${dhruService.apiProvider?.name || 'المزود'}). رقم المرجع الخارجي: #${apiOrderId || 'N/A'}.`
    });

    parsedNotes.events = events;

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'processing',
        apiOrderId: apiOrderId || order.apiOrderId,
        notes: JSON.stringify(parsedNotes)
      }
    });

    return res.json({
      success: true,
      message: `تم إرسال الطلب إلى المزود بنجاح! رقم المرجع: #${apiOrderId || 'تم التسليم'}`,
      order: updatedOrder,
      apiOrderId
    });
  } catch (error: any) {
    console.error('Error dispatching order to provider:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء الإرسال للمزود' });
  }
});

// POST /api/orders/complete-manual - Admin Complete Order & Send Code
router.post('/complete-manual', isAdmin, async (req, res) => {
  try {
    const { orderId, reply } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'معرف الطلب مطلوب' });
    }

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

    let parsedNotes: any = {};
    try {
      if (order.notes) parsedNotes = JSON.parse(order.notes);
    } catch {}

    const now = new Date();
    const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
    events.push({
      time: now.toISOString(),
      action: 'ORDER_COMPLETED',
      title: 'إكمال الطلب يدوياً وتسليم الكود',
      desc: `تم اعتماد إكمال الطلب من قبل الإدارة وتسليم الكود/النتيجة: "${String(reply || 'تم الإكمال بنجاح').slice(0, 50)}..."`
    });

    parsedNotes.events = events;

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'completed',
        reply: reply ? String(reply).trim() : 'تم التنفيذ بنجاح',
        notes: JSON.stringify(parsedNotes)
      }
    });

    return res.json({
      success: true,
      message: 'تم إكمال الطلب وحفظ الكود بنجاح!',
      order: updatedOrder
    });
  } catch (error: any) {
    console.error('Error completing order:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء إكمال الطلب' });
  }
});

// POST /api/orders/refund - Admin Cancel Order Locally & Refund User Balance
router.post('/refund', isAdmin, async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'معرف الطلب مطلوب' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true }
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    if (order.status === 'rejected' || order.status === 'cancelled') {
      return res.status(400).json({ error: 'تم إلغاء هذا الطلب واسترجاع رصيده مسبقاً' });
    }

    const refundAmount = order.price || 0;
    const cancelReason = reason ? String(reason).trim() : 'تم إلغاء الطلب من قبل الإدارة واسترجاع المبلغ';

    let parsedNotes: any = {};
    try {
      if (order.notes) parsedNotes = JSON.parse(order.notes);
    } catch {}

    const now = new Date();
    const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
    events.push({
      time: now.toISOString(),
      action: 'ORDER_CANCELLED_REFUNDED',
      title: 'إلغاء الطلب واسترجاع الرصيد',
      desc: `تم إلغاء الطلب وإرجاع كامل المبلغ ($${refundAmount.toFixed(2)} USD) إلى محفظة العميل. السبب: ${cancelReason}`
    });

    parsedNotes.events = events;

    // 1. Update Order Status
    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'rejected',
        reply: `ملغي ومسترجع: ${cancelReason}`,
        notes: JSON.stringify(parsedNotes)
      }
    });

    // 2. Refund User Balance if userId exists
    if (order.userId && refundAmount > 0) {
      await prisma.user.update({
        where: { id: order.userId },
        data: { balance: { increment: refundAmount } }
      });

      // 3. Create Refund Transaction
      await prisma.transaction.create({
        data: {
          userId: order.userId,
          type: `استرجاع رصيد لطلب ملغي (#${order.id.slice(-6)})`,
          amount: refundAmount,
          method: 'استرجاع للمحفظة',
          refNo: `REFUND-#${order.id.slice(-6)}`,
          status: 'completed'
        }
      });
    }

    return res.json({
      success: true,
      message: `تم إلغاء الطلب بنجاح واسترجاع $${refundAmount.toFixed(2)} USD إلى محفظة العميل!`,
      order: updatedOrder
    });
  } catch (error: any) {
    console.error('Error refunding order:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء إلغاء الطلب واسترجاع الرصيد' });
  }
});

// POST /api/orders/cancel-provider - Admin Cancel Order From Provider & Refund Balance
router.post('/cancel-provider', isAdmin, async (req, res) => {
  try {
    const { orderId, reason } = req.body;
    if (!orderId) {
      return res.status(400).json({ error: 'معرف الطلب مطلوب' });
    }

    const order = await prisma.order.findUnique({
      where: { id: orderId },
      include: { user: true }
    });

    if (!order) {
      return res.status(404).json({ error: 'الطلب غير موجود' });
    }

    const refundAmount = order.price || 0;
    const cancelReason = reason ? String(reason).trim() : 'تم إلغاء الطلب من المزود واسترجاع المبلغ';

    let parsedNotes: any = {};
    try {
      if (order.notes) parsedNotes = JSON.parse(order.notes);
    } catch {}

    const now = new Date();
    const events = Array.isArray(parsedNotes.events) ? parsedNotes.events : [];
    events.push({
      time: now.toISOString(),
      action: 'PROVIDER_CANCELLED_REFUNDED',
      title: 'إلغاء الطلب من المزود واسترجاع الرصيد',
      desc: `تم إلغاء الطلب من المزود (Dhru ID: #${order.apiOrderId || 'N/A'}) واسترجاع $${refundAmount.toFixed(2)} USD للعميل.`
    });

    parsedNotes.events = events;

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: {
        status: 'rejected',
        reply: `ملغي من المزود: ${cancelReason}`,
        notes: JSON.stringify(parsedNotes)
      }
    });

    if (order.userId && refundAmount > 0) {
      await prisma.user.update({
        where: { id: order.userId },
        data: { balance: { increment: refundAmount } }
      });

      await prisma.transaction.create({
        data: {
          userId: order.userId,
          type: `استرجاع رصيد (إلغاء من المزود #${order.id.slice(-6)})`,
          amount: refundAmount,
          method: 'استرجاع للمحفظة',
          refNo: `REF-PROV-#${order.id.slice(-6)}`,
          status: 'completed'
        }
      });
    }

    return res.json({
      success: true,
      message: `تم إلغاء الطلب من المزود واسترجاع $${refundAmount.toFixed(2)} USD للعميل بنجاح!`,
      order: updatedOrder
    });
  } catch (error: any) {
    console.error('Error cancelling provider order:', error);
    return res.status(500).json({ error: 'فشل إلغاء الطلب من المزود' });
  }
});

// POST /api/orders/check-status - Admin check live status from Dhru/Provider API
router.post('/check-status', isAdmin, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'معرف الطلب مطلوب' });

    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return res.status(404).json({ error: 'الطلب غير موجود' });

    if (!order.apiOrderId) {
      return res.status(400).json({ error: 'هذا الطلب لم يتم إرساله إلى أي مزود بعد' });
    }

    const dhruService = await prisma.dhruService.findFirst({
      where: {
        OR: [{ id: String(order.serviceId) }, { dhruId: String(order.serviceId) }]
      },
      include: { dhruCategory: true, apiProvider: true }
    });

    const providerConfig = dhruService?.apiProvider
      ? {
          apiUrl: dhruService.apiProvider.apiUrl,
          username: dhruService.apiProvider.username,
          apiKey: dhruService.apiProvider.apiKey
        }
      : undefined;

    let response: any = null;
    const serviceType = dhruService
      ? resolveOrderServiceType(dhruService.apiServiceType, dhruService.dhruCategory?.name, dhruService.groupName)
      : 'unknown';
    if (dhruService && serviceType === 'imei') {
      response = await getImeiOrder(order.apiOrderId, providerConfig);
    } else {
      response = await getServerOrder(order.apiOrderId, providerConfig);
    }

    if (!response || response.SUCCESS === false || response.ERROR || response.Error) {
      return res.status(400).json({
        error: response?.Error || response?.ERROR?.[0]?.MESSAGE || 'فشل الاستعلام من المزود'
      });
    }

    const statusData = response.SUCCESS?.[0];
    if (!statusData) {
      return res.json({ success: true, message: 'لا توجد بيانات محدثة من المزود بعد', raw: response });
    }

    const apiStatus = String(statusData.STATUS);
    let nextStatus = order.status;
    let reply = order.reply;

    if (apiStatus === '4') {
      nextStatus = 'completed';
      reply = statusData.CODE || 'تم بنجاح من المزود';
    } else if (apiStatus === '2' || apiStatus === '3') {
      nextStatus = 'rejected';
      reply = statusData.CODE || 'مرفوض من المزود';
    } else if (apiStatus === '1') {
      nextStatus = 'processing';
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: { status: nextStatus, reply }
    });

    return res.json({
      success: true,
      message: `تم تحديث حالة الطلب من المزود: ${nextStatus === 'completed' ? 'مكتمل بنجاح ✅' : nextStatus}`,
      order: updatedOrder,
      statusData
    });
  } catch (error: any) {
    console.error('Error checking order status:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء فحص حالة الطلب من المزود' });
  }
});

// POST /api/orders/update-status - Admin update order status & reply code
router.post('/update-status', isAdmin, async (req, res) => {
  try {
    const { orderId, newStatus, reply } = req.body;
    if (!orderId || !newStatus) {
      return res.status(400).json({ error: 'معرف الطلب والحالة الجديدة مطلوبة' });
    }

    const updateData: any = { status: newStatus };
    if (reply !== undefined && reply !== null) {
      updateData.reply = String(reply).trim();
    }

    const updatedOrder = await prisma.order.update({
      where: { id: orderId },
      data: updateData
    });

    return res.json({
      success: true,
      message: 'تم تحديث حالة الطلب وإرسال الكود/النتيجة بنجاح!',
      order: updatedOrder
    });
  } catch (error: any) {
    console.error('Error updating order status:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحديث حالة الطلب' });
  }
});

export default router;
