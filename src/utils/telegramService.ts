import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'path';
import bcrypt from 'bcryptjs';
import { prisma } from '../server';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const ADMIN_FILE_PATH = path.join(__dirname, '../../telegram_admins.json');
const PRIMARY_SITE_DB_PATH = path.join(__dirname, '../../../../backend/db.js');

// Memory & File Persistence for Telegram Admin Chat IDs
let adminChatIds: string[] = [];
let pendingNotificationsQueue: Array<{ imageSource?: string; caption: string; replyMarkup?: any }> = [];
let isRefreshingAdminChatIds = false;

function normalizeAdminChatIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((id) => String(id).trim()).filter(Boolean))];
}

async function loadAdminChatIdsFromPrimarySite(): Promise<string[]> {
  return []; // Bypassing this external DB requirement which causes hangs
}

async function refreshAdminChatIds() {
  if (isRefreshingAdminChatIds) return adminChatIds;
  isRefreshingAdminChatIds = true;

  try {
    const primarySiteIds = await loadAdminChatIdsFromPrimarySite();
    if (primarySiteIds.length > 0) {
      adminChatIds = primarySiteIds;
      return adminChatIds;
    }

    if (process.env.TELEGRAM_ADMIN_CHAT_ID) {
      const envIds = normalizeAdminChatIds([process.env.TELEGRAM_ADMIN_CHAT_ID]);
      if (envIds.length > 0) {
        adminChatIds = envIds;
      }
    }

    return adminChatIds;
  } finally {
    isRefreshingAdminChatIds = false;
  }
}

// Load persisted Admin Chat IDs from file
function loadAdminChatIds() {
  try {
    if (fs.existsSync(ADMIN_FILE_PATH)) {
      const data = fs.readFileSync(ADMIN_FILE_PATH, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        adminChatIds = normalizeAdminChatIds(parsed);
        console.log(`[Telegram Bot] Loaded ${adminChatIds.length} registered Admin Chat ID(s):`, adminChatIds);
      }
    }
  } catch (err) {
    console.error('[Telegram Bot] Error reading telegram_admins.json:', err);
  }

  // Include env variable if set
  if (process.env.TELEGRAM_ADMIN_CHAT_ID && !adminChatIds.includes(process.env.TELEGRAM_ADMIN_CHAT_ID)) {
    adminChatIds.push(process.env.TELEGRAM_ADMIN_CHAT_ID);
  }
}

// Save Admin Chat IDs to file
function saveAdminChatIds() {
  try {
    fs.writeFileSync(ADMIN_FILE_PATH, JSON.stringify(adminChatIds, null, 2), 'utf-8');
  } catch (err) {
    console.error('[Telegram Bot] Error saving telegram_admins.json:', err);
  }
}

export function addAdminChatId(chatId: string) {
  if (chatId && !adminChatIds.includes(chatId)) {
    adminChatIds.push(chatId);
    saveAdminChatIds();
    console.log(`[Telegram Bot] Registered new Admin Chat ID: ${chatId}`);

    // Flush pending queued deposit notifications to newly registered admin
    flushPendingNotifications();
  }
}

export function getAdminChatIds(): string[] {
  return adminChatIds;
}

// Flush pending deposit notifications to registered admins
async function flushPendingNotifications() {
  if (pendingNotificationsQueue.length === 0 || adminChatIds.length === 0) return;

  console.log(`[Telegram Bot] Delivering ${pendingNotificationsQueue.length} pending deposit notification(s) to Admin...`);
  const queue = [...pendingNotificationsQueue];
  pendingNotificationsQueue = [];

  for (const item of queue) {
    await sendTelegramPhotoNotification(item);
  }
}

// Initial load
loadAdminChatIds();
refreshAdminChatIds().catch(() => {});

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

// Handle Incoming Telegram Commands (/start, /admin, admin admin123)
async function handleIncomingTelegramUpdate(update: any) {
  const message = update?.message;
  if (!message || !message.text) return;

  const chatId = message.chat.id.toString();
  const text = message.text.trim();
  const lowerText = text.toLowerCase();

  // Command: /start or /admin
  if (lowerText === '/start' || lowerText === '/admin') {
    if (!adminChatIds.includes(chatId)) {
      addAdminChatId(chatId);
    }

    await sendTelegramMessage(
      chatId,
      `🟢 <b>أهلاً بك في بوت الإدارة التلقائي!</b>\n\nحسابك مسجل الآن كـ <b>أدمن معتمد</b> 🚀 وتصلك جميع إشعارات طلبات الشحن وصور الإيصالات فورياً.`
    );
    return;
  }

  // Check login credentials: [username_or_email] [password]
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
        addAdminChatId(chatId);
        await sendTelegramMessage(
          chatId,
          `✅ <b>تم التحقق والتسجيل بنجاح!</b>\n\nتم إضافة حسابك (Chat ID: <code>${chatId}</code>) لقائمة المدراء المعتمدين بنجاح. 🎉\n\nمن الآن، أي صورة تحويل أو إيصال شحن يرفعه العميل ستصلك مباشرة فوراً على هذا الحساب!`
        );
        return;
      }
    } catch (err) {
      console.error('[Telegram Bot] DB auth error:', err);
    }
  }

  // Status check
  if (lowerText === '/status') {
    const isAuth = adminChatIds.includes(chatId);
    await sendTelegramMessage(
      chatId,
      isAuth
        ? `🟢 <b>حسابك مسجل كـ أدمن معتمد وتصلك صور الإيصالات فوراً.</b>`
        : `🔴 <b>حسابك غير مسجل كـ أدمن!</b> أرسل <code>/admin</code> لتفعيل استقبال الإشعارات.`
    );
    return;
  }

  // Automatically register any chat sending to the bot
  if (!adminChatIds.includes(chatId)) {
    addAdminChatId(chatId);
    await sendTelegramMessage(
      chatId,
      `🟢 <b>تم تفعيل حسابك كـ أدمن لاستقبال صور الإيصالات وطلبات الشحن بنجاح!</b>`
    );
  }
}

export function removeAdminChatId(chatId: string) {
  if (adminChatIds.includes(chatId)) {
    adminChatIds = adminChatIds.filter(id => id !== chatId);
    saveAdminChatIds();
    console.log(`[Telegram Bot] Removed invalid Admin Chat ID: ${chatId}`);
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

// Send Text Message to Telegram
export async function sendTelegramMessage(chatId: string, text: string, replyMarkup?: any) {
  try {
    await refreshAdminChatIds();
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
    console.error(`[Telegram Service Error] Failed to send message to ${chatId}:`, errorDesc);
    if (errorDesc && (errorDesc.includes('chat not found') || errorDesc.includes('bot was blocked') || errorDesc.includes('user is deactivated'))) {
      removeAdminChatId(chatId);
    }
  }
}

// Send Photo (Base64 string, URL, or file path) directly to Telegram with triple fallback guarantee
export async function sendTelegramPhotoNotification({
  imageSource,
  caption,
  replyMarkup
}: {
  imageSource?: string;
  caption: string;
  replyMarkup?: any;
}) {
  try {
    await refreshAdminChatIds();
    if (adminChatIds.length === 0) {
      console.log('⚠️ [Telegram Bot Notice] No Admin Chat ID registered yet. Queuing notification until Admin connects to Bot...');
      pendingNotificationsQueue.push({ imageSource, caption, replyMarkup });
      return;
    }

    let photoBuffer: Buffer | null = null;
    let filename = 'receipt.jpg';
    let mimeType = 'image/jpeg';

    if (imageSource && typeof imageSource === 'string') {
      if (imageSource.startsWith('data:image/')) {
        const match = imageSource.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/s);
        if (match) {
          mimeType = match[1];
          const ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg';
          filename = `receipt.${ext}`;
          photoBuffer = Buffer.from(match[2], 'base64');
        } else {
          const raw = imageSource.split(';base64,').pop();
          if (raw) photoBuffer = Buffer.from(raw, 'base64');
        }
      } else if (fs.existsSync(imageSource)) {
        try {
          photoBuffer = fs.readFileSync(imageSource);
          const ext = path.extname(imageSource).slice(1) || 'jpg';
          filename = `receipt.${ext}`;
          mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
        } catch {}
      } else if (/^[A-Za-z0-9+/=\s]+$/.test(imageSource.slice(0, 100)) && imageSource.length > 100) {
        photoBuffer = Buffer.from(imageSource.trim(), 'base64');
      }
    }

    const trimmedCaption = caption.length > 1000 ? caption.slice(0, 995) + '...' : caption;

    for (const chatId of [...adminChatIds]) {
      let delivered = false;

      // 1. Try sendPhoto if image buffer is available
      if (photoBuffer) {
        try {
          const form = new FormData();
          form.append('chat_id', chatId);
          form.append('caption', trimmedCaption);
          form.append('parse_mode', 'HTML');
          if (replyMarkup) {
            form.append('reply_markup', JSON.stringify(replyMarkup));
          }
          form.append('photo', photoBuffer, { filename, contentType: mimeType });

          await axios.post(`${TELEGRAM_API_URL}/sendPhoto`, form, {
            headers: form.getHeaders(),
            timeout: 25000
          });
          console.log(`🚀 [Telegram Bot] Receipt photo sent successfully to Admin Chat ID: ${chatId}`);
          delivered = true;
        } catch (photoErr: any) {
          const photoDesc = photoErr?.response?.data?.description || photoErr?.message;
          console.warn(`[Telegram sendPhoto failed for ${chatId}, trying document fallback]:`, photoDesc);

          if (photoDesc && (photoDesc.includes('chat not found') || photoDesc.includes('bot was blocked') || photoDesc.includes('user is deactivated'))) {
            removeAdminChatId(chatId);
            continue;
          }

          // 2. Fallback to sendDocument
          try {
            const docForm = new FormData();
            docForm.append('chat_id', chatId);
            docForm.append('caption', trimmedCaption);
            docForm.append('parse_mode', 'HTML');
            if (replyMarkup) {
              docForm.append('reply_markup', JSON.stringify(replyMarkup));
            }
            docForm.append('document', photoBuffer, { filename, contentType: mimeType });

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

      // 3. Fallback to sendMessage (text-only) if photo wasn't delivered or no image attached
      if (!delivered) {
        await sendTelegramMessage(chatId, caption + (photoBuffer ? '\n\n<i>⚠️ تعذر إرسال المعاينة المباشرة للصورة.</i>' : ''), replyMarkup);
      }
    }
  } catch (error: any) {
    console.error('[Telegram Photo Delivery Fatal Error]:', error?.message);
  }
}

// Send Document (e.g., Backup ZIP) to Telegram Admins
export async function sendDocumentToAdmins(filePath: string, caption: string) {
  try {
    await refreshAdminChatIds();
    if (adminChatIds.length === 0) {
      console.log('⚠️ [Telegram Bot Notice] No Admin Chat ID registered to send document.');
      return;
    }

    for (const chatId of [...adminChatIds]) {
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
        if (errorMsg && (errorMsg.includes('chat not found') || errorMsg.includes('bot was blocked'))) {
          removeAdminChatId(chatId);
        } else {
          await sendTelegramMessage(chatId, caption + `\n\n<i>⚠️ تعذر إرسال الملف إليك بسبب مشكلة في الرفع. (${errorMsg})</i>`);
        }
      }
    }
  } catch (error: any) {
    console.error('[Telegram Document Delivery Fatal Error]:', error?.message);
  }
}

// Start listener automatically
startTelegramBotPolling();
