import { Router } from 'express';
import { prisma } from '../server';
import { createPayPalOrder, capturePayPalOrder } from '../services/paypalService';
import { sendTelegramPhotoNotification } from '../utils/telegramService';

const router = Router();

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

    const paypalOrder = await createPayPalOrder(numAmount, returnUrl, cancelUrl);

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
  } catch (error: any) {
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
    const existingTx = await prisma.transaction.findFirst({
      where: { refNo: orderId }
    });

    if (existingTx && existingTx.status === 'completed') {
      const user = await prisma.user.findUnique({ where: { id: existingTx.userId } });
      return res.json({
        success: true,
        message: 'تم خصم وتفعيل هذا الطلب سابقاً في المحفظة! ✅',
        amount: existingTx.amount,
        balance: user?.balance || 0.0,
        alreadyCaptured: true
      });
    }

    // Call PayPal capture API
    const captureResult = await capturePayPalOrder(orderId);

    const isCompleted = captureResult?.status === 'COMPLETED' || 
                        captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.status === 'COMPLETED';

    if (!isCompleted && captureResult?.status !== 'ALREADY_CAPTURED') {
      return res.status(400).json({
        error: 'لم تكتمل عملية الدفع عبر PayPal أو تم إلغاؤها من قبل المستخدم.'
      });
    }

    // Find Target User
    let targetUserId = userId;
    let dbUser: any = null;

    if (userId) {
      dbUser = await prisma.user.findUnique({ where: { id: userId } });
    } else if (email) {
      dbUser = await prisma.user.findUnique({ where: { email: email.trim().toLowerCase() } });
      if (dbUser) targetUserId = dbUser.id;
    }

    if (!targetUserId) {
      const firstUser = await prisma.user.findFirst();
      if (firstUser) {
        targetUserId = firstUser.id;
        dbUser = firstUser;
      }
    }

    // Extract captured amount
    const capturedAmount = parseFloat(
      captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.amount?.value || 10.0
    );

    // 1. Create or update transaction record in DB as COMPLETED
    const newTx = existingTx
      ? await prisma.transaction.update({
          where: { id: existingTx.id },
          data: { status: 'completed' }
        })
      : await prisma.transaction.create({
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
    const updatedUser = await prisma.user.update({
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

    sendTelegramPhotoNotification({ caption }).catch(() => {});

    return res.json({
      success: true,
      message: `تم الدفع وشحن رصيدك بمبلغ $${capturedAmount.toFixed(2)} USD بنجاح! ✅`,
      amount: capturedAmount,
      balance: updatedUser.balance,
      orderId,
      captureId: captureResult?.purchase_units?.[0]?.payments?.captures?.[0]?.id || orderId
    });
  } catch (error: any) {
    console.error('Error capturing PayPal order:', error);
    return res.status(500).json({ error: error.message || 'حدث خطأ أثناء تأكيد عملية الدفع من PayPal' });
  }
});

export default router;
