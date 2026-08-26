export const DHRU_API_URL = process.env.DHRU_API_URL || "https://arab-tech1.online/api/v1";
export const DHRU_USERNAME = process.env.DHRU_USERNAME || "mina15g4y";
export const DHRU_API_KEY = process.env.DHRU_API_KEY || "3AE-27F-14D-104-830-375-6D";

type DhruAction = "accountinfo" | "imeiservicelist" | "serverservicelist" | "placeimeiorder" | "placeserverorder" | "getimeiorder" | "getserverorder";

export async function dhruApiRequest(action: DhruAction, parameters: Record<string, string> = {}) {
  const data = new URLSearchParams();
  data.append("username", DHRU_USERNAME);
  data.append("key", DHRU_API_KEY);
  data.append("apiaccesskey", DHRU_API_KEY);
  data.append("action", action);
  data.append("requestformat", "JSON");
  
  // Send parameters in the format Dhru API natively expects: parameters[KEY]=VALUE
  Object.entries(parameters).forEach(([key, value]) => {
    data.append(`parameters[${key}]`, value);
  });

  try {
    const response = await fetch(DHRU_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: data.toString(),
      // No caching so we get fresh data
      cache: "no-store", 
    });

    const rawText = await response.text();
    let result: any;
    try {
      result = JSON.parse(rawText);
    } catch (e) {
      result = { error: rawText };
    }

    if (!response.ok || (result && result.SUCCESS === false)) {
      console.error(`[Dhru API Error] Status: ${response.status} | Response:`, rawText);
    }

    return result;
  } catch (error) {
    console.error("Dhru API Request Failed:", error);
    return { error: true, message: (error as Error).message };
  }
}

export async function getAccountInfo() {
  return dhruApiRequest("accountinfo");
}

export async function getImeiServiceList() {
  return dhruApiRequest("imeiservicelist");
}

export async function getServerServiceList() {
  return dhruApiRequest("serverservicelist");
}

export async function placeImeiOrder(serviceId: string, imei: string, customFields: Record<string, string> = {}) {
  const params: Record<string, string> = {
    "SERVICEID": serviceId,
    "ID": serviceId, // send both just in case
    "IMEI": imei
  };
  
  if (customFields && Object.keys(customFields).length > 0) {
    params["CUSTOMFIELD"] = Buffer.from(JSON.stringify(customFields)).toString('base64');
  }
  
  return dhruApiRequest("placeimeiorder", params);
}

export async function placeServerOrder(serviceId: string, quantity: number = 1, customFields: Record<string, string> = {}, imei?: string) {
  const params: Record<string, string> = {
    "SERVICEID": serviceId,
    "ID": serviceId, // send both just in case
    "QNT": String(quantity)
  };
  
  if (imei) {
    params["IMEI"] = imei;
  }
  
  if (customFields && Object.keys(customFields).length > 0) {
    params["CUSTOMFIELD"] = Buffer.from(JSON.stringify(customFields)).toString('base64');
  }

  return dhruApiRequest("placeserverorder", params);
}

export async function getImeiOrder(orderId: string) {
  return dhruApiRequest("getimeiorder", {
    ID: orderId
  });
}

export async function getServerOrder(orderId: string) {
  return dhruApiRequest("getserverorder", {
    ID: orderId
  });
}
