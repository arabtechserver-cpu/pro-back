import { createHmac, timingSafeEqual } from "crypto";
import https from "https";
import dns from "dns";
import { getCatalogSection } from "./catalog-section";
import { fieldChoices } from "./foxreload-contract";
import { enrichCustomFieldsWithQuantity, extractQuantityLimits, isQuantityField, parseQuantityNumber } from "./provider-quantity";
import { withinDeadline } from "./request-deadline";
import { resolvePrimaryFrontendUrl } from "./telegram-config";
import { formatProviderConnectionError, isPrivateHostname, isPrivateIP } from "./dhru-api";

export interface FusionProOrderStatusCapability {
  version: number;
  mode: string;
  path?: string;
  lookup?: string;
  max_items?: number;
  max_body_bytes?: number;
  max_response_bytes?: number;
  unavailable_state?: string;
}

interface CachedCapabilities {
  expiresAt: number;
  pollingReady: boolean;
  orderStatus?: FusionProOrderStatusCapability;
}

const CAPABILITY_TTL_MS = 15 * 60 * 1000;
const capabilityCache = new Map<string, CachedCapabilities>();

export function isJwtAccessToken(token?: string | null): boolean {
  const trimmed = String(token || "").trim();
  return /^eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}$/.test(trimmed);
}

export function isDhruFusionProUrl(rawUrl?: string | null): boolean {
  const trimmed = String(rawUrl || "").trim();
  if (!trimmed) return false;
  try {
    const candidate = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const pathname = new URL(candidate).pathname.toLowerCase();
    return /\/api\/reseller\/v\d+(?:\/|$)/i.test(pathname);
  } catch {
    return false;
  }
}

export function isDhruFusionProProvider(
  provider?: { id?: string | null; type?: string | null; apiUrl?: string | null; apiKey?: string | null } | null
): boolean {
  if (!provider) return false;
  const type = String(provider.type || "").trim().toLowerCase();
  const apiUrl = String(provider.apiUrl || "").trim();
  if (provider.id === "foxreload-provider" || type === "foxreload") return false;
  try {
    const host = apiUrl ? new URL(/^https?:\/\//i.test(apiUrl) ? apiUrl : `https://${apiUrl}`).hostname.toLowerCase() : "";
    if (host === "foxreload.com" || host.endsWith(".foxreload.com")) return false;
  } catch {}

  return (
    type === "dhru_fusion_pro" ||
    type === "fusion_pro" ||
    type === "dhru-fusion-pro" ||
    isDhruFusionProUrl(apiUrl) ||
    isJwtAccessToken(provider.apiKey)
  );
}

export function normalizeDhruFusionProUrl(rawUrl: string): string {
  let url = (rawUrl || "").trim();
  if (!url) return "";
  if (url.startsWith("http://")) {
    throw new Error("Insecure HTTP provider URLs are prohibited. HTTPS is strictly required.");
  }
  if (!url.startsWith("https://")) {
    url = "https://" + url;
  }
  const urlObj = new URL(url);
  urlObj.username = "";
  urlObj.password = "";
  urlObj.search = "";
  urlObj.hash = "";

  let path = urlObj.pathname.replace(/\/+$/, "").replace(/\/api\/index\.php$/i, "");
  if (!/\/api\/reseller\/v\d+$/i.test(path)) {
    if (/\/api\/reseller$/i.test(path)) {
      path += "/v1";
    } else if (/\/api$/i.test(path)) {
      path += "/reseller/v1";
    } else {
      path += "/api/reseller/v1";
    }
  }
  urlObj.pathname = path;
  return urlObj.toString().replace(/\/+$/, "");
}

function getCallbackSigningSecret(): string {
  return (process.env.JWT_SECRET || "arab-tech-fusion-pro-callback-fallback").trim();
}

export function signFusionProCallbackToken(orderId: string): string {
  return createHmac("sha256", getCallbackSigningSecret())
    .update(`fusion-pro-cb:${orderId}`)
    .digest("hex");
}

export function verifyFusionProCallbackToken(orderId: string, token: string): boolean {
  if (!orderId || !token) return false;
  const expected = signFusionProCallbackToken(orderId);
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(String(token).trim(), "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function buildFusionProCallbackUrl(orderId: string): string | null {
  const baseUrl = resolvePrimaryFrontendUrl();
  if (!baseUrl || !baseUrl.startsWith("https://")) return null;
  const sig = signFusionProCallbackToken(orderId);
  return `${baseUrl}/api/providers/fusion-pro/callback?orderId=${encodeURIComponent(orderId)}&token=${sig}`;
}

function extractFusionProErrorMessage(status: number, data: any, raw: string): string {
  const candidate =
    data?.message ||
    data?.error?.message ||
    (typeof data?.error === "string" ? data.error : "") ||
    (Array.isArray(data?.errors) ? data.errors.map((e: any) => e?.message || String(e)).join(" - ") : "");

  if (candidate && typeof candidate === "string") {
    return candidate.trim();
  }
  if (status === 401) {
    return "رمز الوصول (Access Token) غير صالح أو منتهي الصلاحية لدى Dhru Fusion Pro (401)";
  }
  if (status === 403) {
    return "تم رفض الطلب من المزود (403). تأكد من صلاحيات رمز الوصول وقائمة IP المسموح بها في لوحة المزود.";
  }
  if (status === 429) {
    return "تم تجاوز حد الطلبات المسموح لدى المزود (429). حاول بعد قليل.";
  }
  if (status === 503) {
    return "الخدمة غير متاحة مؤقتاً لدى المزود (503)";
  }
  if (status === 504) {
    return "انتهت مهلة الاتصال بخادم المزود (504)";
  }
  return raw ? raw.replace(/<[^>]*>/g, " ").trim().slice(0, 300) : `HTTP ${status}`;
}

export async function callDhruFusionProApi(
  apiUrl: string,
  apiKey: string,
  endpointPath: string,
  method: "GET" | "POST" = "GET",
  body: any = null,
  extraHeaders: Record<string, string> = {},
  timeoutMs = 30000,
  maxBytes = 16 * 1024 * 1024
): Promise<{
  ok: boolean;
  status: number;
  data: any;
  raw: string;
  errorMessage: string;
  targetUrl: string;
}> {
  let normalizedBase: string;
  try {
    normalizedBase = normalizeDhruFusionProUrl(apiUrl);
  } catch (err: any) {
    return {
      ok: false,
      status: 400,
      data: null,
      raw: err?.message || "Invalid API URL",
      errorMessage: err?.message || "Invalid API URL",
      targetUrl: apiUrl,
    };
  }

  const trimmedKey = String(apiKey || "").trim();
  if (!normalizedBase || !trimmedKey) {
    return {
      ok: false,
      status: 400,
      data: null,
      raw: "Missing provider URL or Access Token",
      errorMessage: "رابط الـ API ورمز الوصول (Access Token) مطلوبان",
      targetUrl: apiUrl,
    };
  }

  const cleanRelativePath = endpointPath.replace(/^\/+/, "");
  const fullUrl = new URL(cleanRelativePath, `${normalizedBase}/`);
  if (fullUrl.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      data: null,
      raw: "HTTPS required",
      errorMessage: "Only HTTPS provider connections are permitted.",
      targetUrl: fullUrl.toString(),
    };
  }

  if (isPrivateHostname(fullUrl.hostname)) {
    return {
      ok: false,
      status: 400,
      data: null,
      raw: "SSRF Blocked",
      errorMessage: "SSRF Attempt Detected: Blocked local/private network address",
      targetUrl: fullUrl.toString(),
    };
  }

  let safeAddress: string;
  try {
    const { address } = await withinDeadline(dns.promises.lookup(fullUrl.hostname), 3000);
    if (isPrivateIP(address)) {
      return {
        ok: false,
        status: 400,
        data: null,
        raw: "SSRF Blocked",
        errorMessage: "SSRF Attempt Detected: Resolved to local/private network address",
        targetUrl: fullUrl.toString(),
      };
    }
    safeAddress = address;
  } catch (dnsErr: any) {
    return {
      ok: false,
      status: 502,
      data: null,
      raw: dnsErr?.message || "DNS error",
      errorMessage: `Failed to resolve provider hostname: ${dnsErr?.message || "DNS lookup failed"}`,
      targetUrl: fullUrl.toString(),
    };
  }

  const payloadString = body !== null && body !== undefined && method === "POST" ? JSON.stringify(body) : "";
  const headers: Record<string, string | number> = {
    Host: fullUrl.hostname,
    Authorization: `Bearer ${trimmedKey}`,
    Accept: "application/json",
    "User-Agent": "ArabTechPro/1.0",
    ...extraHeaders,
  };
  if (payloadString) {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payloadString);
  }

  return new Promise((resolve) => {
    const options = {
      hostname: safeAddress,
      port: fullUrl.port ? parseInt(fullUrl.port, 10) : 443,
      path: fullUrl.pathname + fullUrl.search,
      method,
      family: 4,
      servername: fullUrl.hostname,
      rejectUnauthorized: true,
      headers,
      timeout: timeoutMs,
    };

    let settled = false;
    const finish = (result: {
      ok: boolean;
      status: number;
      data: any;
      raw: string;
      errorMessage: string;
      targetUrl: string;
    }) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const req = https.request({ ...options, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
      let rawText = "";
      let bytes = 0;
      res.on("data", (chunk) => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > maxBytes) {
          req.destroy(new Error(`Provider response exceeds ${maxBytes} bytes limit`));
          return;
        }
        rawText += chunk;
      });
      res.on("end", () => {
        const statusCode = res.statusCode || 200;
        let parsed: any = null;
        try {
          parsed = JSON.parse(rawText);
        } catch {
          parsed = null;
        }

        const apiCode = parsed?.code !== undefined ? Number(parsed.code) : statusCode;
        const statusSuccess = parsed && typeof parsed === "object" && parsed.status === "success";
        const codeOk = Number.isFinite(apiCode) ? apiCode >= 200 && apiCode < 300 : true;
        const ok = statusCode >= 200 && statusCode < 300 && Boolean(statusSuccess) && codeOk;
        const errorMessage = ok ? "" : extractFusionProErrorMessage(statusCode, parsed, rawText);

        finish({
          ok,
          status: statusCode,
          data: parsed,
          raw: rawText,
          errorMessage,
          targetUrl: fullUrl.toString(),
        });
      });
    });

    req.on("timeout", () => {
      req.destroy();
      finish({
        ok: false,
        status: 504,
        data: null,
        raw: "Timeout",
        errorMessage: "انتهت مهلة الاتصال بخادم المزود",
        targetUrl: fullUrl.toString(),
      });
    });

    req.on("error", (err: any) => {
      const msg = formatProviderConnectionError(err, fullUrl.hostname);
      finish({
        ok: false,
        status: err?.name === "AbortError" || err?.name === "TimeoutError" ? 504 : 500,
        data: null,
        raw: msg,
        errorMessage: msg,
        targetUrl: fullUrl.toString(),
      });
    });

    if (payloadString) {
      req.write(payloadString);
    }
    req.end();
  });
}

function cacheAccountCapabilities(baseUrl: string, data: any): boolean {
  const cap = data?.capabilities?.order_status;
  const pollingReady = Boolean(
    cap &&
    cap.version === 1 &&
    cap.mode === "polling" &&
    cap.path === "order_query" &&
    cap.lookup === "order_uuid" &&
    cap.unavailable_state === "unavailable"
  );
  capabilityCache.set(baseUrl, {
    expiresAt: Date.now() + CAPABILITY_TTL_MS,
    pollingReady,
    orderStatus: cap,
  });
  return pollingReady;
}

async function ensurePollingCapability(apiUrl: string, apiKey: string): Promise<boolean> {
  const normalizedBase = normalizeDhruFusionProUrl(apiUrl);
  const cached = capabilityCache.get(normalizedBase);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.pollingReady;
  }
  const res = await callDhruFusionProApi(normalizedBase, apiKey, "/account", "GET", null, {}, 15000);
  if (res.ok && res.data?.data) {
    return cacheAccountCapabilities(normalizedBase, res.data.data);
  }
  return false;
}

export async function getFusionProAccountInfo(apiUrl: string, apiKey: string): Promise<any> {
  const res = await callDhruFusionProApi(apiUrl, apiKey, "/account", "GET", null, {}, 25000);
  if (!res.ok) {
    return {
      SUCCESS: false,
      ERROR: [{ MESSAGE: res.errorMessage || "فشل الاتصال بواجهة Dhru Fusion Pro" }],
      transportError: res.status === 500 || res.status === 502 || res.status === 504,
    };
  }

  const acctData = res.data?.data || res.data || {};
  const balanceNum = parseFloat(String(acctData.balance ?? acctData.credit ?? "0").replace(/[^\d.-]/g, ""));
  if (!Number.isFinite(balanceNum)) {
    return {
      SUCCESS: false,
      ERROR: [{ MESSAGE: "المزود اتصل بنجاح لكن لم يرجع قيمة رصيد واضحة يمكن قراءتها" }],
    };
  }

  const normalizedBase = normalizeDhruFusionProUrl(apiUrl);
  cacheAccountCapabilities(normalizedBase, acctData);

  const currency = String(acctData.currency || "USD").trim().toUpperCase() || "USD";
  return {
    SUCCESS: [
      {
        AccoutInfo: {
          creditraw: balanceNum,
          credit: String(balanceNum),
          currency,
        },
      },
    ],
    fusionPro: {
      balance: balanceNum,
      currency,
      name: acctData.name || "",
      email: acctData.email || "",
      capabilities: acctData.capabilities || {},
    },
  };
}

function mapFusionProFieldType(rawType: string, hasOptions: boolean): string {
  if (hasOptions) return "select";
  if (["select", "dropdown", "selectbox", "choice"].includes(rawType)) return "select";
  if (["textarea", "multiline", "longtext"].includes(rawType)) return "textarea";
  if (["number", "numeric", "integer"].includes(rawType)) return "number";
  if (rawType === "email") return "email";
  if (["password", "pass"].includes(rawType)) return "password";
  return "text";
}

function inferServiceType(rawType: unknown): "imei" | "server" | "remote" {
  const normalized = String(rawType || "").trim().toLowerCase();
  if (normalized.includes("imei")) return "imei";
  if (normalized.includes("remote")) return "remote";
  return "server";
}

export async function fetchFusionProCatalog(apiUrl: string, apiKey: string): Promise<{
  ok: boolean;
  services: any[];
  rawData: any;
  currency: string;
  error?: string;
}> {
  const res = await callDhruFusionProApi(apiUrl, apiKey, "/products", "GET", null, {}, 45000);
  if (!res.ok) {
    return {
      ok: false,
      services: [],
      rawData: res.data || { error: res.errorMessage },
      currency: "USD",
      error: res.errorMessage || "فشل جلب قائمة الخدمات من Dhru Fusion Pro",
    };
  }

  const payload = res.data?.data || {};
  const currency = String(payload.currency || "USD").trim().toUpperCase() || "USD";

  const categoriesMap = new Map<string, string>();
  if (Array.isArray(payload.categories)) {
    for (const cat of payload.categories) {
      if (!cat || typeof cat !== "object") continue;
      const cid = String(cat.id ?? cat.cid ?? "").trim();
      const cname = String(cat.name || cat.title || "").trim();
      if (cid && cname) categoriesMap.set(cid, cname);
    }
  } else if (payload.categories && typeof payload.categories === "object") {
    for (const [cid, catVal] of Object.entries(payload.categories as Record<string, any>)) {
      const cname = typeof catVal === "string"
        ? catVal.trim()
        : String(catVal?.name || catVal?.title || "").trim();
      if (cid && cname) categoriesMap.set(String(cid), cname);
    }
  }

  const productEntries: Array<[string, any]> = Array.isArray(payload.products)
    ? payload.products.map((p: any, idx: number) => [String(p?.id ?? p?.product_id ?? p?.uuid ?? idx), p])
    : (payload.products && typeof payload.products === "object"
        ? Object.entries(payload.products as Record<string, any>)
        : []);

  const services: any[] = [];
  for (const [keyId, p] of productEntries) {
    if (!p || typeof p !== "object") continue;
    const sId = String(p.id ?? p.product_id ?? p.uuid ?? keyId).trim();
    const sName = String(p.name ?? p.title ?? "").trim();
    if (!sId || !sName) continue;

    const apiServiceType = inferServiceType(p.type ?? p.service_type);
    const categoryName =
      apiServiceType === "imei"
        ? "IMEI Service"
        : apiServiceType === "remote"
          ? "Remote Service"
          : "Server Service";

    const rawCids = Array.isArray(p.cids) ? p.cids : (p.cid !== undefined ? [p.cid] : (p.category_id !== undefined ? [p.category_id] : []));
    const resolvedGroupName =
      rawCids.map((cid: any) => categoriesMap.get(String(cid))).find(Boolean) ||
      String(p.category_name || p.group_name || "").trim() ||
      (apiServiceType === "imei" ? "IMEI Services" : apiServiceType === "remote" ? "Remote Services" : "Server Services");

    const credit = parseFloat(String(p.price ?? p.credit ?? "0")) || 0;
    const sTime = String(p.delivery_time ?? p.time ?? p.delivery ?? "1-24 Hours").trim() || "1-24 Hours";
    const sInfo = String(p.info ?? p.description ?? "").trim();

    let fieldQtyMin: number | null = null;
    let fieldQtyMax: number | null = null;
    const rawFields = Array.isArray(p.fields) ? p.fields : [];
    const normalizedFields: any[] = [];

    for (const f of rawFields) {
      if (!f || typeof f !== "object") continue;
      const fieldName = String(f.name || f.field_id || f.fieldname || f.label || "").trim();
      if (!fieldName) continue;

      const rawType = String(f.type || f.fieldtype || "text").trim().toLowerCase();
      const choices = fieldChoices(f.options ?? f.option_choices ?? f.fieldoptions);
      const fieldoptions = choices.map((c) => c.value);
      const isQty = rawType === "quantity" || isQuantityField(f, fieldName);
      const mappedType = isQty ? "quantity" : mapFusionProFieldType(rawType, fieldoptions.length > 0);
      const fMin = parseQuantityNumber(f.min_quantity ?? f.minQty ?? f.min);
      const fMax = parseQuantityNumber(f.max_quantity ?? f.maxQty ?? f.max);

      if (isQty) {
        if (fieldQtyMin === null && fMin !== null) fieldQtyMin = fMin;
        if (fieldQtyMax === null && fMax !== null) fieldQtyMax = fMax;
      }

      const description = String(f.description || f.placeholder || "").trim();
      normalizedFields.push({
        id: `custom_${fieldName}`,
        field_id: fieldName,
        name: fieldName,
        label: isQty ? "الكمية (Quantity)" : String(f.label || fieldName).trim(),
        type: mappedType,
        fieldtype: mappedType,
        is_quantity: isQty,
        synthetic_quantity: false,
        required: isQty ? true : Boolean(f.required === true || f.required === 1 || f.required === "1"),
        description,
        placeholder: description || (isQty ? "أدخل الكمية المطلوبة" : `أدخل ${fieldName}`),
        options: fieldoptions,
        fieldoptions,
        option_choices: choices,
        provider_field_type: rawType,
        min_quantity: fMin ?? undefined,
        max_quantity: fMax ?? undefined,
      });
    }

    const qtyLimits = extractQuantityLimits(
      {
        ...p,
        SERVICENAME: sName,
        INFO: sInfo,
        SERVICETYPE: apiServiceType,
        groupName: resolvedGroupName,
        min_quantity: p.min_quantity ?? p.min_qty ?? fieldQtyMin ?? undefined,
        max_quantity: p.max_quantity ?? p.max_qty ?? fieldQtyMax ?? undefined,
      },
      normalizedFields
    );

    const enrichedFields = qtyLimits.supportsQty
      ? enrichCustomFieldsWithQuantity(normalizedFields, qtyLimits)
      : normalizedFields;

    const sectionId = getCatalogSection(apiServiceType, resolvedGroupName, String(p.type || ""));
    services.push({
      id: sId,
      service_id: sId,
      name: sName,
      service_name: sName,
      group_name: resolvedGroupName,
      groupName: resolvedGroupName,
      category_name: categoryName,
      service_type: apiServiceType,
      api_service_type: apiServiceType,
      section_id: sectionId,
      category_key: sectionId,
      section_name: resolvedGroupName,
      credit,
      price: credit,
      time: sTime,
      info: sInfo,
      customFields: enrichedFields,
      requiresCustom: enrichedFields.length > 0 ? JSON.stringify(enrichedFields) : null,
      supportsQty: qtyLimits.supportsQty,
      supports_quantity: qtyLimits.supportsQty,
      minQty: qtyLimits.minQty,
      maxQty: qtyLimits.maxQty,
      min_quantity: qtyLimits.minQty,
      max_quantity: qtyLimits.maxQty,
    });
  }

  return {
    ok: true,
    services,
    rawData: res.data,
    currency,
  };
}

function buildReferenceId(orderId?: string): string {
  const cleaned = String(orderId || "").replace(/[^A-Za-z0-9-]/g, "").slice(0, 50);
  if (cleaned) return cleaned;
  return `ord-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 50);
}

export async function placeFusionProOrder(params: {
  apiUrl: string;
  apiKey: string;
  serviceId: string;
  targetInput?: string;
  quantity?: number;
  customFields?: Record<string, any>;
  requiresCustom?: string | null;
  orderId?: string;
}): Promise<any> {
  const { apiUrl, apiKey, serviceId, targetInput, quantity = 1, customFields = {}, requiresCustom, orderId } = params;

  let metaList: any[] = [];
  try {
    if (requiresCustom) {
      const parsed = JSON.parse(requiresCustom);
      if (Array.isArray(parsed)) metaList = parsed;
    }
  } catch {}

  const nonQtyMeta = metaList.filter(
    (m) => m && typeof m === "object" && !m.synthetic_quantity && m.field_id !== "custom_QNT" && !isQuantityField(m)
  );
  const qtyMeta = metaList.find((m) => m && typeof m === "object" && !m.synthetic_quantity && isQuantityField(m));

  const canonical = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const orderFields: Record<string, string | number> = {};

  if (customFields && typeof customFields === "object") {
    for (const [rawKey, rawVal] of Object.entries(customFields)) {
      if (rawVal === undefined || rawVal === null) continue;
      const valStr = String(rawVal).trim();
      if (!valStr) continue;

      const strippedKey = rawKey.replace(/^custom_/i, "").trim();
      if (isQuantityField(undefined, strippedKey)) continue;

      const lower = strippedKey.toLowerCase();
      const canon = canonical(strippedKey);
      const matched = nonQtyMeta.find((m) => {
        const fid = String(m.field_id || "").trim().toLowerCase();
        const fname = String(m.name || "").trim().toLowerCase();
        const flabel = String(m.label || "").trim().toLowerCase();
        return (
          fid === lower ||
          fname === lower ||
          flabel === lower ||
          canonical(fid) === canon ||
          canonical(fname) === canon ||
          canonical(flabel) === canon
        );
      });

      const exactKey = String(matched?.name || matched?.field_id || strippedKey).trim();
      if (exactKey) {
        orderFields[exactKey] = valStr;
      }
    }
  }

  const trimmedTarget = String(targetInput || "").trim();
  if (trimmedTarget) {
    const primaryMeta =
      nonQtyMeta.find((m) =>
        /^(imei|sn|serial|imei[\/_\s]?sn|udid|ecid|account|username|email)$/i.test(String(m.name || m.field_id || "").trim())
      ) || (Object.keys(orderFields).length === 0 ? nonQtyMeta[0] : undefined);

    if (primaryMeta) {
      const targetKey = String(primaryMeta.name || primaryMeta.field_id).trim();
      if (targetKey && !orderFields[targetKey]) {
        orderFields[targetKey] = trimmedTarget;
      }
    } else if (Object.keys(orderFields).length === 0) {
      orderFields.IMEI = trimmedTarget;
    }
  }

  const finalQty = Math.max(1, Math.floor(Number(quantity) || 1));
  if (qtyMeta) {
    const qtyKey = String(qtyMeta.name || qtyMeta.field_id || "Quantity").trim();
    orderFields[qtyKey] = finalQty;
  } else if (finalQty > 1) {
    orderFields.Quantity = finalQty;
  }

  orderFields.reference_id = buildReferenceId(orderId);

  const pollingReady = await ensurePollingCapability(apiUrl, apiKey);
  if (!pollingReady && orderId) {
    const callbackUrl = buildFusionProCallbackUrl(orderId);
    if (callbackUrl) {
      orderFields.feedback_url = callbackUrl;
    }
  }

  const cleanServiceId = String(serviceId).trim();
  const payload = /^\d+$/.test(cleanServiceId)
    ? [{ product_id: Number(cleanServiceId), fields: [orderFields] }]
    : [{ product_uuid: cleanServiceId, fields: [orderFields] }];

  const res = await callDhruFusionProApi(apiUrl, apiKey, "/order", "POST", payload, {}, 60000);
  if (!res.ok) {
    return {
      SUCCESS: false,
      ERROR: [{ MESSAGE: res.errorMessage || "رفض مزود Dhru Fusion Pro الطلب" }],
      transportError: res.status === 500 || res.status === 502 || res.status === 504,
    };
  }

  const dataNode = res.data?.data;
  const firstItem = Array.isArray(dataNode?.[0])
    ? dataNode[0][0]
    : Array.isArray(dataNode)
      ? dataNode[0]
      : dataNode;

  const orderUuid = String(firstItem?.order_uuid || firstItem?.order_id || firstItem?.uuid || "").trim();
  if (!orderUuid) {
    const itemError = firstItem?.error || firstItem?.message || res.data?.message || "لم يرجع المزود رقم مرجع للطلب";
    return {
      SUCCESS: false,
      ERROR: [{ MESSAGE: String(itemError) }],
    };
  }

  return {
    SUCCESS: [
      {
        REFERENCEID: orderUuid,
        ID: orderUuid,
        MESSAGE: res.data?.message || "Order submitted",
      },
    ],
    fusionPro: firstItem,
  };
}

export async function getFusionProOrderStatus(apiUrl: string, apiKey: string, orderUuid: string): Promise<any> {
  const cleanUuid = String(orderUuid || "").trim();
  if (!cleanUuid) {
    return { SUCCESS: false, ERROR: [{ MESSAGE: "Missing order UUID" }] };
  }

  const res = await callDhruFusionProApi(
    apiUrl,
    apiKey,
    `/order?${new URLSearchParams({ order_uuid: cleanUuid }).toString()}`,
    "GET",
    null,
    {},
    30000,
    8 * 1024 * 1024
  );

  // Per official Fusion Pro spec, 503 ORDER_RESULT_UNAVAILABLE / state=unavailable is non-terminal.
  if (
    res.status === 503 ||
    res.data?.code === "ORDER_RESULT_UNAVAILABLE" ||
    res.data?.data?.state === "unavailable"
  ) {
    return {
      SUCCESS: [{ STATUS: "1", STATUS_TEXT: "processing", CODE: "", REPLY: "" }],
    };
  }

  if (!res.ok) {
    return {
      SUCCESS: false,
      ERROR: [{ MESSAGE: res.errorMessage || "تعذر الاستعلام عن حالة الطلب لدى Dhru Fusion Pro" }],
      transportError: res.status === 500 || res.status === 502 || res.status === 504,
    };
  }

  const details = res.data?.data || {};
  const rawStatus = String(details.status || "").trim().toLowerCase();
  const reply = String(details.replay ?? details.reply ?? "").trim();

  if (rawStatus === "success" || rawStatus === "completed") {
    return {
      SUCCESS: [{ STATUS: "4", STATUS_TEXT: "completed", CODE: reply, REPLY: reply }],
    };
  }

  if (["rejected", "canceled", "cancelled", "failed"].includes(rawStatus)) {
    return {
      SUCCESS: [{ STATUS: "3", STATUS_TEXT: "rejected", CODE: reply, REPLY: reply, REASON: reply }],
    };
  }

  return {
    SUCCESS: [{ STATUS: "1", STATUS_TEXT: rawStatus || "processing", CODE: reply, REPLY: reply }],
  };
}
