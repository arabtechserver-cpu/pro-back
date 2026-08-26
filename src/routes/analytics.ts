import { Router } from 'express';
import { prisma } from '../server';
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

export default router;
