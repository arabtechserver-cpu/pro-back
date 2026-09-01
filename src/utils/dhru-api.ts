import https from "https";
import http from "http";

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

export function dhruApiRequest(
  action: DhruAction,
  parameters: Record<string, string> = {},
  provider?: ProviderConfig
): Promise<any> {
  return new Promise((resolve) => {
    const targetUrl = normalizeTargetApiUrl(provider?.apiUrl);
    const username = (provider?.username !== undefined ? provider.username : DHRU_USERNAME) || "";
    const apiKey = (provider?.apiKey || DHRU_API_KEY || "").trim();

    const data = new URLSearchParams();
    if (username) data.append("username", username.trim());
    data.append("key", apiKey);
    data.append("apiaccesskey", apiKey);
    data.append("action", action);
    data.append("requestformat", "JSON");

    // Format parameters
    Object.entries(parameters).forEach(([key, value]) => {
      data.append(`parameters[${key}]`, value);
    });

    try {
      const postData = data.toString();
      const urlObj = new URL(targetUrl);
      
      const options = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: "POST",
        family: 4, // Enforce IPv4 lookup
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
          if ((res.statusCode || 200) >= 400 || (result && result.SUCCESS === false)) {
            console.error(`[Dhru API Error] URL: ${targetUrl} | Status: ${res.statusCode} | Response:`, rawText);
          }
          resolve(result);
        });
      });

      req.on("error", (error: any) => {
        console.error(`[Dhru API Request Failed] URL: ${targetUrl}:`, error);
        resolve({ error: true, message: (error as Error).message });
      });

      req.on("timeout", () => {
        req.destroy();
        console.error(`[Dhru API Timeout] URL: ${targetUrl}`);
        resolve({ error: true, message: "API request timed out" });
      });

      req.write(postData);
      req.end();
    } catch (error: any) {
      console.error(`[Dhru API Sync Error] URL: ${targetUrl}:`, error);
      resolve({ error: true, message: (error as Error).message });
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

export async function placeImeiOrder(
  serviceId: string,
  imei: string,
  customFields: Record<string, string> = {},
  provider?: ProviderConfig
) {
  const params: Record<string, string> = {
    SERVICEID: serviceId,
    ID: serviceId,
    IMEI: imei
  };

  if (customFields && Object.keys(customFields).length > 0) {
    params["CUSTOMFIELD"] = Buffer.from(JSON.stringify(customFields)).toString("base64");
    // Also include custom field parameters directly for compatibility
    Object.entries(customFields).forEach(([k, v]) => {
      params[`customfield[${k}]`] = v;
    });
  }

  return dhruApiRequest("placeimeiorder", params, provider);
}

export async function placeServerOrder(
  serviceId: string,
  quantity: number = 1,
  customFields: Record<string, string> = {},
  imei?: string,
  provider?: ProviderConfig
) {
  const params: Record<string, string> = {
    SERVICEID: serviceId,
    ID: serviceId,
    QNT: String(quantity)
  };

  if (imei) {
    params["IMEI"] = imei;
  }

  if (customFields && Object.keys(customFields).length > 0) {
    params["CUSTOMFIELD"] = Buffer.from(JSON.stringify(customFields)).toString("base64");
    Object.entries(customFields).forEach(([k, v]) => {
      params[`customfield[${k}]`] = v;
    });
  }

  return dhruApiRequest("placeserverorder", params, provider);
}

export async function getImeiOrder(orderId: string, provider?: ProviderConfig) {
  return dhruApiRequest("getimeiorder", { ID: orderId }, provider);
}

export async function getServerOrder(orderId: string, provider?: ProviderConfig) {
  return dhruApiRequest("getserverorder", { ID: orderId }, provider);
}
