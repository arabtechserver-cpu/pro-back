import { Router } from 'express';
import crypto from 'crypto';
import { prisma } from "../utils/prisma";
import { generateToken, authenticateToken } from '../middleware/auth';
import { sendOtpEmailViaLoops, addContactToLoops } from '../utils/emailService';
import { sendTelegramAlert, sendTelegramAdminOtp, sendTelegramAdminLoginSuccess } from '../utils/telegramService';
import { createAdminOtpChallenge, verifyAdminOtp, resendAdminOtp } from '../utils/adminOtp';
import { turnstileMiddleware } from '../middleware/turnstileMiddleware';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { extractClientIp } from '../utils/ipUtils';
import { checkIpAccess, logDashboardAccess } from '../services/ipAccessService';


const router = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'تجاوزت الحد المسموح به، يرجى المحاولة بعد قليل.' }
});

router.use(authLimiter);

// In-memory OTP Store for forgot password flow with brute force attempt tracking
interface UserOtpRecord {
  code: string;
  expiresAt: number;
  attempts: number;
}
const otpStore = new Map<string, UserOtpRecord>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of otpStore.entries()) {
    if (now > val.expiresAt) otpStore.delete(key);
  }
}, 15 * 60 * 1000).unref();

// POST /api/auth/register - Direct & Fast Registration with Cloudflare Turnstile Protection
router.post('/register', turnstileMiddleware, async (req, res) => {
  try {
    const { fullName, email, username, password, country, phone } = req.body;

    if (!fullName || !email || !username || !password) {
      return res.status(200).json({ success: false, error: 'الرجاء تعبئة جميع الحقول المطلوبة' });
    }

    if (password.length < 8) {
      return res.status(200).json({ success: false, error: 'كلمة المرور يجب أن لا تقل عن 8 أحرف' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanUsername = username.trim().toLowerCase();
    const cleanPhone = phone ? String(phone).trim() : null;

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
        phone: cleanPhone,
        country: country || 'EG',
        role: 'user',
        status: 'active',
        balance: 0.0
      }
    });

    addContactToLoops(cleanEmail, fullName.trim()).catch(() => {});

    // Notify Telegram Admins of new user registration
    const newRegMsg = `
<b>عميل جديد انضم للموقع (New Registration)</b>

- <b>الاسم:</b> ${newUser.fullName}
- <b>البريد:</b> <code>${newUser.email}</code>
- <b>اسم المستخدم:</b> @${newUser.username}
- <b>الهاتف:</b> <code>${newUser.phone || 'غير مسجل'}</code>
- <b>الدولة:</b> ${newUser.country}
- <b>التاريخ:</b> ${new Date().toLocaleString('ar-EG')}
    `.trim();

    sendTelegramAlert(newRegMsg).catch(() => {});

    const token = generateToken({
      id: newUser.id,
      email: newUser.email,
      role: newUser.role,
      tokenVersion: newUser.tokenVersion ?? 1
    }, '7d');

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
        role: newUser.role,
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

    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    otpStore.set(cleanEmail, { code: otpCode, expiresAt, attempts: 0 });

    console.log(`[AUTH OTP DISPATCH] Verification code queued for delivery`);

    sendOtpEmailViaLoops(cleanEmail, {
      code: otpCode,
      username: username || 'عزيزنا العميل',
      actionLabel: type === 'forgot_password' ? 'استعادة كلمة المرور' : 'تأكيد الحساب'
    }).catch(() => {});

    return res.json({
      success: true,
      message: `تم إرسال كود التحقق بنجاح إلى: ${cleanEmail}`
    });
  } catch (error: any) {
    return res.status(200).json({ success: false, error: 'حدث خطأ أثناء إرسال كود التحقق' });
  }
});

// POST /api/auth/forgot-password - Reset password with Cloudflare Turnstile Protection
router.post('/forgot-password', turnstileMiddleware, async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body;

    if (!email || !otp || !newPassword) {
      return res.status(200).json({ success: false, error: 'البريد الإلكتروني، كود OTP، وكلمة المرور الجديدة مطلوبة' });
    }

    if (newPassword.length < 8) {
      return res.status(200).json({ success: false, error: 'كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const record = otpStore.get(cleanEmail);

    if (!record || Date.now() > record.expiresAt) {
      if (record) otpStore.delete(cleanEmail);
      return res.status(200).json({ success: false, error: 'كود التحقق (OTP) غير صحيح أو منتهي الصلاحية' });
    }

    if (record.attempts >= 5) {
      otpStore.delete(cleanEmail);
      return res.status(200).json({ success: false, error: 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. الرجاء طلب كود جديد' });
    }

    if (record.code !== otp.trim()) {
      record.attempts += 1;
      return res.status(200).json({ success: false, error: 'كود التحقق (OTP) غير صحيح' });
    }

    const userObj = await prisma.user.findUnique({ where: { email: cleanEmail } });
    if (!userObj) {
      return res.status(200).json({ success: false, error: 'لم يتم العثور على حساب بهذا البريد الإلكتروني' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await prisma.user.update({
      where: { id: userObj.id },
      data: {
        password: hashedPassword,
        tokenVersion: { increment: 1 }
      }
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

// POST /api/auth/logout - Server-Side Session Invalidation
router.post('/logout', authenticateToken, async (req: any, res) => {
  try {
    if (req.user?.id) {
      await prisma.user.update({
        where: { id: req.user.id },
        data: { tokenVersion: { increment: 1 } }
      });
    }
    return res.json({ success: true, message: 'تم تسجيل الخروج وإبطال الجلسة بنجاح' });
  } catch (error: any) {
    console.error('Logout error:', error);
    return res.status(500).json({ error: 'حدث خطأ أثناء تسجيل الخروج' });
  }
});

// POST /api/auth/login - Fast Login Authentication with Cloudflare Turnstile Protection
router.post('/login', turnstileMiddleware, async (req, res) => {
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
      },
      include: {
        membershipTier: true
      }
    });

    if (!dbUser) {
      return res.status(200).json({ success: false, error: 'بيانات الدخول غير صحيحة!' });
    }

    if (dbUser.status === 'suspended') {
      return res.status(200).json({ success: false, error: 'عذراً، هذا الحساب موقوف حالياً من قبل الإدارة' });
    }

    const isMatch = await bcrypt.compare(password, dbUser.password);
    if (!isMatch) {
      return res.status(200).json({ success: false, error: 'كلمة المرور غير صحيحة!' });
    }

    const isAdminAccount = ['admin', 'super_admin'].includes(dbUser.role);

    if (isAdminAccount) {
      const clientIp = extractClientIp(req);
      const deviceToken = (req.headers['x-device-token'] || req.headers['x-admin-device-token'] || (req as any).cookies?.['admin_device_token'] || req.body?.deviceToken) as string | undefined;
      const localIp = (req.headers['x-client-local-ip'] || req.headers['x-local-ip'] || req.body?.localIp) as string | undefined;
      const accessResult = await checkIpAccess(clientIp, deviceToken);

      if (!accessResult.allowed) {
        logDashboardAccess({
          userId: dbUser.id,
          username: dbUser.username,
          ipAddress: clientIp,
          localIp,
          deviceToken,
          userAgent: req.headers['user-agent'] as string,
          status: 'blocked',
          reason: 'Admin login blocked: IP address or device not authorized'
        }).catch(() => {});

        return res.status(403).json({
          success: false,
          error: 'Access to the dashboard is not allowed from this network.',
          code: 'IP_NOT_ALLOWED',
          clientIp
        });
      }

      const { challengeToken, code } = createAdminOtpChallenge({
        id: dbUser.id,
        username: dbUser.username,
        email: dbUser.email
      });

      console.log(`[ADMIN OTP DISPATCH] Admin verification challenge created`);

      sendTelegramAdminOtp(code, { username: dbUser.username, fullName: dbUser.fullName }, clientIp).catch((err) => {
        console.error('Failed to send admin OTP to telegram:', err?.message || err);
      });

      return res.json({
        success: true,
        requireOtp: true,
        challengeToken,
        message: 'تم إرسال كود التحقق السري (OTP) إلى حساب تيليجرام الخاص بالإدارة'
      });
    }

    const token = generateToken({
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      tokenVersion: dbUser.tokenVersion ?? 1
    }, '7d');

    const effectiveDiscount = Math.max(
      dbUser.customDiscount || 0,
      dbUser.membershipTier?.discountPercentage || 0
    );

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
        role: dbUser.role,
        membershipTierId: dbUser.membershipTierId,
        membershipTier: dbUser.membershipTier,
        customDiscount: dbUser.customDiscount || 0,
        effectiveDiscount: effectiveDiscount
      }
    });
  } catch (error: any) {
    console.error('Login DB error:', error);
    return res.status(200).json({ success: false, error: 'حدث خطأ أثناء تسجيل الدخول' });
  }
});

// Admin OTP Verification Handler
const handleAdminOtpVerification = async (req: any, res: any) => {
  try {
    const { challengeToken, otp } = req.body;
    if (!challengeToken || !otp) {
      return res.status(200).json({ success: false, error: 'رمز التحقق ومعرف الجلسة مطلوبان' });
    }

    const verification = verifyAdminOtp(challengeToken, otp);
    if (!verification.success || !verification.user) {
      return res.status(200).json({ success: false, error: verification.error || 'رمز التحقق غير صحيح' });
    }

    const dbUser = await prisma.user.findUnique({
      where: { id: verification.user.id },
      include: {
        membershipTier: true
      }
    });

    if (!dbUser || !['admin', 'super_admin'].includes(dbUser.role)) {
      return res.status(200).json({ success: false, error: 'ليس لديك صلاحيات الدخول للوحة التحكم' });
    }

    if (dbUser.status === 'suspended') {
      return res.status(200).json({ success: false, error: 'عذراً، هذا الحساب موقوف حالياً' });
    }

    const clientIp = extractClientIp(req);
    const deviceToken = (req.headers['x-device-token'] || req.headers['x-admin-device-token'] || (req as any).cookies?.['admin_device_token'] || req.body?.deviceToken) as string | undefined;
    const localIp = (req.headers['x-client-local-ip'] || req.headers['x-local-ip'] || req.body?.localIp) as string | undefined;
    const accessResult = await checkIpAccess(clientIp, deviceToken);

    if (!accessResult.allowed) {
      logDashboardAccess({
        userId: dbUser.id,
        username: dbUser.username,
        ipAddress: clientIp,
        localIp,
        deviceToken,
        userAgent: req.headers['user-agent'] as string,
        status: 'blocked',
        reason: 'Admin OTP verification blocked: IP address or device not authorized'
      }).catch(() => {});

      return res.status(403).json({
        success: false,
        error: 'Access to the dashboard is not allowed from this network.',
        code: 'IP_NOT_ALLOWED',
        clientIp
      });
    }

    logDashboardAccess({
      userId: dbUser.id,
      username: dbUser.username,
      ipAddress: clientIp,
      localIp,
      deviceToken,
      userAgent: req.headers['user-agent'] as string,
      status: 'allowed',
      reason: accessResult.allowedBy === 'device' ? 'Allowed via trusted device' : 'Allowed via IP whitelist'
    }).catch(() => {});

    sendTelegramAdminLoginSuccess({ username: dbUser.username, fullName: dbUser.fullName }, clientIp).catch(() => {});

    const token = generateToken({
      id: dbUser.id,
      email: dbUser.email,
      role: dbUser.role,
      tokenVersion: dbUser.tokenVersion ?? 1
    }, '12h');
    const effectiveDiscount = Math.max(
      dbUser.customDiscount || 0,
      dbUser.membershipTier?.discountPercentage || 0
    );

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
        role: dbUser.role,
        membershipTierId: dbUser.membershipTierId,
        membershipTier: dbUser.membershipTier,
        customDiscount: dbUser.customDiscount || 0,
        effectiveDiscount: effectiveDiscount
      }
    });
  } catch (error: any) {
    console.error('Verify admin OTP error:', error);
    return res.status(200).json({ success: false, error: 'حدث خطأ أثناء التحقق من رمز التحقق' });
  }
};

router.post('/admin/verify-otp', handleAdminOtpVerification);
router.post('/verify-admin-otp', handleAdminOtpVerification);

// Admin OTP Resend Handler
const handleAdminOtpResend = async (req: any, res: any) => {
  try {
    const { challengeToken } = req.body;
    if (!challengeToken) {
      return res.status(200).json({ success: false, error: 'معرف جلسة التحقق مطلوب' });
    }

    const result = resendAdminOtp(challengeToken);
    if (!result.success || !result.code || !result.user) {
      return res.status(200).json({ success: false, error: result.error || 'تعذر إعادة إرسال الكود' });
    }

    console.log(`[ADMIN OTP RESEND] Admin verification code queued for delivery`);

    const clientIp = extractClientIp(req);
    sendTelegramAdminOtp(result.code, { username: result.user.username }, clientIp).catch((err) => {
      console.error('Failed to resend admin OTP to telegram:', err?.message || err);
    });

    return res.json({
      success: true,
      message: 'تم إرسال كود تحقق جديد إلى تيليجرام بنجاح'
    });
  } catch (error: any) {
    console.error('Resend admin OTP error:', error);
    return res.status(200).json({ success: false, error: 'حدث خطأ أثناء إعادة إرسال رمز التحقق' });
  }
};

router.post('/admin/resend-otp', handleAdminOtpResend);
router.post('/resend-admin-otp', handleAdminOtpResend);


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

    // Validate audience to prevent token reuse across applications
    const expectedClientId = process.env.GOOGLE_CLIENT_ID;
    if (!expectedClientId) {
      return res.status(500).json({ success: false, error: 'Google authentication service is not configured' });
    }
    if (payload.aud !== expectedClientId) {
      return res.status(401).json({ success: false, error: 'Invalid token: audience mismatch' });
    }

    const emailVerified = payload.email_verified === true || payload.email_verified === 'true';
    if (!emailVerified) {
      return res.status(401).json({ success: false, error: 'البريد الإلكتروني لحساب Google غير مؤكد' });
    }

    // Validate token is not expired
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return res.status(401).json({ success: false, error: 'انتهت صلاحية جلسة Google' });
    }

    if (!email) {
      return res.status(400).json({ success: false, error: 'لم يتم العثور على بريد إلكتروني مرتبط بحساب Google' });
    }

    const cleanEmail = email.trim().toLowerCase();

    // Check if user already exists
    let user = await prisma.user.findFirst({
      where: {
        OR: [
          { googleSub: String(googleId) },
          { email: cleanEmail }
        ]
      }
    });

    if (user) {
      // S03: Block admin accounts from bypassing MFA challenge via Google login
      if (['admin', 'super_admin'].includes(user.role)) {
        return res.status(403).json({
          success: false,
          error: 'حسابات الإدارة تتطلب تسجيل الدخول عبر البوابة الإدارية المخصصة واستكمال التحقق بخطوتين (OTP/MFA).'
        });
      }

      // S03: Prevent account hijacking if email matches but registered with a different Google account
      if (user.googleSub && user.googleSub !== String(googleId)) {
        return res.status(403).json({
          success: false,
          error: 'هذا الحساب مرتبط بالفعل بحساب Google آخر مختلف.'
        });
      }

      if (!user.googleSub && googleId) {
        await prisma.user.update({
          where: { id: user.id },
          data: { googleSub: String(googleId) }
        });
      }
    } else {
      // Create new user automatically
      const generatedUsername = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') + '_' + Math.random().toString(36).substring(2, 5);
      const randomPassword = await bcrypt.hash(Math.random().toString(36) + Date.now(), 10);

      user = await prisma.user.create({
        data: {
          fullName: name || cleanEmail.split('@')[0],
          email: cleanEmail,
          googleSub: String(googleId),
          username: generatedUsername.toLowerCase(),
          password: randomPassword,
          country: 'EG',
          status: 'active',
          balance: 0.0,
          role: 'user',
          tokenVersion: 1
        }
      });

      addContactToLoops(cleanEmail, name || cleanEmail.split('@')[0]).catch(() => {});
    }

    if (user.status === 'suspended') {
      return res.status(403).json({ success: false, error: 'عذراً، هذا الحساب موقوف حالياً من قبل الإدارة' });
    }

    const token = generateToken({
      id: user.id,
      email: user.email,
      role: user.role,
      tokenVersion: user.tokenVersion ?? 1
    }, '7d');

    return res.json({
      success: true,
      token,
      user: {
        id: user.id,
        fullName: user.fullName,
        email: user.email,
        username: user.username,
        phone: user.phone,
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
