import axios from 'axios';
import https from 'https';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { prisma } from "../utils/prisma";
import { sendDepositApprovalEmail, sendOrderConfirmationEmail } from './emailService';
import { checkAndAutoUpgradeMembership } from './membershipUpgrade';
import { normalizeTelegramAdminChatIds, sanitizeTelegramReplyMarkup } from './telegram-config';
import { roundCurrency } from './currency';
import { getUploadDir } from './uploads';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const DEFAULT_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

// Telegram API stalls intermittently over IPv6 in Docker; pin IPv4 keep-alive connections
// while calling axios directly so tests and HTTP interceptors observe every request.
const telegramHttpsAgent = new https.Agent({ keepAlive: true, family: 4, maxSockets: 10 });

function getTelegramApiUrl(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  return `https://api.telegram.org/bot${token}`;
}

export function isMarkupRejectedError(err: any): boolean {
  const desc = String(err?.response?.data?.description || err?.message || '');
  return /inline keyboard|reply_markup|button_url_invalid|wrong port number|url host is empty|unsupported url protocol/i.test(desc);
}

export function computePollingBackoffMs(consecutiveFailures: number, status?: number, retryAfterSec?: number): number {
  const attempt = Math.max(1, consecutiveFailures);
  if (status === 429) {
    const seconds = Number.isFinite(Number(retryAfterSec)) ? Math.max(5, Number(retryAfterSec)) : 15;
    return Math.min(120000, seconds * 1000);
  }
  if (status === 409) {
    return Math.min(60000, 10000 + (attempt - 1) * 5000);
  }
  return Math.min(60000, 5000 * 2 ** Math.min(attempt - 1, 4));
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

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

// Refresh from DB
export async function refreshAdminIds(): Promise<string[]> {
  adminChatIds = await loadAdminChatIdsFromDb();
  return adminChatIds;
}

// Persist admin IDs to database and update memory cache
export async function saveAdminChatIdsToDb(ids: string[]): Promise<string[]> {
  const normalized = normalizeAdminChatIds(ids);
  await prisma.setting.upsert({
    where: { key: 'telegram_admin_chat_ids' },
    update: { value: JSON.stringify(normalized) },
    create: { key: 'telegram_admin_chat_ids', value: JSON.stringify(normalized) }
  });
  adminChatIds = normalized;
  return adminChatIds;
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

// Long Polling Telegram Bot Updates
let lastUpdateId = 0;
let isPolling = false;
let pollingStopRequested = false;
let pollingAbortController: AbortController | null = null;
let pollingRetryTimer: NodeJS.Timeout | null = null;

function clearPollingRetryTimer() {
  if (pollingRetryTimer) {
    clearTimeout(pollingRetryTimer);
    pollingRetryTimer = null;
  }
}

export async function startTelegramBotPolling() {
  if (!process.env.TELEGRAM_BOT_TOKEN) return;
  const mode = (process.env.TELEGRAM_UPDATES_MODE || 'polling').trim().toLowerCase();
  if (mode === 'webhook' || mode === 'disabled') return;
  if (isPolling) return;

  pollingStopRequested = false;
  clearPollingRetryTimer();
  isPolling = true;
  pollingAbortController = new AbortController();

  let startupFailures = 0;
  while (isPolling && !pollingStopRequested) {
    const apiUrl = getTelegramApiUrl();
    try {
      // Transfer to polling without dropping pending updates.
      const webhook = await axios.get(`${apiUrl}/getWebhookInfo`, {
        httpsAgent: telegramHttpsAgent,
        timeout: 10000,
        signal: pollingAbortController.signal
      });
      if (!webhook.data?.ok) throw new Error('Unable to inspect Telegram webhook');
      if (webhook.data.result?.url) {
        const deleted = await axios.post(
          `${apiUrl}/deleteWebhook`,
          { drop_pending_updates: false },
          { httpsAgent: telegramHttpsAgent, timeout: 10000, signal: pollingAbortController.signal }
        );
        if (!deleted.data?.ok) throw new Error('Unable to remove Telegram webhook');
      }
      await refreshAdminIds();
      break;
    } catch (err: any) {
      if (pollingStopRequested) {
        isPolling = false;
        return;
      }
      const status = Number(err?.response?.status) || 0;
      if (status === 401 || status === 404) {
        isPolling = false;
        console.warn('[Telegram Bot] Polling stopped: bot token was rejected by Telegram API.');
        return;
      }
      startupFailures++;
      const retryAfter = err?.response?.data?.parameters?.retry_after;
      const waitMs = computePollingBackoffMs(startupFailures, status, retryAfter);
      console.warn(`[Telegram Bot] Polling startup attempt #${startupFailures} failed (${err?.message || status || 'network error'}), retrying in ${Math.round(waitMs / 1000)}s...`);
      await sleepWithAbort(waitMs, pollingAbortController.signal);
    }
  }

  if (!isPolling || pollingStopRequested) {
    isPolling = false;
    return;
  }

  console.log('[Telegram Bot Listener] Started background Telegram updates polling...');
  console.log('[Telegram Bot] Active Admin Chat ID(s):', adminChatIds);
  void pollUpdates();
}

async function pollUpdates() {
  let consecutiveFailures = 0;

  while (isPolling && !pollingStopRequested) {
    const apiUrl = getTelegramApiUrl();
    try {
      const controller = pollingAbortController || new AbortController();
      const res = await axios.get(`${apiUrl}/getUpdates`, {
        params: {
          offset: lastUpdateId + 1,
          timeout: 20
        },
        httpsAgent: telegramHttpsAgent,
        timeout: 30000,
        signal: controller.signal
      });

      consecutiveFailures = 0;

      if (res.data?.ok && Array.isArray(res.data.result)) {
        for (const update of res.data.result) {
          if (typeof update?.update_id === 'number') {
            // Advance offset before handling so a bad or crashing update never traps polling in a replay loop.
            lastUpdateId = Math.max(lastUpdateId, update.update_id);
          }
          try {
            await handleIncomingTelegramUpdate(update);
          } catch (updateErr: any) {
            console.error(`[Telegram Bot] Failed to process update #${update?.update_id}:`, updateErr?.message || updateErr);
          }
        }
      }
    } catch (err: any) {
      if (pollingStopRequested) break;
      const status = Number(err?.response?.status) || 0;
      if ([401, 404].includes(status)) {
        isPolling = false;
        console.warn('[Telegram Bot] Polling stopped: bot credentials were rejected.');
        break;
      }
      consecutiveFailures++;
      const retryAfter = err?.response?.data?.parameters?.retry_after;
      const waitMs = computePollingBackoffMs(consecutiveFailures, status, retryAfter);
      if (status === 409) {
        const description = String(err?.response?.data?.description || '').toLowerCase();
        if (description.includes('webhook')) {
          console.warn(`[Telegram Bot] Competing webhook detected while in polling mode; removing webhook and retrying in ${Math.round(waitMs / 1000)}s...`);
          await axios.post(
            `${apiUrl}/deleteWebhook`,
            { drop_pending_updates: false },
            { httpsAgent: telegramHttpsAgent, timeout: 10000 }
          ).catch(() => {});
        } else {
          console.warn(`[Telegram Bot] 409 Conflict on getUpdates (previous instance still closing); retrying in ${Math.round(waitMs / 1000)}s...`);
        }
      } else {
        console.warn(`[Telegram Bot] Polling error (${err?.message || status || 'unknown'}), retrying in ${Math.round(waitMs / 1000)}s...`);
      }
      await sleepWithAbort(waitMs, pollingAbortController?.signal);
    }
  }
  isPolling = false;
}

export function stopTelegramBotPolling() {
  pollingStopRequested = true;
  isPolling = false;
  clearPollingRetryTimer();
  if (pollingAbortController) {
    pollingAbortController.abort();
    pollingAbortController = null;
  }
}

// Answer Telegram Callback Query (for button feedback)
async function answerCallbackQuery(callbackQueryId: string, text?: string, showAlert = false) {
  try {
    await axios.post(
      `${getTelegramApiUrl()}/answerCallbackQuery`,
      {
        callback_query_id: callbackQueryId,
        text: text || '',
        show_alert: showAlert
      },
      { httpsAgent: telegramHttpsAgent, timeout: 10000 }
    );
  } catch (err: any) {
    console.warn('[Telegram Callback Answer Error]:', err?.message);
  }
}

// Handle Incoming Telegram Commands, Text, & Interactive Button Clicks
async function handleIncomingTelegramUpdate(update: any) {
  const incomingChatId: string = (
    update?.callback_query?.message?.chat?.id ||
    update?.message?.chat?.id ||
    update?.channel_post?.chat?.id ||
    update?.edited_message?.chat?.id ||
    ''
  ).toString().trim();

  const incomingSenderId: string = (
    update?.callback_query?.from?.id ||
    update?.message?.from?.id ||
    update?.edited_message?.from?.id ||
    incomingChatId
  ).toString().trim();

  if (!incomingChatId) return;

  // Refresh admin IDs from DB on every update so dashboard changes apply immediately
  await refreshAdminIds();
  const currentAdminIds = getAdminChatIds();
  // Authorization requires the individual sender to be an explicitly approved admin (prevents group member bypass)
  const isAuthorized = currentAdminIds.includes(incomingSenderId);

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
      console.warn(`[Telegram Bot] Unauthorized callback from chat ID: ${chatId} - blocked.`);
      return;
    }

    try {
      // 0. Admin Management Commands
      if (data === 'admin_count') {
        await refreshAdminIds();
        const admins = getAdminChatIds();
        const otherAdminsCount = admins.filter(id => id !== chatId && id !== DEFAULT_ADMIN_CHAT_ID).length;
        
        let msg = `<b>احصائيات المشرفين المسجلين</b>\n\n`;
        msg += `العدد الاجمالي: <b>${admins.length}</b>\n`;
        msg += `المعرفات المسجلة:\n${admins.map(id => `- <code>${id}</code>`).join('\n')}\n\n`;
        
        if (otherAdminsCount > 0) {
          msg += `تنبيه: يوجد <b>${otherAdminsCount}</b> مشرف اخر مسجل في البوت.`;
        } else {
          msg += `انت المشرف الوحيد المسجل حاليا.`;
        }

        await answerCallbackQuery(cbId, 'تم جلب الاحصائيات', false);
        await sendTelegramMessage(chatId, msg);
        return;
      }

      if (data === 'admin_logout') {
        await removeAdminChatId(chatId);
        await answerCallbackQuery(cbId, 'تم تسجيل الخروج بنجاح', true);
        await sendTelegramMessage(chatId, '<b>تم الغاء ربط حسابك.</b>\nلن تصلك اشعارات بعد الان.');
        return;
      }

      // 1. Send Order to Dhru Provider API: send_dhru_{orderId}
      if (data.startsWith('send_dhru_')) {
        const orderId = data.replace('send_dhru_', '').trim();
        await answerCallbackQuery(cbId, 'جاري ارسال الطلب للمزود...', false);

        const { dispatchOrderToProvider } = await import('../services/orderDispatchService');
        const dispatchResult = await dispatchOrderToProvider(orderId, { isAuto: false, requestedBy: 'telegram' });

        if (!dispatchResult.success) {
          const errText = dispatchResult.userFacingMsg || dispatchResult.error || 'تعذر إرسال الطلب للمزود';
          await sendTelegramMessage(chatId, `[ERROR] <b>تعذر تنفيذ الإرسال:</b>\n<code>${escapeHtml(errText)}</code>`);
          return;
        }

        const dispatchedOrder = await prisma.order.findUnique({
          where: { id: orderId },
          include: { user: true }
        });
        const refId = dispatchResult.apiOrderId || 'SENT';

        await sendTelegramMessage(
          chatId,
          `<b>تم إرسال الطلب للمزود بنجاح عبر التلجرام!</b>\n\n<b>رقم الطلب:</b> #${orderId.slice(-6)}\n<b>الخدمة:</b> ${escapeHtml(dispatchedOrder?.serviceName || '')}\n<b>Dhru Ref ID:</b> <code>${escapeHtml(refId)}</code>\n<b>العميل:</b> ${escapeHtml(dispatchedOrder?.user?.fullName || 'Client')} (<code>${escapeHtml(dispatchedOrder?.user?.email || '')}</code>)\n<b>الحالة:</b> جاري التنفيذ لدى المزود`
        );

        if (dispatchedOrder?.user?.email) {
          sendOrderConfirmationEmail(dispatchedOrder.user.email, {
            orderId: dispatchedOrder.id.slice(-6),
            serviceName: dispatchedOrder.serviceName,
            targetInput: dispatchedOrder.targetInput,
            price: dispatchedOrder.price,
            remainingBalance: dispatchedOrder.user.balance,
            username: dispatchedOrder.user.fullName
          }).catch(() => {});
        }
        return;
      }

      // 2. Approve Deposit: approve_tx_{txId}
      if (data.startsWith('approve_tx_')) {
        const txId = data.replace('approve_tx_', '').trim();
        await answerCallbackQuery(cbId, 'جاري اعتماد الإيداع وإضافة الرصيد...', false);

        const tx = await prisma.transaction.findUnique({ where: { id: txId } });
        if (!tx) {
          await sendTelegramMessage(chatId, `[ERROR] <b>عملية الإيداع غير موجودة!</b>`);
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

            const incremented = await t.user.update({
              where: { id: tx.userId },
              data: { balance: { increment: roundCurrency(tx.amount) } }
            });
            const rounded = roundCurrency(incremented.balance, 4);
            const userRes = rounded !== incremented.balance
              ? await t.user.update({ where: { id: tx.userId }, data: { balance: rounded } })
              : incremented;

            return [tx, userRes];
          });
        } catch (txError: any) {
          if (txError.message === 'ALREADY_PROCESSED') {
            await sendTelegramMessage(chatId, `[WARNING] <b>تم اعتماد أو معالجة هذه العملية مسبقاً!</b>`);
            return;
          }
          throw txError;
        }

        const upgradedUser = await checkAndAutoUpgradeMembership(tx.userId, tx.amount);

        const tierInfo = upgradedUser?.membershipTier
          ? `<b>العضوية الحالية:</b> ${upgradedUser.membershipTier.nameAr || upgradedUser.membershipTier.name} (-${upgradedUser.membershipTier.discountPercentage}% خصم)`
          : '';

        await sendTelegramMessage(
          chatId,
          `<b>تمت الموافقة وشحن الرصيد بنجاح عبر التلجرام!</b>\n\n<b>العميل:</b> ${updatedUser.fullName} (<code>${updatedUser.email}</code>)\n<b>المبلغ المضاف:</b> <code>+$${tx.amount.toFixed(2)} USD</code>\n<b>رصيد الحساب الجديد:</b> <code>$${updatedUser.balance.toFixed(2)} USD</code>\n${tierInfo}`
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
           await sendTelegramMessage(chatId, `[WARNING] <b>هذه العملية تمت معالجتها مسبقاً!</b>`);
           return;
        }

        await sendTelegramMessage(chatId, `[REJECTED] <b>تم رفض طلب الإيداع رقم #${txId.slice(-6)} بنجاح.</b>`);
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
          await sendTelegramMessage(chatId, `[WARNING] <b>تم إكمال هذا الطلب مسبقاً!</b>`);
          return;
        }

        const updatedOrder = await prisma.order.findUnique({ where: { id: orderId } });

        await sendTelegramMessage(chatId, `[COMPLETED] <b>تم إكمال الطلب #${orderId.slice(-6)} بنجاح!</b> (${updatedOrder?.serviceName || ''})`);
        return;
      }

      // 5. Cancel & Refund Order: cancel_refund_order_{orderId}
      if (data.startsWith('cancel_refund_order_')) {
        const orderId = data.replace('cancel_refund_order_', '').trim();
        await answerCallbackQuery(cbId, 'جاري الإلغاء واسترجاع الرصيد...', false);

        const order = await prisma.order.findUnique({ where: { id: orderId }, include: { user: true } });
        if (!order || !order.userId) {
          await sendTelegramMessage(chatId, `[ERROR] <b>الطلب غير موجود أو غير مرتبط بحساب عميل!</b>`);
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

            const incremented = await t.user.update({
              where: { id: order.userId },
              data: { balance: { increment: roundCurrency(order.price) } }
            });
            const rounded = roundCurrency(incremented.balance, 4);
            const userRes = rounded !== incremented.balance
              ? await t.user.update({ where: { id: order.userId }, data: { balance: rounded } })
              : incremented;

            await t.transaction.create({
              data: {
                userId: order.userId,
                type: `استرجاع رصيد طلب ملغي: #${order.id.slice(-6)}`,
                amount: roundCurrency(order.price),
                method: 'استرجاع للمحفظة',
                refNo: `REFUND-#${order.id.slice(-6)}`,
                status: 'completed'
              }
            });
            
            return userRes;
          });
        } catch (txError: any) {
          if (txError.message === 'ALREADY_PROCESSED') {
            await sendTelegramMessage(chatId, `[WARNING] <b>تم إلغاء هذا الطلب واسترجاع رصيده مسبقاً!</b>`);
            return;
          }
          throw txError;
        }

        await sendTelegramMessage(
          chatId,
          `[REFUND] <b>تم إلغاء الطلب واسترجاع الرصيد بنجاح!</b>\n\n<b>رقم الطلب:</b> #${order.id.slice(-6)}\n<b>العميل:</b> ${refundedUser.fullName}\n<b>المبلغ المسترجع:</b> <code>+$${order.price.toFixed(2)} USD</code>\n<b>رصيد العميل الحالي:</b> <code>$${refundedUser.balance.toFixed(2)} USD</code>`
        );
        return;
      }
    } catch (err: any) {
      console.error('[Telegram Callback Error]:', err);
      await sendTelegramMessage(chatId, `[WARNING] <b>حدث خطأ أثناء معالجة الأمر:</b> ${err?.message}`);
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
    if (lowerText === '/start' || lowerText === '/admin') {
      console.warn(`[Telegram Bot] Unauthorized access attempt from chat ID: ${chatId}, sender: ${incomingSenderId}`);
      await sendTelegramMessage(
        chatId,
        `<b>حساب غير مسجل كمشرف</b>\n\nمعرف حسابك (Chat ID): <code>${chatId}</code>\n\nلتفعيل هذا الحساب:\nيجب إضافة المعرف حصراً من داخل لوحة تحكم الإدارة (صفحة الإعدادات) بواسطة المدير العام بعد اجتياز التحقق الثنائي (MFA). لا يُقبل تفعيل الحسابات عبر الرسائل النصية المباشرة.`
      );
    }
    return;
  }

  // 2. /start or /admin for authorized admins
  if (lowerText === '/start' || lowerText === '/admin') {
    await sendTelegramMessage(
      chatId,
      `<b>اهلاً بك في بوت الادارة</b>\n\nحسابك مسجل كـ <b>مشرف معتمد</b> (Chat ID: <code>${chatId}</code>) وتصلك جميع اشعارات الايداعات والطلبات فورياً مع ازرار التحكم والاعتماد.`,
      {
        inline_keyboard: [
          [{ text: "عدد المشرفين المسجلين", callback_data: "admin_count" }],
          [{ text: "تسجيل الخروج (الغاء الربط)", callback_data: "admin_logout" }]
        ]
      }
    );
    return;
  }

  // 3. Status check
  if (lowerText === '/status') {
    await sendTelegramMessage(
      chatId,
      `<b>حسابك مسجل كـ مشرف معتمد (Chat ID: <code>${chatId}</code>) وتصلك الاشعارات والازرار التفاعلية فورياً.</b>`
    );
    return;
  }

  // 4. Logout / Unlink
  if (lowerText === '/logout' || lowerText === '/unlink' || lowerText === 'الغاء ربط الحساب' || lowerText === 'الغاء الربط' || lowerText === 'تسجيل خروج') {
    await removeAdminChatId(chatId);
    await sendTelegramMessage(
      chatId,
      `<b>تم تسجيل الخروج والغاء الربط بنجاح</b>\nلن تصلك اشعارات بعد الان. ارسل /start لتسجيل الدخول مجدداً.`
    );
    return;
  }
}

export async function removeAdminChatId(chatId: string) {
  if (chatId === DEFAULT_ADMIN_CHAT_ID) return;
  adminChatIds = adminChatIds.filter(id => id !== chatId);
  if (adminChatIds.length === 0 && DEFAULT_ADMIN_CHAT_ID) {
    adminChatIds = [DEFAULT_ADMIN_CHAT_ID];
  }
  try {
    await prisma.setting.upsert({
      where: { key: 'telegram_admin_chat_ids' },
      update: { value: JSON.stringify(adminChatIds) },
      create: { key: 'telegram_admin_chat_ids', value: JSON.stringify(adminChatIds) }
    });
  } catch (err: any) {
    console.error('[Telegram Bot] Failed to persist removed admin:', err?.message || err);
  }
  console.log(`[Telegram Bot] Removed Admin Chat ID from session and DB: ${chatId}`);
}

export function escapeHtml(str: string): string {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function stripHtml(html: string): string {
  if (!html) return '';
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/br>/gi, '\n')
    .replace(/<hr\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>?/gm, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

export function sanitizeTelegramHtml(input: string): string {
  if (!input) return '';
  let str = String(input).replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  str = str.replace(/<br\s*\/?>/gi, '\n');
  str = str.replace(/<\/br>/gi, '\n');
  str = str.replace(/<hr\s*\/?>/gi, '\n---\n');
  str = str.replace(/<p\b[^>]*>/gi, '\n');
  str = str.replace(/<\/p>/gi, '\n');
  str = str.replace(/<div\b[^>]*>/gi, '\n');
  str = str.replace(/<\/div>/gi, '\n');
  str = str.replace(/<li\b[^>]*>/gi, '\n- ');
  str = str.replace(/<\/li>/gi, '');
  str = str.replace(/<\/?(table|tbody|thead|tr|th|td)\b[^>]*>/gi, '\n');
  str = str.replace(/<\/?(h[1-6])\b[^>]*>/gi, '\n');
  str = str.replace(/&nbsp;/gi, ' ');

  str = str.replace(/<span\s+class="tg-spoiler">/gi, '<tg-spoiler>');
  str = str.replace(/<\/span>/gi, '</tg-spoiler>');

  const tagRegex = /(<\/?[a-zA-Z0-9_-]+(?:\s+[^>]*)?>)/g;
  const tokens = str.split(tagRegex);

  const allowedTags = new Set([
    'b', 'strong',
    'i', 'em',
    'u', 'ins',
    's', 'strike', 'del',
    'code', 'pre',
    'blockquote',
    'tg-spoiler',
    'tg-emoji'
  ]);

  const tagStack: string[] = [];
  let result = '';

  for (const token of tokens) {
    if (!token) continue;

    const tagMatch = token.match(/^<(\/)?([a-zA-Z0-9_-]+)(\s+[^>]*)?>$/);
    if (tagMatch) {
      const isClosing = Boolean(tagMatch[1]);
      const rawTagName = tagMatch[2].toLowerCase();
      const rawAttrs = tagMatch[3] || '';

      if (rawTagName === 'a') {
        if (isClosing) {
          const lastIndex = tagStack.lastIndexOf('a');
          if (lastIndex !== -1) {
            while (tagStack.length > lastIndex) {
              const closed = tagStack.pop();
              result += `</${closed}>`;
            }
          }
        } else {
          const hrefMatch = rawAttrs.match(/href=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
          const href = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]) : '';
          if (href) {
            const safeHref = href.replace(/"/g, '&quot;');
            result += `<a href="${safeHref}">`;
            tagStack.push('a');
          }
        }
        continue;
      }

      if (allowedTags.has(rawTagName)) {
        if (isClosing) {
          const lastIndex = tagStack.lastIndexOf(rawTagName);
          if (lastIndex !== -1) {
            while (tagStack.length > lastIndex) {
              const closed = tagStack.pop();
              result += `</${closed}>`;
            }
          }
        } else {
          if (rawTagName === 'code' && rawAttrs) {
            const classMatch = rawAttrs.match(/class=(?:"([^"]*)"|'([^']*)'|(\S+))/i);
            const className = classMatch ? (classMatch[1] || classMatch[2] || classMatch[3]) : '';
            if (className.startsWith('language-')) {
              result += `<code class="${className}">`;
            } else {
              result += '<code>';
            }
          } else {
            result += `<${rawTagName}>`;
          }
          tagStack.push(rawTagName);
        }
        continue;
      }

      continue;
    }

    let text = token;
    text = text.replace(/&(?!([a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;');
    text = text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

    result += text;
  }

  while (tagStack.length > 0) {
    const closed = tagStack.pop();
    result += `</${closed}>`;
  }

  return result.replace(/\n{3,}/g, '\n\n').trim();
}

async function postTelegramMessage(chatId: string, text: string, parseMode?: 'HTML', replyMarkup?: any) {
  const payload: Record<string, any> = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const res = await axios.post(`${getTelegramApiUrl()}/sendMessage`, payload, {
    httpsAgent: telegramHttpsAgent,
    timeout: 15000
  });
  console.log(`[Telegram Service] Message sent to Chat ID: ${chatId}`);
  return res.data;
}

// Send Text Message to Telegram
export async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: any) {
  const safeMarkup = sanitizeTelegramReplyMarkup(replyMarkup);
  const sanitizedText = sanitizeTelegramHtml(text);

  try {
    return await postTelegramMessage(chatId, sanitizedText, 'HTML', safeMarkup);
  } catch (error: any) {
    const errorDesc = error?.response?.data?.description || error?.message;
    const markupRejected = Boolean(safeMarkup) && isMarkupRejectedError(error);
    console.warn(`[Telegram Service Error] Failed HTML send to ${chatId} (${errorDesc}), retrying fallback...`);

    const secondMarkup = markupRejected ? undefined : safeMarkup;
    try {
      if (markupRejected) {
        return await postTelegramMessage(chatId, sanitizedText, 'HTML', undefined);
      }
      return await postTelegramMessage(chatId, stripHtml(text), undefined, secondMarkup);
    } catch (err2: any) {
      if (secondMarkup) {
        try {
          return await postTelegramMessage(chatId, stripHtml(text), undefined, undefined);
        } catch (err3: any) {
          console.error(`[Telegram Final Fallback Error for ${chatId}]:`, err3?.response?.data?.description || err3?.message);
          return undefined;
        }
      }
      console.error(`[Telegram Plain Text Fallback Error for ${chatId}]:`, err2?.response?.data?.description || err2?.message);
      return undefined;
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
    const safeMarkup = sanitizeTelegramReplyMarkup(replyMarkup);
    const sanitizedCaption = sanitizeTelegramHtml(caption);
    const trimmedCaption = sanitizedCaption.length > 1024
      ? sanitizeTelegramHtml(sanitizedCaption.slice(0, 1000)) + '...'
      : sanitizedCaption;

    for (const chatId of targetChatIds) {
      let delivered = false;
      let markupForChat = safeMarkup;

      // 1. Try sendPhoto or sendDocument if image buffer is available
      if (imageInfo) {
        const isLargeFile = imageInfo.buffer.length > 9.5 * 1024 * 1024;
        const postMedia = async (endpoint: 'sendPhoto' | 'sendDocument', field: 'photo' | 'document', cap: string, html: boolean, markup?: any) => {
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('caption', cap);
          if (html) form.append('parse_mode', 'HTML');
          if (markup) form.append('reply_markup', JSON.stringify(markup));
          form.append(field, imageInfo.buffer, { filename: imageInfo.filename, contentType: imageInfo.mimeType });
          await axios.post(`${getTelegramApiUrl()}/${endpoint}`, form, {
            httpsAgent: telegramHttpsAgent,
            headers: form.getHeaders(),
            timeout: 60000
          });
        };

        if (!isLargeFile) {
          try {
            await postMedia('sendPhoto', 'photo', trimmedCaption, true, markupForChat);
            console.log(`[Telegram Bot] Receipt photo sent successfully to Admin Chat ID: ${chatId}`);
            delivered = true;
          } catch (photoErr: any) {
            if (isMarkupRejectedError(photoErr)) markupForChat = undefined;
            const photoDesc = photoErr?.response?.data?.description || photoErr?.message;
            console.warn(`[Telegram sendPhoto HTML failed for ${chatId}, trying plain text caption]:`, photoDesc);

            try {
              await postMedia('sendPhoto', 'photo', stripHtml(trimmedCaption), false, markupForChat);
              console.log(`[Telegram Bot] Receipt photo (plain) sent successfully to Admin Chat ID: ${chatId}`);
              delivered = true;
            } catch (photoErr2: any) {
              if (isMarkupRejectedError(photoErr2)) markupForChat = undefined;
            }
          }
        }

        // 2. If not delivered yet (or if file is large > 9.5MB), send as Document
        if (!delivered) {
          try {
            await postMedia('sendDocument', 'document', stripHtml(trimmedCaption), false, markupForChat);
            console.log(`[Telegram Bot] Receipt document sent successfully to Admin Chat ID: ${chatId}`);
            delivered = true;
          } catch (docErr: any) {
            if (isMarkupRejectedError(docErr)) {
              markupForChat = undefined;
              try {
                await postMedia('sendDocument', 'document', stripHtml(trimmedCaption), false, undefined);
                console.log(`[Telegram Bot] Receipt document sent successfully (without buttons) to Admin Chat ID: ${chatId}`);
                delivered = true;
              } catch (docErr2: any) {
                console.warn(`[Telegram sendDocument failed for ${chatId}]:`, docErr2?.response?.data?.description || docErr2?.message);
              }
            } else {
              console.warn(`[Telegram sendDocument failed for ${chatId}]:`, docErr?.response?.data?.description || docErr?.message);
            }
          }
        }
      }

      // 3. Fallback to sendMessage (text-only) if photo wasn't delivered or no image attached
      if (!delivered) {
        await sendTelegramMessage(
          chatId,
          caption + (imageInfo ? '\n\n<i>(مرفق مع الطلب صورة إيصال التحويل)</i>' : ''),
          markupForChat
        );
      }
    }
  } catch (error: any) {
    console.error('[Telegram Photo Delivery Error]:', error?.message);
  }
}

// Send Document (e.g., Backup ZIP) to Telegram Admins
export async function sendDocumentToAdmins(filePath: string, caption: string): Promise<boolean> {
  try {
    await refreshAdminIds();
    const targetChatIds = getAdminChatIds();
    if (targetChatIds.length === 0) {
      console.warn('[Telegram Document Delivery] No admin chat IDs registered');
      return false;
    }

    let successCount = 0;
    for (const chatId of targetChatIds) {
      try {
        if (fs.existsSync(filePath)) {
          const form = new FormData();
          const sanitizedDocCaption = sanitizeTelegramHtml(caption);
          form.append('chat_id', chatId);
          form.append('caption', sanitizedDocCaption.slice(0, 1000));
          form.append('parse_mode', 'HTML');
          form.append('document', fs.createReadStream(filePath));

          await axios.post(`${getTelegramApiUrl()}/sendDocument`, form, {
            httpsAgent: telegramHttpsAgent,
            headers: form.getHeaders(),
            timeout: 60000
          });
          successCount++;
          console.log(`[Telegram Bot] Document sent successfully to Admin Chat ID: ${chatId}`);
        } else {
          console.error(`[Telegram Bot] Document not found at path: ${filePath}`);
        }
      } catch (error: any) {
        const errorMsg = error?.response?.data?.description || error?.message;
        console.error(`[Telegram Document Delivery Error for ${chatId}]:`, errorMsg);
        await sendTelegramMessage(chatId, caption + `\n\n<i>[WARNING] تعذر إرسال الملف إليك بسبب مشكلة في الرفع. (${errorMsg})</i>`);
      }
    }
    return successCount > 0;
  } catch (error: any) {
    console.error('[Telegram Document Delivery Fatal Error]:', error?.message);
    return false;
  }
}

// Send Admin OTP to Telegram Admins
export async function sendTelegramAdminOtp(
  otpCode: string,
  user: { username: string; fullName?: string },
  clientIp?: string
): Promise<boolean> {
  try {
    await refreshAdminIds();
    const chatIds = getAdminChatIds();
    if (chatIds.length === 0) {
      console.warn('[Telegram OTP] No admin chat IDs registered');
      return false;
    }

    const message = [
      '<b>[Admin Login OTP]</b>',
      '',
      `<b>المشرف:</b> @${escapeHtml(user.username)} (${escapeHtml(user.fullName || 'Admin')})`,
      `<b>الوقت:</b> ${new Date().toLocaleTimeString('ar-EG')}`,
      `<b>عنوان IP:</b> <code>${escapeHtml(clientIp || 'غير متوفر')}</code>`,
      '',
      '<b>رمز التحقق السري:</b>',
      `<code>${otpCode}</code>`,
      '',
      '<i>هذا الرمز صالح لمدة 5 دقائق فقط. لا تشارك هذا الرمز مع أي شخص لحماية لوحة التحكم.</i>'
    ].join('\n');

    let successCount = 0;
    for (const chatId of chatIds) {
      try {
        const res = await sendTelegramMessage(chatId, message);
        if (res) successCount++;
      } catch (err: any) {
        console.error(`[Telegram sendTelegramAdminOtp Error for ${chatId}]:`, err?.message);
      }
    }
    return successCount > 0;
  } catch (error: any) {
    console.error('[Telegram sendTelegramAdminOtp Error]:', error?.message);
    return false;
  }
}

// Notify Admins on Successful Admin Login
export async function sendTelegramAdminLoginSuccess(
  user: { username: string; fullName?: string },
  clientIp?: string
): Promise<void> {
  try {
    await refreshAdminIds();
    const chatIds = getAdminChatIds();
    if (chatIds.length === 0) return;

    const message = [
      '<b>[Admin Session Started]</b>',
      '',
      `تم تسجيل الدخول إلى لوحة الإدارة بنجاح بواسطة: @${escapeHtml(user.username)} (${escapeHtml(user.fullName || 'Admin')})`,
      `الوقت: ${new Date().toLocaleTimeString('ar-EG')}`,
      `عنوان IP: <code>${escapeHtml(clientIp || 'غير متوفر')}</code>`
    ].join('\n');

    for (const chatId of chatIds) {
      await sendTelegramMessage(chatId, message);
    }
  } catch (error: any) {
    console.error('[Telegram sendTelegramAdminLoginSuccess Error]:', error?.message);
  }
}

// Send Admin Password Reset OTP via Telegram
export async function sendTelegramAdminPasswordResetOtp(
  otpCode: string,
  user: { username: string; fullName?: string },
  clientIp?: string
): Promise<boolean> {
  try {
    await refreshAdminIds();
    const chatIds = getAdminChatIds();
    if (chatIds.length === 0) {
      console.warn('[Telegram Recovery OTP] No admin chat IDs registered');
      return false;
    }

    const message = [
      '<b>[استعادة كلمة مرور الإدارة]</b>',
      '',
      `<b>المشرف:</b> @${escapeHtml(user.username)} (${escapeHtml(user.fullName || 'Admin')})`,
      `<b>الوقت:</b> ${new Date().toLocaleTimeString('ar-EG')}`,
      `<b>عنوان IP:</b> <code>${escapeHtml(clientIp || 'غير متوفر')}</code>`,
      '',
      '<b>رمز التحقق السري لإعادة تعيين كلمة المرور:</b>',
      `<code>${otpCode}</code>`,
      '',
      '<i>هذا الرمز صالح لمدة 5 دقائق فقط لمرة واحدة. إذا لم تكن أنت من طلب ذلك، يرجى الحذر.</i>'
    ].join('\n');

    let successCount = 0;
    for (const chatId of chatIds) {
      try {
        const res = await sendTelegramMessage(chatId, message);
        if (res) successCount++;
      } catch (err: any) {
        console.error(`[Telegram sendTelegramAdminPasswordResetOtp Error for ${chatId}]:`, err?.message);
      }
    }
    return successCount > 0;
  } catch (error: any) {
    console.error('[Telegram sendTelegramAdminPasswordResetOtp Error]:', error?.message);
    return false;
  }
}

// Notify Admins on Successful Admin Password Reset
export async function sendTelegramAdminPasswordResetSuccess(
  user: { username: string; fullName?: string },
  clientIp?: string
): Promise<void> {
  try {
    await refreshAdminIds();
    const chatIds = getAdminChatIds();
    if (chatIds.length === 0) return;

    const message = [
      '<b>[تنبيه أمان: تم تحديث بيانات دخول الإدارة]</b>',
      '',
      `تم تحديث بيانات حساب المشرف بنجاح: @${escapeHtml(user.username)} ${user.fullName ? `(${escapeHtml(user.fullName)})` : ''}`,
      `الوقت: ${new Date().toLocaleTimeString('ar-EG')}`,
      `عنوان IP: <code>${escapeHtml(clientIp || 'غير متوفر')}</code>`,
      '',
      '<i>تم إنهاء كافة الجلسات السابقة تلقائياً وتفعيل البيانات الجديدة.</i>'
    ].join('\n');

    for (const chatId of chatIds) {
      await sendTelegramMessage(chatId, message);
    }
  } catch (error: any) {
    console.error('[Telegram sendTelegramAdminPasswordResetSuccess Error]:', error?.message);
  }
}

// The server starts polling only after successful database initialization.
