import { Router } from 'express';
import { prisma } from '../utils/prisma';
import {
  createBinanceOrder,
  queryBinanceOrder,
  verifyBinanceWebhookHeader
} from '../services/binanceService';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { checkAndAutoUpgradeMembership } from '../utils/membershipUpgrade';
import { authenticateToken } from '../middleware/auth';

const router = Router();
const binanceMutex = new Set<string>();

router.post('/create-order', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول لإنشاء طلب الدفع' });
    }

    const { amount } = req.body;
    const numAmount = parseFloat(amount);
    if (isNaN(numAmount) || numAmount < 1.0) {
      return res.status(400).json({ error: 'الحد الأدنى لمبلغ الإيداع عبر Binance Pay هو $1.00 USD' });
    }

    const originHost = req.headers.origin || 'https://arabtechproserver.tech';
    const returnUrl = `${originHost}/ar/wallet?binance=success`;
    const cancelUrl = `${originHost}/ar/wallet?binance=cancel`;

    const binanceOrder = await createBinanceOrder(numAmount, returnUrl, cancelUrl);

    await prisma.paymentIntent.create({
      data: {
        userId,
        provider: 'binance',
        orderId: binanceOrder.merchantTradeNo,
        amount: numAmount,
        currency: 'USDT',
        status: 'created'
      }
    });

    return res.json({
      success: true,
      orderId: binanceOrder.merchantTradeNo,
      prepayId: binanceOrder.prepayId,
      checkoutUrl: binanceOrder.checkoutUrl,
      universalUrl: binanceOrder.universalUrl,
      qrContent: binanceOrder.qrContent,
      amount: numAmount
    });
  } catch (error: any) {
    console.error('[Binance Create Order Error]:', error);
    return res.status(500).json({
      error: error.message || 'حدث خطأ أثناء التواصل مع بوابة Binance Pay'
    });
  }
});

router.post('/check-order', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول للتحقق من حالة الطلب' });
    }

    const { orderId } = req.body;
    if (!orderId || typeof orderId !== 'string' || orderId.trim() === '') {
      return res.status(400).json({ error: 'رقم العملية (orderId) مطلوب للتحقق' });
    }

    const cleanOrderId = orderId.trim();

    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: {
        provider_orderId: {
          provider: 'binance',
          orderId: cleanOrderId
        }
      }
    });

    if (!paymentIntent) {
      return res.status(404).json({ error: 'طلب الدفع غير مسجل في النظام' });
    }

    if (paymentIntent.userId !== userId) {
      return res.status(403).json({ error: 'غير مصرح لك بالتحقق من هذا الطلب المالي' });
    }

    if (paymentIntent.status === 'completed') {
      const currentUser = await prisma.user.findUnique({ where: { id: userId } });
      return res.json({
        success: true,
        paid: true,
        alreadyCaptured: true,
        amount: paymentIntent.amount,
        balance: currentUser?.balance || 0,
        message: 'تم شحن هذا الرصيد بالفعل سابقاً في محفظتك'
      });
    }

    if (binanceMutex.has(cleanOrderId)) {
      return res.status(429).json({ error: 'جاري التحقق من العملية حالياً، يرجى الانتظار...' });
    }
    binanceMutex.add(cleanOrderId);

    try {
      const queryResult = await queryBinanceOrder(cleanOrderId, paymentIntent.orderId);

      if (queryResult.status !== 'PAID') {
        return res.json({
          success: true,
          paid: false,
          status: queryResult.status,
          message: 'لم يتم استلام الدفعة بعد من Binance Pay'
        });
      }

      if (
        queryResult.orderAmount > 0 &&
        Math.abs(queryResult.orderAmount - paymentIntent.amount) > 0.05
      ) {
        return res.status(400).json({
          error: 'المبلغ المدفوع في باينانس لا يتطابق مع المبلغ المحدد للطلب'
        });
      }

      const captureId = queryResult.transactionId || `TX_${Date.now()}`;
      const refNo = `BINANCE_${paymentIntent.id}_${captureId}`;

      const txResult = await prisma.$transaction(async (tx) => {
        const updateResult = await tx.paymentIntent.updateMany({
          where: {
            id: paymentIntent.id,
            status: { in: ['created', 'pending'] }
          },
          data: {
            status: 'completed',
            captureId
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
            userId,
            type: 'شحن محفظة (Binance Pay فوري)',
            amount: paymentIntent.amount,
            method: 'باينانس باي Binance Pay (تلقائي معتمد)',
            status: 'completed',
            refNo
          }
        });

        const updatedUser = await tx.user.update({
          where: { id: userId },
          data: { balance: { increment: paymentIntent.amount } }
        });

        return {
          alreadyCaptured: false,
          balance: updatedUser.balance,
          user: updatedUser,
          createdTx
        };
      });

      if (txResult.alreadyCaptured) {
        return res.json({
          success: true,
          paid: true,
          alreadyCaptured: true,
          amount: paymentIntent.amount,
          balance: txResult.balance,
          message: 'تم شحن هذا الرصيد بالفعل سابقاً'
        });
      }

      const updatedUser = txResult.user!;
      await checkAndAutoUpgradeMembership(userId, paymentIntent.amount);

      const caption = [
        '[BINANCE PAY SUCCESS] تم تأكيد واستلام دفعة باينانس حقيقية بنجاح',
        '',
        `رقم الطلب: ${cleanOrderId}`,
        `معرف العملية: ${captureId}`,
        `حساب العميل: ${updatedUser.fullName} (@${updatedUser.username})`,
        `المبلغ المشحون: +$${paymentIntent.amount.toFixed(2)} USDT`,
        `رصيد المحفظة الجديد: $${updatedUser.balance.toFixed(2)} USD`,
        'الحالة: مكتمل ومؤكد تلقائياً'
      ].join('\n');

      sendTelegramPhotoNotification({ caption }).catch(() => {});

      return res.json({
        success: true,
        paid: true,
        alreadyCaptured: false,
        amount: paymentIntent.amount,
        balance: updatedUser.balance,
        orderId: cleanOrderId,
        captureId,
        message: `تم التحقق بنجاح وإضافة $${paymentIntent.amount.toFixed(2)} USD إلى محفظتك`
      });
    } finally {
      binanceMutex.delete(cleanOrderId);
    }
  } catch (error: any) {
    console.error('[Binance Check Order Error]:', error);
    return res.status(500).json({
      error: error.message || 'حدث خطأ أثناء فحص حالة طلب باينانس'
    });
  }
});

router.post('/webhook', async (req: any, res) => {
  try {
    const rawHeaders = req.headers;
    const headerInfo = verifyBinanceWebhookHeader(rawHeaders);
    if (!headerInfo) {
      console.warn('[Binance Webhook] Missing required Binance Pay signature headers');
    }

    const payload = req.body;
    const bizStatus = payload?.bizStatus;
    const dataObj = typeof payload?.data === 'string' ? JSON.parse(payload.data) : payload?.data;

    const merchantTradeNo = dataObj?.merchantTradeNo;
    const transactionId = dataObj?.transactionId;
    const rawTotalFee = dataObj?.totalFee || dataObj?.orderAmount;
    const paidAmount = parseFloat(rawTotalFee || '0');

    if (!merchantTradeNo || bizStatus !== 'PAY_SUCCESS') {
      return res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
    }

    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: {
        provider_orderId: {
          provider: 'binance',
          orderId: merchantTradeNo
        }
      }
    });

    if (!paymentIntent || paymentIntent.status === 'completed') {
      return res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
    }

    const captureId = transactionId || `TX_${Date.now()}`;
    const refNo = `BINANCE_${paymentIntent.id}_${captureId}`;
    const userId = paymentIntent.userId;
    const creditedAmount = paymentIntent.amount;

    await prisma.$transaction(async (tx) => {
      const updateResult = await tx.paymentIntent.updateMany({
        where: {
          id: paymentIntent.id,
          status: { in: ['created', 'pending'] }
        },
        data: {
          status: 'completed',
          captureId
        }
      });

      if (updateResult.count === 0) {
        return;
      }

      await tx.transaction.create({
        data: {
          userId,
          type: 'شحن محفظة (Binance Pay فوري)',
          amount: creditedAmount,
          method: 'باينانس باي Binance Pay (تلقائي معتمد)',
          status: 'completed',
          refNo
        }
      });

      const updatedUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: creditedAmount } }
      });

      await checkAndAutoUpgradeMembership(userId, creditedAmount);

      const caption = [
        '[BINANCE WEBHOOK] تم استلام وتأكيد دفعة باينانس عبر Webhook',
        '',
        `رقم الطلب: ${merchantTradeNo}`,
        `معرف العملية: ${captureId}`,
        `حساب العميل: ${updatedUser.fullName} (@${updatedUser.username})`,
        `المبلغ المشحون: +$${creditedAmount.toFixed(2)} USDT`,
        `رصيد المحفظة الجديد: $${updatedUser.balance.toFixed(2)} USD`,
        'الحالة: مكتمل ومؤكد تلقائياً'
      ].join('\n');

      sendTelegramPhotoNotification({ caption }).catch(() => {});
    });

    return res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
  } catch (error: any) {
    console.error('[Binance Webhook Error]:', error);
    return res.status(200).json({ returnCode: 'SUCCESS', returnMessage: null });
  }
});

export default router;
