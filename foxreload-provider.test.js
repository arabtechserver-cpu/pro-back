const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'foxreload-provider-test-secret-123456';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/unused';

const { prisma } = require('./dist/utils/prisma');
const providersRouter = require('./dist/routes/providers').default;
const providersModule = require('./dist/routes/providers');

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
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
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

test('FoxReload provider detection and URL normalization preserve native FoxReload base URL', () => {
  assert.equal(providersModule.isFoxreloadUrl('https://public-api.foxreload.com'), true);
  assert.equal(providersModule.isFoxreloadUrl('https://public-api.foxreload.com/api/index.php'), true);
  assert.equal(providersModule.isFoxreloadUrl('https://dhru-server.example.com'), false);
  assert.equal(
    providersModule.normalizeFoxreloadApiUrl('https://public-api.foxreload.com/api/index.php'),
    'https://public-api.foxreload.com',
  );
  assert.equal(
    providersModule.isFoxreloadProvider({ id: 'foxreload-provider', type: 'dhru', apiUrl: '' }),
    true,
  );
  assert.equal(
    providersModule.isFoxreloadProvider({ id: 'custom-1', type: 'foxreload', apiUrl: 'https://example.com' }),
    true,
  );
});

test('POST /:id/balance falls back to provider.apiKey when settings and env keys are absent', async (t) => {
  const origSettingFind = prisma.setting.findUnique;
  const origProviderFind = prisma.apiProvider.findUnique;
  const origProviderUpdate = prisma.apiProvider.update;
  const origEnvKey = process.env.FOXRELOAD_API_KEY;
  delete process.env.FOXRELOAD_API_KEY;

  t.after(() => {
    prisma.setting.findUnique = origSettingFind;
    prisma.apiProvider.findUnique = origProviderFind;
    prisma.apiProvider.update = origProviderUpdate;
    if (origEnvKey !== undefined) process.env.FOXRELOAD_API_KEY = origEnvKey;
  });

  prisma.setting.findUnique = async () => null;
  prisma.apiProvider.findUnique = async () => ({
    id: 'foxreload-provider',
    name: 'FoxReload',
    type: 'foxreload',
    currency: 'USD',
    apiUrl: 'https://public-api.foxreload.com',
    apiKey: 'provider-saved-key-123',
  });
  prisma.apiProvider.update = async (args) => ({ id: 'foxreload-provider', ...args.data });

  t.mock.method(https, 'request', (options, callback) => {
    assert.equal(options.headers['X-API-Key'], 'provider-saved-key-123');
    const req = new EventEmitter();
    req.end = () => {
      const payload = options.path.endsWith('/balances/')
        ? { items: [{ currency: 'USD', available: '42.50' }] }
        : { email: 'fox@example.com', isActive: true };
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
      callback(res);
      res.emit('data', JSON.stringify(payload));
      res.emit('end');
    };
    return req;
  });

  const handler = getRouteHandler(providersRouter, 'POST', '/:id/balance');
  const res = makeRes();
  await handler({ params: { id: 'foxreload-provider' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.balance, 42.5);
  assert.equal(res.body.currency, 'USD');
});

test('POST /test-connection and PUT /:id support FoxReload natively without appending /api/index.php', async (t) => {
  const origSettingFind = prisma.setting.findUnique;
  const origSettingUpsert = prisma.setting.upsert;
  const origProviderFind = prisma.apiProvider.findUnique;
  const origProviderUpdate = prisma.apiProvider.update;
  const origProviderUpdateMany = prisma.apiProvider.updateMany;

  let upsertPayload = null;
  let updatedProviderData = null;

  t.after(() => {
    prisma.setting.findUnique = origSettingFind;
    prisma.setting.upsert = origSettingUpsert;
    prisma.apiProvider.findUnique = origProviderFind;
    prisma.apiProvider.update = origProviderUpdate;
    prisma.apiProvider.updateMany = origProviderUpdateMany;
  });

  prisma.setting.findUnique = async () => null;
  prisma.setting.upsert = async (args) => {
    upsertPayload = JSON.parse(args.create.value);
    return args.create;
  };
  prisma.apiProvider.findUnique = async () => ({
    id: 'foxreload-provider',
    name: 'FoxReload',
    apiUrl: 'https://public-api.foxreload.com/api/index.php',
    username: null,
    apiKey: 'old-key-123456',
    type: 'foxreload',
    isActive: true,
    balance: 10,
    currency: 'USD',
    mappingRules: null,
  });
  prisma.apiProvider.update = async (args) => {
    updatedProviderData = args.data;
    return { id: 'foxreload-provider', ...args.data };
  };
  prisma.apiProvider.updateMany = async () => ({ count: 1 });

  t.mock.method(https, 'request', (options, callback) => {
    assert.equal(options.hostname, 'public-api.foxreload.com');
    assert.equal(options.headers['X-API-Key'], 'new-fox-key-999');
    const req = new EventEmitter();
    req.end = () => {
      const payload = options.path.endsWith('/balances/')
        ? [{ currency: 'USD', available: '99.10' }]
        : { email: 'owner@foxreload.com', isActive: true };
      const res = Object.assign(new EventEmitter(), { statusCode: 200, headers: {} });
      callback(res);
      res.emit('data', JSON.stringify(payload));
      res.emit('end');
    };
    return req;
  });

  const testConnHandler = getRouteHandler(providersRouter, 'POST', '/test-connection');
  const testRes = makeRes();
  await testConnHandler(
    {
      body: {
        apiUrl: 'https://public-api.foxreload.com',
        apiKey: 'new-fox-key-999',
        type: 'foxreload',
      },
    },
    testRes,
  );
  assert.equal(testRes.statusCode, 200);
  assert.equal(testRes.body.success, true);
  assert.equal(testRes.body.balance, 99.1);

  const putHandler = getRouteHandler(providersRouter, 'PUT', '/:id');
  const putRes = makeRes();
  await putHandler(
    {
      params: { id: 'foxreload-provider' },
      body: {
        name: 'FoxReload',
        apiUrl: 'https://public-api.foxreload.com/api/index.php',
        apiKey: 'new-fox-key-999',
        type: 'foxreload',
        isActive: true,
      },
    },
    putRes,
  );
  assert.equal(putRes.statusCode, 200);
  assert.equal(updatedProviderData.apiUrl, 'https://public-api.foxreload.com');
  assert.equal(updatedProviderData.type, 'foxreload');
  assert.equal(upsertPayload.apiKey, 'new-fox-key-999');
});

test('GET /:id/services and POST /:id/toggle-all handle foxreload-provider without querying DhruService', async (t) => {
  const origProviderFind = prisma.apiProvider.findUnique;
  const origProviderUpdate = prisma.apiProvider.update;
  const origProviderUpdateMany = prisma.apiProvider.updateMany;
  const origSettingFind = prisma.setting.findUnique;
  const origSettingUpsert = prisma.setting.upsert;
  const origDhruCount = prisma.dhruService.count;

  let dhruQueried = false;
  let savedSettings = null;

  t.after(() => {
    prisma.apiProvider.findUnique = origProviderFind;
    prisma.apiProvider.update = origProviderUpdate;
    prisma.apiProvider.updateMany = origProviderUpdateMany;
    prisma.setting.findUnique = origSettingFind;
    prisma.setting.upsert = origSettingUpsert;
    prisma.dhruService.count = origDhruCount;
  });

  prisma.dhruService.count = async () => {
    dhruQueried = true;
    return 999;
  };
  prisma.apiProvider.findUnique = async () => ({
    id: 'foxreload-provider',
    name: 'FoxReload',
    type: 'foxreload',
    apiUrl: 'https://public-api.foxreload.com',
    servicesCount: 1,
    isActive: true,
  });
  prisma.apiProvider.update = async (args) => ({ id: 'foxreload-provider', ...args.data });
  prisma.apiProvider.updateMany = async () => ({ count: 1 });
  prisma.setting.findUnique = async ({ where }) => {
    if (where.key === 'foxreload_settings') {
      return { value: JSON.stringify({ apiKey: 'fox-k', isEnabled: true, defaultProfitMarginPercent: 10, hiddenItems: [] }) };
    }
    if (where.key === 'foxreload_catalog') {
      return {
        value: JSON.stringify({
          isSynced: true,
          sections: {
            topups: {
              nameAr: 'شحن الألعاب',
              bundles: [{ id: 'b-pubg', slug: 'pubg', name: 'PUBG Mobile', bestOfferPrice: '0.99', regions: [] }],
            },
          },
        }),
      };
    }
    return null;
  };
  prisma.setting.upsert = async (args) => {
    savedSettings = JSON.parse(args.create.value);
    return args.create;
  };

  const servicesHandler = getRouteHandler(providersRouter, 'GET', '/:id/services');
  const srvRes = makeRes();
  await servicesHandler({ params: { id: 'foxreload-provider' }, query: {} }, srvRes);
  assert.equal(srvRes.statusCode, 200);
  assert.equal(dhruQueried, false);
  assert.equal(srvRes.body.success, true);
  assert.equal(srvRes.body.services.length >= 1, true);

  const toggleAllHandler = getRouteHandler(providersRouter, 'POST', '/:id/toggle-all');
  const togRes = makeRes();
  await toggleAllHandler({ params: { id: 'foxreload-provider' }, body: { isActive: false } }, togRes);
  assert.equal(togRes.statusCode, 200);
  assert.equal(savedSettings.isEnabled, false);
});
