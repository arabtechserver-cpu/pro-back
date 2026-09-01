import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { prisma } from '../server';
import { placeImeiOrder, placeServerOrder } from './dhru-api';
import { sendDepositApprovalEmail, sendOrderConfirmationEmail } from './emailService';
import { checkAndAutoUpgradeMembership } from './membershipUpgrade';
import { normalizeTelegramAdminChatIds } from './telegram-config';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const DEFAULT_ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || '';

// Determine all possible locations for telegram_admins.json
function getAdminFilePath(): string {
  const possiblePaths = [
    path.join(__dirname, '../../telegram_admins.json'),
    path.join(__dirname, '../telegram_admins.json'),
    path.join(process.cwd(), 'telegram_admins.json'),
    path.join(process.cwd(), 'backend/telegram_admins.json')
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return possiblePaths[0];
}

const ADMIN_FILE_PATH = getAdminFilePath();

// Memory & File Persistence for Telegram Admin Chat IDs
let adminChatIds: string[] = normalizeTelegramAdminChatIds([], DEFAULT_ADMIN_CHAT_ID);
let pendingNotificationsQueue: Array<{ imageSource?: string; caption: string; replyMarkup?: any }> = [];
let isRefreshingAdminChatIds = false;

function normalizeAdminChatIds(ids: unknown): string[] {
  return normalizeTelegramAdminChatIds(ids, DEFAULT_ADMIN_CHAT_ID);
}

// Load persisted Admin Chat IDs from file
function loadAdminChatIds(silent = false) {
  try {
    const filePath = getAdminFilePath();
    if (fs.existsSync(filePath)) {
      const data = fs.readFileSync(filePath, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed) && parsed.length > 0) {
        adminChatIds = normalizeAdminChatIds([...adminChatIds, ...parsed]);
        if (!silent) {
          console.log(`[Telegram Bot] Loaded ${adminChatIds.length} registered Admin Chat ID(s):`, adminChatIds);
        }
      }
    }
  } catch (err) {
    if (!silent) console.error('[Telegram Bot] Error reading telegram_admins.json:', err);
  }

  // Include env variable if set
  adminChatIds = normalizeAdminChatIds(adminChatIds);
}

// Save Admin Chat IDs to file
function saveAdminChatIds() {
  try {
    const targetPaths = [
      path.join(__dirname, '../../telegram_admins.json'),
      path.join(process.cwd(), 'telegram_admins.json')
    ];
    for (const p of targetPaths) {
      try {
        fs.writeFileSync(p, JSON.stringify(adminChatIds, null, 2), 'utf-8');
      } catch {}
    }
  } catch (err) {
    console.error('[Telegram Bot] Error saving telegram_admins.json:', err);
  }
}

async function refreshAdminChatIds() {
  if (isRefreshingAdminChatIds) return adminChatIds;
  isRefreshingAdminChatIds = true;

  try {
    loadAdminChatIds(true);
    return adminChatIds;
  } finally {
    isRefreshingAdminChatIds = false;
  }
}

export function addAdminChatId(chatId: string) {
  if (chatId) {
    const cleanId = String(chatId).trim();
    if (!adminChatIds.includes(cleanId)) {
      adminChatIds.push(cleanId);
      saveAdminChatIds();
      console.log(`[Telegram Bot] Registered new Admin Chat ID: ${cleanId}`);
    }
    // Flush pending queued deposit notifications to registered admins
    flushPendingNotifications();
  }
}

export function getAdminChatIds(): string[] {
  adminChatIds = normalizeAdminChatIds(adminChatIds);
  return adminChatIds;
}

// Flush pending deposit notifications to registered admins
async function flushPendingNotifications() {
  if (pendingNotificationsQueue.length === 0) return;

  console.log(`[Telegram Bot] Delivering ${pendingNotificationsQueue.length} pending deposit notification(s) to Admin...`);
  const queue = [...pendingNotificationsQueue];
  pendingNotificationsQueue = [];

  for (const item of queue) {
    await sendTelegramPhotoNotification(item);
  }
}

// Initial load
loadAdminChatIds();
saveAdminChatIds();

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
  // -------------------------------------------------------------
  // A. Handle Interactive Inline Button Clicks (callback_query)
  // -------------------------------------------------------------
  if (update?.callback_query) {
    const cb = update.callback_query;
    const cbId = cb.id;
    const chatId = cb.message?.chat?.id ? String(cb.message.chat.id) : DEFAULT_ADMIN_CHAT_ID;
    const data: string = cb.data || '';

    addAdminChatId(chatId);

    try {
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
        if (dhruService.dhruCategory?.name === 'IMEI Service') {
          dhruResponse = await placeImeiOrder(dhruService.dhruId, order.targetInput, {});
        } else {
          dhruResponse = await placeServerOrder(dhruService.dhruId, order.quantity, {}, order.targetInput);
        }

        if (!dhruResponse || dhruResponse.SUCCESS === false || dhruResponse.ERROR || dhruResponse.Error) {
          const errMsg = dhruResponse?.Error || dhruResponse?.ERROR?.[0]?.MESSAGE || 'خطأ غير معروف من المزود';
          await sendTelegramMessage(chatId, `❌ <b>فشل إرسال الطلب للمزود:</b>\n<code>${errMsg}</code>`);
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

        if (tx.status === 'completed') {
          await sendTelegramMessage(chatId, `⚠️ <b>تم اعتماد هذه العملية مسبقاً!</b>`);
          return;
        }

        const updatedUser = await prisma.user.update({
          where: { id: tx.userId },
          data: { balance: { increment: tx.amount } }
        });

        await prisma.transaction.update({
          where: { id: txId },
          data: { status: 'completed' }
        });

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

        await prisma.transaction.update({
          where: { id: txId },
          data: { status: 'failed' }
        });

        await sendTelegramMessage(chatId, `❌ <b>تم رفض طلب الإيداع رقم #${txId.slice(-6)} بنجاح.</b>`);
        return;
      }

      // 4. Complete Order: complete_order_{orderId}
      if (data.startsWith('complete_order_')) {
        const orderId = data.replace('complete_order_', '').trim();
        await answerCallbackQuery(cbId, 'تم إكمال الطلب', false);

        const updatedOrder = await prisma.order.update({
          where: { id: orderId },
          data: { status: 'completed' },
          include: { user: true }
        });

        await sendTelegramMessage(chatId, `✅ <b>تم إكمال الطلب #${updatedOrder.id.slice(-6)} بنجاح!</b> (${updatedOrder.serviceName})`);
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

        if (order.status === 'rejected') {
          await sendTelegramMessage(chatId, `⚠️ <b>تم إلغاء هذا الطلب واسترجاع رصيده مسبقاً!</b>`);
          return;
        }

        const refundedUser = await prisma.user.update({
          where: { id: order.userId },
          data: { balance: { increment: order.price } }
        });

        await prisma.order.update({
          where: { id: orderId },
          data: { status: 'rejected' }
        });

        await prisma.transaction.create({
          data: {
            userId: order.userId,
            type: `استرجاع رصيد طلب ملغي: #${order.id.slice(-6)}`,
            amount: order.price,
            method: 'استرجاع للمحفظة',
            refNo: `REFUND-#${order.id.slice(-6)}`,
            status: 'completed'
          }
        });

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

  const chatId = message.chat?.id ? message.chat.id.toString() : '';
  if (!chatId) return;

  const text = (message.text || message.caption || '').trim();
  const lowerText = text.toLowerCase();

  // Always register sender chat ID to guarantee notifications reach them
  addAdminChatId(chatId);

  // 1. Secret / Special Mina Keyword trigger
  if (
    lowerText === 'mina' ||
    lowerText === '/mina' ||
    lowerText.includes('mina') ||
    text === 'مينا' ||
    text.includes('مينا')
  ) {
    await sendTelegramMessage(
      chatId,
      `👑 <b>أهلاً بك يا مينا!</b>\n\n✅ <b>تم تسجيل وتفعيل حسابك بنجاح كأدمن رئيسي معتمد</b> (Chat ID: <code>${chatId}</code>) 🚀\n\nمن الآن فصاعداً:\n• أي طلب خدمة يرسله العميل سيصلك فوراً مع زر <b>[إرسال للمزود]</b>.\n• أي صورة إيصال شحن ستصلك مع زر <b>[موافقة وشحن الرصيد]</b>.\n• يمكنك إدارة كل شيء من التلجرام مباشرة بضغطة واحدة! 🎉`
    );
    return;
  }

  // 2. Command: /start or /admin
  if (lowerText === '/start' || lowerText === '/admin') {
    await sendTelegramMessage(
      chatId,
      `🟢 <b>أهلاً بك في بوت الإدارة التفاعلي المطور!</b>\n\nحسابك مسجل كـ <b>أدمن معتمد</b> (Chat ID: <code>${chatId}</code>) 🚀 وتصلك جميع الإشعارات مع أزرار التحكم الفورية.`
    );
    return;
  }

  // 3. Check login credentials: [username_or_email] [password]
  const parts = text.split(/\s+/);
  if (parts.length === 2) {
    const [identifier, password] = parts;
    try {
      const user = await prisma.user.findFirst({
        where: {
          OR: [
            { email: identifier },
            { username: identifier }
          ],
          role: 'admin'
        }
      });

      if (user && await bcrypt.compare(password, user.password)) {
        await sendTelegramMessage(
          chatId,
          `✅ <b>تم التحقق والتسجيل بنجاح!</b>\n\nتم إضافة حسابك (Chat ID: <code>${chatId}</code>) لقائمة المدراء المعتمدين بنجاح. 🎉`
        );
        return;
      }
    } catch (err) {
      console.error('[Telegram Bot] DB auth error:', err);
    }
  }

  // 4. Status check
  if (lowerText === '/status') {
    await sendTelegramMessage(
      chatId,
      `🟢 <b>حسابك مسجل كـ أدمن معتمد (Chat ID: <code>${chatId}</code>) وتصلك الإشعارات والأزرار التفاعلية فورياً.</b>`
    );
    return;
  }

  // 5. Default acknowledge response for any other incoming text
  await sendTelegramMessage(
    chatId,
    `🟢 <b>تم تفعيل وتأكيد حسابك كـ أدمن لاستقبال صور الإيصالات وطلبات الشحن بنجاح!</b> (Chat ID: <code>${chatId}</code>)`
  );
}

export function removeAdminChatId(chatId: string) {
  // Only remove if it's not the default admin ID
  if (chatId === DEFAULT_ADMIN_CHAT_ID) return;
  if (adminChatIds.includes(chatId)) {
    adminChatIds = adminChatIds.filter(id => id !== chatId);
    if (adminChatIds.length === 0) {
      adminChatIds = [DEFAULT_ADMIN_CHAT_ID];
    }
    saveAdminChatIds();
    console.log(`[Telegram Bot] Removed Admin Chat ID: ${chatId}`);
  }
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
    await refreshAdminChatIds();
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

    // 2. HTTP/HTTPS URL
    if (imageSource.startsWith('http://') || imageSource.startsWith('https://')) {
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

    // 3. Direct local file path or public uploads path
    const checkPaths = [
      imageSource,
      path.join(process.cwd(), imageSource),
      path.join(process.cwd(), 'backend', imageSource),
      path.join(__dirname, '../../public', imageSource),
      path.join(__dirname, '../../../public', imageSource)
    ];

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
    await refreshAdminChatIds();
    const targetChatIds = getAdminChatIds();
    if (targetChatIds.length === 0) {
      throw new Error('No Telegram admin chat IDs are configured');
    }

    const imageInfo = await resolveImageBuffer(imageSource);
    const trimmedCaption = caption.length > 1000 ? caption.slice(0, 995) + '...' : caption;

    for (const chatId of targetChatIds) {
      let delivered = false;

      // 1. Try sendPhoto if image buffer is available
      if (imageInfo) {
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
            timeout: 25000
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
              timeout: 25000
            });
            console.log(`🚀 [Telegram Bot] Receipt photo (plain) sent successfully to Admin Chat ID: ${chatId}`);
            delivered = true;
          } catch (photoErr2: any) {
            // 2. Fallback to sendDocument
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
                timeout: 25000
              });
              console.log(`🚀 [Telegram Bot] Receipt document sent successfully to Admin Chat ID: ${chatId}`);
              delivered = true;
            } catch (docErr: any) {
              console.warn(`[Telegram sendDocument fallback failed for ${chatId}]:`, docErr?.response?.data?.description || docErr?.message);
            }
          }
        }
      }

      // 3. Fallback to sendMessage (text-only) if photo wasn't delivered or no image attached
      if (!delivered) {
        const messageResult = await sendTelegramMessage(
          chatId,
          caption + (imageInfo ? '\n\n<i>(مرفق مع الطلب صورة إيصال التحويل)</i>' : ''),
          replyMarkup
        );
        if (!messageResult) {
          throw new Error(`Telegram message delivery failed for chat ${chatId}`);
        }
      }
    }
  } catch (error: any) {
    console.error('[Telegram Photo Delivery Fatal Error]:', error?.message);
    throw error;
  }
}

// Send Document (e.g., Backup ZIP) to Telegram Admins
export async function sendDocumentToAdmins(filePath: string, caption: string) {
  try {
    await refreshAdminChatIds();
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

