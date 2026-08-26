import { prisma } from './server';
import { placeImeiOrder, getImeiOrder } from './utils/dhru-api';

async function testFullFlow() {
    console.log("=== Starting Order Flow Test ===");

    // 1. Get user
    const user = await prisma.user.findFirst();
    if (!user) {
        console.log("No user found.");
        return;
    }
    console.log(`Using user: ${user.email} (Balance: ${user.balance})`);

    // 2. Add some balance to make sure they can buy
    await prisma.user.update({
        where: { id: user.id },
        data: { balance: { increment: 100 } }
    });
    console.log("Added $100 balance for testing.");

    // 3. Get a service (let's use an IMEI service if possible)
    const dhruService = await prisma.dhruService.findFirst({
        where: { category: { name: "IMEI Service" } }
    });
    
    if (!dhruService) {
        console.log("No IMEI service found.");
        return;
    }
    console.log(`Testing with service: ${dhruService.name} (Dhru ID: ${dhruService.dhruId})`);

    // 4. Place order to Dhru API
    const targetImei = "359999999999999";
    console.log(`Placing order on Dhru API with IMEI: ${targetImei}...`);
    
    const dhruResponse = await placeImeiOrder(dhruService.dhruId, targetImei);
    console.log("Dhru Response:", JSON.stringify(dhruResponse, null, 2));

    if (!dhruResponse || dhruResponse.ERROR) {
        console.log("Dhru API rejected the order. Test stops here.");
        return;
    }

    const apiOrderId = dhruResponse.SUCCESS?.[0]?.REFERENCEID;
    console.log(`Order placed successfully on Dhru! API Order ID: ${apiOrderId}`);

    // 5. Save to DB
    const order = await prisma.order.create({
        data: {
            userId: user.id,
            serviceId: dhruService.dhruId,
            serviceName: dhruService.name,
            targetInput: targetImei,
            quantity: 1,
            price: dhruService.credit,
            status: 'processing',
            apiOrderId: String(apiOrderId)
        }
    });
    console.log(`Order saved to SQLite with ID: ${order.id}`);

    // 6. Test the Cron Job sync logic
    console.log("Simulating Cron Job check...");
    const checkRes = await getImeiOrder(String(apiOrderId));
    console.log("Check Response:", JSON.stringify(checkRes, null, 2));

    if (checkRes && checkRes.SUCCESS) {
        const statusData = checkRes.SUCCESS[0];
        console.log(`Current API Status: ${statusData.STATUS}, Code/Reply: ${statusData.CODE}`);
    }

    console.log("=== Test Complete ===");
}

testFullFlow()
    .catch(console.error)
    .finally(() => prisma.$disconnect());
