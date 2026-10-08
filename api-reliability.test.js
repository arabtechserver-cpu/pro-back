const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.JWT_SECRET = 'reliability-test-secret-at-least-32-chars';
process.env.TELEGRAM_BOT_TOKEN = 'test-token';
const { prisma } = require('./dist/utils/prisma');
const fox = require('./dist/services/foxreloadService');
const { withinDeadline, mapWithinDeadline, RequestDeadlineError } = require('./dist/utils/request-deadline');

function freshCatalog() {
  delete require.cache[require.resolve('./dist/services/unifiedCatalogService')];
  return require('./dist/services/unifiedCatalogService');
}

test('simultaneous API activations preserve the same key; settings never replace it', async () => {
  const { ensureStableApiKey } = require('./dist/utils/stable-api-key');
  let key = null;
  const db = { user: { async updateMany({ where, data }) {
    assert.equal(where.id, 'client');
    if (key === null) key = data.apiKey;
    await new Promise(resolve => setImmediate(resolve));
    return { count: 1 };
  } } };
  await Promise.all(Array.from({ length: 12 }, () => ensureStableApiKey(db, 'client')));
  const original = key;
  await ensureStableApiKey(db, 'client');
  assert.equal(key, original);
  assert.match(key, /^ATS-[a-f0-9]{32}$/);

  const oldUpdateMany = prisma.user.updateMany;
  const oldUpdate = prisma.user.update;
  prisma.user.updateMany = db.user.updateMany;
  prisma.user.update = async ({ data }) => {
    assert.equal(data.apiKey, undefined, 'settings cannot rotate the key, even with an incoming key');
    return { apiKey: key, ...data };
  };
  try {
    const router = require('./dist/routes/users').default;
    const handler = router.stack.find(layer => layer.route?.path === '/update-api-settings').route.stack.at(-1).handle;
    const res = { status() { return this; }, json(body) { this.body = body; return this; } };
    await handler({ body: { userId: 'client', apiEnabled: true, apiMargin: 12, apiKey: 'unwanted-new-key' } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.user.apiKey, original);
  } finally { prisma.user.updateMany = oldUpdateMany; prisma.user.update = oldUpdate; }
});

test('DHRU groups with identical prefixes have distinct IDs and return all matching packages without FoxReload', async () => {
  const oldFind = prisma.dhruService.findMany;
  const oldCatalog = fox.getFoxreloadFullCatalog;
  const oldProducts = fox.getFoxreloadCategoryProducts;
  const records = Array.from({ length: 305 }, (_, i) => ({
    id: `service-${i}`, dhruId: String(i), name: `Package ${i}`, groupName: i < 304 ? 'Common prefix - A' : 'Common prefix - B',
    credit: 10, dhruCategory: { name: 'Server Service' }
  }));
  prisma.dhruService.findMany = async query => {
    assert.equal(query.take, undefined, 'service discovery must not truncate at 200 rows');
    return records;
  };
  fox.getFoxreloadFullCatalog = async () => { throw new Error('DHRU must not wait for FoxReload'); };
  fox.getFoxreloadCategoryProducts = async () => { throw new Error('DHRU must not query FoxReload products'); };
  try {
    const catalog = freshCatalog();
    const services = await catalog.getUnifiedServices('dhru-server');
    assert.equal(services.length, 2);
    assert.notEqual(services[0].id, services[1].id);
    const result = await catalog.getUnifiedPackages(services[0].id, 8);
    assert.equal(result.packages.length, 304);
    assert.equal(result.packages[0].price, 10.8);
    assert.ok(result.packages.every(p => p.serviceName === 'Common prefix - A'));
    const direct = await catalog.getUnifiedPackages('service-0', 8);
    assert.ok(direct.packages.length > 0);
  } finally { prisma.dhruService.findMany = oldFind; fox.getFoxreloadFullCatalog = oldCatalog; fox.getFoxreloadCategoryProducts = oldProducts; }
});

test('changing a password renews the current session and revokes the previous token', async () => {
  const jwt = require('jsonwebtoken');
  const bcrypt = require('bcryptjs');
  const auth = require('./dist/middleware/auth');
  const oldFind = prisma.user.findUnique, oldUpdate = prisma.user.update;
  const user = { id: 'client', email: 'client@example.test', role: 'user', status: 'active', tokenVersion: 1, password: await bcrypt.hash('old-password', 4) };
  const oldToken = auth.generateToken({ id: user.id, role: user.role, tokenVersion: 1 });
  prisma.user.findUnique = async () => user;
  prisma.user.update = async ({ data, select }) => {
    assert.equal(select.tokenVersion, true);
    assert.equal(data.tokenVersion.increment, 1);
    user.tokenVersion++;
    return { ...user };
  };
  const response = () => ({ status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  try {
    const router = require('./dist/routes/users').default;
    const handler = router.stack.find(layer => layer.route?.path === '/update-credentials').route.stack.at(-1).handle;
    const res = response();
    await handler({ user, body: { currentPassword: 'old-password', newPassword: 'new-password' } }, res);
    assert.equal(jwt.decode(res.body.token).tokenVersion, 2);
    let next = 0;
    await auth.authenticateToken({ headers: { authorization: `Bearer ${res.body.token}` }, query: {} }, response(), () => next++);
    assert.equal(next, 1);
    const rejected = response();
    await auth.authenticateToken({ headers: { authorization: `Bearer ${oldToken}` }, query: {} }, rejected, () => next++);
    assert.equal(rejected.statusCode, 401);
    assert.equal(next, 1);
  } finally { prisma.user.findUnique = oldFind; prisma.user.update = oldUpdate; }
});

test('merged catalog includes every bundle and region, coalesces concurrent clients, and isolates margins', async () => {
  const oldFind = prisma.dhruService.findMany;
  const oldCatalog = fox.getFoxreloadFullCatalog;
  const oldProducts = fox.getFoxreloadCategoryProducts;
  const bundles = Array.from({ length: 100 }, (_, i) => ({ id: `bundle-${i}`, name: `Game ${i}`, regions: [{ id: `region-${i}-a` }, { id: `region-${i}-b` }] }));
  prisma.dhruService.findMany = async () => [];
  fox.getFoxreloadFullCatalog = async () => ({ sections: { topups: { bundles } } });
  let calls = 0, active = 0, peak = 0;
  fox.getFoxreloadCategoryProducts = async id => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 2));
    active--;
    return [{ id, name: id, costPrice: 10, minQty: 1 }];
  };
  try {
    const catalog = freshCatalog();
    const [a, b] = await Promise.all([catalog.getDhruCompatibleMergedCatalog(8), catalog.getDhruCompatibleMergedCatalog(8)]);
    assert.equal(a, b);
    assert.equal(calls, 200);
    assert.equal(a.totalServices, 200);
    assert.equal(a.groupsList.length, 100);
    assert.ok(peak <= 24);
    assert.equal(a.groupsList[0].SERVICES[0].PRICE, '10.80');
    const other = await catalog.getDhruCompatibleMergedCatalog(12);
    assert.equal(other.groupsList[0].SERVICES[0].PRICE, '11.20');
    assert.equal((await catalog.getDhruCompatibleMergedCatalog(8)).groupsList[0].SERVICES[0].PRICE, '10.80');
  } finally { prisma.dhruService.findMany = oldFind; fox.getFoxreloadFullCatalog = oldCatalog; fox.getFoxreloadCategoryProducts = oldProducts; }
});

test('deadlines terminate hung reads and stop scheduling new provider requests', async () => {
  await assert.rejects(withinDeadline(new Promise(() => {}), 20), RequestDeadlineError);
  let calls = 0;
  await assert.rejects(mapWithinDeadline([1, 2, 3, 4], async () => { calls++; await new Promise(resolve => setTimeout(resolve, 40)); }, 2, 20), RequestDeadlineError);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(calls, 2);
});

test('a saved and charged order returns immediately while Telegram delivery is stalled', async () => {
  const telegram = require('./dist/utils/telegramService');
  const originals = {
    userFind: prisma.user.findUnique, orderFind: prisma.order.findFirst,
    serviceFind: prisma.dhruService.findFirst, transaction: prisma.$transaction,
    notification: telegram.sendTelegramPhotoNotification
  };
  let balance = 100, charged = 0, notifications = 0;
  let releaseNotification;
  telegram.sendTelegramPhotoNotification = () => {
    notifications++;
    return new Promise(resolve => { releaseNotification = resolve; });
  };
  prisma.user.findUnique = async () => ({ id: 'client', username: 'client', fullName: 'Client', balance });
  prisma.order.findFirst = async () => null;
  prisma.dhruService.findFirst = async () => ({ id: 'service', dhruId: '10', isActive: true, credit: 5, margin: 0, dhruCategory: { name: 'Server Service' } });
  prisma.$transaction = async callback => callback({
    user: { updateMany: async ({ data }) => { balance -= data.balance.decrement; return { count: 1 }; }, findUnique: prisma.user.findUnique },
    order: { create: async ({ data }) => ({ id: 'saved-order', ...data }) },
    transaction: { create: async () => { charged++; return {}; } }
  });
  try {
    const router = require('./dist/routes/orders').default;
    const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack.at(-1).handle;
    const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await withinDeadline(handler({ user: { id: 'client' }, body: { serviceId: 'service', serviceName: 'Service', targetInput: '123', quantity: 1 } }, res), 100);
    assert.equal(res.body.success, true);
    assert.equal(res.body.order.id, 'saved-order');
    assert.equal(balance, 95);
    assert.equal(charged, 1);
    assert.equal(notifications, 1);
  } finally {
    releaseNotification?.();
    prisma.user.findUnique = originals.userFind; prisma.order.findFirst = originals.orderFind;
    prisma.dhruService.findFirst = originals.serviceFind; prisma.$transaction = originals.transaction;
    telegram.sendTelegramPhotoNotification = originals.notification;
  }
});

test('Telegram removes a webhook once at startup and stops on a competing listener', async () => {
  const axios = require('axios');
  const oldGet = axios.get, oldPost = axios.post;
  const oldSetting = prisma.setting.findUnique;
  let deletes = 0, polls = 0;
  axios.get = async url => {
    if (url.endsWith('/getWebhookInfo')) return { data: { ok: true, result: { url: 'https://existing.example/webhook' } } };
    if (url.endsWith('/getUpdates')) {
      polls++;
      throw { response: { status: 409, data: { description: 'Conflict: terminated by other getUpdates request' } } };
    }
    throw new Error('Unexpected Telegram method');
  };
  axios.post = async (url, body) => {
    assert.ok(url.endsWith('/deleteWebhook'));
    assert.equal(body.drop_pending_updates, false);
    deletes++;
    return { data: { ok: true } };
  };
  prisma.setting.findUnique = async () => null;
  try {
    const telegram = require('./dist/utils/telegramService');
    await telegram.startTelegramBotPolling();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(deletes, 1);
    assert.equal(polls, 1);
    process.env.TELEGRAM_UPDATES_MODE = 'webhook';
    await telegram.startTelegramBotPolling();
    assert.equal(polls, 1);
    delete process.env.TELEGRAM_UPDATES_MODE;
    telegram.stopTelegramBotPolling();
  } finally { axios.get = oldGet; axios.post = oldPost; prisma.setting.findUnique = oldSetting; }
});
