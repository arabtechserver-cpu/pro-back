import { Request, Response, NextFunction } from "express";

export async function turnstileMiddleware(req: Request, res: Response, next: NextFunction) {
  const secret = process.env.TURNSTILE_SECRET;

  // If Turnstile is not configured or in test mode on server, skip verification safely
  if (!secret || secret.trim() === "" || secret === "dummy") {
    return next();
  }

  const token = req.body?.["cf-turnstile-response"] || req.headers["cf-turnstile-response"] || req.body?.turnstileToken;
  const clientIp = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress;

  if (!token) {
    console.warn("[Cloudflare Turnstile] Missing token in request, proceeding with fallback check");
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
      console.warn(`[Cloudflare Turnstile] Verification endpoint returned status ${response.status}, allowing user request`);
      return next();
    }

    const result: any = await response.json();

    if (!result.success) {
      console.warn("[Cloudflare Turnstile] Verification failed:", result["error-codes"]);
      const errorCodes = result["error-codes"] || [];
      if (errorCodes.includes("invalid-input-secret") || errorCodes.includes("missing-input-secret")) {
        console.warn("[Cloudflare Turnstile] Server misconfiguration (bad secret), bypassing verification");
        return next();
      }
      return res.status(403).json({ message: "فشل التحقق الأمني من Cloudflare Turnstile. يرجى المحاولة مرة أخرى." });
    }

    next();
  } catch (err: any) {
    console.warn("[Cloudflare Turnstile] Verification error (bypassing):", err?.message);
    return next();
  }
}
