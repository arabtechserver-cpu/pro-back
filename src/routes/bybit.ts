import { Router } from 'express';
import crypto from 'crypto';
import { prisma } from '../utils/prisma';
import { authenticateToken } from '../middleware/auth';
import {
  verifyBybitDepositRecord,
  fetchBybitDepositAddresses,
  BybitDepositRecord
} from '../services/bybitService';
import { sendTelegramPhotoNotification } from '../utils/telegramService';
import { checkAndAutoUpgradeMembership } from '../utils/membershipUpgrade';

const router = Router();
const bybitMutex = new Set<string>();

const DEFAULT_BYBIT_NETWORKS = [
  {
    chain: 'TRX',
    chainType: 'TRON (TRC20)',
    address: 'TFT4t2shanZFQn5aT5Kvas7bsf3Xap9toe',
    nameAr: 'شبكة ترون (TRC20) - الأكثر استخداماً',
    nameEn: 'TRON (TRC20)'
  },
  {
    chain: 'BSC',
    chainType: 'BSC (BEP20)',
    address: '0xafd534f94c99aa0ae7de9b1967bd0f4e038644c5',
    nameAr: 'شبكة بينانس الذكية (BEP20) - عمولة منخفضة',
    nameEn: 'BNB Smart Chain (BEP20)'
  },
  {
    chain: 'ETH',
    chainType: 'Ethereum (ERC20)',
    address: '0xafd534f94c99aa0ae7de9b1967bd0f4e038644c5',
    nameAr: 'شبكة إيثيريوم (ERC20)',
    nameEn: 'Ethereum (ERC20)'
  },
  {
    chain: 'MATIC',
    chainType: 'Polygon PoS',
    address: '0xafd534f94c99aa0ae7de9b1967bd0f4e038644c5',
    nameAr: 'شبكة بوليجون (Polygon PoS)',
    nameEn: 'Polygon PoS'
  },
  {
    chain: 'ARBI',
    chainType: 'Arbitrum One(USDT0)',
    address: '0xafd534f94c99aa0ae7de9b1967bd0f4e038644c5',
    nameAr: 'شبكة أربيتروم (Arbitrum One)',
    nameEn: 'Arbitrum One'
  },
  {
    chain: 'TON',
    chainType: 'TON',
    address: 'UQB6wXz3mUc2I6b_hdPQTiyEyt3xkXl0_km4_mxgz36OyC0E',
    nameAr: 'شبكة تون (TON)',
    nameEn: 'The Open Network (TON)'
  },
  {
    chain: 'SOL',
    chainType: 'SOL',
    address: 'Gu7hKmCXNKr8An1ZaaNRpseLkdguHnpBht4jZtGgJpqY',
    nameAr: 'شبكة سولانا (Solana)',
    nameEn: 'Solana (SOL)'
  }
];

function getAllowedAddresses(): string[] {
  return DEFAULT_BYBIT_NETWORKS.map(n => n.address.toLowerCase());
}

router.get('/config', authenticateToken, async (_req, res) => {
  try {
    const uid = process.env.BYBIT_UID || '600627456';
    let networks = DEFAULT_BYBIT_NETWORKS;

    try {
      const liveChains = await fetchBybitDepositAddresses('USDT');
      if (liveChains && liveChains.length > 0) {
        networks = DEFAULT_BYBIT_NETWORKS.map(defNet => {
          const matched = liveChains.find(c => c.chain === defNet.chain || c.chainType === defNet.chainType);
          return matched?.addressDeposit ? { ...defNet, address: matched.addressDeposit } : defNet;
        });
      }
    } catch {
      // Use fallback default networks
    }

    return res.json({
      success: true,
      uid,
      accountName: 'ARABTECH',
      networks
    });
  } catch (error: any) {
    return res.status(500).json({ error: 'Failed to fetch Bybit config' });
  }
});

router.post('/create-intent', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول لإنشاء طلب الشحن' });
    }

    const { amount, network } = req.body;
    const numAmount = parseFloat(amount);
    if (!Number.isFinite(numAmount) || numAmount < 1.0 || numAmount > 50000) {
      return res.status(400).json({ error: 'الحد الأدنى لمبلغ الإيداع عبر Bybit هو $1.00 USD' });
    }

    const orderId = `BYBIT_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;

    const paymentIntent = await prisma.paymentIntent.create({
      data: {
        userId,
        provider: 'bybit',
        orderId,
        amount: numAmount,
        currency: 'USDT',
        status: 'created'
      }
    });

    const selectedNetwork = DEFAULT_BYBIT_NETWORKS.find(n => n.chain === network || n.chainType === network) || DEFAULT_BYBIT_NETWORKS[0];

    return res.json({
      success: true,
      orderId: paymentIntent.orderId,
      amount: numAmount,
      currency: 'USDT',
      recipientAddress: selectedNetwork.address,
      network: selectedNetwork.chainType,
      bybitUid: process.env.BYBIT_UID || '600627456'
    });
  } catch (error: any) {
    console.error('[Bybit Create Intent Error]:', error);
    return res.status(500).json({ error: error?.message || 'تعذر إنشاء طلب الشحن عبر Bybit' });
  }
});

router.post('/verify-deposit', authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) {
      return res.status(401).json({ error: 'يجب تسجيل الدخول للتحقق من العملية' });
    }

    const { orderId, txId } = req.body;
    const cleanOrderId = (orderId || '').trim();
    const cleanTxId = (txId || '').trim();

    if (!cleanOrderId) {
      return res.status(400).json({ error: 'رقم الطلب (orderId) مطلوب للتحقق' });
    }

    if (!cleanTxId) {
      return res.status(400).json({ error: 'رقم أو هاش المعاملة (TxID / Hash) مطلوب للتحقق' });
    }

    const paymentIntent = await prisma.paymentIntent.findUnique({
      where: {
        provider_orderId: {
          provider: 'bybit',
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

    const mutexKey = `${cleanOrderId}_${cleanTxId.toLowerCase()}`;
    if (bybitMutex.has(mutexKey)) {
      return res.status(429).json({ error: 'جاري التحقق من المعاملة حالياً، يرجى الانتظار...' });
    }
    bybitMutex.add(mutexKey);

    try {
      // Replay attack check: Ensure this txID has not been captured before
      const existingCapturedIntent = await prisma.paymentIntent.findFirst({
        where: {
          provider: 'bybit',
          captureId: cleanTxId,
          status: 'completed'
        }
      });

      if (existingCapturedIntent) {
        return res.status(400).json({
          error: 'تم استخدام هاش المعاملة هذا مسبقاً في شحن رصيد آخر. لا يمكن إعادة استخدام نفس العملية.'
        });
      }

      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          refNo: {
            contains: cleanTxId
          },
          status: 'completed'
        }
      });

      if (existingTransaction) {
        return res.status(400).json({
          error: 'تم استخدام هاش المعاملة هذا مسبقاً في عملية مالية مؤكدة.'
        });
      }

      // Verify directly with Bybit V5 API
      const verification = await verifyBybitDepositRecord({
        txId: cleanTxId,
        expectedAmount: paymentIntent.amount,
        acceptedAddresses: getAllowedAddresses()
      });

      if (!verification.verified || !verification.deposit) {
        return res.status(400).json({
          success: false,
          error: verification.reason || 'تعذر تأكيد العملية من منصة Bybit'
        });
      }

      const depositRecord: BybitDepositRecord = verification.deposit;
      const refNo = `BYBIT_${cleanTxId}`;

      const txResult = await prisma.$transaction(async (tx) => {
        const updateResult = await tx.paymentIntent.updateMany({
          where: {
            id: paymentIntent.id,
            status: { in: ['created', 'pending'] }
          },
          data: {
            status: 'completed',
            captureId: cleanTxId
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
            type: 'شحن محفظة (Bybit فوري)',
            amount: paymentIntent.amount,
            method: `باي بيت Bybit (${depositRecord.chain || 'USDT'}) تلقائي`,
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
        '[BYBIT PAY SUCCESS] تم تأكيد واستلام إيداع Bybit حقيقي بنجاح',
        '',
        `رقم الطلب: ${cleanOrderId}`,
        `هاش المعاملة (TxID): ${cleanTxId}`,
        `الشبكة: ${depositRecord.chain}`,
        `حساب العميل: ${updatedUser.fullName} (@${updatedUser.username})`,
        `المبلغ المشحون: +$${paymentIntent.amount.toFixed(2)} USDT`,
        `رصيد المحفظة الجديد: $${updatedUser.balance.toFixed(2)} USD`,
        'الحالة: مكتمل ومؤكد تلقائياً عبر Bybit API'
      ].join('\n');

      sendTelegramPhotoNotification({ caption }).catch(() => {});

      return res.json({
        success: true,
        paid: true,
        alreadyCaptured: false,
        amount: paymentIntent.amount,
        balance: updatedUser.balance,
        orderId: cleanOrderId,
        txId: cleanTxId,
        chain: depositRecord.chain,
        message: `تم التحقق بنجاح من Bybit وإضافة $${paymentIntent.amount.toFixed(2)} USD إلى محفظتك`
      });
    } finally {
      bybitMutex.delete(mutexKey);
    }
  } catch (error: any) {
    console.error('[Bybit Verify Deposit Error]:', error);
    return res.status(500).json({ error: error?.message || 'حدث خطأ أثناء التحقق من عملية Bybit' });
  }
});

export default router;
