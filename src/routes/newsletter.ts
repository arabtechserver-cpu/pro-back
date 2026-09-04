import { Router } from "express";
import { prisma } from "../utils/prisma";
import { isAdmin } from "../middleware/auth";
import { 
  addContactToLoops, 
  sendWelcomeNewsletterEmail, 
  sendNewsletterBroadcastEmail 
} from "../utils/emailService";
import { sendTelegramMessage, getAdminChatIds } from "../utils/telegramService";

const router = Router();

// Helper to notify all subscribers about a new item / update
export async function broadcastNewItemToSubscribers({
  title,
  message,
  category,
  actionUrl,
  actionText
}: {
  title: string;
  message: string;
  category?: string;
  actionUrl?: string;
  actionText?: string;
}) {
  try {
    const subscribers = await prisma.subscriber.findMany({
      where: { isActive: true }
    });

    if (subscribers.length === 0) return { count: 0 };

    const subject = `[عرب تك برو] ${title}`;
    const broadcastCategory = category || "Service Update";
    const url = actionUrl || "https://arabtechproserver.tech";
    const text = actionText || "عرض التفاصيل الآن";

    // Save broadcast record
    const broadcast = await prisma.newsletterBroadcast.create({
      data: {
        subject,
        title,
        message,
        category: broadcastCategory,
        actionUrl: url,
        actionText: text,
        sentCount: subscribers.length
      }
    });

    // Send emails in background (batched)
    const emailPromises = subscribers.map(async (sub) => {
      try {
        await sendNewsletterBroadcastEmail(sub.email, {
          subject,
          title,
          message,
          actionUrl: url,
          actionText: text
        });
      } catch (err) {
        console.error(`Failed to send broadcast email to ${sub.email}:`, err);
      }
    });

    await Promise.allSettled(emailPromises);

    // Update lastNotifiedAt
    await prisma.subscriber.updateMany({
      where: { isActive: true },
      data: { lastNotifiedAt: new Date() }
    });

    // Also notify Admin on Telegram
    const adminChatIds = getAdminChatIds();
    for (const chatId of adminChatIds) {
      await sendTelegramMessage(
        chatId,
        `📢 <b>تم إرسال إشعار للمشتركين في النشرة الإخبارية!</b>\n\n📌 <b>العنوان:</b> ${title}\n📝 <b>الوصف:</b> ${message}\n👥 <b>عدد المستلمين:</b> ${subscribers.length} عميل مشترك\n🔗 <b>الرابط:</b> ${url}`
      );
    }

    return { count: subscribers.length, broadcastId: broadcast.id };
  } catch (error) {
    console.error("Error broadcasting to subscribers:", error);
    return { count: 0, error };
  }
}

// POST /api/newsletter/subscribe - Public endpoint for visitors & customers
router.post("/subscribe", async (req, res) => {
  try {
    const { email, name } = req.body;

    if (!email || typeof email !== "string" || !email.includes("@")) {
      return res.status(400).json({ 
        success: false, 
        error: "يرجى إدخال بريد إلكتروني صحيح / Please provide a valid email address" 
      });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = (name && typeof name === "string") ? name.trim() : undefined;

    // Check if already subscribed
    const existing = await prisma.subscriber.findUnique({
      where: { email: cleanEmail }
    });

    if (existing && existing.isActive) {
      return res.json({
        success: true,
        alreadySubscribed: true,
        message: "أنت مشترك بالفعل في نشرتنا الإخبارية! ستصلك أحدث العروض والخدمات مباشرة."
      });
    }

    // Upsert subscriber
    const subscriber = await prisma.subscriber.upsert({
      where: { email: cleanEmail },
      update: { 
        isActive: true,
        name: cleanName || existing?.name
      },
      create: {
        email: cleanEmail,
        name: cleanName,
        isActive: true,
        source: "website_banner"
      }
    });

    // Add to Loops audience & send welcome email
    addContactToLoops(cleanEmail, cleanName).catch(() => {});
    sendWelcomeNewsletterEmail(cleanEmail, cleanName).catch(() => {});

    // Notify Telegram Admin about new subscriber
    const adminChatIds = getAdminChatIds();
    for (const chatId of adminChatIds) {
      sendTelegramMessage(
        chatId,
        `📬 <b>مشترك جديد في النشرة الإخبارية!</b>\n\n✉️ <b>البريد الإلكتروني:</b> <code>${cleanEmail}</code>\n👤 <b>الاسم:</b> ${cleanName || 'زائر'}\n🕒 <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}`
      ).catch(() => {});
    }

    return res.json({
      success: true,
      subscriber: {
        id: subscriber.id,
        email: subscriber.email
      },
      message: "تم اشتراكك بنجاح! شكراً لانضمامك، ستصلك أحدث التحديثات والعروض فور إضافتها."
    });
  } catch (error: any) {
    console.error("Subscription error:", error);
    return res.status(500).json({ 
      success: false, 
      error: "حدث خطأ أثناء معالجة طلب الاشتراك. يرجى المحاولة مرة أخرى." 
    });
  }
});

// GET /api/newsletter/subscribers - Admin list of subscribers
router.get("/subscribers", isAdmin, async (req, res) => {
  try {
    const { q, status } = req.query;

    const whereClause: any = {};
    if (status === "active") whereClause.isActive = true;
    if (status === "inactive") whereClause.isActive = false;

    if (q && typeof q === "string") {
      const search = q.trim();
      whereClause.OR = [
        { email: { contains: search, mode: "insensitive" } },
        { name: { contains: search, mode: "insensitive" } }
      ];
    }

    const [subscribers, total, active] = await Promise.all([
      prisma.subscriber.findMany({
        where: whereClause,
        orderBy: { createdAt: "desc" }
      }),
      prisma.subscriber.count(),
      prisma.subscriber.count({ where: { isActive: true } })
    ]);

    const broadcastsCount = await prisma.newsletterBroadcast.count();

    return res.json({
      subscribers,
      stats: {
        total,
        active,
        inactive: total - active,
        broadcastsCount
      }
    });
  } catch (error) {
    console.error("Error fetching subscribers:", error);
    return res.status(500).json({ error: "Failed to fetch subscribers" });
  }
});

// POST /api/newsletter/broadcast - Admin broadcast custom message/offer to all subscribers
router.post("/broadcast", isAdmin, async (req, res) => {
  try {
    const { title, message, category, actionUrl, actionText } = req.body;

    if (!title || !message) {
      return res.status(400).json({ error: "العنوان ومحتوى الرسالة مطلوبان" });
    }

    const result = await broadcastNewItemToSubscribers({
      title: title.trim(),
      message: message.trim(),
      category: category || "Tool Offer",
      actionUrl: actionUrl?.trim(),
      actionText: actionText?.trim()
    });

    return res.json({
      success: true,
      message: `تم إرسال النشرة البريدية بنجاح إلى ${result.count} مشترك نشط!`,
      sentCount: result.count
    });
  } catch (error) {
    console.error("Broadcast error:", error);
    return res.status(500).json({ error: "Failed to send newsletter broadcast" });
  }
});

// POST /api/newsletter/toggle/:id - Admin toggle active status
router.post("/toggle/:id", isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const subscriber = await prisma.subscriber.findUnique({ where: { id } });

    if (!subscriber) {
      return res.status(404).json({ error: "المشترك غير موجود" });
    }

    const updated = await prisma.subscriber.update({
      where: { id },
      data: { isActive: !subscriber.isActive }
    });

    return res.json({
      success: true,
      subscriber: updated,
      message: updated.isActive ? "تم تفعيل اشتراك العميل بنجاح" : "تم تعطيل اشتراك العميل"
    });
  } catch (error) {
    console.error("Toggle subscriber error:", error);
    return res.status(500).json({ error: "Failed to toggle subscriber status" });
  }
});

// DELETE /api/newsletter/subscribers/:id - Admin delete subscriber
router.delete("/subscribers/:id", isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    await prisma.subscriber.delete({ where: { id } });
    return res.json({ success: true, message: "تم حذف المشترك بنجاح" });
  } catch (error) {
    console.error("Delete subscriber error:", error);
    return res.status(500).json({ error: "Failed to delete subscriber" });
  }
});

// GET /api/newsletter/broadcasts - Admin list of sent broadcasts
router.get("/broadcasts", isAdmin, async (req, res) => {
  try {
    const broadcasts = await prisma.newsletterBroadcast.findMany({
      orderBy: { createdAt: "desc" }
    });
    return res.json(broadcasts);
  } catch (error) {
    return res.status(500).json({ error: "Failed to fetch broadcasts" });
  }
});

export default router;
