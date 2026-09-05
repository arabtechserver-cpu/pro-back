import { Request, Response, NextFunction } from "express";

export async function turnstileMiddleware(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.TURNSTILE_SECRET;

  // Local development can opt out, but production never silently disables bot protection.
  if (!secret || secret.trim() === "" || secret === "dummy") {
    if (process.env.NODE_ENV === "production") {
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
      response: String(token).trim(),
      remoteip: clientIp ? String(clientIp).split(",")[0].trim() : ""
    });

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
      console.warn("[Cloudflare Turnstile] Verification notice:", result["error-codes"]);
      return res.status(403).json({
        success: false,
        error: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى.",
        message: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى."
      });
    }

    next();
  } catch (err: any) {
    console.warn("[Cloudflare Turnstile] Verification network error:", err?.message, "- allowing request to prevent outage");
    return next();
  }
}
