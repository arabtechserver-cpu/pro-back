import { Router } from "express";
import { prisma } from "../utils/prisma";
import { isAdmin } from "../middleware/auth";

const router = Router();

// GET /api/coupons - List all coupons with stats (Admin only)
router.get("/", isAdmin, async (req, res) => {
  try {
    const coupons = await prisma.coupon.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        _count: {
          select: { usages: true }
        }
      }
    });

    const now = new Date();

    const formatted = coupons.map((c) => {
      const isExpired = now > c.expiresAt;
      const isMaxedOut = c.usedCount >= c.maxUses;
      const msDiff = c.expiresAt.getTime() - now.getTime();
      const daysRemaining = isExpired ? 0 : Math.max(0, Math.ceil(msDiff / (1000 * 60 * 60 * 24)));

      return {
        ...c,
        isExpired,
        isMaxedOut,
        daysRemaining,
        usagesCount: c._count.usages
      };
    });

    return res.json({ success: true, coupons: formatted });
  } catch (error: any) {
    console.error("Error fetching coupons:", error);
    return res.status(500).json({ error: "فشل جلب قائمة أكواد الخصم" });
  }
});

// POST /api/coupons - Create new coupon (Admin only)
router.post("/", isAdmin, async (req, res) => {
  try {
    const { code, discountPercent, durationDays, maxUses } = req.body;

    if (!code || typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ error: "رمز كود الخصم مطلوب" });
    }

    const cleanCode = code.trim().toUpperCase();

    const percent = parseFloat(discountPercent);
    if (isNaN(percent) || percent <= 0 || percent > 100) {
      return res.status(400).json({ error: "نسبة الخصم يجب أن تكون رقماً بين 1% و 100%" });
    }

    const days = parseInt(durationDays, 10);
    if (isNaN(days) || days <= 0) {
      return res.status(400).json({ error: "مدة الصلاحية بالأيام يجب أن تكون رقماً أكبر من صفر" });
    }

    const uses = parseInt(maxUses, 10);
    if (isNaN(uses) || uses <= 0) {
      return res.status(400).json({ error: "الحد الأقصى لعدد مرات الاستخدام يجب أن يكون رقماً أكبر من صفر" });
    }

    // Check if code already exists
    const existing = await prisma.coupon.findUnique({
      where: { code: cleanCode }
    });

    if (existing) {
      return res.status(400).json({ error: "كود الخصم هذا مسجل بالفعل! يرجى اختيار رمز آخر." });
    }

    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const created = await prisma.coupon.create({
      data: {
        code: cleanCode,
        discountPercent: percent,
        durationDays: days,
        expiresAt,
        maxUses: uses,
        usedCount: 0,
        isActive: true
      }
    });

    return res.json({
      success: true,
      message: `تم إنشاء كود الخصم (${cleanCode}) بنجاح بنسبة ${percent}% وصلاحية ${days} يوم!`,
      coupon: created
    });
  } catch (error: any) {
    console.error("Error creating coupon:", error);
    return res.status(500).json({ error: "فشل إنشاء كود الخصم" });
  }
});

// PATCH /api/coupons/:id/toggle - Enable/Disable coupon (Admin only)
router.patch("/:id/toggle", isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    const existing = await prisma.coupon.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "كود الخصم غير موجود" });
    }

    const updated = await prisma.coupon.update({
      where: { id },
      data: { isActive: !existing.isActive }
    });

    return res.json({
      success: true,
      message: updated.isActive ? "تم تفعيل كود الخصم بنجاح" : "تم تعطيل كود الخصم",
      coupon: updated
    });
  } catch (error: any) {
    console.error("Error toggling coupon:", error);
    return res.status(500).json({ error: "فشل تعديل حالة كود الخصم" });
  }
});

// DELETE /api/coupons/:id - Delete coupon (Admin only)
router.delete("/:id", isAdmin, async (req, res) => {
  try {
    const id = String(req.params.id);
    await prisma.coupon.delete({ where: { id } });
    return res.json({ success: true, message: "تم حذف كود الخصم بنجاح" });
  } catch (error: any) {
    console.error("Error deleting coupon:", error);
    return res.status(500).json({ error: "فشل حذف كود الخصم" });
  }
});

// POST /api/coupons/validate - Validate coupon for checkout (Public/Client)
router.post("/validate", async (req, res) => {
  try {
    const { code, price, userId } = req.body;

    if (!code || typeof code !== "string" || !code.trim()) {
      return res.status(400).json({ valid: false, error: "الرجاء إدخال كود الخصم" });
    }

    const cleanCode = code.trim().toUpperCase();

    const coupon = await prisma.coupon.findUnique({
      where: { code: cleanCode }
    });

    if (!coupon) {
      return res.status(404).json({ valid: false, error: "كود الخصم المدخل غير صحيح" });
    }

    if (!coupon.isActive) {
      return res.status(400).json({ valid: false, error: "عذراً، كود الخصم هذا متوقف حالياً" });
    }

    const now = new Date();
    if (now > coupon.expiresAt) {
      return res.status(400).json({ valid: false, error: "عذراً، لقد انتهت فترة صلاحية هذا الكود" });
    }

    if (coupon.usedCount >= coupon.maxUses) {
      return res.status(400).json({ valid: false, error: "عذراً، اكتمل الحد الأقصى لاستخدام هذا الكود" });
    }

    // If userId provided, check if user already redeemed this coupon
    if (userId) {
      const existingUsage = await prisma.couponUsage.findFirst({
        where: {
          couponId: coupon.id,
          userId: String(userId)
        }
      });
      if (existingUsage) {
        return res.status(400).json({
          valid: false,
          error: "لقد استخدمت كود الخصم هذا من قبل، يُسمح باستخدامه مرة واحدة فقط لكل حساب"
        });
      }
    }

    const originalPrice = parseFloat(price) || 0;
    const discountAmount = Number(((originalPrice * coupon.discountPercent) / 100).toFixed(2));
    const finalPrice = Math.max(0, Number((originalPrice - discountAmount).toFixed(2)));

    return res.json({
      valid: true,
      code: coupon.code,
      discountPercent: coupon.discountPercent,
      discountAmount,
      finalPrice,
      message: `تم تفعيل خصم ${coupon.discountPercent}% بنجاح! وفرت $${discountAmount.toFixed(2)} USD`
    });
  } catch (error: any) {
    console.error("Error validating coupon:", error);
    return res.status(500).json({ valid: false, error: "حدث خطأ أثناء فحص كود الخصم" });
  }
});

export default router;
