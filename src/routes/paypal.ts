import { Router } from 'express';
import { prisma } from "../utils/prisma";
import { createPayPalOrder, capturePayPalOrder, verifyPayPalWebhookSignature } from '../services/paypalService';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { checkAndAutoUpgradeMembership } from '../utils/membershipUpgrade';
import { authenticateToken } from '../middleware/auth';

const router = Router();

// Mutex (In-memory Lock) to prevent local double-capture race conditions
const captureMutex = new Set<string>();

// POST /api/wallet/paypal/create-order
router.post('/create-order', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول لإنشاء طلب الدفع' });
    }

    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 1.0) {
      return res.status(400).json({ error: 'الحد الأدنى لمبلغ الإيداع عبر PayPal هو $1.00 USD' });
    }

    const originHost = req.headers.origin || 'https://arabtechproserver.tech';
    const returnUrl = `${originHost}/ar/wallet?paypal=success`;
    const cancelUrl = `${originHost}/ar/wallet?paypal=cancel`;

    const paypalOrder = await createPayPalOrder(numAmount, returnUrl, cancelUrl);

    if (!paypalOrder.approvalUrl || !paypalOrder.orderId) {
      return res.status(500).json({ error: 'لم يتم العثور على رابط تأكيد الدفع من PayPal' });
    }

    // Persist PaymentIntent linked to the authenticated user
    await prisma.paymentIntent.create({
      data: {
        userId,
        provider: 'paypal',
        orderId: paypalOrder.orderId,
        amount: numAmount,
        currency: 'USD',
        status: 'created'
      }
    });

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

// POST /api/wallet/paypal/capture-order
router.post('/capture-order', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'تعذر تحديد حساب المستخدم. يرجى تسجيل الدخول أولاً.' });
    }

    const { orderId } = req.body;
    if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
      return res.status(400).json({ error: 'رقم طلب PayPal (orderId) مطلوب للتحقق والتأكيد' });
    }

    const cleanOrderId = orderId.trim();

    if (captureMutex.has(cleanOrderId)) {
      return res.status(429).json({ error: 'جاري معالجة طلب الدفع حالياً، يرجى الانتظار...' });
    }
    captureMutex.add(cleanOrderId);

    try {
      // 1. Verify PaymentIntent ownership and status
      const paymentIntent = await prisma.paymentIntent.findUnique({
        where: {
          provider_orderId: {
            provider: 'paypal',
            orderId: cleanOrderId
          }
        }
      });

      if (!paymentIntent) {
        return res.status(404).json({ error: 'طلب الدفع غير مسجل في النظام' });
      }

      if (paymentIntent.userId !== userId) {
        return res.status(403).json({ error: 'غير مصرح لك بتحصيل هذا الطلب المالي' });
      }

      if (paymentIntent.status === 'completed') {
        const currentUser = await prisma.user.findUnique({ where: { id: userId } });
        return res.json({
          success: true,
          message: 'تم شحن هذا الرصيد بالفعل سابقاً في محفظتك',
          amount: paymentIntent.amount,
          balance: currentUser?.balance || 0,
          alreadyCaptured: true
        });
      }

      // 2. Call PayPal Capture API
      const captureResult = await capturePayPalOrder(cleanOrderId);

      const captureObj = captureResult?.purchase_units?.[0]?.payments?.captures?.[0];
      const overallStatus = captureResult?.status;
      const captureStatus = captureObj?.status;
      const isFullyCompleted = overallStatus === 'COMPLETED' || captureStatus === 'COMPLETED';

      if (!isFullyCompleted) {
        return res.status(400).json({
          error: 'لم تكتمل عملية الدفع عبر PayPal أو تم رفضها من قبل البنك أو المزود'
        });
      }

      const rawCapturedValue = captureObj?.amount?.value || captureResult?.purchase_units?.[0]?.amount?.value;
      const capturedAmount = parseFloat(rawCapturedValue);

      if (isNaN(capturedAmount) || capturedAmount <= 0) {
        return res.status(400).json({
          error: 'تعذر التحقق من القيمة الحقيقية للمبلغ المدفوع من PayPal'
        });
      }

      const currency = captureObj?.amount?.currency_code || captureResult?.purchase_units?.[0]?.amount?.currency_code || 'USD';
      if (currency.toUpperCase() !== (paymentIntent.currency || 'USD').toUpperCase()) {
        return res.status(400).json({
          error: 'العملة المدفوعة لا تطابق العملة المحددة للطلب'
        });
      }

      if (Math.abs(capturedAmount - paymentIntent.amount) > 0.01) {
        return res.status(400).json({
          error: 'المبلغ المدفوع لا يطابق المبلغ المسجل في طلب الدفع'
        });
      }

      const captureId = captureObj?.id || cleanOrderId;
      const refNo = `PAYPAL_${paymentIntent.id}_${captureId}`;

      // 3. Atomic Database Update with conditional reservation
      const result = await prisma.$transaction(async (tx) => {
        const updateResult = await tx.paymentIntent.updateMany({
          where: {
            id: paymentIntent.id,
            status: { in: ['created', 'pending'] }
          },
          data: {
            status: 'completed',
            captureId: captureId
          }
        });

        if (updateResult.count === 0) {
          const existingUser = await tx.user.findUnique({ where: { id: userId } });
          return {
            alreadyCaptured: true,
            balance: existingUser?.balance || 0,
            user: existingUser
          };
        }

        const createdTx = await tx.transaction.create({
          data: {
            userId: userId,
            type: 'شحن محفظة (PayPal فوري)',
            amount: capturedAmount,
            method: 'باي بال PayPal (تلقائي معتمد)',
            status: 'completed',
            refNo: refNo
          }
        });

        const updatedUser = await tx.user.update({
          where: { id: userId },
          data: { balance: { increment: capturedAmount } }
        });

        return {
          alreadyCaptured: false,
          balance: updatedUser.balance,
          user: updatedUser,
          createdTx
        };
      });

      if (result.alreadyCaptured) {
        return res.json({
          success: true,
          message: 'تم شحن هذا الرصيد بالفعل سابقاً في محفظتك',
          amount: paymentIntent.amount,
          balance: result.balance,
          alreadyCaptured: true
        });
      }

      const updatedUser = result.user!;
      await checkAndAutoUpgradeMembership(userId, capturedAmount);

      const payerEmail = captureResult?.payer?.email_address || updatedUser.email;
      const caption = [
        '[PAYPAL SUCCESS] تم تأكيد واستلام دفعة PayPal حقيقية بنجاح',
        '',
        `رقم العملية: ${cleanOrderId}`,
        `معرف التحصيل: ${captureId}`,
        `حساب العميل: ${updatedUser.fullName} (@${updatedUser.username})`,
        `إيميل الدفع: ${payerEmail}`,
        `المبلغ المستلم: +$${capturedAmount.toFixed(2)} USD`,
        `رصيد المحفظة الجديد: $${updatedUser.balance.toFixed(2)} USD`,
        'الحالة: مكتمل ومؤكد'
      ].join('\n');

      sendTelegramPhotoNotification({ caption }).catch(() => {});

      return res.json({
        success: true,
        message: `تم التحقق واستلام الدفعة وإضافة $${capturedAmount.toFixed(2)} USD إلى محفظتك بنجاح`,
        amount: capturedAmount,
        balance: updatedUser.balance,
        orderId: cleanOrderId,
        captureId
      });
    } finally {
      captureMutex.delete(cleanOrderId);
    }
  } catch (error: any) {
    console.error('Error capturing PayPal order:', error);
    return res.status(400).json({ error: error.message || 'فشل التحقق من صحة الدفع عبر PayPal' });
  }
});

// POST /api/wallet/paypal/webhook
router.post('/webhook', async (req, res) => {
  try {
    // 1. Mandatory PayPal Webhook Signature Verification
    const verification = await verifyPayPalWebhookSignature(req.headers as any, req.body);
    if (!verification.verified) {
      console.warn('[PayPal Webhook] Signature verification failed:', verification.error);
      return res.status(401).json({
        error: 'PayPal webhook signature verification failed',
        detail: verification.error
      });
    }

    const event = req.body;
    if (!event || !event.event_type) {
      return res.status(400).json({ error: 'Invalid webhook payload' });
    }

    const eventType = event.event_type;
    const resource = event.resource;
    const eventId = String(event.id || '');

    // 2. Handle PAYMENT.CAPTURE.COMPLETED (for out-of-band or browser-closed completions)
    if (eventType === 'PAYMENT.CAPTURE.COMPLETED') {
      const captureId = resource?.id;
      if (!captureId) {
        return res.status(400).json({ error: 'Missing capture ID in webhook resource' });
      }

      const rawAmount = resource?.amount?.value;
      const capturedAmount = parseFloat(rawAmount);
      if (isNaN(capturedAmount) || capturedAmount <= 0) {
        return res.status(400).json({ error: 'Invalid captured amount' });
      }

      const relatedOrderId = resource?.supplementary_data?.related_ids?.order_id;
      const intent = await prisma.paymentIntent.findFirst({
        where: {
          OR: [
            { captureId: captureId },
            ...(relatedOrderId ? [{ orderId: relatedOrderId }] : [])
          ]
        }
      });

      if (!intent) {
        return res.status(200).json({ received: true, message: 'Intent not found, skipping webhook capture' });
      }

      if (intent.status === 'completed') {
        return res.status(200).json({ received: true, message: 'Intent already completed' });
      }

      const resourceCurrency = (resource?.amount?.currency_code || 'USD').toUpperCase();
      if (resourceCurrency !== (intent.currency || 'USD').toUpperCase()) {
        return res.status(400).json({ error: 'Currency mismatch in webhook resource' });
      }

      const refNo = `PAYPAL_${intent.id}_${captureId}`;

      await prisma.$transaction(async (tx) => {
        const updateRes = await tx.paymentIntent.updateMany({
          where: { id: intent.id, status: { in: ['created', 'pending'] } },
          data: { status: 'completed', captureId }
        });

        if (updateRes.count === 0) {
          return;
        }

        await tx.transaction.create({
          data: {
            userId: intent.userId,
            type: 'شحن محفظة (PayPal Webhook تلقائي)',
            amount: capturedAmount,
            method: 'باي بال PayPal (Webhook)',
            status: 'completed',
            refNo: refNo
          }
        });

        await tx.user.update({
          where: { id: intent.userId },
          data: { balance: { increment: capturedAmount } }
        });
      });

      console.log(`[PayPal Webhook] Successfully completed capture ${captureId} for user ${intent.userId}`);
    }

    // 3. Handle PAYMENT.CAPTURE.REFUNDED / REVERSED
    if (eventType === 'PAYMENT.CAPTURE.REFUNDED' || eventType === 'PAYMENT.CAPTURE.REVERSED') {
      const captureId = resource?.id || resource?.parent_payment;
      if (!captureId) {
        return res.status(400).json({ error: 'Missing capture ID in webhook resource' });
      }

      const rawAmount = resource?.amount?.value;
      const refundAmount = parseFloat(rawAmount);

      if (isNaN(refundAmount) || refundAmount <= 0) {
        return res.status(400).json({ error: 'Invalid or negative refund amount rejected' });
      }

      const intent = await prisma.paymentIntent.findFirst({
        where: { captureId: captureId, status: 'completed' }
      });

      if (!intent) {
        return res.status(200).json({ received: true, ignored: 'Intent not found or already refunded' });
      }

      const resourceCurrency = resource?.amount?.currency_code || 'USD';
      if (resourceCurrency.toUpperCase() !== (intent.currency || 'USD').toUpperCase()) {
        return res.status(400).json({ error: 'Currency mismatch in webhook resource' });
      }

      if (refundAmount > intent.amount) {
        return res.status(400).json({ error: 'Refund amount exceeds intent amount' });
      }

      const refNo = `PAYPAL_REVERSAL_${captureId}_${eventId || Date.now()}`;

      await prisma.$transaction(async (tx) => {
        const updateResult = await tx.paymentIntent.updateMany({
          where: { id: intent.id, status: 'completed' },
          data: { status: 'refunded' }
        });

        if (updateResult.count === 0) {
          return;
        }

        await tx.transaction.create({
          data: {
            userId: intent.userId,
            type: 'عكس عملية شحن (PayPal Refund/Reversal)',
            amount: refundAmount,
            method: 'PayPal Reversal',
            status: 'completed',
            refNo: refNo
          }
        });

        await tx.user.update({
          where: { id: intent.userId },
          data: { balance: { decrement: refundAmount } }
        });
      });

      console.log(`[PayPal Webhook] Processed refund/reversal for capture ${captureId}`);
    }

    return res.status(200).json({ received: true });
  } catch (err: any) {
    console.error('[PayPal Webhook Error]:', err?.message || err);
    return res.status(500).json({ error: 'Webhook processing error' });
  }
});

export default router;
