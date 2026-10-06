import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { prisma } from '../utils/prisma';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { extractClientIp, areIpsEqual } from '../utils/ipUtils';
import {
  getUnifiedSections,
  getUnifiedServices,
  getUnifiedPackages,
  getUnifiedCatalogTree,
  getDhruCompatibleMergedCatalog
} from '../services/unifiedCatalogService';
import {
  callFoxreloadApi,
  createAndDispatchFoxreloadOrder,
  getFoxreloadOrderDetails
} from '../services/foxreloadService';

const router = Router();

// IP-based global rate limit
const externalApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200,
  message: {
    SUCCESS: [{
      ERROR: "Too many requests. Global rate limit exceeded, please try again in a minute."
    }]
  },
  validate: { xForwardedForHeader: false }
});

router.use(externalApiLimiter);

// Per-account sliding window rate limiter (anti-scraping / bot prevention)
const accountRateLimits = new Map<string, { count: number; resetAt: number }>();
const ACCOUNT_RATE_LIMIT_PER_MINUTE = 180;

const checkAccountRateLimit = (userId: string): boolean => {
  const now = Date.now();
  const entry = accountRateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    accountRateLimits.set(userId, { count: 1, resetAt: now + 60000 });
    return true;
  }
  entry.count++;
  return entry.count <= ACCOUNT_RATE_LIMIT_PER_MINUTE;
};

// Middleware to authenticate API requests with username and API key
export const authenticateApi = async (req: any, res: any, next: any) => {
  try {
    const authHeader = req.headers.authorization || '';
    let bearerKey = '';
    if (authHeader.toLowerCase().startsWith('bearer ')) {
      bearerKey = authHeader.slice(7).trim();
    }

    const apiKey = (
      bearerKey ||
      req.headers['x-api-key'] ||
      req.body?.apiaccesskey ||
      req.body?.key ||
      req.body?.apiKey ||
      req.query?.apiaccesskey ||
      req.query?.key ||
      req.query?.apiKey ||
      ''
    ).toString().trim();

    const username = (
      req.headers['x-username'] ||
      req.body?.username ||
      req.query?.username ||
      ''
    ).toString().trim();

    if (!apiKey) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Missing API Key. Please provide your key via Authorization header (Bearer <KEY>), x-api-key header, or body payload."
        }]
      });
    }

    // Security warning header when API key is passed in URL query
    if (req.query?.apiaccesskey || req.query?.key || req.query?.apiKey) {
      res.setHeader('X-Security-Warning', 'Passing API key in query parameters is insecure. Please use Authorization header or request body.');
    }

    const userWhere: any = {
      apiKey,
      apiEnabled: true
    };

    if (username) {
      userWhere.OR = [
        { username: { equals: username, mode: 'insensitive' } },
        { email: { equals: username, mode: 'insensitive' } }
      ];
    }

    const user = await prisma.user.findFirst({
      where: userWhere
    });

    if (!user) {
      return res.status(401).json({
        SUCCESS: [{
          ERROR: "Authentication failed. Invalid API credentials or API access is disabled."
        }]
      });
    }

    if (user.status === 'suspended') {
      return res.status(403).json({
        SUCCESS: [{
          ERROR: "Account is suspended. API access is blocked."
        }]
      });
    }

    // IP Whitelist Check
    if (user.apiAllowedIps && user.apiAllowedIps.trim() !== '') {
      const clientIp = extractClientIp(req);
      const allowedList = user.apiAllowedIps
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      if (allowedList.length > 0) {
        const isAllowed = allowedList.some((allowedIp) => areIpsEqual(allowedIp, clientIp));
        if (!isAllowed) {
          return res.status(403).json({
            SUCCESS: [{
              ERROR: `Access denied. Client IP (${clientIp}) is not authorized for this API key. Update allowed IPs in your dashboard.`
            }]
          });
        }
      }
    }

    // Per-Account Rate Limit Check
    if (!checkAccountRateLimit(user.id)) {
      return res.status(429).json({
        SUCCESS: [{
          ERROR: `Account rate limit exceeded (${ACCOUNT_RATE_LIMIT_PER_MINUTE} reqs/min). Please throttle your requests.`
        }]
      });
    }

    req.apiUser = user;
    next();
  } catch (error: any) {
    console.error('[authenticateApi error]:', error?.message || error);
    return res.status(500).json({
      SUCCESS: [{
        ERROR: `Internal Server Error during API authentication: ${error?.message || String(error)}`
      }]
    });
  }
};

router.use(authenticateApi);

// Helper to calculate margin
const getUserMargin = (user: any): number => {
  return typeof user.apiMargin === 'number' && user.apiMargin >= 0
    ? user.apiMargin
    : 8.0;
};

// ----------------------------------------------------------------------
// REST Endpoints: Hierarchical Branching (الأقسام -> الخدمات -> الباقات)
// ----------------------------------------------------------------------

// 1. GET /sections - All Top-Level Categories/Sections
router.get('/sections', async (_req: any, res) => {
  try {
    const sections = await getUnifiedSections();
    return res.json({
      success: true,
      count: sections.length,
      sections
    });
  } catch (error: any) {
    console.error('[API sections error]:', error?.message || error);
    return res.status(500).json({ success: false, error: "Failed to load sections", details: error?.message });
  }
});

// 2. GET /services - Services / Games under a specific section
router.get('/services', async (req: any, res) => {
  try {
    const section = (req.query.section || req.query.sectionId || '').toString();
    const services = await getUnifiedServices(section);
    return res.json({
      success: true,
      section: section || 'all',
      count: services.length,
      services
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Failed to load services" });
  }
});

// 3. GET /service/:serviceId/packages - Packages for a specific service / game
router.get('/service/:serviceId/packages', async (req: any, res) => {
  try {
    const { serviceId } = req.params;
    const margin = getUserMargin(req.apiUser);
    const result = await getUnifiedPackages(serviceId, margin);
    return res.json({
      success: true,
      serviceId,
      serviceName: result.serviceName,
      sectionId: result.sectionId,
      marginPercent: margin,
      count: result.packages.length,
      packages: result.packages
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Failed to load packages" });
  }
});

// 4. GET /tree - Complete Hierarchical Catalog Tree
router.get('/tree', async (req: any, res) => {
  try {
    const margin = getUserMargin(req.apiUser);
    const tree = await getUnifiedCatalogTree(margin);
    return res.json(tree);
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Failed to load catalog tree" });
  }
});

// ----------------------------------------------------------------------
// Unified Order Placement Logic (DHRU + FoxReload Games/Cards)
// ----------------------------------------------------------------------
async function executeOrderPlacement(req: any, res: any, parsedParams: Record<string, any>) {
  const user = req.apiUser;
  const targetServiceId = String(
    parsedParams.ID ||
    parsedParams.SERVICEID ||
    parsedParams.serviceid ||
    parsedParams.id ||
    parsedParams.productId ||
    ''
  ).trim();

  if (!targetServiceId) {
    return res.json({ SUCCESS: [{ ERROR: "Service ID (ID) is required" }] });
  }

  const rawQty = parseInt(parsedParams.QNT || parsedParams.quantity || parsedParams.custom_QNT || '1', 10) || 1;
  const finalQty = Math.max(1, rawQty);

  // Parse custom parameters
  let customFieldsObj: Record<string, string> = {};
  const rawCustomField = parsedParams.customfield || parsedParams.CUSTOMFIELD;
  if (rawCustomField) {
    if (typeof rawCustomField === 'string') {
      try {
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

  let finalTargetInput = rawImei;
  if (!finalTargetInput && Object.keys(customFieldsObj).length > 0) {
    const firstVal = Object.values(customFieldsObj)[0];
    finalTargetInput = String(firstVal);
  }
  if (!finalTargetInput) {
    finalTargetInput = `API-${user.username}`;
  }

  // Idempotency check
  const clientOrderId = parsedParams.clientorderid || parsedParams.apiClientOrderId || req.headers['x-idempotency-key'];
  if (clientOrderId) {
    const cleanClientOrderId = String(clientOrderId).trim();
    const existingClientOrder = await prisma.order.findFirst({
      where: {
        userId: user.id,
        apiClientOrderId: cleanClientOrderId
      }
    });
    if (existingClientOrder) {
      return res.json({
        SUCCESS: [{
          REFERENCEID: existingClientOrder.id,
          STATUS: existingClientOrder.status === 'completed' ? '4' : (existingClientOrder.status === 'processing' ? '2' : '1'),
          CODE: existingClientOrder.reply || undefined,
          MESSAGE: "Order already submitted with this client order ID"
        }]
      });
    }
  }

  const marginPercent = getUserMargin(user);

  // Check if target is a Dhru service
  const dhruService = await prisma.dhruService.findFirst({
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

  // Check if target is a FoxReload product
  let foxProduct: any = null;
  if (!dhruService) {
    const foxRes = await callFoxreloadApi(`/api/products/${encodeURIComponent(targetServiceId)}`, 'GET');
    if (foxRes.ok && foxRes.data) {
      foxProduct = foxRes.data;
    }
  }

  if (!dhruService && !foxProduct) {
    return res.json({ SUCCESS: [{ ERROR: "Service not found or inactive" }] });
  }

  // Calculate pricing
  const baseCost = dhruService
    ? Math.max(0, dhruService.credit || 0)
    : Math.max(0, parseFloat(foxProduct.price || '0') || 0);

  const unitPrice = Number((baseCost * (1 + marginPercent / 100)).toFixed(4));
  const finalTotalPrice = Number((unitPrice * finalQty).toFixed(2));

  // Balance Check
  if (user.balance < finalTotalPrice) {
    return res.json({
      SUCCESS: [{
        ERROR: `Insufficient balance! Total required: $${finalTotalPrice.toFixed(2)} USD. Your balance: $${user.balance.toFixed(2)} USD. Please deposit funds first.`
      }]
    });
  }

  // Daily Spending Limit Check
  if (user.apiDailyLimit && user.apiDailyLimit > 0) {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayOrdersTotal = await prisma.order.aggregate({
      where: {
        userId: user.id,
        source: 'api',
        createdAt: { gte: startOfDay },
        status: { notIn: ['cancelled', 'rejected'] }
      },
      _sum: { price: true }
    });

    const currentSpent = todayOrdersTotal._sum.price || 0;
    if (currentSpent + finalTotalPrice > user.apiDailyLimit) {
      return res.json({
        SUCCESS: [{
          ERROR: `Daily API spending limit exceeded! Limit: $${user.apiDailyLimit.toFixed(2)}, Spent today: $${currentSpent.toFixed(2)}.`
        }]
      });
    }
  }

  // ----------------------------------------------------
  // Scenario A: FoxReload Gaming / Digital Product
  // ----------------------------------------------------
  if (foxProduct) {
    const notesPayload: Record<string, any> = {};
    const reqNoteFields = Array.isArray(foxProduct.requiredNoteFields) ? foxProduct.requiredNoteFields : [];

    for (const field of reqNoteFields) {
      const fieldVal = customFieldsObj[field] ||
        parsedParams[field] ||
        (field === 'account_id' || field === 'player_id' || field === 'id' ? finalTargetInput : undefined);

      if (fieldVal) {
        notesPayload[field] = fieldVal;
      }
    }

    if (Object.keys(notesPayload).length === 0 && finalTargetInput) {
      notesPayload['account_id'] = finalTargetInput;
    }

    const structuredNotes = JSON.stringify({
      userNote: `طلب API ألعاب: ${foxProduct.name} من (@${user.username})`,
      targetInput: finalTargetInput,
      foxreloadNotes: notesPayload,
      customFields: customFieldsObj,
      productDetails: {
        id: foxProduct.id,
        name: foxProduct.name,
        cost: baseCost,
        finalPrice: finalTotalPrice,
        margin: marginPercent
      }
    });

    let createdOrder: any = null;
    try {
      createdOrder = await prisma.$transaction(async (tx) => {
        const updated = await tx.user.updateMany({
          where: { id: user.id, balance: { gte: finalTotalPrice } },
          data: { balance: { decrement: finalTotalPrice } }
        });

        if (updated.count === 0) {
          throw new Error('INSUFFICIENT_BALANCE_RACE');
        }

        await tx.transaction.create({
          data: {
            userId: user.id,
            type: `طلب API: ${foxProduct.name.slice(0, 35)}`,
            amount: finalTotalPrice,
            method: 'رصيد API',
            status: 'completed',
            refNo: `API-${Date.now()}`
          }
        });

        return await tx.order.create({
          data: {
            userId: user.id,
            serviceId: foxProduct.id,
            serviceName: foxProduct.name,
            targetInput: finalTargetInput,
            quantity: finalQty,
            price: finalTotalPrice,
            status: 'processing',
            source: 'api',
            notes: structuredNotes,
            apiClientOrderId: clientOrderId ? String(clientOrderId).trim() : null
          }
        });
      });
    } catch (err: any) {
      if (err.message === 'INSUFFICIENT_BALANCE_RACE') {
        return res.json({ SUCCESS: [{ ERROR: "Insufficient balance during transaction" }] });
      }
      throw err;
    }

    // Dispatch directly to FoxReload provider
    const dispatchRes = await createAndDispatchFoxreloadOrder({
      productId: foxProduct.id,
      quantity: finalQty,
      notes: notesPayload
    });

    if (!dispatchRes.success) {
      // Revert transaction and refund client
      await prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { balance: { increment: finalTotalPrice } }
        });
        await tx.order.update({
          where: { id: createdOrder.id },
          data: {
            status: 'cancelled',
            reply: `فشل التنفيذ لدى المزود: ${dispatchRes.error}`
          }
        });
        await tx.transaction.create({
          data: {
            userId: user.id,
            type: `استرجاع طلب API: ${foxProduct.name.slice(0, 35)}`,
            amount: finalTotalPrice,
            method: 'استرجاع تلقائي',
            status: 'completed',
            refNo: `REFUND-${Date.now()}`
          }
        });
      });

      return res.json({
        SUCCESS: [{
          ERROR: `Failed to fulfill with provider: ${dispatchRes.error || 'Provider rejected order'}`
        }]
      });
    }

    const codesList = Array.isArray(dispatchRes.codes) ? dispatchRes.codes : [];
    const hasCodes = codesList.length > 0;
    const isCompleted = dispatchRes.status === 'completed' || dispatchRes.status === 'finished' || hasCodes;
    const replyText = hasCodes ? codesList.join('\n') : (isCompleted ? 'تم الشحن والتفعيل بنجاح' : undefined);

    await prisma.order.update({
      where: { id: createdOrder.id },
      data: {
        status: isCompleted ? 'completed' : 'processing',
        apiOrderId: dispatchRes.orderId ? String(dispatchRes.orderId) : null,
        reply: replyText
      }
    });

    return res.json({
      SUCCESS: [{
        MESSAGE: isCompleted ? "Order completed and delivered successfully" : "Order placed and is currently processing",
        REFERENCEID: createdOrder.id,
        STATUS: isCompleted ? "4" : "2",
        CODE: replyText || undefined
      }]
    });
  }

  // ----------------------------------------------------
  // Scenario B: DHRU IMEI / Server Service
  // ----------------------------------------------------
  if (!dhruService) {
    return res.json({ SUCCESS: [{ ERROR: "Service not found or inactive" }] });
  }

  if (dhruService.supportsQty) {
    if (dhruService.minQty && finalQty < dhruService.minQty) {
      return res.json({ SUCCESS: [{ ERROR: `Quantity is less than minimum limit (${dhruService.minQty})` }] });
    }
    if (dhruService.maxQty && dhruService.maxQty > 0 && finalQty > dhruService.maxQty) {
      return res.json({ SUCCESS: [{ ERROR: `Quantity exceeds maximum limit (${dhruService.maxQty})` }] });
    }
  }

  const structuredNotes = JSON.stringify({
    userNote: `طلب API: ${user.apiSiteName || 'موقع عميل'} (@${user.username})`,
    rawImei: rawImei || finalTargetInput,
    customFields: customFieldsObj,
    apiDetails: {
      username: user.username,
      email: user.email,
      margin: marginPercent
    },
    originalPrice: baseCost * finalQty,
    finalPrice: finalTotalPrice
  });

  let order: any;
  try {
    order = await prisma.$transaction(async (tx) => {
      const updatedUser = await tx.user.updateMany({
        where: { id: user.id, balance: { gte: finalTotalPrice } },
        data: { balance: { decrement: finalTotalPrice } }
      });

      if (updatedUser.count === 0) {
        throw new Error('INSUFFICIENT_BALANCE_RACE');
      }

      await tx.transaction.create({
        data: {
          userId: user.id,
          type: `طلب API: ${dhruService.name.slice(0, 35)}`,
          amount: finalTotalPrice,
          method: 'رصيد API',
          status: 'completed',
          refNo: `API-${Date.now()}`
        }
      });

      return await tx.order.create({
        data: {
          userId: user.id,
          serviceId: dhruService.id,
          serviceName: dhruService.name,
          targetInput: finalTargetInput,
          quantity: finalQty,
          price: finalTotalPrice,
          status: 'pending',
          source: 'api',
          notes: structuredNotes,
          apiClientOrderId: clientOrderId ? String(clientOrderId).trim() : null
        }
      });
    });
  } catch (err: any) {
    if (err.message === 'INSUFFICIENT_BALANCE_RACE') {
      return res.json({ SUCCESS: [{ ERROR: "Insufficient balance during transaction" }] });
    }
    throw err;
  }

  const providerName = dhruService.apiProvider?.name || 'سيرفر محلي / يدوي';
  const caption = `
[NEW API ORDER] <b>طلب API جديد في انتظار اعتماد الإدارة</b>

<b>رقم الطلب:</b> #${order.id.slice(-6)}
<b>العميل:</b> ${user.fullName} (@${user.username})
<b>الخدمة:</b> ${order.serviceName}
<b>المزود:</b> ${providerName}
<b>البيانات:</b> <code>${order.targetInput}</code>
<b>المبلغ:</b> $${order.price.toFixed(2)} USD
  `.trim();

  sendTelegramPhotoNotification({ caption }).catch(() => {});

  return res.json({
    SUCCESS: [{
      MESSAGE: "Order placed successfully and is pending admin approval",
      REFERENCEID: order.id,
      STATUS: "1"
    }]
  });
}

// ----------------------------------------------------------------------
// Root Handler (Dhru Action-Based Protocol Compatibility)
// ----------------------------------------------------------------------
router.all(['/', '/index.php', '/provider', '/api'], async (req: any, res: any) => {
  const action = req.body?.action || req.query?.action || req.headers?.['x-action'];
  const parameters = req.body?.parameters || req.query?.parameters;
  const user = req.apiUser;

  const writeActions = ['placeimeiorder', 'placeserverorder', 'placeorder'];
  if (writeActions.includes(String(action).toLowerCase()) && req.method === 'GET') {
    return res.status(405).json({
      SUCCESS: [{
        ERROR: "HTTP GET method is not allowed for order placement. Please use POST."
      }]
    });
  }

  try {
    let parsedParams: Record<string, any> = {};
    if (parameters) {
      if (typeof parameters === 'string') {
        try {
          parsedParams = JSON.parse(parameters);
        } catch {
          parsedParams = { raw: parameters };
        }
      } else if (typeof parameters === 'object' && parameters !== null) {
        parsedParams = { ...parameters };
      }
    }

    const combinedInput = { ...(req.query || {}), ...(req.body || {}) };
    for (const [key, value] of Object.entries(combinedInput)) {
      if (['username', 'apiaccesskey', 'key', 'apiKey', 'action', 'parameters'].includes(key)) continue;
      const match = key.match(/^parameters\[(.+)\]$/);
      if (match) {
        parsedParams[match[1]] = value;
      } else if (parsedParams[key] === undefined) {
        parsedParams[key] = value;
      }
    }

    const normalizedAction = (action || '').toString().toLowerCase().trim();
    const margin = getUserMargin(user);

    switch (normalizedAction) {
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
              siteUrl: user.apiSiteUrl || "",
              dailyLimit: user.apiDailyLimit || null
            }
          }]
        });
      }

      // Modern hierarchical branching actions
      case 'sections':
      case 'getsections': {
        const sections = await getUnifiedSections();
        return res.json({
          SUCCESS: [{
            LIST: sections,
            SECTIONS: sections,
            total_sections: sections.length
          }]
        });
      }

      case 'servicesbysection':
      case 'getservicesbysection': {
        const targetSection = parsedParams.section || parsedParams.sectionId || parsedParams.id;
        const services = await getUnifiedServices(targetSection);
        return res.json({
          SUCCESS: [{
            LIST: services,
            SERVICES: services,
            section: targetSection || 'all',
            total_services: services.length
          }]
        });
      }

      case 'packagesbyservice':
      case 'getpackages': {
        const serviceId = parsedParams.serviceId || parsedParams.id || parsedParams.bundleId;
        if (!serviceId) {
          return res.json({ SUCCESS: [{ ERROR: "Service ID is required" }] });
        }
        const result = await getUnifiedPackages(serviceId, margin);
        return res.json({
          SUCCESS: [{
            LIST: result.packages,
            PACKAGES: result.packages,
            serviceName: result.serviceName,
            sectionId: result.sectionId,
            total_packages: result.packages.length
          }]
        });
      }

      case 'catalogtree':
      case 'getcatalogtree': {
        const tree = await getUnifiedCatalogTree(margin);
        return res.json({
          SUCCESS: [{
            TREE: tree,
            total_sections: tree.totalSections
          }]
        });
      }

      // Dhru Standard Service Lists (Now fully merged with FoxReload games & cards)
      case 'imeiservicelist':
      case 'serverservicelist':
      case 'remoteservicelist':
      case 'servicelist':
      case 'serviceslist':
      case 'getservicelist':
      case 'getservices':
      case 'services': {
        const filterType: 'imei' | 'server' | 'all' =
          normalizedAction === 'imeiservicelist' ? 'imei' :
          normalizedAction === 'serverservicelist' ? 'server' : 'all';

        const targetSection = (parsedParams.section || parsedParams.sectionId || parsedParams.category || req.query?.section || req.query?.category || '').toString();
        const { groupsList, groupsObject, totalServices } = await getDhruCompatibleMergedCatalog(margin, filterType, targetSection);
        const isObjectFormat = req.query.format === 'object' || parsedParams.format === 'object';
        const listPayload = isObjectFormat ? groupsObject : groupsList;

        return res.json({
          SUCCESS: [{
            LIST: listPayload,
            GROUPS: groupsList,
            PACKAGES: groupsList,
            serviceList: groupsList,
            total_groups: groupsList.length,
            total_services: totalServices
          }]
        });
      }

      // Place Order
      case 'placeimeiorder':
      case 'placeserverorder':
      case 'placeorder': {
        return await executeOrderPlacement(req, res, parsedParams);
      }

      // Check Order Status
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

        // If order was a FoxReload order currently processing, sync live status
        if (order.status === 'processing' && order.apiOrderId) {
          const liveDetails = await getFoxreloadOrderDetails(order.apiOrderId);
          if (liveDetails.success) {
            if (liveDetails.status === 'completed') {
              const replyCode = liveDetails.reply || liveDetails.codes.join('\n') || 'Completed';
              await prisma.order.update({
                where: { id: order.id },
                data: { status: 'completed', reply: replyCode }
              });
              order.status = 'completed';
              order.reply = replyCode;
            } else if (liveDetails.status === 'rejected') {
              await prisma.order.update({
                where: { id: order.id },
                data: { status: 'rejected', reply: liveDetails.error || 'Cancelled by provider' }
              });
              order.status = 'rejected';
            }
          }
        }

        let statusCode = "1";
        let statusMessage = "Pending admin verification";
        let replyCode = "";

        if (order.status === 'completed') {
          statusCode = "4";
          statusMessage = "Order completed successfully";
          replyCode = order.reply || "Completed";
        } else if (order.status === 'rejected' || order.status === 'cancelled') {
          statusCode = "3";
          statusMessage = "Order rejected or cancelled";
          replyCode = order.reply || "Rejected";
        } else if (order.status === 'processing') {
          statusCode = "2";
          statusMessage = "Order in process with provider";
          replyCode = "In process";
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
    console.error("API Error:", error);
    return res.status(500).json({
      SUCCESS: [{
        ERROR: "Internal Server Error"
      }]
    });
  }
});

export default router;
