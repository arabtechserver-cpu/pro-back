import { Router } from 'express';
import { prisma } from "../utils/prisma";
import {
  sendTelegramPhotoNotification,
  getAdminChatIds,
  refreshAdminIds,
  sendTelegramMessage,
  escapeHtml
} from '../utils/telegramService';
import { isAdmin, authenticateToken, optionalAuth } from '../middleware/auth';
import { checkAndAutoUpgradeMembership } from '../utils/membershipUpgrade';
import { sendDepositApprovalEmail, sendDepositPendingEmail } from '../utils/emailService';
import { buildAdminTransactionPageQuery, normalizeTransactionListQuery } from '../utils/transaction-query';
import { saveBufferToUploads } from '../utils/uploads';

const router = Router();

// GET /api/transactions?userId=... - Fetch Real User Transactions
router.get('/', authenticateToken, async (req, res) => {
  try {
    const { userId, email } = req.query;

    let targetUserId = userId as string;
    const authUser = (req as any).user;
    const isAdminUser = authUser && (authUser.role === 'admin' || authUser.role === 'super_admin');

    // Prevent IDOR: force own user id if not an admin
    if (!isAdminUser && authUser) {
      targetUserId = authUser.id;
    } else if (!targetUserId && email) {
      const u = await prisma.user.findUnique({ where: { email: (email as string).trim().toLowerCase() } });
      if (u) targetUserId = u.id;
    }

    if (!targetUserId && isAdminUser) {
      const listQuery = normalizeTransactionListQuery(req.query as Record<string, unknown>);
        const pageQuery = buildAdminTransactionPageQuery(listQuery);

        const [rows, filteredTotal, statusCounts] = await Promise.all([
          prisma.transaction.findMany(pageQuery),
          prisma.transaction.count({ where: pageQuery.where }),
          prisma.transaction.groupBy({ by: ['status'], _count: { _all: true } })
        ]);

        const hasMore = rows.length > listQuery.limit;
        const pageRows = hasMore ? rows.slice(0, listQuery.limit) : rows;
        const receiptRows = pageRows.length > 0
          ? await prisma.transaction.findMany({
              where: {
                id: { in: pageRows.map((transaction) => transaction.id) },
                receiptImage: { not: null }
              },
              select: { id: true }
            })
          : [];
        const receiptIds = new Set(receiptRows.map((transaction) => transaction.id));
        const summary = statusCounts.reduce(
          (acc, item) => {
            const count = item._count._all;
            acc.total += count;
            if (item.status === 'pending') acc.pending = count;
            if (item.status === 'completed') acc.completed = count;
            return acc;
          },
          { total: 0, pending: 0, completed: 0 }
        );

        return res.json({
          success: true,
          transactions: pageRows.map((transaction) => ({
            ...transaction,
            hasReceipt: receiptIds.has(transaction.id)
          })),
          summary,
          pagination: {
            limit: listQuery.limit,
            filteredTotal,
            hasMore,
            nextCursor: hasMore ? pageRows[pageRows.length - 1]?.id || null : null
          }
        });
      }


    if (!targetUserId) {
      return res.json({ success: true, transactions: [] });
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

// GET /api/transactions/:transactionId/receipt - Load a large receipt only when opened by an admin
router.get('/:transactionId/receipt', isAdmin, async (req, res) => {
  try {
    const transaction = await prisma.transaction.findUnique({
      where: { id: String(req.params.transactionId) },
      select: { receiptImage: true }
    });

    if (!transaction) return res.status(404).json({ error: 'العملية غير موجودة' });
    if (!transaction.receiptImage) return res.status(404).json({ error: 'لا توجد صورة إيصال لهذه العملية' });

    return res.json({ success: true, receiptImage: transaction.receiptImage });
  } catch (error: any) {
    console.error('Error fetching transaction receipt:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب صورة الإيصال' });
  }
});

// POST /api/transactions - Submit New Deposit Transaction (SQLite DB & Telegram)
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { userId, email, type, amount, method, refNo, receiptImage } = req.body;

    if (!amount || !method || !refNo) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة (المبلغ، طريقة الدفع، رقم المرجع)' });
    }

    // 1. Authenticated user from token has highest priority and is guaranteed to exist
    const targetUserId = (req as any).user?.id;

    if (!targetUserId) {
      return res.status(401).json({ error: 'يُرجى تسجيل الدخول بحسابك أولاً لإتمام طلب الشحن' });
    }

    const cleanRefNo = String(refNo).trim();
    const cleanMethod = String(method).trim();
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح، يرجى إدخال قيمة صحيحة' });
    }

    // 1. Check duplicate reference number (same refNo already pending or completed)
    const existingSameRef = await prisma.transaction.findFirst({
      where: {
        refNo: { equals: cleanRefNo, mode: 'insensitive' },
        status: { in: ['pending', 'completed'] }
      }
    });

    if (existingSameRef) {
      if (existingSameRef.status === 'pending') {
        return res.status(400).json({
          error: `رقم المعاملة أو الإشعار (${cleanRefNo}) مسجل مسبقا وهو قيد المراجعة حاليا من قبل الإدارة. يرجى الانتظار لتفادي التكرار.`
        });
      } else {
        return res.status(400).json({
          error: `تم اعتماد هذا الإشعار/الرقم المرجعي (${cleanRefNo}) مسبقا وشحن الرصيد به. لا يمكن إعادة استخدامه.`
        });
      }
    }

    // 2. Prevent spam / rapid consecutive deposit requests from the same user (within 30 seconds)
    const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
    const recentPendingTx = await prisma.transaction.findFirst({
      where: {
        userId: targetUserId,
        status: 'pending',
        createdAt: { gte: thirtySecondsAgo }
      }
    });

    if (recentPendingTx) {
      return res.status(429).json({
        error: 'تم إرسال طلب إيداع من حسابك قبل قليل وهو قيد المراجعة. يرجى الانتظار بضع لحظات قبل إرسال طلب جديد لتجنب التكرار.'
      });
    }

    // 3. Handle receipt image with strict MIME validation to prevent Stored XSS
    let savedReceiptUrl = null;
    let localDiskPath: string | null = null;
    
    if (receiptImage && typeof receiptImage === 'string') {
      if (!receiptImage.startsWith('data:image/')) {
        return res.status(400).json({ error: 'صيغة الصورة غير صالحة. يجب أن تكون Base64 تبدأ بـ data:image/' });
      }
      try {
        const match = receiptImage.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s);
        if (match) {
          const mimeType = match[1].toLowerCase();
          const allowedMimeTypes: Record<string, string> = {
            'image/jpeg': 'jpg',
            'image/jpg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp'
          };

          const ext = allowedMimeTypes[mimeType];
          if (!ext) {
            return res.status(400).json({ error: 'نوع صورة الإيصال غير مدعوم. يسمح فقط بصيغ JPG و PNG و WEBP.' });
          }

          const base64Data = match[2];
          const buffer = Buffer.from(base64Data, 'base64');
          if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
            return res.status(400).json({ error: 'حجم صورة الإيصال يجب ألا يتجاوز 10 ميجابايت.' });
          }

          const filename = `receipt_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
          localDiskPath = saveBufferToUploads(filename, buffer);
          savedReceiptUrl = `/uploads/${filename}`;
        } else {
          return res.status(400).json({ error: 'تنسيق الصورة (Base64) غير صالح أو معطوب.' });
        }
      } catch (saveErr) {
        console.error('[Transactions] Error saving receipt image to disk:', saveErr);
        return res.status(500).json({ error: 'فشل في حفظ صورة الإيصال.' });
      }
    }

    const newTransaction = await prisma.transaction.create({
      data: {
        userId: targetUserId,
        type: type || 'شحن محفظة',
        amount: parseFloat(amount),
        method: method.trim(),
        refNo: refNo.trim(),
        receiptImage: savedReceiptUrl,
        status: 'pending'
      }
    });

    console.log(`[Pending Deposit Submitted] Saved: ${newTransaction.id} ($${amount}) via ${method} - Awaiting Admin Approval`);

    // Notify Telegram Admin
    const userObj = await prisma.user.findUnique({ where: { id: targetUserId } });
    const safeFullName = escapeHtml(userObj?.fullName || 'عميل');
    const safeUsername = escapeHtml(userObj?.username || 'مستخدم');
    const safeEmail = escapeHtml(userObj?.email || 'N/A');
    const safeMethod = escapeHtml(method);
    const safeRefNo = escapeHtml(refNo);

    const receiptLink = savedReceiptUrl
      ? `\nصورة الإيصال: <a href="https://arabtechproserver.tech${savedReceiptUrl}">عرض الصورة كاملة</a>`
      : '';

    const caption = `
<b>إيداع جديد قيد المراجعة (New Deposit Pending)</b>

- <b>العميل:</b> ${safeFullName} (@${safeUsername})
- <b>البريد:</b> <code>${safeEmail}</code>
- <b>المبلغ المطلوب:</b> <code>+$${parseFloat(amount).toFixed(2)} USD</code>
- <b>طريقة الدفع:</b> ${safeMethod}
- <b>رقم المرجع / الإيصال:</b> <code>${safeRefNo}</code>
- <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}
${receiptLink}

<b>الحالة:</b> قيد المراجعة - يرجى فتح لوحة التحكم أو استخدام الأزرار أدناه.
    `.trim();

    const inlineKeyboard: any[][] = [];
    if (savedReceiptUrl) {
      inlineKeyboard.push([
        { text: "فتح الإيصال بالدقة الكاملة", url: `https://arabtechproserver.tech${savedReceiptUrl}` }
      ]);
    }
    inlineKeyboard.push([
      { text: "موافقة وشحن الرصيد", callback_data: `approve_tx_${newTransaction.id}` },
      { text: "رفض الإيداع", callback_data: `reject_tx_${newTransaction.id}` }
    ]);

    const replyMarkup = { inline_keyboard: inlineKeyboard };

    sendTelegramPhotoNotification({
      imageSource: localDiskPath || savedReceiptUrl || receiptImage,
      caption,
      replyMarkup
    }).catch((err) => console.error('[Telegram Async Error]:', err));

    if (userObj?.email) {
      sendDepositPendingEmail(userObj.email, {
        amount: parseFloat(amount),
        method: method.trim(),
        username: userObj.fullName
      }).catch((err) => console.error('[Deposit Pending Email Error]:', err));
    }

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

    // Fix Race Condition & Lost Updates: Atomic update to prevent double-approving
    let updatedUser: any;
    let uTx: any;

    try {
      [uTx, updatedUser] = await prisma.$transaction(async (t) => {
        const txResult = await t.transaction.updateMany({
          where: { id: transactionId, status: 'pending' },
          data: { status: 'completed' }
        });

        if (txResult.count === 0) {
          throw new Error('ALREADY_PROCESSED');
        }

        const userResult = await t.user.update({
          where: { id: tx.userId },
          data: { balance: { increment: tx.amount } }
        });

        const txObj = await t.transaction.findUnique({ where: { id: transactionId } });
        
        return [txObj, userResult];
      });
    } catch (txError: any) {
      if (txError.message === 'ALREADY_PROCESSED') {
        return res.status(400).json({ error: 'تمت معالجة العملية مسبقاً ولا يمكن تكرارها' });
      }
      throw txError;
    }

    // Automatically check and upgrade user VIP membership tier
    const upgradedUser = await checkAndAutoUpgradeMembership(tx.userId, tx.amount);

    const caption = `
[إشعار إداري]
<b>تمت الموافقة وإضافة الرصيد بنجاح</b>

- <b>العميل:</b> ${updatedUser.fullName} (@${updatedUser.username})
- <b>المبلغ المضاف:</b> <code>+$${tx.amount.toFixed(2)} USD</code>
- <b>رصيد الحساب الجديد:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>
${upgradedUser?.membershipTier ? `- <b>العضوية الحالية:</b> ${upgradedUser.membershipTier.nameAr || upgradedUser.membershipTier.name} (${upgradedUser.membershipTier.discountPercentage}% خصم)` : ''}
    `.trim();

    sendTelegramPhotoNotification({ caption }).catch(() => {});

    // Send confirmation email to customer
    if (updatedUser.email) {
      sendDepositApprovalEmail(updatedUser.email, {
        amount: tx.amount,
        newBalance: updatedUser.balance,
        username: updatedUser.fullName,
        tierName: upgradedUser?.membershipTier ? (upgradedUser.membershipTier.nameAr || upgradedUser.membershipTier.name) : undefined
      }).catch((err) => console.error('[Deposit Email Error]:', err));
    }

    return res.json({
      success: true,
      message: `تم اعتماد إيداع بقيمة $${tx.amount} وزيادة رصيد العميل بنجاح!`,
      transaction: { ...tx, status: 'completed' },
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

    // Fix Race Condition: Atomic update for rejecting
    const updatedTx = await prisma.transaction.updateMany({
      where: { id: transactionId, status: 'pending' },
      data: { status: 'failed' }
    });

    if (updatedTx.count === 0) {
      return res.status(400).json({ error: 'العملية تمت معالجتها مسبقاً' });
    }

    return res.json({
      success: true,
      message: 'تم رفض طلب الشحن',
      transaction: { ...tx, status: 'failed' }
    });
  } catch (error: any) {
    console.error('Error rejecting transaction:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء رفض الطلب' });
  }
});

// GET & POST /api/transactions/telegram-admin - Telegram Bot Chat Registration
router.get('/telegram-admin', isAdmin, async (req, res) => {
  const chatIds = await refreshAdminIds();
  return res.json({
    success: true,
    connected: chatIds.length > 0,
    chatIds
  });
});


export default router;
