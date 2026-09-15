import { Router } from 'express';
import { prisma } from '../utils/prisma';
import { isAdmin } from '../middleware/auth';
import { normalizeTelegramAdminChatIds } from '../utils/telegram-config';

const router = Router();

const TELEGRAM_ADMINS_KEY = 'telegram_admin_chat_ids';

// GET /api/settings/telegram-admins
router.get('/telegram-admins', isAdmin, async (_req, res) => {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: TELEGRAM_ADMINS_KEY } });
    const ids: string[] = setting ? JSON.parse(setting.value) : [];
    return res.json({ success: true, chatIds: ids });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ في جلب إعدادات تليجرام' });
  }
});

// POST /api/settings/telegram-admins
router.post('/telegram-admins', isAdmin, async (req, res) => {
  try {
    const { chatIds } = req.body;
    if (!Array.isArray(chatIds)) {
      return res.status(400).json({ error: 'chatIds يجب أن يكون مصفوفة' });
    }

    const normalized = normalizeTelegramAdminChatIds(chatIds, process.env.TELEGRAM_ADMIN_CHAT_ID || '');

    await prisma.setting.upsert({
      where: { key: TELEGRAM_ADMINS_KEY },
      update: { value: JSON.stringify(normalized) },
      create: { key: TELEGRAM_ADMINS_KEY, value: JSON.stringify(normalized) }
    });

    return res.json({ success: true, chatIds: normalized });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ في حفظ إعدادات تليجرام' });
  }
});

export default router;
