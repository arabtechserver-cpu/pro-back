const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const axios = require('axios');

process.env.JWT_SECRET = 'isolated-paypal-config-test-secret';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.NODE_ENV = 'test';
const { getPayPalConfig, getPublicPayPalConfig } = require('./dist/utils/paypalConfig');
const { getPayPalAccessToken, createPayPalOrder } = require('./dist/services/paypalService');
const { prisma } = require('./dist/utils/prisma');
const paypalRouter = require('./dist/routes/paypal').default;
const currenciesRouter = require('./dist/routes/currencies').default;
const { PayPalGatewayError } = require('./dist/utils/paypalError');
const { checkPayPalCredentials } = require('./dist/scripts/checkPayPal');
const jwt = require('jsonwebtoken');
after(async () => { await prisma.$disconnect(); });

test('public endpoints use the REST merchant configuration and never expose its secret', async () => {
  process.env.PAYPAL_CLIENT_ID = ' runtime-merchant-id ';
  process.env.PAYPAL_CLIENT_SECRET = ' private-server-secret ';
  const originalFind = prisma.setting.findUnique;
  prisma.setting.findUnique = async () => ({ value: JSON.stringify({ paypal: { clientId: 'stale-database-id', isActive: true } }) });
  const app = express();
  app.use('/paypal', paypalRouter);
  app.use('/currencies', currenciesRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/paypal/client-id`);
    const publicConfig = await response.json();
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(publicConfig, { success: true, clientId: 'runtime-merchant-id', configured: true });
    const currencies = await (await fetch(`${base}/currencies`)).json();
    assert.equal(currencies.config.paypal.clientId, publicConfig.clientId);
    assert.equal(JSON.stringify(currencies).includes('private-server-secret'), false);

    // Configuration can change after module import; both endpoints must follow it.
    process.env.PAYPAL_CLIENT_ID = 'new-runtime-id';
    assert.equal((await (await fetch(`${base}/paypal/client-id`)).json()).clientId, 'new-runtime-id');
    process.env.PAYPAL_CLIENT_SECRET = '   ';
    assert.deepEqual(await (await fetch(`${base}/paypal/client-id`)).json(), { success: true, clientId: '', configured: false });
  } finally {
    prisma.setting.findUnique = originalFind;
    await new Promise(resolve => server.close(resolve));
  }
});

test('OAuth and order creation use the same trimmed runtime credentials and environment', async () => {
  process.env.PAYPAL_CLIENT_ID = ' sandbox-merchant ';
  process.env.PAYPAL_CLIENT_SECRET = ' sandbox-secret ';
  process.env.PAYPAL_MODE = 'sandbox';
  const originalAdapter = axios.defaults.adapter;
  const requests = [];
  axios.defaults.adapter = async config => {
    requests.push(config);
    return { status: 200, statusText: 'OK', headers: {}, config, data: config.url.endsWith('/token')
      ? { access_token: 'test-access-token' }
      : { id: 'test-order', links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/checkoutnow?token=test-order' }] } };
  };
  try {
    const result = await createPayPalOrder(10, 'https://example.com/success', 'https://example.com/cancel');
    assert.equal(result.orderId, 'test-order');
    assert.equal(requests[0].url, 'https://api-m.sandbox.paypal.com/v1/oauth2/token');
    assert.equal(requests[0].headers.Authorization, `Basic ${Buffer.from('sandbox-merchant:sandbox-secret').toString('base64')}`);
    assert.equal(requests[1].url, 'https://api-m.sandbox.paypal.com/v2/checkout/orders');
    assert.equal(requests[1].headers.Authorization, 'Bearer test-access-token');
    assert.equal(JSON.parse(requests[1].data).purchase_units[0].amount.value, '10.00');
    assert.equal(getPublicPayPalConfig().clientId, 'sandbox-merchant');
    process.env.PAYPAL_CLIENT_SECRET = '';
    await assert.rejects(getPayPalAccessToken, /PAYPAL_CLIENT_SECRET/);
    assert.equal(requests.length, 2, 'missing credentials must not send an OAuth request');
    delete process.env.PAYPAL_CLIENT_ID;
    process.env.PAYPAL_CLIENT_SECRET = 'fallback-secret';
    assert.equal(getPayPalConfig().clientId, getPublicPayPalConfig().clientId);
    assert.ok(getPublicPayPalConfig().clientId);
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
});

test('quoted credentials and uppercase LIVE mode authenticate against live, while invalid modes never silently use sandbox', async () => {
  process.env.PAYPAL_CLIENT_ID = ' "quoted-client" ';
  process.env.PAYPAL_CLIENT_SECRET = " 'quoted-secret' ";
  process.env.PAYPAL_MODE = ' "LIVE" ';
  const originalAdapter = axios.defaults.adapter;
  let calls = 0;
  axios.defaults.adapter = async config => {
    calls++;
    assert.equal(config.url, 'https://api-m.paypal.com/v1/oauth2/token');
    assert.equal(config.headers.Authorization, `Basic ${Buffer.from('quoted-client:quoted-secret').toString('base64')}`);
    assert.equal(config.timeout, 10000);
    return { status: 200, statusText: 'OK', headers: {}, config, data: { access_token: 'private-access-token' } };
  };
  try {
    const check = await checkPayPalCredentials();
    assert.equal(check.success, true);
    assert.equal(check.mode, 'live');
    assert.equal(check.clientIdLength, 'quoted-client'.length);
    assert.equal(JSON.stringify(check).includes('quoted-secret'), false);
    assert.equal(JSON.stringify(check).includes('private-access-token'), false);
    process.env.PAYPAL_MODE = 'production-typo';
    assert.equal(getPublicPayPalConfig().configured, false);
    await assert.rejects(getPayPalAccessToken, error => error instanceof PayPalGatewayError && error.code === 'PAYPAL_INVALID_MODE');
    assert.equal(calls, 1);
  } finally {
    axios.defaults.adapter = originalAdapter;
  }
});

test('PayPal invalid_client becomes a safe 503 for create/capture before any payment intent write', async () => {
  process.env.PAYPAL_CLIENT_ID = 'auth-failure-client';
  process.env.PAYPAL_CLIENT_SECRET = 'do-not-log-this-secret';
  process.env.PAYPAL_MODE = 'live';
  const originalAdapter = axios.defaults.adapter;
  const originalUser = prisma.user.findUnique;
  const originalIntent = prisma.paymentIntent.create;
  const originalFindIntent = prisma.paymentIntent.findUnique;
  const originalError = console.error;
  const logs = [];
  let intentWrites = 0;
  let requests = 0;
  console.error = (...args) => logs.push(JSON.stringify(args));
  axios.defaults.adapter = async config => {
    requests++;
    assert.ok(config.url.endsWith('/v1/oauth2/token'), 'no order may be created after authentication fails');
    throw Object.assign(new Error('raw-provider-message-do-not-leak'), {
      config,
      response: { status: 401, data: { error: 'invalid_client', error_description: 'raw-provider-message-do-not-leak' } }
    });
  };
  prisma.user.findUnique = async () => ({ id: 'paypal-test-user', role: 'user', status: 'active', tokenVersion: 1 });
  prisma.paymentIntent.create = async () => { intentWrites++; throw new Error('must not create an intent'); };
  prisma.paymentIntent.findUnique = async () => ({ id: 'test-intent', userId: 'paypal-test-user', orderId: 'fixture-order', amount: 10, currency: 'USD', status: 'created' });
  const app = express();
  app.use(express.json());
  app.use('/paypal', paypalRouter);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    await assert.rejects(() => createPayPalOrder(10, 'https://example.com/success', 'https://example.com/cancel'), error =>
      error instanceof PayPalGatewayError && error.code === 'PAYPAL_AUTH_FAILED' && error.status === 503);
    const token = jwt.sign({ id: 'paypal-test-user', tokenVersion: 1 }, process.env.JWT_SECRET);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/paypal/create-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ amount: 10 })
    });
    assert.equal(response.status, 503);
    const data = await response.json();
    assert.equal(data.success, false);
    assert.equal(data.code, 'PAYPAL_AUTH_FAILED');
    assert.equal(intentWrites, 0);
    const capture = await fetch(`http://127.0.0.1:${server.address().port}/paypal/capture-order`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ orderId: 'fixture-order' })
    });
    assert.equal(capture.status, 503);
    const captureData = await capture.json();
    assert.equal(captureData.code, 'PAYPAL_AUTH_FAILED');
    const check = await checkPayPalCredentials();
    assert.equal(check.success, false);
    assert.equal(check.code, 'PAYPAL_AUTH_FAILED');
    assert.equal(requests, 4);
    const output = logs.join('\n') + JSON.stringify(data) + JSON.stringify(captureData) + JSON.stringify(check);
    for (const sensitive of ['do-not-log-this-secret', 'raw-provider-message-do-not-leak', 'Authorization', Buffer.from('auth-failure-client:do-not-log-this-secret').toString('base64')]) {
      assert.equal(output.includes(sensitive), false, `must not expose ${sensitive}`);
    }
  } finally {
    console.error = originalError;
    axios.defaults.adapter = originalAdapter;
    prisma.user.findUnique = originalUser;
    prisma.paymentIntent.create = originalIntent;
    prisma.paymentIntent.findUnique = originalFindIntent;
    await new Promise(resolve => server.close(resolve));
  }
});

test('OAuth timeouts and malformed success responses are classified without a false success', async () => {
  process.env.PAYPAL_CLIENT_ID = 'test-client';
  process.env.PAYPAL_CLIENT_SECRET = 'test-secret';
  process.env.PAYPAL_MODE = 'live';
  const originalAdapter = axios.defaults.adapter;
  const originalError = console.error;
  console.error = () => {};
  try {
    axios.defaults.adapter = async () => { throw Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }); };
    await assert.rejects(getPayPalAccessToken, error => error.code === 'PAYPAL_TIMEOUT' && error.status === 504);
    axios.defaults.adapter = async config => ({ status: 200, statusText: 'OK', headers: {}, config, data: {} });
    await assert.rejects(getPayPalAccessToken, error => error.code === 'PAYPAL_INVALID_RESPONSE' && error.status === 502);
  } finally {
    console.error = originalError;
    axios.defaults.adapter = originalAdapter;
  }
});
