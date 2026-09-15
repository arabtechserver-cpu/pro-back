import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { authenticateToken } from '../middleware/auth';

const router = Router();

router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user.id;

    const transactions = await prisma.walletTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' }
    });

    const balance = transactions.reduce((acc: number, tx: any) => {
      if (tx.status !== 'completed') return acc;
      return tx.type === 'deposit' ? acc + tx.amount : acc - tx.amount;
    }, 0);

    res.json({ balance, transactions });
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

    const tx = await prisma.walletTransaction.create({
      data: {
        userId,
        amount: parsedAmount,
        type: String(type || 'deposit').trim(),
        status: 'pending'
      }
    });
    res.status(201).json(tx);
  } catch (error) {
    res.status(500).json({ error: 'Failed to create transaction' });
  }
});

export default router;
