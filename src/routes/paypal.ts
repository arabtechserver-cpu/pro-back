import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { createPayPalOrder, capturePayPalOrder } from '../services/paypalService';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { checkAndAutoUpgradeMembership } from '../utils/membershipUpgrade';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// POST /api/wallet/paypal/create-order
router.post('/create-order', authenticateToken, async (req: any, res) => {
  try {
    const { amount } = req.body;

    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 1.0) {
      return res.status(400).json({ error: 'الحد الأدنى لمبلغ الإيداع عبر PayPal هو $1.00 USD' });
    }

    const originHost = req.headers.origin || 'https://arabtechproserver.tech';
    const returnUrl = `${originHost}/ar/wallet?paypal=success`;
    const cancelUrl = `${originHost}/ar/wallet?paypal=cancel`;

    const paypalOrder = await createPayPalOrder(numAmount, returnUrl, cancelUrl);

    if (!paypalOrder.approvalUrl) {
      return res.status(500).json({ error: 'لم يتم العثور على رابط تأكيد الدفع من PayPal' });
    }

    console.log(`[PayPal Order Created] ID: ${paypalOrder.orderId} - Amount: $${numAmount.toFixed(2)} USD`);

    return res.json({
      success: true,
      orderId: paypalOrder.orderId,
      approvalUrl: paypalOrder.approvalUrl,
      amount: numAmount
    });
  } catch (error: any) {
    console.error('Error creating PayPal order:', error);
    return res.status(500).json({ error: error.message || 'حدث خطأ أثناء التواصل مع سيرفر PayPal' });
  }
});

// POST /api/wallet/paypal/capture-order (Strict Real-Money Verification)
router.post('/capture-order', authenticateToken, async (req: any, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
      return res.status(400).json({ error: 'رقم طلب PayPal (orderId) مطلوب للتحقق والتأكيد' });
    }

    const cleanOrderId = orderId.trim();

    // 1. Identify Target User
    const targetUser = req.user?.id
      ? await prisma.user.findUnique({ where: { id: req.user.id } })
      : null;

    if (!targetUser) {
      return res.status(401).json({ error: 'تعذر تحديد حساب المستخدم. يرجى تسجيل الدخول أولاً.' });
    }

    // 2. Anti-Replay Guard: Check if this order was already processed and credited in DB
    const existingTx = await prisma.transaction.findFirst({
      where: {
        OR: [
          { refNo: cleanOrderId },
          { refNo: { startsWith: cleanOrderId } }
        ]
      }
    });

    if (existingTx && existingTx.status === 'completed') {
      const refreshedUser = await prisma.user.findUnique({ where: { id: targetUser.id } });
      return res.json({
        success: true,
        message: 'تم شحن هذا الرصيد بالفعل سابقاً في محفظتك! ✅',
        amount: existingTx.amount,
        balance: refreshedUser?.balance || targetUser.balance,
        alreadyCaptured: true
      });
    }

    // 3. Call PayPal Official Capture API
    const captureResult = await capturePayPalOrder(cleanOrderId);

    // 4. Strict Validation of Capture Status from PayPal
    const captureObj = captureResult?.purchase_units?.[0]?.payments?.captures?.[0];
    const overallStatus = captureResult?.status;
    const captureStatus = captureObj?.status;

    const isFullyCompleted = overallStatus === 'COMPLETED' || captureStatus === 'COMPLETED';

    if (!isFullyCompleted) {
      return res.status(400).json({
        error: 'لم تكتمل عملية الدفع عبر PayPal أو تم رفضها من قبل البنك/المزود.'
      });
    }

    // 5. Strict Extraction of Real Amount Captured
    const rawCapturedValue = captureObj?.amount?.value || captureResult?.purchase_units?.[0]?.amount?.value;
    const capturedAmount = parseFloat(rawCapturedValue);

    if (isNaN(capturedAmount) || capturedAmount <= 0) {
      return res.status(400).json({
        error: 'تعذر التحقق من القيمة الحقيقية للمبلغ المدفوع من PayPal.'
      });
    }

    const captureId = captureObj?.id || cleanOrderId;

    // 6. Atomic Database Update: Record Transaction & Increment User Balance
    const [createdTx, updatedUser] = await prisma.$transaction([
      prisma.transaction.create({
        data: {
          userId: targetUser.id,
          type: 'شحن محفظة (PayPal فوري)',
          amount: capturedAmount,
          method: 'باي بال PayPal (تلقائي معتمد)',
          status: 'completed',
          refNo: `${cleanOrderId}_${captureId}`
        }
      }),
      prisma.user.update({
        where: { id: targetUser.id },
        data: { balance: { increment: capturedAmount } }
      })
    ]);

    // 6.5 Automatically check and upgrade user VIP membership tier
    const upgradedUser = await checkAndAutoUpgradeMembership(targetUser.id, capturedAmount);

    console.log(`[PayPal Live REAL Credit] User: ${updatedUser.username} | Amount: +$${capturedAmount.toFixed(2)} USD | New Balance: $${updatedUser.balance.toFixed(2)} USD | Ref: ${cleanOrderId}`);

    // 7. Send Real-time Verified Telegram Admin Alert
    const payerEmail = captureResult?.payer?.email_address || targetUser.email;
    const payerName = captureResult?.payer?.name ? `${captureResult.payer.name.given_name || ''} ${captureResult.payer.name.surname || ''}`.trim() : targetUser.fullName;

    const caption = `
🎉 <b>تم تأكيد واستلام دفعة PayPal حقيقية بنجاح! 🟢</b>

💳 <b>رقم العملية (PayPal):</b> <code>${cleanOrderId}</code>
🧾 <b>معرف التحصيل (Capture ID):</b> <code>${captureId}</code>
👤 <b>حساب العميل بالموقع:</b> ${updatedUser.fullName} (@${updatedUser.username})
📧 <b>إيميل الدفع (PayPal Payer):</b> <code>${payerEmail}</code>
💰 <b>المبلغ المستلم فعلياً:</b> <code>+$${capturedAmount.toFixed(2)} USD</code>
🏦 <b>رصيد المحفظة بعد الشحن:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
⚡ <b>الحالة:</b> مدفوع ومؤكد من خوادم PayPal مباشرة ✅
    `.trim();

    sendTelegramPhotoNotification({ caption }).catch(() => {});

    return res.json({
      success: true,
      message: `تم التحقق واستلام الدفعة وإضافة $${capturedAmount.toFixed(2)} USD إلى محفظتك بنجاح! ✅`,
      amount: capturedAmount,
      balance: updatedUser.balance,
      orderId: cleanOrderId,
      captureId
    });
  } catch (error: any) {
    console.error('Error capturing PayPal order:', error);
    return res.status(400).json({ error: error.message || 'فشل التحقق من صحة الدفع عبر PayPal' });
  }
});

export default router;
