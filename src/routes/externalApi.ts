import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { resolveOrderServiceType } from '../utils/order-response';

const router = Router();

// Middleware to authenticate API requests with username and API key
const authenticateApi = async (req: any, res: any, next: any) => {
  try {
    const username = (
      req.body.username ||
      req.query.username ||
      req.headers['x-username'] ||
      ''
    ).toString().trim();

    const apiKey = (
      req.body.apiaccesskey ||
      req.body.key ||
      req.body.apiKey ||
      req.query.apiaccesskey ||
      req.query.key ||
      req.headers['x-api-key'] ||
      ''
    ).toString().trim();

    if (!username || !apiKey) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Invalid username or API key. Please provide username and apiaccesskey/key."
        }]
      });
    }

    const user = await prisma.user.findFirst({
      where: {
        OR: [
          { username: { equals: username, mode: 'insensitive' } },
          { email: { equals: username, mode: 'insensitive' } }
        ],
        apiKey: apiKey,
        apiEnabled: true
      }
    });

    if (!user) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Authentication failed or API access is disabled for this account."
        }]
      });
    }

    req.apiUser = user;
    next();
  } catch (error) {
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error during API authentication"
      }]
    });
  }
};

router.post('/', authenticateApi, async (req: any, res: any) => {
  const { action, parameters } = req.body;
  const user = req.apiUser;

  try {
    // 1. Parse incoming parameters from various formats (JSON string, Object, or flat form fields)
    let parsedParams: Record<string, any> = {};

    if (parameters) {
      if (typeof parameters === 'string') {
        try {
          parsedParams = JSON.parse(parameters);
        } catch {
          // If not JSON, might be raw value
          parsedParams = { raw: parameters };
        }
      } else if (typeof parameters === 'object' && parameters !== null) {
        parsedParams = { ...parameters };
      }
    }

    // Also pick up flat fields from req.body (e.g. ID, IMEI, customfield, etc.)
    for (const [key, value] of Object.entries(req.body)) {
      if (['username', 'apiaccesskey', 'key', 'apiKey', 'action', 'parameters'].includes(key)) continue;
      const match = key.match(/^parameters\[(.+)\]$/);
      if (match) {
        parsedParams[match[1]] = value;
      } else if (parsedParams[key] === undefined) {
        parsedParams[key] = value;
      }
    }

    const normalizedAction = (action || '').toString().toLowerCase().trim();

    switch (normalizedAction) {
      // ----------------------------------------------------
      // 1. Account Info
      // ----------------------------------------------------
      case 'accountinfo': {
        return res.json({
          SUCCESS: [{
            accoutinfo: {
              credit: user.balance.toFixed(2),
              balance: user.balance.toFixed(2),
              currency: "USD",
              mail: user.email,
              username: user.username,
              siteName: user.apiSiteName || "",
              siteUrl: user.apiSiteUrl || ""
            }
          }]
        });
      }

      // ----------------------------------------------------
      // 2. Service Lists (IMEI, Server, Remote)
      // ----------------------------------------------------
      case 'imeiservicelist':
      case 'serverservicelist':
      case 'remoteservicelist': {
        const isImei = normalizedAction === 'imeiservicelist';
        const isRemote = normalizedAction === 'remoteservicelist';
        const isServer = normalizedAction === 'serverservicelist';

        // Fetch active services that belong to an active provider or have no provider requirement
        const services = await prisma.dhruService.findMany({
          where: {
            isActive: true,
            OR: [
              { apiProvider: { isActive: true } },
              { providerId: null }
            ]
          },
          include: {
            dhruCategory: { select: { id: true, name: true } },
            apiProvider: { select: { id: true, name: true, isActive: true } }
          },
          orderBy: [
            { groupName: 'asc' },
            { name: 'asc' }
          ]
        });

        // Filter services matching the requested type
        const filteredServices = services.filter((srv) => {
          const srvType = resolveOrderServiceType(
            srv.apiServiceType,
            srv.dhruCategory?.name,
            srv.groupName
          );

          if (isImei) return srvType === 'imei';
          if (isRemote) return srvType === 'remote';
          if (isServer) return srvType === 'server';
          return true;
        });

        // Margin calculation: Default is strictly 8% profit margin added to provider base cost
        const marginPercent = typeof user.apiMargin === 'number' && user.apiMargin > 0
          ? user.apiMargin
          : 8.0;

        // Group services by their actual package name (groupName)
        const serviceList: Record<string, any> = {};

        for (const srv of filteredServices) {
          const groupName = (srv.groupName || 'General Services').trim();
          const groupKey = srv.categoryId || groupName.replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, '_');

          if (!serviceList[groupKey]) {
            serviceList[groupKey] = {
              GROUPNAME: groupName,
              SERVICES: []
            };
          }

          // Provider base price (cost)
          const baseCost = Math.max(0, srv.credit || 0);
          // Calculate price with 8% profit margin only: baseCost * (1 + 8/100)
          const finalPrice = Number((baseCost * (1 + (marginPercent / 100))).toFixed(4));

          // Parse and build custom fields specifications
          let customReq: any[] = [];
          if (srv.requiresCustom) {
            try {
              const parsed = typeof srv.requiresCustom === 'string' ? JSON.parse(srv.requiresCustom) : srv.requiresCustom;
              if (Array.isArray(parsed)) customReq = parsed;
              else if (typeof parsed === 'object' && parsed !== null) customReq = Object.values(parsed);
            } catch {}
          }

          const requiresFields: string[] = [];
          if (isImei) {
            requiresFields.push("IMEI");
          }

          for (const f of customReq) {
            const fname = f.name || f.fieldname || f.label || f.field_id;
            if (fname && !requiresFields.some(existing => existing.toLowerCase() === String(fname).toLowerCase())) {
              requiresFields.push(String(fname));
            }
          }

          if (requiresFields.length === 0 && isImei) {
            requiresFields.push("IMEI");
          }

          serviceList[groupKey].SERVICES.push({
            SERVICEID: srv.dhruId || srv.id,
            ID: srv.id,
            SERVICENAME: srv.name,
            CREDIT: finalPrice.toFixed(2),
            PRICE: finalPrice.toFixed(2),
            TIME: srv.time || "1-24 Hours",
            INFO: srv.info || "",
            GROUPNAME: groupName,
            Requires: requiresFields.join(","),
            RequiresCustom: customReq.length > 0 ? customReq : undefined,
            CUSTOM: customReq.length > 0 ? customReq : undefined,
            SupportsQty: srv.supportsQty,
            MIN_QNT: srv.minQty || 1,
            MAX_QNT: srv.maxQty || 0
          });
        }

        return res.json({
          SUCCESS: [{
            LIST: serviceList
          }]
        });
      }

      // ----------------------------------------------------
      // 3. Place Order (IMEI / Server)
      // ----------------------------------------------------
      case 'placeimeiorder':
      case 'placeserverorder': {
        const targetServiceId = String(
          parsedParams.ID ||
          parsedParams.SERVICEID ||
          parsedParams.serviceid ||
          parsedParams.id ||
          ''
        ).trim();

        if (!targetServiceId) {
          return res.json({ SUCCESS: [{ ERROR: "Service ID (ID) is required" }] });
        }

        // Support lookup by UUID or Provider DhruId
        const service = await prisma.dhruService.findFirst({
          where: {
            OR: [
              { id: targetServiceId },
              { dhruId: targetServiceId }
            ],
            isActive: true
          },
          include: {
            apiProvider: true,
            dhruCategory: true
          }
        });

        if (!service) {
          return res.json({ SUCCESS: [{ ERROR: "Service not found or inactive" }] });
        }

        const rawQty = parseInt(parsedParams.QNT || parsedParams.quantity || parsedParams.custom_QNT || '1', 10) || 1;
        const finalQty = service.supportsQty ? Math.max(service.minQty || 1, rawQty) : 1;

        // Base provider cost + 8% margin
        const baseCost = Math.max(0, service.credit || 0);
        const marginPercent = typeof user.apiMargin === 'number' && user.apiMargin > 0
          ? user.apiMargin
          : 8.0;

        const unitPrice = Number((baseCost * (1 + (marginPercent / 100))).toFixed(4));
        const finalTotalPrice = Number((unitPrice * finalQty).toFixed(2));

        // Balance validation
        if (user.balance < finalTotalPrice) {
          return res.json({
            SUCCESS: [{
              ERROR: `Insufficient balance! Total required: $${finalTotalPrice.toFixed(2)} USD. Your balance: $${user.balance.toFixed(2)} USD. Please deposit funds first.`
            }]
          });
        }

        // Parse custom field parameters (handle Base64 JSON, JSON string, or Object)
        let customFieldsObj: Record<string, string> = {};
        const rawCustomField = parsedParams.customfield || parsedParams.CUSTOMFIELD;

        if (rawCustomField) {
          if (typeof rawCustomField === 'string') {
            try {
              // Try base64 decode first
              const decoded = Buffer.from(rawCustomField, 'base64').toString('utf8');
              const parsed = JSON.parse(decoded);
              if (parsed && typeof parsed === 'object') customFieldsObj = parsed;
            } catch {
              try {
                const parsed = JSON.parse(rawCustomField);
                if (parsed && typeof parsed === 'object') customFieldsObj = parsed;
              } catch {
                customFieldsObj = { custom: rawCustomField };
              }
            }
          } else if (typeof rawCustomField === 'object' && rawCustomField !== null) {
            customFieldsObj = { ...rawCustomField };
          }
        }

        // Support flat parameters starting with custom_
        for (const [pKey, pVal] of Object.entries(parsedParams)) {
          if (pKey.startsWith('custom_') && pVal !== undefined && pVal !== null) {
            customFieldsObj[pKey] = String(pVal);
            customFieldsObj[pKey.replace(/^custom_/, '')] = String(pVal);
          }
        }

        const rawImei = (
          parsedParams.IMEI ||
          parsedParams.imei ||
          parsedParams.sn ||
          parsedParams.serial ||
          ''
        ).toString().trim();

        // Determine final target input
        let finalTargetInput = rawImei;
        if (!finalTargetInput && Object.keys(customFieldsObj).length > 0) {
          const firstVal = Object.values(customFieldsObj)[0];
          finalTargetInput = String(firstVal);
        }
        if (!finalTargetInput) {
          finalTargetInput = `API-${user.username}`;
        }

        // Structure timeline events and notes for dashboard inspection
        const now = new Date();
        const timelineEvents = [
          {
            time: now.toISOString(),
            action: 'API_ORDER_CREATED',
            title: 'استلام طلب عبر الـ API وخصم الرصيد',
            desc: `تم استلام الطلب بنجاح عبر API من موقع (${user.apiSiteName || 'بدون اسم موقع'}) بواسطة العميل (@${user.username}) وخصم $${finalTotalPrice.toFixed(2)} USD من رصيد محفظته. الطلب في انتظار مراجعة وموافقة الإدارة.`
          }
        ];

        if (service.apiProvider) {
          timelineEvents.push({
            time: now.toISOString(),
            action: 'PROVIDER_LINKED',
            title: 'ربط المزود',
            desc: `الخدمة مربوطة بالمزود (${service.apiProvider.name}) برقم خدمة #${service.dhruId}. الطلب في انتظار موافقة الإدارة للإرسال للمزود أو التنفيذ اليدوي.`
          });
        }

        const mergedCustomFields: Record<string, string> = { ...customFieldsObj };
        if (service.supportsQty) {
          mergedCustomFields['QNT'] = String(finalQty);
          mergedCustomFields['custom_QNT'] = String(finalQty);
        }

        const structuredNotes = JSON.stringify({
          userNote: `طلب API وارد من موقع: ${user.apiSiteName || 'N/A'} (العميل: @${user.username})`,
          rawImei: rawImei || finalTargetInput,
          customFields: Object.keys(mergedCustomFields).length > 0 ? mergedCustomFields : null,
          apiDetails: {
            username: user.username,
            email: user.email,
            fullName: user.fullName,
            siteName: user.apiSiteName || null,
            siteUrl: user.apiSiteUrl || null,
            apiKey: user.apiKey ? user.apiKey.slice(0, 8) + '...' : null,
            margin: marginPercent
          },
          originalPrice: baseCost * finalQty,
          finalPrice: finalTotalPrice,
          events: timelineEvents
        });

        // Deduct balance, record transaction, and create order with status: 'pending'
        const order = await prisma.$transaction(async (tx: any) => {
          const updatedUser = await tx.user.update({
            where: { id: user.id },
            data: { balance: { decrement: finalTotalPrice } }
          });

          await tx.transaction.create({
            data: {
              userId: user.id,
              type: `طلب API: ${service.name.slice(0, 35)}`,
              amount: finalTotalPrice,
              method: 'رصيد API',
              status: 'completed',
              refNo: `API-${Date.now()}`
            }
          });

          const newOrder = await tx.order.create({
            data: {
              userId: user.id,
              serviceId: service.id,
              serviceName: service.name,
              targetInput: finalTargetInput,
              quantity: finalQty,
              price: finalTotalPrice,
              status: 'pending',
              source: 'api',
              notes: structuredNotes,
              apiClientOrderId: parsedParams.clientorderid || parsedParams.apiClientOrderId || null
            }
          });

          return newOrder;
        });

        // Send Telegram alert to admin for manual approval
        const providerName = service.apiProvider?.name || 'سيرفر محلي / يدوي';
        const caption = `
🛍️ <b>طلب API جديد في انتظار موافقة الإدارة! (New API Order Pending)</b>

💳 <b>رقم الطلب:</b> #${order.id.slice(-6)}
🌐 <b>مصدر الطلب:</b> API (${user.apiSiteName || 'موقع عميل'})
🔗 <b>رابط الموقع:</b> ${user.apiSiteUrl || 'N/A'}
👤 <b>العميل:</b> ${user.fullName} (@${user.username})
📧 <b>الإيميل:</b> <code>${user.email}</code>
📱 <b>اسم الخدمة:</b> ${order.serviceName}
🏢 <b>المزود المربوط:</b> ${providerName} (ID: ${service.dhruId || 'N/A'})
🔢 <b>البيانات / IMEI:</b> <code>${order.targetInput}</code>
📦 <b>الكمية:</b> ${order.quantity}
💰 <b>المبلغ المخصوم (تكلفة + 8% ربح):</b> <code>$${order.price.toFixed(2)} USD</code>
🏦 <b>رصيد العميل المتبقي:</b> <code>$${(user.balance - finalTotalPrice).toFixed(2)} USD</code>
📅 <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}

⏳ <b>الحالة:</b> في انتظار مراجعة وموافقة الإدارة بالداشبورد
        `.trim();

        sendTelegramPhotoNotification({ caption }).catch((err) => {
          console.error('[API Order Telegram Alert Error]:', err?.message || err);
        });

        return res.json({
          SUCCESS: [{
            MESSAGE: "Order placed successfully and is pending admin approval",
            REFERENCEID: order.id
          }]
        });
      }

      // ----------------------------------------------------
      // 4. Check Order Status & Retrieve Code (IMEI & Server)
      // ----------------------------------------------------
      case 'getimeiorder':
      case 'getserverorder':
      case 'getorder': {
        const orderId = String(
          parsedParams.ID ||
          parsedParams.orderid ||
          parsedParams.referenceid ||
          parsedParams.id ||
          ''
        ).trim();

        if (!orderId) {
          return res.json({ SUCCESS: [{ ERROR: "Order ID (ID) is required" }] });
        }

        const order = await prisma.order.findUnique({
          where: { id: orderId }
        });

        if (!order || order.userId !== user.id) {
          return res.json({ SUCCESS: [{ ERROR: "Order not found" }] });
        }

        // Dhru Standard Status Codes:
        // 1 = Pending (في انتظار الموافقة)
        // 2 = In Process (قيد التنفيذ بالمزود)
        // 3 = Rejected / Cancelled (ملغي ومسترجع)
        // 4 = Success / Completed (مكتمل ومسلم)
        let statusCode = "1";
        let statusMessage = "Pending admin verification and approval";
        let replyCode = "";

        if (order.status === 'completed') {
          statusCode = "4";
          statusMessage = "Order completed successfully";
          replyCode = order.reply || "Completed";
        } else if (order.status === 'rejected' || order.status === 'cancelled') {
          statusCode = "3";
          statusMessage = "Order rejected or cancelled by admin";
          replyCode = order.reply || "Rejected by admin";
        } else if (order.status === 'processing') {
          statusCode = "2";
          statusMessage = "Order in process with provider";
          replyCode = "In process";
        } else {
          statusCode = "1";
          statusMessage = "Order pending admin approval";
          replyCode = "Pending";
        }

        return res.json({
          SUCCESS: [{
            STATUS: statusCode,
            CODE: replyCode,
            MESSAGE: statusMessage,
            REFERENCEID: order.id
          }]
        });
      }

      default: {
        return res.status(400).json({
          SUCCESS: [{
            ERROR: `Action "${action}" is not supported.`
          }]
        });
      }
    }
  } catch (error: any) {
    console.error("API error:", error);
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error"
      }]
    });
  }
});

export default router;
