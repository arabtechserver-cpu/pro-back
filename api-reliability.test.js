const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const catalogTestDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'arad-catalog-test-'));
process.env.FOXRELOAD_CATALOG_CACHE_DIR = catalogTestDirectory;
process.on('exit', () => {
  if (path.dirname(path.resolve(catalogTestDirectory)) === path.resolve(os.tmpdir()) && path.basename(catalogTestDirectory).startsWith('arad-catalog-test-')) {
    fs.rmSync(catalogTestDirectory, { recursive: true, force: true });
  }
});

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
  const oldAll = fox.getFoxreloadAllProducts;
  const oldAvailable = fox.getAvailableFoxreloadCatalog;
  prisma.dhruService.findMany = async () => [];
  fox.getFoxreloadFullCatalog = async () => ({ sections: { topups: { bundles } } });
  let calls = 0;
  fox.getFoxreloadCategoryProducts = async () => { throw new Error('Merged catalog must use the bulk cursor API'); };
  fox.getFoxreloadAllProducts = async () => {
    calls++;
    await new Promise(resolve => setTimeout(resolve, 2));
    return bundles.flatMap(bundle => bundle.regions.map(region => ({ id: region.id, categoryId: region.id, name: region.id, costPrice: 10, minQty: 1 })));
  };
  let published;
  fox.getAvailableFoxreloadCatalog = () => published ||= Promise.all([fox.getFoxreloadFullCatalog(), fox.getFoxreloadAllProducts()]).then(([catalog, products]) => ({ catalog, products, complete: true, refreshing: false }));
  try {
    const catalog = freshCatalog();
    const [a, b] = await Promise.all([catalog.getDhruCompatibleMergedCatalog(8), catalog.getDhruCompatibleMergedCatalog(8)]);
    assert.deepEqual(a, b);
    assert.equal(calls, 1);
    assert.equal(a.totalServices, 200);
    assert.equal(a.groupsList.length, 100);
    assert.ok(a.groupsList.every(group => group.section_id === 'topups' && group.GROUPTYPE === 'SERVER'));
    assert.equal(a.groupsList[0].SERVICES[0].PRICE, '10.80');
    const other = await catalog.getDhruCompatibleMergedCatalog(12);
    assert.equal(other.groupsList[0].SERVICES[0].PRICE, '11.20');
    assert.equal((await catalog.getDhruCompatibleMergedCatalog(8)).groupsList[0].SERVICES[0].PRICE, '10.80');
  } finally { prisma.dhruService.findMany = oldFind; fox.getFoxreloadFullCatalog = oldCatalog; fox.getFoxreloadCategoryProducts = oldProducts; fox.getFoxreloadAllProducts = oldAll; fox.getAvailableFoxreloadCatalog = oldAvailable; }
});

test('DHRU single-list clients receive all sections, IDs, fields and accurate remote filters without duplicates', async () => {
  const oldFind = prisma.dhruService.findMany, oldCatalog = fox.getFoxreloadFullCatalog, oldAll = fox.getFoxreloadAllProducts;
  const oldAvailable = fox.getAvailableFoxreloadCatalog;
  let records = ['imei', 'server', 'remote'].map(type => ({
    id: `local-${type}`, dhruId: `provider::${type}`, name: `${type} package`, apiServiceType: type,
    groupName: 'Same group name', credit: 10, supportsQty: false,
    dhruCategory: { name: 'IMEI Service' }, requiresCustom: JSON.stringify([{ fieldname: 'Serial', fieldtype: 'text', required: true }])
  }));
  const sectionKeys = [['topups', 'topups'], ['appStores', 'app-stores'], ['gameCurrency', 'game-currency'], ['subscriptions', 'subscriptions'], ['esim', 'esim'], ['rewarble', 'rewarble']];
  const sections = Object.fromEntries(sectionKeys.map(([key, id]) => [key, { bundles: [{ id, name: id, regions: [{ id: `${id}-region` }] }] }]));
  sections.popular = sections.topups; // Popular is an alias; it must not steal the game's section.
  const products = sectionKeys.map(([, id]) => ({ id: `product-${id}`, categoryId: `${id}-region`, name: id, costPrice: 5,
    requiredNoteFields: ['Region'], noteFieldTypes: { Region: 'dropdown', Extra: 'text' }, noteFieldOptions: { Region: ['EU', 'US'] }, minQty: 2, maxQty: 100 }));
  let builds = 0;
  prisma.dhruService.findMany = async query => { assert.ok(query.where.OR, 'inactive provider services are excluded'); return records; };
  fox.getFoxreloadFullCatalog = async () => ({ sections });
  fox.getFoxreloadAllProducts = async () => { builds++; return products; };
  let published;
  fox.getAvailableFoxreloadCatalog = () => published ||= Promise.all([fox.getFoxreloadFullCatalog(), fox.getFoxreloadAllProducts()]).then(([catalog, products]) => ({ catalog, products, complete: true, refreshing: false }));
  try {
    freshCatalog();
    delete require.cache[require.resolve('./dist/routes/externalApi')];
    const router = require('./dist/routes/externalApi').default;
    const handler = router.stack.find(layer => Array.isArray(layer.route?.path)).route.stack.at(-1).handle;
    async function request(action, query = {}) {
      const res = { status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handler({ apiUser: { id: 'client', apiMargin: 8 }, body: { action }, query, headers: {}, method: 'POST' }, res);
      assert.equal(res.statusCode, undefined);
      return res.body;
    }
    const [all, server, remote] = await Promise.all(['imeiservicelist', 'serverservicelist', 'remoteservicelist'].map(action => request(action)));
    assert.equal(builds, 1);
    assert.equal(all.SUCCESS[0].total_services, 9);
    assert.equal(all.SUCCESS[0].catalog_complete, true);
    assert.equal(server.SUCCESS[0].total_services, 7);
    assert.equal(remote.SUCCESS[0].total_services, 1);
    const groups = Object.values(all.SUCCESS[0].LIST);
    assert.equal(groups.length, 9, 'identical group names with different protocol types remain separate');
    assert.ok(groups.every(g => !g.services && !g.services_map), 'wire response must not duplicate each group three times');
    const rawServices = groups.flatMap(g => Object.values(g.SERVICES));
    assert.ok(rawServices.every(s => s.ID === s.SERVICEID && s.section_id && s.SERVICETYPE));
    const imei = rawServices.find(s => s.SERVICETYPE === 'IMEI');
    assert.equal(imei.Requires, 'Serial', 'serial-only services do not get a fabricated IMEI field');
    const topup = rawServices.find(s => s.section_id === 'topups');
    assert.equal(topup['Requires.Custom'][0].fieldtype, 'dropdown');
    assert.deepEqual(topup['Requires.Custom'][0].fieldoptions, ['EU', 'US']);
    assert.equal(topup.MAXQNT, 100);
    assert.equal(topup['Requires.Custom'].find(field => field.name === 'Extra').required, false);
    const parsed = require('./dist/routes/providers').parseAllProviderServices({ data: all }, { data: server }, { data: remote });
    assert.equal(parsed.length, 9);
    assert.equal(parsed.find(s => s.id === 'product-topups').section_id, 'topups');
    assert.equal((await request('imeiservicelist', { service_type: 'imei' })).SUCCESS[0].total_services, 1);
    assert.equal((await request('imeiservicelist', { section: 'dhru-remote' })).SUCCESS[0].total_services, 1);
    assert.equal((await request('imeiservicelist', { section: 'esim' })).SUCCESS[0].total_services, 1);
    records = records.slice(1);
    require('./dist/utils/catalog-revision').invalidateCatalogRevision();
    assert.equal((await request('imeiservicelist')).SUCCESS[0].total_services, 8, 'service edits invalidate previously exported catalogs');
  } finally { prisma.dhruService.findMany = oldFind; fox.getFoxreloadFullCatalog = oldCatalog; fox.getFoxreloadAllProducts = oldAll; fox.getAvailableFoxreloadCatalog = oldAvailable; }
});

test('FoxReload follows all cursor and offset pages; failed or stalled pagination never becomes a partial success', async () => {
  const cursorCalls = [];
  const all = await fox.readFoxreloadProductPages(async path => {
    const query = new URL(path, 'https://example.test').searchParams;
    assert.equal(query.get('includeDescendants'), 'true');
    cursorCalls.push(query.get('cursor'));
    const second = query.has('cursor');
    return { ok: true, data: { items: Array.from({ length: second ? 50 : 200 }, (_, i) => ({ id: String(i + (second ? 200 : 0)) })), total: 250, limit: 200, nextCursor: second ? null : 'page-2' } };
  });
  assert.equal(all.length, 250);
  assert.deepEqual(cursorCalls, [null, 'page-2']);
  const offsets = [];
  const category = await fox.readFoxreloadProductPages(async path => {
    const query = new URL(path, 'https://example.test').searchParams;
    const offset = Number(query.get('offset'));
    assert.equal(query.get('categoryId'), 'a/b'); offsets.push(offset);
    return { ok: true, data: { items: Array.from({ length: offset ? 50 : 200 }, (_, i) => ({ id: String(offset + i) })), total: 250, limit: 200 } };
  }, 'a/b');
  assert.equal(category.length, 250);
  assert.deepEqual(offsets, [0, 200]);
  await assert.rejects(fox.readFoxreloadProductPages(async () => ({ ok: false, data: {} })), /incomplete catalog/);
  await assert.rejects(fox.readFoxreloadProductPages(async () => ({ ok: true, data: { items: [{ id: 'one' }], total: 2 } })), /incomplete catalog/);
  await assert.rejects(fox.readFoxreloadProductPages(async () => ({ ok: true, data: { items: [{ id: 'one' }], nextCursor: 'same' } })), /did not advance/);
  const walk = { products: new Map(), cursors: new Set(), cursor: '', offset: 0 };
  let pageCalls = 0;
  await assert.rejects(fox.readFoxreloadProductPages(async () => {
    pageCalls++;
    return pageCalls === 1 ? { ok: true, data: { items: [{ id: 'saved' }], nextCursor: 'resume' } } : { ok: false, data: {} };
  }, undefined, 1000, walk), /incomplete catalog/);
  const resumed = await fox.readFoxreloadProductPages(async url => {
    assert.equal(new URL(url, 'https://example.test').searchParams.get('cursor'), 'resume');
    return { ok: true, data: { items: [{ id: 'last' }], total: 2, nextCursor: null } };
  }, undefined, 1000, walk);
  assert.deepEqual(resumed.map(product => product.id), ['saved', 'last']);
});

test('cold or stalled FoxReload never blocks local catalogs; 32 readers return honest readiness and reuse the DB build', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const oldRequest = https.request, oldSetting = prisma.setting.findUnique, oldFind = prisma.dhruService.findMany;
  const oldUser = prisma.user.findFirst;
  let server;
  const oldKey = process.env.FOXRELOAD_API_KEY;
  const pending = [];
  let dbReads = 0, settingReads = 0, releaseImmediately = false;
  process.env.FOXRELOAD_API_KEY = '';
  prisma.setting.findUnique = async () => { settingReads++; return { value: JSON.stringify({ apiKey: 'cold-provider-fixture', isEnabled: true, hiddenItems: [] }) }; };
  prisma.dhruService.findMany = async () => { dbReads++; return ['imei', 'server', 'remote'].map(type => ({ id: type, name: type, apiServiceType: type, groupName: type, credit: 10, dhruCategory: { name: `${type} Service` } })); };
  https.request = (options, callback) => {
    const req = new EventEmitter(); req.write = () => {}; req.destroy = () => {};
    req.end = () => {
      const finish = () => {
      const res = new EventEmitter(); res.statusCode = 401;
      callback(res); res.emit('data', '{"error":"fixture provider unavailable"}'); res.emit('end');
      };
      if (releaseImmediately) setImmediate(finish); else pending.push(finish);
    };
    return req;
  };
  try {
    fox.clearCatalogCache();
    const catalog = freshCatalog();
    const start = performance.now();
    const results = await withinDeadline(Promise.all(Array.from({ length: 32 }, () => catalog.getDhruCompatibleMergedCatalog(8))), 1500);
    assert.ok(performance.now() - start < 1500);
    assert.equal(dbReads, 1);
    assert.ok(results.every(result => result.totalServices === 3 && result.catalogComplete === false));
    assert.deepEqual(results[0].refreshingSources, ['foxreload']);
    const before = settingReads;
    const remote = await catalog.getDhruCompatibleMergedCatalog(8, 'remote');
    const imei = await catalog.getDhruCompatibleMergedCatalog(8, 'imei');
    assert.equal(remote.totalServices, 1); assert.equal(imei.totalServices, 1);
    assert.equal(remote.catalogComplete, true);
    assert.equal(settingReads, before, 'local protocol lists never need FoxReload settings or connections');
    const { dhruCatalogChunks } = require('./dist/utils/streaming-catalog');
    const body = JSON.parse(Array.from(dhruCatalogChunks(results[0].groupsList, true, 3, false)).join(''));
    assert.equal(body.SUCCESS[0].catalog_complete, false);
    assert.deepEqual(body.SUCCESS[0].refreshing_sources, ['foxreload']);
    assert.ok(require('./dist/routes/providers').getProviderCatalogWarning([{ data: body }]));
    const express = require('express');
    const app = express(); app.use(express.json());
    prisma.user.findFirst = async () => ({ id: 'cold-catalog-client', status: 'active', apiEnabled: true });
    app.use('/api/v1/provider', require('./dist/routes/externalApi').default);
    server = app.listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    const responses = await withinDeadline(Promise.all(['imeiservicelist', 'serverservicelist', 'remoteservicelist'].map(async action => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/provider`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': 'catalog-fixture-key' }, body: JSON.stringify({ action })
      });
      assert.equal(response.status, 200, 'ready catalog must not turn a cold provider into HTTP 504');
      const parsed = await response.json();
      assert.equal(parsed.SUCCESS[0].total_services, action === 'imeiservicelist' ? 3 : 1);
      const complete = action === 'remoteservicelist';
      assert.equal(parsed.SUCCESS[0].catalog_complete, complete);
      assert.equal(response.headers.get('x-catalog-complete'), String(complete));
      assert.equal(response.headers.get('retry-after'), complete ? null : '5');
      return parsed;
    })), 1500);
    assert.equal(responses.length, 3);
  } finally {
    server?.closeAllConnections();
    if (server) await new Promise(resolve => server.close(resolve));
    releaseImmediately = true;
    for (const finish of pending) finish();
    await new Promise(resolve => setTimeout(resolve, 30));
    https.request = oldRequest; prisma.setting.findUnique = oldSetting; prisma.dhruService.findMany = oldFind;
    prisma.user.findFirst = oldUser;
    if (oldKey === undefined) delete process.env.FOXRELOAD_API_KEY; else process.env.FOXRELOAD_API_KEY = oldKey;
    fox.clearCatalogCache();
  }
});

test('private compressed snapshots survive restarts and reject mismatched settings or incomplete files', async () => {
  const snapshot = require('./dist/utils/provider-catalog-snapshot');
  const file = path.join(catalogTestDirectory, 'persisted.jsonl.gz');
  const products = [{ id: 'product', name: 'Product', costPrice: 0, price: 0 }];
  await snapshot.saveProviderCatalogSnapshot(file, 'fingerprint', products, { sections: { topups: {} } });
  assert.deepEqual((await snapshot.loadProviderCatalogSnapshot(file, 'fingerprint')).products, products);
  assert.equal(await snapshot.loadProviderCatalogSnapshot(file, 'different-settings'), null);
  await snapshot.saveProviderCatalogSnapshot(file, 'fingerprint', products, { sections: {} }, Date.now() - 25 * 60 * 60 * 1000);
  assert.equal(await snapshot.loadProviderCatalogSnapshot(file, 'fingerprint'), null, 'metadata updates cannot renew old product freshness');
  fs.writeFileSync(file, require('node:zlib').gzipSync(JSON.stringify({ version: 1, timestamp: Date.now(), fingerprint: 'fingerprint' }) + '\n' + JSON.stringify({ product: products[0] }) + '\n'));
  assert.equal(await snapshot.loadProviderCatalogSnapshot(file, 'fingerprint'), null, 'missing completion footer cannot become a successful snapshot');
  fs.writeFileSync(file, 'invalid gzip');
  assert.equal(await snapshot.loadProviderCatalogSnapshot(file, 'fingerprint'), null);
  assert.equal(await snapshot.loadProviderCatalogSnapshot(path.join(catalogTestDirectory, 'missing.gz'), 'fingerprint'), null);
});

test('a timed-out reader leaves one shared FoxReload refresh running and subsequent clients receive its complete snapshot', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const originalRequest = https.request, originalSetting = prisma.setting.findUnique;
  let calls = 0;
  prisma.setting.findUnique = async () => ({ value: JSON.stringify({ apiKey: 'catalog-test', isEnabled: true, hiddenItems: [] }) });
  https.request = (options, callback) => {
    calls++;
    const query = new URL(options.path, 'https://example.test').searchParams;
    const req = new EventEmitter();
    req.end = () => setTimeout(() => {
      const second = query.has('cursor');
      const res = new EventEmitter(); res.statusCode = 200;
      callback(res);
      res.emit('data', JSON.stringify({ items: Array.from({ length: second ? 50 : 200 }, (_, i) => ({
        id: `warm-${i + (second ? 200 : 0)}`, name: 'Product', price: i === 0 && !second ? 0 : 10, quantity: 1, categoryId: 'topups'
      })), total: 250, limit: 200, nextCursor: second ? null : 'next' }));
      res.emit('end');
    }, 20);
    req.write = () => {};
    req.destroy = () => {};
    return req;
  };
  try {
    fox.clearCatalogCache();
    await assert.rejects(fox.getFoxreloadAllProducts(false, 5), RequestDeadlineError);
    const [first, second] = await Promise.all([fox.getFoxreloadAllProducts(false, 500), fox.getFoxreloadAllProducts(false, 500)]);
    assert.equal(first.length, 250);
    assert.equal(first[0].costPrice, 0, 'available free services must not disappear from discovery');
    assert.equal(first, second);
    assert.equal(calls, 2, 'timeout and concurrent clients must not restart pagination');
    assert.equal((await fox.getFoxreloadAllProducts()).length, 250);
    assert.equal(calls, 2, 'completed snapshot serves immediately without more provider reads');
    // Include a published section tree in the restart fixture so background topology
    // discovery is not needed to verify persisted product readiness.
    const { createHash } = require('node:crypto');
    const settings = await fox.getFoxreloadSettings();
    await require('./dist/utils/provider-catalog-snapshot').saveProviderCatalogSnapshot(
      path.join(catalogTestDirectory, 'foxreload.jsonl.gz'), createHash('sha256').update(JSON.stringify(settings)).digest('hex'), first,
      { sections: { topups: { bundles: [] } } }
    );
    fox.clearCatalogCache();
    const restored = await fox.getAvailableFoxreloadCatalog();
    assert.equal(restored.complete, true);
    assert.equal(restored.products.length, 250);
    assert.equal(calls, 2, 'restart restores a complete private snapshot without waiting for upstream');
  } finally {
    https.request = originalRequest; prisma.setting.findUnique = originalSetting; fox.clearCatalogCache();
  }
});

test('large standard catalogs stream valid object/array JSON with backpressure and release disconnected readers', async () => {
  const { EventEmitter } = require('node:events');
  const { dhruCatalogChunks, streamDhruCatalog } = require('./dist/utils/streaming-catalog');
  const services = Array.from({ length: 1000 }, (_, i) => ({ SERVICEID: `id-${i}`, SERVICETYPE: 'SERVER',
    SERVICENAME: `خدمة "${i}"`, INFO: 'Details'.repeat(200), 'Requires.Custom': [{ fieldname: 'Region', fieldtype: 'dropdown', fieldoptions: ['EU', 'US'] }] }));
  services[0].SERVICEID = '__proto__';
  const groups = [{ GROUPID: 'g', GROUPNAME: 'Games', GROUPTYPE: 'SERVER', section_id: 'topups', SERVICES: services, services, services_map: Object.fromEntries(services.map(service => [service.SERVICEID, service])) }];
  for (const objectFormat of [true, false]) {
    const parsed = JSON.parse(Array.from(dhruCatalogChunks(groups, objectFormat, services.length)).join(''));
    const group = objectFormat ? parsed.SUCCESS[0].LIST.g : parsed.SUCCESS[0].LIST[0];
    const rows = objectFormat ? Object.values(group.SERVICES) : group.SERVICES;
    assert.deepEqual(rows, services);
    assert.equal(parsed.SUCCESS[0].total_services, 1000);
    assert.equal(group.services_map, undefined);
  }
  class Response extends EventEmitter {
    destroyed = false; writableEnded = false; pending = false; writes = []; ended = false;
    setHeader() {}
    write(chunk) {
      assert.equal(this.pending, false, 'the next write must wait for drain');
      this.pending = true; this.writes.push(chunk);
      setImmediate(() => { this.pending = false; this.emit('drain'); });
      return false;
    }
    end() { this.ended = true; }
  }
  const res = new Response();
  await streamDhruCatalog(res, groups, true, 1000);
  assert.equal(res.ended, true);
  assert.ok(res.writes.length > 10);
  assert.ok(Math.max(...res.writes.map(chunk => chunk.length)) < 40000, 'writer retains small chunks instead of a whole catalog string');
  assert.equal(JSON.parse(res.writes.join('')).SUCCESS[0].total_services, 1000);
  assert.equal(res.listenerCount('close'), 0);
  const closed = new Response();
  closed.write = () => { setImmediate(() => { closed.destroyed = true; closed.emit('close'); }); return false; };
  await assert.rejects(streamDhruCatalog(closed, groups, true, 1000), /response closed/);
  assert.equal(closed.listenerCount('drain'), 0);
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
