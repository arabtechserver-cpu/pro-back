"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const server_1 = require("../server");
const paypalService_1 = require("../services/paypalService");
const telegramService_1 = require("../utils/telegramService");
const router = (0, express_1.Router)();
// POST /api/wallet/paypal/create-order
router.post('/create-order', async (req, res) => {
    try {
        const { amount, userId, email } = req.body;
        if (!amount || parseFloat(amount) <= 0) {
            return res.status(400).json({ error: 'الحد الأدنى لمبلغ الإيداع هو $1.00 USD' });
        }
        const numAmount = parseFloat(amount);
        const originHost = req.headers.origin || 'https://arabtechproserver.tech';
        const returnUrl = `${originHost}/ar/wallet?paypal=success`;
        const cancelUrl = `${originHost}/ar/wallet?paypal=cancel`;
        const paypalOrder = await (0, paypalService_1.createPayPalOrder)(numAmount, returnUrl, cancelUrl);
        if (!paypalOrder.approvalUrl) {
            return res.status(500).json({ error: 'لم يتم العثور على رابط تأكيد الدفع من PayPal' });
        }
        console.log(`[PayPal Live Order Created] ID: ${paypalOrder.orderId} - Amount: $${numAmount}`);
        return res.json({
            success: true,
            orderId: paypalOrder.orderId,
            approvalUrl: paypalOrder.approvalUrl,
            amount: numAmount
        });
    }
    catch (error) {
        console.error('Error creating PayPal order:', error);
        return res.status(500).json({ error: error.message || 'حدث خطأ أثناء التواصل مع PayPal' });
    }
});
// POST /api/wallet/paypal/capture-order
router.post('/capture-order', async (req, res) => {
    try {
        const { orderId, userId, email } = req.body;
        if (!orderId) {
            return res.status(400).json({ error: 'رقم طلب PayPal (orderId) مطلوب للتأكيد' });
        }
        // Check double-capture guard in SQLite DB
        const existingTx = await server_1.prisma.transaction.findFirst({
            where: { refNo: orderId }
        });
        if (existingTx && existingTx.status === 'completed') {
            const user = await server_1.prisma.user.findUnique({ where: { id: existingTx.userId } });
            return res.json({
                success: true,
                message: 'تم خصم وتفعيل هذا الطلب سابقاً في المحفظة! ✅',
                amount: existingTx.amount,
                balance: user?.balance || 0.0,
                alreadyCaptured: true
            });
        }
        // Call PayPal capture API
        const captureResult = await (0, paypalService_1.capturePayPalOrder)(orderId);
        const isCompleted = captureResult?.status === 'COMPLETED' ||
            captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.status === 'COMPLETED';
        if (!isCompleted && captureResult?.status !== 'ALREADY_CAPTURED') {
            return res.status(400).json({
                error: 'لم تكتمل عملية الدفع عبر PayPal أو تم إلغاؤها من قبل المستخدم.'
            });
        }
        // Find Target User
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
        // Extract captured amount
        const capturedAmount = parseFloat(captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 10.0);
        // 1. Create or update transaction record in DB as COMPLETED
        const newTx = existingTx
            ? await server_1.prisma.transaction.update({
                where: { id: existingTx.id },
                data: { status: 'completed' }
            })
            : await server_1.prisma.transaction.create({
                data: {
                    userId: targetUserId,
                    type: 'شحن محفظة (PayPal فوري)',
                    amount: capturedAmount,
                    method: 'باي بال PayPal (تلقائي)',
                    status: 'completed',
                    refNo: orderId
                }
            });
        // 2. Increment User Balance in SQLite DB
        const updatedUser = await server_1.prisma.user.update({
            where: { id: targetUserId },
            data: { balance: { increment: capturedAmount } }
        });
        console.log(`[PayPal Live Auto-Credited] User ${updatedUser.username} +$${capturedAmount} -> New Balance: $${updatedUser.balance}`);
        // 3. Send Admin Notification to Telegram
        const caption = `
🎉 <b>تم شحن محفظة تلقائياً عبر PayPal Live!</b>

💳 <b>رقم العملية:</b> <code>${orderId}</code>
👤 <b>العميل:</b> ${updatedUser.fullName} (@${updatedUser.username})
📧 <b>الإيميل:</b> <code>${updatedUser.email}</code>
💰 <b>المبلغ المضاف:</b> <code>+$${capturedAmount.toFixed(2)} USD</code>
🏦 <b>رصيد المحفظة الجديد:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
⚡ <b>حالة الدفع:</b> مكتمل تلقائياً 🟢
    `.trim();
        (0, telegramService_1.sendTelegramPhotoNotification)({ caption }).catch(() => { });
        return res.json({
            success: true,
            message: `تم الدفع وشحن رصيدك بمبلغ $${capturedAmount.toFixed(2)} USD بنجاح! ✅`,
            amount: capturedAmount,
            balance: updatedUser.balance,
            orderId,
            captureId: captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId
        });
    }
    catch (error) {
        console.error('Error capturing PayPal order:', error);
        return res.status(500).json({ error: error.message || 'حدث خطأ أثناء تأكيد عملية الدفع من PayPal' });
    }
});
exports.default = router;
