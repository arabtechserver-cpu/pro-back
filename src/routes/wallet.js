"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const server_1 = require("../server");
const auth_1 = require("../middleware/auth");
const router = (0, express_1.Router)();
router.get('/', auth_1.authenticateToken, async (req, res) => {
    try {
        const transactions = await server_1.prisma.walletTransaction.findMany({
            orderBy: { createdAt: 'desc' }
        });
        const balance = transactions.reduce((acc, tx) => {
            if (tx.status !== 'completed')
                return acc;
            return tx.type === 'deposit' ? acc + tx.amount : acc - tx.amount;
        }, 0);
        res.json({ balance, transactions });
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch wallet info' });
    }
});
router.post('/', auth_1.authenticateToken, async (req, res) => {
    try {
        const { amount, type } = req.body;
        const tx = await server_1.prisma.walletTransaction.create({
            data: {
                userId: req.user?.id || 'admin_1',
                amount: Number(amount),
                type,
                status: 'pending' // Admin can approve later
            }
        });
        res.status(201).json(tx);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to create transaction' });
    }
});
exports.default = router;
