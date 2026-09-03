import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { isAdmin } from '../middleware/auth';

const router = Router();

// POST /api/analytics/events - Log an anonymous or authenticated conversion event
router.post('/events', async (req, res) => {
  try {
    const { eventName, sessionId, path, metadata } = req.body;
    
    if (!eventName) {
      return res.status(400).json({ error: 'حدث غير صالح.' });
    }

    await prisma.analyticsEvent.create({
      data: {
        eventName: String(eventName).trim().slice(0, 80),
        sessionId: sessionId ? String(sessionId).trim().slice(0, 100) : null,
        path: path ? String(path).trim().slice(0, 500) : null,
        metadata: metadata ? JSON.stringify(metadata) : null,
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

    // 1. Basic Counts
    const totalUsers = await prisma.user.count({ where: { role: 'user' } });
    const totalOrders = await prisma.order.count();
    
    // 2. Events Summary (from last 'days' days)
    const recentEvents = await prisma.analyticsEvent.findMany({
      where: { createdAt: { gte: cutoffDate } }
    });

    const counts: Record<string, number> = {};
    const sessions = new Set<string>();
    const dailyMap = new Map<string, any>();

    recentEvents.forEach((row) => {
      // Aggregate event counts
      counts[row.eventName] = (counts[row.eventName] || 0) + 1;
      
      // Unique sessions
      if (row.sessionId) sessions.add(row.sessionId);
      
      // Daily breakdown
      const day = new Date(row.createdAt).toISOString().slice(0, 10);
      const current = dailyMap.get(day) || { day };
      current[row.eventName] = (current[row.eventName] || 0) + 1;
      dailyMap.set(day, current);
    });

    // 3. Most Viewed Services
    const serviceViews: Record<string, number> = {};
    recentEvents.forEach((row) => {
      if (row.eventName === 'service_view' && row.metadata) {
        try {
          const meta = JSON.parse(row.metadata);
          if (meta.serviceId) {
            serviceViews[meta.serviceId] = (serviceViews[meta.serviceId] || 0) + 1;
          }
        } catch (e) {
          // ignore parsing error
        }
      }
    });
    
    // Sort and get top 5 services
    const topServiceIds = Object.entries(serviceViews)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5);
      
    const topServices = await Promise.all(
      topServiceIds.map(async ([id, count]) => {
        const service = await prisma.dhruService.findUnique({ where: { id } });
        return {
          id,
          name: service?.name || 'Unknown Service',
          views: count
        };
      })
    );

    return res.json({
      success: true,
      data: {
        days,
        totalUsers,
        totalOrders,
        uniqueSessions: sessions.size,
        counts,
        topServices,
        daily: [...dailyMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
      }
    });
  } catch (error: any) {
    console.error('Conversion summary error:', error);
    return res.status(500).json({ error: 'تعذر تحميل تقرير الإحصائيات.' });
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

    let dhruInfo: any = null;
    try {
      const { getAccountInfo } = require('../utils/dhru-api');
      dhruInfo = await getAccountInfo();
    } catch {
      dhruInfo = null;
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

    const [orders, totalCount, servicesList] = await Promise.all([
      prisma.order.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 300,
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
        distinct: ['serviceName']
      })
    ]);

    const completedOrders = orders.filter((o) => o.status === 'completed');
    const totalVolume = orders.reduce((sum, o) => sum + (o.price || 0), 0);
    const completedVolume = completedOrders.reduce((sum, o) => sum + (o.price || 0), 0);

    return res.json({
      success: true,
      data: {
        orders,
        totalCount,
        servicesList: servicesList.map((s) => s.serviceName).filter(Boolean),
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
