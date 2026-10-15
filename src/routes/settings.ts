import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../utils/prisma';
import { isAdmin } from '../middleware/auth';
import { normalizeTelegramAdminChatIds } from '../utils/telegram-config';
import { saveAdminChatIdsToDb } from '../utils/telegramService';
import { loadConfig, saveConfig, DEFAULT_CONFIG, CurrencyConfig, CustomPaymentMethod } from './currencies';

const router = Router();

const TELEGRAM_ADMINS_KEY = 'telegram_admin_chat_ids';

function sanitizeStr(val: any, maxLen = 500): string {
  if (typeof val !== 'string') return '';
  return val.trim().slice(0, maxLen);
}

function sanitizeBool(val: any, fallback = false): boolean {
  if (typeof val === 'boolean') return val;
  if (val === 'true' || val === 1 || val === '1') return true;
  if (val === 'false' || val === 0 || val === '0') return false;
  return fallback;
}

// GET /api/settings/telegram-admins
router.get('/telegram-admins', isAdmin, async (_req, res) => {
  try {
    const setting = await prisma.setting.findUnique({ where: { key: TELEGRAM_ADMINS_KEY } });
    let ids: string[] = [];
    if (setting) {
      try {
        const parsed = JSON.parse(setting.value);
        if (Array.isArray(parsed)) ids = parsed;
      } catch {}
    }
    if (ids.length === 0) {
      ids = normalizeTelegramAdminChatIds([], process.env.TELEGRAM_ADMIN_CHAT_ID || '');
    }
    return res.json({ success: true, chatIds: ids });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ في جلب إعدادات تليجرام' });
  }
});

// POST /api/settings/telegram-admins
router.post('/telegram-admins', isAdmin, async (req: any, res) => {
  try {
    if (req.user?.role !== 'super_admin') {
      return res.status(403).json({ error: 'صلاحية تعديل حسابات تليجرام الإدارية محصورة في المدير العام فقط' });
    }

    const { chatIds } = req.body;
    if (!Array.isArray(chatIds)) {
      return res.status(400).json({ error: 'chatIds يجب أن يكون مصفوفة' });
    }

    const normalized = await saveAdminChatIdsToDb(chatIds);

    return res.json({ success: true, chatIds: normalized });
  } catch (err) {
    return res.status(500).json({ error: 'خطأ في حفظ إعدادات تليجرام' });
  }
});

// GET /api/settings/payment-methods - Secure fetch of current payment methods and addresses
router.get('/payment-methods', isAdmin, async (_req, res) => {
  try {
    const config = await loadConfig();
    return res.json({
      success: true,
      paymentMethods: {
        bankak: config.bankak || DEFAULT_CONFIG.bankak,
        fawry: config.fawry || DEFAULT_CONFIG.fawry,
        vodafone: config.vodafone || DEFAULT_CONFIG.vodafone,
        binance: config.binance || DEFAULT_CONFIG.binance,
        cryptoBnb: config.cryptoBnb || DEFAULT_CONFIG.cryptoBnb,
        rewarble: config.rewarble || DEFAULT_CONFIG.rewarble,
        paypal: config.paypal || DEFAULT_CONFIG.paypal,
        customMethods: Array.isArray(config.customMethods) ? config.customMethods : []
      },
      updatedAt: config.updatedAt
    });
  } catch (err) {
    console.error('Error fetching payment methods settings:', err);
    return res.status(500).json({ error: 'تعذر تحميل إعدادات طرق الدفع' });
  }
});

// POST /api/settings/payment-methods - Secure update and persistence of payment methods and addresses
router.post('/payment-methods', isAdmin, async (req: any, res) => {
  try {
    const { currentPassword, paymentMethods } = req.body;

    if (currentPassword) {
      const adminUser = await prisma.user.findUnique({ where: { id: req.user.id } });
      if (!adminUser) {
        return res.status(401).json({ error: 'المستخدم غير موجود' });
      }
      const isMatch = await bcrypt.compare(currentPassword, adminUser.password);
      if (!isMatch) {
        return res.status(400).json({ error: 'كلمة المرور الحالية غير صحيحة' });
      }
    }

    const payload = paymentMethods || req.body;
    if (!payload || typeof payload !== 'object') {
      return res.status(400).json({ error: 'بيانات طرق الدفع غير صالحة' });
    }

    const current = await loadConfig();

    const sanitizedBankak = payload.bankak ? {
      nameAr: sanitizeStr(payload.bankak.nameAr, 100) || current.bankak?.nameAr || DEFAULT_CONFIG.bankak.nameAr,
      nameEn: sanitizeStr(payload.bankak.nameEn, 100) || current.bankak?.nameEn || DEFAULT_CONFIG.bankak.nameEn,
      accountNumber: sanitizeStr(payload.bankak.accountNumber, 100),
      accountName: sanitizeStr(payload.bankak.accountName, 150),
      instructionsAr: sanitizeStr(payload.bankak.instructionsAr, 1000),
      instructionsEn: sanitizeStr(payload.bankak.instructionsEn, 1000),
      isActive: sanitizeBool(payload.bankak.isActive, current.bankak?.isActive ?? true)
    } : current.bankak;

    const sanitizedFawry = payload.fawry ? {
      nameAr: sanitizeStr(payload.fawry.nameAr, 100) || current.fawry?.nameAr || DEFAULT_CONFIG.fawry?.nameAr,
      nameEn: sanitizeStr(payload.fawry.nameEn, 100) || current.fawry?.nameEn || DEFAULT_CONFIG.fawry?.nameEn,
      accountNumber: sanitizeStr(payload.fawry.accountNumber, 100),
      accountName: sanitizeStr(payload.fawry.accountName, 150),
      instructionsAr: sanitizeStr(payload.fawry.instructionsAr, 1000),
      instructionsEn: sanitizeStr(payload.fawry.instructionsEn, 1000),
      isActive: sanitizeBool(payload.fawry.isActive, current.fawry?.isActive ?? true)
    } : (current.fawry || DEFAULT_CONFIG.fawry);

    const sanitizedVodafone = payload.vodafone ? {
      nameAr: sanitizeStr(payload.vodafone.nameAr, 100) || current.vodafone?.nameAr || DEFAULT_CONFIG.vodafone.nameAr,
      nameEn: sanitizeStr(payload.vodafone.nameEn, 100) || current.vodafone?.nameEn || DEFAULT_CONFIG.vodafone.nameEn,
      walletNumber: sanitizeStr(payload.vodafone.walletNumber, 50),
      instructionsAr: sanitizeStr(payload.vodafone.instructionsAr, 1000),
      instructionsEn: sanitizeStr(payload.vodafone.instructionsEn, 1000),
      isActive: sanitizeBool(payload.vodafone.isActive, current.vodafone?.isActive ?? true)
    } : current.vodafone;

    const sanitizedBinance = payload.binance ? {
      nameAr: sanitizeStr(payload.binance.nameAr, 100) || current.binance?.nameAr || DEFAULT_CONFIG.binance.nameAr,
      nameEn: sanitizeStr(payload.binance.nameEn, 100) || current.binance?.nameEn || DEFAULT_CONFIG.binance.nameEn,
      payId: sanitizeStr(payload.binance.payId, 100),
      instructionsAr: sanitizeStr(payload.binance.instructionsAr, 1000),
      instructionsEn: sanitizeStr(payload.binance.instructionsEn, 1000),
      isActive: sanitizeBool(payload.binance.isActive, current.binance?.isActive ?? true)
    } : current.binance;

    const sanitizedCryptoBnb = payload.cryptoBnb ? {
      nameAr: sanitizeStr(payload.cryptoBnb.nameAr, 100) || current.cryptoBnb?.nameAr || DEFAULT_CONFIG.cryptoBnb.nameAr,
      nameEn: sanitizeStr(payload.cryptoBnb.nameEn, 100) || current.cryptoBnb?.nameEn || DEFAULT_CONFIG.cryptoBnb.nameEn,
      address: sanitizeStr(payload.cryptoBnb.address, 150),
      network: sanitizeStr(payload.cryptoBnb.network, 100) || 'BNB Smart Chain (BEP20)',
      transferName: sanitizeStr(payload.cryptoBnb.transferName, 50) || 'BNB',
      instructionsAr: sanitizeStr(payload.cryptoBnb.instructionsAr, 1000),
      instructionsEn: sanitizeStr(payload.cryptoBnb.instructionsEn, 1000),
      isActive: sanitizeBool(payload.cryptoBnb.isActive, current.cryptoBnb?.isActive ?? true)
    } : current.cryptoBnb;

    const sanitizedRewarble = payload.rewarble ? {
      nameAr: sanitizeStr(payload.rewarble.nameAr, 100) || current.rewarble?.nameAr || DEFAULT_CONFIG.rewarble?.nameAr,
      nameEn: sanitizeStr(payload.rewarble.nameEn, 100) || current.rewarble?.nameEn || DEFAULT_CONFIG.rewarble?.nameEn,
      address: sanitizeStr(payload.rewarble.address, 150),
      transferName: sanitizeStr(payload.rewarble.transferName, 50) || 'BNB',
      instructionsAr: sanitizeStr(payload.rewarble.instructionsAr, 1000),
      instructionsEn: sanitizeStr(payload.rewarble.instructionsEn, 1000),
      isActive: sanitizeBool(payload.rewarble.isActive, current.rewarble?.isActive ?? true)
    } : (current.rewarble || DEFAULT_CONFIG.rewarble);

    let sanitizedPaypalEmail = sanitizeStr(payload.paypal?.email, 150);
    if (sanitizedPaypalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(sanitizedPaypalEmail)) {
      return res.status(400).json({ error: 'بريد PayPal الإلكتروني غير صالح' });
    }
    const sanitizedPaypal = payload.paypal ? {
      nameAr: sanitizeStr(payload.paypal.nameAr, 100) || current.paypal?.nameAr || DEFAULT_CONFIG.paypal.nameAr,
      nameEn: sanitizeStr(payload.paypal.nameEn, 100) || current.paypal?.nameEn || DEFAULT_CONFIG.paypal.nameEn,
      email: sanitizedPaypalEmail || current.paypal?.email || 'paypal@gsmteam.com',
      isActive: sanitizeBool(payload.paypal.isActive, current.paypal?.isActive ?? true)
    } : current.paypal;

    let sanitizedCustomMethods: CustomPaymentMethod[] = current.customMethods || [];
    if (payload.customMethods !== undefined) {
      if (!Array.isArray(payload.customMethods)) {
        return res.status(400).json({ error: 'طرق الدفع المخصصة يجب أن تكون مصفوفة' });
      }
      sanitizedCustomMethods = payload.customMethods
        .filter((item: any) => item && typeof item === 'object')
        .map((item: any, idx: number) => ({
          id: sanitizeStr(item.id, 50) || `custom_${Date.now()}_${idx}`,
          nameAr: sanitizeStr(item.nameAr, 100),
          nameEn: sanitizeStr(item.nameEn, 100) || undefined,
          type: sanitizeStr(item.type, 50) || 'other',
          accountOrAddress: sanitizeStr(item.accountOrAddress, 200),
          network: sanitizeStr(item.network, 100) || undefined,
          transferName: sanitizeStr(item.transferName, 50) || undefined,
          instructionsAr: sanitizeStr(item.instructionsAr, 1000) || undefined,
          instructionsEn: sanitizeStr(item.instructionsEn, 1000) || undefined,
          isActive: sanitizeBool(item.isActive, true)
        }))
        .filter((item: CustomPaymentMethod) => item.nameAr && item.accountOrAddress);
    }

    const updatedConfig: CurrencyConfig = {
      ...current,
      bankak: sanitizedBankak,
      fawry: sanitizedFawry,
      vodafone: sanitizedVodafone,
      binance: sanitizedBinance,
      cryptoBnb: sanitizedCryptoBnb,
      rewarble: sanitizedRewarble,
      paypal: sanitizedPaypal,
      customMethods: sanitizedCustomMethods,
      updatedAt: new Date().toISOString()
    };

    const persisted = await saveConfig(updatedConfig);
    if (!persisted) {
      return res.status(500).json({ error: 'تعذر حفظ الإعدادات في قاعدة البيانات' });
    }

    return res.json({
      success: true,
      message: 'تم حفظ وتحديث طرق الدفع والعناوين في قاعدة البيانات بنجاح',
      paymentMethods: {
        bankak: updatedConfig.bankak,
        fawry: updatedConfig.fawry,
        vodafone: updatedConfig.vodafone,
        binance: updatedConfig.binance,
        cryptoBnb: updatedConfig.cryptoBnb,
        rewarble: updatedConfig.rewarble,
        paypal: updatedConfig.paypal,
        customMethods: updatedConfig.customMethods
      },
      updatedAt: updatedConfig.updatedAt
    });
  } catch (err: any) {
    console.error('Error saving payment methods:', err);
    return res.status(500).json({ error: 'حدث خطأ غير متوقع أثناء حفظ طرق الدفع' });
  }
});

export default router;
