"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const server_1 = require("../server");
const dhru_api_1 = require("../utils/dhru-api");
const telegramService_1 = require("../utils/telegramService");
const router = (0, express_1.Router)();
// GET /api/orders - Fetch customer order history or all orders for admin
router.get('/', async (req, res) => {
    try {
        const { userId, email } = req.query;
        let targetUserId = userId;
        if (!targetUserId && email) {
            const u = await server_1.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
            if (u)
                targetUserId = u.id;
        }
        if (!targetUserId) {
            // Admin request - fetch all orders
            const allOrders = await server_1.prisma.order.findMany({
                take: 100,
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: { fullName: true, email: true, username: true, balance: true }
                    }
                }
            });
            return res.json({ success: true, orders: allOrders });
        }
        // Customer request - fetch user's orders
        const userOrders = await server_1.prisma.order.findMany({
            where: { userId: targetUserId },
            orderBy: { createdAt: 'desc' },
            include: {
                user: {
                    select: { fullName: true, email: true, username: true, balance: true }
                }
            }
        });
        return res.json({ success: true, orders: userOrders });
    }
    catch (error) {
        console.error('Error fetching orders:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل الطلبات' });
    }
});
// POST /api/orders - Create & Save New Order to SQLite DB + Deduct Wallet Balance
router.post('/', async (req, res) => {
    try {
        const { userId, email, serviceId, serviceName, targetInput, quantity, price, notes, customFields } = req.body;
        if (!serviceId || !serviceName || !targetInput) {
            return res.status(400).json({ error: 'يرجى تعبئة جميع بيانات الطلب (الخدمة والرقم المطلوب)' });
        }
        let targetUserId = userId;
        let dbUser = null;
        if (userId) {
            dbUser = await server_1.prisma.user.findUnique({ where: { id: userId } });
        }
        else if (email) {
            dbUser = await server_1.prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
            if (dbUser)
                targetUserId = dbUser.id;
        }
        if (!targetUserId) {
            const firstUser = await server_1.prisma.user.findFirst();
            if (firstUser) {
                targetUserId = firstUser.id;
                dbUser = firstUser;
            }
        }
        if (!targetUserId || !dbUser) {
            return res.status(400).json({ error: 'الرجاء تسجيل الدخول أولاً لإرسال الطلب' });
        }
        const qty = Math.max(1, parseInt(quantity || 1));
        const unitPrice = parseFloat(price || 0);
        const totalPrice = unitPrice * qty;
        // Check balance sufficiency
        if (dbUser.balance < totalPrice) {
            return res.status(400).json({
                error: `رصيد محفظتك غير كافٍ! التكلفة الإجمالية: $${totalPrice.toFixed(2)} USD ورصيدك الحالي: $${dbUser.balance.toFixed(2)} USD. يرجى شحن المحفظة أولاً.`
            });
        }
        // 0. Forward to Dhru API
        const dhruService = await server_1.prisma.dhruService.findFirst({
            where: { dhruId: String(serviceId) },
            include: { category: true }
        });
        let dhruResponse = null;
        let apiOrderId = null;
        if (dhruService && dhruService.category?.name === "IMEI Service") {
            dhruResponse = await (0, dhru_api_1.placeImeiOrder)(String(serviceId), String(targetInput).trim());
        }
        else {
            dhruResponse = await (0, dhru_api_1.placeServerOrder)(String(serviceId), qty, customFields || {});
        }
        if (!dhruResponse || dhruResponse.ERROR) {
            console.error("Dhru API Error:", dhruResponse);
            const errMsg = dhruResponse?.ERROR?.[0]?.MESSAGE || 'Unknown Provider Error';
            return res.status(400).json({ error: `عذراً، رفض المزود الطلب: ${errMsg}` });
        }
        if (dhruResponse.SUCCESS && dhruResponse.SUCCESS[0] && dhruResponse.SUCCESS[0].REFERENCEID) {
            apiOrderId = String(dhruResponse.SUCCESS[0].REFERENCEID);
        }
        // 1. Create Order in SQLite DB
        const newOrder = await server_1.prisma.order.create({
            data: {
                userId: targetUserId,
                serviceId: String(serviceId),
                serviceName: String(serviceName).trim(),
                targetInput: String(targetInput).trim(),
                quantity: qty,
                price: totalPrice,
                status: 'processing',
                notes: notes ? String(notes).trim() : null,
                apiOrderId: apiOrderId
            }
        });
        // 2. Deduct Balance from User
        const updatedUser = await server_1.prisma.user.update({
            where: { id: targetUserId },
            data: { balance: { decrement: totalPrice } }
        });
        // 3. Create Deduction Transaction Record
        await server_1.prisma.transaction.create({
            data: {
                userId: targetUserId,
                type: `خصم خدمة: ${serviceName.slice(0, 30)}`,
                amount: totalPrice,
                method: 'رصيد المحفظة',
                refNo: `ORD-#${newOrder.id.slice(-6)}`,
                status: 'completed'
            }
        });
        console.log(`[Order Placed & DB Saved] Order #${newOrder.id.slice(-6)} for User ${updatedUser.username} - Total: $${totalPrice} - New Balance: $${updatedUser.balance}`);
        // 4. Send Telegram Alert to Admin
        const caption = `
🛍️ <b>طلب خدمة جديد من رصيد العميل! (New Order Placed)</b>

💳 <b>رقم الطلب:</b> #${newOrder.id.slice(-6)}
👤 <b>العميل:</b> ${dbUser.fullName} (@${dbUser.username})
📧 <b>الإيميل:</b> <code>${dbUser.email}</code>
📱 <b>اسم الخدمة:</b> ${newOrder.serviceName}
🔢 <b>المُدخل (IMEI / Serial / ID):</b> <code>${newOrder.targetInput}</code>
📦 <b>الكمية:</b> ${newOrder.quantity}
💰 <b>إجمالي التكلفة:</b> <code>$${newOrder.price.toFixed(2)} USD</code>
🏦 <b>رصيد العميل المتبقي:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
📅 <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}

🟢 <b>الحالة:</b> جاري التنفيذ ⏳ (تم الإرسال للمزود بنجاح - Dhru ID: ${apiOrderId || 'N/A'})
    `.trim();
        (0, telegramService_1.sendTelegramMessage)(dbUser.email, caption).catch(() => { });
        return res.json({
            success: true,
            message: `تم إرسال الطلب وحفظه في سجل طلباتك بنجاح! تم خصم $${totalPrice.toFixed(2)} USD من رصيدك.`,
            order: newOrder,
            newBalance: updatedUser.balance
        });
    }
    catch (error) {
        console.error('Error creating order:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء إرسال وحفظ الطلب' });
    }
});
// POST /api/orders/update-status - Admin update order status & reply code
router.post('/update-status', async (req, res) => {
    try {
        const { orderId, newStatus, reply } = req.body;
        if (!orderId || !newStatus) {
            return res.status(400).json({ error: 'معرف الطلب والحالة الجديدة مطلوبة' });
        }
        const updateData = { status: newStatus };
        if (reply !== undefined && reply !== null) {
            updateData.reply = String(reply).trim();
        }
        const updatedOrder = await server_1.prisma.order.update({
            where: { id: orderId },
            data: updateData
        });
        return res.json({
            success: true,
            message: `تم تحديث حالة الطلب وإرسال الكود/النتيجة بنجاح!`,
            order: updatedOrder
        });
    }
    catch (error) {
        console.error('Error updating order status:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء تحديث حالة الطلب' });
    }
});
exports.default = router;
