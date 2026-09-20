import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { prisma } from "../utils/prisma";
import {
  sendTelegramPhotoNotification,
  getAdminChatIds,
  refreshAdminIds,
  sendTelegramMessage,
  escapeHtml
} from '../utils/telegramService';
import { isAdmin, authenticateToken, optionalAuth } from '../middleware/auth';
import { dashboardIpGuard } from '../middleware/dashboardIpGuard';
import { checkAndAutoUpgradeMembership } from '../utils/membershipUpgrade';
import { sendDepositApprovalEmail, sendDepositPendingEmail } from '../utils/emailService';
import { buildAdminTransactionPageQuery, normalizeTransactionListQuery } from '../utils/transaction-query';
import { getUploadDir, ensureUploadDir } from '../utils/uploads';

const router = Router();

// GET /api/transactions?userId=... - Fetch Real User Transactions
router.get('/', authenticateToken, async (req: any, res) => {
  try {
    const { userId, email } = req.query;

    let targetUserId = userId as string;
    const authUser = req.user;
    const isAdminUser = authUser && ['admin', 'super_admin'].includes(authUser.role);

    // Prevent IDOR: force own user id if not an admin
    if (!isAdminUser && authUser) {
      targetUserId = authUser.id;
    } else if (!targetUserId && email) {
      const u = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
      if (u) targetUserId = u.id;
    }

    const executeTransactionFetch = async () => {
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
    };

    const isInspectingAdminTransactions = isAdminUser && (!targetUserId || targetUserId !== authUser.id);
    if (isInspectingAdminTransactions) {
      return dashboardIpGuard(req, res, executeTransactionFetch);
    }

    return executeTransactionFetch();
  } catch (error: any) {
    console.error('Error fetching transactions:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب سجل المعاملات' });
  }
});

// GET /api/transactions/:transactionId/receipt - Load receipt payload for authorized caller
router.get('/:transactionId/receipt', authenticateToken, async (req: any, res) => {
  try {
    const authUser = req.user;
    const transaction = await prisma.transaction.findUnique({
      where: { id: String(req.params.transactionId) },
      select: { id: true, userId: true, receiptImage: true }
    });

    if (!transaction) return res.status(404).json({ error: 'العملية غير موجودة' });
    if (!transaction.receiptImage) return res.status(404).json({ error: 'لا توجد صورة إيصال لهذه العملية' });

    const isOwner = authUser && transaction.userId === authUser.id;
    const isAdminUser = authUser && ['admin', 'super_admin'].includes(authUser.role);
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ error: 'غير مصرح لك بعرض هذا الإيصال' });
    }

    const sendReceipt = () => res.json({ success: true, receiptImage: transaction.receiptImage });
    if (!isOwner && isAdminUser) {
      return dashboardIpGuard(req, res, sendReceipt);
    }
    return sendReceipt();
  } catch (error: any) {
    console.error('Error fetching transaction receipt:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء جلب صورة الإيصال' });
  }
});

// GET /api/transactions/:transactionId/receipt-file - Stream receipt image securely
router.get('/:transactionId/receipt-file', authenticateToken, async (req: any, res) => {
  try {
    const authUser = req.user;
    const transaction = await prisma.transaction.findUnique({
      where: { id: String(req.params.transactionId) },
      select: { id: true, userId: true, receiptImage: true }
    });

    if (!transaction || !transaction.receiptImage) {
      return res.status(404).json({ error: 'الإيصال غير موجود' });
    }

    const isOwner = authUser && transaction.userId === authUser.id;
    const isAdminUser = authUser && ['admin', 'super_admin'].includes(authUser.role);
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ error: 'غير مصرح لك بالوصول' });
    }

    const streamFile = () => {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');

      if (transaction.receiptImage!.startsWith('data:image/')) {
        const match = transaction.receiptImage!.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s);
        if (match) {
          res.setHeader('Content-Type', match[1]);
          return res.send(Buffer.from(match[2], 'base64'));
        }
      }

      const filename = path.basename(transaction.receiptImage!);
      const filePath = path.join(getUploadDir(), 'receipts', filename);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }

      const legacyPath = path.join(getUploadDir(), filename);
      if (fs.existsSync(legacyPath)) {
        return res.sendFile(legacyPath);
      }

      return res.status(404).json({ error: 'ملف الإيصال غير موجود على الخادم' });
    };

    if (!isOwner && isAdminUser) {
      return dashboardIpGuard(req, res, streamFile);
    }
    return streamFile();
  } catch (error: any) {
    console.error('Error streaming receipt file:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحميل ملف الإيصال' });
  }
});

// GET /api/transactions/receipts/:filename - Direct file endpoint for saved receipt paths
router.get('/receipts/:filename', authenticateToken, async (req: any, res) => {
  try {
    const authUser = req.user;
    const filename = path.basename(String(req.params.filename));

    const transaction = await prisma.transaction.findFirst({
      where: {
        receiptImage: { contains: filename }
      },
      select: { id: true, userId: true, receiptImage: true }
    });

    if (!transaction) {
      return res.status(404).json({ error: 'الإيصال غير موجود' });
    }

    const isOwner = authUser && transaction.userId === authUser.id;
    const isAdminUser = authUser && ['admin', 'super_admin'].includes(authUser.role);
    if (!isOwner && !isAdminUser) {
      return res.status(403).json({ error: 'غير مصرح لك بالوصول إلى هذا الإيصال' });
    }

    const streamReceipt = () => {
      res.setHeader('Cache-Control', 'private, no-store, max-age=0');
      const filePath = path.join(getUploadDir(), 'receipts', filename);
      if (fs.existsSync(filePath)) {
        return res.sendFile(filePath);
      }
      return res.status(404).json({ error: 'ملف الإيصال غير موجود على الخادم' });
    };

    if (!isOwner && isAdminUser) {
      return dashboardIpGuard(req, res, streamReceipt);
    }
    return streamReceipt();
  } catch (error: any) {
    console.error('Error serving receipt by filename:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تحميل الإيصال' });
  }
});

// POST /api/transactions - Submit New Deposit Transaction
router.post('/', authenticateToken, async (req: any, res) => {
  try {
    const { amount, method, refNo, receiptImage, type } = req.body;

    if (!amount || !method || !refNo) {
      return res.status(400).json({ error: 'جميع الحقول مطلوبة (المبلغ، طريقة الدفع، رقم المرجع)' });
    }

    const targetUserId = req.user?.id;
    if (!targetUserId) {
      return res.status(401).json({ error: 'يُرجى تسجيل الدخول بحسابك أولاً لإتمام طلب الشحن' });
    }

    const cleanRefNo = String(refNo).trim();
    const cleanMethod = String(method).trim();
    const parsedAmount = parseFloat(amount);

    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'المبلغ غير صالح، يرجى إدخال قيمة صحيحة' });
    }

    let savedReceiptPath: string | null = null;
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

          const receiptsDir = path.join(getUploadDir(), 'receipts');
          if (!fs.existsSync(receiptsDir)) {
            fs.mkdirSync(receiptsDir, { recursive: true });
          }

          const filename = `receipt_${Date.now()}_${Math.floor(Math.random() * 10000)}.${ext}`;
          const filePath = path.join(receiptsDir, filename);
          fs.writeFileSync(filePath, buffer);
          savedReceiptPath = `/api/transactions/receipts/${filename}`;
        } else {
          return res.status(400).json({ error: 'تنسيق الصورة (Base64) غير صالح أو معطوب.' });
        }
      } catch (saveErr) {
        console.error('[Transactions] Error saving receipt image to disk:', saveErr);
        return res.status(500).json({ error: 'فشل في حفظ صورة الإيصال.' });
      }
    }

    let newTransaction: any;
    try {
      newTransaction = await prisma.$transaction(async (tx) => {
        const existingSameRef = await tx.transaction.findFirst({
          where: {
            refNo: { equals: cleanRefNo, mode: 'insensitive' },
            status: { in: ['pending', 'completed'] }
          }
        });

        if (existingSameRef) {
          throw new Error(existingSameRef.status === 'pending'
            ? `DUPLICATE_PENDING:${cleanRefNo}`
            : `DUPLICATE_COMPLETED:${cleanRefNo}`);
        }

        const thirtySecondsAgo = new Date(Date.now() - 30 * 1000);
        const recentPendingTx = await tx.transaction.findFirst({
          where: {
            userId: targetUserId,
            status: 'pending',
            createdAt: { gte: thirtySecondsAgo }
          }
        });

        if (recentPendingTx) {
          throw new Error('SPAM_COOLDOWN');
        }

        return tx.transaction.create({
          data: {
            userId: targetUserId,
            type: type || 'شحن محفظة',
            amount: parsedAmount,
            method: cleanMethod,
            refNo: cleanRefNo,
            receiptImage: savedReceiptPath,
            status: 'pending'
          }
        });
      }, { isolationLevel: 'Serializable' });
    } catch (txErr: any) {
      if (txErr.message.startsWith('DUPLICATE_PENDING:')) {
        return res.status(400).json({
          error: `رقم المعاملة أو الإشعار (${cleanRefNo}) مسجل مسبقا وهو قيد المراجعة حاليا من قبل الإدارة.`
        });
      }
      if (txErr.message.startsWith('DUPLICATE_COMPLETED:')) {
        return res.status(400).json({
          error: `تم اعتماد هذا الإشعار/الرقم المرجعي (${cleanRefNo}) مسبقا وشحن الرصيد به. لا يمكن إعادة استخدامه.`
        });
      }
      if (txErr.message === 'SPAM_COOLDOWN') {
        return res.status(429).json({
          error: 'تم إرسال طلب إيداع من حسابك قبل قليل وهو قيد المراجعة. يرجى الانتظار بضع لحظات قبل إرسال طلب جديد.'
        });
      }
      throw txErr;
    }

    console.log(`[Pending Deposit Submitted] Saved: ${newTransaction.id} ($${amount}) via ${method} - Awaiting Admin Approval`);

    // Notify Telegram Admin
    const userObj = await prisma.user.findUnique({ where: { id: targetUserId } });
    const safeFullName = escapeHtml(userObj?.fullName || 'عميل');
    const safeUsername = escapeHtml(userObj?.username || 'مستخدم');
    const safeEmail = escapeHtml(userObj?.email || 'N/A');
    const safeMethod = escapeHtml(method);
    const safeRefNo = escapeHtml(refNo);

    const receiptLink = savedReceiptPath
      ? `\nصورة الإيصال: <a href="https://arabtechproserver.tech${savedReceiptPath}">عرض الصورة كاملة</a>`
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
    if (savedReceiptPath) {
      inlineKeyboard.push([
        { text: "فتح الإيصال بالدقة الكاملة", url: `https://arabtechproserver.tech${savedReceiptPath}` }
      ]);
    }
    inlineKeyboard.push([
      { text: "موافقة وشحن الرصيد", callback_data: `approve_tx_${newTransaction.id}` },
      { text: "رفض الإيداع", callback_data: `reject_tx_${newTransaction.id}` }
    ]);

    const replyMarkup = { inline_keyboard: inlineKeyboard };

    sendTelegramPhotoNotification({
      imageSource: receiptImage || undefined,
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
