const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const https = require('node:https');
const dns = require('node:dns');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'dhru-fusion-pro-test-secret-123456';
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://test:test@127.0.0.1:1/unused';
process.env.FRONTEND_URL = 'https://arabproserver.com';

const { prisma } = require('./dist/utils/prisma');
const fusionPro = require('./dist/utils/dhru-fusion-pro');
const dhruApi = require('./dist/utils/dhru-api');
const providersRouter = require('./dist/routes/providers').default;

const SAMPLE_JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcmFiIiwiY2lkIjoyfQ.signaturetokenvalue123';

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

function mockHttpsAndDns(t, handler) {
  t.mock.method(dns.promises, 'lookup', async () => ({ address: '93.184.216.34', family: 4 }));
  t.mock.method(https, 'request', (options, callback) => {
    const req = new EventEmitter();
    let rawBody = '';
    req.write = (chunk) => {
      rawBody += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    };
    req.destroy = () => {};
    req.end = () => {
      const responseSpec = handler(options, rawBody);
      const res = Object.assign(new EventEmitter(), {
        statusCode: responseSpec.statusCode || 200,
        headers: responseSpec.headers || {},
      });
      callback(res);
      res.emit('data', typeof responseSpec.body === 'string' ? responseSpec.body : JSON.stringify(responseSpec.body));
      res.emit('end');
    };
    return req;
  });
}

test('Dhru Fusion Pro detection and HTTPS URL normalization handle GsmGenesis and JWT tokens', () => {
  assert.equal(fusionPro.isJwtAccessToken(SAMPLE_JWT), true);
  assert.equal(fusionPro.isJwtAccessToken('short-legacy-key'), false);

  assert.equal(
    fusionPro.normalizeDhruFusionProUrl('https://api.gsmgenesis.com'),
    'https://api.gsmgenesis.com/api/reseller/v1',
  );
  assert.equal(
    fusionPro.normalizeDhruFusionProUrl('https://api.gsmgenesis.com/api/reseller/v1/'),
    'https://api.gsmgenesis.com/api/reseller/v1',
  );
  assert.equal(
    fusionPro.normalizeDhruFusionProUrl('https://api.gsmgenesis.com/api/index.php'),
    'https://api.gsmgenesis.com/api/reseller/v1',
  );
  assert.throws(() => fusionPro.normalizeDhruFusionProUrl('http://api.gsmgenesis.com'), /HTTPS/);

  assert.equal(
    fusionPro.isDhruFusionProProvider({ type: 'dhru', apiUrl: 'https://api.gsmgenesis.com', apiKey: SAMPLE_JWT }),
    true,
  );
  assert.equal(
    fusionPro.isDhruFusionProProvider({ type: 'dhru_fusion_pro', apiUrl: 'https://panel.example.com', apiKey: 'abc' }),
    true,
  );
  assert.equal(
    fusionPro.isDhruFusionProProvider({ id: 'foxreload-provider', type: 'foxreload', apiUrl: 'https://public-api.foxreload.com', apiKey: SAMPLE_JWT }),
    false,
  );
});

test('Providers test-connection, create, and balance refresh work natively with Dhru Fusion Pro Bearer auth', async (t) => {
  const origProviderFindUnique = prisma.apiProvider.findUnique;
  const origProviderCreate = prisma.apiProvider.create;
  const origProviderUpdate = prisma.apiProvider.update;

  t.after(() => {
    prisma.apiProvider.findUnique = origProviderFindUnique;
    prisma.apiProvider.create = origProviderCreate;
    prisma.apiProvider.update = origProviderUpdate;
  });

  let createdData = null;
  let updatedBalance = null;
  prisma.apiProvider.findUnique = async () => ({
    id: 'prov-gsmgenesis',
    name: 'GsmGenesis',
    apiUrl: 'https://api.gsmgenesis.com/api/reseller/v1',
    username: null,
    apiKey: SAMPLE_JWT,
    type: 'dhru_fusion_pro',
    isActive: true,
    balance: 0,
    currency: 'USD',
  });
  prisma.apiProvider.create = async (args) => {
    createdData = args.data;
    return { id: 'prov-gsmgenesis', ...args.data };
  };
  prisma.apiProvider.update = async (args) => {
    updatedBalance = args.data;
    return { id: 'prov-gsmgenesis', name: 'GsmGenesis', ...args.data };
  };

  mockHttpsAndDns(t, (options) => {
    assert.equal(options.headers.Host, 'api.gsmgenesis.com');
    assert.equal(options.headers.Authorization, `Bearer ${SAMPLE_JWT}`);
    assert.equal(options.path, '/api/reseller/v1/account');
    return {
      statusCode: 200,
      body: {
        status: 'success',
        code: 200,
        data: {
          currency: 'USD',
          balance: '154.75',
          name: 'Arab',
          email: 'hassanisotoo@gmail.com',
        },
      },
    };
  });

  const testConnHandler = getRouteHandler(providersRouter, 'POST', '/test-connection');
  const testRes = makeRes();
  await testConnHandler(
    { body: { apiUrl: 'https://api.gsmgenesis.com', apiKey: SAMPLE_JWT, type: 'dhru' } },
    testRes,
  );
  assert.equal(testRes.statusCode, 200);
  assert.equal(testRes.body.success, true);
  assert.equal(testRes.body.balance, 154.75);
  assert.equal(testRes.body.currency, 'USD');

  const createHandler = getRouteHandler(providersRouter, 'POST', '/');
  const createRes = makeRes();
  await createHandler(
    { body: { name: 'GsmGenesis', apiUrl: 'https://api.gsmgenesis.com', apiKey: SAMPLE_JWT } },
    createRes,
  );
  assert.equal(createRes.statusCode, 200);
  assert.equal(createdData.type, 'dhru_fusion_pro');
  assert.equal(createdData.apiUrl, 'https://api.gsmgenesis.com/api/reseller/v1');
  assert.equal(createdData.balance, 154.75);

  const balanceHandler = getRouteHandler(providersRouter, 'POST', '/:id/balance');
  const balRes = makeRes();
  await balanceHandler({ params: { id: 'prov-gsmgenesis' } }, balRes);
  assert.equal(balRes.statusCode, 200);
  assert.equal(updatedBalance.balance, 154.75);
});

test('fetch-services and sync parse Dhru Fusion Pro GET /products categories, fields, options, and limits', async (t) => {
  const origProviderFindUnique = prisma.apiProvider.findUnique;
  const origProviderUpdate = prisma.apiProvider.update;
  const origCatFindFirst = prisma.dhruCategory.findFirst;
  const origCatCreate = prisma.dhruCategory.create;
  const origServiceFindMany = prisma.dhruService.findMany;
  const origServiceCreateMany = prisma.dhruService.createMany;
  const origServiceCount = prisma.dhruService.count;

  t.after(() => {
    prisma.apiProvider.findUnique = origProviderFindUnique;
    prisma.apiProvider.update = origProviderUpdate;
    prisma.dhruCategory.findFirst = origCatFindFirst;
    prisma.dhruCategory.create = origCatCreate;
    prisma.dhruService.findMany = origServiceFindMany;
    prisma.dhruService.createMany = origServiceCreateMany;
    prisma.dhruService.count = origServiceCount;
  });

  let insertedServices = [];
  prisma.apiProvider.findUnique = async () => ({
    id: 'prov-gsmgenesis',
    name: 'GsmGenesis',
    apiUrl: 'https://api.gsmgenesis.com/api/reseller/v1',
    username: null,
    apiKey: SAMPLE_JWT,
    type: 'dhru_fusion_pro',
    isActive: true,
  });
  prisma.apiProvider.update = async (args) => ({ id: 'prov-gsmgenesis', ...args.data });
  prisma.dhruCategory.findFirst = async ({ where }) => ({ id: `cat-${where.name}`, name: where.name });
  prisma.dhruCategory.create = async ({ data }) => ({ id: `cat-${data.name}`, name: data.name });
  prisma.dhruService.findMany = async () => [];
  prisma.dhruService.createMany = async ({ data }) => {
    insertedServices.push(...data);
    return { count: data.length };
  };
  prisma.dhruService.count = async () => insertedServices.length;

  mockHttpsAndDns(t, (options) => {
    assert.equal(options.path, '/api/reseller/v1/products');
    assert.equal(options.headers.Authorization, `Bearer ${SAMPLE_JWT}`);
    return {
      statusCode: 200,
      body: {
        status: 'success',
        code: 200,
        data: {
          currency: 'USD',
          categories: {
            '10': { name: 'Apple Unlock' },
            '20': { name: 'Tool Credits' },
          },
          products: {
            '101': {
              name: 'iPhone Clean Unlock',
              type: 'imei',
              cids: ['10'],
              price: '12.50',
              delivery_time: '1-6 Hours',
              info: 'Official carrier check',
              fields: [
                { type: 'imei', name: 'IMEI', required: true },
                { type: 'select', name: 'Carrier', required: true, options: ['AT&T', 'T-Mobile'] },
              ],
            },
            '202': {
              name: 'Chimera Tool Credits',
              type: 'server',
              cids: ['20'],
              price: '0.15',
              delivery_time: 'Instant',
              fields: [
                { type: 'text', name: 'Username', required: true },
                { type: 'quantity', name: 'Quantity', min: 10, max: 500, required: true },
              ],
            },
          },
        },
      },
    };
  });

  const fetchHandler = getRouteHandler(providersRouter, 'GET', '/:id/fetch-services');
  const fetchRes = makeRes();
  await fetchHandler({ params: { id: 'prov-gsmgenesis' } }, fetchRes);
  assert.equal(fetchRes.statusCode, 200);
  assert.equal(fetchRes.body.servicesCount, 2);

  const imeiSrv = fetchRes.body.services.find((s) => s.id === '101');
  assert.equal(imeiSrv.group_name, 'Apple Unlock');
  assert.equal(imeiSrv.api_service_type, 'imei');
  assert.equal(imeiSrv.customFields.find((f) => f.name === 'Carrier').type, 'select');
  assert.deepEqual(imeiSrv.customFields.find((f) => f.name === 'Carrier').options, ['AT&T', 'T-Mobile']);

  const syncHandler = getRouteHandler(providersRouter, 'POST', '/:id/sync');
  const syncRes = makeRes();
  await syncHandler({ params: { id: 'prov-gsmgenesis' }, body: { markupPercent: 10 } }, syncRes);
  assert.equal(syncRes.statusCode, 200);
  assert.equal(syncRes.body.count, 2);
  assert.equal(insertedServices.length, 2);

  const serverRow = insertedServices.find((s) => s.dhruId === 'prov-gsmgenesis::202');
  assert.equal(serverRow.supportsQty, true);
  assert.equal(serverRow.minQty, 10);
  assert.equal(serverRow.maxQty, 500);
  assert.equal(serverRow.margin, 0.01);
});

test('Order dispatch and status polling handle Fusion Pro JSON payload, polling vs callback, and 503 unavailable', async (t) => {
  const capturedCalls = [];
  let accountHasPolling = true;
  let orderStatusMode = 'success';

  mockHttpsAndDns(t, (options, rawBody) => {
    capturedCalls.push({ method: options.method, path: options.path, body: rawBody ? JSON.parse(rawBody) : null });

    if (options.path === '/api/reseller/v1/account') {
      return {
        statusCode: 200,
        body: {
          status: 'success',
          code: 200,
          data: {
            currency: 'USD',
            balance: '50.00',
            capabilities: accountHasPolling
              ? {
                  order_status: {
                    version: 1,
                    mode: 'polling',
                    path: 'order_query',
                    lookup: 'order_uuid',
                    max_items: 1000,
                    max_body_bytes: 262144,
                    max_response_bytes: 8388608,
                    unavailable_state: 'unavailable',
                  },
                }
              : {},
          },
        },
      };
    }

    if (options.path === '/api/reseller/v1/order' && options.method === 'POST') {
      return {
        statusCode: 200,
        body: {
          status: 'success',
          code: 200,
          message: '1 Order submitted',
          data: [[{ order_uuid: 'FP-UUID-1001', amount: 12.5, currency_code: 'USD', reference_id: 'ord-abc' }]],
        },
      };
    }

    if (options.path.startsWith('/api/reseller/v1/order?order_uuid=')) {
      if (orderStatusMode === 'unavailable') {
        return {
          statusCode: 503,
          body: { status: 'error', code: 'ORDER_RESULT_UNAVAILABLE', data: { state: 'unavailable' } },
        };
      }
      if (orderStatusMode === 'http201_error') {
        return {
          statusCode: 201,
          body: { status: 'error', code: 201, message: 'Validation failed on host' },
        };
      }
      return {
        statusCode: 200,
        body: {
          status: 'success',
          code: 200,
          data: { quantity: 1, replay: 'UNLOCK-CODE-9988', status: 'success' },
        },
      };
    }

    return { statusCode: 404, body: { status: 'error', code: 404 } };
  });

  const provPolling = {
    apiUrl: 'https://polling.gsmgenesis.test/api/reseller/v1',
    apiKey: SAMPLE_JWT,
    type: 'dhru_fusion_pro',
    orderId: 'ord-abc',
    requiresCustom: JSON.stringify([
      { field_id: 'IMEI', name: 'IMEI', type: 'text', required: true },
      { field_id: 'Carrier', name: 'Carrier', type: 'select', required: true },
    ]),
  };

  const placeRes = await dhruApi.placeImeiOrder('101', '352000000000001', { custom_Carrier: 'AT&T' }, provPolling);
  assert.equal(placeRes.SUCCESS[0].REFERENCEID, 'FP-UUID-1001');

  const postCall = capturedCalls.find((c) => c.method === 'POST');
  assert.deepEqual(postCall.body, [
    {
      product_id: 101,
      fields: [
        {
          Carrier: 'AT&T',
          IMEI: '352000000000001',
          reference_id: 'ord-abc',
        },
      ],
    },
  ]);

  // Workspace without polling must automatically attach signed HTTPS feedback_url
  accountHasPolling = false;
  const provCallback = {
    apiUrl: 'https://callbackonly.gsmgenesis.test/api/reseller/v1',
    apiKey: SAMPLE_JWT,
    type: 'dhru_fusion_pro',
    orderId: 'ord-cb-99',
    requiresCustom: JSON.stringify([
      { field_id: 'Username', name: 'Username', type: 'text', required: true },
      { field_id: 'Quantity', name: 'Quantity', type: 'quantity', is_quantity: true, required: true },
    ]),
  };
  await dhruApi.placeServerOrder('202', 25, { Username: 'demo_user' }, '', provCallback);
  const cbPostCall = capturedCalls[capturedCalls.length - 1];
  assert.equal(cbPostCall.body[0].fields[0].Quantity, 25);
  assert.equal(cbPostCall.body[0].fields[0].Username, 'demo_user');
  assert.match(cbPostCall.body[0].fields[0].feedback_url, /^https:\/\/arabproserver\.com\/api\/providers\/fusion-pro\/callback\?orderId=ord-cb-99&token=/);

  const okStatus = await dhruApi.getImeiOrder('FP-UUID-1001', provPolling);
  assert.equal(okStatus.SUCCESS[0].STATUS, '4');
  assert.equal(okStatus.SUCCESS[0].CODE, 'UNLOCK-CODE-9988');

  orderStatusMode = 'unavailable';
  const unavailStatus = await dhruApi.getImeiOrder('FP-UUID-1001', provPolling);
  assert.equal(unavailStatus.SUCCESS[0].STATUS, '1');

  orderStatusMode = 'http201_error';
  const err201Status = await dhruApi.getImeiOrder('FP-UUID-1001', provPolling);
  assert.equal(err201Status.SUCCESS, false);
  assert.match(err201Status.ERROR[0].MESSAGE, /Validation failed/);
});

test('POST /fusion-pro/callback authenticates HMAC token, decodes base64 replay, and handles completion & idempotent refund', async (t) => {
  const origOrderFindUnique = prisma.order.findUnique;
  const origOrderUpdate = prisma.order.update;
  const origUserFindUnique = prisma.user.findUnique;
  const origTransaction = prisma.$transaction;

  t.after(() => {
    prisma.order.findUnique = origOrderFindUnique;
    prisma.order.update = origOrderUpdate;
    prisma.user.findUnique = origUserFindUnique;
    prisma.$transaction = origTransaction;
  });

  let orderState = {
    id: 'order-fp-1',
    userId: 'user-1',
    serviceName: 'iPhone Unlock',
    targetInput: '352000000000001',
    price: 15,
    status: 'processing',
    apiOrderId: 'FP-UUID-1',
    refundedAt: null,
    user: { id: 'user-1', email: null, fullName: 'Arab', balance: 10 },
  };
  let refundTxCreated = false;

  prisma.order.findUnique = async () => ({ ...orderState });
  prisma.order.update = async ({ data }) => {
    orderState = { ...orderState, ...data };
    return orderState;
  };
  prisma.user.findUnique = async () => ({ email: null, fullName: 'Arab', balance: 25 });
  prisma.$transaction = async (fn) =>
    fn({
      order: {
        updateMany: async ({ data }) => {
          if (orderState.refundedAt) return { count: 0 };
          orderState = { ...orderState, ...data };
          return { count: 1 };
        },
      },
      user: {
        update: async () => ({ balance: 25 }),
      },
      transaction: {
        create: async () => {
          refundTxCreated = true;
          return {};
        },
      },
    });

  const cbHandler = getRouteHandler(providersRouter, 'POST', '/fusion-pro/callback');

  const badRes = makeRes();
  await cbHandler(
    {
      query: { orderId: 'order-fp-1', token: 'invalid-token' },
      body: { reference_id: 'order-fp-1', order_id: 'FP-UUID-1', status: 'success', replay: 'T0s=' },
    },
    badRes,
  );
  assert.equal(badRes.statusCode, 401);

  const validToken = fusionPro.signFusionProCallbackToken('order-fp-1');
  const okRes = makeRes();
  await cbHandler(
    {
      query: { orderId: 'order-fp-1', token: validToken },
      body: {
        reference_id: 'order-fp-1',
        order_id: 'FP-UUID-1',
        status: 'success',
        replay: Buffer.from('Done: UNLOCK-OK').toString('base64'),
      },
    },
    okRes,
  );
  assert.equal(okRes.statusCode, 200);
  assert.equal(okRes.body.accepted, true);
  assert.equal(orderState.status, 'completed');
  assert.equal(orderState.reply, 'Done: UNLOCK-OK');

  // Test rejection + automatic refund
  orderState.status = 'processing';
  const rejRes = makeRes();
  await cbHandler(
    {
      query: { orderId: 'order-fp-1', token: validToken },
      body: {
        reference_id: 'order-fp-1',
        order_id: 'FP-UUID-1',
        status: 'rejected',
        replay: Buffer.from('Unsupported carrier').toString('base64'),
      },
    },
    rejRes,
  );
  assert.equal(rejRes.statusCode, 200);
  assert.equal(orderState.status, 'rejected');
  assert.equal(orderState.reply, 'Unsupported carrier');
  assert.equal(refundTxCreated, true);
});
