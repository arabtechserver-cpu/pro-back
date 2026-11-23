const test = require('node:test');
const assert = require('node:assert/strict');

const origNodeEnv = process.env.NODE_ENV;
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890abcdef1234567890';
process.env.DISABLE_TURNSTILE = 'true';
process.env.NODE_ENV = 'development';

const { prisma } = require('./dist/utils/prisma');
const email = require('./dist/utils/emailService');

function getRouteHandlers(router, path) {
  const layer = router.stack.find((l) => l.route?.path === path);
  if (!layer) throw new Error(`Route not found: ${path}`);
  return layer.route.stack.map((s) => s.handle);
}

async function runMiddlewareChain(handlers, req, res) {
  let idx = 0;
  async function next() {
    const fn = handlers[idx++];
    if (!fn) return;
    let nextCalled = false;
    await fn(req, res, () => {
      nextCalled = true;
    });
    if (nextCalled) await next();
  }
  await next();
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    cookies: [],
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    cookie(name, val) {
      this.cookies.push({ name, val });
      return this;
    }
  };
}

test('registration requires a valid registration OTP, rejects wrong purpose/code, and prevents replay', async () => {
  const oldSendOtp = email.sendOtpEmailViaLoops;
  const oldWelcome = email.sendWelcomeRegistrationEmail;
  const oldFindUnique = prisma.user.findUnique;
  const oldCreate = prisma.user.create;

  const delivered = [];
  let createdUsers = 0;

  email.sendOtpEmailViaLoops = async (to, payload) => {
    delivered.push({ to, code: payload.code, actionLabel: payload.actionLabel });
    return true;
  };
  email.sendWelcomeRegistrationEmail = async () => true;
  prisma.user.findUnique = async () => null;
  prisma.user.create = async ({ data }) => {
    createdUsers++;
    return { id: `user-${createdUsers}`, ...data };
  };

  delete require.cache[require.resolve('./dist/routes/auth')];
  const authRouter = require('./dist/routes/auth').default;
  const sendOtpHandlers = getRouteHandlers(authRouter, '/send-otp');
  const registerHandlers = getRouteHandlers(authRouter, '/register');

  try {
    // 1. Registering without OTP must fail validation (400)
    const noOtpRes = makeRes();
    await runMiddlewareChain(
      registerHandlers,
      {
        body: {
          fullName: 'Test User',
          email: 'new-client@example.test',
          username: 'newclient1',
          password: 'StrongPassword123!'
        }
      },
      noOtpRes
    );
    assert.equal(noOtpRes.statusCode, 400);
    assert.equal(createdUsers, 0);

    // 2. Request a registration OTP
    const sendRes = makeRes();
    await runMiddlewareChain(
      sendOtpHandlers,
      { body: { email: 'new-client@example.test', username: 'newclient1', type: 'registration' } },
      sendRes
    );
    assert.equal(sendRes.body.success, true);
    assert.equal(delivered.length, 1);
    const validOtp = delivered[0].code;
    assert.match(validOtp, /^\d{6}$/);

    // 3. Wrong OTP must be rejected
    const wrongOtpRes = makeRes();
    await runMiddlewareChain(
      registerHandlers,
      {
        body: {
          fullName: 'Test User',
          email: 'new-client@example.test',
          username: 'newclient1',
          password: 'StrongPassword123!',
          otp: '000000'
        }
      },
      wrongOtpRes
    );
    assert.equal(wrongOtpRes.body.success, false);
    assert.equal(createdUsers, 0);

    // 4. Valid registration OTP succeeds once
    const okRes = makeRes();
    await runMiddlewareChain(
      registerHandlers,
      {
        body: {
          fullName: 'Test User',
          email: 'new-client@example.test',
          username: 'newclient1',
          password: 'StrongPassword123!',
          otp: validOtp
        }
      },
      okRes
    );
    assert.equal(okRes.body.success, true);
    assert.equal(createdUsers, 1);

    // 5. Replaying the same OTP must fail
    const replayRes = makeRes();
    await runMiddlewareChain(
      registerHandlers,
      {
        body: {
          fullName: 'Test User',
          email: 'new-client@example.test',
          username: 'newclient1',
          password: 'StrongPassword123!',
          otp: validOtp
        }
      },
      replayRes
    );
    assert.equal(replayRes.body.success, false);
    assert.equal(createdUsers, 1);
  } finally {
    email.sendOtpEmailViaLoops = oldSendOtp;
    email.sendWelcomeRegistrationEmail = oldWelcome;
    prisma.user.findUnique = oldFindUnique;
    prisma.user.create = oldCreate;
    if (origNodeEnv !== undefined) process.env.NODE_ENV = origNodeEnv;
    else delete process.env.NODE_ENV;
  }
});

test('email templates escape injected HTML and deliver via Brevo API transport when configured', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const origRequest = https.request;
  const origBrevoApiKey = process.env.BREVO_API_KEY;
  const origResendKey = process.env.RESEND_API_KEY;
  let capturedPayload = null;

  process.env.BREVO_API_KEY = 'xkeysib-test-brevo-api-key';
  delete process.env.RESEND_API_KEY;

  https.request = (options, callback) => {
    const req = new EventEmitter();
    req.setTimeout = () => {};
    req.write = (chunk) => {
      capturedPayload = JSON.parse(chunk.toString());
    };
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 201;
      callback(res);
      res.emit('data', '{"messageId":"<test@brevo>"}');
      res.emit('end');
    };
    return req;
  };

  try {
    const ok = await email.sendOrderStatusUpdateEmail('client@example.test', {
      orderId: 'ABC123',
      serviceName: '<script>alert(1)</script> iPhone Unlock',
      targetInput: '356938035643809',
      status: 'completed',
      reply: '<b>CODE-999</b>',
      username: 'Ali <img src=x onerror=alert(1)>'
    });
    assert.equal(ok, true);
    assert.ok(capturedPayload);
    assert.equal(capturedPayload.to[0].email, 'client@example.test');
    assert.ok(!capturedPayload.htmlContent.includes('<script>alert(1)</script>'));
    assert.ok(capturedPayload.htmlContent.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!capturedPayload.htmlContent.includes('<img src=x'));
  } finally {
    https.request = origRequest;
    if (origBrevoApiKey !== undefined) process.env.BREVO_API_KEY = origBrevoApiKey;
    else delete process.env.BREVO_API_KEY;
    if (origResendKey !== undefined) process.env.RESEND_API_KEY = origResendKey;
  }
});
