const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'cashier-license-security-test-secret-123456';

const { prisma } = require('./dist/utils/prisma');
const {
  signCashierEntitlement,
  verifyCashierEntitlement,
  getCashierSigningKeyInfo,
} = require('./dist/utils/cashier-license-signer');
const mobileCashierRouter = require('./dist/routes/mobileCashier').default;

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
    headers: {},
    body: null,
    set() {
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

test('Ed25519 entitlement signing verifies valid payloads and rejects tampering', () => {
  const machine = 'a'.repeat(64);
  const nonce = 'b'.repeat(48);
  const until = new Date(Date.now() + 86_400_000).toISOString();
  const signed = signCashierEntitlement({
    machine,
    status: 'ACTIVE',
    until,
    shopName: 'Arab Tech Shop',
    email: 'owner@example.com',
    nonce,
  });

  const { publicKeyPem, keyId } = getCashierSigningKeyInfo();
  assert.equal(signed.keyId, keyId);
  assert.equal(signed.nonce, nonce);
  assert.equal(signed.leaseSeconds, 30);

  assert.equal(
    verifyCashierEntitlement({ machine, ...signed }, publicKeyPem),
    true,
  );

  // Tamper status, until, machine, or nonce
  assert.equal(
    verifyCashierEntitlement({ machine, ...signed, status: 'TRIAL' }, publicKeyPem),
    false,
  );
  assert.equal(
    verifyCashierEntitlement({ machine, ...signed, until: new Date(Date.now() + 999_999_999).toISOString() }, publicKeyPem),
    false,
  );
  assert.equal(
    verifyCashierEntitlement({ machine: 'c'.repeat(64), ...signed }, publicKeyPem),
    false,
  );
  assert.equal(
    verifyCashierEntitlement({ machine, ...signed, nonce: 'd'.repeat(48) }, publicKeyPem),
    false,
  );
});

test('POST /enroll blocks repeated free trials on the same email and GET /entitlement returns signed proof', async (t) => {
  const origTx = prisma.$transaction;
  const origDeviceFindFirst = prisma.cashierDevice.findFirst;
  const origDeviceUpdate = prisma.cashierDevice.update;

  t.after(() => {
    prisma.$transaction = origTx;
    prisma.cashierDevice.findFirst = origDeviceFindFirst;
    prisma.cashierDevice.update = origDeviceUpdate;
  });

  const machine = crypto.randomBytes(32).toString('hex');
  const proof = crypto.randomBytes(32).toString('hex');
  const nonce = crypto.randomBytes(24).toString('hex');

  // 1. Block second free trial for already-used email on a new machine
  prisma.$transaction = async (fn) => {
    const tx = {
      cashierDevice: {
        findUnique: async () => null,
        findFirst: async () => ({ id: 'existing-device-id' }),
        create: async () => {
          throw new Error('Should not create second trial device');
        },
      },
      cashierLicense: { findUnique: async () => null },
    };
    return fn(tx);
  };

  const enrollHandler = getRouteHandler(mobileCashierRouter, 'POST', '/enroll');
  const enrollRes = makeRes();
  await enrollHandler(
    {
      body: { machine, proof, shopName: 'Second Shop', email: 'used@example.com' },
      get: (h) => (h.toLowerCase() === 'x-cashier-nonce' ? nonce : undefined),
    },
    enrollRes,
    () => {},
  );
  assert.equal(enrollRes.statusCode, 409);
  assert.equal(enrollRes.body.code, 'TRIAL_ALREADY_USED');

  // 2. GET /entitlement returns signed payload bound to machine + nonce
  const futureExpiry = new Date(Date.now() + 5 * 86_400_000);
  prisma.cashierDevice.findFirst = async () => ({
    id: 'dev-1',
    shopName: 'Verified Shop',
    email: 'verified@example.com',
    trialEndsAt: null,
    lastSeenAt: new Date(),
    activeKey: {
      expiresAt: futureExpiry,
      revokedAt: null,
    },
  });
  prisma.cashierDevice.update = async () => ({});

  const entitlementHandler = getRouteHandler(mobileCashierRouter, 'GET', '/entitlement');
  const entRes = makeRes();
  await entitlementHandler(
    {
      get: (h) => {
        const k = h.toLowerCase();
        if (k === 'authorization') return `Bearer Cashier.${machine}.${proof}`;
        if (k === 'x-cashier-nonce') return nonce;
        return undefined;
      },
    },
    entRes,
    () => {},
  );

  assert.equal(entRes.statusCode, 200);
  assert.equal(entRes.body.status, 'ACTIVE');
  assert.equal(entRes.body.nonce, nonce);
  assert.ok(entRes.body.signature);

  const { publicKeyPem } = getCashierSigningKeyInfo();
  assert.equal(
    verifyCashierEntitlement({ machine, ...entRes.body }, publicKeyPem),
    true,
  );
});
