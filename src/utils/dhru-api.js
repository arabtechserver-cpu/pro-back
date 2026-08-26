"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DHRU_API_KEY = exports.DHRU_USERNAME = exports.DHRU_API_URL = void 0;
exports.dhruApiRequest = dhruApiRequest;
exports.getAccountInfo = getAccountInfo;
exports.getImeiServiceList = getImeiServiceList;
exports.getServerServiceList = getServerServiceList;
exports.placeImeiOrder = placeImeiOrder;
exports.placeServerOrder = placeServerOrder;
exports.getImeiOrder = getImeiOrder;
exports.DHRU_API_URL = "https://arab-tech1.online/api/v1";
exports.DHRU_USERNAME = "mina15g4y";
exports.DHRU_API_KEY = "3AE-27F-14D-104-830-375-6D";
async function dhruApiRequest(action, parameters = {}) {
    const data = new URLSearchParams({
        username: exports.DHRU_USERNAME,
        key: exports.DHRU_API_KEY,
        action: action,
        ...parameters
    });
    try {
        const response = await fetch(exports.DHRU_API_URL, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: data,
            // No caching so we get fresh data
            cache: "no-store",
        });
        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }
        const result = await response.json();
        return result;
    }
    catch (error) {
        console.error("Dhru API Request Failed:", error);
        return { error: true, message: error.message };
    }
}
async function getAccountInfo() {
    return dhruApiRequest("accountinfo");
}
async function getImeiServiceList() {
    return dhruApiRequest("imeiservicelist");
}
async function getServerServiceList() {
    return dhruApiRequest("serverservicelist");
}
async function placeImeiOrder(serviceId, imei) {
    return dhruApiRequest("placeimeiorder", {
        "SERVICEID": serviceId,
        "IMEI": imei
    });
}
async function placeServerOrder(serviceId, quantity = 1, customFields = {}) {
    const params = {
        "SERVICEID": serviceId,
        "QNT": String(quantity)
    };
    Object.entries(customFields).forEach(([key, val]) => {
        params[key] = val;
    });
    return dhruApiRequest("placeserverorder", params);
}
async function getImeiOrder(orderId) {
    return dhruApiRequest("getimeiorder", {
        ID: orderId
    });
}
