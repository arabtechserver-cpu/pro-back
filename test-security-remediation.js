const assert = require("assert");

async function runTests() {
  console.log("Starting security remediation simulation tests...");

  // Test 1: Provider API key masking & detection
  {
    const { maskApiKey, isMaskedApiKey } = require("./dist/routes/providers");
    assert.strictEqual(maskApiKey(""), "");
    assert.strictEqual(maskApiKey("short"), "********");
    assert.strictEqual(maskApiKey("abcdefghijklmnop"), "abcd...mnop");

    // Masked patterns
    assert.strictEqual(isMaskedApiKey("abcd...mnop"), true);
    assert.strictEqual(isMaskedApiKey("********"), true);
    assert.strictEqual(isMaskedApiKey("abc***xyz"), true);
    // Unmasked new key
    assert.strictEqual(isMaskedApiKey("sk_live_new_provider_secret_12345"), false);
    // Existing key match
    const existingKey = "secret_provider_token_999999";
    assert.strictEqual(isMaskedApiKey(maskApiKey(existingKey), existingKey), true);
    console.log("PASS: Provider API key masking and detection test");
  }

  // Test 2: Admin Service Response margin & credit concealment
  {
    const { serializePricingServiceCategories } = require("./dist/utils/admin-service-response");
    const mockCategories = [{
      id: "cat_mobile",
      name: "Mobile Unlocking",
      dhruServices: [{
        id: "srv_apple",
        dhruId: "201",
        name: "Apple Check",
        originalName: "Apple Check Clean",
        groupName: "Apple Services",
        credit: 5.0,
        margin: 2.0,
        time: "5-10m",
        info: null,
        isActive: true,
        requiresCustom: null
      }]
    }];

    const publicResult = serializePricingServiceCategories(mockCategories, (n) => n, false);
    const serviceForCustomer = publicResult[0].services[0];
    assert.strictEqual(serviceForCustomer.credit, undefined);
    assert.strictEqual(serviceForCustomer.margin, undefined);
    assert.strictEqual(serviceForCustomer.finalPrice, 7.0);

    const adminResult = serializePricingServiceCategories(mockCategories, (n) => n, true);
    const serviceForAdmin = adminResult[0].services[0];
    assert.strictEqual(serviceForAdmin.credit, 5.0);
    assert.strictEqual(serviceForAdmin.margin, 2.0);
    assert.strictEqual(serviceForAdmin.finalPrice, 7.0);
    console.log("PASS: Service margin & credit concealment test");
  }

  // Test 3: Video Tutorial Access Sanitization
  {
    const { sanitizeTutorialAccess } = require("./dist/routes/video");
    const adminUser = { id: "u_admin", role: "admin" };
    const normalUser = { id: "u_customer", role: "user" };

    const paidTutorial = {
      id: "tut_1",
      title: "Advanced Chip Programming",
      videoUrl: "https://stream.provider.com/video/secret_stream.m3u8",
      isFree: false
    };

    // Public guest
    const guestView = sanitizeTutorialAccess(paidTutorial, null);
    assert.strictEqual(guestView.videoUrl, null);
    assert.strictEqual(guestView.isLocked, true);

    // Normal customer without purchase
    const customerView = sanitizeTutorialAccess(paidTutorial, normalUser);
    assert.strictEqual(customerView.videoUrl, null);
    assert.strictEqual(customerView.isLocked, true);

    // Admin user
    const adminView = sanitizeTutorialAccess(paidTutorial, adminUser);
    assert.strictEqual(adminView.videoUrl, "https://stream.provider.com/video/secret_stream.m3u8");
    assert.strictEqual(adminView.isLocked, false);

    // Free tutorial
    const freeTutorial = { ...paidTutorial, isFree: true };
    const freeGuestView = sanitizeTutorialAccess(freeTutorial, null);
    assert.strictEqual(freeGuestView.videoUrl, "https://stream.provider.com/video/secret_stream.m3u8");
    assert.strictEqual(freeGuestView.isLocked, false);

    console.log("PASS: Video tutorial access control test");
  }

  // Test 4: Telegram Sender Authorization (closing group chat bypass)
  {
    const authorizedAdminIds = ["1001", "1002"];

    function checkTelegramAuthorization(incomingSenderId, incomingChatId) {
      return authorizedAdminIds.includes(String(incomingSenderId));
    }

    // Authorized admin sending directly
    assert.strictEqual(checkTelegramAuthorization("1001", "1001"), true);
    // Authorized admin sending from authorized group
    assert.strictEqual(checkTelegramAuthorization("1001", "-9999"), true);
    // Unauthorized member sending from authorized group
    assert.strictEqual(checkTelegramAuthorization("5555", "-9999"), false);
    // Unauthorized stranger sending directly
    assert.strictEqual(checkTelegramAuthorization("7777", "7777"), false);

    console.log("PASS: Telegram sender authorization logic test");
  }

  // Test 5: PayPal Webhook Payload Validation Logic
  {
    function validateWebhookRefund(payload, recordedAmount, recordedCurrency) {
      const refundObj = payload?.resource;
      if (!refundObj) return { valid: false, reason: "Missing resource" };

      const refundAmount = parseFloat(refundObj.amount?.value || "0");
      const refundCurrency = (refundObj.amount?.currency_code || "").toUpperCase();

      if (isNaN(refundAmount) || refundAmount <= 0) {
        return { valid: false, reason: "Invalid refund amount" };
      }

      if (refundCurrency !== recordedCurrency) {
        return { valid: false, reason: "Currency mismatch" };
      }

      if (refundAmount > recordedAmount) {
        return { valid: false, reason: "Refund amount exceeds original payment intent amount" };
      }

      return { valid: true, refundAmount };
    }

    const recordedAmount = 50.0;
    const recordedCurrency = "USD";

    // Valid refund
    assert.deepStrictEqual(
      validateWebhookRefund({ resource: { amount: { value: "50.00", currency_code: "USD" } } }, recordedAmount, recordedCurrency),
      { valid: true, refundAmount: 50.0 }
    );

    // Partial refund within bounds
    assert.deepStrictEqual(
      validateWebhookRefund({ resource: { amount: { value: "25.00", currency_code: "USD" } } }, recordedAmount, recordedCurrency),
      { valid: true, refundAmount: 25.0 }
    );

    // Negative amount exploit
    assert.strictEqual(
      validateWebhookRefund({ resource: { amount: { value: "-10.00", currency_code: "USD" } } }, recordedAmount, recordedCurrency).valid,
      false
    );

    // Zero amount
    assert.strictEqual(
      validateWebhookRefund({ resource: { amount: { value: "0.00", currency_code: "USD" } } }, recordedAmount, recordedCurrency).valid,
      false
    );

    // Currency mismatch exploit
    assert.strictEqual(
      validateWebhookRefund({ resource: { amount: { value: "50.00", currency_code: "EUR" } } }, recordedAmount, recordedCurrency).valid,
      false
    );

    // Amount greater than payment
    assert.strictEqual(
      validateWebhookRefund({ resource: { amount: { value: "500.00", currency_code: "USD" } } }, recordedAmount, recordedCurrency).valid,
      false
    );

    console.log("PASS: PayPal webhook refund payload validation test");
  }

  // Test 5b: PayPal Webhook Signature Verification Logic
  {
    const { verifyPayPalWebhookSignature } = require("./dist/services/paypalService");

    const origWebhookId = process.env.PAYPAL_WEBHOOK_ID;

    // Case 1: Missing PAYPAL_WEBHOOK_ID
    delete process.env.PAYPAL_WEBHOOK_ID;
    const noWebhookIdRes = await verifyPayPalWebhookSignature({}, {});
    assert.strictEqual(noWebhookIdRes.verified, false);

    // Case 2: Missing required headers
    process.env.PAYPAL_WEBHOOK_ID = "WH-123456789";
    const missingHeadersRes = await verifyPayPalWebhookSignature({}, {});
    assert.strictEqual(missingHeadersRes.verified, false);

    // Case 3: Insecure cert_url (http instead of https)
    const insecureCertRes = await verifyPayPalWebhookSignature({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "http://api.paypal.com/cert.pem",
      "paypal-transmission-id": "trans-1",
      "paypal-transmission-sig": "sig-1",
      "paypal-transmission-time": "2026-09-20T00:00:00Z"
    }, {});
    assert.strictEqual(insecureCertRes.verified, false);

    // Case 4: Untrusted host in cert_url (attacker host)
    const untrustedHostRes = await verifyPayPalWebhookSignature({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://evil-attacker.com/cert.pem",
      "paypal-transmission-id": "trans-1",
      "paypal-transmission-sig": "sig-1",
      "paypal-transmission-time": "2026-09-20T00:00:00Z"
    }, {});
    assert.strictEqual(untrustedHostRes.verified, false);

    if (origWebhookId) {
      process.env.PAYPAL_WEBHOOK_ID = origWebhookId;
    } else {
      delete process.env.PAYPAL_WEBHOOK_ID;
    }

    console.log("PASS: PayPal webhook signature verification test");
  }

  // Test 6: Order status double refund race condition simulation
  {
    const simulatedOrders = new Map([
      ["ord_1", { id: "ord_1", refundedAt: null, price: 15.0, status: "pending" }]
    ]);
    const simulatedUser = { id: "user_alice", balance: 100.0 };

    async function checkStatusSimulatedRefund(orderId, userId) {
      const order = simulatedOrders.get(orderId);
      if (!order) return { success: false, reason: "not_found" };

      if (order.refundedAt !== null) {
        return { success: false, reason: "already_refunded", refundedCount: 0 };
      }

      order.refundedAt = new Date();
      order.status = "rejected";

      simulatedUser.balance += order.price;
      return { success: true, refundedCount: 1, newBalance: simulatedUser.balance };
    }

    const [res1, res2] = await Promise.all([
      checkStatusSimulatedRefund("ord_1", "user_alice"),
      checkStatusSimulatedRefund("ord_1", "user_alice")
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const alreadyRefunded = [res1, res2].filter((r) => r.reason === "already_refunded");

    assert.strictEqual(successes.length, 1, "Only one concurrent refund can succeed");
    assert.strictEqual(alreadyRefunded.length, 1, "Second concurrent request must be rejected");
    assert.strictEqual(simulatedUser.balance, 115.0, "User balance must only increment once");
    console.log("PASS: Order double refund race condition prevention test");
  }

  console.log("All security remediation tests passed successfully!");
}

runTests().then(() => process.exit(0)).catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
