import { Router } from "express";
import { prisma } from "../utils/prisma";
import bcrypt from "bcryptjs";
import { isAdmin, authenticateToken } from "../middleware/auth";
import { checkAndAutoUpgradeMembership } from "../utils/membershipUpgrade";
import { prepareApiActivation } from "../utils/api-activation";

const router = Router();

// GET all registered users for Admin Dashboard
router.get("/", isAdmin, async (req, res) => {
  try {
    const { q, status } = req.query;

    const whereClause: any = {
      role: { not: 'admin' }
    };
    if (status && status !== "all") {
      whereClause.status = String(status);
    }
    if (q) {
      const searchStr = String(q).trim();
      whereClause.OR = [
        { fullName: { contains: searchStr, mode: 'insensitive' } },
        { email: { contains: searchStr, mode: 'insensitive' } },
        { username: { contains: searchStr, mode: 'insensitive' } },
        { phone: { contains: searchStr, mode: 'insensitive' } },
        { country: { contains: searchStr, mode: 'insensitive' } }
      ];
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      orderBy: { createdAt: "desc" }
    });

    const totalUsers = await prisma.user.count({ where: { role: { not: 'admin' } } });
    const activeUsers = await prisma.user.count({ where: { role: { not: 'admin' }, status: "active" } });
    const suspendedUsers = await prisma.user.count({ where: { role: { not: 'admin' }, status: "suspended" } });

    return res.json({
      users,
      stats: {
        total: totalUsers,
        active: activeUsers,
        suspended: suspendedUsers
      }
    });
  } catch (error: any) {
    console.error("Error fetching users:", error);
    return res.status(500).json({ error: "Failed to fetch users" });
  }
});

// GET /api/users/profile - Fetch live user profile & balance
router.get("/profile", authenticateToken, async (req: any, res) => {
  try {
    const { email, userId } = req.query;
    let u: any = null;
    if (userId) {
      u = await prisma.user.findUnique({ where: { id: String(userId) }, include: { membershipTier: true } });
    } else if (email) {
      u = await prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() }, include: { membershipTier: true } });
    } else if (req.user?.id) {
      u = await prisma.user.findUnique({ where: { id: req.user.id }, include: { membershipTier: true } });
    } else if (req.user) {
      u = await prisma.user.findUnique({ where: { id: req.user.id }, include: { membershipTier: true } }) || req.user;
    }

    if (!u) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Auto-check for VIP upgrade
    const autoUpgraded = await checkAndAutoUpgradeMembership(u.id);
    if (autoUpgraded) {
      u = autoUpgraded;
    }

    const effectiveDiscount = Math.max(
      u.customDiscount || 0,
      u.membershipTier?.discountPercentage || 0
    );

    return res.json({
      success: true,
      user: {
        id: u.id,
        fullName: u.fullName,
        username: u.username,
        email: u.email,
        phone: u.phone,
        country: u.country,
        balance: u.balance,
        role: u.role,
        status: u.status,
        membershipTierId: u.membershipTierId,
        membershipTier: u.membershipTier,
        customDiscount: u.customDiscount || 0,
        effectiveDiscount: effectiveDiscount,
        apiEnabled: u.apiEnabled,
        apiKey: u.apiKey,
        apiSiteName: u.apiSiteName,
        apiSiteUrl: u.apiSiteUrl
      }
    });
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Failed to fetch user profile" });
  }
});

// POST /api/users/update-credentials - Update self profile credentials (username, email, password, phone)
router.post("/update-credentials", authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "غير مصرح لك" });

    const { username, email, phone, newPassword, currentPassword } = req.body;
    if (!currentPassword) {
      return res.status(400).json({ error: "الرجاء إدخال كلمة المرور الحالية للتأكيد" });
    }

    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) return res.status(404).json({ error: "المستخدم غير موجود" });

    const isMatch = await bcrypt.compare(currentPassword, currentUser.password);
    if (!isMatch) return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });

    const updateData: any = {};

    if (username && username !== currentUser.username) {
      const existingUser = await prisma.user.findUnique({ where: { username } });
      if (existingUser) return res.status(400).json({ error: "اسم المستخدم مسجل بالفعل" });
      updateData.username = username;
    }

    if (email && email !== currentUser.email) {
      const existingEmail = await prisma.user.findUnique({ where: { email } });
      if (existingEmail) return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل" });
      updateData.email = email;
    }

    if (phone !== undefined && phone !== currentUser.phone) {
      updateData.phone = phone ? String(phone).trim() : null;
    }

    if (newPassword) {
      if (newPassword.length < 4) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن لا تقل عن 4 أحرف" });
      updateData.password = await bcrypt.hash(newPassword, 10);
    }

    if (Object.keys(updateData).length === 0) {
      return res.json({ success: true, message: "لم يتم إجراء أي تعديلات" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData
    });

    return res.json({
      success: true,
      message: "تم تحديث بيانات الدخول بنجاح",
      user: {
        id: updatedUser.id,
        username: updatedUser.username,
        email: updatedUser.email,
        phone: updatedUser.phone
      }
    });
  } catch (error: any) {
    console.error("Error updating credentials:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تحديث البيانات" });
  }
});

// POST Register new user
router.post("/register", async (req, res) => {
  try {
    const { fullName, email, username, password, country, phone } = req.body;

    if (!fullName || !email || !username || !password) {
      return res.status(400).json({ error: "الرجاء تعبئة جميع الحقول المطلوبة" });
    }

    const existingEmail = await prisma.user.findUnique({ where: { email } });
    if (existingEmail) {
      return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل" });
    }

    const existingUsername = await prisma.user.findUnique({ where: { username } });
    if (existingUsername) {
      return res.status(400).json({ error: "اسم المستخدم مسجل بالفعل" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        fullName,
        email,
        username,
        password: hashedPassword,
        phone: phone ? String(phone).trim() : null,
        country: country || "EG",
        status: "active"
      }
    });

    return res.json({
      success: true,
      message: "تم إنشاء الحساب بنجاح",
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        email: newUser.email,
        username: newUser.username,
        phone: newUser.phone,
        country: newUser.country,
        status: newUser.status
      }
    });
  } catch (error: any) {
    console.error("Registration error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إكمال التسجيل" });
  }
});

// POST Toggle User Status (Activate / Suspend)
router.post("/toggle-status", isAdmin, async (req, res) => {
  try {
    const { userId, newStatus } = req.body;
    if (!userId || !newStatus) {
      return res.status(400).json({ error: "userId and newStatus are required" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (targetUser?.role === 'admin') {
      return res.status(400).json({ success: false, error: 'لا يمكن إيقاف حساب الأدمن الرئيسي' });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { status: newStatus }
    });

    return res.json({
      success: true,
      user: updatedUser,
      message: newStatus === "suspended" ? "تم إيقاف حساب المستخدم بنجاح" : "تم تفعيل حساب المستخدم بنجاح"
    });
  } catch (error: any) {
    console.error("Error toggling user status:", error);
    return res.status(500).json({ error: "Failed to update user status" });
  }
});

// DELETE User
router.delete("/:id", isAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.user.delete({ where: { id: id as string } });
    return res.json({ success: true, message: "تم حذف المستخدم بنجاح" });
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

// POST /api/users/change-password - Admin change user password
router.post("/change-password", isAdmin, async (req, res) => {
  try {
    const { userId, newPassword } = req.body;
    if (!userId || !newPassword) {
      return res.status(400).json({ error: "الرجاء إدخال معرف المستخدم وكلمة المرور الجديدة" });
    }

    if (newPassword.length < 4) {
      return res.status(400).json({ error: "كلمة المرور يجب أن لا تقل عن 4 أحرف" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword }
    });

    console.log(`[DB persisted] Password updated for userId: ${userId}`);

    return res.json({
      success: true,
      message: "تم تغيير كلمة المرور للمستخدم بنجاح"
    });
  } catch (error: any) {
    console.error("Error changing password:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تغيير كلمة المرور" });
  }
});

// POST /api/users/update-balance - Admin manually update user wallet balance
router.post("/update-balance", isAdmin, async (req, res) => {
  try {
    const { userId, newBalance, action, amount } = req.body;
    if (!userId) {
      return res.status(400).json({ error: "معرف المستخدم مطلوب" });
    }

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    let updatedBalance = existingUser.balance;

    if (newBalance !== undefined && newBalance !== null && !isNaN(parseFloat(newBalance))) {
      updatedBalance = parseFloat(newBalance);
    } else if (action === "add" && amount) {
      updatedBalance = existingUser.balance + parseFloat(amount);
    } else if (action === "subtract" && amount) {
      updatedBalance = Math.max(0, existingUser.balance - parseFloat(amount));
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { balance: updatedBalance }
    });

    const upgraded = await checkAndAutoUpgradeMembership(userId, amount ? parseFloat(amount) : undefined);

    console.log(`[Admin Manual Balance Edit] User ${updatedUser.username} (${updatedUser.email}) -> New Balance: $${updatedUser.balance}`);

    return res.json({
      success: true,
      message: `تم تعديل رصيد المستخدم (${updatedUser.fullName}) بنجاح إلى $${updatedUser.balance.toFixed(2)} USD!`,
      user: upgraded || updatedUser
    });
  } catch (error: any) {
    console.error("Error updating balance:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تعديل رصيد المستخدم" });
  }
});

// POST /api/users/update-api-settings - Admin update user API settings
router.post("/update-api-settings", isAdmin, async (req, res) => {
  try {
    const { userId, apiEnabled, apiSiteName, apiSiteUrl, apiMargin } = req.body;
    if (!userId) return res.status(400).json({ error: "معرف المستخدم مطلوب" });

    // Generate API key if enabling for the first time
    let apiKey = req.body.apiKey;
    if (apiEnabled && !apiKey) {
      apiKey = "ATS-" + require('crypto').randomBytes(16).toString('hex');
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        apiEnabled: Boolean(apiEnabled),
        apiSiteName: apiSiteName || null,
        apiSiteUrl: apiSiteUrl || null,
        apiMargin: parseFloat(apiMargin) || 0.0,
        ...(apiKey && { apiKey })
      }
    });

    return res.json({
      success: true,
      message: "تم تحديث إعدادات الـ API بنجاح",
      user: updatedUser
    });
  } catch (error: any) {
    console.error("Error updating API settings:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تحديث إعدادات API" });
  }
});

// POST /api/users/request-api - Client confirms and activates API access immediately
router.post("/request-api", authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "غير مصرح لك" });

    const currentUser = await prisma.user.findUnique({
      where: { id: userId },
      select: { apiKey: true }
    });
    if (!currentUser) return res.status(404).json({ error: "المستخدم غير موجود" });

    let activationData;
    try {
      activationData = prepareApiActivation(
        req.body,
        currentUser.apiKey,
        () => "ATS-" + require('crypto').randomBytes(16).toString('hex')
      );
    } catch (validationError: any) {
      return res.status(400).json({ error: validationError.message || "بيانات تفعيل API غير صحيحة" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: activationData,
      select: {
        apiEnabled: true,
        apiKey: true,
        apiSiteName: true,
        apiSiteUrl: true
      }
    });

    return res.json({
      success: true,
      message: "تم تأكيد وتفعيل API فوراً بنجاح",
      user: updatedUser
    });
  } catch (error: any) {
    console.error("Error activating API:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تفعيل API" });
  }
});

// POST /api/users/update-api-settings - Admin update user API settings
router.post("/update-api-settings", authenticateToken, isAdmin, async (req: any, res) => {
  try {
    const { userId, apiEnabled, apiMargin } = req.body;

    if (!userId) {
      return res.status(400).json({ error: "User ID is required" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        apiEnabled: Boolean(apiEnabled),
        apiMargin: parseFloat(apiMargin) || 0
      }
    });

    return res.json({
      success: true,
      message: "تم تحديث إعدادات API بنجاح",
      user: {
        apiEnabled: updatedUser.apiEnabled,
        apiMargin: updatedUser.apiMargin,
        apiKey: updatedUser.apiKey
      }
    });
  } catch (error: any) {
    console.error("Error updating API settings:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تحديث إعدادات API" });
  }
});

// POST /api/users/regenerate-api-key - Client regenerate API key
router.post("/regenerate-api-key", authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "غير مصرح لك" });

    const apiKey = "ATS-" + require('crypto').randomBytes(16).toString('hex');

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: { apiKey }
    });

    return res.json({
      success: true,
      message: "تم توليد مفتاح API جديد بنجاح",
      apiKey
    });
  } catch (error: any) {
    console.error("Error regenerating API key:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء توليد المفتاح" });
  }
});

export default router;
