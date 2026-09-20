import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { authenticateToken } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { balance: true }
    });

    const transactions = await prisma.transaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    res.json({
      balance: user?.balance || 0,
      transactions: transactions.map(t => ({
        id: t.id,
        amount: t.amount,
        type: t.type,
        status: t.status,
        method: t.method,
        createdAt: t.createdAt
      }))
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch wallet info' });
  }
});

router.post('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const { amount, type } = req.body;
    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    const tx = await prisma.transaction.create({
      data: {
        userId,
        amount: parsedAmount,
        type: String(type || 'طلب إيداع').trim(),
        method: 'تحويل محفظة',
        refNo: `TX_REQ_${Date.now()}_${Math.floor(Math.random() * 10000)}`,
        status: 'pending'
      }
    });
    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

export default router;
