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

router.get('/services', async (req, res) => {
  try {
    const categories = await prisma.dhruCategory.findMany({
      include: {
        services: {
          where: { isActive: true }, // Only return active services to customers
          orderBy: { name: 'asc' }
        }
      }
    });
    res.json(categories);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch Dhru services from DB' });
  }
});

export default router;
