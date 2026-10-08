import { BoundedRateLimitStore } from '../utils/bounded-rate-limit-store';
import { Router } from 'express';
import crypto from 'crypto';
import { digestOtp, matchesOtp } from '../utils/otp-security';
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
  store: new BoundedRateLimitStore(),
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, error: 'تجاوزت الحد المسموح به، يرجى المحاولة بعد قليل.' },
  validate: { xForwardedForHeader: false }
});

router.use(authLimiter);

// In-memory OTP Store for forgot password flow with brute force attempt tracking
interface UserOtpRecord {
  codeDigest: string;
  expiresAt: number;
  attempts: number;
  lastSentAt: number;
  purpose: string;
  resends: number;
}
const otpStore = new Map<string, UserOtpRecord>();
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of otpStore.entries()) {
    if (now > val.expiresAt) otpStore.delete(key);
  }
}, 60 * 1000).unref();

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
    if (typeof email !== 'string' || email.length > 254 || !email.includes('@')) {
      return res.status(200).json({ success: false, error: 'الرجاء إدخال بريد إلكتروني صحيح' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (type === 'forgot_password') {
      const userObj = await prisma.user.findUnique({ where: { email: cleanEmail } });
      if (!userObj) {
        return res.status(200).json({ success: false, error: 'لم يتم العثور على حساب مرتبط بهذا البريد الإلكتروني!' });
      }
    }
    // Admission and reservation are synchronous after the database lookup.
    const now = Date.now();
    const previous = otpStore.get(cleanEmail);
    if (previous && now < previous.expiresAt && now - previous.lastSentAt < 60000) {
      return res.status(429).json({ success: false, error: 'يرجى الانتظار دقيقة قبل طلب كود جديد' });
    }
    if (previous && now < previous.expiresAt && (previous.resends >= 3 || previous.attempts >= 5)) {
      return res.status(429).json({ success: false, error: 'تجاوزت حد محاولات التحقق، يرجى المحاولة لاحقاً' });
    }
    for (const [key, record] of otpStore) if (record.expiresAt <= now) otpStore.delete(key);
    if (!otpStore.has(cleanEmail) && otpStore.size >= 1000) {
      return res.status(503).json({ success: false, error: 'خدمة التحقق مشغولة حالياً، يرجى المحاولة لاحقاً' });
    }

    const otpCode = crypto.randomInt(100000, 1000000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000;

    const purpose = type === 'forgot_password' ? 'forgot_password' : 'registration';
    otpStore.set(cleanEmail, {
      codeDigest: digestOtp(`${cleanEmail}:${purpose}`, otpCode),
      expiresAt: previous && now < previous.expiresAt ? previous.expiresAt : expiresAt,
      attempts: previous && now < previous.expiresAt ? previous.attempts : 0,
      lastSentAt: now,
      purpose,
      resends: previous && now < previous.expiresAt ? previous.resends + 1 : 0
    });

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

    if (typeof email !== 'string' || typeof otp !== 'string' || typeof newPassword !== 'string' || !email || !otp || !newPassword) {
      return res.status(200).json({ success: false, error: 'البريد الإلكتروني، كود OTP، وكلمة المرور الجديدة مطلوبة' });
    }

    if (newPassword.length < 8) {
      return res.status(200).json({ success: false, error: 'كلمة المرور الجديدة يجب أن لا تقل عن 8 أحرف' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const record = otpStore.get(cleanEmail);

    if (!record || record.purpose !== 'forgot_password' || Date.now() > record.expiresAt) {
      if (record) otpStore.delete(cleanEmail);
      return res.status(200).json({ success: false, error: 'كود التحقق (OTP) غير صحيح أو منتهي الصلاحية' });
    }

    if (record.attempts >= 5) {
      return res.status(200).json({ success: false, error: 'تم تجاوز الحد الأقصى للمحاولات الخاطئة. الرجاء طلب كود جديد' });
    }

    if (!matchesOtp(`${cleanEmail}:forgot_password`, otp, record.codeDigest)) {
      record.attempts += 1;
      return res.status(200).json({ success: false, error: 'كود التحقق (OTP) غير صحيح' });
    }

    // Consume synchronously before any await to prevent concurrent reuse.
    otpStore.delete(cleanEmail);
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

      console.log('[ADMIN OTP DISPATCH] Verification code queued for delivery');

      sendTelegramAdminOtp(code, { username: dbUser.username, fullName: dbUser.fullName }, clientIp).catch((err) => {
        console.error('Admin OTP delivery failed');
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
    console.error('Admin OTP verification failed');
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

    console.log('[ADMIN OTP RESEND] Verification code queued for delivery');

    const clientIp = extractClientIp(req);
    sendTelegramAdminOtp(result.code, { username: result.user.username }, clientIp).catch((err) => {
      console.error('Admin OTP redelivery failed');
    });

    return res.json({
      success: true,
      message: 'تم إرسال كود تحقق جديد إلى تيليجرام بنجاح'
    });
  } catch (error: any) {
    console.error('Admin OTP resend failed');
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
    const verifyRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`, { signal: AbortSignal.timeout(5000) });
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
      const generatedUsername = cleanEmail.split('@')[0].replace(/[^a-zA-Z0-9_]/g, '') + '_' + crypto.randomBytes(6).toString('hex');
      const randomPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 10);

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
