import { Router } from 'express';
import { prisma } from '../server';
import { generateToken } from '../middleware/auth';
import { sendOtpEmailViaLoops, addContactToLoops } from '../utils/emailService';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';

const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 15,
  message: { success: false, error: 'تجاوزت الحد المسموح به، يرجى المحاولة بعد قليل.' }
});

router.use(authLimiter);

// In-memory OTP Store for forgot password flow
const otpStore = new Map<string, { code: string; expiresAt: number }>();

// POST /api/auth/register - Direct & Fast Registration
router.post('/register', async (req, res) => {
  try {
    const { fullName, email, username, password, country } = req.body;

    if (!fullName || !email || !username || !password) {
      return res.status(200).json({ success: false, error: 'الرجاء تعبئة جميع الحقول المطلوبة' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();

    const existingEmail = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (existingEmail) {
      return res.status(200).json({ success: false, error: 'البريد الإلكتروني مسجل بالفعل في الموقع!' });
    }

    const existingUsername = await prisma.user.findUnique({ where: { username: cleanUsername } });
    if (existingUsername) {
      return res.status(200).json({ success: false, error: 'اسم المستخدم مسجل بالفعل! اختر اسم آخر.' });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = await prisma.user.create({
      data: {
        fullName: fullName.trim(),
        email: cleanEmail,
        username: cleanUsername,
        password: hashedPassword,
        country: country || 'EG',
        status: 'active',
        balance: 0.0
      }
    });

    addContactToLoops(cleanEmail, fullName.trim()).catch(() => {});

    const token = generateToken({ id: newUser.id, email: newUser.email, role: newUser.role });

    return res.json({
      success: true,
      token,
      message: 'تم إنشاء الحساب وحفظه في قاعدة البيانات بنجاح',
      user: {
        id: newUser.id,
        fullName: newUser.fullName,
        email: newUser.email,
        username: newUser.username,
        country: newUser.country,
        status: newUser.status,
        balance: newUser.balance
      }
    });
  } catch (error: any) {
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
      const userObj = await prisma.user.findUnique({ where: { email: cleanEmail } });
      if (!userObj) {
        return res.status(200).json({ success: false, error: 'لم يتم العثور على حساب مرتبط بهذا البريد الإلكتروني!' });
      }
    }

    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(cleanEmail, { code: otpCode, expiresAt });

    sendOtpEmailViaLoops(cleanEmail, {
      code: otpCode,
      username: username || 'عزيزنا العميل',
      actionLabel: type === 'forgot_password' ? 'استعادة كلمة المرور' : 'تأكيد الحساب'
    }).catch(() => {});

    return res.json({
      success: true,
      message: `تم إرسال كود التحقق بنجاح إلى: ${cleanEmail}`,
      devOtp: otpCode
    });
  } catch (error: any) {
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

    const userObj = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!userObj) {
      return res.status(200).json({ success: false, error: 'لم يتم العثور على حساب بهذا البريد الإلكتروني' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userObj.id },
      data: { password: hashedPassword }
    });

    otpStore.delete(cleanEmail);

    return res.json({
      success: true,
      message: 'تم إعادة تعيين كلمة المرور بنجاح! يمكنك الآن تسجيل الدخول بكلمة المرور الجديدة.'
    });
  } catch (error: any) {
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

    // Check DB for registered user by email or username
    const dbUser = await prisma.user.findFirst({
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

    if (dbUser.role !== 'admin' && dbUser.status === 'suspended') {
      return res.status(200).json({ success: false, error: 'عذراً، هذا الحساب موقوف حالياً من قبل الإدارة 🔴' });
    }

    const isMatch = await bcrypt.compare(password, dbUser.password);
    if (!isMatch) {
      return res.status(200).json({ success: false, error: 'كلمة المرور غير صحيحة!' });
    }

    const token = generateToken({ id: dbUser.id, email: dbUser.email, role: dbUser.role });

    return res.json({
      success: true,
      token,
      user: {
        id: dbUser.id,
        fullName: dbUser.fullName,
        email: dbUser.email,
        username: dbUser.username,
        country: dbUser.country,
        status: dbUser.status,
        balance: dbUser.balance,
        role: dbUser.role
      }
    });
  } catch (error: any) {
    console.error('Login DB error:', error);
    return res.status(200).json({ success: false, error: 'حدث خطأ أثناء تسجيل الدخول' });
  }
});

// POST /api/auth/google - Google Sign-In & One-Tap Authentication
router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ success: false, error: 'Google credential token is required' });
    }

    // Verify token with Google's public tokeninfo endpoint
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!verifyRes.ok) {
      return res.status(401).json({ success: false, error: 'فشل التحقق من حساب Google' });
    }

    const payload = await verifyRes.json();
    const { email, name, sub: googleId, picture } = payload;

    if (!email) {
      return res.status(400).json({ success: false, error: 'لم يتم العثور على بريد إلكتروني مرتبط بحساب Google' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user already exists
    let user = await prisma.user.findFirst({
      where: { email: cleanEmail }
    });

    if (!user) {
      // Create new user automatically
      const generatedUsername = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') + '_' + Math.random().toString(36).substring(2, 5);
      const randomPassword = await bcrypt.hash(Math.random().toString(36) + Date.now(), 10);

      user = await prisma.user.create({
        data: {
          fullName: name || cleanEmail.split('@')[0],
          email: cleanEmail,
          username: generatedUsername.toLowerCase(),
          password: randomPassword,
          country: 'EG',
          status: 'active',
          balance: 0.0,
          role: 'user'
        }
      });

      addContactToLoops(cleanEmail, name || cleanEmail.split('@')[0]).catch(() => {});
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'عذراً، هذا الحساب موقوف حالياً من قبل الإدارة 🔴' });
    }

    const token = generateToken({ id: user.id, email: user.email, role: user.role });

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        username: user.username,
        country: user.country,
        status: user.status,
        balance: user.balance,
        role: user.role
      }
    });
  } catch (error: any) {
    console.error('Google Auth error:', error);
    return res.status(500).json({ success: false, error: 'حدث خطأ أثناء تسجيل الدخول بحساب Google' });
  }
});

export default router;
