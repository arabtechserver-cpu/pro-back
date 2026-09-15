import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { prisma } from "../utils/prisma";
import { placeImeiOrder, placeServerOrder } from './dhru-api';
import { sendDepositApprovalEmail, sendOrderConfirmationEmail } from './emailService';
import { checkAndAutoUpgradeMembership } from './membershipUpgrade';
import { normalizeTelegramAdminChatIds } from './telegram-config';
import { resolveOrderServiceType } from './order-response';
import { getUploadDir } from './uploads';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const DEFAULT_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

// Admin Chat IDs - env var is the primary source, DB extends it.
let adminChatIds: string[] = normalizeTelegramAdminChatIds([], DEFAULT_ADMIN_CHAT_ID);
const pendingNotificationsQueue: Array<{ imageSource?: string; caption: string; replyMarkup?: any }> = [];

function normalizeAdminChatIds(ids: unknown): string[] {
  return normalizeTelegramAdminChatIds(ids, DEFAULT_ADMIN_CHAT_ID);
}

// Load admin IDs from DB and merge with env var
async function loadAdminChatIdsFromDb(): Promise<string[]> {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: 'telegram_admin_chat_ids' } });
    if (setting) {
      const parsed = JSON.parse(setting.value);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return normalizeAdminChatIds(parsed);
      }
    }
  } catch {
    // DB not ready yet, use env var only
  }
  return normalizeAdminChatIds([]);
}

export function getAdminChatIds(): string[] {
  return adminChatIds;
}

// Refresh from DB (called before every notification)
async function refreshAdminIds() {
  adminChatIds = await loadAdminChatIdsFromDb();
}

// Flush pending deposit notifications to registered admins
async function flushPendingNotifications() {
  if (pendingNotificationsQueue.length === 0) return;

  const queue = [...pendingNotificationsQueue];
  pendingNotificationsQueue.length = 0;

  for (const item of queue) {
    await sendTelegramPhotoNotification(item);
  }
}

console.log(`[Telegram Bot] Active Admin Chat ID(s):`, adminChatIds);

// Long Polling Telegram Bot Updates
let lastUpdateId = 0;
let isPolling = false;

export function startTelegramBotPolling() {
  if (isPolling) return;
  isPolling = true;
  console.log('[Telegram Bot Listener] Started background Telegram updates polling...');
  pollUpdates();
}

async function pollUpdates() {
  while (isPolling) {
    try {
      const res = await axios.get(`${TELEGRAM_API_URL}/getUpdates`, {
        params: {
          offset: lastUpdateId + 1,
          timeout: 20
        },
        timeout: 25000
      });

      if (res.data?.ok && Array.isArray(res.data.result)) {
        for (const update of res.data.result) {
          lastUpdateId = update.update_id;
          await handleIncomingTelegramUpdate(update);
        }
      }
    } catch (err: any) {
      if (err?.response?.status === 409) {
        await new Promise((r) => setTimeout(r, 10000));
      } else {
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }
}

// Answer Telegram Callback Query (for button feedback)
async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
  try {
    await axios.post(`${TELEGRAM_API_URL}/answerCallbackQuery`, {
      callback_query_id: callbackQueryId,
      text: text || '',
      show_alert: showAlert
    });
  } catch (err: any) {
    console.warn('[Telegram Callback Answer Error]:', err?.message);
  }
}

// Handle Incoming Telegram Commands, Text, & Interactive Button Clicks
async function handleIncomingTelegramUpdate(update: any) {
  // Determine the chat ID for all incoming updates
  const incomingChatId: string = (
    update?.callback_query?.message?.chat?.id ||
    update?.message?.chat?.id ||
    update?.channel_post?.chat?.id ||
    update?.edited_message?.chat?.id ||
    ''
  ).toString();

  if (!incomingChatId) return;

  // Security: Only process commands from authorized admins
  const currentAdminIds = getAdminChatIds();
  let isAuthorized = currentAdminIds.includes(incomingChatId);

  // -------------------------------------------------------------
  // A. Handle Interactive Inline Button Clicks (callback_query)
  // -------------------------------------------------------------
  if (update?.callback_query) {
    const cb = update.callback_query;
    const cbId = cb.id;
    const chatId = incomingChatId || DEFAULT_ADMIN_CHAT_ID;
    const data: string = cb.data || '';

    // Block unauthorized callback executions
    if (!isAuthorized) {
      await answerCallbackQuery(cbId, 'غير مصرح', true);
      console.warn(`[Telegram Bot] Unauthorized callback from chat ID: ${chatId} — blocked.`);
      return;
    }

    try {
      // 0. Admin Management Commands
      if (data === 'admin_count') {
        const admins = getAdminChatIds();
        const otherAdminsCount = admins.filter(id => id !== chatId && id !== DEFAULT_ADMIN_CHAT_ID).length;
        
        let msg = `👥 <b>إحصائيات المشرفين المسجلين</b>\n\n`;
        msg += `العدد الإجمالي: <b>${admins.length}</b>\n`;
        msg += `<i>(هذا العدد يشمل حسابك الحالي وحساب النظام الافتراضي)</i>\n\n`;
        
        if (otherAdminsCount > 0) {
          msg += `⚠️ <b>تنبيه:</b> يوجد <b>${otherAdminsCount}</b> مشرف/مشرفين آخرين غيرك مسجلين في البوت!`;
        } else {
          msg += `✅ <b>الوضع آمن:</b> أنت المشرف الوحيد المسجل حالياً (بالإضافة للنظام).`;
        }

        await answerCallbackQuery(cbId, `تم جلب الإحصائيات!`, false);
        await sendTelegramMessage(chatId, msg);
        return;
      }

      if (data === 'admin_kick_all') {
        // Keep only the current admin and the default admin
        const currentAdmins = getAdminChatIds();
        for (const id of currentAdmins) {
          if (id !== chatId && id !== DEFAULT_ADMIN_CHAT_ID) {
            removeAdminChatId(id);
          }
        }
        await answerCallbackQuery(cbId, '🗑️ تم طرد جميع المشرفين الآخرين بنجاح!', true);
        await sendTelegramMessage(chatId, '✅ <b>تم طرد جميع المشرفين الآخرين.</b>\nأنت المشرف الوحيد المسجل الآن (بالإضافة للمشرف الافتراضي).');
        return;
      }

      if (data === 'admin_logout') {
        removeAdminChatId(chatId);
        await answerCallbackQuery(cbId, '🚪 تم تسجيل الخروج بنجاح!', true);
        await sendTelegramMessage(chatId, '🚪 <b>تم إلغاء ربط حسابك.</b>\nلم تعد تستلم إشعارات ولن تتمكن من التحكم بالبوت.');
        return;
      }

      // 1. Send Order to Dhru Provider API: send_dhru_{orderId}
      if (data.startsWith('send_dhru_')) {
        const orderId = data.replace('send_dhru_', '').trim();
        await answerCallbackQuery(cbId, '⏳ جاري إرسال الطلب للمزود (Dhru)...', false);

        const order = await prisma.order.findUnique({
          where: { id: orderId },
          include: { user: true }
        });

        if (!order) {
          await sendTelegramMessage(chatId, `❌ <b>الطلب #${orderId.slice(-6)} غير موجود في قاعدة البيانات!</b>`);
          return;
        }

        if (order.apiOrderId) {
          await sendTelegramMessage(chatId, `⚠️ <b>تم إرسال هذا الطلب للمزود مسبقاً!</b> (Dhru ID: <code>${order.apiOrderId}</code>)`);
          return;
        }

        const dhruService = await prisma.dhruService.findFirst({
          where: { id: order.serviceId },
          include: { dhruCategory: true }
        });

        if (!dhruService || !dhruService.dhruId) {
          await sendTelegramMessage(chatId, `❌ <b>تعذر العثور على معرّف الخدمة (Dhru ID) للخدمة "${order.serviceName}"!</b>`);
          return;
        }

        let dhruResponse: any = null;
        if (resolveOrderServiceType(
          dhruService.apiServiceType,
          dhruService.dhruCategory?.name,
          dhruService.groupName
        ) === 'imei') {
          dhruResponse = await placeImeiOrder(dhruService.dhruId, order.targetInput, {});
        } else {
          dhruResponse = await placeServerOrder(dhruService.dhruId, order.quantity, {}, order.targetInput);
        }

        if (!dhruResponse || dhruResponse.SUCCESS === false || dhruResponse.ERROR || dhruResponse.Error) {
          const rawErrMsg = dhruResponse?.Error || dhruResponse?.ERROR?.[0]?.MESSAGE || dhruResponse?.ERROR?.[0]?.FULL_DESCRIPTION || 'خطأ غير معروف من المزود';
          const isCredit = JSON.stringify(dhruResponse || {}).toLowerCase().includes('credit');
          const finalErrMsg = isCredit
            ? '⚠️ رصيد حسابك لدى المزود الخارجي غير كافٍ. يرجى شحن حسابك لدى المزود أولاً ثم إعادة المحاولة.'
            : rawErrMsg;
          await sendTelegramMessage(chatId, `❌ <b>فشل إرسال الطلب للمزود:</b>\n<code>${finalErrMsg}</code>`);
          return;
        }

        const refId = String(dhruResponse?.SUCCESS?.[0]?.REFERENCEID || dhruResponse?.REFERENCEID || 'SENT');

        await prisma.order.update({
          where: { id: orderId },
          data: {
            apiOrderId: refId,
            status: 'processing'
          }
        });

        await sendTelegramMessage(
          chatId,
          `🚀 <b>تم إرسال الطلب للمزود بنجاح عبر التلجرام!</b>\n\n🔢 <b>رقم الطلب:</b> #${order.id.slice(-6)}\n📱 <b>الخدمة:</b> ${order.serviceName}\n🔢 <b>Dhru Ref ID:</b> <code>${refId}</code>\n👤 <b>العميل:</b> ${order.user?.fullName} (<code>${order.user?.email}</code>)\n🟢 <b>الحالة:</b> جاري التنفيذ لدى المزود ⏳`
        );

        if (order.user?.email) {
          sendOrderConfirmationEmail(order.user.email, {
            orderId: order.id.slice(-6),
            serviceName: order.serviceName,
            targetInput: order.targetInput,
            price: order.price,
            remainingBalance: order.user.balance,
            username: order.user.fullName
          }).catch(() => {});
        }
        return;
      }

      // 2. Approve Deposit: approve_tx_{txId}
      if (data.startsWith('approve_tx_')) {
        const txId = data.replace('approve_tx_', '').trim();
        await answerCallbackQuery(cbId, '⏳ جاري اعتماد الإيداع وإضافة الرصيد...', false);

        const tx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (!tx) {
          await sendTelegramMessage(chatId, `❌ <b>عملية الإيداع غير موجودة!</b>`);
          return;
        }

        // Atomic Status Update & Balance Increment
        let updatedUser: any;
        let uTx: any;
        
        try {
          [uTx, updatedUser] = await prisma.$transaction(async (t) => {
            const updatedTxResult = await t.transaction.updateMany({
              where: { id: txId, status: { not: 'completed' } },
              data: { status: 'completed' }
            });

            if (updatedTxResult.count === 0) {
              throw new Error('ALREADY_PROCESSED');
            }

            const userRes = await t.user.update({
              where: { id: tx.userId },
              data: { balance: { increment: tx.amount } }
            });
            
            return [tx, userRes];
          });
        } catch (txError: any) {
          if (txError.message === 'ALREADY_PROCESSED') {
            await sendTelegramMessage(chatId, `⚠️ <b>تم اعتماد أو معالجة هذه العملية مسبقاً!</b>`);
            return;
          }
          throw txError;
        }

        const upgradedUser = await checkAndAutoUpgradeMembership(tx.userId, tx.amount);

        const tierInfo = upgradedUser?.membershipTier
          ? `🎖️ <b>العضوية الحالية:</b> ${upgradedUser.membershipTier.nameAr || upgradedUser.membershipTier.name} (-${upgradedUser.membershipTier.discountPercentage}% خصم)`
          : '';

        await sendTelegramMessage(
          chatId,
          `✅ <b>تمت الموافقة وشحن الرصيد بنجاح عبر التلجرام!</b>\n\n👤 <b>العميل:</b> ${updatedUser.fullName} (<code>${updatedUser.email}</code>)\n💰 <b>المبلغ المضاف:</b> <code>+$${tx.amount.toFixed(2)} USD</code>\n🏦 <b>رصيد الحساب الجديد:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>\n${tierInfo}`
        );

        if (updatedUser.email) {
          sendDepositApprovalEmail(updatedUser.email, {
            amount: tx.amount,
            newBalance: updatedUser.balance,
            username: updatedUser.fullName,
            tierName: upgradedUser?.membershipTier ? (upgradedUser.membershipTier.nameAr || upgradedUser.membershipTier.name) : undefined
          }).catch(() => {});
        }
        return;
      }

      // 3. Reject Deposit: reject_tx_{txId}
      if (data.startsWith('reject_tx_')) {
        const txId = data.replace('reject_tx_', '').trim();
        await answerCallbackQuery(cbId, 'تم رفض الإيداع', false);

        const updatedTxResult = await prisma.transaction.updateMany({
          where: { id: txId, status: { notIn: ['failed', 'completed'] } },
          data: { status: 'failed' }
        });

        if (updatedTxResult.count === 0) {
           await sendTelegramMessage(chatId, `⚠️ <b>هذه العملية تمت معالجتها مسبقاً!</b>`);
           return;
        }

        await sendTelegramMessage(chatId, `❌ <b>تم رفض طلب الإيداع رقم #${txId.slice(-6)} بنجاح.</b>`);
        return;
      }

      // 4. Complete Order: complete_order_{orderId}
      if (data.startsWith('complete_order_')) {
        const orderId = data.replace('complete_order_', '').trim();
        await answerCallbackQuery(cbId, 'تم إكمال الطلب', false);

        const updatedOrderResult = await prisma.order.updateMany({
          where: { id: orderId, status: { not: 'completed' } },
          data: { status: 'completed' }
        });

        if (updatedOrderResult.count === 0) {
          await sendTelegramMessage(chatId, `⚠️ <b>تم إكمال هذا الطلب مسبقاً!</b>`);
          return;
        }

        const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });

        await sendTelegramMessage(chatId, `✅ <b>تم إكمال الطلب #${orderId.slice(-6)} بنجاح!</b> (${updatedOrder?.serviceName || ''})`);
        return;
      }

      // 5. Cancel & Refund Order: cancel_refund_order_{orderId}
      if (data.startsWith('cancel_refund_order_')) {
        const orderId = data.replace('cancel_refund_order_', '').trim();
        await answerCallbackQuery(cbId, 'جاري الإلغاء واسترجاع الرصيد...', false);

        const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
        if (!order || !order.userId) {
          await sendTelegramMessage(chatId, `❌ <b>الطلب غير موجود أو غير مرتبط بحساب عميل!</b>`);
          return;
        }

        // Atomic Order Rejection & Refund
        let refundedUser: any;
        
        try {
          refundedUser = await prisma.$transaction(async (t) => {
            const updatedOrderResult = await t.order.updateMany({
              where: { id: orderId, status: { notIn: ['rejected', 'cancelled'] } },
              data: { status: 'rejected' }
            });

            if (updatedOrderResult.count === 0) {
              throw new Error('ALREADY_PROCESSED');
            }

            if (!order.userId) {
              throw new Error('NO_USER_ID');
            }

            const userRes = await t.user.update({
              where: { id: order.userId },
              data: { balance: { increment: order.price } }
            });

            await t.transaction.create({
              data: {
                userId: order.userId,
                type: `استرجاع رصيد طلب ملغي: #${order.id.slice(-6)}`,
                amount: order.price,
                method: 'استرجاع للمحفظة',
                refNo: `REFUND-#${order.id.slice(-6)}`,
                status: 'completed'
              }
            });
            
            return userRes;
          });
        } catch (txError: any) {
          if (txError.message === 'ALREADY_PROCESSED') {
            await sendTelegramMessage(chatId, `⚠️ <b>تم إلغاء هذا الطلب واسترجاع رصيده مسبقاً!</b>`);
            return;
          }
          throw txError;
        }

        await sendTelegramMessage(
          chatId,
          `🔄 <b>تم إلغاء الطلب واسترجاع الرصيد بنجاح!</b>\n\n🔢 <b>رقم الطلب:</b> #${order.id.slice(-6)}\n👤 <b>العميل:</b> ${refundedUser.fullName}\n💰 <b>المبلغ المسترجع:</b> <code>+$${order.price.toFixed(2)} USD</code>\n🏦 <b>رصيد العميل الحالي:</b> <code>$${refundedUser.balance.toFixed(2)} USD</code>`
        );
        return;
      }
    } catch (err: any) {
      console.error('[Telegram Callback Error]:', err);
      await sendTelegramMessage(chatId, `⚠️ <b>حدث خطأ أثناء معالجة الأمر:</b> ${err?.message}`);
      return;
    }
  }

  // -------------------------------------------------------------
  // B. Handle Text Messages & Admin Commands
  // -------------------------------------------------------------
  const message = update?.message || update?.channel_post || update?.edited_message;
  if (!message) return;

  const chatId = incomingChatId;
  if (!chatId) return;

  const text = (message.text || message.caption || '').trim();
  const lowerText = text.toLowerCase();

  // 1. Handle unauthorized users
  if (!isAuthorized) {
    // Only chat IDs listed in TELEGRAM_ADMIN_CHAT_ID env var can log in via password
    const allowedIds = DEFAULT_ADMIN_CHAT_ID.split(',').map(s => s.trim()).filter(Boolean);
    const isAllowedToLogin = allowedIds.includes(chatId);

    if (isAllowedToLogin) {
      const parts = text.split(/\s+/);
      if (parts.length === 2 && lowerText !== '/start' && lowerText !== '/admin') {
        const [identifier, password] = parts;
        try {
          const user = await prisma.user.findFirst({
            where: {
              OR: [{ email: identifier }, { username: identifier }],
              role: 'admin'
            }
          });
          if (user && await bcrypt.compare(password, user.password)) {
            adminChatIds = normalizeAdminChatIds(allowedIds);
            isAuthorized = true;
            await sendTelegramMessage(
              chatId,
              `✅ <b>تم تسجيل الدخول بنجاح!</b>\n\nأرسل /start لعرض خيارات التحكم.`
            );
            return;
          } else {
            await sendTelegramMessage(chatId, `❌ <b>بيانات الدخول خاطئة.</b>\nتأكد من اسم المستخدم وكلمة المرور.`);
            return;
          }
        } catch (err) {
          console.error('[Telegram Bot] DB auth error:', err);
          return;
        }
      }
      if (lowerText === '/start' || lowerText === '/admin') {
        await sendTelegramMessage(
          chatId,
          `🔐 <b>مرحباً!</b>\n\nأرسل <b>اسم المستخدم</b> و<b>كلمة المرور</b> في رسالة واحدة مفصولين بمسافة:\n\n<code>admin mypassword123</code>`
        );
      }
    } else {
      if (lowerText === '/start' || lowerText === '/admin') {
        console.warn(`[Telegram Bot] Unauthorized /start from chat ID: ${chatId}`);
      }
    }
    return;
  }


  // 2. /start or /admin
  if (lowerText === '/start' || lowerText === '/admin') {
    if (isAuthorized) {
      await sendTelegramMessage(
        chatId,
        `🟢 <b>أهلاً بك في بوت الإدارة التفاعلي!</b>\n\nحسابك مسجل كـ <b>أدمن معتمد</b> (Chat ID: <code>${chatId}</code>) وتصلك جميع الإشعارات مع أزرار التحكم الفورية.`,
        {
          inline_keyboard: [
            [{ text: "👥 عدد المشرفين المسجلين", callback_data: "admin_count" }],
            [{ text: "🗑️ طرد جميع المشرفين", callback_data: "admin_kick_all" }],
            [{ text: "🚪 تسجيل الخروج (إلغاء الربط)", callback_data: "admin_logout" }]
          ]
        }
      );
    } else {
      await sendTelegramMessage(
        chatId,
        `🔒 <b>غير مصرح!</b>\n\nأنت غير مسجل كمسؤول. يرجى إرسال <b>اسم المستخدم</b> و <b>كلمة المرور</b> الخاصة بلوحة التحكم (مفصولين بمسافة) لتفعيل حسابك.`
      );
      console.warn(`[Telegram Bot] Unauthorized /start from chat ID: ${chatId}`);
    }
    return;
  }

  // 3. Status check
  if (isAuthorized && lowerText === '/status') {
    await sendTelegramMessage(
      chatId,
      `🟢 <b>حسابك مسجل كـ أدمن معتمد (Chat ID: <code>${chatId}</code>) وتصلك الإشعارات والأزرار التفاعلية فورياً.</b>`
    );
    return;
  }

  // 4. Logout / Unlink
  if (isAuthorized && (lowerText === '/logout' || lowerText === '/unlink' || lowerText === 'الغاء ربط الحساب' || lowerText === 'الغاء الربط' || lowerText === 'تسجيل خروج')) {
    removeAdminChatId(chatId);
    await sendTelegramMessage(
      chatId,
      `🚪 <b>تم تسجيل الخروج وإلغاء الربط بنجاح!</b>\nلن تصلك إشعارات بعد الآن. أرسل /start لتسجيل الدخول مجدداً.`
    );
    return;
  }
}

export function removeAdminChatId(chatId: string) {
  if (chatId === DEFAULT_ADMIN_CHAT_ID) return;
  adminChatIds = adminChatIds.filter(id => id !== chatId);
  if (adminChatIds.length === 0) {
    adminChatIds = [DEFAULT_ADMIN_CHAT_ID];
  }
  console.log(`[Telegram Bot] Removed Admin Chat ID from session: ${chatId}`);
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>?/gm, '');
}

// Send Text Message to Telegram
export async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: any) {
  try {
    const res = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: replyMarkup
    });
    console.log(`[Telegram Service] Message sent to Chat ID: ${chatId}`);
    return res.data;
  } catch (error: any) {
    const errorDesc = error?.response?.data?.description || error?.message;
    console.warn(`[Telegram Service Error] Failed HTML send to ${chatId} (${errorDesc}), retrying plain text...`);
    // Retry without parse_mode
    try {
      const res2 = await axios.post(`${TELEGRAM_API_URL}/sendMessage`, {
        chat_id: chatId,
        text: stripHtml(text),
        reply_markup: replyMarkup
      });
      return res2.data;
    } catch (err2: any) {
      console.error(`[Telegram Plain Text Fallback Error for ${chatId}]:`, err2?.response?.data?.description || err2?.message);
    }
  }
}

// Broadcast Alert to all Admin Chat IDs
export async function sendTelegramAlert(text: string) {
  try {
    await refreshAdminIds();
    const chatIds = getAdminChatIds();
    for (const id of chatIds) {
      await sendTelegramMessage(id, text);
    }
  } catch (err: any) {
    console.error('[Telegram sendTelegramAlert Error]:', err?.message);
  }
}

// Helper to convert any image representation to a Buffer
async function resolveImageBuffer(imageSource?: string | null): Promise<{ buffer: Buffer; filename: string; mimeType: string } | null> {
  if (!imageSource || typeof imageSource !== 'string') return null;

  try {
    // 1. Data URL (Base64)
    if (imageSource.startsWith('data:image/')) {
      const match = imageSource.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s);
      if (match) {
        const mimeType = match[1];
        const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
        return {
          buffer: Buffer.from(match[2], 'base64'),
          filename: `receipt.${ext}`,
          mimeType
        };
      }
      const raw = imageSource.split(';base64,').pop();
      if (raw) {
        return {
          buffer: Buffer.from(raw, 'base64'),
          filename: 'receipt.jpg',
          mimeType: 'image/jpeg'
        };
      }
    }

    // 2. HTTP/HTTPS URL (SSRF Mitigated)
    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
      const urlObj = new URL(imageSource);
      const isPrivate = (
        urlObj.hostname === 'localhost' ||
        urlObj.hostname === '127.0.0.1' ||
        urlObj.hostname === '::1' ||
        urlObj.hostname === '0.0.0.0' ||
        urlObj.hostname.startsWith('10.') ||
        urlObj.hostname.startsWith('192.168.') ||
        /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(urlObj.hostname) ||
        urlObj.hostname.startsWith('169.254.') ||
        urlObj.hostname.endsWith('.internal') ||
        urlObj.hostname.endsWith('.local')
      );
      if (isPrivate) {
        throw new Error('SSRF Attempt Detected: Blocked private network address');
      }

      const res = await axios.get(imageSource, { responseType: 'arraybuffer', timeout: 15000 });
      const rawType = res.headers['content-type'];
      const contentType = typeof rawType === 'string' ? rawType : 'image/jpeg';
      const ext = contentType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
      return {
        buffer: Buffer.from(res.data),
        filename: `receipt.${ext}`,
        mimeType: contentType
      };
    }

    // 3. Direct local file path or persistent uploads volume (LFI Mitigated)
    if (imageSource.includes('../') || imageSource.includes('..\\')) {
      throw new Error('Path Traversal Attempt Detected');
    }

    const allowedRoots = [
      path.resolve(process.cwd(), 'backend', 'public'),
      path.resolve(process.cwd(), 'public'),
      path.resolve(__dirname, '../../public'),
      path.resolve(__dirname, '../../../public')
    ];
    
    try {
      allowedRoots.push(path.resolve(getUploadDir()));
    } catch {}

    const rawCheckPaths = [
      imageSource,
      path.join(process.cwd(), imageSource),
      path.join(process.cwd(), 'backend', imageSource),
      path.join(__dirname, '../../public', imageSource),
      path.join(__dirname, '../../../public', imageSource)
    ];

    try {
      if (imageSource.startsWith('/uploads/')) {
        rawCheckPaths.push(path.join(getUploadDir(), imageSource.replace('/uploads/', '')));
      } else {
        rawCheckPaths.push(path.join(getUploadDir(), imageSource));
      }
    } catch {}

    const checkPaths = rawCheckPaths.map(p => path.resolve(p)).filter(p => allowedRoots.some(root => p.startsWith(root)));

    for (const p of checkPaths) {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        const buffer = fs.readFileSync(p);
        const ext = path.extname(p).slice(1) || 'jpg';
        return {
          buffer,
          filename: `receipt.${ext}`,
          mimeType: ext === 'png' ? 'image/png' : 'image/jpeg'
        };
      }
    }

    // 4. Raw Base64 string without data prefix
    if (/^[A-Za-z0-9+/=\s]+$/.test(imageSource.slice(0, 100)) && imageSource.length > 100) {
      return {
        buffer: Buffer.from(imageSource.trim(), 'base64'),
        filename: 'receipt.jpg',
        mimeType: 'image/jpeg'
      };
    }
  } catch (err: any) {
    console.warn('[Telegram Buffer Resolve Error]:', err?.message);
  }

  return null;
}

// Send Photo directly to Telegram with triple fallback guarantee
export async function sendTelegramPhotoNotification({
  imageSource,
  caption,
  replyMarkup
}: {
  imageSource?: string | null;
  caption: string;
  replyMarkup?: any;
}) {
  try {
    await refreshAdminIds();
    const targetChatIds = getAdminChatIds();
    if (targetChatIds.length === 0) {
      throw new Error('No Telegram admin chat IDs are configured');
    }

    const imageInfo = await resolveImageBuffer(imageSource);
    const trimmedCaption = caption.length > 1000 ? caption.slice(0, 995) + '...' : caption;

    for (const chatId of targetChatIds) {
      let delivered = false;

      // 1. Try sendPhoto or sendDocument if image buffer is available
      if (imageInfo) {
        const isLargeFile = imageInfo.buffer.length > 9.5 * 1024 * 1024;

        if (!isLargeFile) {
          try {
            const form = new FormData();
            form.append('chat_id', chatId);
            form.append('caption', trimmedCaption);
            form.append('parse_mode', 'HTML');
            if (replyMarkup) {
              form.append('reply_markup', JSON.stringify(replyMarkup));
            }
            form.append('photo', imageInfo.buffer, { filename: imageInfo.filename, contentType: imageInfo.mimeType });

            await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, form, {
              headers: form.getHeaders(),
              timeout: 60000
            });
            console.log(`🚀 [Telegram Bot] Receipt photo sent successfully to Admin Chat ID: ${chatId}`);
            delivered = true;
          } catch (photoErr: any) {
            const photoDesc = photoErr?.response?.data?.description || photoErr?.message;
            console.warn(`[Telegram sendPhoto HTML failed for ${chatId}, trying plain text caption]:`, photoDesc);

            // Retry sendPhoto with plain text caption
            try {
              const form2 = new FormData();
              form2.append('chat_id', chatId);
              form2.append('caption', stripHtml(trimmedCaption));
              if (replyMarkup) {
                form2.append('reply_markup', JSON.stringify(replyMarkup));
              }
              form2.append('photo', imageInfo.buffer, { filename: imageInfo.filename, contentType: imageInfo.mimeType });

              await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, form2, {
                headers: form2.getHeaders(),
                timeout: 60000
              });
              console.log(`🚀 [Telegram Bot] Receipt photo (plain) sent successfully to Admin Chat ID: ${chatId}`);
              delivered = true;
            } catch (photoErr2: any) {}
          }
        }

        // 2. If not delivered yet (or if file is large > 9.5MB), send as Document
        if (!delivered) {
          try {
            const docForm = new FormData();
            docForm.append('chat_id', chatId);
            docForm.append('caption', stripHtml(trimmedCaption));
            if (replyMarkup) {
              docForm.append('reply_markup', JSON.stringify(replyMarkup));
            }
            docForm.append('document', imageInfo.buffer, { filename: imageInfo.filename, contentType: imageInfo.mimeType });

            await axios.post(`${TELEGRAM_API_URL}/sendDocument`, docForm, {
              headers: docForm.getHeaders(),
              timeout: 60000
            });
            console.log(`🚀 [Telegram Bot] Receipt document sent successfully to Admin Chat ID: ${chatId}`);
            delivered = true;
          } catch (docErr: any) {
            console.warn(`[Telegram sendDocument failed for ${chatId}]:`, docErr?.response?.data?.description || docErr?.message);
          }
        }
      }

      // 3. Fallback to sendMessage (text-only) if photo wasn't delivered or no image attached
      if (!delivered) {
        await sendTelegramMessage(
          chatId,
          caption + (imageInfo ? '\n\n<i>(مرفق مع الطلب صورة إيصال التحويل)</i>' : ''),
          replyMarkup
        );
      }
    }
  } catch (error: any) {
    console.error('[Telegram Photo Delivery Error]:', error?.message);
  }
}

// Send Document (e.g., Backup ZIP) to Telegram Admins
export async function sendDocumentToAdmins(filePath: string, caption: string) {
  try {
    await refreshAdminIds();
    const targetChatIds = getAdminChatIds();

    for (const chatId of targetChatIds) {
      try {
        if (fs.existsSync(filePath)) {
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('caption', caption.slice(0, 1000));
          form.append('parse_mode', 'HTML');
          form.append('document', fs.createReadStream(filePath));

          await axios.post(`${TELEGRAM_API_URL}/sendDocument`, form, {
            headers: form.getHeaders(),
            timeout: 60000
          });
          console.log(`🚀 [Telegram Bot] Document sent successfully to Admin Chat ID: ${chatId}`);
        } else {
          console.error(`[Telegram Bot] Document not found at path: ${filePath}`);
        }
      } catch (error: any) {
        const errorMsg = error?.response?.data?.description || error?.message;
        console.error(`[Telegram Document Delivery Error for ${chatId}]:`, errorMsg);
        await sendTelegramMessage(chatId, caption + `\n\n<i>⚠️ تعذر إرسال الملف إليك بسبب مشكلة في الرفع. (${errorMsg})</i>`);
      }
    }
  } catch (error: any) {
    console.error('[Telegram Document Delivery Fatal Error]:', error?.message);
  }
}

// Start listener automatically
startTelegramBotPolling();
