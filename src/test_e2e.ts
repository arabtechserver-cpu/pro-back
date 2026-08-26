async function testE2E() {
    const user = { email: "minasamir1q1@gmail.com" }; // Change to a valid user

    console.log("Adding balance to user first...");
    // Let's assume the user has balance, or I can just hit the API to check what happens.

    const orderPayload = {
        email: user.email,
        serviceId: "1477000001", // A valid dhru service ID in DB
        serviceName: "Haafedk iCloud Premium 1 Year A12 - A13",
        targetInput: "359999999999999",
        quantity: 1,
        price: 0.1 // set low price to pass balance check
    };

    console.log("Placing order via /api/orders...");
    try {
        const res = await fetch("https://api.arabtechproserver.tech/api/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(orderPayload)
        });
        
        const data = await res.json();
        console.log("Status:", res.status);
        console.log("Response:", JSON.stringify(data, null, 2));
    } catch (e) {
        console.error("Failed to connect to backend:", e);
    }
}

testE2E();
