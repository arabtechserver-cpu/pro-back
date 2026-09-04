import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '../middleware/auth';
import { prisma } from '../utils/prisma';

const router = Router();
const DATA_FILE = path.join(__dirname, '../data/currencies.json');

export interface CurrencyConfig {
  usdToSdg: number; // Sudanese Pound rate per 1 USD
  usdToEgp: number; // Egyptian Pound rate per 1 USD
  usdToSar: number; // Saudi Riyal rate per 1 USD
  usdToAed: number; // UAE Dirham rate per 1 USD
  bankak: {
    accountNumber: string;
    accountName: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  vodafone: {
    walletNumber: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  binance: {
    payId: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  cryptoBnb: {
    address: string;
    network: string;
    instructionsAr: string;
    instructionsEn: string;
    isActive: boolean;
  };
  paypal: {
    email: string;
    isActive: boolean;
  };
  updatedAt?: string;
}

const DEFAULT_CONFIG: CurrencyConfig = {
  usdToSdg: 2850,
  usdToEgp: 50.0,
  usdToSar: 3.75,
  usdToAed: 3.67,
  bankak: {
    accountNumber: "6302273",
    accountName: "حسن",
    instructionsAr: "حول المبلغ بالجنيه السوداني عبر تطبيق بنكك إلى رقم الحساب ثم ارفع صورة إشعار التحويل للتأكيد الفوري.",
    instructionsEn: "Transfer in Sudanese Pounds via Bankak app then upload the transfer receipt image.",
    isActive: true
  },
  vodafone: {
    walletNumber: "01097160605",
    instructionsAr: "حول المبلغ إلى رقم المحفظة واكتب الرقم المحول منه وارفق صورة رسالة أو إيصال التحويل.",
    instructionsEn: "Transfer funds to wallet number then attach receipt screenshot.",
    isActive: true
  },
  binance: {
    payId: "894642115",
    instructionsAr: "افتح تطبيق باينانس واكتب معرف Binance Pay ID ثم ارفق لقطة الشاشة للتأكيد.",
    instructionsEn: "Open Binance App and send funds via Pay ID then attach payment screenshot.",
    isActive: true
  },
  cryptoBnb: {
    address: "0xaCc3ab6f0165B39Cf2F1286ED8A778735Ae8314f",
    network: "BNB Smart Chain (BEP20)",
    instructionsAr: "تأكد من اختيار شبكة (BNB Smart Chain - BEP20) ثم ارفع صورة إثبات المعاملة من باينانس أو Trust Wallet.",
    instructionsEn: "Ensure network selected is BNB Smart Chain (BEP20) then upload transaction receipt screenshot.",
    isActive: true
  },
  paypal: {
    email: "paypal@gsmteam.com",
    isActive: true
  }
};

function readConfigFile(): CurrencyConfig {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    }
    if (fs.existsSync(DATA_FILE)) {
      const data = fs.readFileSync(DATA_FILE, 'utf-8');
      return { ...DEFAULT_CONFIG, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error('Failed to read currencies config file:', err);
  }
  return DEFAULT_CONFIG;
}

function writeConfigFile(config: CurrencyConfig): boolean {
  try {
    if (!fs.existsSync(path.dirname(DATA_FILE))) {
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(config, null, 2), 'utf-8');
    return true;
  } catch (err) {
    console.error('Failed to write currencies config file:', err);
    return false;
  }
}

// Load config from Database (Setting table) with fallback to file
async function loadConfig(): Promise<CurrencyConfig> {
  try {
    const record = await prisma.setting.findUnique({
      where: { key: 'currencies_config' }
    });
    if (record && record.value) {
      const parsed = JSON.parse(record.value);
      return { ...DEFAULT_CONFIG, ...parsed };
    }
  } catch (err) {
    console.warn('Could not read currencies from Setting table, falling back to local file:', err);
  }
  return readConfigFile();
}

// Save config to Database (Setting table) and local file as backup
async function saveConfig(config: CurrencyConfig): Promise<boolean> {
  writeConfigFile(config);
  try {
    await prisma.setting.upsert({
      where: { key: 'currencies_config' },
      update: { value: JSON.stringify(config) },
      create: { key: 'currencies_config', value: JSON.stringify(config) }
    });
    return true;
  } catch (err) {
    console.error('Failed to persist currencies in database:', err);
    return false;
  }
}

// GET /api/currencies - Public & Authenticated endpoint to get current exchange rates & bank details
router.get('/', async (req, res) => {
  const config = await loadConfig();
  res.json({ success: true, config });
});

// POST /api/currencies - Admin endpoint to update currency rates and payment settings
router.post('/', isAdmin, async (req, res) => {
  try {
    const current = await loadConfig();
    const {
      usdToSdg,
      usdToEgp,
      usdToSar,
      usdToAed,
      bankak,
      vodafone,
      binance,
      cryptoBnb,
      paypal
    } = req.body;

    const updatedConfig: CurrencyConfig = {
      usdToSdg: usdToSdg !== undefined ? Number(usdToSdg) : current.usdToSdg,
      usdToEgp: usdToEgp !== undefined ? Number(usdToEgp) : current.usdToEgp,
      usdToSar: usdToSar !== undefined ? Number(usdToSar) : current.usdToSar,
      usdToAed: usdToAed !== undefined ? Number(usdToAed) : current.usdToAed,
      bankak: bankak ? { ...current.bankak, ...bankak } : current.bankak,
      vodafone: vodafone ? { ...current.vodafone, ...vodafone } : current.vodafone,
      binance: binance ? { ...current.binance, ...binance } : current.binance,
      cryptoBnb: cryptoBnb ? { ...current.cryptoBnb, ...cryptoBnb } : current.cryptoBnb,
      paypal: paypal ? { ...current.paypal, ...paypal } : current.paypal,
      updatedAt: new Date().toISOString()
    };

    await saveConfig(updatedConfig);

    return res.json({
      success: true,
      message: 'تم حفظ وتثبيت أسعار الصرف وبيانات الحسابات في قاعدة البيانات بنجاح!',
      config: updatedConfig
    });
  } catch (error: any) {
    console.error('Error updating currency config:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء حفظ الإعدادات في قاعدة البيانات' });
  }
});

export default router;
