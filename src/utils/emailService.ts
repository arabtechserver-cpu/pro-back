import https from "https";
import net from "net";
import tls from "tls";
import crypto from "crypto";

interface OtpPayload {
  code: string;
  username?: string;
  actionLabel?: string;
  siteName?: string;
}

const SMTP_TIMEOUT_MS = 12000;

export function escapeEmailHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseFromHeader(rawFrom: string): { name: string; email: string; formatted: string } {
  const trimmed = (rawFrom || "").trim();
  const match = trimmed.match(/^(.*?)\s*<([^<>@\s]+@[^<>@\s]+)>$/);
  if (match) {
    const name = match[1].trim().replace(/^["']|["']$/g, "") || "arabproserver.com";
    const email = match[2].trim();
    return { name, email, formatted: `${name} <${email}>` };
  }
  if (/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(trimmed)) {
    return { name: "arabproserver.com", email: trimmed, formatted: `arabproserver.com <${trimmed}>` };
  }
  return {
    name: "arabproserver.com",
    email: "arabtechproserver@arabproserver.com",
    formatted: "arabproserver.com <arabtechproserver@arabproserver.com>"
  };
}

function sanitizeHeaderValue(value: string): string {
  return String(value || "").replace(/[\r\n]+/g, " ").trim();
}

function encodeMimeSubject(subject: string): string {
  const clean = sanitizeHeaderValue(subject);
  return `=?UTF-8?B?${Buffer.from(clean, "utf8").toString("base64")}?=`;
}

function wrapBase64(input: string): string {
  const b64 = Buffer.from(input, "utf8").toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < b64.length; i += 76) {
    lines.push(b64.slice(i, i + 76));
  }
  return lines.join("\r\n");
}

function generateLuxuryEmailHtml({
  title,
  username,
  messageHtml,
  badgeText,
  actionText,
  actionUrl
}: {
  title: string;
  username: string;
  messageHtml: string;
  badgeText?: string;
  actionText?: string;
  actionUrl?: string;
}): string {
  const safeTitle = escapeEmailHtml(title);
  const safeUsername = escapeEmailHtml(username);
  const safeBadge = badgeText ? escapeEmailHtml(badgeText) : "";
  const safeActionText = actionText ? escapeEmailHtml(actionText) : "";
  const safeActionUrl = actionUrl && /^https?:\/\//i.test(actionUrl) ? escapeEmailHtml(actionUrl) : "";

  return `
<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #0b0f19; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; direction: rtl; text-align: right; color: #e2e8f0;">
  <div style="width: 100%; background-color: #0b0f19; padding: 35px 0;">
    <table width="100%" cellpadding="0" cellspacing="0" style="max-width: 580px; margin: 0 auto; background: linear-gradient(180deg, #131b2e 0%, #0f172a 100%); border-radius: 20px; border: 1px solid #1e293b; box-shadow: 0 15px 35px rgba(0,0,0,0.6); overflow: hidden;">
      <tr>
        <td style="background: linear-gradient(135deg, #1e3a8a 0%, #0284c7 100%); padding: 30px 20px; text-align: center;">
          <div style="display: inline-block; padding: 6px 16px; background: rgba(15, 23, 42, 0.6); border: 1px solid rgba(56, 189, 248, 0.4); border-radius: 30px; color: #38bdf8; font-size: 12px; font-weight: bold; margin-bottom: 10px; letter-spacing: 1px;">
            ARAB TECH PRO SERVER
          </div>
          <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: 0.5px;">عرب تك برو سيرفر</h1>
          <p style="margin: 5px 0 0 0; color: #bae6fd; font-size: 13px; font-family: monospace;">arabproserver.com</p>
        </td>
      </tr>
      <tr>
        <td style="padding: 35px 30px;">
          <div style="font-size: 18px; font-weight: 700; color: #f8fafc; margin-bottom: 15px;">
            مرحباً بك، ${safeUsername}
          </div>
          <div style="background-color: rgba(15, 23, 42, 0.7); border: 1px solid #334155; border-radius: 14px; padding: 22px; color: #cbd5e1; font-size: 15px; line-height: 1.8; margin-bottom: 25px; white-space: pre-line;">
            ${messageHtml}
          </div>
          ${safeBadge ? `
          <div style="text-align: center; margin: 20px 0 25px 0;">
            <div style="display: inline-block; background: linear-gradient(135deg, #0284c7 0%, #2563eb 100%); color: #ffffff; padding: 12px 28px; border-radius: 12px; font-size: 24px; font-weight: 800; letter-spacing: 3px; box-shadow: 0 4px 15px rgba(2, 132, 199, 0.4);">
              ${safeBadge}
            </div>
          </div>
          ` : ""}
          ${safeActionUrl && safeActionText ? `
          <div style="text-align: center; margin: 30px 0 10px 0;">
            <a href="${safeActionUrl}" target="_blank" style="display: inline-block; background: linear-gradient(135deg, #2563eb 0%, #0284c7 100%); color: #ffffff !important; text-decoration: none; font-size: 15px; font-weight: bold; padding: 14px 34px; border-radius: 12px; box-shadow: 0 6px 20px rgba(37, 99, 235, 0.4);">
              ${safeActionText}
            </a>
          </div>
          ` : ""}
        </td>
      </tr>
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

async function sendViaBrevoApi({
  apiKey,
  from,
  replyTo,
  to,
  subject,
  html
}: {
  apiKey: string;
  from: { name: string; email: string };
  replyTo: string;
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      sender: { name: from.name, email: from.email },
      replyTo: { email: replyTo },
      to: [{ email: to }],
      subject,
      htmlContent: html
    });

    const options = {
      hostname: "api.brevo.com",
      port: 443,
      path: "/v3/smtp/email",
      method: "POST",
      headers: {
        "api-key": apiKey,
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log("[Brevo API Success] Email delivered");
          resolve(true);
        } else {
          console.warn(`[Brevo API Error] Email provider returned status ${res.statusCode}`);
          resolve(false);
        }
      });
    });

    req.setTimeout(SMTP_TIMEOUT_MS, () => {
      req.destroy(new Error("Brevo API request timeout"));
    });

    req.on("error", (err) => {
      console.error("[Brevo API Network Error]:", err?.message);
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

function readSmtpResponse(socket: net.Socket | tls.TLSSocket): Promise<{ code: number; text: string }> {
  return new Promise((resolve, reject) => {
    let buffer = "";

    const cleanup = () => {
      socket.removeListener("data", onData);
      socket.removeListener("error", onError);
      socket.removeListener("close", onClose);
    };

    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onClose = () => {
      cleanup();
      reject(new Error("SMTP connection closed unexpectedly"));
    };

    const onData = (chunk: Buffer | string) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split(/\r?\n/);
      // Keep the trailing incomplete fragment if any
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        // A final SMTP reply line has 3 digits followed by a space (or end of line)
        const match = line.match(/^(\d{3})(?:\s|$)/);
        if (match && buffer.endsWith("\n")) {
          cleanup();
          resolve({ code: Number(match[1]), text: buffer.trim() });
          return;
        }
        break;
      }
    };

    socket.on("data", onData);
    socket.on("error", onError);
    socket.on("close", onClose);
  });
}

async function sendSmtpCommand(
  socket: net.Socket | tls.TLSSocket,
  command: string,
  expectedCodes: number[]
): Promise<{ code: number; text: string }> {
  const responsePromise = readSmtpResponse(socket);
  socket.write(`${command}\r\n`);
  const resp = await responsePromise;
  if (!expectedCodes.includes(resp.code)) {
    throw new Error(`SMTP unexpected status ${resp.code}`);
  }
  return resp;
}

async function sendViaBrevoSmtp({
  host,
  port,
  user,
  pass,
  from,
  replyTo,
  to,
  subject,
  html
}: {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: { name: string; email: string; formatted: string };
  replyTo: string;
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  let socket: net.Socket | tls.TLSSocket | null = null;
  let settled = false;

  try {
    const useImplicitTls = port === 465;

    socket = await new Promise<net.Socket | tls.TLSSocket>((resolve, reject) => {
      const sock = useImplicitTls
        ? tls.connect({ host, port, servername: host })
        : net.createConnection({ host, port });

      sock.setTimeout(SMTP_TIMEOUT_MS, () => {
        sock.destroy(new Error("SMTP connection timeout"));
      });

      const onError = (err: Error) => reject(err);
      sock.once("error", onError);
      sock.once(useImplicitTls ? "secureConnect" : "connect", () => {
        sock.removeListener("error", onError);
        resolve(sock);
      });
    });

    const greeting = await readSmtpResponse(socket);
    if (greeting.code !== 220) {
      throw new Error(`SMTP greeting failed with ${greeting.code}`);
    }

    await sendSmtpCommand(socket, "EHLO arabproserver.com", [250]);

    if (!useImplicitTls) {
      await sendSmtpCommand(socket, "STARTTLS", [220]);
      socket = await new Promise<tls.TLSSocket>((resolve, reject) => {
        const tlsSock = tls.connect({ socket: socket as net.Socket, servername: host });
        tlsSock.setTimeout(SMTP_TIMEOUT_MS, () => {
          tlsSock.destroy(new Error("SMTP TLS handshake timeout"));
        });
        const onError = (err: Error) => reject(err);
        tlsSock.once("error", onError);
        tlsSock.once("secureConnect", () => {
          tlsSock.removeListener("error", onError);
          resolve(tlsSock);
        });
      });
      await sendSmtpCommand(socket, "EHLO arabproserver.com", [250]);
    }

    await sendSmtpCommand(socket, "AUTH LOGIN", [334]);
    await sendSmtpCommand(socket, Buffer.from(user, "utf8").toString("base64"), [334]);
    await sendSmtpCommand(socket, Buffer.from(pass, "utf8").toString("base64"), [235]);

    await sendSmtpCommand(socket, `MAIL FROM:<${sanitizeHeaderValue(from.email)}>`, [250]);
    await sendSmtpCommand(socket, `RCPT TO:<${sanitizeHeaderValue(to)}>`, [250, 251]);
    await sendSmtpCommand(socket, "DATA", [354]);

    const fromDomain = sanitizeHeaderValue(from.email.split("@")[1] || "arabproserver.com");
    const mimeHeaders = [
      `From: ${sanitizeHeaderValue(from.formatted)}`,
      `To: ${sanitizeHeaderValue(to)}`,
      `Reply-To: ${sanitizeHeaderValue(replyTo)}`,
      `Subject: ${encodeMimeSubject(subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${crypto.randomUUID()}@${fromDomain}>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`
    ].join("\r\n");

    const mimeMessage = `${mimeHeaders}\r\n\r\n${wrapBase64(html)}\r\n.`;
    await sendSmtpCommand(socket, mimeMessage, [250]);

    settled = true;
    await sendSmtpCommand(socket, "QUIT", [221, 250]).catch(() => {});
    socket.end();
    console.log("[Brevo SMTP Success] Email delivered");
    return true;
  } catch (err: any) {
    if (!settled) {
      console.warn("[Brevo SMTP Error]:", err?.message || "SMTP delivery failed");
    }
    if (socket && !socket.destroyed) {
      socket.destroy();
    }
    return false;
  }
}

async function sendViaResendApi({
  apiKey,
  from,
  replyTo,
  to,
  subject,
  html
}: {
  apiKey: string;
  from: string;
  replyTo: string;
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      from,
      reply_to: replyTo,
      to: [to],
      subject,
      html
    });

    const options = {
      hostname: "api.resend.com",
      port: 443,
      path: "/emails",
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      }
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log("[Resend Success] Email delivered");
          resolve(true);
        } else {
          console.warn(`[Resend Error] Email provider returned status ${res.statusCode}`);
          if (data && data.includes("domain is not verified")) {
            console.warn("[Resend Action Required] The domain arabproserver.com is unverified in Resend.");
          }
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

export async function sendEmail({
  to,
  subject,
  html
}: {
  to: string;
  subject: string;
  html: string;
}): Promise<boolean> {
  const cleanTo = String(to || "").trim().toLowerCase();
  if (!cleanTo || !cleanTo.includes("@")) {
    return false;
  }

  const resendApiKey = process.env.RESEND_API_KEY || "";
  const resendFrom = process.env.RESEND_FROM || "arabproserver.com <arabtechproserver@arabproserver.com>";
  const brevoFrom = parseFromHeader(process.env.BREVO_FROM || resendFrom);
  const replyTo = sanitizeHeaderValue(process.env.BREVO_REPLY_TO || "arabtechserver@gmail.com");

  // Preserve test isolation when tests supply a mock Resend key and intercept https.request
  if (resendApiKey === "test-only-key") {
    return sendViaResendApi({
      apiKey: resendApiKey,
      from: resendFrom,
      replyTo,
      to: cleanTo,
      subject,
      html
    });
  }

  const brevoApiKey = process.env.BREVO_API_KEY || "";
  const brevoSmtpKey = process.env.BREVO_SMTP_KEY || "";
  const brevoSmtpHost = process.env.BREVO_SMTP_HOST || "smtp-relay.brevo.com";
  const brevoSmtpPort = Number(process.env.BREVO_SMTP_PORT || 587) || 587;
  const brevoSmtpUser = (process.env.BREVO_SMTP_USER || brevoFrom.email || "arabtechserver@gmail.com").trim();

  if (brevoApiKey.startsWith("xkeysib-") || brevoSmtpKey.startsWith("xkeysib-")) {
    const sent = await sendViaBrevoApi({
      apiKey: brevoApiKey.startsWith("xkeysib-") ? brevoApiKey : brevoSmtpKey,
      from: brevoFrom,
      replyTo,
      to: cleanTo,
      subject,
      html
    });
    if (sent) return true;
  }

  if (brevoSmtpKey) {
    const sent = await sendViaBrevoSmtp({
      host: brevoSmtpHost,
      port: brevoSmtpPort,
      user: brevoSmtpUser,
      pass: brevoSmtpKey,
      from: brevoFrom,
      replyTo,
      to: cleanTo,
      subject,
      html
    });
    if (sent) return true;
  }

  if (resendApiKey) {
    return sendViaResendApi({
      apiKey: resendApiKey,
      from: resendFrom,
      replyTo,
      to: cleanTo,
      subject,
      html
    });
  }

  console.warn("[Email Warning] Neither Brevo nor Resend credentials are configured.");
  return false;
}

export async function sendLoopsTransactionalEmail(
  email: string,
  transactionalId: string,
  dataVariables: Record<string, any>
): Promise<boolean> {
  const LOOPS_API_KEY = process.env.LOOPS_API_KEY || "";
  if (!LOOPS_API_KEY) return false;
  return new Promise((resolve) => {
    const postData = JSON.stringify({
      transactionalId,
      email: email.trim().toLowerCase(),
      dataVariables
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
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          console.log("[Loops Success] Transactional email sent");
          resolve(true);
        } else {
          console.warn(`[Loops Error] Email provider returned status ${res.statusCode}`);
          resolve(false);
        }
      });
    });

    req.on("error", (err) => {
      console.error("[Loops Network Error]:", err?.message);
      resolve(false);
    });

    req.write(postData);
    req.end();
  });
}

export const sendOtpEmail = async (email: string, payload: OtpPayload): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const safeCode = escapeEmailHtml(payload.code);
  const title = "كود التحقق الخاص بك";
  const messageHtml = `كود التحقق الخاص بك هو: <b>${safeCode}</b>.\nيرجى إدخاله في الموقع لتأكيد العملية.\nهذا الكود صالح لمدة 10 دقائق فقط للحفاظ على أمان حسابك. لا تشارك هذا الرمز مع أي شخص.`;

  console.log("[OTP DISPATCH] Verification email queued for delivery");

  const html = generateLuxuryEmailHtml({
    title,
    username,
    messageHtml,
    badgeText: payload.code,
    actionText: payload.actionLabel || "فتح الموقع",
    actionUrl: "https://arabproserver.com/ar/login"
  });

  const sent = await sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | ${payload.actionLabel || "كود التحقق"}: ${payload.code}`,
    html
  });

  if (!sent) {
    console.warn("[OTP DELIVERY] Verification email delivery failed");
  }

  return sent;
};

export const sendOtpEmailViaLoops = sendOtpEmail;

export const addContactToLoops = async (_email: string, _firstName?: string): Promise<boolean> => {
  return true;
};

export const sendWelcomeRegistrationEmail = async (
  email: string,
  payload: { fullName: string; username: string }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const messageHtml = [
    "تم تأكيد بريدك الإلكتروني وإنشاء حسابك بنجاح في منصة عرب تك برو سيرفر.",
    "",
    `<b>اسم المستخدم:</b> ${escapeEmailHtml(payload.username)}`,
    `<b>البريد المسجل:</b> ${escapeEmailHtml(cleanEmail)}`,
    "",
    "يمكنك الآن شحن محفظتك وطلب جميع خدمات فك الشفرات والسيرفرات والأدوات الفورية بأمان تام."
  ].join("\n");

  const html = generateLuxuryEmailHtml({
    title: "مرحباً بك في عرب تك برو سيرفر",
    username: payload.fullName || payload.username,
    messageHtml,
    badgeText: `@${payload.username}`,
    actionText: "الدخول إلى لوحة التحكم",
    actionUrl: "https://arabproserver.com/ar"
  });

  return sendEmail({
    to: cleanEmail,
    subject: "عرب تك برو سيرفر | تم تفعيل حسابك بنجاح",
    html
  });
};

export const sendWelcomeNewsletterEmail = async (email: string, name?: string): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = name || "عزيزنا العميل";
  const messageHtml =
    "أهلاً بك في النشرة الإخبارية الرسمية لعرب تك برو سيرفر! ستصلك أحدث عروض الأدوات وتحديثات السيرفر والخدمات الجديدة فور إضافتها مباشرة على بريدك الإلكتروني.";

  const html = generateLuxuryEmailHtml({
    title: "مرحباً بك في عرب تك برو سيرفر",
    username,
    messageHtml,
    actionText: "زيارة الموقع وتصفح الخدمات",
    actionUrl: "https://arabproserver.com"
  });

  return sendEmail({
    to: cleanEmail,
    subject: "عرب تك برو سيرفر | أهلاً بك معنا!",
    html
  });
};

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
    messageHtml: escapeEmailHtml(payload.message),
    actionText: payload.actionText || "عرض التفاصيل في الموقع",
    actionUrl: payload.actionUrl || "https://arabproserver.com"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | ${payload.subject}`,
    html
  });
};

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
  const messageHtml = [
    `تم استلام طلب الخدمة الخاص بك رقم <b>#${escapeEmailHtml(payload.orderId)}</b> بنجاح!`,
    "",
    `<b>الخدمة:</b> ${escapeEmailHtml(payload.serviceName)}`,
    `<b>البيانات / IMEI:</b> ${escapeEmailHtml(payload.targetInput)}`,
    `<b>المبلغ المخصوم:</b> $${Number(payload.price).toFixed(2)} USD`,
    `<b>الرصيد المتبقي:</b> $${Number(payload.remainingBalance).toFixed(2)} USD`,
    "",
    "سيصلك إشعار آخر على البريد الإلكتروني فور اكتمال الطلب أو تحديث حالته."
  ].join("\n");

  const html = generateLuxuryEmailHtml({
    title: `تم استلام طلبك رقم #${payload.orderId}`,
    username,
    messageHtml,
    badgeText: `#${payload.orderId}`,
    actionText: "متابعة حالة الطلب في الموقع",
    actionUrl: "https://arabproserver.com/ar/orders"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | تم استلام طلبك #${payload.orderId} بنجاح`,
    html
  });
};

export const sendOrderStatusUpdateEmail = async (
  email: string,
  payload: {
    orderId: string;
    serviceName: string;
    targetInput?: string;
    status: "completed" | "rejected" | "processing";
    reply?: string;
    refundAmount?: number;
    newBalance?: number;
    username?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const isCompleted = payload.status === "completed";
  const isRejected = payload.status === "rejected";

  const statusHeadline = isCompleted
    ? `تم اكتمال طلبك رقم <b>#${escapeEmailHtml(payload.orderId)}</b> بنجاح!`
    : isRejected
      ? `تم إلغاء / رفض طلبك رقم <b>#${escapeEmailHtml(payload.orderId)}</b>.`
      : `طلبك رقم <b>#${escapeEmailHtml(payload.orderId)}</b> قيد التنفيذ الآن.`;

  const lines = [
    statusHeadline,
    "",
    `<b>الخدمة:</b> ${escapeEmailHtml(payload.serviceName)}`
  ];

  if (payload.targetInput) {
    lines.push(`<b>البيانات / IMEI:</b> ${escapeEmailHtml(payload.targetInput)}`);
  }
  if (payload.reply) {
    lines.push(`<b>${isRejected ? "السبب" : "النتيجة / الكود"}:</b> ${escapeEmailHtml(payload.reply)}`);
  }
  if (isRejected && typeof payload.refundAmount === "number" && payload.refundAmount > 0) {
    lines.push(`<b>المبلغ المسترجع للمحفظة:</b> +$${Number(payload.refundAmount).toFixed(2)} USD`);
  }
  if (typeof payload.newBalance === "number") {
    lines.push(`<b>رصيدك الحالي:</b> $${Number(payload.newBalance).toFixed(2)} USD`);
  }

  const badgeText = isCompleted ? "مكتمل" : isRejected ? "مرفوض ومسترجع" : "قيد التنفيذ";
  const subjectStatus = isCompleted ? "تم اكتمال طلبك" : isRejected ? "تحديث بخصوص طلبك" : "طلبك قيد التنفيذ";

  const html = generateLuxuryEmailHtml({
    title: `${subjectStatus} #${payload.orderId}`,
    username,
    messageHtml: lines.join("\n"),
    badgeText,
    actionText: "عرض تفاصيل الطلب",
    actionUrl: "https://arabproserver.com/ar/orders"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | ${subjectStatus} #${payload.orderId}`,
    html
  });
};

export const sendDepositApprovalEmail = async (
  email: string,
  payload: {
    amount: number;
    newBalance: number;
    username?: string;
    tierName?: string;
    method?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const lines = [
    `تهانينا! تمت الموافقة على شحن محفظتك وإضافة <b>+$${Number(payload.amount).toFixed(2)} USD</b> إلى رصيدك بنجاح.`
  ];
  if (payload.method) {
    lines.push(`<b>وسيلة الدفع:</b> ${escapeEmailHtml(payload.method)}`);
  }
  lines.push(`<b>رصيدك الحالي:</b> $${Number(payload.newBalance).toFixed(2)} USD`);
  if (payload.tierName) {
    lines.push(`<b>مستوى عضويتك الحالي:</b> ${escapeEmailHtml(payload.tierName)}`);
  }

  const html = generateLuxuryEmailHtml({
    title: `تم اعتماد إيداع رصيدك: +$${Number(payload.amount).toFixed(2)}`,
    username,
    messageHtml: lines.join("\n"),
    badgeText: `+$${Number(payload.amount).toFixed(2)} USD`,
    actionText: "فتح المحفظة والطلب الآن",
    actionUrl: "https://arabproserver.com/ar/wallet"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | تم اعتماد شحن رصيدك (+$${Number(payload.amount).toFixed(2)} USD)`,
    html
  });
};

export const sendDepositPendingEmail = async (
  email: string,
  payload: {
    amount: number;
    method: string;
    username?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const messageHtml = `تم استلام طلب شحن محفظتك بقيمة <b>$${Number(payload.amount).toFixed(2)} USD</b> بنجاح عبر <b>${escapeEmailHtml(payload.method)}</b>.\n\nالطلب الآن قيد المراجعة من قبل الإدارة. سيتم إرسال إشعار لك فور اعتماد الرصيد في حسابك.`;

  const html = generateLuxuryEmailHtml({
    title: "طلب شحن محفظتك قيد المراجعة",
    username,
    messageHtml,
    badgeText: "قيد المراجعة",
    actionText: "متابعة حالة الطلب في الموقع",
    actionUrl: "https://arabproserver.com/ar/wallet"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | طلب إيداعك قيد المراجعة ($${Number(payload.amount).toFixed(2)} USD)`,
    html
  });
};

export const sendDepositRejectionEmail = async (
  email: string,
  payload: {
    amount: number;
    method?: string;
    refNo?: string;
    reason?: string;
    username?: string;
  }
): Promise<boolean> => {
  const cleanEmail = email.trim().toLowerCase();
  const username = payload.username || "عزيزنا العميل";
  const lines = [
    `نأسف لإبلاغك بأنه لم يتم اعتماد طلب شحن المحفظة بقيمة <b>$${Number(payload.amount).toFixed(2)} USD</b>.`
  ];
  if (payload.method) {
    lines.push(`<b>وسيلة الدفع:</b> ${escapeEmailHtml(payload.method)}`);
  }
  if (payload.refNo) {
    lines.push(`<b>رقم المرجع:</b> ${escapeEmailHtml(payload.refNo)}`);
  }
  if (payload.reason) {
    lines.push(`<b>السبب:</b> ${escapeEmailHtml(payload.reason)}`);
  }
  lines.push("", "إذا كان لديك أي استفسار أو إيصال بديل، يرجى التواصل مع الدعم الفني.");

  const html = generateLuxuryEmailHtml({
    title: "تحديث بخصوص طلب شحن المحفظة",
    username,
    messageHtml: lines.join("\n"),
    badgeText: "مرفوض",
    actionText: "مراجعة المحفظة",
    actionUrl: "https://arabproserver.com/ar/wallet"
  });

  return sendEmail({
    to: cleanEmail,
    subject: `عرب تك برو سيرفر | تحديث حول طلب شحن الرصيد ($${Number(payload.amount).toFixed(2)} USD)`,
    html
  });
};
