import { Request, Response, NextFunction } from "express";
import { extractClientIp } from '../utils/ipUtils';



function getPublicClientIp(req: Request): string | null {
  const candidate = extractClientIp(req);
  if (typeof candidate === "string" && candidate.trim()) {
    const ip = candidate.trim().split(",")[0].trim();
    // Exclude loopback and private ranges (RFC 1918)
    if (
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip.startsWith("10.") ||
      ip.startsWith("192.168.") ||
      /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(ip) ||
      ip.startsWith("fc00:") ||
      ip.startsWith("fe80:")
    ) {
      return null;
    }
    return ip;
  }
  return null;
}

export async function turnstileMiddleware(req: Request, res: Response, next: NextFunction) {
  const isDev = process.env.NODE_ENV === "development";
  if (
    process.env.DISABLE_TURNSTILE === "true" ||
    process.env.DISABLE_CLOUDFLARE === "true" ||
    process.env.NEXT_PUBLIC_DISABLE_TURNSTILE === "true" ||
    process.env.TURNSTILE_SECRET === "disabled"
  ) {
    if (isDev) return next();
    return res.status(503).json({ success: false, error: "Security verification must be enabled in production" });
  }

  const secret = process.env.TURNSTILE_SECRET;

  // Local development can opt out, but production never silently disables bot protection.
  if (!secret || secret.trim() === "" || secret === "dummy") {
    if (!isDev) {
      return res.status(503).json({
        success: false,
        error: "خدمة التحقق الأمني غير مهيأة حالياً.",
        message: "خدمة التحقق الأمني غير مهيأة حالياً."
      });
    }
    return next();
  }

  const token = req.body?.["cf-turnstile-response"] || req.headers["cf-turnstile-response"] || req.body?.turnstileToken;
  const clientIp = extractClientIp(req);

  if (!token) {
    if (isDev) {
      console.warn(`[Cloudflare Turnstile] Bypassed missing token for development IP: ${clientIp || 'unknown'}`);
      return next();
    }
    return res.status(403).json({
      success: false,
      error: "يرجى إكمال التحقق الأمني قبل المتابعة.",
      message: "يرجى إكمال التحقق الأمني قبل المتابعة."
    });
  }

  if (token === "cf-turnstile-client-fallback" || token === "turnstile-disabled") {
    if (!isDev || process.env.STRICT_TURNSTILE === "true") {
      return res.status(403).json({
        success: false,
        error: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        message: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        code: "TURNSTILE_FAILED"
      });
    }
    console.warn(`[Cloudflare Turnstile] Accepted client fallback in development for IP: ${clientIp || 'unknown'}`);
    return next();
  }

  try {
    const params = new URLSearchParams({
      secret: secret.trim(),
      response: String(token).trim()
    });

    // Only pass remoteip if it is a validated external public IP (omitting it avoids false rejections behind Docker/proxy)
    const publicIp = getPublicClientIp(req);
    if (publicIp) {
      params.append("remoteip", publicIp);
    }

    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params,
      signal: AbortSignal.timeout(5000)
    });

    if (!response.ok) {
      console.warn(`[Cloudflare Turnstile] Verification endpoint returned status ${response.status}`);
      return res.status(403).json({
        success: false,
        error: "فشل التحقق الأمني من Cloudflare Turnstile (Network Error). يرجى المحاولة مرة أخرى.",
        message: "فشل التحقق الأمني من Cloudflare Turnstile (Network Error). يرجى المحاولة مرة أخرى.",
        code: "TURNSTILE_FAILED"
      });
    }

    const result: any = await response.json();

    if (result.success !== true) {
      const errorCodes: string[] = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
      console.warn("[Cloudflare Turnstile] Verification notice:", errorCodes);

      // Specific message for expired or already-used tokens so client can trigger a clean refresh
      if (errorCodes.includes("timeout-or-duplicate")) {
        return res.status(403).json({
          success: false,
          error: "انتهت صلاحية رمز التحقق الأمني، يرجى المحاولة مجدداً.",
          message: "انتهت صلاحية رمز التحقق الأمني، يرجى المحاولة مجدداً.",
          code: "TURNSTILE_EXPIRED"
        });
      }

      if (errorCodes.includes("invalid-input-secret")) {
        console.error("[Cloudflare Turnstile] CRITICAL: TURNSTILE_SECRET is invalid in environment variables!");
      }

      return res.status(403).json({
        success: false,
        error: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        message: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        code: "TURNSTILE_FAILED"
      });
    }

    const hostnames = (process.env.TURNSTILE_ALLOWED_HOSTNAMES || 'arabtechproserver.tech,www.arabtechproserver.tech,borai.store,www.borai.store')
      .split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
    if (!isDev && (typeof result.hostname !== 'string' || !hostnames.includes(result.hostname.toLowerCase()))) {
      return res.status(403).json({ success: false, error: 'Security verification hostname mismatch', code: 'TURNSTILE_FAILED' });
    }
    next();
  } catch (err: any) {
    console.warn("[Cloudflare Turnstile] Verification network error:", err?.message);
    return res.status(403).json({
      success: false,
      error: "تعذر الاتصال بخدمة التحقق الأمني. يرجى التحقق من اتصالك والمحاولة مرة أخرى.",
      message: "تعذر الاتصال بخدمة التحقق الأمني. يرجى التحقق من اتصالك والمحاولة مرة أخرى.",
      code: "TURNSTILE_NETWORK_ERROR"
    });
  }
}
