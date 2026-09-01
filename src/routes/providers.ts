import { Router } from "express";
import { prisma } from "../server";
import { cleanServiceName } from "../scripts/syncDhruServices";

const router = Router();

// Helper to format API url
export function normalizeApiUrl(rawUrl: string): string {
  let url = (rawUrl || "").trim();
  if (!url) return "";
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    url = "https://" + url;
  }
  try {
    const parsed = new URL(url);
    if (!parsed.pathname || parsed.pathname === "/" || parsed.pathname === "") {
      parsed.pathname = "/api/index.php";
      return parsed.toString();
    }
  } catch {}
  return url;
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
  const resolvedType = fieldoptions.length > 0 && normalizedType === "text" ? "select" : normalizedType;

  return {
    id: `custom_${String(field.field_id || field.reqid || field.REQID || field.id || name).trim()}`,
    field_id: String(field.field_id || field.reqid || field.REQID || field.id || name).trim(),
    name,
    label: name,
    type: resolvedType,
    fieldtype: resolvedType,
    required: isRequiredField(field.required ?? field.REQUIRED),
    description,
    placeholder: description || `أدخل ${name}`,
    options: fieldoptions,
    fieldoptions
  };
}

// Helper to make API calls to any provider
export async function makeProviderApiCall(
  apiUrl: string,
  username: string | null | undefined,
  apiKey: string,
  action: string,
  parameters: Record<string, string> = {}
) {
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

  try {
    const response = await fetch(targetUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "application/json, text/plain, */*"
      },
      body: data.toString(),
      cache: "no-store"
    });

    const rawText = await response.text();
    let result: any;
    try {
      result = JSON.parse(rawText);
    } catch {
      result = { error: rawText };
    }
    return { ok: response.ok, status: response.status, data: result, raw: rawText, targetUrl };
  } catch (err: any) {
    return { ok: false, error: err.message || "Failed to reach provider API" };
  }
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

    if (apiRes.data?.ERROR && Array.isArray(apiRes.data.ERROR) && apiRes.data.ERROR[0]?.MESSAGE) {
      return res.status(400).json({
        error: `خطأ من مزود الـ API: ${apiRes.data.ERROR[0].MESSAGE}`
      });
    }

    let liveCredit = 0;
    let currency = "USD";

    if (apiRes.data) {
      if (Array.isArray(apiRes.data.SUCCESS) && apiRes.data.SUCCESS[0]) {
        const row = apiRes.data.SUCCESS[0];
        liveCredit = parseFloat(row.AccountInfo?.credit || row.credit || row.balance || "0") || 0;
        if (row.AccountInfo?.currency || row.currency) {
          currency = row.AccountInfo?.currency || row.currency;
        }
      } else if (apiRes.data.credit !== undefined) {
        liveCredit = parseFloat(apiRes.data.credit) || 0;
      } else if (apiRes.data.balance !== undefined) {
        liveCredit = parseFloat(apiRes.data.balance) || 0;
      }
    }

    return res.json({
      success: true,
      balance: liveCredit,
      currency,
      message: `الاتصال بالسيرفر ناجح! الرصيد المتاح: ${liveCredit.toFixed(2)} ${currency}`
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

    let initialBalance = 0.0;
    let initialCurrency = "USD";
    try {
      const balRes = await makeProviderApiCall(apiUrl, username, apiKey, "accountinfo");
      if (balRes.data && Array.isArray(balRes.data.SUCCESS) && balRes.data.SUCCESS[0]) {
        const row = balRes.data.SUCCESS[0];
        initialBalance = parseFloat(row.AccountInfo?.credit || row.credit || row.balance || "0") || 0;
        if (row.AccountInfo?.currency || row.currency) {
          initialCurrency = row.AccountInfo?.currency || row.currency;
        }
      }
    } catch (e) {}

    const newProvider = await prisma.apiProvider.create({
      data: {
        name,
        apiUrl,
        username,
        apiKey,
        type,
        isActive,
        balance: initialBalance,
        currency: initialCurrency,
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
    const apiUrl = (req.body.apiUrl || req.body.api_url) !== undefined ? (req.body.apiUrl || req.body.api_url).trim() : existing.apiUrl;
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

    if (apiRes.data?.ERROR && Array.isArray(apiRes.data.ERROR) && apiRes.data.ERROR[0]?.MESSAGE) {
      return res.status(400).json({
        error: `خطأ من مزود الـ API: ${apiRes.data.ERROR[0].MESSAGE}`
      });
    }

    let liveCredit = 0;
    let currency = "USD";

    if (apiRes.data) {
      if (Array.isArray(apiRes.data.SUCCESS) && apiRes.data.SUCCESS[0]) {
        const row = apiRes.data.SUCCESS[0];
        liveCredit = parseFloat(row.AccountInfo?.credit || row.credit || row.balance || "0") || 0;
        if (row.AccountInfo?.currency || row.currency) {
          currency = row.AccountInfo?.currency || row.currency;
        }
      } else if (apiRes.data.credit !== undefined) {
        liveCredit = parseFloat(apiRes.data.credit) || 0;
      } else if (apiRes.data.balance !== undefined) {
        liveCredit = parseFloat(apiRes.data.balance) || 0;
      }
    }

    const updated = await prisma.apiProvider.update({
      where: { id },
      data: {
        balance: liveCredit,
        currency
      }
    });

    return res.json({
      success: true,
      balance: liveCredit,
      credit: `${liveCredit.toFixed(2)} ${currency}`,
      currency,
      provider: updated,
      message: `تم تحديث الرصيد للمزود (${provider.name}): ${liveCredit.toFixed(2)} ${currency}`
    });
  } catch (error: any) {
    console.error("Check balance error:", error);
    return res.status(500).json({ error: "فشل تحديث رصيد المزود: " + (error.message || "") });
  }
}

// POST & GET /api/providers/:id/balance - Check & update live balance
router.post("/:id/balance", (req, res) => checkAndUpdateProviderBalance(req.params.id, res));
router.get("/:id/balance", (req, res) => checkAndUpdateProviderBalance(req.params.id, res));

// Helper: parse raw services list from provider responses
function parseAllProviderServices(imeiRes: any, serverRes: any, remoteRes?: any) {
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
      const groupName = g.GROUPNAME || g.groupName || g.name || (type === "imei" ? "IMEI Services" : "Server Services");
      const rawServices = Array.isArray(g.SERVICES) ? g.SERVICES : (g.SERVICES && typeof g.SERVICES === "object" ? Object.values(g.SERVICES) : (g.SERVICEID ? [g] : []));

      for (const s of rawServices as any[]) {
        if (!s) continue;
        const rawCustomFields = extractCustomFields(s);
        const normalizedFields = rawCustomFields.map(normalizeCustomField).filter(Boolean);

        const sId = String(s.SERVICEID || s.id || s.ID || "");
        const sName = String(s.SERVICENAME || s.name || s.NAME || "");
        const sCredit = parseFloat(s.CREDIT || s.credit || s.PRICE || s.price || "0") || 0;
        const sTime = String(s.TIME || s.time || "1-24 Hours");
        const sInfo = String(s.INFO || s.info || "");

        extractedServices.push({
          id: sId,
          service_id: sId,
          name: sName,
          service_name: sName,
          group_name: groupName,
          groupName,
          category_name: type === "imei" ? "IMEI Service" : (type === "remote" ? "Remote Service" : "Server Service"),
          service_type: type,
          credit: sCredit,
          price: sCredit,
          time: sTime,
          info: sInfo,
          customFields: normalizedFields,
          requiresCustom: normalizedFields.length > 0 ? JSON.stringify(normalizedFields) : null,
          min_quantity: parseInt(s.MIN || s.min || s.QNT_MIN || s.qnt_min || "1") || 1,
          max_quantity: parseInt(s.MAX || s.max || s.QNT_MAX || s.qnt_max || "0") || 0
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

    const services = parseAllProviderServices(imeiRes, serverRes, remoteRes);

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

// POST /api/providers/:id/sync - Non-destructive sync of all services from provider
router.post("/:id/sync", async (req, res) => {
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

    const allServices = parseAllProviderServices(imeiRes, serverRes, remoteRes);

    if (allServices.length === 0) {
      return res.status(400).json({
        error: "لم يتم العثور على خدمات في رد المزود. تأكد من صحة الرابط ومفتاح الـ API واسم المستخدم وتصريح الـ IP."
      });
    }

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

    // Load existing services for this provider or all services to match
    const existingServices = await prisma.dhruService.findMany({
      where: {
        OR: [{ providerId: provider.id }, { providerId: null }]
      }
    });
    const existingMap = new Map<string, any>();
    for (const s of existingServices) {
      if (s.dhruId) existingMap.set(s.dhruId, s);
    }

    const newServicesToInsert: any[] = [];
    const servicesToUpdate: any[] = [];
    const seenDhruIds = new Set<string>();

    const markupPercent = parseFloat(req.body.markupPercent ?? req.body.markup_percent) || 0;
    const exchangeRate = parseFloat(req.body.exchangeRate ?? req.body.exchange_rate) || 1;

    for (const s of allServices) {
      const dhruId = String(s.id);
      if (!dhruId || seenDhruIds.has(dhruId)) continue;
      seenDhruIds.add(dhruId);

      const serviceName = s.name || "";
      const groupName = s.group_name || s.groupName || "General";
      let credit = (parseFloat(s.credit) || 0) * (exchangeRate > 0 ? exchangeRate : 1);
      const time = s.time || "";
      const info = s.info || "";
      const requiresCustomStr = s.requiresCustom || null;

      let categoryName = s.category_name || "Server Service";
      if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
        categoryName = "Remote Service";
      } else if (s.service_type === "imei") {
        categoryName = "IMEI Service";
      }
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
            requiresCustom: requiresCustomStr,
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
          requiresCustom: requiresCustomStr,
          isActive: !isNotice,
          margin: computedMargin
        });
      }
    }

    // Insert new services
    if (newServicesToInsert.length > 0) {
      for (let i = 0; i < newServicesToInsert.length; i += 500) {
        const chunk = newServicesToInsert.slice(i, i + 500);
        await prisma.dhruService.createMany({ data: chunk, skipDuplicates: true });
      }
    }

    // Update existing services
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

    const totalSynced = newServicesToInsert.length + servicesToUpdate.length;

    await prisma.apiProvider.update({
      where: { id },
      data: {
        servicesCount: totalSynced
      }
    });

    return res.json({
      success: true,
      count: totalSynced,
      message: `تمت المزامنة بنجاح! تم استيراد وتحديث ${totalSynced} خدمة من المزود (${provider.name}).`
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
      return res.status(400).json({ error: "يرجى تحديد خدمة واحدة على الأقل للاستيراد" });
    }

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
      const dhruId = String(s.id || s.service_id);
      if (!dhruId) continue;

      const serviceName = s.name || s.service_name || "";
      const groupName = s.group_name || s.groupName || "General";
      let credit = (parseFloat(s.credit || s.price) || 0) * rate;
      const margin = markup > 0 ? Number(((credit * markup) / 100).toFixed(2)) : 0;
      const cleanName = cleanServiceName(serviceName, s.info || "", groupName);
      
      let categoryName = s.category_name || "Server Service";
      if (`${groupName} ${serviceName}`.match(/remote|rent|teamviewer|anydesk|usb|flexi/i)) {
        categoryName = "Remote Service";
      } else if (s.service_type === "imei") {
        categoryName = "IMEI Service";
      }
      const categoryId = categoryMap.get(categoryName)!;

      const requiresCustomStr = s.customFields && Array.isArray(s.customFields)
        ? JSON.stringify(s.customFields.map(normalizeCustomField).filter(Boolean))
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
          requiresCustom: requiresCustomStr,
          isActive: true,
          margin
        }
      });
      count++;
    }

    await prisma.apiProvider.update({
      where: { id },
      data: {
        servicesCount: await prisma.dhruService.count({ where: { providerId: id } })
      }
    });

    return res.json({
      success: true,
      count,
      message: `تم استيراد وتحديث ${count} خدمة بنجاح!`
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
      include: { dhruCategory: true },
      orderBy: { name: "asc" }
    });

    return res.json({
      success: true,
      services
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
