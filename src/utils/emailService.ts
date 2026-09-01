import https from "https";

// Resend Configuration (100% Resend Powered)
const RESEND_API_KEY = process.env.RESEND_API_KEY || "";
const RESEND_FROM = process.env.RESEND_FROM || "arabtechproserver.tech <arabtechproserver@arabtechproserver.tech>";

interface OtpPayload {
  code: string;
  username?: string;
  actionLabel?: string;
  siteName?: string;
}

// Generate Luxury HTML Email with Circular Avatar & Verified Badge
// Generate Clean Luxury HTML Email (No external image dependencies)
function generateLuxuryEmailHtml({
  title,
  username,
  message,
  badgeText,
  actionText,
  actionUrl
}: {
  title: string;
  username: string;
  message: string;
  badgeText?: string;
  actionText?: string;
  actionUrl?: string;
}): string {
  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right; color: #e2e8f0;">
  <div style="width: 100%; background-color: #0b0f19; padding: 35px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 580px; margin: 0 auto; background: linear-gradient(180deg, #131b2e 0%, #0f172a 100%); border-radius: 20px; border: 1px solid #1e293b; box-shadow: 0 15px 35px rgba(0,0,0,0.6); overflow: hidden;">
      
      <!-- TOP HEADER (CLEAN & MODERN) -->
      <tr>
        <td style="background: linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%); padding: 30px 20px; text-align: center;">
          <div style="display: inline-block; padding: 6px 16px; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 30px; color: #38bdf8; font-size: 12px; font-weight: bold; margin-bottom: 10px; letter-spacing: 1px;">
            ⚡ ARAB TECH PRO SERVER
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: 0.5px;">عرب تك برو سيرفر</h1>
          <p style="margin: 5px 0 0 0; color: #bae6fd; font-size: 13px; font-family: monospace;">arabtechproserver.tech</p>
        </td>
      </tr>

      <!-- CONTENT BODY -->
      <tr>
        <td style="padding: 35px 30px;">
          <div style="font-size: 18px; font-weight: 700; color: #f8fafc; margin-bottom: 15px;">
            مرحباً بك، ${username} 👋
          </div>
          
          <div style="background-color: rgba(15, 23, 42, 0.7); border: 1px solid #334155; border-radius: 14px; padding: 22px; color: #cbd5e1; font-size: 15px; line-height: 1.8; margin-bottom: 25px; white-space: pre-line;">
            ${message}
          </div>

          ${badgeText ? `
          <div style="text-align: center; margin: 20px 0 25px 0;">
            <div style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; padding: 12px 28px; border-radius: 12px; font-size: 24px; font-weight: 800; letter-spacing: 3px; box-shadow: 0 4px 15px rgba(2, 132, 199, 0.4);">
              ${badgeText}
            </div>
          </div>
          ` : ''}

          ${actionUrl && actionText ? `
          <div style="text-align: center; margin: 30px 0 10px 0;">
            <a href="${actionUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #0284c7 100%); color: #ffffff !important; text-decoration: none; font-size: 15px; font-weight: bold; padding: 14px 34px; border-radius: 12px; box-shadow: 0 6px 20px rgba(37, 99, 235, 0.4);">
              ${actionText}
            </a>
          </div>
          ` : ''}
        </td>
      </tr>

      <!-- FOOTER -->
      <tr>
        <td style="background-color: #090d16; padding: 22px 20px; text-align: center; border-top: 1px solid #1e293b;">
          <p style="margin: 0; color: #64748b; font-size: 12px;">© 2026 <strong>عرب تك برو سيرفر - ARAB TECH PRO</strong>. جميع الحقوق محفوظة.</p>
          <p style="margin: 6px 0 0 0; color: #64748b; font-size: 12px;">الدعم الفني المباشر: <a href="mailto:arabtechserver@gmail.com" style="color: #38bdf8; text-decoration: none;">arabtechserver@gmail.com</a></p>
        </td>
      </tr>
    </table>
  </div>
</body>
</html>
  `.trim();
}

// Send Email Core via Resend API
export async function sendEmail({
  to,
  subject,
  html
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    if (!RESEND_API_KEY) {
      console.warn("[Resend Warning] RESEND_API_KEY is not configured.");
      return resolve(false);
    }

    const postData = JSON.stringify({
      from: RESEND_FROM,
      reply_to: "arabtechserver@gmail.com",
      to: [to.trim().toLowerCase()],
      subject,
      html
    });

    const options = {
      hostname: "api.resend.com",
      port: 443,
      path: "/emails",
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`🚀 [Resend Success] Email delivered to: ${to} (Subject: ${subject})`);
          resolve(true);
        } else {
          console.warn(`[Resend Error ${res.statusCode}]:`, data);
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.error("[Resend Network Error]:", err?.message);
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Send Transactional OTP Email
 */
export const sendOtpEmailViaLoops = async (email: string, payload: OtpPayload): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const title = `كود التحقق الخاص بك: ${payload.code}`;
  const username = payload.username || "عزيزنا العميل";
  const message = `كود التحقق الخاص بك هو: <b>${payload.code}</b>.\nيرجى إدخاله في الموقع لتأكيد العملية.\nهذا الكود صالح لمدة 10 دقائق فقط للحفاظ على أمان حسابك.`;

  const html = generateLuxuryEmailHtml({
    title,
    username,
    message,
    badgeText: payload.code,
    actionText: payload.actionLabel || "تأكيد الحساب والدخول",
    actionUrl: "https://arabtechproserver.tech/login"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | ${payload.actionLabel || 'كود التحقق'}: ${payload.code}`,
    html
  });
};

// Aliased export for clarity
export const sendOtpEmail = sendOtpEmailViaLoops;

/**
 * Add a contact dummy helper for backwards compatibility
 */
export const addContactToLoops = async (email: string, firstName?: string): Promise<boolean> => {
  return true;
};

/**
 * Send Welcome Email to New Newsletter Subscriber
 */
export const sendWelcomeNewsletterEmail = async (email: string, name?: string): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = name || "عزيزنا العميل";
  const message = "أهلاً بك في النشرة الإخبارية الرسمية لعرب تك برو سيرفر! ستصلك أحدث عروض الأدوات وتحديثات السيرفر والخدمات الجديدة فور إضافتها مباشرة على بريدك الإلكتروني.";

  const html = generateLuxuryEmailHtml({
    title: "مرحباً بك في عرب تك برو سيرفر",
    username,
    message,
    actionText: "زيارة الموقع وتصفح الخدمات",
    actionUrl: "https://arabtechproserver.tech"
  });

  return sendEmail({
    to: cleanEmail,
    subject: "عرب تك برو سيرفر | أهلاً بك معنا!",
    html
  });
};

/**
 * Send Broadcast / New Item Notification Email to a Subscriber
 */
export const sendNewsletterBroadcastEmail = async (
  email: string,
  payload: {
    subject: string;
    title: string;
    message: string;
    actionUrl?: string;
    actionText?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const html = generateLuxuryEmailHtml({
    title: payload.title,
    username: "عزيزنا العميل",
    message: payload.message,
    actionText: payload.actionText || "عرض التفاصيل في الموقع",
    actionUrl: payload.actionUrl || "https://arabtechproserver.tech"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | ${payload.subject}`,
    html
  });
};

/**
 * Send Order Confirmation Email to Customer
 */
export const sendOrderConfirmationEmail = async (
  email: string,
  payload: {
    orderId: string;
    serviceName: string;
    targetInput: string;
    price: number;
    remainingBalance: number;
    username?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const message = `تم استلام وتنفيذ طلبك رقم <b>#${payload.orderId}</b> بنجاح!\n\n📱 <b>الخدمة:</b> ${payload.serviceName}\n🔢 <b>المُدخل (IMEI / ID):</b> ${payload.targetInput}\n💰 <b>المبلغ المخصوم:</b> $${payload.price.toFixed(2)} USD\n🏦 <b>رصيد محفظتك المتبقي:</b> $${payload.remainingBalance.toFixed(2)} USD.`;

  const html = generateLuxuryEmailHtml({
    title: `تم تأكيد طلبك رقم #${payload.orderId}`,
    username,
    message,
    badgeText: `#${payload.orderId}`,
    actionText: "متابعة حالة الطلب في الموقع",
    actionUrl: "https://arabtechproserver.tech/dashboard/orders"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | تم استلام طلبك #${payload.orderId} بنجاح`,
    html
  });
};

/**
 * Send Deposit Approval Email to Customer
 */
export const sendDepositApprovalEmail = async (
  email: string,
  payload: {
    amount: number;
    newBalance: number;
    username?: string;
    tierName?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const message = `تهانينا! تمت الموافقة على طلب إيداعك وإضافة <b>+$${payload.amount.toFixed(2)} USD</b> إلى رصيدك بنجاح.\n\n🏦 <b>إجمالي رصيد محفظتك الحالي:</b> $${payload.newBalance.toFixed(2)} USD.${payload.tierName ? `\n🎖️ <b>مستوى عضويتك الحالي:</b> ${payload.tierName}` : ''}`;

  const html = generateLuxuryEmailHtml({
    title: `تم اعتماد إيداع رصيدك: +$${payload.amount.toFixed(2)}`,
    username,
    message,
    badgeText: `+$${payload.amount.toFixed(2)} USD`,
    actionText: "فتح المحفظة والطلب الآن",
    actionUrl: "https://arabtechproserver.tech/dashboard/wallet"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | تم اعتماد شحن رصيدك (+$${payload.amount.toFixed(2)} USD)`,
    html
  });
};
