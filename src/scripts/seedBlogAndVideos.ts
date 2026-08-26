import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const articles = [
  {
    titleEn: "Complete Guide to iPhone FMI OFF & iCloud Removal 2026",
    titleAr: "الدليل الشامل لفك شفرات وتخطي حسابات iCloud لجميع هواتف الآيفون 2026",
    excerptEn: "Explore the most reliable methods and server APIs to unlock FMI OFF and bypass iCloud on iPhone 11 through iPhone 16.",
    excerptAr: "استكشف أهم الطرق والخدمات الحديثة المعتمدة لفك وتخطي حسابات iCloud لهواتف iPhone 11 إلى iPhone 16.",
    contentEn: `### Understanding iPhone iCloud Unlocking in 2026

Unlocking iPhones has evolved significantly over recent years. Today, GSM technicians rely on two main categories of unlocking services:

#### 1. Server FMI OFF (Official Removal)
Official FMI OFF removes the Apple ID directly from Apple servers. Once completed, the iPhone can be restored, updated, and logged into with any new iCloud account without any restrictions.
- **Supported Statuses:** Clean IMEI, Sold By GSX Check verified.
- **Process Time:** 1-5 Days depending on the server source.

#### 2. Signal Bypass (Ramdisk & Activation Services)
For locked devices where server removal is not cost-effective, Ramdisk and activation bypass tools offer instant activation with working SIM network signals, FaceTime, iMessage, and App Store access.

#### Best Practices for Technicians:
1. Always run an IMEI Sold By / FMI Status check prior to submitting an order.
2. Ensure the device serial number matches the server submission.
3. Backup customer data when applicable.`,
    contentAr: `### فهم تقنيات فك وتخطي الـ iCloud لعام 2026

شهد مجال السوفت وير وفك الشفرات لهواتف آبل تطوراً كبيراً. يعتمد الفنيون والمهندسون اليوم على نوعين رئيسيين من الخدمات:

#### 1. خدمة FMI OFF الرسمية (إزالة السيرفر النهائية)
تقوم هذه الخدمة بحذف الحساب تماماً من سيرفرات آبل الرسمية. بعد اكتمال الخدمة، يمكنك عمل فورمات وتحديث للجهاز وتسجيل حساب جديد بكل حرية.
- **الحالات المدعومة:** الأجهزة النظيفة (Clean) بعد التأكد بتقرير GSX.
- **وقت التنفيذ:** من يوم إلى 5 أيام حسب السيرفر المباشر.

#### 2. تخطي الـ Bypass مع تفعيل الشبكة (Ramdisk Services)
للأجهزة التي لا يتناسب معها الفك الرسمي، تتيح أدوات الـ Ramdisk التفعيل الفوري مع تشغيل الشريحة والمكالمات والـ FaceTime والـ App Store بشكل كامل.

#### نصائح مهمة لفني السوفت وير:
1. قم دائماً بإجراء فحص IMEI Check لمعرفة حالة الـ FMI والبلد المنشأ.
2. تأكد من مطابقة السيريال نمبر عند تقديم الطلب.
3. حافظ على تحديث أدوات الـ Ramdisk لأحدث إصدارات iOS.`,
    imageUrl: "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?w=800&auto=format&fit=crop&q=80",
    category: "iPhone / iOS"
  },
  {
    titleEn: "Samsung FRP & Knox Guard Bypass Guide 2026",
    titleAr: "دليل التعامل مع حماية FRP وهواتف سامسونج الحديثة 2026",
    excerptEn: "Master the latest 1-click MTP and ADB auto-server tools for bypassing FRP on Samsung Galaxy devices.",
    excerptAr: "تعلم كيفية التعامل مع حماية Google Account (FRP) والتحديثات الأهم لعام 2026 وسيرفرات الـ MTP والـ ADB.",
    contentEn: `### Samsung FRP Unlocking Solutions

Factory Reset Protection (FRP) on modern Samsung Galaxy smartphones running Android 13, 14, and 15 requires high-speed API server operations.

#### Key Methods Available:
- **Auto API Server FRP Unlocking:** Submit your device details or use 1-Click test mode (*#0*#) tools.
- **Knox Guard Removal:** For devices locked with corporate or lease payloads.
- **Download Mode Flashing:** Using original Repair Firmware (4-File / 5-File BL, AP, CP, CSC, HOME_CSC).

Always ensure you are using original USB cables and high-speed port connections during software operations.`,
    contentAr: `### حلول فك حماية حسابات جوجل لهواتف سامسونج

تتطلب حماية FRP على هواتف سامسونج الحديثة التي تعمل بأنظمة أندرويد 13 و 14 و 15 استخدام سيرفرات سريعة ومباشرة.

#### الطرق المتاحة حالياً:
- **سيرفرات الـ FRP الأوتوماتيكية:** تقديم الطلب مباشرة عبر الـ API للتخطي التلقائي عبر وضع الاختبار (*#0*#).
- **إزالة Knox Guard:** للهواتف المقفولة بحسابات الشركات أو الإيجار.
- **التفليش عبر وضع Download Mode:** باستخدام الفلاشة الأربع ملفات الرسمية (BL, AP, CP, CSC).

احرص دائماً على استخدام كابلات داتا أصلية ومنافذ USB عالية السرعة لضمان سلامة العملية.`,
    imageUrl: "https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=800&auto=format&fit=crop&q=80",
    category: "Samsung / Android"
  },
  {
    titleEn: "Pandora Tool & Z3X Master Class for GSM Professionals",
    titleAr: "شرح كامل لاستخدام دونجل Pandora & Z3X لفك شفرات هواتف الكوالكوم والميديا تيك",
    excerptEn: "Detailed technical breakdown on using Pandora Dongle and Z3X Box for advanced Mediatek and Qualcomm flashing.",
    excerptAr: "دليل شامل للمهندسين والفنيين لاستخدام أدوات الشحن وفك الشفرات الأقوى على مستوى العالم.",
    contentEn: `### Pandora & Z3X Professional Hardware Setup

Pandora Box/Dongle is widely regarded as one of the most powerful tools for MediaTek (MTK) and Unisoc chipsets, while Z3X leads Samsung flashing and network repair.

#### Pandora Tool Capabilities:
- Direct Read/Write RPMB partitions.
- Repair IMEI on supported MTK chips.
- Backup and restore NVRAM/NVDATA calibrations.
- Unlock Bootloader with one click.

#### Pro Tips for Repair Workshops:
Maintain an isolated Windows environment with driver signature enforcement disabled when installing custom MTK USB VCOM and LibUSB drivers.`,
    contentAr: `### الإعداد الاحترافي لأدوات Pandora و Z3X

يعتبر دونجل Pandora الأداة الأقوى على الإطلاق لمعالجات MediaTek و Unisoc، بينما يتصدر دونجل Z3X عالم سوفت وير سامسونج وفك الشبكات.

#### مميزات دونجل Pandora:
- قراءة وكتابة بارتشنات الـ RPMB.
- إصلاح الـ IMEI لمعالجات الـ MTK المدعومة.
- عمل نسخ احتياطي لملفات الـ NVRAM و NVDATA.
- فك الـ Bootloader بنقرة واحدة.

#### نصائح للمهندسين والمحترفين:
قم بإيقاف فرض التوقيع الرقمي للتعريفات (Driver Signature Enforcement) في نظام ويندوز لضمان تثبيت تعريفات MTK VCOM بشكل صحيح.`,
    imageUrl: "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=800&auto=format&fit=crop&q=80",
    category: "Tools & Dongles"
  },
  {
    titleEn: "Xiaomi Mi Cloud Clean Official Removal Guide",
    titleAr: "تخطي وإزالة حسابات Xiaomi Mi Cloud بنقرة واحدة 2026",
    excerptEn: "Learn how official Xiaomi server credits completely wipe Mi Accounts from global and regional devices.",
    excerptAr: "أفضل الخدمات لسيرفرات شاومي الرسمية لإزالة حساب Mi Cloud نهائياً بدون رجوع.",
    contentEn: `### Official Xiaomi Server Unlocking vs Temporary Bypass

When a Xiaomi device is locked with a Mi Account, you have two options depending on the customer's budget:

#### 1. Official Server Removal (Clean Only)
By supplying the Lock Code shown on the screen (e.g. 12-digit code), the server unties the device from the Xiaomi Cloud permanently.
- Device can be formatted and updated without relocking.
- Works on all MIUI and HyperOS versions.

#### 2. EDL Bypass (Lost / Local Fix)
For devices flagged as lost or unsupported by region, EDL mode tools allow bypassing the account locally with anti-relock patches.`,
    contentAr: `### الإزالة الرسمية لحساب شاومي مقابل التخطي المؤقت

عند قفل هاتف شاومي بحساب Mi Account، يمتلك الفني خيارين بناءً على حالة الجهاز:

#### 1. الإزالة الرسمية عبر السيرفر (Clean)
عن طريق إدخال كود القفل المكون من الأرقام والرموز الظاهرة على الشاشة، يقوم السيرفر بفك ارتباط الجهاز بالحساب تماماً.
- يمكن عمل سوفت وير وتحديثات بدون عودة القفل.
- مدعوم على كافة واجهات MIUI و HyperOS الحديثة.

#### 2. التخطي عبر وضع EDL Mode
للأجهزة غير المدعومة أو المفقودة، يمكن استخدام أدوات الـ EDL لتخطي الحساب محلياً وتفعيل خيار الحماية ضد إعادة القفل.`,
    imageUrl: "https://images.unsplash.com/photo-1598327105666-5b89351aff97?w=800&auto=format&fit=crop&q=80",
    category: "Xiaomi / Redmi"
  },
  {
    titleEn: "Dead Boot Recovery: MTK & Qualcomm TestPoint Mastery",
    titleAr: "طريقة التعامل مع وضع الـ EDL Mode وهواتف الميديا تيك الميتة",
    excerptEn: "Step-by-step techniques for reviving hard-bricked Android devices using TestPoint and factory flash dumps.",
    excerptAr: "كيفية إحياء الهواتف الفاصلة باور بسبب خطأ في السوفت وير باستخدام كابل الاختبار والـ TestPoint.",
    contentEn: `### Recovering Hard Bricked Smartphones

A "hard brick" occurs when a phone loses its primary bootloader (PBL/SBL), rendering screen and buttons unresponsive.

#### Recovery Procedure:
1. **Identify TestPoint Pins:** Locate the hardware TestPoint on the phone board schematics.
2. **Short to Ground:** Short the pin to GND while plugging in the USB cable.
3. **Qualcomm Emergency Mode (HS-USB QDLoader 9008):** Use tools like UnlockTool or Chimera to write rawprogram0.xml and patch0.xml.
4. **MediaTek BROM Mode:** Force BROM mode to write scatter files and preloader images.`,
    contentAr: `### إحياء الهواتف الفاصلة باور (Hard Brick)

يحدث الـ Hard Brick عندما يفقد الهاتف البوتلودر الأساسي نتيجة تفليش فلاشة خاطئة أو انقطاع الاتصال أثناء السوفت وير.

#### خطوات الاسترجاع:
1. **تحديد نقطة الـ TestPoint:** معرفة نقطة الاختبار المخصصة على بوردة الهاتف من المخططات.
2. **التوصيل بالأرضي:** توجيه كابل الـ TestPoint إلى الأرضي (GND) أثناء توصيل كابل الـ USB.
3. **وضع كوالكوم 9008 (QDLoader 9008):** استخدام برنامج مثل UnlockTool لكتابة ملفات الـ rawprogram0.xml.
4. **وضع ميديا تيك BROM:** إجبار المعالج على قراءة ملف الـ Preloader وكتابة الـ Scatter الفلاشة الأصلية.`,
    imageUrl: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80",
    category: "Repair & Flashing"
  },
  {
    titleEn: "Top Automated API Server Services for Resellers 2026",
    titleAr: "أهم أدوات السيرفر الأوتوماتيكية لعام 2026 لجميع المحلات والوكلاء",
    excerptEn: "Compare the leading GSM server licenses including Chimera, UnlockTool, AMT, and EFT Pro for maximum profitability.",
    excerptAr: "مقارنة شاملة بين أشهر أدوات وسيرفرات GSM مثل Chimera, UnlockTool, AMT, و EFT Pro.",
    contentEn: `### Choosing the Right Software Tools for Your Shop

Running a successful GSM repair shop requires having access to reliable, automated digital credits and licenses.

#### Top Digital Tools Evaluated:
- **UnlockTool:** Best all-in-one multi-brand tool for MTK, Qualcomm, and Apple Ramdisk.
- **Chimera Tool:** Premier software for Samsung IMEI repair and Blackberry/Huawei unlocking.
- **EFT Pro (Easy Firmware Team):** Outstanding for Samsung FRP and Huawei ID removal.
- **AMT (Android Multi Tool):** Fast server credits with automatic instant execution.`,
    contentAr: `### اختيار أدوات السوفت وير المناسبة لمركزك

يتطلب نجاح مركز صيانة الهواتف الوصول إلى تراخيص وسيرفرات رقمية سريعة ومؤتمتة بالكامل عبر الـ API.

#### تقييم أهم الأدوات الرقمية:
- **UnlockTool:** الأداة الأشهر والأشمل لكافة المعالجات (MTK, Qualcomm, Apple Ramdisk).
- **Chimera Tool:** الأقوى في تفليش وإصلاح هواتف سامسونج وهواري.
- **EFT Pro:** تمتاز بقوة الـ Dongle في التعامل مع حمايات سامسونج وحسابات Huawei ID.
- **AMT Tool:** أرصدة سيرفر فورية وأوتوماتيكية لتنفيذ الطلبات في ثوانٍ.`,
    imageUrl: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&auto=format&fit=crop&q=80",
    category: "Reseller & API"
  },
  {
    titleEn: "US Carrier Network Unlocking: T-Mobile, AT&T & Metro",
    titleAr: "دليل فك شفرات هواتف موتورولا وزد تي إي التابعة للشبكات الأمريكية",
    excerptEn: "How to permanently unlock SIM restrictions on imported American and European smartphones.",
    excerptAr: "كيفية فك شفرات الشبكات المقفولة لجميع الهواتف الواردة من أمريكا وأوروبا بسهولة.",
    contentEn: `### Permanent Carrier Unlocking Overview

Smartphones sold by US carriers like T-Mobile, MetroPCS, AT&T, and Verizon come locked to their respective SIM networks.

#### Unlocking Mechanisms:
- **Device Unlock App (Server Auto):** Unlocking directly via remote database authorization.
- **CPID Unlocking:** Repairing carrier lock bytes for Samsung Galaxy devices.
- **Code Retrieval (NCK/SPC):** Entering unlock codes generated from IMEI databases.`,
    contentAr: `### نظرة عامة على فك تشفير الشبكات الأمريكية

تأتي الهواتف الواردة من أمريكا من شبكات مثل T-Mobile و AT&T و Verizon مقفولة على شريحة الشركة فقط.

#### آليات فك التشفيـر:
- **تطبيق Device Unlock (عبر السيرفر):** الفك المباشر من خلال تسجيل الجهاز في قاعدة بيانات الشبكة.
- **فك الـ CPID:** تعديل بيانات تشفير الشبكة لهواتف سامسونج.
- **أكواد الـ NCK:** استخراج كود فك الشفرة عن طريق الـ IMEI وإدخاله يدوياً في الجهاز.`,
    imageUrl: "https://images.unsplash.com/photo-1563986768609-322da13575f3?w=800&auto=format&fit=crop&q=80",
    category: "Network Unlock"
  },
  {
    titleEn: "NVRAM & IMEI Repair Best Practices for Engineers",
    titleAr: "كتابة وإصلاح أرقام الـ IMEI وسجلات الـ NVRAM للهواتف الذكية",
    excerptEn: "Professional methods to fix 'Not Registered on Network' and restore missing baseband calibration.",
    excerptAr: "القوانين التقنية والخطوات الأمنية لإصلاح فقدان الشبكة ومشكلة 'غير مسجل على الشبكة'.",
    contentEn: `### Restoring Baseband and Network Connectivity

When a phone experiences a corrupt EFS or NVRAM partition, it displays "Unknown Baseband" or Null IMEI.

#### Safe Repair Workflow:
1. Always create a full backup of EFS / NVRAM / NVDATA before flashing.
2. Write original QCN files for Qualcomm devices using QPST or Pandora.
3. Perform Meta Mode or AT Command calibration for MediaTek phones.
4. Verify checksums to avoid network dropping after reboot.`,
    contentAr: `### استعادة بيانات الباندباند وشبكة الاتصال

عند تلف ملفات الـ EFS أو NVRAM في الهاتف، يظهر الجهاز عبارة "Baseband غير معروف" أو يفقد رقم الـ IMEI.

#### الخطوات الآمنة للإصلاح:
1. الاحتفاظ بنسخة احتياطية من ملفات الـ EFS و NVRAM قبل كتابة أي فلاشة.
2. كتابة ملف QCN المناسب لمعالجات كوالكوم باستخدام برنامج QPST أو Pandora.
3. التعديل عبر وضع Meta Mode لهواتف الـ MediaTek.
4. التحقق من سلامة السيريال والشبكة بعد إعادة التشغيل.`,
    imageUrl: "https://images.unsplash.com/photo-1550751827-4bd374c3f58b?w=800&auto=format&fit=crop&q=80",
    category: "Advanced Repair"
  },
  {
    titleEn: "GSM Workshop Security & API Key Protection",
    titleAr: "دليل الأمان والحماية لسيرفرات السوفت وير ومحلات صيانة الهواتف",
    excerptEn: "Protecting reseller credit balances, API credentials, and customer devices from malicious exploits.",
    excerptAr: "أفضل الممارسات لحماية أجهزة العملاء وبيانات المحل وأرصدة السيرفرات من الاختراق.",
    contentEn: `### Securing Your Software Infrastructure

GSM shop owners handle high-value credit balances and API integration keys daily. Securing this infrastructure is imperative.

#### Essential Security Measures:
- **API Key Scoping:** Never hardcode secret keys in client-side code; proxy all API calls through a secure backend.
- **PC Isolation:** Dedicate a specific workstation for flashing and unlocking to prevent malware infection.
- **Two-Factor Authentication (2FA):** Enable 2FA on all GSM portal accounts and payment gateways.`,
    contentAr: `### تأمين البنية التحتية لمركز الصيانة

يتعامل أصحاب مراكز الصيانة يومياً مع أرصدة سيرفرات ومفاتيح ربط API مرتفعة القيمة، مما يتطلب تأمينها بأعلى الدرجات.

#### تدابير الأمان الأساسية:
- **تأمين مفاتيح الـ API:** عدم كتابة مفاتيح السر في كود الواجهة الأمامية، وربط كافة الطلبات عبر السيرفر الخافي (Backend).
- **عزل كمبيوتر السوفت وير:** تخصيص جهاز معين لعمليات السوفت وير لمنع وصول البرمجيات الخبيثة.
- **تفعيل التحقق بخطوتين (2FA):** تفعيل حماية 2FA على كافة حسابات السيرفرات ومحافط الدفع الإلكتروني.`,
    imageUrl: "https://images.unsplash.com/photo-1563013544-824ae1b704d3?w=800&auto=format&fit=crop&q=80",
    category: "Cyber Security & Shop Management"
  }
];

const videos = [
  {
    titleEn: "Samsung FRP One-Click Auto API Unlock Tutorial",
    titleAr: "شرح عملي: تخطي حساب FRP لهواتف سامسونج أحدث حماية بنقرة واحدة",
    descriptionEn: "Step-by-step video demonstration on using automated server APIs to bypass Samsung Google Account lock in under 60 seconds.",
    descriptionAr: "فيديو تعليمي خطوة بخطوة لشرح كيفية استخدام سيرفر السوفت وير لتخطي حساب جوجل لهواتف سامسونج في أقل من دقيقة.",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    thumbnail: "https://images.unsplash.com/photo-1610945265064-0e34e5519bbf?w=800&auto=format&fit=crop&q=80",
    category: "Samsung / FRP",
    isFreePreview: true,
    orderIndex: 1
  },
  {
    titleEn: "UnlockTool Masterclass 2026: Multi-Brand Flashing & Unlocking",
    titleAr: "دورة احتراف UnlockTool: الفك والتفلش الكامل لجميع المعالجات 2026",
    descriptionEn: "Complete masterclass covering UnlockTool interface for Xiaomi, Samsung, OPPO, Vivo, and Apple Ramdisk devices.",
    descriptionAr: "كورس شامل لتعلم واجهة أداة UnlockTool الشهيرة، التعامل مع هواتف Xiaomi, OPPO, Vivo, Samsung.",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    thumbnail: "https://images.unsplash.com/photo-1581092160607-ee22621dd758?w=800&auto=format&fit=crop&q=80",
    category: "UnlockTool / Multi-Brand",
    isFreePreview: true,
    orderIndex: 2
  },
  {
    titleEn: "Qualcomm EDL Mode TestPoint & QDLoader 9008 Flashing",
    titleAr: "شرح استخدام كابل الـ EDL TestPoint لتفليش هواتف كوالكوم الميتة",
    descriptionEn: "Learn how to locate motherboard TestPoints and force Qualcomm QDLoader 9008 mode to unbrick dead phones.",
    descriptionAr: "تعلم تحديد نقاط الـ TestPoint على البوردة وإدخال الهاتف في وضع 9008 لاستعادة الهواتف الفاصلة.",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    thumbnail: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=800&auto=format&fit=crop&q=80",
    category: "Hardware & Software",
    isFreePreview: true,
    orderIndex: 3
  },
  {
    titleEn: "How to Buy Credits, Activate Licenses & Manage Reseller Wallet",
    titleAr: "تفعيل وشحن أرصدة السيرفرات وشراء الـ Credits والـ Dongles",
    descriptionEn: "Visual walkthrough showing how to top up your wallet and instantly activate software credits and tool licenses.",
    descriptionAr: "شرح خطوة بخطوة لشحن المحفظة وشراء وتفعيل التراخيص والخدمات التلقائية فورياً من الموقع.",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    thumbnail: "https://images.unsplash.com/photo-1558494949-ef010cbdcc31?w=800&auto=format&fit=crop&q=80",
    category: "Reseller Guide",
    isFreePreview: true,
    orderIndex: 4
  },
  {
    titleEn: "iPhone iCloud Ramdisk Bypass & Network Signal Repair",
    titleAr: "شرح التعامل مع هواتف الآيفون: التخطي التام والشبكة ومسح iCloud",
    descriptionEn: "Detailed tutorial explaining how to prepare Ramdisk environment and bypass iCloud with active cellular signals.",
    descriptionAr: "فيديو توضيحي يشرح بالتفصيل طريقة تجهيز الهاتف على وضع الـ Ramdisk واستخدام السيرفر لإعادة تشغيل الشبكة.",
    videoUrl: "https://www.youtube.com/embed/dQw4w9WgXcQ",
    thumbnail: "https://images.unsplash.com/photo-1512499617640-c74ae3a79d37?w=800&auto=format&fit=crop&q=80",
    category: "Apple / iOS",
    isFreePreview: true,
    orderIndex: 5
  }
];

async function seed() {
  console.log("Seeding Blog Posts...");
  await prisma.blogPost.deleteMany({});
  for (const article of articles) {
    await prisma.blogPost.create({ data: article });
  }
  console.log(`Successfully created ${articles.length} Blog Posts.`);

  console.log("Seeding Video Tutorials...");
  await prisma.videoTutorial.deleteMany({});
  for (const video of videos) {
    await prisma.videoTutorial.create({ data: video });
  }
  console.log(`Successfully created ${videos.length} Video Tutorials.`);
}

seed()
  .catch((e) => {
    console.error("Seeding Error:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
