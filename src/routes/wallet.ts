import { Router } from 'express';
import { prisma } from '../server';
import { authenticateToken } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, async (req, res) => {
  try {
    const transactions = await prisma.walletTransaction.findMany({
      orderBy: { createdAt: 'desc' }
    });
    
    const balance = transactions.reduce((acc, tx) => {
      if (tx.status !== 'completed') return acc;
      return tx.type === 'deposit' ? acc + tx.amount : acc - tx.amount;
    }, 0);

    res.json({ balance, transactions });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch wallet info' });
  }
});

router.post('/', authenticateToken, async (req, res) => {
  try {
    const { amount, type } = req.body;
    const tx = await prisma.walletTransaction.create({
      data: {
        userId: (req as any).user?.id || 'admin_1',
        amount: Number(amount),
        type,
        status: 'pending' // Admin can approve later
      }
    });
    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

export default router;
