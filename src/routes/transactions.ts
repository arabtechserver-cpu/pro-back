import { Router } from 'express';
import { prisma } from '../server';
import {
  sendTelegramPhotoNotification,
  getAdminChatIds,
  addAdminChatId,
  sendTelegramMessage
} from '../utils/telegramService';
import { isAdmin, authenticateToken } from '../middleware/auth';

const router = Router();

// GET /api/transactions?userId=... - Fetch Real User Transactions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { userId, email } = req.query;

    let targetUserId = userId as string;

    if (!targetUserId && email) {
      const u = await prisma.user.findUnique({ where: { email: (email as string).trim().toLowerCase() } });
      if (u) targetUserId = u.id;
    }

    if (!targetUserId) {
      if ((req as any).user?.role !== 'admin') {
        return res.status(403).json({ error: 'Access denied' });
      }
      const allTx = await prisma.transaction.findMany({
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

    const txs = await prisma.transaction.findMany({
      where: { userId: targetUserId },
      orderBy: { createdAt: 'desc' }
    });

    return res.json({ success: true, transactions: txs });
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل المعاملات' });
  }
});

// POST /api/transactions - Submit New Deposit Transaction (SQLite DB & Telegram)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { userId, email, type, amount, method, refNo, receiptImage } = req.body;

    if (!amount || !method || !refNo) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة (المبلغ، طريقة الدفع، رقم المرجع)' });
    }

    let targetUserId = userId;

    if (!targetUserId && email) {
      const dbUser = await prisma.user.findUnique({
        where: { email: email.trim().toLowerCase() }
      });
      if (dbUser) {
        targetUserId = dbUser.id;
      }
    }

    if (!targetUserId) {
      return res.status(404).json({ error: 'المستخدم غير موجود. يُرجى الدخول بحساب صحيح' });
    }

    const newTransaction = await prisma.transaction.create({
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
    const userObj = await prisma.user.findUnique({ where: { id: targetUserId } });
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

    sendTelegramPhotoNotification({
      imageSource: receiptImage,
      caption
    }).catch((err) => console.error('[Telegram Async Error]:', err));

    return res.json({
      success: true,
      message: 'تم تسجيل طلب الشحن بنجاح! سينتقل لطلب المراجعة وسيتم إضافة الرصيد لحسابك فور موافقة الأدمن.',
      transaction: newTransaction
    });
  } catch (error: any) {
    console.error('Error creating transaction:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء حفظ العملية في قاعدة البيانات' });
  }
});

// POST /api/transactions/approve - Admin Approve Deposit
router.post('/approve', isAdmin, async (req, res) => {
  try {
    const { transactionId } = req.body;
    if (!transactionId) {
      return res.status(400).json({ error: 'رقم العملية مطلوب' });
    }

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) {
      return res.status(404).json({ error: 'العملية غير موجودة' });
    }

    if (tx.status === 'completed') {
      return res.status(400).json({ error: 'العملية مكتملة بالفعل' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: tx.userId },
      data: { balance: { increment: tx.amount } }
    });

    const updatedTx = await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: 'completed' }
    });

    const caption = `
🟢 <b>تمت الموافقة وإضافة الرصيد بنجاح!</b>

👤 <b>العميل:</b> ${updatedUser.fullName} (@${updatedUser.username})
💰 <b>المبلغ المضاف:</b> <code>+$${tx.amount.toFixed(2)} USD</code>
🏦 <b>رصيد الحساب الجديد:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
    `.trim();

    sendTelegramPhotoNotification({ caption }).catch(() => {});

    return res.json({
      success: true,
      message: `تم اعتماد إيداع بقيمة $${tx.amount} وزيادة رصيد العميل بنجاح!`,
      transaction: updatedTx,
      newBalance: updatedUser.balance
    });
  } catch (error: any) {
    console.error('Error approving transaction:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تفعيل طلب الشحن' });
  }
});

// POST /api/transactions/reject - Admin Reject Deposit
router.post('/reject', isAdmin, async (req, res) => {
  try {
    const { transactionId } = req.body;
    if (!transactionId) {
      return res.status(400).json({ error: 'رقم العملية مطلوب' });
    }

    const tx = await prisma.transaction.findUnique({ where: { id: transactionId } });
    if (!tx) {
      return res.status(404).json({ error: 'العملية غير موجودة' });
    }

    const updatedTx = await prisma.transaction.update({
      where: { id: transactionId },
      data: { status: 'failed' }
    });

    return res.json({
      success: true,
      message: 'تم رفض طلب الشحن',
      transaction: updatedTx
    });
  } catch (error: any) {
    console.error('Error rejecting transaction:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء رفض الطلب' });
  }
});

// GET & POST /api/transactions/telegram-admin - Telegram Bot Chat Registration
router.get('/telegram-admin', isAdmin, async (req, res) => {
  const chatIds = getAdminChatIds();
  return res.json({
    success: true,
    connected: chatIds.length > 0,
    chatIds
  });
});

router.post('/telegram-admin', isAdmin, async (req, res) => {
  try {
    const { chatId } = req.body;
    if (!chatId) {
      return res.status(400).json({ error: 'معرف الشات مطلوب' });
    }

    addAdminChatId(String(chatId).trim());

    await sendTelegramMessage(
      String(chatId).trim(),
      `🎉 <b>تم ربط حسابك كـ أدمن في البوت بنجاح!</b>\n\nستصلك جميع إشعارات صور الإيصالات وطلبات الشحن فورياً على هذا الحساب.`
    );

    return res.json({
      success: true,
      message: `تم تسجيل معرف الشات (${chatId}) بنجاح وإرسال رسالة اختبار لـ تلجرام!`
    });
  } catch (error: any) {
    console.error('Error setting telegram admin:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء حفظ معرف الشات' });
  }
});

export default router;
