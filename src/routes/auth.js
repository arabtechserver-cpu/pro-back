"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const server_1 = require("../server");
const auth_1 = require("../middleware/auth");
const emailService_1 = require("../utils/emailService");
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const router = (0, express_1.Router)();
// In-memory OTP Store for forgot password flow
const otpStore = new Map();
// POST /api/auth/register - Direct & Fast Registration
router.post('/register', async (req, res) => {
    try {
        const { fullName, email, username, password, country, phone } = req.body;
        if (!fullName || !email || !username || !password) {
            return res.status(200).json({ success: false, error: 'الرجاء تعبئة جميع الحقول المطلوبة' });
        }
        const cleanEmail = email.trim().toLowerCase();
        const cleanUsername = username.trim().toLowerCase();
        const cleanPhone = phone ? String(phone).trim() : null;
        const existingEmail = await server_1.prisma.user.findUnique({ where: { email: cleanEmail } });
        if (existingEmail) {
            return res.status(200).json({ success: false, error: 'البريد الإلكتروني مسجل بالفعل في الموقع!' });
        }
        const existingUsername = await server_1.prisma.user.findUnique({ where: { username: cleanUsername } });
        if (existingUsername) {
            return res.status(200).json({ success: false, error: 'اسم المستخدم مسجل بالفعل! اختر اسم آخر.' });
        }
        const hashedPassword = await bcryptjs_1.default.hash(password, 10);
        const newUser = await server_1.prisma.user.create({
            data: {
                fullName: fullName.trim(),
                email: cleanEmail,
                username: cleanUsername,
                password: hashedPassword,
                phone: cleanPhone,
                country: country || 'EG',
                status: 'active',
                balance: 0.0
            }
        });
        (0, emailService_1.addContactToLoops)(cleanEmail, fullName.trim()).catch(() => { });
        console.log(`[Fast Registration DB] New user created instantly: ${newUser.username} (${newUser.email})`);
        const token = (0, auth_1.generateToken)({ id: newUser.id, email: newUser.email, role: newUser.role });
        return res.json({
            success: true,
            token,
            message: 'تم إنشاء الحساب وحفظه في قاعدة البيانات بنجاح',
            user: {
                id: newUser.id,
                fullName: newUser.fullName,
                email: newUser.email,
                username: newUser.username,
                phone: newUser.phone,
                country: newUser.country,
                status: newUser.status,
                balance: newUser.balance
            }
        });
    }
    catch (error) {
        console.error('Registration DB error:', error);
        return res.status(200).json({ success: false, error: 'حدث خطأ أثناء حفظ بيانات المستخدم في قاعدة البيانات' });
    }
});
// POST /api/auth/send-otp - Send OTP via Loops Email
router.post('/send-otp', async (req, res) => {
    try {
        const { email, username, type } = req.body;
        if (!email || !email.includes('@')) {
            return res.status(200).json({ success: false, error: 'الرجاء إدخال بريد إلكتروني صحيح' });
        }
        const cleanEmail = email.trim().toLowerCase();
        if (type === 'forgot_password') {
            const userObj = await server_1.prisma.user.findUnique({ where: { email: cleanEmail } });
            if (!userObj) {
                return res.status(200).json({ success: false, error: 'لم يتم العثور على حساب مرتبط بهذا البريد الإلكتروني!' });
            }
        }
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const expiresAt = Date.now() + 10 * 60 * 1000;
        otpStore.set(cleanEmail, { code: otpCode, expiresAt });
        (0, emailService_1.sendOtpEmailViaLoops)(cleanEmail, {
            code: otpCode,
            username: username || 'عزيزنا العميل',
            actionLabel: type === 'forgot_password' ? 'استعادة كلمة المرور' : 'تأكيد الحساب'
        }).catch(() => { });
        console.log(`[Loops OTP Sent] ${cleanEmail} -> ${otpCode}`);
        return res.json({
            success: true,
            message: `تم إرسال كود التحقق بنجاح إلى: ${cleanEmail}`,
            devOtp: otpCode
        });
    }
    catch (error) {
        return res.status(200).json({ success: false, error: 'حدث خطأ أثناء إرسال كود التحقق' });
    }
});
// POST /api/auth/forgot-password - Reset password using Loops OTP
router.post('/forgot-password', async (req, res) => {
    try {
        const { email, otp, newPassword } = req.body;
        if (!email || !otp || !newPassword) {
            return res.status(200).json({ success: false, error: 'البريد الإلكتروني، كود OTP، وكلمة المرور الجديدة مطلوبة' });
        }
        const cleanEmail = email.trim().toLowerCase();
        const record = otpStore.get(cleanEmail);
        if (!record || record.code !== otp.trim() || Date.now() > record.expiresAt) {
            return res.status(200).json({ success: false, error: 'كود التحقق (OTP) غير صحيح أو منتهي الصلاحية' });
        }
        const userObj = await server_1.prisma.user.findUnique({ where: { email: cleanEmail } });
        if (!userObj) {
            return res.status(200).json({ success: false, error: 'لم يتم العثور على حساب بهذا البريد الإلكتروني' });
        }
        const hashedPassword = await bcryptjs_1.default.hash(newPassword, 10);
        await server_1.prisma.user.update({
            where: { id: userObj.id },
            data: { password: hashedPassword }
        });
        otpStore.delete(cleanEmail);
        console.log(`[Forgot Password Reset] Password updated for ${cleanEmail}`);
        return res.json({
            success: true,
            message: 'تم إعادة تعيين كلمة المرور بنجاح! يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.'
        });
    }
    catch (error) {
        console.error('Forgot password error:', error);
        return res.status(200).json({ success: false, error: 'حدث خطأ أثناء تغيير كلمة المرور' });
    }
});
// POST /api/auth/login - Fast Login Authentication
router.post('/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        if (!email || !password) {
            return res.status(200).json({ success: false, error: 'البريد الإلكتروني وكلمة المرور مطلوبان' });
        }
        const inputStr = email.trim().toLowerCase();
        // Admin check:
        if ((inputStr === 'admin@gsmteam.com' || inputStr === 'admin') && password === 'admin123') {
            const token = (0, auth_1.generateToken)({ id: 'admin_1', email: 'admin@gsmteam.com', role: 'admin' });
            return res.json({ success: true, token, user: { email: 'admin@gsmteam.com', role: 'admin' } });
        }
        // Check DB for registered user by email or username
        const dbUser = await server_1.prisma.user.findFirst({
            where: {
                OR: [
                    { email: inputStr },
                    { username: inputStr }
                ]
            }
        });
        if (!dbUser) {
            return res.status(200).json({ success: false, error: 'بيانات الدخول غير صحيحة!' });
        }
        if (dbUser.status === 'suspended') {
            return res.status(200).json({ success: false, error: 'عذراً، هذا الحساب موقوف حالياً من قبل الإدارة 🔴' });
        }
        const isMatch = await bcryptjs_1.default.compare(password, dbUser.password);
        if (!isMatch) {
            return res.status(200).json({ success: false, error: 'كلمة المرور غير صحيحة!' });
        }
        const token = (0, auth_1.generateToken)({ id: dbUser.id, email: dbUser.email, role: dbUser.role });
        return res.json({
            success: true,
            token,
            user: {
                id: dbUser.id,
                fullName: dbUser.fullName,
                email: dbUser.email,
                username: dbUser.username,
                phone: dbUser.phone,
                country: dbUser.country,
                status: dbUser.status,
                balance: dbUser.balance,
                role: dbUser.role
            }
        });
    }
    catch (error) {
        console.error('Login DB error:', error);
        return res.status(200).json({ success: false, error: 'حدث خطأ أثناء تسجيل الدخول' });
    }
});
exports.default = router;
