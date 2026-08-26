"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const dhru_api_1 = require("../utils/dhru-api");
const router = (0, express_1.Router)();
router.get('/account', async (req, res) => {
    try {
        const info = await (0, dhru_api_1.getAccountInfo)();
        res.json(info);
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch Dhru account info' });
    }
});
const client_1 = require("@prisma/client");
const prisma = new client_1.PrismaClient();
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
    }
    catch (error) {
        res.status(500).json({ error: 'Failed to fetch Dhru services from DB' });
    }
});
exports.default = router;
