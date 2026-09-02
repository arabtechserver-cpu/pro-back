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

  const token = generateToken({ id: "user-id" });
  const decoded = jwt.decode(token);
  assert.ok(decoded.exp - decoded.iat <= 60 * 60, "access tokens must expire within one hour");
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

(async () => {
  await testAuthenticationRequiresTokenForGet();
  testJwtSecretIsRequired();
  await testTurnstileFailsClosedWhenConfigured();
  console.log("security regression tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
