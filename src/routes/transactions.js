"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const server_1 = require("../server");
const telegramService_1 = require("../utils/telegramService");
const router = (0, express_1.Router)();
// GET /api/transactions?userId=... - Fetch Real User Transactions
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
            const allTx = await server_1.prisma.transaction.findMany({
                orderBy: { createdAt: 'desc' },
                include: {
                    user: {
                        select: {
                            fullName: true,
                            email: true,
                            username: true,
                            balance: true
                        }
                    }
                }
            });
            return res.json({ success: true, transactions: allTx });
        }
        const txs = await server_1.prisma.transaction.findMany({
            where: { userId: targetUserId },
            orderBy: { createdAt: 'desc' }
        });
        return res.json({ success: true, transactions: txs });
    }
    catch (error) {
        console.error('Error fetching transactions:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل المعاملات' });
    }
});
// POST /api/transactions - Submit New Deposit Transaction (SQLite DB & Telegram)
router.post('/', async (req, res) => {
    try {
        const { userId, email, type, amount, method, refNo, receiptImage } = req.body;
        if (!amount || !method || !refNo) {
            return res.status(400).json({ error: 'جميع الحقول مطلوبة (المبلغ، طريقة الدفع، رقم المرجع)' });
        }
        let targetUserId = userId;
        if (!targetUserId && email) {
            const dbUser = await server_1.prisma.user.findUnique({
                where: { email: email.trim().toLowerCase() }
            });
            if (dbUser) {
                targetUserId = dbUser.id;
            }
        }
        if (!targetUserId) {
            return res.status(404).json({ error: 'المستخدم غير موجود. يُرجى الدخول بحساب صحيح' });
        }
        const newTransaction = await server_1.prisma.transaction.create({
            data: {
                userId: targetUserId,
                type: type || 'شحن محفظة',
                amount: parseFloat(amount),
                method: method.trim(),
                refNo: refNo.trim(),
                receiptImage: null, // As requested: Images are NOT stored in DB/server, sent ONLY to Telegram
                status: 'pending'
            }
        });
        console.log(`[Pending Deposit Submitted] Saved: ${newTransaction.id} ($${amount}) via ${method} - Awaiting Admin Approval`);
        // Notify Telegram Admin
        const userObj = await server_1.prisma.user.findUnique({ where: { id: targetUserId } });
        const caption = `
💳 <b>إيداع جديد قيد المراجعة! (New Deposit Pending)</b>

👤 <b>العميل:</b> ${userObj?.fullName || 'عميل'} (@${userObj?.username || 'مستخدم'})
📧 <b>الإيميل:</b> <code>${userObj?.email || 'N/A'}</code>
💰 <b>المبلغ المطلوب:</b> <code>+$${parseFloat(amount).toFixed(2)} USD</code>
🏦 <b>طريقة الدفع:</b> ${method}
🔢 <b>رقم المرجع / الإيصال:</b> <code>${refNo}</code>
📅 <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}

⏳ <b>الحالة:</b> قيد المراجعة - يُرجى فتح لوحة التحكم واعتماد الإيداع.
    `.trim();
        (0, telegramService_1.sendTelegramPhotoNotification)({
            imageSource: receiptImage,
            caption
        }).catch((err) => console.error('[Telegram Async Error]:', err));
        return res.json({
            success: true,
            message: 'تم تسجيل طلب الشحن بنجاح! سينتقل لطلب المراجعة وسيتم إضافة الرصيد لحسابك فور موافقة الأدمن.',
            transaction: newTransaction
        });
    }
    catch (error) {
        console.error('Error creating transaction:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء حفظ العملية في قاعدة البيانات' });
    }
});
// POST /api/transactions/approve - Admin Approve Deposit
router.post('/approve', async (req, res) => {
    try {
        const { transactionId } = req.body;
        if (!transactionId) {
            return res.status(400).json({ error: 'رقم العملية مطلوب' });
        }
        const tx = await server_1.prisma.transaction.findUnique({ where: { id: transactionId } });
        if (!tx) {
            return res.status(404).json({ error: 'العملية غير موجودة' });
        }
        if (tx.status === 'completed') {
            return res.status(400).json({ error: 'العملية مكتملة بالفعل' });
        }
        const updatedUser = await server_1.prisma.user.update({
            where: { id: tx.userId },
            data: { balance: { increment: tx.amount } }
        });
        const updatedTx = await server_1.prisma.transaction.update({
            where: { id: transactionId },
            data: { status: 'completed' }
        });
        const caption = `
🟢 <b>تمت الموافقة وإضافة الرصيد بنجاح!</b>

👤 <b>العميل:</b> ${updatedUser.fullName} (@${updatedUser.username})
💰 <b>المبلغ المضاف:</b> <code>+$${tx.amount.toFixed(2)} USD</code>
🏦 <b>رصيد الحساب الجديد:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
    `.trim();
        (0, telegramService_1.sendTelegramPhotoNotification)({ caption }).catch(() => { });
        return res.json({
            success: true,
            message: `تم اعتماد إيداع بقيمة $${tx.amount} وزيادة رصيد العميل بنجاح!`,
            transaction: updatedTx,
            newBalance: updatedUser.balance
        });
    }
    catch (error) {
        console.error('Error approving transaction:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء تفعيل طلب الشحن' });
    }
});
// POST /api/transactions/reject - Admin Reject Deposit
router.post('/reject', async (req, res) => {
    try {
        const { transactionId } = req.body;
        if (!transactionId) {
            return res.status(400).json({ error: 'رقم العملية مطلوب' });
        }
        const tx = await server_1.prisma.transaction.findUnique({ where: { id: transactionId } });
        if (!tx) {
            return res.status(404).json({ error: 'العملية غير موجودة' });
        }
        const updatedTx = await server_1.prisma.transaction.update({
            where: { id: transactionId },
            data: { status: 'failed' }
        });
        return res.json({
            success: true,
            message: 'تم رفض طلب الشحن',
            transaction: updatedTx
        });
    }
    catch (error) {
        console.error('Error rejecting transaction:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء رفض الطلب' });
    }
});
// GET & POST /api/transactions/telegram-admin - Telegram Bot Chat Registration
router.get('/telegram-admin', async (req, res) => {
    const chatIds = (0, telegramService_1.getAdminChatIds)();
    return res.json({
        success: true,
        connected: chatIds.length > 0,
        chatIds
    });
});
router.post('/telegram-admin', async (req, res) => {
    try {
        const { chatId } = req.body;
        if (!chatId) {
            return res.status(400).json({ error: 'معرف الشات مطلوب' });
        }
        (0, telegramService_1.addAdminChatId)(String(chatId).trim());
        await (0, telegramService_1.sendTelegramMessage)(String(chatId).trim(), `🎉 <b>تم ربط حسابك كـ أدمن في البوت بنجاح!</b>\n\nستصلك جميع إشعارات صور الإيصالات وطلبات الشحن فورياً على هذا الحساب.`);
        return res.json({
            success: true,
            message: `تم تسجيل معرف الشات (${chatId}) بنجاح وإرسال رسالة اختبار لـ تلجرام!`
        });
    }
    catch (error) {
        console.error('Error setting telegram admin:', error);
        return res.status(500).json({ error: 'حدث خطأ أثناء حفظ معرف الشات' });
    }
});
exports.default = router;
