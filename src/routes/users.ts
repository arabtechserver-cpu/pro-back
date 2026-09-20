import { Router } from "express";
import { prisma } from "../utils/prisma";
import bcrypt from "bcryptjs";
import { isAdmin, authenticateToken } from "../middleware/auth";
import { dashboardIpGuard } from "../middleware/dashboardIpGuard";
import { checkAndAutoUpgradeMembership } from "../utils/membershipUpgrade";
import { prepareApiActivation } from "../utils/api-activation";

const router = Router();

export const safeUserSelect = {
  id: true,
  fullName: true,
  email: true,
  username: true,
  phone: true,
  country: true,
  role: true,
  status: true,
  balance: true,
  membershipTierId: true,
  membershipTier: true,
  customDiscount: true,
  apiEnabled: true,
  apiSiteName: true,
  apiSiteUrl: true,
  apiMargin: true,
  createdAt: true,
  updatedAt: true
};

// GET all registered users for Admin Dashboard
router.get("/", isAdmin, async (req, res) => {
  try {
    const { q, status, apiOnly } = req.query;

    const whereClause: any = {
      AND: []
    };
    
    // Exclude admins only for the regular users list, not for API users
    if (apiOnly !== 'true') {
      whereClause.role = { not: 'admin' };
    }

    if (status && status !== "all") {
      whereClause.status = String(status);
    }

    if (apiOnly === "true") {
      whereClause.apiEnabled = true;
    }

    if (q && typeof q === 'string' && q.trim()) {
      const searchStr = q.trim();
      whereClause.AND.push({
        OR: [
          { username: { contains: searchStr, mode: 'insensitive' } },
          { email: { contains: searchStr, mode: 'insensitive' } },
          { fullName: { contains: searchStr, mode: 'insensitive' } },
          { country: { contains: searchStr, mode: 'insensitive' } }
        ]
      });
    }

    if (whereClause.AND.length === 0) {
      delete whereClause.AND;
    }

    const users = await prisma.user.findMany({
      where: whereClause,
      select: safeUserSelect,
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
    console.error("Fetch users error:", error);
    return res.status(500).json({ error: "فشل جلب قائمة المستخدمين" });
  }
});

// GET /api/users/profile - Fetch live user profile & balance
router.get("/profile", authenticateToken, async (req: any, res) => {
  try {
    const { email, userId } = req.query;
    const requestedId = userId ? String(userId) : null;
    const requestedEmail = email ? String(email).trim().toLowerCase() : null;
    const authUser = req.user;

    const executeProfileFetch = async () => {
      let u: any = null;
      const isAdminUser = authUser && ['admin', 'super_admin'].includes(authUser.role);

      if (isAdminUser) {
        if (requestedId) {
          u = await prisma.user.findUnique({ where: { id: requestedId }, select: safeUserSelect });
        } else if (requestedEmail) {
          u = await prisma.user.findUnique({ where: { email: requestedEmail }, select: safeUserSelect });
        } else {
          u = await prisma.user.findUnique({ where: { id: authUser.id }, select: safeUserSelect });
        }
      } else {
        u = await prisma.user.findUnique({ where: { id: authUser.id }, select: safeUserSelect });
      }

      if (!u) {
        return res.status(404).json({ success: false, error: "User not found" });
      }

      await checkAndAutoUpgradeMembership(u.id);

      const effectiveDiscount = Math.max(
        u.customDiscount || 0,
        u.membershipTier?.discountPercentage || 0
      );

      return res.json({
        success: true,
        user: {
          ...u,
          effectiveDiscount
        }
      });
    };

    const isInspectingOther = authUser && ['admin', 'super_admin'].includes(authUser.role) && (
      (requestedId && requestedId !== authUser.id) ||
      (requestedEmail && requestedEmail !== authUser.email)
    );

    if (isInspectingOther) {
      return dashboardIpGuard(req, res, executeProfileFetch);
    }

    return executeProfileFetch();
  } catch (error: any) {
    return res.status(500).json({ success: false, error: "Failed to fetch user profile" });
  }
});

// POST /api/users/update-credentials - Update self profile credentials
router.post("/update-credentials", authenticateToken, async (req: any, res) => {
  try {
    const userId = req.user?.id;
    if (!userId) return res.status(401).json({ error: "غير مصرح لك" });

    const { fullName, username, email, phone, newPassword, currentPassword } = req.body;
    if (!currentPassword) {
      return res.status(400).json({ error: "الرجاء إدخال كلمة المرور الحالية للتأكيد" });
    }

    const currentUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!currentUser) return res.status(404).json({ error: "المستخدم غير موجود" });

    const isMatch = await bcrypt.compare(currentPassword, currentUser.password);
    if (!isMatch) return res.status(400).json({ error: "كلمة المرور الحالية غير صحيحة" });

    const updateData: any = {};

    if (fullName && fullName.trim() && fullName.trim() !== currentUser.fullName) {
      updateData.fullName = fullName.trim();
    }

    if (username && username.trim() !== currentUser.username) {
      const normalizedUsername = username.trim();
      const existingUser = await prisma.user.findUnique({ where: { username: normalizedUsername } });
      if (existingUser) return res.status(400).json({ error: "اسم المستخدم مسجل بالفعل" });
      updateData.username = normalizedUsername;
    }

    if (email) {
      const normalizedEmail = String(email).trim().toLowerCase();
      if (normalizedEmail !== currentUser.email) {
        const existingEmail = await prisma.user.findUnique({ where: { email: normalizedEmail } });
        if (existingEmail) return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل" });
        updateData.email = normalizedEmail;
      }
    }

    if (phone !== undefined && phone !== currentUser.phone) {
      updateData.phone = phone ? String(phone).trim() : null;
    }

    if (newPassword) {
      if (newPassword.length < 8) return res.status(400).json({ error: "كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف" });
      updateData.password = await bcrypt.hash(newPassword, 10);
      updateData.tokenVersion = { increment: 1 };
    }

    if (Object.keys(updateData).length === 0) {
      return res.json({ success: true, message: "لم يتم إجراء أي تعديلات" });
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: safeUserSelect
    });

    return res.json({
      success: true,
      message: "تم تحديث بيانات الحساب بنجاح",
      user: updatedUser
    });
  } catch (error: any) {
    console.error("Error updating credentials:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تحديث البيانات" });
  }
});

// POST Toggle User Status (Activate / Suspend)
router.post("/toggle-status", isAdmin, async (req: any, res) => {
  try {
    const { userId, newStatus } = req.body;
    if (!userId || !newStatus) {
      return res.status(400).json({ error: "userId and newStatus are required" });
    }

    const callerId = req.user?.id;
    if (callerId === userId) {
      return res.status(400).json({ success: false, error: "لا يمكن تعطيل حسابك الحالي" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return res.status(404).json({ success: false, error: "المستخدم غير موجود" });
    }

    if (['admin', 'super_admin'].includes(targetUser.role)) {
      return res.status(403).json({ success: false, error: "لا يمكن تعديل حالة حسابات المسؤولين" });
    }

    const updateData: any = { status: newStatus };
    if (newStatus === "suspended") {
      updateData.tokenVersion = { increment: 1 };
    }

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: updateData,
      select: safeUserSelect
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
router.delete("/:id", isAdmin, async (req: any, res) => {
  try {
    const { id } = req.params;
    const callerId = req.user?.id;
    const callerRole = req.user?.role;

    if (callerId === id) {
      return res.status(400).json({ error: "لا يمكن حذف حسابك الحالي" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: id as string } });
    if (!targetUser) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (['admin', 'super_admin'].includes(targetUser.role)) {
      if (callerRole !== 'super_admin') {
        return res.status(403).json({ error: "غير مصرح لك بحذف حسابات المسؤولين" });
      }
      if (targetUser.role === 'super_admin') {
        return res.status(403).json({ error: "لا يمكن حذف حساب المدير العام" });
      }
    }

    const hasFinancialRecords = await prisma.transaction.findFirst({ where: { userId: id as string } }) ||
      await prisma.order.findFirst({ where: { userId: id as string } });

    if (hasFinancialRecords) {
      await prisma.user.update({
        where: { id: id as string },
        data: {
          status: 'suspended',
          deletedAt: new Date(),
          tokenVersion: { increment: 1 }
        }
      });
      return res.json({ success: true, message: "تم إيقاف حساب المستخدم وأرشفته للحفاظ على السجلات المالية" });
    }

    await prisma.user.delete({ where: { id: id as string } });
    return res.json({ success: true, message: "تم حذف المستخدم بنجاح" });
  } catch (error: any) {
    console.error("Error deleting user:", error);
    return res.status(500).json({ error: "Failed to delete user" });
  }
});

// POST /api/users/change-password - Admin change user password
router.post("/change-password", isAdmin, async (req: any, res) => {
  try {
    const { userId, newPassword } = req.body;
    const callerId = req.user?.id;
    const callerRole = req.user?.role;

    if (!userId || !newPassword) {
      return res.status(400).json({ error: "الرجاء إدخال معرف المستخدم وكلمة المرور الجديدة" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "كلمة المرور يجب أن لا تقل عن 8 أحرف" });
    }

    const targetUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!targetUser) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (['admin', 'super_admin'].includes(targetUser.role)) {
      if (targetUser.role === 'super_admin' && callerId !== targetUser.id) {
        return res.status(403).json({ error: "لا يمكن إعادة تعيين كلمة مرور المدير العام من هذه الواجهة" });
      }
      if (callerRole !== 'super_admin' && callerId !== targetUser.id) {
        return res.status(403).json({ error: "غير مصرح لك بتغيير كلمة مرور حسابات المسؤولين" });
      }
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);

    await prisma.user.update({
      where: { id: userId },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 }
      }
    });

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
router.post("/update-balance", isAdmin, async (req: any, res) => {
  try {
    const { userId, newBalance, action, amount, reason } = req.body;
    const callerId = req.user?.id;
    const callerRole = req.user?.role;

    if (!userId) {
      return res.status(400).json({ error: "معرف المستخدم مطلوب" });
    }

    if (callerId === userId && callerRole !== 'super_admin') {
      return res.status(403).json({ error: "غير مصرح لك بتعديل رصيد حسابك الشخصي" });
    }

    const existingUser = await prisma.user.findUnique({ where: { id: userId } });
    if (!existingUser) {
      return res.status(404).json({ error: "المستخدم غير موجود" });
    }

    if (['admin', 'super_admin'].includes(existingUser.role) && callerRole !== 'super_admin' && callerId !== existingUser.id) {
      return res.status(403).json({ error: "غير مصرح لك بتعديل أرصدة حسابات المسؤولين" });
    }

    const refNo = "ADJ-" + Date.now().toString(36).toUpperCase() + "-" + Math.random().toString(36).substring(2, 6).toUpperCase();

    const { updatedUser, delta } = await prisma.$transaction(async (tx) => {
      const freshUser = await tx.user.findUnique({ where: { id: userId } });
      if (!freshUser) {
        throw new Error("USER_NOT_FOUND");
      }

      let finalDelta = 0;
      let finalType = "manual_adjustment_credit";

      if (newBalance !== undefined && newBalance !== null && !isNaN(parseFloat(newBalance))) {
        const target = Math.max(0, parseFloat(newBalance));
        finalDelta = target - freshUser.balance;
        finalType = finalDelta >= 0 ? "manual_adjustment_credit" : "manual_adjustment_debit";
      } else if (action === "add" && amount) {
        finalDelta = Math.abs(parseFloat(amount));
        finalType = "manual_adjustment_credit";
      } else if (action === "subtract" && amount) {
        finalDelta = -Math.abs(parseFloat(amount));
        finalType = "manual_adjustment_debit";
      }

      const uUser = await tx.user.update({
        where: { id: userId },
        data: { balance: { increment: finalDelta } },
        select: safeUserSelect
      });

      await tx.transaction.create({
        data: {
          userId,
          amount: Math.abs(finalDelta),
          type: finalType,
          status: "completed",
          method: "admin_adjustment",
          refNo,
          adminActorId: callerId,
          notes: reason ? String(reason).trim() : `Manual balance adjustment by admin ${callerId}`
        }
      });

      return { updatedUser: uUser, delta: Math.abs(finalDelta) };
    });

    const upgraded = await checkAndAutoUpgradeMembership(userId, delta);

    return res.json({
      success: true,
      message: `تم تعديل رصيد المستخدم (${updatedUser.fullName}) بنجاح إلى $${updatedUser.balance.toFixed(2)} USD`,
      user: upgraded || updatedUser
    });
  } catch (error: any) {
    console.error("Error updating balance:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تعديل رصيد المستخدم" });
  }
});

// POST /api/users/update-api-settings - Admin update user API settings
router.post("/update-api-settings", isAdmin, async (req: any, res) => {
  try {
    const { userId, apiEnabled, apiSiteName, apiSiteUrl, apiMargin } = req.body;
    if (!userId) return res.status(400).json({ error: "معرف المستخدم مطلوب" });

    let apiKey = req.body.apiKey;
    if (apiEnabled && !apiKey) {
      apiKey = "ATS-" + require('crypto').randomBytes(16).toString('hex');
    }

    const marginValue = apiMargin !== undefined && apiMargin !== null && !isNaN(parseFloat(apiMargin))
      ? parseFloat(apiMargin)
      : 8.0;

    const updatedUser = await prisma.user.update({
      where: { id: userId },
      data: {
        apiEnabled: Boolean(apiEnabled),
        apiSiteName: apiSiteName !== undefined ? (apiSiteName ? String(apiSiteName).trim() : null) : undefined,
        apiSiteUrl: apiSiteUrl !== undefined ? (apiSiteUrl ? String(apiSiteUrl).trim() : null) : undefined,
        apiMargin: marginValue,
        ...(apiKey && { apiKey })
      },
      select: safeUserSelect
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
      select: { apiKey: true, role: true }
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
      data: {
        ...activationData,
        apiMargin: 8.0
      },
      select: {
        apiEnabled: true,
        apiKey: true,
        apiSiteName: true,
        apiSiteUrl: true,
        apiMargin: true
      }
    });

    return res.json({
      success: true,
      message: "تم تأكيد وتفعيل API فوراً بنجاح بنسبة ربح 8%",
      user: updatedUser
    });
  } catch (error: any) {
    console.error("Error activating API:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تفعيل API" });
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
