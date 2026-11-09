import https from "https";
import { withinDeadline } from "./request-deadline";
import http from "http";
import dns from "dns";
import { promisify } from "util";

const lookup = promisify(dns.lookup);

export function isPrivateIP(ip: string): boolean {
  if (!ip) return true;

  const cleanIp = ip.startsWith("::ffff:") ? ip.slice(7) : ip;

  const ipv4Parts = cleanIp.split(".").map(Number);
  if (ipv4Parts.length === 4 && ipv4Parts.every((p) => !isNaN(p) && p >= 0 && p <= 255)) {
    const [b0, b1, b2] = ipv4Parts;
    if (b0 === 0) return true;
    if (b0 === 10) return true;
    if (b0 === 100 && b1 >= 64 && b1 <= 127) return true;
    if (b0 === 127) return true;
    if (b0 === 169 && b1 === 254) return true;
    if (b0 === 172 && b1 >= 16 && b1 <= 31) return true;
    if (b0 === 192 && b1 === 0 && b2 === 0) return true;
    if (b0 === 192 && b1 === 0 && b2 === 2) return true;
    if (b0 === 192 && b1 === 88 && b2 === 99) return true;
    if (b0 === 192 && b1 === 168) return true;
    if (b0 === 198 && (b1 === 18 || b1 === 19)) return true;
    if (b0 === 198 && b1 === 51 && b2 === 100) return true;
    if (b0 === 203 && b1 === 0 && b2 === 113) return true;
    if (b0 >= 224) return true;
    return false;
  }

  const lower = cleanIp.toLowerCase();
  if (
    lower === "::" ||
    lower === "::1" ||
    lower.startsWith("fe8") ||
    lower.startsWith("fe9") ||
    lower.startsWith("fea") ||
    lower.startsWith("feb") ||
    lower.startsWith("fc") ||
    lower.startsWith("fd") ||
    lower.startsWith("ff") ||
    lower.startsWith("2001:db8:") ||
    lower.startsWith("64:ff9b:")
  ) {
    return true;
  }

  return false;
}

export function isPrivateHostname(hostname: string): boolean {
  if (!hostname) return true;
  const lower = hostname.toLowerCase();
  return (
    lower === "localhost" ||
    lower.endsWith(".localhost") ||
    lower.endsWith(".local") ||
    lower.endsWith(".internal") ||
    lower.endsWith(".lan") ||
    lower === "metadata.google.internal" ||
    isPrivateIP(lower)
  );
}

export const DHRU_API_URL = process.env.DHRU_API_URL || "";
export const DHRU_USERNAME = process.env.DHRU_USERNAME || "";
export const DHRU_API_KEY = process.env.DHRU_API_KEY || "";

export interface ProviderConfig {
  apiUrl?: string;
  username?: string | null;
  apiKey?: string;
}

// Per-hostname TLS failure cooldown — prevents hammering a provider with a broken cert
const tlsCooldowns = new Map<string, number>();
const TLS_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

export function formatProviderConnectionError(error: { code?: string; message: string }, hostname: string): string {
  if (error.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
    return `${error.message}. Correct the HTTPS certificate/DNS for ${hostname} or configure the provider's verified API URL.`;
  }
  return error.message;
}

export function cleanDhruErrorMessage(raw: unknown): string {
  if (!raw) return "";
  let text = String(raw).trim();
  text = text.replace(/^ValidationError\d*/i, "").trim();
  text = text.replace(/<\/?[^>]+>/g, "\n").trim();
  const parts = text
    .split(/[\n,;]+/)
    .map(p => p.trim().replace(/^[-:•\s]+|[-:•\s]+$/g, ""))
    .filter(Boolean);
  const uniqueParts = Array.from(new Set(parts));
  return uniqueParts.join(" - ") || text;
}

export function isInvalidImeiError(response: any): boolean {
  if (!response) return false;
  const raw = (
    response?.ERROR?.[0]?.MESSAGE ||
    response?.ERROR?.[0]?.message ||
    response?.ERROR?.[0]?.FULL_DESCRIPTION ||
    response?.Error ||
    response?.error ||
    ""
  ).toLowerCase();
  return (
    raw.includes("invalid imei") ||
    raw.includes("required imei") ||
    raw.includes("imei invalid") ||
    raw.includes("imei is required") ||
    raw.includes("invalid-imei")
  );
}

export function getDhruApiErrorMessage(response: any): string | null {
  const error = response?.error || response?.Error || response?.ERROR;
  if (!error) return null;
  const detail = Array.isArray(error) ? error[0] : error;
  if (!detail) return null;
  const rawMsg = typeof detail === "string" ? detail : String(detail.MESSAGE || detail.message || detail.error || JSON.stringify(detail));
  return cleanDhruErrorMessage(rawMsg);
}

type DhruAction =
  | "accountinfo"
  | "imeiservicelist"
  | "serverservicelist"
  | "remoteservicelist"
  | "placeimeiorder"
  | "placeserverorder"
  | "placeorder"
  | "placeremoteorder"
  | "getimeiorder"
  | "getserverorder"
  | "getorder";

export function isActionUnsupported(response: any): boolean {
  if (!response) return false;
  const raw = (
    response?.ERROR?.[0]?.MESSAGE ||
    response?.ERROR?.[0]?.message ||
    response?.Error ||
    response?.error ||
    ""
  ).toLowerCase();
  return (
    raw.includes("invalid action") ||
    raw.includes("command not found") ||
    raw.includes("action not found") ||
    raw.includes("unknown action") ||
    raw.includes("not supported") ||
    raw.includes("invalid command")
  );
}

export function normalizeTargetApiUrl(rawUrl?: string): string {
  let url = (rawUrl || DHRU_API_URL).trim();
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

  const path = urlObj.pathname.replace(/\/+$/, "");
  const hasExplicitApiEndpoint =
    /\/api\/index\.php$/i.test(path) ||
    /\/api\/v\d+$/i.test(path) ||
    (path.includes("/api/") && !/\/api$/i.test(path));

  if (!hasExplicitApiEndpoint) {
    if (/\/api$/i.test(path)) {
      urlObj.pathname = path + "/index.php";
    } else {
      urlObj.pathname = path + "/api/index.php";
    }
  }

  return urlObj.toString();
}

export function dhruApiRequest(
  action: DhruAction,
  parameters: Record<string, string> = {},
  provider?: ProviderConfig
): Promise<any> {
  return new Promise(async (resolve) => {
    let targetUrl: string;
    try {
      targetUrl = normalizeTargetApiUrl(provider?.apiUrl);
    } catch (err: any) {
      return resolve({ error: err.message, SUCCESS: false });
    }

    if (!targetUrl) {
      return resolve({ error: "Missing or unconfigured provider API URL", SUCCESS: false });
    }

    const username = (provider?.username !== undefined ? provider.username : DHRU_USERNAME) || "";
    const apiKey = (provider?.apiKey || DHRU_API_KEY || "").trim();

    // Separate bracket-style keys (e.g. customfield[FIELD_NAME]) from plain keys.
    // URLSearchParams percent-encodes '[' and ']' in key names, which breaks PHP
    // providers that parse $_POST['customfield']['FIELD_NAME']. We append those as
    // literal text directly to avoid the encoding problem.
    const safePairs: Array<[string, string]> = [];
    const bracketPairs: Array<[string, string]> = [];

    const data = new URLSearchParams();
    if (username) data.append("username", username.trim());
    data.append("key", apiKey);
    data.append("apiaccesskey", apiKey);
    data.append("action", action);
    data.append("requestformat", "JSON");

    Object.entries(parameters).forEach(([key, value]) => {
      if (key.includes("[")) {
        // Literal bracket key — must not go through URLSearchParams encoding.
        bracketPairs.push([key, value]);
      } else {
        data.append(`parameters[${key}]`, value);
        safePairs.push([key, value]);
      }
    });

    // Append plain keys after the parameters[KEY] pairs.
    safePairs.forEach(([key, value]) => data.append(key, value));

    try {
      // Build final body: URLSearchParams-encoded fields + literal bracket fields.
      let postData = data.toString();
      bracketPairs.forEach(([key, value]) => {
        const encodedKey = key.split("[").map((segment, i) =>
          i === 0
            ? encodeURIComponent(segment)
            : `[${encodeURIComponent(segment.replace(/]$/, ""))}]`
        ).join("");
        postData += (postData ? "&" : "") + encodedKey + "=" + encodeURIComponent(value);
      });
      const urlObj = new URL(targetUrl);

      if (urlObj.protocol !== "https:") {
        return resolve({ error: "Only HTTPS provider connections are permitted.", SUCCESS: false });
      }

      if (isPrivateHostname(urlObj.hostname)) {
        console.error(`[SSRF BLOCK] Attempted to connect to private host: ${urlObj.hostname}`);
        return resolve({ error: "SSRF Attempt Detected: Blocked local/private network address", SUCCESS: false });
      }

      // Skip request immediately if this hostname recently had a TLS cert failure
      const cooldownUntil = tlsCooldowns.get(urlObj.hostname);
      if (cooldownUntil && Date.now() < cooldownUntil) {
        const remainingSec = Math.ceil((cooldownUntil - Date.now()) / 1000);
        console.warn(`[Dhru API] Skipping ${urlObj.hostname} — TLS cert failure cooldown active (${remainingSec}s remaining)`);
        return resolve({ error: formatProviderConnectionError({ code: "ERR_TLS_CERT_ALTNAME_INVALID", message: "TLS certificate mismatch — provider skipped during cooldown" }, urlObj.hostname), SUCCESS: false, transportError: true });
      }

      let safeAddress: string;
      try {
        const { address } = await withinDeadline(lookup(urlObj.hostname), 3000);
        if (isPrivateIP(address)) {
          console.error(`[SSRF BLOCK] Hostname ${urlObj.hostname} resolved to private IP: ${address}`);
          return resolve({ error: "SSRF Attempt Detected: Resolved to local/private network address", SUCCESS: false });
        }
        safeAddress = address;
      } catch (dnsErr) {
        console.error(`[DNS Lookup Error] Failed to resolve ${urlObj.hostname}:`, dnsErr);
        return resolve({ error: "Failed to resolve provider hostname", SUCCESS: false, transportError: true });
      }

      const options = {
        hostname: safeAddress,
        port: urlObj.port ? parseInt(urlObj.port, 10) : 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        family: 4,
        servername: urlObj.hostname,
        rejectUnauthorized: true,
        headers: {
          Host: urlObj.hostname,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": "ArabTechPro/1.0",
          Accept: "application/json, text/plain, */*"
        },
        timeout: 25000
      };

      const req = https.request({ ...options, signal: AbortSignal.timeout(25000) }, (res) => {
        let rawText = "";
        let responseBytes = 0;
        res.on("data", (chunk) => {
          responseBytes += Buffer.byteLength(chunk);
          if (responseBytes > 16 * 1024 * 1024) {
            req.destroy(new Error('Provider response exceeds 16 MiB limit'));
            return;
          }
          rawText += chunk;
        });
        res.on("end", () => {
          let result: any;
          try {
            result = JSON.parse(rawText);
          } catch {
            result = { error: rawText };
          }
          if ((res.statusCode || 200) >= 400 || (result && result.SUCCESS === false)) {
            console.error(`[Dhru API Error] URL: ${targetUrl} | Status: ${res.statusCode} | Response:`, rawText);
          }
          resolve(result);
        });
      });

      req.on("error", (err: any) => {
        if (err.code === "ERR_TLS_CERT_ALTNAME_INVALID") {
          tlsCooldowns.set(urlObj.hostname, Date.now() + TLS_COOLDOWN_MS);
          console.error(`[Dhru API Exception] URL: ${targetUrl} | Error:`, err.message);
          console.error(`[Dhru API] TLS cert mismatch on ${urlObj.hostname} — suppressing retries for ${TLS_COOLDOWN_MS / 60000} minutes`);
        } else {
          console.error(`[Dhru API Exception] URL: ${targetUrl} | Error:`, err.message);
        }
        resolve({ error: formatProviderConnectionError(err, urlObj.hostname), SUCCESS: false, transportError: true });
      });

      req.on("timeout", () => {
        req.destroy();
        console.error(`[Dhru API Timeout] URL: ${targetUrl}`);
        resolve({ error: "Request timeout", SUCCESS: false, transportError: true });
      });

      req.write(postData);
      req.end();
    } catch (err: any) {
      console.error(`[Dhru API Init Exception]:`, err.message);
      resolve({ error: err.message, SUCCESS: false });
    }
  });
}

export async function getAccountInfo(provider?: ProviderConfig) {
  return dhruApiRequest("accountinfo", {}, provider);
}

export async function getImeiServiceList(provider?: ProviderConfig) {
  return dhruApiRequest("imeiservicelist", {}, provider);
}

export async function getServerServiceList(provider?: ProviderConfig) {
  return dhruApiRequest("serverservicelist", {}, provider);
}

export async function getRemoteServiceList(provider?: ProviderConfig) {
  return dhruApiRequest("remoteservicelist", {}, provider);
}

export function normalizeProviderCustomFields(
  customFields: Record<string, any> = {},
  requiresCustom?: string | null
): Record<string, string> {
  if (!customFields || typeof customFields !== "object") return {};

  let requiredMeta: any[] = [];
  try {
    if (requiresCustom) {
      const parsed = JSON.parse(requiresCustom);
      if (Array.isArray(parsed)) {
        requiredMeta = parsed;
      } else if (parsed && typeof parsed === "object") {
        requiredMeta = Object.entries(parsed).map(([key, val]: [string, any]) => ({
          ...(val && typeof val === "object" ? val : {}),
          id: val?.id || val?.field_id || key,
          field_id: val?.field_id || val?.reqid || val?.id || key,
          name: val?.name || val?.fieldname || val?.label || key,
          fieldname: val?.fieldname || key,
          label: val?.label || key
        }));
      }
    }
  } catch {}

  const canonical = (s: string) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(customFields)) {
    if (rawVal === undefined || rawVal === null) continue;
    const value = typeof rawVal === "string" ? rawVal.trim() : String(rawVal);
    if (!value) continue;

    const inputKey = String(rawKey).trim();
    const cleanKey = inputKey.replace(/^custom_/i, "").trim().toLowerCase();
    const canonKey = canonical(cleanKey);

    const matchingField = requiredMeta.find((meta: any) => {
      const fieldId = String(meta?.id || meta?.field_id || meta?.reqid || meta?.REQID || "").replace(/^custom_/i, "").toLowerCase();
      const fieldName = String(meta?.name || meta?.field_name || meta?.fieldname || meta?.FIELDNAME || meta?.customname || "").toLowerCase();
      const fieldLabel = String(meta?.label || "").toLowerCase();
      const fieldApiName = String(meta?.api_name || meta?.field_api_name || "").toLowerCase();
      return (
        fieldId === cleanKey ||
        fieldName === cleanKey ||
        fieldLabel === cleanKey ||
        fieldApiName === cleanKey ||
        fieldId === inputKey.toLowerCase() ||
        fieldName === inputKey.toLowerCase() ||
        fieldLabel === inputKey.toLowerCase() ||
        canonical(fieldId) === canonKey ||
        canonical(fieldName) === canonKey ||
        canonical(fieldLabel) === canonKey ||
        canonical(fieldApiName) === canonKey
      );
    });

    const primaryKey =
      matchingField?.fieldname
      || matchingField?.name
      || matchingField?.field_name
      || matchingField?.customname
      || matchingField?.field_id
      || inputKey.replace(/^custom_/i, "");

    const strKey = String(primaryKey).trim();
    normalized[strKey] = String(value);

    const underscoreKey = strKey.replace(/[\s-]+/g, "_");
    if (underscoreKey && underscoreKey !== strKey) {
      normalized[underscoreKey] = String(value);
    }
    const spacedKey = strKey.replace(/[_\-]+/g, " ");
    if (spacedKey && spacedKey !== strKey) {
      normalized[spacedKey] = String(value);
    }
  }

  return normalized;
}

export async function placeImeiOrder(
  serviceId: string,
  imei: string,
  customFields: Record<string, string> = {},
  provider?: ProviderConfig
) {
  const isNumericImei = /^\d{14,16}$/.test((imei || "").replace(/[\s-]/g, ''));
  const params: Record<string, string> = {
    SERVICEID: serviceId,
    ID: serviceId,
    serviceid: serviceId,
    id: serviceId
  };
  if (isNumericImei) {
    params["IMEI"] = imei;
    params["imei"] = imei;
  }

  const cleanFields: Record<string, string> = {};
  if (customFields && typeof customFields === "object") {
    Object.entries(customFields).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const valStr = String(v).trim();
      if (!valStr) return;
      const strippedKey = k.replace(/^custom_/i, "").trim();
      cleanFields[strippedKey] = valStr;
      const underscoreKey = strippedKey.replace(/[\s-]+/g, "_");
      if (underscoreKey) cleanFields[underscoreKey] = valStr;
      const spacedKey = strippedKey.replace(/[_\-]+/g, " ");
      if (spacedKey) cleanFields[spacedKey] = valStr;
    });
  }

  if (!isNumericImei && imei) {
    const hasKey = Object.keys(cleanFields).some(k => /^(sn|serial|imei[\/_]sn)$/i.test(k));
    if (!hasKey) {
      cleanFields["SN"] = imei;
      cleanFields["IMEI/SN"] = imei;
    }
  }

  if (Object.keys(cleanFields).length > 0) {
    const base64Custom = Buffer.from(JSON.stringify(cleanFields)).toString("base64");
    params["CUSTOMFIELD"] = base64Custom;
    params["customfield"] = base64Custom;
    Object.entries(cleanFields).forEach(([k, v]) => {
      params[`customfield[${k}]`] = v;
      params[k] = v;
    });
  }

  let res: any;
  if (isNumericImei) {
    res = await dhruApiRequest("placeimeiorder", params, provider);
  } else {
    const serverParams: Record<string, string> = { ...params, QNT: "1", qnt: "1" };
    res = await dhruApiRequest("placeserverorder", serverParams, provider);
  }

  if (isActionUnsupported(res) || isInvalidImeiError(res)) {
    console.log('[Dhru API] Attempting fallback placeserverorder...');
    const serverParams: Record<string, string> = { ...params, QNT: "1", qnt: "1" };
    delete serverParams.IMEI;
    delete serverParams.imei;
    const serverRes = await dhruApiRequest("placeserverorder", serverParams, provider);
    if (serverRes && (serverRes.SUCCESS || serverRes.REFERENCEID || serverRes.ID || !serverRes.ERROR)) {
      res = serverRes;
    } else if (isActionUnsupported(res)) {
      res = serverRes;
    }
  }

  if (isActionUnsupported(res)) {
    console.log('[Dhru API] attempting fallback placeorder...');
    const fallbackParams: Record<string, string> = { ...params };
    if (!isNumericImei) {
      delete fallbackParams.IMEI;
      delete fallbackParams.imei;
    }
    res = await dhruApiRequest("placeorder", fallbackParams, provider);
  }

  if (isActionUnsupported(res)) {
    console.log('[Dhru API] attempting fallback placeremoteorder...');
    const fallbackParams: Record<string, string> = { ...params };
    if (!isNumericImei) {
      delete fallbackParams.IMEI;
      delete fallbackParams.imei;
    }
    res = await dhruApiRequest("placeremoteorder", fallbackParams, provider);
  }

  return res;
}

export async function placeServerOrder(
  serviceId: string,
  quantity: number = 1,
  customFields: Record<string, string> = {},
  imei?: string,
  provider?: ProviderConfig
) {
  const finalQty = quantity > 0 ? quantity : 1;
  const params: Record<string, string> = {
    SERVICEID: serviceId,
    ID: serviceId,
    serviceid: serviceId,
    id: serviceId,
    QNT: String(finalQty),
    qnt: String(finalQty)
  };

  const targetIdentifier = (imei && imei.trim())
    ? imei.trim()
    : (
        customFields.SN ||
        customFields.sn ||
        customFields.ecid ||
        customFields.ECID ||
        customFields.serial ||
        customFields.email ||
        customFields.username ||
        customFields.account ||
        customFields.custom_sn ||
        customFields.custom_ecid ||
        customFields.custom_email ||
        customFields.custom_username ||
        ""
      );

  const isNumericImei = /^\d{14,16}$/.test((targetIdentifier || "").replace(/[\s-]/g, ''));
  if (targetIdentifier && isNumericImei) {
    params["IMEI"] = targetIdentifier;
    params["imei"] = targetIdentifier;
  }

  const cleanFields: Record<string, string> = {};
  if (customFields && typeof customFields === "object") {
    Object.entries(customFields).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const valStr = String(v).trim();
      if (!valStr) return;
      const strippedKey = k.replace(/^custom_/i, "").trim();
      cleanFields[strippedKey] = valStr;
      const underscoreKey = strippedKey.replace(/[\s-]+/g, "_");
      if (underscoreKey) cleanFields[underscoreKey] = valStr;
      const spacedKey = strippedKey.replace(/[_\-]+/g, " ");
      if (spacedKey) cleanFields[spacedKey] = valStr;
    });
  }

  if (targetIdentifier && !isNumericImei) {
    const hasIdentifierInCustom = Object.keys(cleanFields).some(k =>
      /^(sn|serial|imei[\/_]sn|account|username|identifier)$/i.test(k)
    );
    if (!hasIdentifierInCustom) {
      cleanFields["SN"] = targetIdentifier;
      cleanFields["IMEI/SN"] = targetIdentifier;
    }
  }

  if (Object.keys(cleanFields).length > 0) {
    const base64Custom = Buffer.from(JSON.stringify(cleanFields)).toString("base64");
    params["CUSTOMFIELD"] = base64Custom;
    params["customfield"] = base64Custom;
    Object.entries(cleanFields).forEach(([k, v]) => {
      params[`customfield[${k}]`] = v;
      params[k] = v;
    });
  }

  let res = await dhruApiRequest("placeserverorder", params, provider);

  if (isActionUnsupported(res)) {
    console.log('[Dhru API] placeserverorder returned Command Not Found, attempting fallback placeimeiorder...');
    const imeiParams: Record<string, string> = { ...params };
    if (targetIdentifier) {
      imeiParams["IMEI"] = targetIdentifier;
      imeiParams["imei"] = targetIdentifier;
    }
    res = await dhruApiRequest("placeimeiorder", imeiParams, provider);
  }

  if (isActionUnsupported(res)) {
    console.log('[Dhru API] attempting fallback placeorder...');
    res = await dhruApiRequest("placeorder", params, provider);
  }

  if (isActionUnsupported(res)) {
    console.log('[Dhru API] attempting fallback placeremoteorder...');
    res = await dhruApiRequest("placeremoteorder", params, provider);
  }

  return res;
}

export async function getImeiOrder(orderId: string, provider?: ProviderConfig) {
  const params = {
    ID: orderId,
    id: orderId,
    REFERENCEID: orderId,
    referenceid: orderId,
    orderid: orderId
  };
  let res = await dhruApiRequest("getimeiorder", params, provider);
  if (isActionUnsupported(res)) {
    res = await dhruApiRequest("getserverorder", params, provider);
  }
  if (isActionUnsupported(res)) {
    res = await dhruApiRequest("getorder", params, provider);
  }
  return res;
}

export async function getServerOrder(orderId: string, provider?: ProviderConfig) {
  const params = {
    ID: orderId,
    id: orderId,
    REFERENCEID: orderId,
    referenceid: orderId,
    orderid: orderId
  };
  let res = await dhruApiRequest("getimeiorder", params, provider);
  if (isActionUnsupported(res)) {
    res = await dhruApiRequest("getserverorder", params, provider);
  }
  if (isActionUnsupported(res)) {
    res = await dhruApiRequest("getorder", params, provider);
  }
  return res;
}
