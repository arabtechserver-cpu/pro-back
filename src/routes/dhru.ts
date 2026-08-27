import { Router } from 'express';
import { getAccountInfo, getImeiServiceList } from '../utils/dhru-api';

const router = Router();

router.get('/account', async (req, res) => {
  try {
    const info = await getAccountInfo();
    res.json(info);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Dhru account info' });
  }
});

import { prisma } from '../server';

import { syncDhruServices, cleanServiceName } from '../scripts/syncDhruServices';

router.get('/services', async (req, res) => {
  try {
    const { all } = req.query;
    const categories = await prisma.dhruCategory.findMany({
      include: {
        services: {
          where: all === 'true' ? {} : { isActive: true }, // Only return active services to customers unless all=true
          orderBy: { name: 'asc' }
        }
      }
    });

    const cleanedCategories = categories.map((cat) => ({
      ...cat,
      services: cat.services.map((srv) => ({
        ...srv,
        name: cleanServiceName(srv.name, srv.info || '', srv.groupName || ''),
      })),
    }));

    res.json(cleanedCategories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Dhru services from DB' });
  }
});

// POST /api/dhru/services/toggle - Toggle single service visibility
router.post('/services/toggle', async (req, res) => {
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

    res.json({ success: true, service: updated, message: nextState ? 'تم إظهار الخدمة للعملاء' : 'تم إخفاء الخدمة عن العملاء' });
  } catch (error) {
    console.error('Toggle service error:', error);
    res.status(500).json({ error: 'Failed to toggle service visibility' });
  }
});

// POST /api/dhru/services/toggle-group - Toggle or hide/show entire package group
router.post('/services/toggle-group', async (req, res) => {
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

// POST /api/dhru/services/update - Edit service custom name and profit margin
router.post('/services/update', async (req, res) => {
  try {
    const { serviceId, name, margin } = req.body;
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

    const updated = await prisma.dhruService.update({
      where: { id: serviceId },
      data: updateData
    });

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
          { serviceId: isNaN(Number(id)) ? -1 : Number(id) }
        ]
      },
      include: {
        category: true
      }
    });

    if (!service) {
      return res.status(404).json({ error: 'Service not found' });
    }

    const cleanedService = {
      ...service,
      name: cleanServiceName(service.name, service.info || '', service.groupName || '')
    };

    res.json(cleanedService);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch service' });
  }
});

router.post('/sync', async (req, res) => {
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

router.get('/my-ip', async (req, res) => {
  try {
    const ipRes = await fetch('https://api.ipify.org?format=json');
    const ipData = await ipRes.json();
    res.json({ outboundIp: ipData.ip });
  } catch (error) {
    res.status(500).json({ error: 'Failed to detect outbound IP' });
  }
});

export default router;
