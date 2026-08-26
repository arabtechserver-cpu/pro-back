import { DHRU_USERNAME, DHRU_API_KEY, DHRU_API_URL } from './utils/dhru-api';

async function testDhru(action: string, params: any) {
    const data = new URLSearchParams({
        username: DHRU_USERNAME,
        key: DHRU_API_KEY,
        action: action,
        ...params
    });

    const response = await fetch(DHRU_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: data
    });
    console.log(`\n--- Action: ${action} ---`);
    console.log("Params:", JSON.stringify(params));
    console.log("Result:", await response.json());
}

async function run() {
    const realServiceId = "1477000001"; // iCloud service (usually IMEI)
    
    // 1. placeserverorder with SERVICEID
    await testDhru("placeserverorder", {
        "SERVICEID": realServiceId,
        "QNT": "1"
    });
}
run();
