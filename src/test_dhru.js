"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const dhru_api_1 = require("./utils/dhru-api");
async function testDhru(action, params) {
    const data = new URLSearchParams({
        username: dhru_api_1.DHRU_USERNAME,
        key: dhru_api_1.DHRU_API_KEY,
        action: action,
        ...params
    });
    const response = await fetch(dhru_api_1.DHRU_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: data
    });
    console.log("Result for", action, params, ":", await response.json());
}
async function run() {
    await testDhru("placeimeiorder", {
        "SERVICEID": "1",
        "IMEI": "123456789012345"
    });
    await testDhru("placeserverorder", {
        "SERVICEID": "1",
        "QNT": "1"
    });
}
run();
