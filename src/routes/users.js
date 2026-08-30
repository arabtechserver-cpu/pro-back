"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const server_1 = require("../server");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const router = (0, express_1.Router)();
// GET all registered users for Admin Dashboard
router.get("/", async (req, res) => {
    try {
        const { q, status } = req.query;
        const whereClause = {};
        if (status && status !== "all") {
            whereClause.status = String(status);
        }
        if (q) {
            const searchStr = String(q).toLowerCase();
            whereClause.OR = [
                { fullName: { contains: searchStr } },
                { email: { contains: searchStr } },
                { username: { contains: searchStr } },
                { phone: { contains: searchStr } },
                { country: { contains: searchStr } }
            ];
        }
        const users = await server_1.prisma.user.findMany({
            where: whereClause,
            orderBy: { createdAt: "desc" }
        });
        const totalUsers = await server_1.prisma.user.count();
        const activeUsers = await server_1.prisma.user.count({ where: { status: "active" } });
        const suspendedUsers = await server_1.prisma.user.count({ where: { status: "suspended" } });
        return res.json({
            users,
            stats: {
                total: totalUsers,
                active: activeUsers,
                suspended: suspendedUsers
            }
        });
    }
    catch (error) {
        console.error("Error fetching users:", error);
        return res.status(500).json({ error: "Failed to fetch users" });
    }
});
// GET /api/users/profile - Fetch live user profile & balance
router.get("/profile", async (req, res) => {
    try {
        const { email, userId } = req.query;
        let u = null;
        if (userId) {
            u = await server_1.prisma.user.findUnique({ where: { id: String(userId) } });
        }
        else if (email) {
            u = await server_1.prisma.user.findUnique({ where: { email: String(email).trim().toLowerCase() } });
        }
        if (!u) {
            return res.status(404).json({ error: "User not found" });
        }
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
                status: u.status
            }
        });
    }
    catch (error) {
        return res.status(500).json({ error: "Failed to fetch user profile" });
    }
});
// POST Register new user
router.post("/register", async (req, res) => {
    try {
        const { fullName, email, username, password, country, phone } = req.body;
        if (!fullName || !email || !username || !password) {
            return res.status(400).json({ error: "الرجاء تعبئة جميع الحقول المطلوبة" });
        }
        const existingEmail = await server_1.prisma.user.findUnique({ where: { email } });
        if (existingEmail) {
            return res.status(400).json({ error: "البريد الإلكتروني مسجل بالفعل" });
        }
        const existingUsername = await server_1.prisma.user.findUnique({ where: { username } });
        if (existingUsername) {
            return res.status(400).json({ error: "اسم المستخدم مسجل بالفعل" });
        }
        const hashedPassword = await bcryptjs_1.default.hash(password, 10);
        const newUser = await server_1.prisma.user.create({
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
    }
    catch (error) {
        console.error("Registration error:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء إكمال التسجيل" });
    }
});
// POST Toggle User Status (Activate / Suspend)
router.post("/toggle-status", async (req, res) => {
    try {
        const { userId, newStatus } = req.body;
        if (!userId || !newStatus) {
            return res.status(400).json({ error: "userId and newStatus are required" });
        }
        const updatedUser = await server_1.prisma.user.update({
            where: { id: userId },
            data: { status: newStatus }
        });
        return res.json({
            success: true,
            user: updatedUser,
            message: newStatus === "suspended" ? "تم إيقاف حساب المستخدم بنجاح" : "تم تفعيل حساب المستخدم بنجاح"
        });
    }
    catch (error) {
        console.error("Error toggling user status:", error);
        return res.status(500).json({ error: "Failed to update user status" });
    }
});
// DELETE User
router.delete("/:id", async (req, res) => {
    try {
        const { id } = req.params;
        await server_1.prisma.user.delete({ where: { id } });
        return res.json({ success: true, message: "تم حذف المستخدم بنجاح" });
    }
    catch (error) {
        console.error("Error deleting user:", error);
        return res.status(500).json({ error: "Failed to delete user" });
    }
});
// POST /api/users/change-password - Admin change user password
router.post("/change-password", async (req, res) => {
    try {
        const { userId, newPassword } = req.body;
        if (!userId || !newPassword) {
            return res.status(400).json({ error: "الرجاء إدخال معرف المستخدم وكلمة المرور الجديدة" });
        }
        if (newPassword.length < 4) {
            return res.status(400).json({ error: "كلمة المرور يجب أن لا تقل عن 4 أحرف" });
        }
        const hashedPassword = await bcryptjs_1.default.hash(newPassword, 10);
        await server_1.prisma.user.update({
            where: { id: userId },
            data: { password: hashedPassword }
        });
        console.log(`[DB persisted] Password updated for userId: ${userId}`);
        return res.json({
            success: true,
            message: "تم تغيير كلمة المرور للمستخدم بنجاح"
        });
    }
    catch (error) {
        console.error("Error changing password:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تغيير كلمة المرور" });
    }
});
// POST /api/users/update-balance - Admin manually update user wallet balance
router.post("/update-balance", async (req, res) => {
    try {
        const { userId, newBalance, action, amount } = req.body;
        if (!userId) {
            return res.status(400).json({ error: "معرف المستخدم مطلوب" });
        }
        const existingUser = await server_1.prisma.user.findUnique({ where: { id: userId } });
        if (!existingUser) {
            return res.status(404).json({ error: "المستخدم غير موجود" });
        }
        let updatedBalance = existingUser.balance;
        if (newBalance !== undefined && newBalance !== null && !isNaN(parseFloat(newBalance))) {
            updatedBalance = parseFloat(newBalance);
        }
        else if (action === "add" && amount) {
            updatedBalance = existingUser.balance + parseFloat(amount);
        }
        else if (action === "subtract" && amount) {
            updatedBalance = Math.max(0, existingUser.balance - parseFloat(amount));
        }
        const updatedUser = await server_1.prisma.user.update({
            where: { id: userId },
            data: { balance: updatedBalance }
        });
        console.log(`[Admin Manual Balance Edit] User ${updatedUser.username} (${updatedUser.email}) -> New Balance: $${updatedUser.balance}`);
        return res.json({
            success: true,
            message: `تم تعديل رصيد المستخدم (${updatedUser.fullName}) بنجاح إلى $${updatedUser.balance.toFixed(2)} USD!`,
            user: updatedUser
        });
    }
    catch (error) {
        console.error("Error updating balance:", error);
        return res.status(500).json({ error: "حدث خطأ أثناء تعديل رصيد المستخدم" });
    }
});
exports.default = router;
