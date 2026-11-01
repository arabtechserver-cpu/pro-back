import { BoundedRateLimitStore } from '../utils/bounded-rate-limit-store';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from "../utils/prisma";
import { isAdmin } from '../middleware/auth';
import { enrichOrdersWithProviderData } from './orders';

const router = Router();

const EVENT_BODY_BYTES = 8192;
const EVENT_METADATA_BYTES = 4096;
const SUMMARY_GROUP_LIMIT = 10000;
const SUMMARY_DETAIL_LIMIT = 100;

function summaryCount(value: bigint | number): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('Analytics count exceeds safe numeric range.');
  return count;
}

function analyticsText(maxBytes: number) {
  return z.string().superRefine((value, ctx) => {
    if (Buffer.byteLength(value, 'utf8') > maxBytes) {
      ctx.addIssue({ code: 'too_big', origin: 'string', maximum: maxBytes, inclusive: true, message: 'Analytics field exceeds byte limit.' });
    } else if (value.includes('\0') || Buffer.from(value, 'utf8').toString('utf8') !== value) {
      ctx.addIssue({ code: 'custom', message: 'Invalid analytics text.' });
    }
  });
}

const eventFields = {
  sessionId: analyticsText(400).max(100).nullish(),
  path: analyticsText(2000).max(500).nullish(),
};
const visitorFields = {
  userAgent: analyticsText(2048).nullish(),
  userName: analyticsText(400).nullish(),
  userEmail: analyticsText(1024).nullish(),
};
// These are the payloads sent by AnalyticsTracker and PurchaseClient.
const eventSchema = z.discriminatedUnion('eventName', [
  z.strictObject({
    eventName: z.literal('page_view'),
    ...eventFields,
    metadata: z.strictObject({
      ...visitorFields,
      timestamp: analyticsText(32).pipe(z.iso.datetime()).optional(),
    }).nullish(),
  }),
  z.strictObject({
    eventName: z.literal('service_view'),
    ...eventFields,
    metadata: z.strictObject({
      ...visitorFields,
      serviceId: analyticsText(200).trim().min(1),
      serviceName: analyticsText(1024).optional(),
    }),
  }),
]);

const analyticsLimiter = rateLimit({
  store: new BoundedRateLimitStore(),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Too many requests' },
  validate: { xForwardedForHeader: false }
});

// POST /api/analytics/events - Log an anonymous or authenticated conversion event
router.post('/events', analyticsLimiter, async (req, res) => {
  try {
    const parsed = eventSchema.safeParse(req.body);
    if (!parsed.success) {
      const oversized = parsed.error.issues.some(issue => issue.code === 'too_big');
      return res.status(oversized ? 413 : 400).json({ error: oversized ? 'Analytics event is too large.' : 'حدث غير صالح.' });
    }
    const { eventName, sessionId, path, metadata } = parsed.data;
    const serializedMetadata = metadata == null ? null : JSON.stringify(metadata);
    // Validate the flat shape before serializing, including when called without the route parser.
    if ((serializedMetadata && Buffer.byteLength(serializedMetadata, 'utf8') > EVENT_METADATA_BYTES) ||
        Buffer.byteLength(JSON.stringify(parsed.data), 'utf8') > EVENT_BODY_BYTES) {
      return res.status(413).json({ error: 'Analytics event is too large.' });
    }

    await prisma.analyticsEvent.create({
      data: {
        eventName,
        sessionId: sessionId?.trim() || null,
        path: path?.trim() || null,
        metadata: serializedMetadata,
      }
    });

    return res.status(202).json({ accepted: true });
  } catch (error: any) {
    console.error('Analytics event error:', error);
    return res.status(500).json({ error: 'تعذر تسجيل الحدث.' });
  }
});

// GET /api/analytics/summary - Get overall analytics summary (Admin only)
router.get('/summary', isAdmin, async (req, res) => {
  try {
    const requestedDays = Number(req.query.days);
    const days = [7, 30, 90].includes(requestedDays) ? requestedDays : 30;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const data = await prisma.$transaction(async tx => {
      // Fail an expensive report explicitly, rather than returning sampled totals.
      // These settings are transaction-local and do not change the database configuration.
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      await tx.$executeRaw`SET LOCAL statement_timeout = '5s'`;
      await tx.$executeRaw`SET LOCAL work_mem = '4MB'`;
      await tx.$executeRaw`SET LOCAL TIME ZONE 'UTC'`;

      const [totals] = await tx.$queryRaw<{ totalUsers: bigint; totalOrders: bigint; uniqueSessions: bigint }[]>`
        SELECT
          (SELECT COUNT(*) FROM "User" WHERE "role" = 'user') AS "totalUsers",
          (SELECT COUNT(*) FROM "Order") AS "totalOrders",
          COUNT(DISTINCT NULLIF("sessionId", '')) AS "uniqueSessions"
        FROM "AnalyticsEvent" WHERE "createdAt" >= ${cutoffDate}`;

      const groups = await tx.$queryRaw<{ day: string; eventName: string | null; count: bigint }[]>`
        SELECT to_char("createdAt", 'YYYY-MM-DD') AS "day",
          CASE WHEN octet_length("eventName") <= 320 THEN "eventName" END AS "eventName",
          COUNT(*) AS "count"
        FROM "AnalyticsEvent" WHERE "createdAt" >= ${cutoffDate}
        GROUP BY "eventName", to_char("createdAt", 'YYYY-MM-DD')
        LIMIT ${SUMMARY_GROUP_LIMIT + 1}`;
      if (groups.length > SUMMARY_GROUP_LIMIT) throw new Error('Analytics report exceeds safe grouping limit.');

      const counts: Record<string, number> = Object.create(null);
      const dailyMap = new Map<string, Record<string, string | number>>();
      for (const row of groups) {
        if (row.eventName === null || row.eventName === 'day') throw new Error('Unsupported historical analytics event name.');
        counts[row.eventName] = summaryCount((counts[row.eventName] || 0) + summaryCount(row.count));
        const current = dailyMap.get(row.day) || Object.assign(Object.create(null), { day: row.day });
        current[row.eventName] = summaryCount(row.count);
        dailyMap.set(row.day, current);
      }

      // All matching service views contribute, not just the 100 displayed detail rows.
      // Historical metadata was JSON.stringify output; malformed imported JSON fails the report.
      const topRows = await tx.$queryRaw<{ id: string | null; views: bigint; invalidIds: boolean }[]>`
        SELECT CASE WHEN octet_length("serviceId") <= ${EVENT_METADATA_BYTES} THEN "serviceId" END AS "id",
          COUNT(*) AS "views", BOOL_OR(BOOL_OR("idType" <> 'string')) OVER () AS "invalidIds"
        FROM (
          SELECT "metadata"::json ->> 'serviceId' AS "serviceId",
            json_typeof("metadata"::json -> 'serviceId') AS "idType"
          FROM "AnalyticsEvent"
          WHERE "createdAt" >= ${cutoffDate} AND "eventName" = 'service_view'
        ) views
        WHERE "serviceId" IS NOT NULL AND "serviceId" <> ''
        GROUP BY "serviceId"
        ORDER BY COUNT(*) DESC, "serviceId" ASC
        LIMIT 10`;
      if (topRows.some(row => row.id === null || row.invalidIds)) throw new Error('Unsupported historical analytics service ID.');

      const logRows = await tx.$queryRaw<{
        kind: 'service' | 'visitor'; id: string; sessionId: string | null;
        path: string | null; createdAt: Date; metadata: string | null; oversized: boolean;
      }[]>`
        WITH selected AS (
          (SELECT 'service' AS "kind", "id", "createdAt"
            FROM "AnalyticsEvent" WHERE "createdAt" >= ${cutoffDate} AND "eventName" = 'service_view'
            ORDER BY "createdAt" DESC, "id" DESC LIMIT ${SUMMARY_DETAIL_LIMIT})
          UNION ALL
          (SELECT 'visitor' AS "kind", "id", "createdAt" FROM (
            SELECT DISTINCT ON ("sessionId") "id", "createdAt"
            FROM "AnalyticsEvent" WHERE "createdAt" >= ${cutoffDate} AND "sessionId" <> ''
            ORDER BY "sessionId", "createdAt" ASC, "id" ASC
          ) sessions ORDER BY "createdAt" DESC, "id" DESC LIMIT ${SUMMARY_DETAIL_LIMIT})
        )
        SELECT selected."kind", event."id", event."sessionId", event."path", event."createdAt",
          CASE WHEN octet_length(event."metadata") <= ${EVENT_METADATA_BYTES} THEN event."metadata" END AS "metadata",
          COALESCE(octet_length(event."metadata") > ${EVENT_METADATA_BYTES}, false) AS "oversized"
        FROM selected JOIN "AnalyticsEvent" event ON event."id" = selected."id"
        ORDER BY event."createdAt" DESC, event."id" DESC, selected."kind"`;

      const logs = logRows.map(row => {
        if (row.oversized) throw new Error('Historical analytics detail exceeds safe byte limit.');
        const meta = row.metadata ? JSON.parse(row.metadata) : null;
        for (const key of ['serviceId', 'serviceName', 'userAgent', 'userName', 'userEmail']) {
          if (meta?.[key] != null && typeof meta[key] !== 'string') throw new Error('Unsupported historical analytics detail.');
        }
        return { ...row, meta };
      });
      const serviceIds = [...new Set([
        ...topRows.map(row => row.id!),
        ...logs.filter(row => row.kind === 'service').map(row => String(row.meta?.serviceId || '')),
      ])].filter(Boolean);
      const serviceNameMap = new Map<string, string>();
      if (serviceIds.length) {
        const services = await tx.$queryRaw<{ id: string; name: string | null; oversized: boolean }[]>`
          SELECT requested.id,
            CASE WHEN octet_length(service.name) <= ${EVENT_METADATA_BYTES} THEN service.name END AS name,
            COALESCE(octet_length(service.name) > ${EVENT_METADATA_BYTES}, false) AS oversized
          FROM unnest(${serviceIds}::text[]) requested(id)
          LEFT JOIN LATERAL (
            SELECT "name" FROM "DhruService" WHERE "id" = requested.id OR "dhruId" = requested.id
            ORDER BY ("id" = requested.id) DESC LIMIT 1
          ) service ON true`;
        for (const service of services) {
          if (service.oversized) throw new Error('Analytics service name exceeds safe byte limit.');
          if (service.name !== null) serviceNameMap.set(service.id, service.name);
        }
      }

      const serviceViewLogs: any[] = [];
      const visitorLogs: any[] = [];
      for (const { meta, ...row } of logs) {
        const log = {
          id: row.id,
          sessionId: row.sessionId || 'زائر مجهول',
          path: row.path || (row.kind === 'service' ? '/purchase' : '/'),
          createdAt: row.createdAt,
          userAgent: meta?.userAgent || null,
          userName: meta?.userName || null,
          userEmail: meta?.userEmail || null,
        };
        if (row.kind === 'service') {
          const serviceId = meta?.serviceId || '';
          serviceViewLogs.push({
            ...log, serviceId,
            serviceName: serviceNameMap.get(serviceId) || meta?.serviceName || (serviceId ? `خدمة #${serviceId}` : 'خدمة غير محددة'),
          });
        } else {
          visitorLogs.push(log);
        }
      }

      return {
        days,
        totalUsers: summaryCount(totals.totalUsers),
        totalOrders: summaryCount(totals.totalOrders),
        uniqueSessions: summaryCount(totals.uniqueSessions),
        counts,
        topServices: topRows.map(row => ({ id: row.id!, name: serviceNameMap.get(row.id!) || `خدمة #${row.id}`, views: summaryCount(row.views) })),
        serviceViewLogs,
        visitorLogs,
        daily: [...dailyMap.values()].sort((a, b) => String(a.day).localeCompare(String(b.day))),
      };
    }, { isolationLevel: 'RepeatableRead', maxWait: 1000, timeout: 10000 });

    return res.json({ success: true, data });
  } catch (error: any) {
    console.error('Conversion summary error:', error?.code || error?.message);
    return res.status(503).json({ error: 'تعذر تحميل تقرير الإحصائيات.', code: 'ANALYTICS_REPORT_UNAVAILABLE' });
  }
});

// GET /api/analytics/dashboard-stats - Live comprehensive admin dashboard figures
router.get('/dashboard-stats', isAdmin, async (req, res) => {
  try {
    const [
      totalUsers,
      activeUsers,
      suspendedUsers,
      totalOrders,
      completedOrders,
      pendingOrders,
      rejectedOrders,
      totalTransactions,
      pendingTransactions,
      completedTransactions,
      balanceAggregate,
      totalCategories,
      totalServices,
      activeServices,
      recentOrders,
      recentTransactions,
      recentUsers
    ] = await Promise.all([
      prisma.user.count({ where: { role: { not: 'admin' } } }),
      prisma.user.count({ where: { role: { not: 'admin' }, status: 'active' } }),
      prisma.user.count({ where: { role: { not: 'admin' }, status: 'suspended' } }),
      prisma.order.count(),
      prisma.order.count({ where: { status: 'completed' } }),
      prisma.order.count({ where: { status: 'pending' } }),
      prisma.order.count({ where: { status: { in: ['rejected', 'failed'] } } }),
      prisma.transaction.count(),
      prisma.transaction.count({ where: { status: 'pending' } }),
      prisma.transaction.count({ where: { status: 'completed' } }),
      prisma.user.aggregate({
        where: { role: { not: 'admin' } },
        _sum: { balance: true }
      }),
      prisma.dhruCategory.count(),
      prisma.dhruService.count(),
      prisma.dhruService.count({ where: { isActive: true } }),
      prisma.order.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { fullName: true, email: true, username: true, phone: true } }
        }
      }),
      prisma.transaction.findMany({
        take: 6,
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { fullName: true, email: true, username: true, phone: true } }
        }
      }),
      prisma.user.findMany({
        where: { role: { not: 'admin' } },
        take: 6,
        orderBy: { createdAt: 'desc' },
        select: { id: true, fullName: true, email: true, username: true, phone: true, balance: true, country: true, status: true, createdAt: true }
      })
    ]);

    // Check active providers from database
    const activeProvider = await prisma.apiProvider.findFirst({
      where: { isActive: true },
      orderBy: { updatedAt: 'desc' }
    });

    let dhruInfo: any = null;
    if (activeProvider) {
      try {
        const { makeProviderApiCall, extractProviderAccountInfo } = require('./providers');
        const apiRes = await makeProviderApiCall(activeProvider.apiUrl, activeProvider.username, activeProvider.apiKey, "accountinfo");
        const accountInfo = extractProviderAccountInfo(apiRes.data);
        if (accountInfo) {
          dhruInfo = {
            providerName: activeProvider.name,
            balance: accountInfo.balance,
            currency: accountInfo.currency,
            formattedBalance: `$${accountInfo.balance.toFixed(2)} ${accountInfo.currency}`,
            SUCCESS: [{ credit: `$${accountInfo.balance.toFixed(2)} ${accountInfo.currency}` }],
            connected: true
          };
          await prisma.apiProvider.update({
            where: { id: activeProvider.id },
            data: { balance: accountInfo.balance, currency: accountInfo.currency }
          }).catch(() => {});
        } else {
          dhruInfo = {
            providerName: activeProvider.name,
            balance: activeProvider.balance,
            currency: activeProvider.currency || 'USD',
            formattedBalance: `$${activeProvider.balance.toFixed(2)} ${activeProvider.currency || 'USD'}`,
            SUCCESS: [{ credit: `$${activeProvider.balance.toFixed(2)} ${activeProvider.currency || 'USD'}` }],
            connected: true
          };
        }
      } catch {
        dhruInfo = {
          providerName: activeProvider.name,
          balance: activeProvider.balance,
          currency: activeProvider.currency || 'USD',
          formattedBalance: `$${activeProvider.balance.toFixed(2)} ${activeProvider.currency || 'USD'}`,
          SUCCESS: [{ credit: `$${activeProvider.balance.toFixed(2)} ${activeProvider.currency || 'USD'}` }],
          connected: true
        };
      }
    } else {
      try {
        const { getAccountInfo } = require('../utils/dhru-api');
        dhruInfo = await getAccountInfo();
      } catch {
        dhruInfo = null;
      }
    }

    return res.json({
      success: true,
      data: {
        users: {
          total: totalUsers,
          active: activeUsers,
          suspended: suspendedUsers,
          totalBalances: balanceAggregate._sum.balance || 0
        },
        orders: {
          total: totalOrders,
          completed: completedOrders,
          pending: pendingOrders,
          rejected: rejectedOrders
        },
        transactions: {
          total: totalTransactions,
          pending: pendingTransactions,
          completed: completedTransactions
        },
        services: {
          categories: totalCategories,
          total: totalServices,
          active: activeServices
        },
        dhru: dhruInfo,
        recent: {
          orders: recentOrders,
          transactions: recentTransactions,
          users: recentUsers
        }
      }
    });
  } catch (error: any) {
    console.error('Error fetching dashboard stats:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard stats' });
  }
});

// GET /api/analytics/provider-orders - Detailed provider orders report by period and service
router.get('/provider-orders', isAdmin, async (req, res) => {
  try {
    const { startDate, endDate, status, search, serviceName } = req.query;

    const where: any = {
      apiOrderId: { not: null }
    };

    // Date range filter
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) {
        const start = new Date(String(startDate));
        start.setHours(0, 0, 0, 0);
        where.createdAt.gte = start;
      }
      if (endDate) {
        const end = new Date(String(endDate));
        end.setHours(23, 59, 59, 999);
        where.createdAt.lte = end;
      }
    }

    // Status filter
    if (status && status !== 'all' && status !== 'ALL') {
      const s = String(status).toLowerCase();
      if (s === 'success' || s === 'completed') {
        where.status = 'completed';
      } else if (s === 'processing' || s === 'in_process') {
        where.status = 'processing';
      } else if (s === 'rejected' || s === 'failed') {
        where.status = { in: ['rejected', 'failed'] };
      } else {
        where.status = String(status);
      }
    }

    // Service name filter
    if (serviceName && serviceName !== 'all' && serviceName !== 'ALL') {
      where.serviceName = String(serviceName);
    }

    // Search query (id, apiOrderId, targetInput, serviceName)
    if (search && String(search).trim()) {
      const q = String(search).trim();
      where.OR = [
        { id: { contains: q } },
        { apiOrderId: { contains: q } },
        { serviceName: { contains: q } },
        { targetInput: { contains: q } }
      ];
    }

    const [orders, totalCount, rawServices] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 500,
        include: {
          user: {
            select: { id: true, fullName: true, email: true, username: true }
          }
        }
      }),
      prisma.order.count({ where }),
      prisma.order.findMany({
        where: { apiOrderId: { not: null } },
        select: { serviceName: true },
        take: 1000
      })
    ]);

    const servicesList = Array.from(new Set(rawServices.map((s) => s.serviceName).filter(Boolean)));

    const completedOrders = orders.filter((o) => o.status === 'completed');
    const totalVolume = orders.reduce((sum, o) => sum + (o.price || 0), 0);
    const completedVolume = completedOrders.reduce((sum, o) => sum + (o.price || 0), 0);

    const enrichedOrders = await enrichOrdersWithProviderData(orders);

    return res.json({
      success: true,
      data: {
        orders: enrichedOrders,
        totalCount,
        servicesList,
        summary: {
          total: totalCount,
          completedCount: completedOrders.length,
          processingCount: orders.filter((o) => o.status === 'processing').length,
          failedCount: orders.filter((o) => o.status === 'failed' || o.status === 'rejected').length,
          totalVolume,
          completedVolume
        }
      }
    });
  } catch (error: any) {
    console.error('Error fetching provider orders report:', error);
    return res.status(500).json({ error: 'تعذر جلب تقرير طلبات المزود.' });
  }
});

export default router;
