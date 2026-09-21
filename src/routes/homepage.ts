import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { isAdmin } from '../middleware/auth';
import { prisma } from '../utils/prisma';

const router = Router();
const CONFIG_FILE = path.join(__dirname, '../../data/homepage_config.json');

const defaultConfig = {
  noticeBar: {
    text1En: "Instant automated 24/7 delivery for IMEI & server services",
    text1Ar: "تسليم فوري وتلقائي لمعظم خدمات الـ IMEI والسيرفر على مدار 24/7",
    text2En: "100% Secure checkout + instant wallet funding & refund protection",
    text2Ar: "دفع آمن 100% + شحن فوري للمحفظة مع ضمان استرجاع الرصيد",
    whatsapp: "+16728972935",
    telegram: "@ARABTECHSUPPURT2",
    email: "arabtechserver@gmail.com"
  },
  heroSection: {
    liveTagEn: "All-in-One Platform for GSM Services",
    liveTagAr: "منصة متكاملة لخدمات الـ GSM",
    eyebrowEn: "Built for GSM professionals",
    eyebrowAr: "مصممة خصيصاً لمحترفي الـ GSM",
    title1En: "Everything You Need to Manage",
    title1Ar: "كل ما تحتاجه لإدارة",
    title2En: "Your GSM Business",
    title2Ar: "أعمال الـ GSM",
    leadEn: "Reliable Services ... Powerful Tools ... Continuous Support\nBecause your success is our mission",
    leadAr: "خدمات موثوقة ... أدوات قوية ... دعم دائم\nلأن نجاحك هو هدفنا",
    btnBrowseEn: "Explore All Services",
    btnBrowseAr: "عرض كافة الخدمات",
    btnBrowseUrl: "/pricing",
    btnJoinEn: "Join Free Network",
    btnJoinAr: "انضم للشبكة مجاناً",
    btnJoinUrl: "/register",
    badge1En: "+100K Orders",
    badge1Ar: "+100K طلب منجز",
    badge2En: "99.9% Success",
    badge2Ar: "99.9% نسبة النجاح",
    badge3En: "+1500 Models",
    badge3Ar: "+1500 طراز مدعوم",
    heroImage: "/images/hero_phone_mockup.jpg"
  },
  sidebarPromos: {
    featuredTitleEn: "Borneo Schematics",
    featuredTitleAr: "مخططات بورنيو الرسمية",
    featuredSubtitleEn: "Official reseller promotion",
    featuredSubtitleAr: "تفعيل فوري بأفضل الأسعار",
    featuredImage: "/images/promo_borneo.webp",
    featuredUrl: "/pricing",
    supportTitleEn: "Need a fast answer?",
    supportTitleAr: "هل تحتاج إجابة سريعة؟",
    supportBtnEn: "Chat with GSM Team",
    supportBtnAr: "تحدث مع الدعم الفني",
    whatsappUrl: "https://api.whatsapp.com/send/?phone=16728972935&text&type=phone_number&app_absent=0"
  },
  serviceLanes: {
    imeiTitleEn: "IMEI Services",
    imeiTitleAr: "خدمات IMEI وفك الشبكات",
    imeiDescEn: "Network Unlock - IMEI Repair - All Global Brands",
    imeiDescAr: "فك الشبكات - إصلاح IMEI - فك أجهزة - جميع الماركات",
    imeiUrl: "/pricing?cat=imei",
    serverTitleEn: "Server Services",
    serverTitleAr: "خدمات السيرفرات والأرصدة والتراخيص",
    serverDescEn: "Server activations & credits at competitive prices",
    serverDescAr: "تفعيل السيرفرات المختلفة بأسعار منافسة",
    serverUrl: "/pricing?cat=server",
    remoteTitleEn: "Remote Services",
    remoteTitleAr: "خدمات التحكم عن بعد",
    remoteDescEn: "Fast & secure remote technical support by specialists",
    remoteDescAr: "حلول فنية سريعة وآمنة بواسطة فريق متخصص",
    remoteUrl: "/pricing?cat=remote",
    storeTitleEn: "Tools & Store",
    storeTitleAr: "الأدوات والمتجر وباقات المحترفين",
    storeDescEn: "Exclusive professional software tools and bundles",
    storeDescAr: "أدوات مميزة وباقات حصرية للمحترفين",
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
  campaigns: [
    {
      tagEn: "Limited Time Offer",
      tagAr: "عرض حصري لفترة محدودة",
      titleEn: "Samsung FRP Remove",
      titleAr: "حذف حساب سامسونج FRP الفوري",
      descEn: "Instant removal for all Samsung models via direct official server API.",
      descAr: "فك فوري وتلقائي لجميع طرازات سامسونج عبر السيرفر الرسمي بأعلى سرعة وأمان.",
      badgeEn: "Direct API Link",
      badgeAr: "ربط سيرفر مباشر",
      turnaroundEn: "1 - 5 Mins",
      turnaroundAr: "1 - 5 دقائق",
      guaranteeEn: "100% REFUND",
      guaranteeAr: "ضمان مالي 100%",
      connectionEn: "DIRECT API",
      connectionAr: "ربط فوري API",
      theme: "purple",
      image: "/images/promo_samsung_clean.png",
      url: "/pricing?search=Samsung",
      buttonTextEn: "Order & Activate Now",
      buttonTextAr: "اطلب الآن وابدأ التفعيل"
    },
    {
      tagEn: "Official Reseller",
      tagAr: "موزع رسمي معتمد",
      titleEn: "Official Reseller Campaigns",
      titleAr: "عروض وحملات الموزعين الرسمية",
      descEn: "Best wholesale rates, instant activations, and full warranty on tools.",
      descAr: "أفضل أسعار الجملة المعتمدة، إصدارات جديدة، وتفعيل فوري مع ضمان كامل.",
      badgeEn: "Full Warranty",
      badgeAr: "ضمان معتمد كامل",
      turnaroundEn: "Instant Delivery",
      turnaroundAr: "تسليم فوري 24/7",
      guaranteeEn: "100% Guaranteed",
      guaranteeAr: "ضمان رسمي كامل",
      connectionEn: "AUTO SERVER",
      connectionAr: "سيرفر مؤتمت",
      theme: "cyan",
      image: "/images/promo_gift_box_clean.png",
      url: "/pricing",
      buttonTextEn: "View All Offers",
      buttonTextAr: "عرض جميع العروض"
    },
    {
      tagEn: "Best Seller Tool",
      tagAr: "الأداة الأكثر طلباً",
      titleEn: "Chimera Tool Pro",
      titleAr: "أداة شيميرا (Chimera Tool)",
      descEn: "All Brands and Samsung activations with instant server token generation.",
      descAr: "تراخيص سنوية وتعبئة أرصدة شيميرا بأسعار منافسة وتسليم فوري خلال دقيقة.",
      badgeEn: "Instant License",
      badgeAr: "ترخيص فوري مباشر",
      turnaroundEn: "Under 1 Min",
      turnaroundAr: "أقل من دقيقة",
      guaranteeEn: "100% REFUND",
      guaranteeAr: "ضمان استرجاع 100%",
      connectionEn: "GSM SERVER",
      connectionAr: "سيرفر رسمي",
      theme: "blue",
      image: "/images/promo_chimera.png",
      url: "/pricing?section=Chimera%20Tool",
      buttonTextEn: "Get Chimera License",
      buttonTextAr: "احصل على ترخيص شيميرا"
    },
    {
      tagEn: "Hardware Diagnostics",
      tagAr: "مخططات الهاردوير",
      titleEn: "Borneo Schematics",
      titleAr: "مخططات بورنيو (Borneo)",
      descEn: "Official activation codes for 1-PC and 2-PC with instant daily updates.",
      descAr: "تفعيل رسمي لمخططات بورنيو مع تحديثات يومية ودعم لجميع اللوحات الإلكترونية.",
      badgeEn: "Daily Updates",
      badgeAr: "تحديثات يومية متواصلة",
      turnaroundEn: "Instant 24/7",
      turnaroundAr: "فوري على مدار الساعة",
      guaranteeEn: "Official Code",
      guaranteeAr: "كود تفعيل أصلي",
      connectionEn: "OFFICIAL DB",
      connectionAr: "قاعدة بيانات رسمية",
      theme: "emerald",
      image: "/images/promo_borneo.png",
      url: "/pricing?search=Borneo",
      buttonTextEn: "Activate Borneo",
      buttonTextAr: "تفعيل باقة بورنيو"
    }
  ],
  featuredPackages: [
    {
      id: "chimera",
      nameAr: "Chimera Tool",
      nameEn: "Chimera Tool",
      subAr: "Activation / Credits",
      subEn: "Activation / Credits",
      badgeAr: "Best Seller",
      badgeEn: "Best Seller",
      isPopular: true,
      startingPrice: "$106.59",
      categoryAr: "Official",
      categoryEn: "Official",
      deliveryTimeAr: "فوري 24/7",
      deliveryTimeEn: "Instant 24/7",
      iconName: "build",
      image: "",
      url: "/pricing?section=Chimera%20Tool",
      featuresAr: [
        "تراخيص Chimera Basic و Samsung و All Brands Pro",
        "فك شبكات وتصليح السيريال وإصلاح IMEI وتعديل الموديل",
        "تفعيل رسمي مباشر على حساب المستخدم خلال دقيقة",
        "تحديثات متواصلة لدعم أحدث إصدارات الأندرويد"
      ],
      featuresEn: [
        "Chimera Basic, Samsung, and All Brands Pro licenses",
        "Carrier unlock, serial repair, and network patching",
        "Official 1-minute automated account activation",
        "Continuous support for latest Android security patches"
      ]
    },
    {
      id: "amt",
      nameAr: "Android Multi Tool",
      nameEn: "Android Multi Tool",
      subAr: "AMT Credits",
      subEn: "AMT Credits",
      badgeAr: "Popular",
      badgeEn: "Popular",
      isPopular: false,
      startingPrice: "$0.92",
      categoryAr: "Instant",
      categoryEn: "Instant",
      deliveryTimeAr: "فوري 24/7",
      deliveryTimeEn: "Instant 24/7",
      iconName: "bolt",
      image: "",
      url: "/pricing?section=Android%20Multi%20Tool",
      featuresAr: [
        "دعم كامل لهواتف VIVO و XIAOMI و TECNO و INFINIX",
        "عمليات FRP وتخطي حسابات وحذف الديمو (Demo Removal)",
        "شحن فوري بالكريدت مباشرة إلى اسم المستخدم لحسابك",
        "لا يحتاج إلى بوكس أو دونجل خارجي للعمل"
      ],
      featuresEn: [
        "Full support for Vivo, Xiaomi, Tecno & Infinix",
        "One-click FRP bypass, factory reset, and demo removal",
        "Instant credit top-up directly to your username",
        "No hardware box or dongle required to run"
      ]
    },
    {
      id: "xiaomi",
      nameAr: "Xiaomi Remove Account",
      nameEn: "Xiaomi Remove Account",
      subAr: "",
      subEn: "",
      badgeAr: "Official",
      badgeEn: "Official",
      isPopular: false,
      startingPrice: "$3.41",
      categoryAr: "Fast Service",
      categoryEn: "Fast Service",
      deliveryTimeAr: "1 - 12 ساعة",
      deliveryTimeEn: "1 - 12 Hours",
      iconName: "smartphone",
      image: "",
      url: "/pricing?section=Xiaomi%20Remove%20Account",
      featuresAr: [
        "حذف دائم ونظيف من سيرفر شاومي الرسمي (Clean IMEI)",
        "دعم الأجهزة من جميع دول العالم (Worldwide Support)",
        "إمكانية إعادة ضبط المصنع والتحديث بعد الحذف بأمان",
        "تنفيذ تلقائي عبر الـ API مع استرجاع الرصيد في حال الرفض"
      ],
      featuresEn: [
        "Permanent clean removal from official Xiaomi servers",
        "Worldwide device support across all regions",
        "Safe factory reset and OTA updates after completion",
        "Automated API execution with full refund protection"
      ]
    }
  ],
  supportedTools: [
    { id: "chimera", name: "Chimera", url: "/pricing?search=Chimera", image: "/images/tools/tool_chimera.png" },
    { id: "unlocktool", name: "UnlockTool", url: "/pricing?search=UnlockTool", image: "/images/tools/tool_unlocktool.png" },
    { id: "borneo", name: "Borneo", url: "/pricing?search=Borneo", image: "/images/tools/tool_borneo.png" },
    { id: "iremoval", name: "iRemoval Pro", url: "/pricing?search=iRemoval%20Pro", image: "/images/tools/tool_iremoval.png" },
    { id: "dft", name: "DFT Pro", url: "/pricing?search=DFT%20Pro", image: "/images/tools/tool_dft.png" },
    { id: "mobilesea", name: "MobileSea Tool", url: "/pricing?search=MobileSea%20Tool", image: "/images/tools/tool_mobilesea.png" },
    { id: "amt", name: "AMT", url: "/pricing?search=AMT", image: "/images/tools/tool_amt.png" },
    { id: "phoenix", name: "Phoenix", url: "/pricing?search=Phoenix", image: "/images/tools/tool_phoenix.png" },
    { id: "cheetah", name: "Cheetah", url: "/pricing?search=Cheetah", image: "/images/tools/tool_cheetah.png" },
    { id: "fkey", name: "FKey", url: "/pricing?search=FKey", image: "/images/tools/tool_fkey.png" }
  ]
};

function ensureDirectoryExistence(filePath: string) {
  const dirname = path.dirname(filePath);
  if (fs.existsSync(dirname)) {
    return true;
  }
  ensureDirectoryExistence(dirname);
  fs.mkdirSync(dirname);
}

function normalizeCampaigns(c: any): any[] {
  if (Array.isArray(c) && c.length > 0) {
    return c.map((item: any, idx: number) => ({
      id: item.id || `camp_${idx + 1}`,
      tagEn: item.tagEn || "",
      tagAr: item.tagAr || "",
      titleEn: item.titleEn || "",
      titleAr: item.titleAr || "",
      descEn: item.descEn || "",
      descAr: item.descAr || "",
      badgeEn: item.badgeEn || "",
      badgeAr: item.badgeAr || "",
      turnaroundEn: item.turnaroundEn || "",
      turnaroundAr: item.turnaroundAr || "",
      guaranteeEn: item.guaranteeEn || "",
      guaranteeAr: item.guaranteeAr || "",
      connectionEn: item.connectionEn || "",
      connectionAr: item.connectionAr || "",
      theme: item.theme || "purple",
      image: item.image || "",
      url: item.url || "/pricing",
      buttonTextEn: item.buttonTextEn || "",
      buttonTextAr: item.buttonTextAr || ""
    }));
  }
  if (c && typeof c === "object") {
    const list: any[] = [];
    if (c.promo1TitleAr || c.promo1Image || c.promo1TitleEn) {
      list.push({
        tagEn: c.promo1TagEn || "Limited Time Offer",
        tagAr: c.promo1TagAr || "عرض حصري",
        titleEn: c.promo1TitleEn || "Samsung FRP Remove",
        titleAr: c.promo1TitleAr || "حذف حساب سامسونج FRP",
        descEn: c.promo1DescEn || "",
        descAr: c.promo1DescAr || "",
        badgeEn: "Direct API",
        badgeAr: "ربط مباشر",
        turnaroundEn: "1 - 5 Mins",
        turnaroundAr: "1 - 5 دقائق",
        guaranteeEn: "100% REFUND",
        guaranteeAr: "ضمان 100%",
        connectionEn: "DIRECT API",
        connectionAr: "ربط فوري",
        theme: "purple",
        image: c.promo1Image || "/images/promo_samsung_clean.png",
        url: c.promo1Url || "/pricing"
      });
    }
    if (c.promo2TitleAr || c.promo2Image || c.promo2TitleEn) {
      list.push({
        tagEn: c.promo2TagEn || "Official Reseller",
        tagAr: c.promo2TagAr || "موزع رسمي معتمد",
        titleEn: c.promo2TitleEn || "Official Reseller Campaigns",
        titleAr: c.promo2TitleAr || "عروض وحملات الموزعين الرسمية",
        descEn: c.promo2DescEn || "",
        descAr: c.promo2DescAr || "",
        badgeEn: "Full Warranty",
        badgeAr: "ضمان كامل",
        turnaroundEn: "Instant",
        turnaroundAr: "تسليم فوري",
        guaranteeEn: "100% Guaranteed",
        guaranteeAr: "ضمان رسمي",
        connectionEn: "AUTO SERVER",
        connectionAr: "سيرفر مؤتمت",
        theme: "cyan",
        image: c.promo2Image || "/images/promo_gift_box_clean.png",
        url: c.promo2Url || "/pricing"
      });
    }
    if (list.length > 0) return list;
  }
  return defaultConfig.campaigns;
}

function normalizeFeaturedPackages(pkgs: any): any[] {
  if (Array.isArray(pkgs) && pkgs.length > 0) {
    return pkgs.map((p: any, idx: number) => ({
      id: p.id || `pkg_${idx + 1}`,
      nameAr: p.nameAr || "",
      nameEn: p.nameEn || "",
      subAr: p.subAr || "",
      subEn: p.subEn || "",
      badgeAr: p.badgeAr || "",
      badgeEn: p.badgeEn || "",
      isPopular: Boolean(p.isPopular),
      startingPrice: p.startingPrice || "",
      categoryAr: p.categoryAr || "",
      categoryEn: p.categoryEn || "",
      deliveryTimeAr: p.deliveryTimeAr || "",
      deliveryTimeEn: p.deliveryTimeEn || "",
      iconName: p.iconName || "inventory_2",
      image: p.image || "",
      url: p.url || "/pricing",
      featuresAr: Array.isArray(p.featuresAr) ? p.featuresAr : [],
      featuresEn: Array.isArray(p.featuresEn) ? p.featuresEn : []
    }));
  }
  return defaultConfig.featuredPackages;
}

function normalizeSupportedTools(tools: any): any[] {
  if (Array.isArray(tools) && tools.length > 0) {
    return tools.map((t: any, idx: number) => ({
      id: t.id || `tool_${idx + 1}`,
      name: t.name || "",
      url: t.url || (t.name ? `/pricing?search=${encodeURIComponent(t.name)}` : "/pricing"),
      image: t.image || ""
    }));
  }
  return defaultConfig.supportedTools;
}

async function loadConfig() {
  try {
    const dbSetting = await prisma.setting.findUnique({ where: { key: 'homepage_config' } });
    if (dbSetting?.value) {
      const parsed = JSON.parse(dbSetting.value);
      const merged = { ...defaultConfig, ...parsed };
      merged.campaigns = normalizeCampaigns(parsed.campaigns !== undefined ? parsed.campaigns : defaultConfig.campaigns);
      merged.featuredPackages = normalizeFeaturedPackages(parsed.featuredPackages !== undefined ? parsed.featuredPackages : defaultConfig.featuredPackages);
      merged.supportedTools = normalizeSupportedTools(parsed.supportedTools !== undefined ? parsed.supportedTools : defaultConfig.supportedTools);
      return merged;
    }
  } catch (dbErr) {
    console.warn("Could not read homepage config from DB, falling back to file:", dbErr);
  }

  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = fs.readFileSync(CONFIG_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      const merged = { ...defaultConfig, ...parsed };
      merged.campaigns = normalizeCampaigns(parsed.campaigns !== undefined ? parsed.campaigns : defaultConfig.campaigns);
      merged.featuredPackages = normalizeFeaturedPackages(parsed.featuredPackages !== undefined ? parsed.featuredPackages : defaultConfig.featuredPackages);
      merged.supportedTools = normalizeSupportedTools(parsed.supportedTools !== undefined ? parsed.supportedTools : defaultConfig.supportedTools);
      return merged;
    }
  } catch (err) {
    console.error("Error reading homepage config from file:", err);
  }
  return defaultConfig;
}

async function saveConfig(config: any) {
  if (config && config.campaigns !== undefined) {
    config.campaigns = normalizeCampaigns(config.campaigns);
  }
  if (config && config.featuredPackages !== undefined) {
    config.featuredPackages = normalizeFeaturedPackages(config.featuredPackages);
  }
  if (config && config.supportedTools !== undefined) {
    config.supportedTools = normalizeSupportedTools(config.supportedTools);
  }
  const serialized = JSON.stringify(config, null, 2);

  // 1. Save to Backend File
  try {
    ensureDirectoryExistence(CONFIG_FILE);
    fs.writeFileSync(CONFIG_FILE, serialized, 'utf-8');
  } catch (fileErr) {
    console.error("Error writing homepage config to file:", fileErr);
  }

  // 2. Sync to Frontend File if accessible
  try {
    const frontendConfigFile = path.join(__dirname, '../../../frontend/src/data/homepage_config.json');
    if (fs.existsSync(path.dirname(frontendConfigFile))) {
      fs.writeFileSync(frontendConfigFile, serialized, 'utf-8');
    }
  } catch (feErr) {
    // Non-fatal if frontend directory is elsewhere
  }

  // 3. Save to DB Setting for permanent persistence
  try {
    await prisma.setting.upsert({
      where: { key: 'homepage_config' },
      update: { value: serialized },
      create: { key: 'homepage_config', value: serialized },
    });
  } catch (dbErr) {
    console.error("Error saving homepage config to DB:", dbErr);
  }
}

// GET homepage config
router.get('/', async (req, res) => {
  const config = await loadConfig();
  res.json(config);
});

// POST update homepage config
router.post('/', isAdmin, async (req, res) => {
  try {
    const updatedConfig = req.body;
    await saveConfig(updatedConfig);
    res.json({ success: true, message: "تم تحديث محتوى الصفحة الرئيسية بنجاح!", config: updatedConfig });
  } catch (error) {
    console.error("Failed to save homepage config:", error);
    res.status(500).json({ error: "فشل حفظ إعدادات الصفحة الرئيسية" });
  }
});

export default router;
