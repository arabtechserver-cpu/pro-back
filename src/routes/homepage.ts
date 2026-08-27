import { Router } from 'express';
import fs from 'fs';
import path from 'path';

const router = Router();
const CONFIG_FILE = path.join(__dirname, '../../data/homepage_config.json');

const defaultConfig = {
  noticeBar: {
    text1En: "Instant delivery on most services",
    text1Ar: "تسليم فوري لمعظم الخدمات",
    text2En: "Secure checkout + trusted support",
    text2Ar: "دفع آمن + دعم موثوق على مدار الساعة",
    whatsapp: "+16728972935",
    telegram: "@ARABTECHSUPPURT2",
    email: "eslamgsm1774@gmail.com"
  },
  heroSection: {
    liveTagEn: "Live service portal",
    liveTagAr: "البوابة المباشرة للخدمات",
    eyebrowEn: "Built for GSM professionals",
    eyebrowAr: "مصممة خصيصاً لمحترفي الـ GSM",
    title1En: "The complete",
    title1Ar: "كل ما تحتاجه",
    title2En: "GSM service portal.",
    title2Ar: "لإدارة أعمال الـ GSM",
    leadEn: "Unlock, activate, fund, and track every GSM job from one verified workspace.",
    leadAr: "افتح، تجاوز، وقم بتفعيل الخدمات فوراً مع منصتنا المؤتمتة عبر الـ API.",
    btnBrowseEn: "Browse services",
    btnBrowseAr: "عرض كافة الخدمات",
    btnBrowseUrl: "/pricing",
    btnJoinEn: "Join free",
    btnJoinAr: "انضم للشبكة مجاناً",
    btnJoinUrl: "/register",
    badge1En: "Clear ETAs",
    badge1Ar: "وقت تسليم حقيقي",
    badge2En: "Secure checkout",
    badge2Ar: "مدفوعات آمنة",
    badge3En: "Direct support",
    badge3Ar: "دعم على مدار الساعة",
    heroImage: "/images/promo_hero.png"
  },
  sidebarPromos: {
    featuredTitleEn: "Borneo Schematics",
    featuredTitleAr: "مخططات بورنيو الرسمية",
    featuredSubtitleEn: "Official reseller promotion",
    featuredSubtitleAr: "تفعيل فوري بأفضل الأسعار",
    featuredImage: "/images/promo_borneo.png",
    featuredUrl: "/pricing",
    supportTitleEn: "Need a fast answer?",
    supportTitleAr: "هل تحتاج إجابة سريعة؟",
    supportBtnEn: "Chat with GSM Team",
    supportBtnAr: "تحدث مع الدعم الفني",
    whatsappUrl: "https://api.whatsapp.com/send/?phone=16728972935&text&type=phone_number&app_absent=0"
  },
  serviceLanes: {
    imeiTitleEn: "IMEI Services",
    imeiTitleAr: "خدمات الـ IMEI",
    imeiDescEn: "Unlocks, checks, and device services",
    imeiDescAr: "فك شفرات، تقارير فحص، وخدمات الأجهزة",
    imeiUrl: "/pricing?cat=imei",
    serverTitleEn: "Server Services",
    serverTitleAr: "خدمات السيرفرات",
    serverDescEn: "Credits, activations, and tools",
    serverDescAr: "أرصدة، تفعيلات، وتراخيص البرامج",
    serverUrl: "/pricing?cat=server",
    remoteTitleEn: "Remote Services",
    remoteTitleAr: "خدمات التحكم عن بعد",
    remoteDescEn: "Assisted sessions and support",
    remoteDescAr: "جلسات صيانة وتفعيل موجهة",
    remoteUrl: "/pricing?cat=remote",
    storeTitleEn: "Tools & Store",
    storeTitleAr: "الأدوات والمتجر",
    storeDescEn: "Licenses, products, and bundles",
    storeDescAr: "منتجات رقمية وباقات محترفين",
    storeUrl: "/pricing?cat=store"
  },
  toolMarquee: [
    "Chimera", "UnlockTool", "Borneo", "iRemoval Pro", "DFT Pro", "MobileSea Tool", "AMT", "Phoenix", "Cheetah", "FKey"
  ],
  featureRibbon: {
    feat1TitleEn: "Official distributor",
    feat1TitleAr: "موزع رسمي معتمد",
    feat1DescEn: "Global tool access with reseller-ready bundles and transparent SLAs.",
    feat1DescAr: "وصول مباشر لأهم أدوات السوفت وير العالمية وباقات الجملة.",
    feat2TitleEn: "Secure payments",
    feat2TitleAr: "مدفوعات آمنة 100%",
    feat2DescEn: "Multiple gateways, wallet topups, and receipts for every transaction.",
    feat2DescAr: "وسائل دفع متعددة وشحن فوري للمحفظة الرقمية.",
    feat3TitleEn: "Priority support",
    feat3TitleAr: "دعم مخصص ذو أولوية",
    feat3DescEn: "Live chat and Telegram admin with priority lanes for resellers.",
    feat3DescAr: "فريق دعم بشري متواجد على التيليجرام والواتساب لمساعدتك."
  },
  campaigns: {
    promo1TagEn: "Hot Offer",
    promo1TagAr: "عرض خاص",
    promo1TitleEn: "Samsung FRP Remove",
    promo1TitleAr: "حذف حساب جوجل لسامسونج",
    promo1DescEn: "Instant via IMEI. Support all models.",
    promo1DescAr: "فك فوري لجميع موديلات سامسونج.",
    promo1Image: "/images/promo_samsung.png",
    promo1Url: "/pricing",
    
    promo2TagEn: "Official Reseller",
    promo2TagAr: "ترخيص رسمي",
    promo2TitleEn: "Chimera Tool",
    promo2TitleAr: "أداة شيميراChimera",
    promo2DescEn: "Activations and credits available instantly.",
    promo2DescAr: "تراخيص وأرصدة سريعة ومتاحة فوراً.",
    promo2Image: "/images/promo_chimera.png",
    promo2Url: "/pricing"
  }
};

function ensureDirectoryExistence(filePath: string) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      return { ...defaultConfig, ...JSON.parse(data) };
    }
  } catch (err) {
    console.error("Error reading homepage config:", err);
  }
  return defaultConfig;
}

function saveConfig(config: any) {
  ensureDirectoryExistence(CONFIG_FILE);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
}

// GET homepage config
router.get('/', (req, res) => {
  const config = loadConfig();
  res.json(config);
});

// POST update homepage config
router.post('/', (req, res) => {
  try {
    const updatedConfig = req.body;
    saveConfig(updatedConfig);
    res.json({ success: true, message: "تم تحديث محتوى الصفحة الرئيسية بنجاح!", config: updatedConfig });
  } catch (error) {
    res.status(500).json({ error: "فشل حفظ إعدادات الصفحة الرئيسية" });
  }
});

export default router;
