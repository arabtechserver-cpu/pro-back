const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { EventEmitter } = require('node:events');
const dns = require('node:dns');
const https = require('node:https');
const cron = require('node-cron');
const { promisify } = require('node:util');

process.env.JWT_SECRET = 'provider-order-errors-test-secret-123456789';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
delete process.env.TELEGRAM_BOT_TOKEN;

// Both API clients capture dns.lookup on import. No test uses the network.
const originalLookup = dns.lookup;
dns.lookup = (_host, callback) => callback(null, '8.8.8.8', 4);
dns.lookup[promisify.custom] = async () => ({ address: '8.8.8.8', family: 4 });
const dhru = require('./dist/utils/dhru-api');
const providers = require('./dist/routes/providers');
dns.lookup = originalLookup;
const { prisma } = require('./dist/utils/prisma');
after(async () => { await prisma.$disconnect(); });

test('both provider clients verify TLS even when STRICT_PROVIDER_SSL is false or unset', async () => {
  const originalRequest = https.request;
  const originalStrict = process.env.STRICT_PROVIDER_SSL;
  const originalLog = console.error;
  const requests = [];
  https.request = options => {
    requests.push(options);
    const request = new EventEmitter();
    request.write = () => {};
    request.end = () => queueMicrotask(() => request.emit('error', Object.assign(
      new Error("Hostname/IP does not match certificate's altnames"),
      { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }
    )));
    return request;
  };
  console.error = () => {};
  try {
    for (const strict of [undefined, 'false', 'true']) {
      if (strict === undefined) delete process.env.STRICT_PROVIDER_SSL;
      else process.env.STRICT_PROVIDER_SSL = strict;
      const response = await dhru.getImeiOrder('479408', {
        apiUrl: 'https://provider.example/api/v1', username: 'test', apiKey: 'test'
      });
      assert.equal(response.SUCCESS, false);
      assert.equal(response.transportError, true);
      assert.match(response.error, /Correct the HTTPS certificate\/DNS for provider.example/);
      const adminResponse = await providers.makeProviderApiCall(
        'https://provider.example/api/v1', 'test', 'test', 'accountinfo'
      );
      assert.equal(adminResponse.ok, false);
      assert.match(adminResponse.data.error, /Correct the HTTPS certificate\/DNS for provider.example/);
    }
    assert.equal(requests.length, 6);
    for (const options of requests) {
      assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.servername, 'provider.example');
      assert.equal(options.headers.Host, 'provider.example');
      assert.equal(options.hostname, '8.8.8.8');
    }
  } finally {
    https.request = originalRequest;
    console.error = originalLog;
    if (originalStrict === undefined) delete process.env.STRICT_PROVIDER_SSL;
    else process.env.STRICT_PROVIDER_SSL = originalStrict;
  }
});

test('order validation accepts combined custom fields above 500 characters without truncation', () => {
  const { createOrderSchema } = require('./dist/schemas/order.schema');
  const { validateBody } = require('./dist/middleware/validate');
  const target = `custom_LockCode: ${'X'.repeat(600)} | custom_Email: user@example.test`;
  const req = { body: { serviceId: 'service', serviceName: 'Service', targetInput: target } };
  let nextCalled = false;
  validateBody(createOrderSchema)(req, { status() { throw new Error('valid input was rejected'); } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.body.targetInput, target);
  assert.equal(createOrderSchema.safeParse({ ...req.body, targetInput: 'X'.repeat(10000) }).success, true);
  assert.equal(createOrderSchema.safeParse({ ...req.body, targetInput: 'X'.repeat(10001) }).success, false);
});

test('instant order validation succeeds when service requires no inputs and customFields is null', () => {
  const { createOrderSchema } = require('./dist/schemas/order.schema');
  const { validateBody } = require('./dist/middleware/validate');
  const instantOrderBody = {
    serviceId: '731',
    serviceName: 'Google play Account (Gmail + Password)',
    targetInput: 'طلب فوري',
    rawImei: '',
    quantity: 1,
    notes: '',
    couponCode: null,
    customFields: null
  };
  let nextCalled = false;
  const req = { body: instantOrderBody };
  validateBody(createOrderSchema)(req, { status() { throw new Error('valid instant order was rejected'); } }, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.body.serviceId, '731');
  assert.equal(req.body.customFields, null);
});

test('cron reports connection failures once and keeps failed checks and status 1 orders processing', async () => {
  const originalSchedule = cron.default.schedule;
  const originalFind = prisma.order.findMany;
  const originalService = prisma.dhruService.findFirst;
  const originalUpdate = prisma.order.update;
  const originalTransaction = prisma.$transaction;
  const originalImei = dhru.getImeiOrder;
  const originalServer = dhru.getServerOrder;
  const originalWarn = console.warn;
  const originalLog = console.log;
  let tick;
  const warnings = [], logs = [];
  cron.default.schedule = (_expression, callback) => { tick = callback; return {}; };
  prisma.order.findMany = async () => [{
    id: 'order-4b41ae', apiOrderId: '479408', serviceId: 'service',
    serviceName: 'Service', status: 'processing', notes: '{}'
  }];
  let serviceType = 'imei';
  prisma.dhruService.findFirst = async () => ({
    apiServiceType: serviceType,
    apiProvider: { apiUrl: 'https://provider.example/api/v1', username: 'test', apiKey: 'test' }
  });
  prisma.order.update = async () => { throw new Error('failed/in-progress checks must not change orders'); };
  prisma.$transaction = async () => { throw new Error('failed/in-progress checks must not refund'); };
  console.warn = message => warnings.push(message);
  console.log = message => logs.push(message);
  try {
    require('./dist/cron/orderSync').initOrderSyncCron();
    for (serviceType of ['imei', 'server']) {
      let calls = 0;
      dhru.getImeiOrder = dhru.getServerOrder = async () => {
        calls++;
        return { SUCCESS: false, error: 'TLS certificate mismatch', transportError: true };
      };
      await tick();
      assert.equal(calls, 1, 'transport failures must not retry the same connection');
      assert.match(warnings.at(-1), /TLS certificate mismatch/);
      assert.match(warnings.at(-1), /Keeping in processing status/);
    }

    dhru.getImeiOrder = dhru.getServerOrder = async () => ({ ERROR: [{ MESSAGE: 'Provider maintenance' }] });
    await tick();
    assert.match(warnings.at(-1), /Provider maintenance/);

    dhru.getImeiOrder = dhru.getServerOrder = async () => ({ error: 'API unavailable' });
    await tick();
    assert.match(warnings.at(-1), /API unavailable/);

    const warningCount = warnings.length;
    dhru.getImeiOrder = dhru.getServerOrder = async () => ({ SUCCESS: [{ STATUS: 1 }] });
    await tick();
    assert.equal(warnings.length, warningCount);
    assert.match(logs.at(-1), /still in progress \(Provider Status: 1\)/);
  } finally {
    cron.default.schedule = originalSchedule;
    prisma.order.findMany = originalFind;
    prisma.dhruService.findFirst = originalService;
    prisma.order.update = originalUpdate;
    prisma.$transaction = originalTransaction;
    dhru.getImeiOrder = originalImei;
    dhru.getServerOrder = originalServer;
    console.warn = originalWarn;
    console.log = originalLog;
  }
});
