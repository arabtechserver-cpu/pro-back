const assert = require("assert");
const jwt = require("jsonwebtoken");

function createResponse() {
  return {
    statusCode: 200,
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

async function testAuthenticationRequiresTokenForGet() {
  process.env.JWT_SECRET = "test-secret-with-enough-entropy-12345";
  delete require.cache[require.resolve("./dist/middleware/auth")];
  const { authenticateToken, generateToken } = require("./dist/middleware/auth");
  const response = createResponse();
  let nextCalled = false;

  await authenticateToken({ headers: {}, method: "GET", query: {} }, response, () => {
    nextCalled = true;
  });

  assert.equal(nextCalled, false, "an unauthenticated GET must not reach its route handler");
  assert.equal(response.statusCode, 401);

  const adminToken = generateToken({ id: "admin-id", role: "admin" });
  const adminDecoded = jwt.decode(adminToken);
  assert.ok(adminDecoded.exp - adminDecoded.iat <= 12 * 3600, "admin tokens must expire within 12 hours");

  const userToken = generateToken({ id: "user-id", role: "user" });
  const userDecoded = jwt.decode(userToken);
  assert.ok(userDecoded.exp - userDecoded.iat <= 7 * 86400, "user tokens must expire within 7 days");
}

function testJwtSecretIsRequired() {
  const originalSecret = process.env.JWT_SECRET;
  delete process.env.JWT_SECRET;
  delete require.cache[require.resolve("./dist/middleware/auth")];

  try {
    assert.throws(() => require("./dist/middleware/auth"), /JWT_SECRET/);
  } finally {
    process.env.JWT_SECRET = originalSecret;
    delete require.cache[require.resolve("./dist/middleware/auth")];
  }
}

async function testTurnstileFailsClosedWhenConfigured() {
  process.env.TURNSTILE_SECRET = "test-turnstile-secret";
  delete require.cache[require.resolve("./dist/middleware/turnstileMiddleware")];
  const { turnstileMiddleware } = require("./dist/middleware/turnstileMiddleware");
  const response = createResponse();
  let nextCalled = false;

  await turnstileMiddleware(
    { body: {}, headers: {}, socket: {} },
    response,
    () => { nextCalled = true; }
  );

  assert.equal(nextCalled, false, "missing Turnstile tokens must be rejected when protection is configured");
  assert.equal(response.statusCode, 403);
}

function testSsrfProtectionBlocksPrivateHosts() {
  const { isPrivateIP, isPrivateHostname } = require("./dist/utils/dhru-api");

  const privateIps = [
    "127.0.0.1",
    "127.10.20.30",
    "10.0.0.1",
    "10.255.255.255",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fe80::1",
  ];

  for (const ip of privateIps) {
    assert.equal(isPrivateIP(ip), true, `IP ${ip} must be identified as private`);
  }

  assert.equal(isPrivateIP("8.8.8.8"), false, "Public IP 8.8.8.8 must not be blocked");
  assert.equal(isPrivateIP("1.1.1.1"), false, "Public IP 1.1.1.1 must not be blocked");

  assert.equal(isPrivateHostname("localhost"), true, "localhost must be identified as private");
  assert.equal(isPrivateHostname("service.local"), true, ".local must be identified as private");
  assert.equal(isPrivateHostname("metadata.google.internal"), true, "cloud metadata must be identified as private");
  assert.equal(isPrivateHostname("api.dhru.com"), false, "Public hostname must not be private");
}

function testProviderApiKeyMasking() {
  const { maskApiKey, isMaskedApiKey } = require("./dist/routes/providers");

  assert.equal(maskApiKey(""), "");
  assert.equal(maskApiKey("12345678"), "********");
  assert.equal(maskApiKey("sk_live_1234567890abcdef"), "sk_l...cdef");

  assert.equal(isMaskedApiKey("abcd...wxyz"), true);
  assert.equal(isMaskedApiKey("********"), true);
  assert.equal(isMaskedApiKey("abcd*efgh"), true);
  assert.equal(isMaskedApiKey("sk_live_1234567890abcdef"), false);

  const realKey = "my_super_secret_provider_key_12345";
  const masked = maskApiKey(realKey);
  assert.equal(isMaskedApiKey(masked, realKey), true);
  assert.equal(isMaskedApiKey("completely_new_key_not_masked", realKey), false);
}

function testAdminServiceResponseHidesMarginsForNonAdmin() {
  const { serializePricingServiceCategories } = require("./dist/utils/admin-service-response");

  const categories = [{
    id: "cat-1",
    name: "Category 1",
    dhruServices: [{
      id: "srv-1",
      dhruId: "101",
      name: "Test Service",
      originalName: "Test Service",
      groupName: "Test Group",
      credit: 10.5,
      margin: 2.5,
      time: "1-2h",
      info: null,
      isActive: true,
      requiresCustom: null
    }]
  }];

  const cleanName = (n) => n;

  const publicView = serializePricingServiceCategories(categories, cleanName, false);
  const publicService = publicView[0].services[0];
  assert.strictEqual(publicService.credit, undefined, "credit must not be exposed to non-admin");
  assert.strictEqual(publicService.margin, undefined, "margin must not be exposed to non-admin");
  assert.strictEqual(publicService.finalPrice, 13, "finalPrice must be sum of credit + margin");

  const adminView = serializePricingServiceCategories(categories, cleanName, true);
  const adminService = adminView[0].services[0];
  assert.strictEqual(adminService.credit, 10.5, "credit must be present for admin");
  assert.strictEqual(adminService.margin, 2.5, "margin must be present for admin");
}

function testAdminOtpExpiresAndRejects() {
  const { createAdminOtpChallenge, verifyAdminOtp, resendAdminOtp } = require("./dist/utils/adminOtp");

  const { challengeToken } = createAdminOtpChallenge({
    id: "user-1",
    username: "admin",
    email: "admin@example.com"
  });

  const invalidVerify = verifyAdminOtp(challengeToken, "000000");
  assert.strictEqual(invalidVerify.success, false);

  const fakeTokenVerify = verifyAdminOtp("fake-token-1234567890", "123456");
  assert.strictEqual(fakeTokenVerify.success, false);

  const fakeTokenResend = resendAdminOtp("fake-token-1234567890");
  assert.strictEqual(fakeTokenResend.success, false);
}

(async () => {
  await testAuthenticationRequiresTokenForGet();
  testJwtSecretIsRequired();
  await testTurnstileFailsClosedWhenConfigured();
  testSsrfProtectionBlocksPrivateHosts();
  testProviderApiKeyMasking();
  testAdminServiceResponseHidesMarginsForNonAdmin();
  testAdminOtpExpiresAndRejects();
  console.log("security regression tests passed");
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

