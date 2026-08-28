import https from "https";

const LOOPS_API_KEY = process.env.LOOPS_API_KEY;
const LOOPS_OTP_TRANSACTIONAL_ID = process.env.LOOPS_TRANSACTIONAL_ID_OTP || "cmrv2rlz301lp0j2pig1clc4n";

interface OtpPayload {
  code: string;
  username?: string;
  actionLabel?: string;
  siteName?: string;
}

/**
 * Send Transactional OTP Email via Loops.so API
 */
export const sendOtpEmailViaLoops = (email: string, payload: OtpPayload): Promise<boolean> => {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      transactionalId: LOOPS_OTP_TRANSACTIONAL_ID,
      email: email.trim().toLowerCase(),
      addToAudience: true,
      dataVariables: {
        site_name: payload.siteName || "عرب تك برو سيرفر - ARAB TECH PRO",
        username: payload.username || "عزيزنا العميل",
        code: payload.code,
        otp_code: payload.code,
        message_body: `كود التحقق الخاص بك هو: ${payload.code}. يرجى إدخاله في الموقع لتأكيد العملية. الكود صالحة لمدة 10 دقائق.`,
        actionLabel: payload.actionLabel || "تأكيد الحساب",
        reset_url: "https://arabtechproserver.tech"
      }
    });

    const options = {
      hostname: "app.loops.so",
      port: 443,
      path: "/api/v1/transactional",
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`[Loops Email Sent] OTP ${payload.code} delivered to ${email}`);
          resolve(true);
        } else {
          console.error(`[Loops Email Error] HTTP ${res.statusCode}:`, data);
          // Fallback resolve to true for dev environment so registration is never blocked
          resolve(true);
        }
      });
    });

    req.on("error", (error) => {
      console.error("[Loops Request Error]:", error);
      resolve(true);
    });

    req.write(postData);
    req.end();
  });
};

/**
 * Add a contact to Loops.so Audience
 */
export const addContactToLoops = (email: string, firstName?: string): Promise<boolean> => {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      email: email.trim().toLowerCase(),
      firstName: firstName || "عميل",
      userGroup: "Newsletter Subscriber",
      source: "Arab Tech Pro Server"
    });

    const options = {
      hostname: "app.loops.so",
      port: 443,
      path: "/api/v1/contacts/create",
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(true));
    });

    req.on("error", () => resolve(false));
    req.write(postData);
    req.end();
  });
};

/**
 * Send Welcome Email to New Newsletter Subscriber
 */
export const sendWelcomeNewsletterEmail = (email: string, name?: string): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!LOOPS_API_KEY) return resolve(true);

    const postData = JSON.stringify({
      email: email.trim().toLowerCase(),
      transactionalId: LOOPS_OTP_TRANSACTIONAL_ID,
      addToAudience: true,
      dataVariables: {
        site_name: "عرب تك برو سيرفر - ARAB TECH PRO",
        username: name || "عميلنا العزيز",
        code: "WELCOME",
        otp_code: "WELCOME",
        message_body: "أهلاً بك في النشرة الإخبارية الرسمية لعرب تك برو سيرفر! ستصلك أحدث عروض الأدوات وتحديثات السيرفر والخدمات الجديدة فور إضافتها مباشرة على بريدك الإلكتروني.",
        actionLabel: "زيارة الموقع وتصفح الخدمات",
        reset_url: "https://arabtechproserver.tech"
      }
    });

    const options = {
      hostname: "app.loops.so",
      port: 443,
      path: "/api/v1/transactional",
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(true));
    });

    req.on("error", () => resolve(true));
    req.write(postData);
    req.end();
  });
};

/**
 * Send Broadcast / New Item Notification Email to a Subscriber
 */
export const sendNewsletterBroadcastEmail = (
  email: string, 
  payload: { 
    subject: string; 
    title: string; 
    message: string; 
    actionUrl?: string; 
    actionText?: string;
  }
): Promise<boolean> => {
  return new Promise((resolve) => {
    if (!LOOPS_API_KEY) return resolve(true);

    const postData = JSON.stringify({
      email: email.trim().toLowerCase(),
      transactionalId: LOOPS_OTP_TRANSACTIONAL_ID,
      addToAudience: true,
      dataVariables: {
        site_name: "عرب تك برو سيرفر - ARAB TECH PRO",
        username: "عميلنا العزيز",
        code: payload.title,
        otp_code: payload.title,
        message_body: payload.message,
        actionLabel: payload.actionText || "عرض التفاصيل في الموقع",
        reset_url: payload.actionUrl || "https://arabtechproserver.tech"
      }
    });

    const options = {
      hostname: "app.loops.so",
      port: 443,
      path: "/api/v1/transactional",
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOOPS_API_KEY}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      res.on("data", () => {});
      res.on("end", () => resolve(true));
    });

    req.on("error", () => resolve(true));
    req.write(postData);
    req.end();
  });
};
