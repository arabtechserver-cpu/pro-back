const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890abcdef1234567890';
process.env.FRONTEND_URL = 'https://arabproserver.com,http://localhost:3000';

const { prisma } = require('./dist/utils/prisma');

function sha256(val) {
  return crypto.createHash('sha256').update(val).digest('hex');
}

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods?.[method.toLowerCase()]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);
  const stack = layer.route.stack.map((s) => s.handle);
  return stack[stack.length - 1];
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set() { return this; },
    setHeader(name, val) {
      this.headers[name.toLowerCase()] = val;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function loadRouter() {
  delete require.cache[require.resolve('./dist/routes/mobileCashier')];
  return require('./dist/routes/mobileCashier').default;
}

test('repair tracking publish, public lookup, quote response, rotate, and revoke', async () => {
  const origDevice = { ...prisma.cashierDevice };
  const origTrack = { ...prisma.cashierRepairTrack };

  const machine = 'a'.repeat(64);
  const proof = 'b'.repeat(64);
  const authHeader = `Bearer Cashier.${machine}.${proof}`;
  const validReq = (body = {}, params = {}) => ({
    get(h) { return h.toLowerCase() === 'authorization' ? authHeader : ''; },
    body,
    params
  });

  let storedTrack = null;

  prisma.cashierDevice.findFirst = async () => ({
    id: 'dev-1',
    shopName: 'Arab Shop',
    email: 'shop@example.test',
    trialEndsAt: new Date(Date.now() + 86_400_000),
    activeKey: null
  });

  prisma.cashierRepairTrack.findUnique = async () => storedTrack;
  prisma.cashierRepairTrack.upsert = async ({ create, update }) => {
    storedTrack = storedTrack
      ? { ...storedTrack, ...update, updatedAt: new Date() }
      : { id: 'track-1', ...create, createdAt: new Date(), updatedAt: new Date(), quoteNote: null, quoteRespondedAt: null, revokedAt: null };
    return storedTrack;
  };
  prisma.cashierRepairTrack.update = async ({ data }) => {
    storedTrack = { ...storedTrack, ...data, updatedAt: new Date() };
    return storedTrack;
  };
  prisma.cashierRepairTrack.findFirst = async ({ where }) => {
    if (!storedTrack || storedTrack.revokedAt !== null) return null;
    if (where.tokenHash && where.tokenHash !== storedTrack.tokenHash) return null;
    return storedTrack;
  };
  prisma.cashierRepairTrack.updateMany = async ({ data }) => {
    if (!storedTrack || storedTrack.revokedAt) return { count: 0 };
    storedTrack = { ...storedTrack, ...data };
    return { count: 1 };
  };

  try {
    const router = loadRouter();
    const publishHandler = getRouteHandler(router, 'POST', '/tracking/publish');
    const getPublicHandler = getRouteHandler(router, 'GET', '/public/track/:token');
    const quoteHandler = getRouteHandler(router, 'POST', '/public/track/:token/quote-response');
    const revokeHandler = getRouteHandler(router, 'POST', '/tracking/revoke');

    // 1. Publish tracking link
    const res1 = makeRes();
    await publishHandler(validReq({
      localRepairId: 'rep-100',
      orderNumber: 'REP-2026-100100',
      shopName: 'Arab Shop',
      shopPhone: '0100000000',
      deviceType: 'PHONE',
      brand: 'Apple',
      model: 'iPhone 14',
      status: 'DIAGNOSING',
      quoteApprovalStatus: 'PENDING',
      estimatedPrice: 1200,
      paidAmount: 200,
      remainingAmount: 1000,
      currency: 'EGP',
      warrantyDays: 30,
      orderCreatedAt: '2026-11-23T17:00:00.000Z',
      timeline: [{ toStatus: 'RECEIVED', createdAt: '2026-11-23T17:00:00.000Z' }],
      rotateToken: true
    }), res1, () => {});

    assert.equal(res1.statusCode, 200);
    assert.equal(res1.body.synced, true);
    assert.ok(res1.body.token);
    assert.equal(res1.body.trackingUrl, `https://arabproserver.com/ar/track/${res1.body.token}`);
    assert.equal(storedTrack.tokenHash, sha256(res1.body.token));
    const token1 = res1.body.token;

    // 2. Public GET returns DTO without internal tokenHash or deviceId
    const pubRes = makeRes();
    await getPublicHandler({ params: { token: token1 } }, pubRes, () => {});
    assert.equal(pubRes.statusCode, 200);
    assert.equal(pubRes.body.orderNumber, 'REP-2026-100100');
    assert.equal(pubRes.body.quoteApprovalStatus, 'PENDING');
    assert.equal(pubRes.body.tokenHash, undefined);
    assert.equal(pubRes.body.deviceId, undefined);

    // 3. Customer approves quote
    const quoteRes = makeRes();
    await quoteHandler({ params: { token: token1 }, body: { decision: 'APPROVED', note: 'Go ahead' } }, quoteRes, () => {});
    assert.equal(quoteRes.statusCode, 200);
    assert.equal(quoteRes.body.quoteApprovalStatus, 'APPROVED');
    assert.equal(quoteRes.body.quoteNote, 'Go ahead');
    assert.ok(quoteRes.body.timeline.some((s) => s.toStatus === 'QUOTE_APPROVED'));

    // 4. Duplicate quote response is rejected with 409
    const dupQuoteRes = makeRes();
    await quoteHandler({ params: { token: token1 }, body: { decision: 'REJECTED' } }, dupQuoteRes, () => {});
    assert.equal(dupQuoteRes.statusCode, 409);

    // 5. Desktop status update without rotateToken preserves customer APPROVED decision
    const res2 = makeRes();
    await publishHandler(validReq({
      localRepairId: 'rep-100',
      orderNumber: 'REP-2026-100100',
      shopName: 'Arab Shop',
      brand: 'Apple',
      model: 'iPhone 14',
      status: 'IN_PROGRESS',
      quoteApprovalStatus: 'PENDING',
      estimatedPrice: 1200,
      paidAmount: 200,
      remainingAmount: 1000,
      currency: 'EGP',
      warrantyDays: 30,
      orderCreatedAt: '2026-11-23T17:00:00.000Z',
      timeline: [{ toStatus: 'IN_PROGRESS', createdAt: '2026-11-23T17:10:00.000Z' }],
      rotateToken: false
    }), res2, () => {});
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.body.quoteApprovalStatus, 'APPROVED');
    assert.equal(res2.body.quoteNote, 'Go ahead');

    // 6. Closed order rejects quote-response with 400
    storedTrack.status = 'DELIVERED';
    storedTrack.quoteApprovalStatus = 'PENDING';
    const closedRes = makeRes();
    await quoteHandler({ params: { token: token1 }, body: { decision: 'APPROVED' } }, closedRes, () => {});
    assert.equal(closedRes.statusCode, 400);

    // 7. Revoke invalidates public GET
    const revRes = makeRes();
    await revokeHandler(validReq({ localRepairId: 'rep-100' }), revRes, () => {});
    assert.equal(revRes.statusCode, 200);
    assert.equal(revRes.body.revoked, true);

    const notFoundRes = makeRes();
    await getPublicHandler({ params: { token: token1 } }, notFoundRes, () => {});
    assert.equal(notFoundRes.statusCode, 404);
  } finally {
    Object.assign(prisma.cashierDevice, origDevice);
    Object.assign(prisma.cashierRepairTrack, origTrack);
  }
});
