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
