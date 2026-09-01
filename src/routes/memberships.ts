import { Router } from "express";
import { prisma } from "../utils/prisma";
import { isAdmin, authenticateToken } from "../middleware/auth";

const router = Router();

// GET /api/memberships - Get all membership tiers
router.get("/", async (req, res) => {
  try {
    const tiers = await prisma.membershipTier.findMany({
      orderBy: { minDeposit: "asc" },
      include: {
        _count: {
          select: { users: true }
        }
      }
    });

    // If no tiers exist yet, create default starter tiers
    if (tiers.length === 0) {
      const defaultTiers = [
        {
          name: "عضوية برونزية (Bronze)",
          nameAr: "عضوية برونزية",
          minDeposit: 0,
          discountPercentage: 0,
          badgeColor: "#94a3b8",
          description: "العضوية الافتراضية لجميع المستخدمين المسجلين الجدد.",
          isDefault: true
        },
        {
          name: "عضوية فضية (Silver)",
          nameAr: "عضوية فضية",
          minDeposit: 50,
          discountPercentage: 5,
          badgeColor: "#38bdf8",
          description: "خصم 5% على جميع خدمات السيرفر عند شحن 50$ أو أكثر.",
          isDefault: false
        },
        {
          name: "عضوية ذهبية VIP (Gold VIP 100$)",
          nameAr: "عضوية ذهبية VIP",
          minDeposit: 100,
          discountPercentage: 10,
          badgeColor: "#fbbf24",
          description: "خصم 10% فوري على كل الخدمات عند شحن 100$ في المحفظة.",
          isDefault: false
        },
        {
          name: "عضوية تجار بلاتينية (Platinum Reseller)",
          nameAr: "عضوية بلاتينية كبار التجار",
          minDeposit: 300,
          discountPercentage: 15,
          badgeColor: "#a855f7",
          description: "أعلى نسبة خصم 15% وحساب VIP مخصص لكبار الموزعين والفنيين.",
          isDefault: false
        }
      ];

      for (const t of defaultTiers) {
        await prisma.membershipTier.create({ data: t });
      }

      const freshTiers = await prisma.membershipTier.findMany({
        orderBy: { minDeposit: "asc" },
        include: {
          _count: {
            select: { users: true }
          }
        }
      });
      return res.json({ success: true, tiers: freshTiers });
    }

    return res.json({ success: true, tiers });
  } catch (error: any) {
    console.error("Error fetching membership tiers:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch memberships" });
  }
});

// GET /api/memberships/users - Get all users with their membership information (Admin only)
router.get("/users", isAdmin, async (req, res) => {
  try {
    const users = await prisma.user.findMany({
      where: { role: { not: "admin" } },
      select: {
        id: true,
        fullName: true,
        username: true,
        email: true,
        phone: true,
        country: true,
        balance: true,
        status: true,
        customDiscount: true,
        membershipTierId: true,
        membershipTier: true,
        createdAt: true
      },
      orderBy: { createdAt: "desc" }
    });

    return res.json({ success: true, users });
  } catch (error: any) {
    console.error("Error fetching membership users:", error);
    return res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

// POST /api/memberships - Create or Update a membership tier (Admin only)
router.post("/", isAdmin, async (req, res) => {
  try {
    const { id, name, nameAr, minDeposit, discountPercentage, badgeColor, description, isDefault } = req.body;

    if (!name) {
      return res.status(400).json({ success: false, error: "اسم العضوية مطلوب" });
    }

    const payload = {
      name: String(name),
      nameAr: nameAr ? String(nameAr) : String(name),
      minDeposit: parseFloat(minDeposit) || 0,
      discountPercentage: parseFloat(discountPercentage) || 0,
      badgeColor: badgeColor ? String(badgeColor) : "#2dd4bf",
      description: description ? String(description) : "",
      isDefault: Boolean(isDefault)
    };

    let tier;
    if (id) {
      tier = await prisma.membershipTier.update({
        where: { id: String(id) },
        data: payload
      });
    } else {
      tier = await prisma.membershipTier.create({
        data: payload
      });
    }

    return res.json({ success: true, tier });
  } catch (error: any) {
    console.error("Error saving membership tier:", error);
    return res.status(500).json({ success: false, error: "Failed to save membership tier" });
  }
});

// DELETE /api/memberships/:id - Delete a membership tier (Admin only)
router.delete("/:id", isAdmin, async (req, res) => {
  try {
    const { id } = req.params;

    // Unassign users first
    await prisma.user.updateMany({
      where: { membershipTierId: String(id) },
      data: { membershipTierId: null }
    });

    await prisma.membershipTier.delete({
      where: { id: String(id) }
    });

    return res.json({ success: true, message: "تم حذف العضوية بنجاح" });
  } catch (error: any) {
    console.error("Error deleting membership tier:", error);
    return res.status(500).json({ success: false, error: "Failed to delete membership tier" });
  }
});

// POST /api/memberships/assign-user - Assign user to a tier or set custom discount (Admin only)
router.post("/assign-user", isAdmin, async (req, res) => {
  try {
    const { userId, membershipTierId, customDiscount } = req.body;

    if (!userId) {
      return res.status(400).json({ success: false, error: "معرف المستخدم مطلوب" });
    }

    const updateData: any = {};
    if (membershipTierId !== undefined) {
      updateData.membershipTierId = membershipTierId === "" || membershipTierId === "none" ? null : String(membershipTierId);
    }
    if (customDiscount !== undefined) {
      updateData.customDiscount = parseFloat(customDiscount) || 0;
    }

    const updatedUser = await prisma.user.update({
      where: { id: String(userId) },
      data: updateData,
      include: {
        membershipTier: true
      }
    });

    return res.json({ success: true, user: updatedUser });
  } catch (error: any) {
    console.error("Error assigning membership to user:", error);
    return res.status(500).json({ success: false, error: "Failed to assign membership" });
  }
});

export default router;
