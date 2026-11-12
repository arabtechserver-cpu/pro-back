const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const axios = require('axios');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'reliability-fixes-test-secret-123456';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/unused';
process.env.PAYPAL_CLIENT_ID = 'test-client-id';
process.env.PAYPAL_CLIENT_SECRET = 'test-client-secret';
process.env.PAYPAL_MODE = 'sandbox';
delete process.env.TELEGRAM_BOT_TOKEN;

const { prisma } = require('./dist/utils/prisma');
const { roundCurrency } = require('./dist/utils/currency');
const {
  resolvePrimaryFrontendUrl,
  isValidTelegramButtonUrl,
  sanitizeTelegramReplyMarkup
} = require('./dist/utils/telegram-config');
const {
  isMarkupRejectedError,
  computePollingBackoffMs
} = require('./dist/utils/telegramService');
const { classifyDhruDispatchError } = require('./dist/services/orderDispatchService');
const { computeFoxreloadRetryCooldownMs } = require('./dist/services/foxreloadService');
const { createPayPalOrder } = require('./dist/services/paypalService');
const { PayPalGatewayError } = require('./dist/utils/paypalError');
const jwt = require('jsonwebtoken');
const {
  USER_IDLE_TIMEOUT_MS,
  isUserSessionIdleExpired,
  shouldTouchUserActivity
} = require('./dist/utils/userSessionPolicy');
const { authenticateToken } = require('./dist/middleware/auth');

after(async () => {
  await prisma.$disconnect();
});

test('roundCurrency eliminates binary floating-point drift on debits and credits', () => {
  assert.equal(roundCurrency(0.220000000000002), 0.22);
  assert.equal(roundCurrency(7.489999999999998), 7.49);
  assert.equal(roundCurrency(22.96 - 5.83), 17.13);
  assert.equal(roundCurrency(0.1 + 0.2), 0.3);
  assert.equal(roundCurrency(1.005, 2), 1.01);
  assert.equal(roundCurrency('not-a-number'), 0);
});

test('Telegram config resolves a single public frontend URL and strips invalid inline buttons', () => {
  assert.equal(
    resolvePrimaryFrontendUrl('http://localhost:3000, https://borai.store, https://www.borai.store'),
    'https://borai.store'
  );
  assert.equal(
    resolvePrimaryFrontendUrl('https://arabtechproserver.tech/ , https://borai.store'),
    'https://arabtechproserver.tech'
  );
  assert.equal(isValidTelegramButtonUrl('https://borai.store/admin/transactions'), true);
  assert.equal(isValidTelegramButtonUrl('mailto:user@example.com'), false);
  assert.equal(isValidTelegramButtonUrl('https://borai.store,https://www.borai.store/test'), false);
  assert.equal(isValidTelegramButtonUrl('http://127.0.0.1:3000/test'), false);

  const sanitized = sanitizeTelegramReplyMarkup({
    inline_keyboard: [
      [
        { text: 'Email User', url: 'mailto:user@example.com' },
        { text: 'Broken Multi URL', url: 'https://borai.store,https://www.borai.store/admin' }
      ],
      [
        { text: 'Approve', callback_data: 'approve_tx_123' },
        { text: 'Open Admin', url: 'https://borai.store/admin' }
      ]
    ]
  });
  assert.deepEqual(sanitized, {
    inline_keyboard: [
      [
        { text: 'Approve', callback_data: 'approve_tx_123' },
        { text: 'Open Admin', url: 'https://borai.store/admin' }
      ]
    ]
  });
  assert.equal(
    sanitizeTelegramReplyMarkup({ inline_keyboard: [[{ text: 'Bad', url: 'mailto:a@b.com' }]] }),
    undefined
  );
});

test('Telegram markup error detector and polling backoff handle 429, 409 and network retries', () => {
  assert.equal(
    isMarkupRejectedError({ response: { data: { description: 'Bad Request: wrong port number specified in the URL' } } }),
    true
  );
  assert.equal(
    isMarkupRejectedError({ response: { data: { description: 'Bad Request: BUTTON_URL_INVALID' } } }),
    true
  );
  assert.equal(isMarkupRejectedError({ message: 'socket hang up' }), false);

  assert.equal(computePollingBackoffMs(1, 429, 45), 45000);
  assert.equal(computePollingBackoffMs(1, 429, 1), 5000);
  assert.equal(computePollingBackoffMs(1, 429, 999), 120000);
  assert.equal(computePollingBackoffMs(1, 409), 10000);
  assert.equal(computePollingBackoffMs(3, 409), 20000);
  assert.equal(computePollingBackoffMs(1, 502), 5000);
  assert.equal(computePollingBackoffMs(4, 502), 40000);
});

test('classifyDhruDispatchError classifies ValidationError Out of Stock cleanly without double prefix', () => {
  const outOfStock = classifyDhruDispatchError(
    {
      ERROR: [
        {
          MESSAGE: 'ValidationError123  Out of Stock please try after sometime',
          FULL_DESCRIPTION: '  Out of Stock please try after sometime'
        }
      ]
    },
    '',
    'DHRU Main',
    '16016'
  );
  assert.equal(outOfStock.category, 'out_of_stock');
  assert.equal(outOfStock.isCreditError, false);
  assert.equal(outOfStock.userFacingMsg.includes('فشل الإرسال: فشل الإرسال:'), false);
  assert.equal(outOfStock.userFacingMsg.includes('الضغط على زر التعديل'), false);
  assert.equal(outOfStock.userFacingMsg.includes('Out of Stock please try after sometime'), true);

  const missingField = classifyDhruDispatchError(
    { ERROR: [{ MESSAGE: 'ValidationError IMEI is required' }] },
    '',
    'DHRU Main',
    '100'
  );
  assert.equal(missingField.category, 'imei');
  assert.equal(missingField.title.includes('فشل الإرسال:'), true);
  assert.equal(missingField.userFacingMsg.includes('فشل الإرسال: فشل الإرسال:'), false);

  const customFieldErr = classifyDhruDispatchError(
    { ERROR: [{ MESSAGE: 'ValidationError Missing required custom field Player ID' }] },
    'طلب فوري',
    'DHRU Main',
    '100'
  );
  assert.equal(customFieldErr.category, 'fields');
  assert.equal(customFieldErr.userFacingMsg.includes('الضغط على زر التعديل'), true);
  assert.equal(customFieldErr.userFacingMsg.includes('فشل الإرسال: فشل الإرسال:'), false);

  const lowBalance = classifyDhruDispatchError(
    { ERROR: [{ MESSAGE: 'Not enough credit on your account' }] },
    '123456789012345',
    'DHRU Main',
    '200'
  );
  assert.equal(lowBalance.category, 'credit');
  assert.equal(lowBalance.isCreditError, true);
});

test('FoxReload cooldown backs off 15m on WAF 403, 5m on 429 and escalates transient errors', () => {
  assert.equal(computeFoxreloadRetryCooldownMs(403, 1), 15 * 60 * 1000);
  assert.equal(computeFoxreloadRetryCooldownMs(429, 1), 5 * 60 * 1000);
  assert.equal(computeFoxreloadRetryCooldownMs(502, 1), 2 * 60 * 1000);
  assert.equal(computeFoxreloadRetryCooldownMs(504, 2), 4 * 60 * 1000);
  assert.equal(computeFoxreloadRetryCooldownMs(500, 3), 8 * 60 * 1000);
  assert.equal(computeFoxreloadRetryCooldownMs(500, 6), 8 * 60 * 1000);
});

test('createPayPalOrder converts upstream gateway failures into typed PayPalGatewayError instead of 500 Error', async () => {
  const originalAdapter = axios.defaults.adapter;
  const originalErr = console.error;
  console.error = () => {};
  let calls = 0;
  axios.defaults.adapter = async (config) => {
    calls++;
    if (String(config.url).includes('/oauth2/token')) {
      return {
        data: { access_token: 'mock-access-token' },
        status: 200,
        statusText: 'OK',
        headers: {},
        config
      };
    }
    const err = new Error('Unprocessable Entity');
    err.response = {
      status: 422,
      data: {
        details: [{ description: 'The requested action could not be performed for this entity.' }]
      }
    };
    throw err;
  };
  try {
    await assert.rejects(
      createPayPalOrder(10, 'https://borai.store/wallet?paypal=success', 'https://borai.store/wallet?paypal=cancel'),
      err => err instanceof PayPalGatewayError && err.code === 'PAYPAL_REJECTED' && err.status === 422
    );
    assert.equal(calls, 2);
  } finally {
    axios.defaults.adapter = originalAdapter;
    console.error = originalErr;
  }
});

test('userSessionPolicy enforces 30m idle timeout for regular users and exempts admins', () => {
  const now = 1_780_000_000_000;
  assert.equal(USER_IDLE_TIMEOUT_MS, 30 * 60 * 1000);
  assert.equal(isUserSessionIdleExpired('user', new Date(now - 30 * 60 * 1000), undefined, now), true);
  assert.equal(isUserSessionIdleExpired('user', new Date(now - (30 * 60 * 1000 - 1)), undefined, now), false);
  assert.equal(isUserSessionIdleExpired('user', null, Math.floor((now - 31 * 60 * 1000) / 1000), now), true);
  assert.equal(isUserSessionIdleExpired('admin', new Date(now - 45 * 60 * 1000), undefined, now), false);
  assert.equal(isUserSessionIdleExpired('super_admin', new Date(now - 45 * 60 * 1000), undefined, now), false);

  assert.equal(shouldTouchUserActivity('admin', new Date(now - 120 * 1000), undefined, false, now), false);
  assert.equal(shouldTouchUserActivity('user', new Date(now - 120 * 1000), undefined, true, now), false);
  assert.equal(shouldTouchUserActivity('user', new Date(now - 30 * 1000), undefined, false, now), false);
  assert.equal(shouldTouchUserActivity('user', new Date(now - 60 * 1000), undefined, false, now), true);
});

test('authenticateToken rejects regular users idle >= 30m with SESSION_IDLE_EXPIRED and skips passive poll touch', async () => {
  const origFindUnique = prisma.user.findUnique;
  const origUpdate = prisma.user.update;
  let updateCalls = 0;
  let mockUser = null;

  prisma.user.findUnique = async () => mockUser;
  prisma.user.update = async ({ data }) => {
    updateCalls++;
    if (mockUser && data?.lastActivityAt) mockUser.lastActivityAt = data.lastActivityAt;
    return mockUser;
  };

  const makeMockRes = () => {
    const headers = {};
    const cleared = [];
    const res = {
      statusCode: 200,
      body: null,
      headers,
      cleared,
      setHeader(k, v) { headers[k] = v; },
      clearCookie(name, opts) { cleared.push({ name, opts }); },
      status(code) { res.statusCode = code; return res; },
      json(payload) { res.body = payload; return res; }
    };
    return res;
  };

  try {
    const userToken = jwt.sign({ id: 'u-idle', email: 'idle@example.com', role: 'user', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '7d' });

    mockUser = { id: 'u-idle', role: 'user', status: 'active', tokenVersion: 1, lastActivityAt: new Date(Date.now() - 31 * 60 * 1000) };
    let nextCalled = false;
    const expiredRes = makeMockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${userToken}` }, originalUrl: '/api/users/profile' }, expiredRes, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(expiredRes.statusCode, 401);
    assert.equal(expiredRes.body?.code, 'SESSION_IDLE_EXPIRED');
    assert.equal(expiredRes.cleared.some(c => c.name === 'user_token'), true);
    assert.equal(updateCalls, 0);

    mockUser = { id: 'u-idle', role: 'user', status: 'active', tokenVersion: 1, lastActivityAt: new Date(Date.now() - 5 * 60 * 1000) };
    nextCalled = false;
    const passiveRes = makeMockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${userToken}`, 'x-passive-poll': 'true' }, originalUrl: '/api/wallet/binance/check-order' }, passiveRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(updateCalls, 0);

    nextCalled = false;
    const activeRes = makeMockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${userToken}` }, originalUrl: '/api/orders' }, activeRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(updateCalls, 1);

    const adminToken = jwt.sign({ id: 'a-1', email: 'admin@example.com', role: 'admin', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '12h' });
    mockUser = { id: 'a-1', role: 'admin', status: 'active', tokenVersion: 1, lastActivityAt: new Date(Date.now() - 45 * 60 * 1000) };
    nextCalled = false;
    const adminRes = makeMockRes();
    await authenticateToken({ headers: { authorization: `Bearer ${adminToken}` }, originalUrl: '/api/orders' }, adminRes, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(adminRes.statusCode, 200);
    assert.equal(updateCalls, 1);
  } finally {
    prisma.user.findUnique = origFindUnique;
    prisma.user.update = origUpdate;
  }
});
