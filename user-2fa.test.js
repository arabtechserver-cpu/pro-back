const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const bcrypt = require('bcryptjs');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'user-2fa-test-secret-1234567890abcdef';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/unused';
process.env.DISABLE_TURNSTILE = 'true';

const { prisma } = require('./dist/utils/prisma');
const totp = require('./dist/utils/totp');
const dhruApi = require('./dist/utils/dhru-api');
const usersRouter = require('./dist/routes/users').default;
const authRouter = require('./dist/routes/auth').default;

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find(
    (l) => l.route?.path === routePath && l.route.methods?.[method.toLowerCase()],
  );
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);
  return layer.route.stack[layer.route.stack.length - 1].handle;
}

function makeRes() {
  return {
    statusCode: 200,
    cookies: {},
    body: null,
    cookie(name, value) {
      this.cookies[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('TOTP RFC 6238 generation, AES-256-GCM encryption, SVG QR, and single-use backup codes', async () => {
  const secret = totp.generateTotpSecret();
  assert.match(secret, /^[A-Z2-7]{32}$/);

  const now = 1_795_630_000_000;
  const code = totp.generateTotpCode(secret, now, 0);
  assert.match(code, /^\d{6}$/);
  assert.equal(totp.verifyTotpCode(secret, code, now), true);
  assert.equal(totp.verifyTotpCode(secret, code, now + 30_000), true);
  assert.equal(totp.verifyTotpCode(secret, '000000', now), false);

  const encrypted = totp.encryptTotpSecret(secret);
  assert.notEqual(encrypted, secret);
  assert.equal(totp.decryptTotpSecret(encrypted), secret);

  const uri = totp.buildOtpAuthUri('user@example.com', secret);
  assert.match(uri, /^otpauth:\/\/totp\//);
  const svg = await totp.generateOtpAuthQrSvg(uri);
  assert.match(svg, /<svg/);

  const { plainCodes, hashesJson } = totp.generateBackupCodes('u-1', 8);
  assert.equal(plainCodes.length, 8);
  assert.equal(totp.countRemainingBackupCodes(hashesJson), 8);

  const used = totp.consumeBackupCode('u-1', hashesJson, plainCodes[0]);
  assert.equal(used.matched, true);
  assert.equal(used.remainingCount, 7);

  const reuseAttempt = totp.consumeBackupCode('u-1', used.remainingHashesJson, plainCodes[0]);
  assert.equal(reuseAttempt.matched, false);
});

test('End-to-end user 2FA setup, enable, login enforcement, verify-2fa, and disable', async (t) => {
  const passwordHash = await bcrypt.hash('Password123!', 4);
  const dbUser = {
    id: 'user-2fa-1',
    fullName: 'Arab Tester',
    email: 'tester@example.com',
    username: 'arabtester',
    password: passwordHash,
    phone: null,
    country: 'EG',
    role: 'user',
    status: 'active',
    balance: 25,
    tokenVersion: 1,
    deletedAt: null,
    membershipTierId: null,
    membershipTier: null,
    customDiscount: 0,
    twoFactorEnabled: false,
    twoFactorSecret: null,
    twoFactorBackupCodes: null,
    twoFactorEnabledAt: null,
  };

  const origFindUnique = prisma.user.findUnique;
  const origFindFirst = prisma.user.findFirst;
  const origUpdate = prisma.user.update;

  t.after(() => {
    prisma.user.findUnique = origFindUnique;
    prisma.user.findFirst = origFindFirst;
    prisma.user.update = origUpdate;
  });

  prisma.user.findUnique = async ({ where }) => {
    if (where.id === dbUser.id || where.email === dbUser.email) return { ...dbUser };
    return null;
  };
  prisma.user.findFirst = async () => ({ ...dbUser });
  prisma.user.update = async ({ data }) => {
    if (data.tokenVersion?.increment) {
      dbUser.tokenVersion += data.tokenVersion.increment;
    }
    const cleanData = { ...data };
    delete cleanData.tokenVersion;
    Object.assign(dbUser, cleanData);
    return { ...dbUser };
  };

  // 1. Setup 2FA
  const setupHandler = getRouteHandler(usersRouter, 'POST', '/2fa/setup');
  const setupRes = makeRes();
  await setupHandler({ user: { id: dbUser.id } }, setupRes);
  assert.equal(setupRes.statusCode, 200);
  assert.equal(setupRes.body.success, true);
  assert.match(setupRes.body.qrSvg, /<svg/);

  // 2. Enable 2FA with live TOTP code
  const enableHandler = getRouteHandler(usersRouter, 'POST', '/2fa/enable');
  const liveCode = totp.generateTotpCode(setupRes.body.secret);
  const enableRes = makeRes();
  await enableHandler({ user: { id: dbUser.id }, body: { code: liveCode } }, enableRes);
  assert.equal(enableRes.statusCode, 200);
  assert.equal(enableRes.body.success, true);
  assert.equal(enableRes.body.backupCodes.length, 8);
  assert.equal(dbUser.twoFactorEnabled, true);

  // 3. Password login must pause and require 2FA challenge instead of issuing JWT
  const loginHandler = getRouteHandler(authRouter, 'POST', '/login');
  const loginRes = makeRes();
  await loginHandler({ body: { email: dbUser.email, password: 'Password123!' }, headers: {} }, loginRes);
  assert.equal(loginRes.statusCode, 200);
  assert.equal(loginRes.body.require2fa, true);
  assert.ok(loginRes.body.challengeToken);
  assert.equal(loginRes.body.token, undefined);

  // 4. Verify 2FA with TOTP code issues JWT + user session
  const verifyHandler = getRouteHandler(authRouter, 'POST', '/verify-2fa');
  const verifyRes = makeRes();
  await verifyHandler(
    { body: { challengeToken: loginRes.body.challengeToken, code: totp.generateTotpCode(setupRes.body.secret) } },
    verifyRes,
  );
  assert.equal(verifyRes.statusCode, 200);
  assert.equal(verifyRes.body.success, true);
  assert.ok(verifyRes.body.token);

  // 5. Login again and verify using a single-use backup code
  const loginRes2 = makeRes();
  await loginHandler({ body: { email: dbUser.email, password: 'Password123!' }, headers: {} }, loginRes2);
  const backupVerifyRes = makeRes();
  await verifyHandler(
    { body: { challengeToken: loginRes2.body.challengeToken, code: enableRes.body.backupCodes[0] } },
    backupVerifyRes,
  );
  assert.equal(backupVerifyRes.statusCode, 200);
  assert.ok(backupVerifyRes.body.token);
  assert.equal(totp.countRemainingBackupCodes(dbUser.twoFactorBackupCodes), 7);

  // 6. Disable 2FA cleanly
  const disableHandler = getRouteHandler(usersRouter, 'POST', '/2fa/disable');
  const disableRes = makeRes();
  await disableHandler(
    { user: { id: dbUser.id }, body: { code: enableRes.body.backupCodes[1] } },
    disableRes,
  );
  assert.equal(disableRes.statusCode, 200);
  assert.equal(dbUser.twoFactorEnabled, false);
  assert.equal(dbUser.twoFactorSecret, null);
});

test('o2oooo3o DHRU 6.1 Unsupported action fallback sends placeserverorder -> placeimeiorder with Email and ECID', async (t) => {
  assert.equal(
    dhruApi.isActionUnsupported({ ERROR: [{ MESSAGE: 'Unsupported action: placeserverorder' }] }),
    true,
  );

  const actions = [];
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    let body = '';
    req.write = (chunk) => { body += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || ''); };
    req.destroy = () => {};
    req.end = () => {
      const form = new URLSearchParams(body);
      const action = form.get('action');
      actions.push({ action, customfield: form.get('CUSTOMFIELD'), ecid: form.get('ECID'), email: form.get('Email') });

      const payload =
        action === 'placeserverorder'
          ? { ERROR: [{ MESSAGE: 'Unsupported action: placeserverorder' }] }
          : { SUCCESS: [{ REFERENCEID: 'O2O-ORDER-777', MESSAGE: 'Order received' }] };

      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
      callback(res);
      res.emit('data', JSON.stringify(payload));
      res.emit('end');
    };
    return req;
  });

  const res = await dhruApi.placeServerOrder(
    '10',
    1,
    { Email: 'buyer@example.com', ECID: '0x1A2B3C4D5E' },
    '',
    {
      apiUrl: 'https://license.o2oooo3o.com/',
      username: 'ARABTECHSERVERPRO',
      apiKey: 'a8baa31c85c78e21b8f8282f7e1d6bcb3b9b123cfbdb7bbb',
    },
  );

  assert.deepEqual(actions.map((a) => a.action), ['placeserverorder', 'placeimeiorder']);
  assert.equal(res.SUCCESS[0].REFERENCEID, 'O2O-ORDER-777');
  const decodedCustom = JSON.parse(Buffer.from(actions[1].customfield, 'base64').toString('utf8'));
  assert.equal(decodedCustom.Email, 'buyer@example.com');
  assert.equal(decodedCustom.ECID, '0x1A2B3C4D5E');
});
