import https from "https";
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

type DhruAction =
  | "accountinfo"
  | "imeiservicelist"
  | "serverservicelist"
  | "remoteservicelist"
  | "placeimeiorder"
  | "placeserverorder"
  | "getimeiorder"
  | "getserverorder";

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

    const username = (provider?.username !== undefined ? provider.username : DHRU_USERNAME) || "";
    const apiKey = (provider?.apiKey || DHRU_API_KEY || "").trim();

    const data = new URLSearchParams();
    if (username) data.append("username", username.trim());
    data.append("key", apiKey);
    data.append("apiaccesskey", apiKey);
    data.append("action", action);
    data.append("requestformat", "JSON");

    Object.entries(parameters).forEach(([key, value]) => {
      data.append(`parameters[${key}]`, value);
      data.append(key, value);
    });

    try {
      const postData = data.toString();
      const urlObj = new URL(targetUrl);

      if (urlObj.protocol !== "https:") {
        return resolve({ error: "Only HTTPS provider connections are permitted.", SUCCESS: false });
      }

      if (isPrivateHostname(urlObj.hostname)) {
        console.error(`[SSRF BLOCK] Attempted to connect to private host: ${urlObj.hostname}`);
        return resolve({ error: "SSRF Attempt Detected: Blocked local/private network address", SUCCESS: false });
      }

      let safeAddress: string;
      try {
        const { address } = await lookup(urlObj.hostname);
        if (isPrivateIP(address)) {
          console.error(`[SSRF BLOCK] Hostname ${urlObj.hostname} resolved to private IP: ${address}`);
          return resolve({ error: "SSRF Attempt Detected: Resolved to local/private network address", SUCCESS: false });
        }
        safeAddress = address;
      } catch (dnsErr) {
        console.error(`[DNS Lookup Error] Failed to resolve ${urlObj.hostname}:`, dnsErr);
        return resolve({ error: "Failed to resolve provider hostname", SUCCESS: false });
      }

      const options = {
        hostname: safeAddress,
        port: urlObj.port ? parseInt(urlObj.port, 10) : 443,
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        family: 4,
        servername: urlObj.hostname,
        headers: {
          Host: urlObj.hostname,
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(postData),
          "User-Agent": "ArabTechPro/1.0",
          Accept: "application/json, text/plain, */*"
        },
        timeout: 60000
      };

      const req = https.request(options, (res) => {
        let rawText = "";
        res.on("data", (chunk) => { rawText += chunk; });
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

      req.on("error", (err) => {
        console.error(`[Dhru API Exception] URL: ${targetUrl} | Error:`, err.message);
        resolve({ error: err.message, SUCCESS: false });
      });

      req.on("timeout", () => {
        req.destroy();
        console.error(`[Dhru API Timeout] URL: ${targetUrl}`);
        resolve({ error: "Request timeout", SUCCESS: false });
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

  const normalized: Record<string, string> = {};
  for (const [rawKey, rawVal] of Object.entries(customFields)) {
    if (rawVal === undefined || rawVal === null) continue;
    const value = typeof rawVal === "string" ? rawVal.trim() : String(rawVal);
    if (!value) continue;

    const inputKey = String(rawKey).trim();
    const cleanKey = inputKey.replace(/^custom_/i, "").trim().toLowerCase();

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
        fieldLabel === inputKey.toLowerCase()
      );
    });

    const providerKey =
      matchingField?.field_id
      || matchingField?.customname
      || matchingField?.fieldname
      || matchingField?.name
      || matchingField?.reqid
      || inputKey.replace(/^custom_/i, "");

    normalized[String(providerKey)] = String(value);
  }

  return normalized;
}

export async function placeImeiOrder(
  serviceId: string,
  imei: string,
  customFields: Record<string, string> = {},
  provider?: ProviderConfig
) {
  const params: Record<string, string> = {
    SERVICEID: serviceId,
    ID: serviceId,
    serviceid: serviceId,
    id: serviceId,
    IMEI: imei,
    imei: imei
  };

  const cleanFields: Record<string, string> = {};
  if (customFields && typeof customFields === "object") {
    Object.entries(customFields).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      const valStr = String(v).trim();
      if (!valStr) return;
      const strippedKey = k.replace(/^custom_/i, "").trim();
      cleanFields[strippedKey] = valStr;
    });
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

  let res = await dhruApiRequest("placeimeiorder", params, provider);

  // Fallback if provider expects placeserverorder
  if (res?.ERROR?.[0]?.MESSAGE === 'Command Not Found' || res?.error?.includes?.('Command Not Found')) {
    console.log('[Dhru API] placeimeiorder returned Command Not Found, attempting fallback placeserverorder...');
    res = await dhruApiRequest("placeserverorder", params, provider);
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

  if (targetIdentifier) {
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
    });
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

  // Standard Dhru command for placing server service orders is placeserverorder
  let res = await dhruApiRequest("placeserverorder", params, provider);

  // If provider returns Command Not Found, fallback to placeimeiorder
  if (res?.ERROR?.[0]?.MESSAGE === 'Command Not Found' || res?.error?.includes?.('Command Not Found')) {
    console.log('[Dhru API] placeserverorder returned Command Not Found, attempting fallback placeimeiorder...');
    res = await dhruApiRequest("placeimeiorder", params, provider);
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
  if (res?.ERROR?.[0]?.MESSAGE === 'Command Not Found') {
    res = await dhruApiRequest("getserverorder", params, provider);
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
  // In Dhru, getimeiorder is the standard query for all orders
  let res = await dhruApiRequest("getimeiorder", params, provider);
  if (res?.ERROR?.[0]?.MESSAGE === 'Command Not Found') {
    res = await dhruApiRequest("getserverorder", params, provider);
  }
  return res;
}
