import { Request, Response, NextFunction } from "express";

export async function turnstileMiddleware(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.TURNSTILE_SECRET;

  // Local development can opt out, but production never silently disables bot protection.
  if (!secret || secret.trim() === "" || secret === "dummy") {
    if (process.env.NODE_ENV === "production") {
      return res.status(503).json({ message: "خدمة التحقق الأمني غير مهيأة حالياً." });
    }
    return next();
  }

  const token = req.body?.["cf-turnstile-response"] || req.headers["cf-turnstile-response"] || req.body?.turnstileToken;
  const clientIp = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress;

  if (!token || token === "cf-turnstile-client-fallback") {
    return res.status(403).json({ message: "يرجى إكمال التحقق الأمني قبل المتابعة." });
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
      console.warn(`[Cloudflare Turnstile] Verification endpoint returned status ${response.status}`);
      return res.status(503).json({ message: "تعذر التحقق الأمني مؤقتاً. يرجى المحاولة لاحقاً." });
    }

    const result: any = await response.json();

    if (!result.success) {
      console.warn("[Cloudflare Turnstile] Verification notice:", result["error-codes"]);
      const errorCodes = result["error-codes"] || [];
      return res.status(403).json({ message: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى." });
    }

    next();
  } catch (err: any) {
    console.warn("[Cloudflare Turnstile] Verification error:", err?.message);
    return res.status(503).json({ message: "تعذر التحقق الأمني مؤقتاً. يرجى المحاولة لاحقاً." });
  }
}
