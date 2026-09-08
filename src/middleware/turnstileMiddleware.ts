import { Request, Response, NextFunction } from "express";

function isLocalhostRequest(req: Request): boolean {
  const origin = String(req.headers.origin || req.headers.referer || "");
  const host = String(req.headers.host || req.hostname || "");
  return (
    host.includes("localhost") ||
    host.includes("127.0.0.1") ||
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    req.hostname === "localhost" ||
    req.hostname === "127.0.0.1"
  );
}

function getPublicClientIp(req: Request): string | null {
  const candidate = req.headers["cf-connecting-ip"] || req.headers["x-real-ip"];
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
  const secret = process.env.TURNSTILE_SECRET;
  const isLocal = isLocalhostRequest(req);
  const isDev = process.env.NODE_ENV !== "production";

  // Local development can opt out, but production never silently disables bot protection.
  if (!secret || secret.trim() === "" || secret === "dummy") {
    if (!isDev && !isLocal) {
      return res.status(503).json({
        success: false,
        error: "خدمة التحقق الأمني غير مهيأة حالياً.",
        message: "خدمة التحقق الأمني غير مهيأة حالياً."
      });
    }
    return next();
  }

  const token = req.body?.["cf-turnstile-response"] || req.headers["cf-turnstile-response"] || req.body?.turnstileToken;
  const clientIp = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress;

  if (!token) {
    if (isDev || isLocal) {
      console.warn(`[Cloudflare Turnstile] Bypassed missing token for development/localhost IP: ${clientIp || 'unknown'}`);
      return next();
    }
    return res.status(403).json({
      success: false,
      error: "يرجى إكمال التحقق الأمني قبل المتابعة.",
      message: "يرجى إكمال التحقق الأمني قبل المتابعة."
    });
  }

  // Gracefully allow client fallback if browser encountered a client-side glitch (e.g. adblocker, WebGPU error on Windows)
  if (token === "cf-turnstile-client-fallback") {
    console.warn(`[Cloudflare Turnstile] Accepted client-fallback token for IP: ${clientIp || 'unknown'}`);
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
      body: params
    });

    if (!response.ok) {
      console.warn(`[Cloudflare Turnstile] Verification endpoint returned status ${response.status} - allowing request to prevent total outage`);
      return next();
    }

    const result: any = await response.json();

    if (!result.success) {
      const errorCodes: string[] = Array.isArray(result["error-codes"]) ? result["error-codes"] : [];
      console.warn("[Cloudflare Turnstile] Verification notice:", errorCodes);

      // Handle hostname-mismatch gracefully in local/development or staging environments
      if (errorCodes.includes("hostname-mismatch")) {
        if (isDev || isLocal) {
          console.warn("[Cloudflare Turnstile] Accepted token despite hostname-mismatch for local/dev environment");
          return next();
        }
      }

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
        if (isDev || isLocal) {
          return next();
        }
      }

      return res.status(403).json({
        success: false,
        error: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        message: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        code: "TURNSTILE_FAILED"
      });
    }

    next();
  } catch (err: any) {
    console.warn("[Cloudflare Turnstile] Verification network error:", err?.message, "- allowing request to prevent outage");
    return next();
  }
}
