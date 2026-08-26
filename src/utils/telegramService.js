"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.addAdminChatId = addAdminChatId;
exports.getAdminChatIds = getAdminChatIds;
exports.startTelegramBotPolling = startTelegramBotPolling;
exports.sendTelegramMessage = sendTelegramMessage;
exports.sendTelegramPhotoNotification = sendTelegramPhotoNotification;
const axios_1 = __importDefault(require("axios"));
const form_data_1 = __importDefault(require("form-data"));
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '8520796422:AAEwT2cu1NU4IGdYjjxh627zC8cen01rftE';
const TELEGRAM_API_URL = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}`;
const ADMIN_FILE_PATH = path_1.default.join(__dirname, '../../telegram_admins.json');
// Memory & File Persistence for Telegram Admin Chat IDs
let adminChatIds = [];
let pendingNotificationsQueue = [];
// Load persisted Admin Chat IDs from file
function loadAdminChatIds() {
    try {
        if (fs_1.default.existsSync(ADMIN_FILE_PATH)) {
            const data = fs_1.default.readFileSync(ADMIN_FILE_PATH, 'utf-8');
            const parsed = JSON.parse(data);
            if (Array.isArray(parsed)) {
                adminChatIds = parsed;
                console.log(`[Telegram Bot] Loaded ${adminChatIds.length} registered Admin Chat ID(s):`, adminChatIds);
            }
        }
    }
    catch (err) {
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
        fs_1.default.writeFileSync(ADMIN_FILE_PATH, JSON.stringify(adminChatIds, null, 2), 'utf-8');
    }
    catch (err) {
        console.error('[Telegram Bot] Error saving telegram_admins.json:', err);
    }
}
function addAdminChatId(chatId) {
    if (chatId && !adminChatIds.includes(chatId)) {
        adminChatIds.push(chatId);
        saveAdminChatIds();
        console.log(`[Telegram Bot] Registered new Admin Chat ID: ${chatId}`);
        // Flush pending queued deposit notifications to newly registered admin
        flushPendingNotifications();
    }
}
function getAdminChatIds() {
    return adminChatIds;
}
// Flush pending deposit notifications to registered admins
async function flushPendingNotifications() {
    if (pendingNotificationsQueue.length === 0 || adminChatIds.length === 0)
        return;
    console.log(`[Telegram Bot] Delivering ${pendingNotificationsQueue.length} pending deposit notification(s) to Admin...`);
    const queue = [...pendingNotificationsQueue];
    pendingNotificationsQueue = [];
    for (const item of queue) {
        await sendTelegramPhotoNotification(item);
    }
}
// Initial load
loadAdminChatIds();
// Long Polling Telegram Bot Updates
let lastUpdateId = 0;
let isPolling = false;
function startTelegramBotPolling() {
    if (isPolling)
        return;
    isPolling = true;
    console.log('[Telegram Bot Listener] Started background Telegram updates polling...');
    pollUpdates();
}
async function pollUpdates() {
    while (isPolling) {
        try {
            const res = await axios_1.default.get(`${TELEGRAM_API_URL}/getUpdates`, {
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
        }
        catch (err) {
            if (err?.response?.status === 409) {
                await new Promise((r) => setTimeout(r, 10000));
            }
            else {
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
    }
}
// Handle Incoming Telegram Commands (/start, /admin, admin admin123)
async function handleIncomingTelegramUpdate(update) {
    const message = update?.message;
    if (!message || !message.text)
        return;
    const chatId = message.chat.id.toString();
    const text = message.text.trim();
    const lowerText = text.toLowerCase();
    // Command: /start or /admin
    if (lowerText === '/start' || lowerText === '/admin') {
        if (!adminChatIds.includes(chatId)) {
            addAdminChatId(chatId);
        }
        await sendTelegramMessage(chatId, `🟢 <b>أهلاً بك في بوت الإدارة التلقائي!</b>\n\nحسابك مسجل الآن كـ <b>أدمن معتمد</b> 🚀 وتصلك جميع إشعارات طلبات الشحن وصور الإيصالات فورياً.`);
        return;
    }
    // Check login credentials: username "admin" and password "admin123"
    if ((lowerText.includes('admin') && lowerText.includes('admin123')) ||
        text === 'admin admin123') {
        addAdminChatId(chatId);
        await sendTelegramMessage(chatId, `✅ <b>تم التحقق والتسجيل بنجاح!</b>\n\nتم إضافة حسابك (Chat ID: <code>${chatId}</code>) لقائمة المدراء المعتمدين بنجاح. 🎉\n\nمن الآن، أي صورة تحويل أو إيصال شحن يرفعه العميل ستصلك مباشرة فوراً على هذا الحساب!`);
        return;
    }
    // Status check
    if (lowerText === '/status') {
        const isAuth = adminChatIds.includes(chatId);
        await sendTelegramMessage(chatId, isAuth
            ? `🟢 <b>حسابك مسجل كـ أدمن معتمد وتصلك صور الإيصالات فوراً.</b>`
            : `🔴 <b>حسابك غير مسجل كـ أدمن!</b> أرسل <code>/admin</code> لتفعيل استقبال الإشعارات.`);
        return;
    }
    // Automatically register any chat sending to the bot
    if (!adminChatIds.includes(chatId)) {
        addAdminChatId(chatId);
        await sendTelegramMessage(chatId, `🟢 <b>تم تفعيل حسابك كـ أدمن لاستقبال صور الإيصالات وطلبات الشحن بنجاح!</b>`);
    }
}
// Send Text Message to Telegram
async function sendTelegramMessage(chatId, text, replyMarkup) {
    try {
        await axios_1.default.post(`${TELEGRAM_API_URL}/sendMessage`, {
            chat_id: chatId,
            text,
            parse_mode: 'HTML',
            reply_markup: replyMarkup
        });
        console.log(`[Telegram Service] Message sent to Chat ID: ${chatId}`);
    }
    catch (error) {
        console.error(`[Telegram Service Error] Failed to send message to ${chatId}:`, error?.response?.data?.description || error?.message);
    }
}
// Send Photo (Base64 string or file path) directly to Telegram
async function sendTelegramPhotoNotification({ imageSource, caption, replyMarkup }) {
    try {
        if (adminChatIds.length === 0) {
            console.log('⚠️ [Telegram Bot Notice] No Admin Chat ID registered yet. Queuing notification until Admin connects to Bot...');
            pendingNotificationsQueue.push({ imageSource, caption, replyMarkup });
            return;
        }
        for (const chatId of adminChatIds) {
            if (imageSource && (imageSource.startsWith('data:image/') || fs_1.default.existsSync(imageSource))) {
                const form = new form_data_1.default();
                form.append('chat_id', chatId);
                form.append('caption', caption);
                form.append('parse_mode', 'HTML');
                if (replyMarkup) {
                    form.append('reply_markup', JSON.stringify(replyMarkup));
                }
                if (imageSource.startsWith('data:image/')) {
                    const base64Data = imageSource.split(';base64,').pop();
                    if (base64Data) {
                        const buffer = Buffer.from(base64Data, 'base64');
                        form.append('photo', buffer, { filename: 'receipt.jpg', contentType: 'image/jpeg' });
                    }
                }
                else if (fs_1.default.existsSync(imageSource)) {
                    form.append('photo', fs_1.default.createReadStream(imageSource));
                }
                await axios_1.default.post(`${TELEGRAM_API_URL}/sendPhoto`, form, {
                    headers: form.getHeaders()
                });
                console.log(`🚀 [Telegram Bot] Receipt photo sent successfully to Admin Chat ID: ${chatId}`);
            }
            else {
                await sendTelegramMessage(chatId, caption, replyMarkup);
            }
        }
    }
    catch (error) {
        console.error('[Telegram Photo Delivery Error]:', error?.response?.data?.description || error?.message);
    }
}
// Start listener automatically
startTelegramBotPolling();
