import { Router } from "express";
import { prisma } from "../utils/prisma";
import { cleanServiceName } from "../scripts/syncDhruServices";
import { buildProviderServiceId } from "../utils/provider-service-id";
import https from "https";
import http from "http";
import { isAdmin } from '../middleware/auth';
import {
  isQuantityField,
  extractQuantityLimits,
  getServiceQuantityConfig,
  enrichCustomFieldsWithQuantity
} from "../utils/provider-quantity";
import { invalidateDhruServicesCache } from "./dhru";

const router = Router();

router.use(isAdmin);

// Helper to format API url
export function normalizeApiUrl(rawUrl: string): string {
  let url = (rawUrl || "").trim();
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  const urlObj = new URL(url);
  const path = urlObj.pathname.replace(/\/+$/, "");
  const hasExplicitApiEndpoint =
    /\/api\/index\.php$/i.test(path) ||
    /\/api\/v\d+$/i.test(path) ||
    (path.includes("/api/") && !/\/api$/i.test(path));

  if (!hasExplicitApiEndpoint) {
    if (/\/api$/i.test(path)) {
      url = url.replace(/\/$/, '') + '/index.php';
    } else {
      url = url.replace(/\/$/, '') + '/api/index.php';
    }
  }
  return url;
}

function collectAccountInfoCandidates(payload: any): any[] {
  if (!payload || typeof payload !== "object") return [];

  const candidates: any[] = [payload];

  if (Array.isArray(payload.SUCCESS)) candidates.push(...payload.SUCCESS);
  else if (payload.SUCCESS && typeof payload.SUCCESS === "object") candidates.push(payload.SUCCESS);

  if (Array.isArray(payload.RESULT)) candidates.push(...payload.RESULT);
  else if (payload.RESULT && typeof payload.RESULT === "object") candidates.push(payload.RESULT);

  return candidates.flatMap((candidate) => {
    if (!candidate || typeof candidate !== "object") return [];
    return [candidate, candidate.AccountInfo, candidate.accountinfo, candidate.accountInfo].filter(Boolean);
  });
}

function parseProviderNumber(value: any): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = parseFloat(String(value).replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

export function extractProviderAccountInfo(payload: any): { balance: number; currency: string } | null {
  const candidates = collectAccountInfoCandidates(payload);

  for (const candidate of candidates) {
    const balance =
      parseProviderNumber(candidate?.credit) ??
      parseProviderNumber(candidate?.balance) ??
      parseProviderNumber(candidate?.credits) ??
      parseProviderNumber(candidate?.amount);

    if (balance === null) continue;

    const currency = String(candidate?.currency || candidate?.Currency || payload?.currency || "USD").trim() || "USD";
    return { balance, currency };
  }

  return null;
}

export function getProviderApiErrorMessage(payload: any): string | null {
  if (!payload) return null;

  const rawError = payload.ERROR ?? payload.Error ?? payload.error ?? payload.message ?? payload.MESSAGE;
  if (!rawError) return null;

  if (Array.isArray(rawError) && rawError[0]) {
    return stripHtml(String(rawError[0].MESSAGE || rawError[0].message || rawError[0].error || rawError[0]));
  }

  if (typeof rawError === "object") {
    return stripHtml(String(rawError.MESSAGE || rawError.message || JSON.stringify(rawError)));
  }

  return stripHtml(String(rawError));
}

export function isProviderApiSuccess(payload: any): boolean {
  if (!payload) return false;
  if (payload.SUCCESS === false) return false;
  if (getProviderApiErrorMessage(payload)) return false;
  return extractProviderAccountInfo(payload) !== null || Boolean(payload.SUCCESS) || Boolean(payload.RESULT);
}

function summarizeProviderApiFailure(responses: Array<{ data: any; raw: string }>): string {
  for (const response of responses) {
    const message = getProviderApiErrorMessage(response?.data) || stripHtml(response?.raw);
    if (message) return message;
  }
  return "لم يرجع المزود بيانات قابلة للقراءة";
}

// Strip HTML tags from strings
export function stripHtml(str: any): string {
  if (typeof str !== "string") return String(str || "");
  return str.replace(/<[^>]*>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").trim();
}

export function normalizeFieldType(value: any): string {
  const type = String(value || "text").trim().toLowerCase();
  if (["select", "dropdown", "selectbox", "choice"].includes(type)) return "select";
  if (["textarea", "multiline", "longtext"].includes(type)) return "textarea";
  if (["number", "numeric", "integer"].includes(type)) return "number";
  if (type === "email") return "email";
  if (["password", "pass"].includes(type)) return "password";
  return "text";
}

export function normalizeFieldOptions(value: any): string[] {
  if (Array.isArray(value)) {
    return value.map(option => stripHtml(option)).filter(Boolean);
  }
  if (value && typeof value === "object") {
    return Object.values(value).map(option => stripHtml(option)).filter(Boolean);
  }
  if (typeof value !== "string") return [];

  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      return normalizeFieldOptions(JSON.parse(trimmed));
    } catch (e) {}
  }
  return trimmed.split(/[,\n|]+/).map(option => stripHtml(option)).filter(Boolean);
}

export function isRequiredField(value: any): boolean {
  if (value === true || value === 1) return true;
  return ["1", "true", "yes", "on", "required"].includes(String(value ?? "").trim().toLowerCase());
}

export function extractCustomFields(service: any): any[] {
  const s = service || {};
  const nestedRequires = s.Requires || s.REQUIRES || {};
  const allFields: any[] = [];

  const addRaw = (raw: any) => {
    if (raw === null || raw === undefined || raw === "") return;

    if (typeof raw === "string") {
      const trimmed = raw.trim();
      if (!trimmed) return;
      if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
        try {
          raw = JSON.parse(trimmed);
        } catch (e) {}
      }
    }

    if (Array.isArray(raw)) {
      const parsed = raw.filter(
        field =>
          field &&
          typeof field === "object" &&
          (field.fieldname || field.FIELDNAME || field.field_name || field.name || field.NAME || field.customname || field.reqid || field.label)
      );
      allFields.push(...parsed);
      return;
    }

    if (raw && typeof raw === "object") {
      const looksLikeField = [
        "fieldname",
        "FIELDNAME",
        "field_name",
        "name",
        "NAME",
        "customname",
        "fieldtype",
        "FIELDTYPE",
        "required",
        "REQUIRED"
      ].some(key => Object.prototype.hasOwnProperty.call(raw, key));

      if (looksLikeField) {
        allFields.push(raw);
        return;
      }

      const parsed = Object.entries(raw).map(([key, value]: [string, any]) => ({
        field_id: (value && (value.reqid || value.REQID || value.field_id || value.id || value.ID)) || key,
        fieldname: (value && (value.FIELDNAME || value.fieldname || value.field_name || value.name || value.NAME || value.label)) || key,
        fieldtype: (value && (value.FIELDTYPE || value.fieldtype || value.type)) || "text",
        required: (value && (value.REQUIRED ?? value.required)) ?? "on",
        description: (value && (value.DESCRIPTION || value.description || value.placeholder)) || "",
        fieldoptions: (value && (value.FIELDOPTIONS ?? value.fieldoptions ?? value.options)) || ""
      }));
      allFields.push(...parsed);
      return;
    }

    if (typeof raw === "string") {
      const parsed = raw
        .split(",")
        .map(name => name.trim())
        .filter(Boolean)
        .map(name => ({
          fieldname: name,
          fieldtype: "text",
          required: "on",
          description: ""
        }));
      allFields.push(...parsed);
    }
  };

  const candidates = [
    s["Requires.Custom"],
    s["REQUIRES.CUSTOM"],
    nestedRequires.Custom,
    nestedRequires.CUSTOM,
    nestedRequires.custom,
    s.CUSTOM,
    s.Custom,
    s.custom,
    s.RequiresCustom,
    s.CUSTOMFIELD,
    s.CUSTOMFIELDS,
    s.customfields,
    s.CustomFields,
    s.FIELDS,
    s.Fields,
    s.FIELD,
    s.fields
  ];

  candidates.forEach(addRaw);

  const fieldKey = Object.keys(s).find(key => {
    const normalized = key.replace(/[._\s-]/g, "").toLowerCase();
    return ["requirescustom", "customfield", "customfields", "fields", "field"].includes(normalized);
  });
  if (fieldKey && !candidates.includes(s[fieldKey])) {
    addRaw(s[fieldKey]);
  }

  // Deduplicate fields by fieldname
  const uniqueFields: any[] = [];
  const seen = new Set<string>();

  for (const field of allFields) {
    const name = String(
      field.customname || field.fieldname || field.FIELDNAME || field.field_name || field.name || field.NAME || field.label || ""
    ).trim().toLowerCase();

    // Ignore internal provider fields like order code / supplier code
    if (
      name.includes("order_code") ||
      name.includes("ordercode") ||
      name.includes("order code") ||
      name.includes("ref_code") ||
      name.includes("refcode") ||
      name.includes("supplier_code") ||
      name.includes("provider_code") ||
      name.includes("code_id")
    ) {
      continue;
    }

    if (name && !seen.has(name)) {
      seen.add(name);
      uniqueFields.push(field);
    }
  }

  return uniqueFields;
}

export function normalizeCustomField(cf: any): any {
  const field = cf || {};
  const name = stripHtml(
    String(field.customname || field.fieldname || field.FIELDNAME || field.field_name || field.name || field.NAME || field.label || "").trim()
  );
  if (!name) return null;

  const description = stripHtml(String(field.description || field.DESCRIPTION || field.placeholder || "").trim());
  const fieldoptions = normalizeFieldOptions(field.fieldoptions ?? field.FIELDOPTIONS ?? field.options);
  const rawType = field.fieldtype || field.FIELDTYPE || field.type;
  const normalizedType = normalizeFieldType(rawType);
  const isQty = isQuantityField(field, name);
  const resolvedType = isQty ? "quantity" : (fieldoptions.length > 0 && normalizedType === "text" ? "select" : normalizedType);

  return {
    id: `custom_${String(field.field_id || field.reqid || field.REQID || field.id || name).trim()}`,
    field_id: String(field.field_id || field.reqid || field.REQID || field.id || name).trim(),
    name,
    label: isQty ? "الكمية (Quantity)" : name,
    type: resolvedType,
    fieldtype: resolvedType,
    is_quantity: isQty,
    required: isQty ? true : isRequiredField(field.required ?? field.REQUIRED),
    description,
    placeholder: description || (isQty ? "أدخل الكمية المطلوبة" : `أدخل ${name}`),
    options: fieldoptions,
    fieldoptions,
    min_quantity: field.min_quantity ?? field.minQty ?? field.min ?? undefined,
    max_quantity: field.max_quantity ?? field.maxQty ?? field.max ?? undefined
  };
}

// Helper to make API calls to any provider
export function makeProviderApiCall(
  apiUrl: string,
  username: string | null | undefined,
  apiKey: string,
  action: string,
  parameters: Record<string, string> = {}
): Promise<{ ok: boolean; status: number; data: any; raw: string; targetUrl: string }> {
  return new Promise((resolve) => {
    try {
      const targetUrl = normalizeApiUrl(apiUrl);
      const data = new URLSearchParams();
      if (username) data.append("username", username.trim());
      data.append("key", apiKey.trim());
      data.append("apiaccesskey", apiKey.trim());
      data.append("action", action);
      data.append("requestformat", "JSON");

      // Format parameters
      Object.entries(parameters).forEach(([k, v]) => {
        data.append(`parameters[${k}]`, v);
      });

      const postData = data.toString();
      const urlObj = new URL(targetUrl);
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        // Enforce IPv4 lookup explicitly to match old dhruClient.js behavior inside Docker
        family: 4, 
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*"
        },
        timeout: 60000
      };

      const client = urlObj.protocol === "https:" ? https : http;
      
      const req = client.request(options, (res) => {
        let rawText = "";
        res.on("data", (chunk) => { rawText += chunk; });
        res.on("end", () => {
          let result: any;
          try {
            result = JSON.parse(rawText);
          } catch {
            result = { error: rawText };
          }
          resolve({ ok: (res.statusCode || 200) < 400, status: res.statusCode || 200, data: result, raw: rawText, targetUrl });
        });
      });

      req.on("error", (err: any) => {
        resolve({
          ok: false,
          status: 500,
          data: { error: `Network error connecting to API: ${err.message}` },
          raw: err.message,
          targetUrl
        });
      });

      req.on("timeout", () => {
        req.destroy();
        resolve({
          ok: false,
          status: 504,
          data: { error: "API request timed out" },
          raw: "Timeout",
          targetUrl
        });
      });

      req.write(postData);
      req.end();
    } catch (err: any) {
      resolve({
        ok: false,
        status: 500,
        data: { error: err.message },
        raw: err.message,
        targetUrl: apiUrl
      });
    }
  });
}

// GET /api/providers - List all providers
router.get("/", async (req, res) => {
  try {
    let providers = await prisma.apiProvider.findMany({
      orderBy: { createdAt: "asc" },
      include: {
        _count: {
          select: { services: true }
        }
      }
    });

    // If empty, initialize the default primary provider
    if (providers.length === 0) {
      const realProvider = {
        name: "سيرفر عرب تك (Dhru Fusion API)",
        apiUrl: process.env.DHRU_API_URL || "https://arab-tech1.online/api/v1",
        username: process.env.DHRU_USERNAME || "mina15g4y",
        apiKey: process.env.DHRU_API_KEY || "3AE-27F-14D-104-830-375-6D",
        type: "dhru",
        isActive: true,
        balance: 23.21,
        currency: "USD",
        servicesCount: 2295
      };

      const created = await prisma.apiProvider.create({ data: realProvider });
      await prisma.dhruService.updateMany({
        where: { providerId: null },
        data: { providerId: created.id }
      });

      providers = await prisma.apiProvider.findMany({
        orderBy: { createdAt: "asc" },
        include: {
          _count: {
            select: { services: true }
          }
        }
      });
    }

    return res.json({
      success: true,
      providers: providers.map(p => ({
        ...p,
        servicesCount: p._count?.services || p.servicesCount || 0
      }))
    });
  } catch (error: any) {
    console.error("Fetch providers error:", error);
    return res.status(500).json({ error: "فشل جلب مزودي الخدمة" });
  }
});

// POST /api/providers/test-connection - Test API credentials & get live balance
router.post("/test-connection", async (req, res) => {
  try {
    const apiUrl = (req.body.apiUrl || req.body.api_url || "").trim();
    const username = (req.body.username || "").trim() || null;
    const apiKey = (req.body.apiKey || req.body.api_key || "").trim();

    if (!apiUrl || !apiKey) {
      return res.status(400).json({ error: "رابط الـ API ومفتاح الـ API مطلوبان لاختبار الاتصال" });
    }

    const apiRes = await makeProviderApiCall(apiUrl, username, apiKey, "accountinfo");

    if (!apiRes.ok || !isProviderApiSuccess(apiRes.data)) {
      const errMsg = getProviderApiErrorMessage(apiRes.data) || stripHtml(apiRes.raw) || "فشل الاتصال أو خطأ غير معروف";
      return res.status(400).json({
        error: `خطأ من مزود الـ API: ${errMsg}`
      });
    }

    const accountInfo = extractProviderAccountInfo(apiRes.data);
    if (!accountInfo) {
      return res.status(400).json({
        error: "المزود اتصل بنجاح لكن لم يرجع قيمة رصيد واضحة يمكن قراءتها"
      });
    }

    return res.json({
      success: true,
      balance: accountInfo.balance,
      currency: accountInfo.currency,
      message: `الاتصال بالسيرفر ناجح! الرصيد المتاح: ${accountInfo.balance.toFixed(2)} ${accountInfo.currency}`
    });
  } catch (error: any) {
    console.error("Test connection error:", error);
    return res.status(500).json({ error: "فشل الاتصال بالمزود: " + (error.message || "") });
  }
});

// POST /api/providers - Create new provider
router.post("/", async (req, res) => {
  try {
    const name = (req.body.name || "").trim();
    const apiUrl = (req.body.apiUrl || req.body.api_url || "").trim();
    const username = (req.body.username || "").trim() || null;
    const apiKey = (req.body.apiKey || req.body.api_key || "").trim();
    const type = req.body.type || req.body.provider_type || "dhru";
    const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : (req.body.is_active !== undefined ? Boolean(req.body.is_active) : true);
    const mappingRules = req.body.mappingRules || req.body.mapping_rules || null;

    if (!name || !apiUrl || !apiKey) {
      return res.status(400).json({ error: "اسم المزود، رابط الـ API، ومفتاح API كلها حقول مطلوبة" });
    }

    const normalizedApiUrl = normalizeApiUrl(apiUrl);
    const balRes = await makeProviderApiCall(normalizedApiUrl, username, apiKey, "accountinfo");
    if (!balRes.ok || !isProviderApiSuccess(balRes.data)) {
      const errMsg = getProviderApiErrorMessage(balRes.data) || stripHtml(balRes.raw) || "فشل التحقق من بيانات المزود";
      return res.status(400).json({ error: "فشل التحقق من الرصيد عند إضافة المزود: " + errMsg });
    }

    const accountInfo = extractProviderAccountInfo(balRes.data);
    if (!accountInfo) {
      return res.status(400).json({ error: "تم الاتصال بالمزود لكن لم يتم العثور على رصيد واضح في الرد" });
    }

    const newProvider = await prisma.apiProvider.create({
      data: {
        name,
        apiUrl: normalizedApiUrl,
        username,
        apiKey,
        type,
        isActive,
        balance: accountInfo.balance,
        currency: accountInfo.currency,
        mappingRules: mappingRules ? (typeof mappingRules === "string" ? mappingRules : JSON.stringify(mappingRules)) : null
      }
    });

    return res.json({
      success: true,
      provider: newProvider,
      message: `تمت إضافة المزود (${newProvider.name}) بنجاح!`
    });
  } catch (error: any) {
    console.error("Create provider error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء إضافة المزود: " + (error.message || "") });
  }
});

// PUT /api/providers/:id - Update provider
router.put("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.apiProvider.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const name = req.body.name !== undefined ? req.body.name.trim() : existing.name;
    const apiUrl = (req.body.apiUrl || req.body.api_url) !== undefined ? normalizeApiUrl((req.body.apiUrl || req.body.api_url).trim()) : existing.apiUrl;
    const username = req.body.username !== undefined ? (req.body.username ? req.body.username.trim() : null) : existing.username;
    const apiKey = (req.body.apiKey || req.body.api_key) !== undefined ? (req.body.apiKey || req.body.api_key).trim() : existing.apiKey;
    const type = (req.body.type || req.body.provider_type) !== undefined ? (req.body.type || req.body.provider_type) : existing.type;
    const isActive = req.body.isActive !== undefined ? Boolean(req.body.isActive) : (req.body.is_active !== undefined ? Boolean(req.body.is_active) : existing.isActive);
    const balance = req.body.balance !== undefined ? parseFloat(req.body.balance) : existing.balance;
    const mappingRules = req.body.mappingRules || req.body.mapping_rules;

    const updated = await prisma.apiProvider.update({
      where: { id },
      data: {
        name,
        apiUrl,
        username,
        apiKey,
        type,
        isActive,
        balance,
        ...(mappingRules !== undefined ? { mappingRules: mappingRules ? (typeof mappingRules === "string" ? mappingRules : JSON.stringify(mappingRules)) : null } : {})
      }
    });

    return res.json({
      success: true,
      provider: updated,
      message: `تم تحديث بيانات المزود (${updated.name}) بنجاح!`
    });
  } catch (error: any) {
    console.error("Update provider error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء تعديل المزود: " + (error.message || "") });
  }
});

// DELETE /api/providers/:id - Delete provider
router.delete("/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const existing = await prisma.apiProvider.findUnique({ where: { id } });
    if (!existing) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    // Unlink services
    await prisma.dhruService.updateMany({
      where: { providerId: id },
      data: { providerId: null }
    });

    await prisma.apiProvider.delete({ where: { id } });

    return res.json({
      success: true,
      message: `تم حذف المزود (${existing.name}) بنجاح.`
    });
  } catch (error: any) {
    console.error("Delete provider error:", error);
    return res.status(500).json({ error: "حدث خطأ أثناء حذف المزود" });
  }
});

// Balance checker helper
async function checkAndUpdateProviderBalance(id: string, res: any) {
  try {
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const apiRes = await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "accountinfo");

    if (!apiRes.ok || !isProviderApiSuccess(apiRes.data)) {
      const errMsg = getProviderApiErrorMessage(apiRes.data) || stripHtml(apiRes.raw) || "فشل الاتصال أو خطأ غير معروف";
      return res.status(400).json({
        error: `خطأ من مزود الـ API: ${errMsg}`
      });
    }

    const accountInfo = extractProviderAccountInfo(apiRes.data);
    if (!accountInfo) {
      return res.status(400).json({
        error: "المزود اتصل بنجاح لكن لم يرجع قيمة رصيد واضحة يمكن قراءتها"
      });
    }

    const updated = await prisma.apiProvider.update({
      where: { id },
      data: {
        balance: accountInfo.balance,
        currency: accountInfo.currency
      }
    });

    return res.json({
      success: true,
      balance: accountInfo.balance,
      credit: `${accountInfo.balance.toFixed(2)} ${accountInfo.currency}`,
      currency: accountInfo.currency,
      provider: updated,
      message: `تم تحديث الرصيد للمزود (${provider.name}): ${accountInfo.balance.toFixed(2)} ${accountInfo.currency}`
    });
  } catch (error: any) {
    console.error("Check balance error:", error);
    return res.status(500).json({ error: "فشل تحديث رصيد المزود: " + (error.message || "") });
  }
}

// POST & GET /api/providers/:id/balance - Check & update live balance
router.post("/:id/balance", (req, res) => checkAndUpdateProviderBalance(req.params.id, res));
router.get("/:id/balance", (req, res) => checkAndUpdateProviderBalance(req.params.id, res));

export type ProviderServiceType = "imei" | "server" | "remote";

const PROVIDER_SERVICE_TYPES: ProviderServiceType[] = ["imei", "server", "remote"];

export function normalizeRequestedServiceTypes(input: unknown): ProviderServiceType[] {
  if (input === undefined || input === null) return [...PROVIDER_SERVICE_TYPES];
  if (!Array.isArray(input)) return [];

  const normalized = input
    .map((value) => String(value).trim().toLowerCase())
    .filter((value): value is ProviderServiceType => PROVIDER_SERVICE_TYPES.includes(value as ProviderServiceType));
  return Array.from(new Set(normalized));
}

export function getProviderServiceType(categoryName: unknown): ProviderServiceType | "unknown" {
  const normalized = String(categoryName || "").toLowerCase();
  if (normalized.includes("remote")) return "remote";
  if (normalized.includes("server")) return "server";
  if (normalized.includes("imei")) return "imei";
  return "unknown";
}

export function normalizeProviderApiServiceType(
  explicitType: unknown,
  endpointType?: ProviderServiceType
): ProviderServiceType | "unknown" {
  const normalized = String(explicitType || "").trim().toLowerCase();
  if (normalized.includes("remote")) return "remote";
  if (normalized.includes("server")) return "server";
  if (normalized.includes("imei")) return "imei";
  return endpointType || "unknown";
}

export function getProviderServiceApiActions(types: ProviderServiceType[]) {
  const actions = {
    imei: "imeiservicelist",
    server: "serverservicelist",
    remote: "remoteservicelist"
  } as const;
  return types.map((type) => ({ type, action: actions[type] }));
}

// Helper: parse raw services list from provider responses
export function parseAllProviderServices(imeiRes: any, serverRes: any, remoteRes?: any) {
  const extractedServices: any[] = [];

  const processGroups = (groupData: any, type: "imei" | "server" | "remote") => {
    let groups: any[] = [];
    if (groupData?.SUCCESS === true && Array.isArray(groupData?.RESULT)) {
      groups = groupData.RESULT;
    } else if (Array.isArray(groupData?.SUCCESS)) {
      const first = groupData.SUCCESS[0];
      if (first && first.LIST && typeof first.LIST === "object") {
        groups = Object.values(first.LIST);
      } else {
        groups = groupData.SUCCESS;
      }
    } else if (Array.isArray(groupData)) {
      groups = groupData;
    } else if (typeof groupData === "object" && groupData !== null) {
      groups = Object.values(groupData);
    }

    for (const g of groups) {
      if (!g) continue;
      const rawGroupName = String(g.GROUPNAME || g.groupName || g.name || "").trim();
      const groupName = rawGroupName || (type === "imei" ? "IMEI Services" : "Server Services");
      const rawServices = Array.isArray(g.SERVICES) ? g.SERVICES : (g.SERVICES && typeof g.SERVICES === "object" ? Object.values(g.SERVICES) : (g.SERVICEID ? [g] : []));

      for (const s of rawServices as any[]) {
        if (!s) continue;
        const rawCustomFields = extractCustomFields(s);
        const normalizedFields = rawCustomFields.map(normalizeCustomField).filter(Boolean);

        const sId = String(s.SERVICEID || s.id || s.ID || "").trim();
        const sName = String(s.SERVICENAME || s.name || s.NAME || "").trim();
        const sCredit = parseFloat(s.CREDIT || s.credit || s.PRICE || s.price || "0") || 0;
        const sTime = String(s.TIME || s.time || "1-24 Hours");
        const sInfo = String(s.INFO || s.info || "");
        const apiServiceType = normalizeProviderApiServiceType(
          s.SERVICETYPE ?? s.SERVICE_TYPE ?? s.serviceType ?? s.service_type,
          type
        );

        if (apiServiceType === "imei") {
          const existingImeiIndex = normalizedFields.findIndex((f: any) => {
             const lowerName = String(f.name || f.field_id || "").toLowerCase();
             return lowerName === "imei" || lowerName === "custom_imei" || lowerName.includes("imei");
          });

          if (existingImeiIndex !== -1) {
            normalizedFields[existingImeiIndex].required = false;
            if (existingImeiIndex > 0) {
              const [imeiField] = normalizedFields.splice(existingImeiIndex, 1);
              normalizedFields.unshift(imeiField);
            }
          } else {
            normalizedFields.unshift({
              id: "custom_IMEI",
              field_id: "IMEI",
              name: "IMEI",
              label: "IMEI",
              type: "text",
              fieldtype: "text",
              required: false,
              description: "",
              placeholder: "أدخل IMEI (اختياري)",
              options: [],
              fieldoptions: []
            });
          }
        }

        const qtyLimits = extractQuantityLimits(s, normalizedFields);
        const enrichedFields = qtyLimits.supportsQty
          ? enrichCustomFieldsWithQuantity(normalizedFields, qtyLimits)
          : normalizedFields;

        extractedServices.push({
          id: sId,
          service_id: sId,
          name: sName,
          service_name: sName,
          group_name: groupName,
          groupName,
          category_name: apiServiceType === "imei" ? "IMEI Service" : (apiServiceType === "remote" ? "Remote Service" : "Server Service"),
          service_type: apiServiceType,
          api_service_type: apiServiceType,
          credit: sCredit,
          price: sCredit,
          time: sTime,
          info: sInfo,
          customFields: enrichedFields,
          requiresCustom: enrichedFields.length > 0 ? JSON.stringify(enrichedFields) : null,
          supportsQty: qtyLimits.supportsQty,
          supports_quantity: qtyLimits.supportsQty,
          minQty: qtyLimits.minQty,
          maxQty: qtyLimits.maxQty,
          min_quantity: qtyLimits.minQty,
          max_quantity: qtyLimits.maxQty
        });
      }
    }
  };

  if (imeiRes?.data) processGroups(imeiRes.data, "imei");
  if (serverRes?.data) processGroups(serverRes.data, "server");
  if (remoteRes?.data) processGroups(remoteRes.data, "remote");

  return extractedServices;
}

// GET & POST /api/providers/:id/fetch-services - Fetch live remote services for preview
const fetchRemoteServicesHandler = async (req: any, res: any) => {
  try {
    const { id } = req.params;
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const [imeiRes, serverRes, remoteRes] = await Promise.all([
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "imeiservicelist"),
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "serverservicelist"),
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "remoteservicelist")
    ]);

    const responses = [imeiRes, serverRes, remoteRes];
    if (responses.every((response) => !response.ok || getProviderApiErrorMessage(response.data))) {
      return res.status(400).json({
        error: `فشل جلب الخدمات من المزود: ${summarizeProviderApiFailure(responses)}`
      });
    }

    const services = parseAllProviderServices(imeiRes, serverRes, remoteRes);

    if (services.length === 0) {
      return res.status(400).json({
        error: "اتصلنا بالمزود لكن لم يتم العثور على خدمات قابلة للقراءة في الرد"
      });
    }

    // Cross-reference with existing database services to mark which ones are already imported and active
    try {
      const existingServices = await prisma.dhruService.findMany({
        where: { providerId: id },
        select: { dhruId: true, isActive: true }
      });
      const existingMap = new Map<string, boolean>();
      for (const es of existingServices) {
        if (es.dhruId) existingMap.set(es.dhruId, es.isActive);
      }

      for (const s of services) {
        const dhruId = buildProviderServiceId(provider.id, String(s.id || s.service_id));
        const isImported = existingMap.has(dhruId);
        s.isImported = isImported;
        s.isActive = isImported ? (existingMap.get(dhruId) ?? false) : false;
      }
    } catch (dbErr) {
      console.error("Error cross-referencing DB services on fetch-services preview:", dbErr);
    }

    return res.json({
      success: true,
      services,
      servicesCount: services.length,
      count: services.length
    });
  } catch (error: any) {
    console.error("Fetch remote services error:", error);
    return res.status(500).json({ error: "فشل جلب الخدمات من المزود: " + (error.message || "") });
  }
};

router.get("/:id/fetch-services", fetchRemoteServicesHandler);
router.post("/:id/fetch-services", fetchRemoteServicesHandler);

// Helper to build comprehensive provider export JSON
async function buildProviderExportData(provider: any, includeRaw = true) {
  // 1. Fetch DB services
  const dbServices = await prisma.dhruService.findMany({
    where: { providerId: provider.id },
    include: { dhruCategory: true }
  });

  // 2. Fetch live remote services if credentials exist
  let rawApiResponses: any = {};
  let remoteServices: any[] = [];

  if (provider.apiUrl && provider.apiKey) {
    try {
      const [imeiRes, serverRes, remoteRes] = await Promise.all([
        makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "imeiservicelist"),
        makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "serverservicelist"),
        makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "remoteservicelist")
      ]);

      if (includeRaw) {
        rawApiResponses = {
          imeiservicelist: imeiRes.data,
          serverservicelist: serverRes.data,
          remoteservicelist: remoteRes.data
        };
      }

      remoteServices = parseAllProviderServices(imeiRes, serverRes, remoteRes);
    } catch (apiErr) {
      console.warn(`Could not fetch live API services for provider ${provider.name}:`, apiErr);
    }
  }

  // Combine & cross-reference services
  const allServicesList = remoteServices.length > 0 ? remoteServices : dbServices.map(s => {
    let customFields = [];
    try {
      customFields = s.requiresCustom ? JSON.parse(s.requiresCustom) : [];
    } catch {}
    const qtyLimits = extractQuantityLimits(s, customFields);
    return {
      id: s.id,
      service_id: s.dhruId,
      name: s.name,
      group_name: s.groupName || "General",
      category_name: s.dhruCategory?.name || "General",
      service_type: s.dhruCategory?.name === "IMEI Service" ? "imei" : (s.dhruCategory?.name === "Remote Service" ? "remote" : "server"),
      credit: Number(s.credit) || 0,
      price: Number(s.credit) || 0,
      margin: Number(s.margin) || 0,
      finalPrice: Number((Number(s.credit) || 0) + (Number(s.margin) || 0)),
      time: s.time || "",
      info: s.info || "",
      customFields,
      requiresCustom: s.requiresCustom,
      supportsQty: qtyLimits.supportsQty,
      minQty: qtyLimits.minQty,
      maxQty: qtyLimits.maxQty,
      isActive: s.isActive,
      isImported: true
    };
  });

  // Cross-reference with DB services
  const dbMap = new Map<string, any>();
  for (const ds of dbServices) {
    if (ds.dhruId) dbMap.set(ds.dhruId, ds);
    dbMap.set(ds.id, ds);
  }

  const enrichedServices = allServicesList.map(s => {
    const remoteId = String(s.id || s.service_id);
    const fullDhruId = buildProviderServiceId(provider.id, remoteId);
    const matchedDb = dbMap.get(fullDhruId) || dbMap.get(remoteId);

    return {
      id: s.id,
      service_id: remoteId,
      name: s.name,
      group_name: s.group_name || s.groupName || "General",
      category_name: s.category_name || (s.service_type === "imei" ? "IMEI Service" : "Server Service"),
      service_type: s.service_type || "server",
      credit: Number(s.credit || s.price) || 0,
      price: Number(s.credit || s.price) || 0,
      margin: matchedDb ? Number(matchedDb.margin) : 0,
      sellingPrice: matchedDb ? Number(((Number(matchedDb.credit) || 0) + (Number(matchedDb.margin) || 0)).toFixed(2)) : Number((Number(s.credit || s.price) || 0).toFixed(2)),
      time: s.time || "1-24 Hours",
      info: s.info || "",
      customFields: s.customFields || [],
      requiresCustom: s.requiresCustom || null,
      supportsQty: Boolean(s.supportsQty || s.supports_quantity),
      minQty: s.minQty ?? 1,
      maxQty: s.maxQty ?? 0,
      isImported: Boolean(matchedDb),
      isActive: matchedDb ? matchedDb.isActive : Boolean(s.isActive),
      databaseId: matchedDb?.id || null,
      fullDhruId: matchedDb?.dhruId || fullDhruId
    };
  });

  // Group services by package / group name
  const packagesMap: Record<string, any[]> = {};
  for (const s of enrichedServices) {
    const pkg = s.group_name || "باقة عامة";
    if (!packagesMap[pkg]) packagesMap[pkg] = [];
    packagesMap[pkg].push(s);
  }

  const packages = Object.entries(packagesMap).map(([packageName, services]) => ({
    packageName,
    servicesCount: services.length,
    serviceTypes: Array.from(new Set(services.map(srv => srv.service_type || srv.category_name))),
    services
  }));

  const typeCounts = {
    imei: enrichedServices.filter(s => (s.service_type === "imei" || s.category_name === "IMEI Service")).length,
    server: enrichedServices.filter(s => (s.service_type === "server" || s.category_name === "Server Service")).length,
    remote: enrichedServices.filter(s => (s.service_type === "remote" || s.category_name === "Remote Service")).length
  };

  return {
    provider: {
      id: provider.id,
      name: provider.name,
      apiUrl: provider.apiUrl,
      username: provider.username,
      apiKey: provider.apiKey,
      type: provider.type,
      isActive: provider.isActive,
      balance: provider.balance,
      currency: provider.currency,
      servicesCount: enrichedServices.length,
      createdAt: provider.createdAt,
      updatedAt: provider.updatedAt
    },
    metadata: {
      exportedAt: new Date().toISOString(),
      system: "Arab Tech Pro Server",
      totalServices: enrichedServices.length,
      totalPackages: packages.length,
      servicesByType: typeCounts
    },
    packages,
    services: enrichedServices,
    databaseServices: dbServices,
    ...(includeRaw && Object.keys(rawApiResponses).length > 0 ? { rawApiResponses } : {})
  };
}

// GET /api/providers/export-all-data - Export full data for ALL providers
router.get("/export-all-data", async (req, res) => {
  try {
    const providers = await prisma.apiProvider.findMany({
      orderBy: { createdAt: "asc" }
    });

    const exportList = [];
    for (const provider of providers) {
      const pData = await buildProviderExportData(provider, false);
      exportList.push(pData);
    }

    const fullExport = {
      metadata: {
        exportedAt: new Date().toISOString(),
        system: "Arab Tech Pro Server",
        totalProviders: providers.length,
        totalServicesAcrossProviders: exportList.reduce((acc, p) => acc + (p.metadata?.totalServices || 0), 0)
      },
      providers: exportList
    };

    if (req.query.download === "true") {
      const filename = `all_providers_full_data_${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "application/json");
    }

    return res.json({
      success: true,
      data: fullExport
    });
  } catch (error: any) {
    console.error("Export all providers error:", error);
    return res.status(500).json({ error: "فشل تصدير بيانات المزودين: " + (error.message || "") });
  }
});

// GET /api/providers/:id/export-full-data - Export complete data for a single provider
router.get("/:id/export-full-data", async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const includeRaw = req.query.include_raw !== "false";
    const exportData = await buildProviderExportData(provider, includeRaw);

    if (req.query.download === "true") {
      const cleanName = provider.name.replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, "_");
      const filename = `provider_${cleanName}_full_data_${new Date().toISOString().slice(0, 10)}.json`;
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      res.setHeader("Content-Type", "application/json");
    }

    return res.json({
      success: true,
      data: exportData
    });
  } catch (error: any) {
    console.error("Export provider full data error:", error);
    return res.status(500).json({ error: "فشل تصدير بيانات المزود: " + (error.message || "") });
  }
});

// GET /api/providers/:id/raw-data - Download 100% untouched pure raw data directly from provider API without ANY modifications from us
router.get("/:id/raw-data", async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const type = String(req.query.type || "all").toLowerCase();
    const isDownload = req.query.download === "true" || req.query.download === "1";
    const cleanName = (provider.name || "provider").replace(/[^a-zA-Z0-9_\u0600-\u06FF]/g, "_");

    if (type === "imei") {
      const imeiRes = await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "imeiservicelist");
      if (isDownload) {
        res.setHeader("Content-Disposition", `attachment; filename="${cleanName}_RAW_IMEI_Services.json"`);
        res.setHeader("Content-Type", "application/json");
      }
      return res.json(imeiRes.data);
    }

    if (type === "server") {
      const serverRes = await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "serverservicelist");
      if (isDownload) {
        res.setHeader("Content-Disposition", `attachment; filename="${cleanName}_RAW_Server_Services.json"`);
        res.setHeader("Content-Type", "application/json");
      }
      return res.json(serverRes.data);
    }

    if (type === "remote") {
      const remoteRes = await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "remoteservicelist");
      if (isDownload) {
        res.setHeader("Content-Disposition", `attachment; filename="${cleanName}_RAW_Remote_Services.json"`);
        res.setHeader("Content-Type", "application/json");
      }
      return res.json(remoteRes.data);
    }

    // Default "all" or "pure_dhru": Fetch all 3 lists simultaneously
    const [imeiRes, serverRes, remoteRes] = await Promise.all([
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "imeiservicelist"),
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "serverservicelist"),
      makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, "remoteservicelist")
    ]);

    if (type === "pure_dhru") {
      const allOriginalGroups: any[] = [];
      const appendGroups = (data: any) => {
        if (!data || typeof data !== "object") return;
        const success = data.SUCCESS ?? data.success;
        if (Array.isArray(success)) {
          for (const item of success) {
            if (item && Array.isArray(item.LIST)) {
              allOriginalGroups.push(...item.LIST);
            } else if (item) {
              allOriginalGroups.push(item);
            }
          }
        } else if (success && typeof success === "object") {
          allOriginalGroups.push(...Object.values(success));
        }
      };

      appendGroups(imeiRes.data);
      appendGroups(serverRes.data);
      appendGroups(remoteRes.data);

      if (isDownload) {
        res.setHeader("Content-Disposition", `attachment; filename="${cleanName}_RAW_Dhru_SUCCESS.json"`);
        res.setHeader("Content-Type", "application/json");
      }
      return res.json({ SUCCESS: allOriginalGroups });
    }

    // Combined Raw - pure original data without any additions
    const combinedRaw = {
      provider: {
        id: provider.id,
        name: provider.name,
        apiUrl: provider.apiUrl,
        username: provider.username,
        type: provider.type,
        currency: provider.currency,
        balance: provider.balance,
        exportedAt: new Date().toISOString()
      },
      imeiservicelist: imeiRes.data ?? null,
      serverservicelist: serverRes.data ?? null,
      remoteservicelist: remoteRes.data ?? null
    };

    if (isDownload) {
      res.setHeader("Content-Disposition", `attachment; filename="${cleanName}_RAW_Original_Full.json"`);
      res.setHeader("Content-Type", "application/json");
    }

    return res.json(combinedRaw);
  } catch (error: any) {
    console.error("Fetch raw provider data error:", error);
    return res.status(500).json({ error: "فشل سحب الداتا الأصلية من المزود: " + (error.message || "") });
  }
});

// Helper function to persist/upsert any list of provider services into DB
export async function persistProviderServicesList(
  provider: { id: string },
  allServices: any[],
  markupPercent = 0,
  exchangeRate = 1
) {
  // Ensure standard categories exist
  const categoryNames = ["IMEI Service", "Server Service", "Remote Service"];
  const categoryMap = new Map<string, string>();

  for (const name of categoryNames) {
    let cat = await prisma.dhruCategory.findFirst({ where: { name } });
    if (!cat) {
      cat = await prisma.dhruCategory.create({ data: { name } });
    }
    categoryMap.set(name, cat.id);
  }

  const existingServices = await prisma.dhruService.findMany({
    where: { providerId: provider.id }
  });
  const existingMap = new Map<string, any>();
  for (const s of existingServices) {
    if (s.dhruId) existingMap.set(s.dhruId, s);
  }

  const newServicesToInsert: any[] = [];
  const servicesToUpdate: any[] = [];
  const seenDhruIds = new Set<string>();

  for (const s of allServices) {
    const remoteServiceId = String(s.id || s.service_id);
    if (!remoteServiceId || seenDhruIds.has(remoteServiceId)) continue;
    seenDhruIds.add(remoteServiceId);
    const dhruId = buildProviderServiceId(provider.id, remoteServiceId);

    const serviceName = s.name || s.service_name || "";
    const groupName = s.group_name || s.groupName || "General";
    let credit = (parseFloat(s.credit || s.price) || 0) * (exchangeRate > 0 ? exchangeRate : 1);
    const time = s.time || "";
    const info = s.info || "";
    let customFieldsList = s.customFields && Array.isArray(s.customFields)
      ? s.customFields
      : (s.requiresCustom ? (() => { try { return JSON.parse(s.requiresCustom); } catch { return []; } })() : []);
    const qtyLimits = extractQuantityLimits(s, customFieldsList);
    if (qtyLimits.supportsQty) {
      customFieldsList = enrichCustomFieldsWithQuantity(customFieldsList, qtyLimits);
    }
    const requiresCustomStr = customFieldsList && customFieldsList.length > 0
      ? JSON.stringify(customFieldsList)
      : (s.requiresCustom || null);
    const apiServiceType = normalizeProviderApiServiceType(s.api_service_type ?? s.service_type);
    const categoryName = apiServiceType === "imei"
      ? "IMEI Service"
      : (apiServiceType === "remote" ? "Remote Service" : "Server Service");
    const categoryId = categoryMap.get(categoryName)!;
    const cleanName = cleanServiceName(serviceName, info, groupName);

    const existing = existingMap.get(dhruId);
    const computedMargin = markupPercent > 0 
      ? Number(((credit * markupPercent) / 100).toFixed(2)) 
      : (existing ? (existing.margin ?? 0) : 0);

    if (existing) {
      servicesToUpdate.push({
        id: existing.id,
        data: {
          name: existing.name && existing.name !== existing.originalName ? existing.name : cleanName,
          originalName: serviceName,
          groupName,
          credit: credit === 0 && existing.credit > 0 ? existing.credit : credit,
          time,
          info,
          categoryId,
          providerId: provider.id,
          apiServiceType,
          requiresCustom: requiresCustomStr || existing.requiresCustom,
          isActive: existing.isActive,
          margin: computedMargin
        }
      });
    } else {
      const isNotice = credit === 0 && (serviceName.match(/rules?|refund|notice|تنبيه/i) || groupName.match(/rules?|refund/i));
      newServicesToInsert.push({
        dhruId,
        name: cleanName,
        originalName: serviceName,
        groupName,
        credit,
        time,
        info,
        categoryId,
        providerId: provider.id,
        apiServiceType,
        requiresCustom: requiresCustomStr,
        isActive: !isNotice,
        margin: computedMargin
      });
    }
  }

  // Insert new services in batches
  if (newServicesToInsert.length > 0) {
    for (let i = 0; i < newServicesToInsert.length; i += 500) {
      const chunk = newServicesToInsert.slice(i, i + 500);
      await prisma.dhruService.createMany({ data: chunk, skipDuplicates: true });
    }
  }

  // Update existing services in batches
  if (servicesToUpdate.length > 0) {
    for (let i = 0; i < servicesToUpdate.length; i += 100) {
      const chunk = servicesToUpdate.slice(i, i + 100);
      await prisma.$transaction(
        chunk.map(item =>
          prisma.dhruService.update({
            where: { id: item.id },
            data: item.data
          })
        )
      );
    }
  }

  const totalSynced = await prisma.dhruService.count({ where: { providerId: provider.id } });
  await prisma.apiProvider.update({
    where: { id: provider.id },
    data: { servicesCount: totalSynced }
  });

  invalidateDhruServicesCache();
  return totalSynced;
}

// POST /api/providers/:id/sync - Non-destructive sync of all services from provider
router.post("/:id/sync", async (req, res) => {
  try {
    const { id } = req.params;
    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const requestedServiceTypes = [...PROVIDER_SERVICE_TYPES];

    const fetchedResponses = await Promise.all(
      getProviderServiceApiActions(requestedServiceTypes).map(async ({ type, action }) => ({
        type,
        response: await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, action)
      }))
    );
    const responses = fetchedResponses.map(({ response }) => response);
    if (responses.every((response) => !response.ok || getProviderApiErrorMessage(response.data))) {
      return res.status(400).json({
        error: `فشل جلب الخدمات من المزود: ${summarizeProviderApiFailure(responses)}`
      });
    }

    const responseByType = new Map(fetchedResponses.map(({ type, response }) => [type, response]));
    const imeiRes = responseByType.get("imei");
    const serverRes = responseByType.get("server");
    const remoteRes = responseByType.get("remote");
    const allServices = parseAllProviderServices(imeiRes, serverRes, remoteRes);

    if (allServices.length === 0) {
      return res.status(400).json({
        error: "لم يتم العثور على خدمات في رد المزود. تأكد من صحة الرابط ومفتاح الـ API واسم المستخدم وتصريح الـ IP."
      });
    }

    const markupPercent = parseFloat(req.body.markupPercent ?? req.body.markup_percent) || 0;
    const exchangeRate = parseFloat(req.body.exchangeRate ?? req.body.exchange_rate) || 1;

    const totalSynced = await persistProviderServicesList(provider, allServices, markupPercent, exchangeRate);

    return res.json({
      success: true,
      count: allServices.length,
      totalCount: totalSynced,
      serviceTypes: requestedServiceTypes,
      message: `تمت المزامنة بنجاح! تم جلب قوائم IMEI وServer وRemote وتصنيف ${allServices.length} خدمة تلقائياً. إجمالي خدمات المزود: ${totalSynced}.`
    });
  } catch (error: any) {
    console.error("Provider sync error:", error);
    return res.status(500).json({ error: "فشل مزامنة الخدمات من المزود: " + (error.message || "") });
  }
});

// POST /api/providers/:id/import-services - Selective import of services
router.post("/:id/import-services", async (req, res) => {
  try {
    const { id } = req.params;
    const { services, markup_percent, exchange_rate } = req.body;

    if (!Array.isArray(services) || services.length === 0) {
      console.log("[import-services] No services received. Body:", req.body);
      return res.status(400).json({ error: "يرجى تحديد خدمة واحدة على الأقل للاستيراد" });
    }
    console.log(`[import-services] Received ${services.length} services to import for provider ${id}`);

    const provider = await prisma.apiProvider.findUnique({ where: { id } });
    if (!provider) {
      return res.status(404).json({ error: "المزود غير موجود" });
    }

    const markup = parseFloat(markup_percent) || 0;
    const rate = parseFloat(exchange_rate) || 1;

    // Ensure categories
    const categoryNames = ["IMEI Service", "Server Service", "Remote Service"];
    const categoryMap = new Map<string, string>();
    for (const name of categoryNames) {
      let cat = await prisma.dhruCategory.findFirst({ where: { name } });
      if (!cat) cat = await prisma.dhruCategory.create({ data: { name } });
      categoryMap.set(name, cat.id);
    }

    let count = 0;
    for (const s of services) {
      const remoteServiceId = String(s.id || s.service_id);
      if (!remoteServiceId) continue;
      const dhruId = buildProviderServiceId(provider.id, remoteServiceId);

      const serviceName = String(s.name || s.service_name || "").trim();
      const groupName = String(s.group_name || s.groupName || "General").trim();
      let credit = (parseFloat(s.credit || s.price) || 0) * rate;
      const margin = markup > 0 ? Number(((credit * markup) / 100).toFixed(2)) : 0;
      const cleanName = cleanServiceName(serviceName, s.info || "", groupName);
      
      const apiServiceType = normalizeProviderApiServiceType(s.api_service_type ?? s.service_type);
      const categoryName = apiServiceType === "imei"
        ? "IMEI Service"
        : (apiServiceType === "remote" ? "Remote Service" : "Server Service");
      const categoryId = categoryMap.get(categoryName)!;

      let customFieldsList = s.customFields && Array.isArray(s.customFields)
        ? s.customFields.map(normalizeCustomField).filter(Boolean)
        : (s.requiresCustom ? (() => { try { return JSON.parse(s.requiresCustom); } catch { return []; } })() : []);
      const qtyLimits = extractQuantityLimits(s, customFieldsList);
      if (qtyLimits.supportsQty) {
        customFieldsList = enrichCustomFieldsWithQuantity(customFieldsList, qtyLimits);
      }
      const requiresCustomStr = customFieldsList && customFieldsList.length > 0
        ? JSON.stringify(customFieldsList)
        : (s.requiresCustom || null);

      await prisma.dhruService.upsert({
        where: { dhruId },
        create: {
          dhruId,
          name: cleanName,
          originalName: serviceName,
          groupName,
          credit,
          time: s.time || "",
          info: s.info || "",
          categoryId,
          providerId: provider.id,
          apiServiceType,
          requiresCustom: requiresCustomStr,
          isActive: true,
          margin
        },
        update: {
          name: cleanName,
          originalName: serviceName,
          groupName,
          credit,
          time: s.time || "",
          info: s.info || "",
          categoryId,
          providerId: provider.id,
          apiServiceType,
          requiresCustom: requiresCustomStr,
          isActive: true,
          margin
        }
      });
      count++;
    }

    const totalCount = await prisma.dhruService.count({ where: { providerId: id } });
    await prisma.apiProvider.update({
      where: { id },
      data: {
        servicesCount: totalCount
      }
    });

    invalidateDhruServicesCache();
    return res.json({
      success: true,
      count,
      totalCount,
      message: `تم استيراد وتفعيل ${count} خدمة بنجاح!`
    });
  } catch (error: any) {
    console.error("Selective import error:", error);
    return res.status(500).json({ error: "فشل استيراد الخدمات: " + (error.message || "") });
  }
});

// GET /api/providers/:id/services - Get services from a specific provider
router.get("/:id/services", async (req, res) => {
  try {
    const { id } = req.params;
    const services = await prisma.dhruService.findMany({
      where: {
        OR: [{ providerId: id }, { providerId: null }]
      },
      select: {
        id: true,
        name: true,
        originalName: true,
        groupName: true,
        credit: true,
        time: true,
        info: true,
        isActive: true,
        margin: true,
        requiresCustom: true,
        apiServiceType: true,
        dhruCategory: {
          select: { name: true }
        }
      },
      orderBy: { name: "asc" }
    });

    return res.json({
      success: true,
      services: services.map((service) => {
        const qtyConfig = getServiceQuantityConfig(service);
        return {
          ...service,
          category_name: service.dhruCategory?.name || null,
          service_type: service.apiServiceType || getProviderServiceType(service.dhruCategory?.name),
          api_service_type: service.apiServiceType || null,
          supportsQty: qtyConfig.supportsQty,
          supports_quantity: qtyConfig.supportsQty,
          minQty: qtyConfig.minQty,
          maxQty: qtyConfig.maxQty,
          min_quantity: qtyConfig.min_quantity,
          max_quantity: qtyConfig.max_quantity
        };
      })
    });
  } catch (error: any) {
    console.error("Fetch provider services error:", error);
    return res.status(500).json({ error: "فشل جلب خدمات المزود" });
  }
});

// POST /api/providers/:id/toggle-packages - Toggle multiple package visibility
router.post("/:id/toggle-packages", async (req, res) => {
  try {
    const { id } = req.params;
    const { groupNames, isActive } = req.body;

    if (!Array.isArray(groupNames) || groupNames.length === 0) {
      return res.status(400).json({ error: "يرجى تحديد باقة واحدة على الأقل" });
    }

    const nextActive = typeof isActive === "boolean" ? isActive : true;

    const result = await prisma.dhruService.updateMany({
      where: {
        groupName: { in: groupNames },
        OR: [{ providerId: id }, { providerId: null }]
      },
      data: {
        isActive: nextActive
      }
    });

    invalidateDhruServicesCache();
    return res.json({
      success: true,
      count: result.count,
      message: nextActive
        ? `تم إظهار وتفعيل ${result.count} خدمة ضمن (${groupNames.length} باقة) للعملاء بنجاح!`
        : `تم إخفاء ${result.count} خدمة ضمن (${groupNames.length} باقة) عن العملاء بنجاح.`
    });
  } catch (error: any) {
    console.error("Toggle packages error:", error);
    return res.status(500).json({ error: "فشل تغيير حالة ظهور الباقات" });
  }
});

// POST /api/providers/:id/toggle-all - Toggle ALL services visibility for this provider
router.post("/:id/toggle-all", async (req, res) => {
  try {
    const { id } = req.params;
    const { isActive } = req.body;
    const nextActive = typeof isActive === "boolean" ? isActive : true;

    const result = await prisma.dhruService.updateMany({
      where: {
        OR: [{ providerId: id }, { providerId: null }]
      },
      data: {
        isActive: nextActive
      }
    });

    invalidateDhruServicesCache();
    return res.json({
      success: true,
      count: result.count,
      message: nextActive
        ? `تم تفعيل وإظهار كافة خدمات السيرفر (${result.count} خدمة) في المتجر بنجاح!`
        : `تم إخفاء كافة خدمات السيرفر (${result.count} خدمة) عن المتجر.`
    });
  } catch (error: any) {
    console.error("Toggle all services error:", error);
    return res.status(500).json({ error: "فشل تحديث حالة ظهور الخدمات" });
  }
});

// POST /api/providers/:id/toggle-service - Toggle a single service
router.post("/:id/toggle-service", async (req, res) => {
  try {
    const { serviceId, isActive } = req.body;
    if (!serviceId) {
      return res.status(400).json({ error: "serviceId is required" });
    }

    const updated = await prisma.dhruService.update({
      where: { id: serviceId },
      data: { isActive: Boolean(isActive) }
    });

    invalidateDhruServicesCache();
    return res.json({
      success: true,
      service: updated,
      message: updated.isActive ? "تم إظهار الخدمة للعملاء" : "تم إخفاء الخدمة عن العملاء"
    });
  } catch (error: any) {
    console.error("Toggle service error:", error);
    return res.status(500).json({ error: "فشل تغيير حالة الخدمة" });
  }
});

export default router;
