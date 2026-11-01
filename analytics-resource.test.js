const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

// Execute current source with explicit mocks: never import Prisma, auth, providers or the server.
const filename = path.join(__dirname, 'src/routes/analytics.ts');
const compiled = transformSync(fs.readFileSync(filename, 'utf8'), {
  loader: 'ts', format: 'cjs', target: 'es2022', sourcefile: filename,
}).code;
const NOW = '2026-11-01T12:00:00.000Z';
class FixedDate extends Date {
  constructor(value) { super(value === undefined ? NOW : value); }
  static now() { return Date.parse(NOW); }
}

function loadAnalytics(prisma) {
  const routes = new Map();
  const rateLimits = [];
  const errors = [];
  const router = {};
  const module = { exports: {} };
  for (const method of ['get', 'post']) {
    router[method] = (route, ...handlers) => { routes.set(`${method} ${route}`, handlers.at(-1)); };
  }
  const mocks = {
    express: { Router: () => router },
    'express-rate-limit': options => { rateLimits.push(options); return () => {}; },
    zod: require('zod'),
    '../utils/prisma': { prisma },
    '../utils/bounded-rate-limit-store': { BoundedRateLimitStore: class {} },
    '../middleware/auth': { isAdmin: () => {} },
    './orders': { enrichOrdersWithProviderData: () => { throw new Error('Unexpected provider work'); } },
  };
  vm.runInNewContext(compiled, {
    module, exports: module.exports, Buffer, Date: FixedDate,
    console: { error: (...args) => errors.push(args) },
    require(name) {
      assert.ok(Object.hasOwn(mocks, name), `Unexpected import: ${name}`);
      return mocks[name];
    },
  }, { filename });
  return { routes, rateLimits, errors };
}

async function invoke(handler, request) {
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = JSON.parse(JSON.stringify(body)); return this; },
  };
  await handler(request, response);
  return response;
}

function ingestion() {
  const writes = [];
  const loaded = loadAnalytics({ analyticsEvent: { create: async value => { writes.push(value.data); } } });
  return { writes, ...loaded, send: body => invoke(loaded.routes.get('post /events'), { body }) };
}

const page = () => ({
  eventName: 'page_view', sessionId: 'browser-session', path: '/ar/pricing',
  metadata: { timestamp: NOW, userAgent: 'Mozilla/5.0', userName: null, userEmail: null },
});
const service = () => ({
  eventName: 'service_view', sessionId: '', path: '/purchase?service=provider%3A%3A42',
  metadata: { serviceId: 'provider::42', userAgent: 'Mozilla/5.0', userName: '\u0645\u062d\u0645\u062f', userEmail: 'user@example.test' },
});

test('current beacon and purchase callers retain fields and 202 semantics', async () => {
  const app = ingestion();
  assert.equal(app.rateLimits[0].max, 60);
  assert.equal(app.rateLimits[0].windowMs, 60000);
  for (const body of [page(), service(), { eventName: 'page_view' }, { eventName: 'page_view', metadata: null }]) {
    const result = await app.send(body);
    assert.equal(result.statusCode, 202);
    assert.deepEqual(result.body, { accepted: true });
    const stored = app.writes.at(-1);
    assert.equal(stored.eventName, body.eventName);
    assert.equal(stored.sessionId, body.sessionId || null);
    assert.equal(stored.path, body.path || null);
    assert.deepEqual(stored.metadata === null ? null : JSON.parse(stored.metadata), body.metadata || null);
  }
});

test('unknown fields, unknown events and non-flat input fail without database writes', async () => {
  const app = ingestion();
  let nested = 'leaf';
  for (let i = 0; i < 12000; i++) nested = { nested };
  const bad = [
    undefined, null, [], true, 'page_view', {},
    { ...page(), eventName: 'purchase_completed' },
    { ...page(), eventName: {} },
    { ...page(), extra: 'not stored' },
    { ...page(), sessionId: 123 },
    { ...page(), path: ['/ar'] },
    { ...page(), metadata: [] },
    { ...page(), metadata: 'not an object' },
    { ...page(), metadata: { unknown: 'not stored' } },
    { ...page(), metadata: { serviceId: 'wrong event' } },
    { ...page(), metadata: { userAgent: nested } },
    { ...page(), metadata: { userEmail: { email: 'nested@example.test' } } },
    { ...page(), metadata: { userName: ['nested'] } },
    { ...page(), metadata: { timestamp: 'not-a-date' } },
    { ...page(), metadata: { userAgent: 'nul\0text' } },
    { ...page(), metadata: { userAgent: '\ud800' } },
    { ...service(), metadata: {} },
    { ...service(), metadata: null },
    { ...service(), metadata: { serviceId: '' } },
    { ...service(), metadata: { serviceId: 42 } },
    JSON.parse('{"eventName":"page_view","metadata":{"__proto__":{"polluted":true}}}'),
  ];
  for (const body of bad) assert.equal((await app.send(body)).statusCode, 400);
  assert.equal(app.writes.length, 0);
  assert.equal({}.polluted, undefined);
});

test('field bounds use UTF-8 bytes and reject oversize values instead of truncating', async () => {
  const app = ingestion();
  const bad = [
    { ...page(), path: 'x'.repeat(501) },
    { ...page(), sessionId: 'x'.repeat(101) },
    { ...page(), metadata: { userAgent: 'x'.repeat(2049) } },
    { ...page(), metadata: { userAgent: '\u0627'.repeat(1025) } },
    { ...page(), metadata: { userName: '\u4e2d'.repeat(134) } },
    { ...page(), metadata: { userEmail: 'x'.repeat(1025) } },
    { ...service(), metadata: { serviceId: 'x'.repeat(201) } },
    { ...service(), metadata: { serviceId: 'ok', serviceName: 'x'.repeat(1025) } },
    { ...page(), metadata: { userAgent: 'x'.repeat(2 * 1024 * 1024) } },
    { ...page(), metadata: { userAgent: '\\'.repeat(2048) } },
  ];
  for (const body of bad) assert.equal((await app.send(body)).statusCode, 413);
  assert.equal(app.writes.length, 0);
  const valid = { ...page(), metadata: { userAgent: '\ud83d\ude00'.repeat(512), userName: '\u0627'.repeat(200) } };
  assert.equal((await app.send(valid)).statusCode, 202);
  assert.deepEqual(JSON.parse(app.writes[0].metadata), valid.metadata);
});

test('metadata accepts exactly 4096 serialized bytes and rejects one extra byte', async () => {
  const app = ingestion();
  const body = service();
  body.metadata = { serviceId: 'ok', userAgent: 'a'.repeat(2048), userEmail: 'b'.repeat(1024), userName: 'c'.repeat(400), serviceName: '' };
  body.metadata.serviceName = 'd'.repeat(4096 - Buffer.byteLength(JSON.stringify(body.metadata)));
  assert.equal(Buffer.byteLength(JSON.stringify(body.metadata)), 4096);
  assert.equal((await app.send(body)).statusCode, 202);
  assert.equal(Buffer.byteLength(app.writes[0].metadata), 4096);
  body.metadata.serviceName += 'd';
  assert.equal((await app.send(body)).statusCode, 413);
  assert.equal(app.writes.length, 1);
});

function cutoff(days) {
  const date = new Date(NOW);
  date.setDate(date.getDate() - days);
  return date;
}

function event(id, eventName, createdAt, sessionId = null, metadata = null, eventPath = null) {
  return { id, eventName, createdAt, sessionId, metadata: metadata === null ? null : JSON.stringify(metadata), path: eventPath };
}

test('summary queries run only against an isolated in-memory PostgreSQL database', { timeout: 60000 }, async t => {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = await PGlite.create();
  const calls = [];
  // Minimal ephemeral fixtures, not project migrations or a connection to a real database.
  await pg.exec(`
    CREATE TABLE "AnalyticsEvent" (id text PRIMARY KEY, "eventName" text NOT NULL, "sessionId" text, path text, metadata text, "createdAt" timestamp NOT NULL);
    CREATE TABLE "User" (id text PRIMARY KEY, role text NOT NULL);
    CREATE TABLE "Order" (id text PRIMARY KEY);
    CREATE TABLE "DhruService" (id text PRIMARY KEY, "dhruId" text UNIQUE, name text NOT NULL);
    INSERT INTO "User" VALUES ('a','admin'), ('b','user'), ('c','user'), ('d','reseller');
    INSERT INTO "Order" VALUES ('a'), ('b'), ('c');
    INSERT INTO "DhruService" VALUES ('popular','provider::popular','Popular service'), ('new','provider::new','New service');
    SET TIME ZONE 'America/New_York';
    SET work_mem = '8MB';
  `);
  const prisma = {
    async $transaction(callback, options) {
      assert.equal(options.isolationLevel, 'RepeatableRead');
      assert.equal(options.maxWait, 1000);
      assert.equal(options.timeout, 10000);
      return pg.transaction(async sql => {
        await sql.exec('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        const run = async (strings, ...values) => {
          const text = strings.reduce((query, part, index) => query + (index ? `$${index}` : '') + part, '');
          const call = { text, values, rows: [] };
          calls.push(call);
          const result = await sql.query(text, values.map(value => value instanceof Date ? value.toISOString() : value));
          call.rows = result.rows;
          return result.rows;
        };
        return callback({ $queryRaw: run, $executeRaw: run });
      });
    },
  };
  const app = loadAnalytics(prisma);
  const summary = days => invoke(app.routes.get('get /summary'), { query: days === undefined ? {} : { days } });
  async function seed(rows) {
    await pg.exec('TRUNCATE "AnalyticsEvent"');
    if (rows.length) await pg.query(`INSERT INTO "AnalyticsEvent"
      SELECT id, "eventName", "sessionId", path, metadata, "createdAt"
      FROM json_to_recordset($1::json) AS input(id text, "eventName" text, "sessionId" text, path text, metadata text, "createdAt" timestamp)`, [JSON.stringify(rows)]);
    calls.length = 0;
  }
  const fixture = [];
  for (let i = 0; i < 250; i++) {
    fixture.push(event(`old-${String(i).padStart(4, '0')}`, 'service_view', new Date(Date.parse('2026-10-10T00:00:00Z') + i * 1000).toISOString(), `session-${i % 140}`, { serviceId: 'provider::popular', userAgent: 'Old browser' }, '/purchase'));
  }
  for (let i = 0; i < 180; i++) {
    const isService = i % 3 === 0;
    fixture.push(event(`new-${String(i).padStart(4, '0')}`, isService ? 'service_view' : 'page_view', new Date(Date.parse('2026-10-31T00:00:00Z') + i * 1000).toISOString(), `session-${i % 160}`, isService ? { serviceId: `service-${i % 13}` } : { userName: 'Visitor' }, '/ar/pricing'));
  }
  fixture.push(event('legacy', 'checkout_started', '2026-10-31T23:59:59.999Z'));
  fixture.push(event('proto', '__proto__', '2026-11-01T00:00:00.000Z'));
  fixture.push(event('constructor', 'constructor', '2026-11-01T00:00:00.001Z'));
  fixture.push(event('anonymous', 'service_view', '2026-11-01T00:00:01.000Z', '', { serviceName: 'Unnamed historical service' }));
  fixture.push(event('future', 'page_view', '2026-11-02T00:00:00.000Z'));
  fixture.push(event('outside30', 'page_view', '2026-10-01T00:00:00.000Z'));

  try {
    await t.test('all-window counts and rankings stay accurate beyond detail limits', async () => {
      await seed(fixture);
      const response = await summary('30');
      assert.equal(response.statusCode, 200, JSON.stringify(app.errors));
      const data = response.body.data;
      const recent = fixture.filter(row => new Date(row.createdAt) >= cutoff(30));
      const expectedCounts = Object.create(null);
      const expectedDaily = new Map();
      const expectedViews = new Map();
      const firstSessions = new Map();
      for (const row of [...recent].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))) {
        expectedCounts[row.eventName] = (expectedCounts[row.eventName] || 0) + 1;
        const day = row.createdAt.slice(0, 10);
        const daily = expectedDaily.get(day) || Object.assign(Object.create(null), { day });
        daily[row.eventName] = (daily[row.eventName] || 0) + 1;
        expectedDaily.set(day, daily);
        if (row.sessionId && !firstSessions.has(row.sessionId)) firstSessions.set(row.sessionId, row);
        const id = row.metadata && JSON.parse(row.metadata).serviceId;
        if (row.eventName === 'service_view' && id) expectedViews.set(id, (expectedViews.get(id) || 0) + 1);
      }
      const descending = (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
      assert.equal(data.totalUsers, 2);
      assert.equal(data.totalOrders, 3);
      assert.equal(data.uniqueSessions, firstSessions.size);
      assert.deepEqual(data.counts, JSON.parse(JSON.stringify(expectedCounts)));
      assert.deepEqual(data.daily, JSON.parse(JSON.stringify([...expectedDaily.values()])));
      assert.deepEqual(data.topServices.map(({ id, views }) => [id, views]), [...expectedViews].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 10));
      assert.equal(data.topServices[0].name, 'Popular service', 'provider IDs resolve without loading the whole catalog');
      assert.equal(data.serviceViewLogs.length, 100);
      assert.deepEqual(data.serviceViewLogs.map(row => row.id), recent.filter(row => row.eventName === 'service_view').sort(descending).slice(0, 100).map(row => row.id));
      assert.equal(data.visitorLogs.length, 100);
      assert.deepEqual(data.visitorLogs.map(row => row.id), [...firstSessions.values()].sort(descending).slice(0, 100).map(row => row.id));
      assert.equal(data.serviceViewLogs[0].serviceName, 'Unnamed historical service');
      assert.equal(data.serviceViewLogs[0].path, '/purchase');
      assert.equal(data.counts.__proto__, 1);
      assert.equal(data.counts.constructor, 1);
      assert.equal({}.polluted, undefined);

      assert.equal(calls.length, 9, 'four local settings and five bounded result queries');
      assert.match(calls[0].text, /READ ONLY/);
      assert.match(calls[1].text, /statement_timeout = '5s'/);
      assert.match(calls[2].text, /work_mem = '4MB'/);
      assert.match(calls[3].text, /TIME ZONE 'UTC'/);
      const logs = calls.find(call => /WITH selected/.test(call.text));
      assert.ok(logs.rows.length <= 200);
      assert.equal(logs.values.filter(value => value === 100).length, 2);
      assert.ok(logs.rows.every(row => row.metadata === null || Buffer.byteLength(row.metadata) <= 4096));
      const names = calls.find(call => /unnest/.test(call.text));
      assert.ok(names.values.find(Array.isArray).length <= 110);
      const settings = (await pg.query("SELECT current_setting('TimeZone') AS tz, current_setting('work_mem') AS memory, current_setting('statement_timeout') AS timeout")).rows[0];
      assert.deepEqual(settings, { tz: 'America/New_York', memory: '8MB', timeout: '0' });
    });

    await t.test('7, 30, 90 and default periods preserve complete totals and UTC days', async () => {
      await seed(fixture);
      for (const [query, days] of [['7', 7], ['90', 90], ['invalid', 30], [undefined, 30]]) {
        const response = await summary(query);
        assert.equal(response.statusCode, 200, JSON.stringify(app.errors));
        assert.equal(response.body.data.days, days);
        assert.equal(Object.values(response.body.data.counts).reduce((sum, value) => sum + value, 0), fixture.filter(row => new Date(row.createdAt) >= cutoff(days)).length);
        assert.equal(response.body.data.daily.find(row => row.day === '2026-11-01').__proto__, 1);
      }
    });

    await t.test('empty analytics still returns user/order totals with empty details', async () => {
      await seed([]);
      const response = await summary();
      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.body.data, { days: 30, totalUsers: 2, totalOrders: 3, uniqueSessions: 0, counts: {}, daily: [], topServices: [], visitorLogs: [], serviceViewLogs: [] });
      assert.equal(calls.some(call => /unnest/.test(call.text)), false);
    });

    await t.test('large historical metadata outside details still contributes to service totals', async () => {
      const rows = Array.from({ length: 120 }, (_, i) => event(`recent-${i}`, 'service_view', '2026-10-31T00:00:00Z', null, { serviceId: 'new' }));
      rows.push(event('historical-large', 'service_view', '2026-10-10T00:00:00Z', null, { serviceId: 'popular', padding: 'x'.repeat(100000) }));
      await seed(rows);
      const response = await summary('30');
      assert.equal(response.statusCode, 200, JSON.stringify(app.errors));
      assert.equal(response.body.data.counts.service_view, 121);
      assert.deepEqual(response.body.data.topServices.map(({ id, views }) => [id, views]), [['new', 120], ['popular', 1]]);
      assert.equal(response.body.data.serviceViewLogs.length, 100);
      assert.ok(calls.find(call => /WITH selected/.test(call.text)).rows.every(row => !row.metadata.includes('padding')));
      assert.equal((await pg.query('SELECT octet_length(metadata) AS bytes FROM "AnalyticsEvent" WHERE id=$1', ['historical-large'])).rows[0].bytes > 100000, true);
    });

    await t.test('unsafe legacy detail or malformed JSON returns explicit 503, never partial totals', async () => {
      const oversized = event('large', 'page_view', NOW, 'visitor', { userAgent: 'x'.repeat(4097) });
      const malformedService = { ...event('malformed-service', 'service_view', NOW), metadata: '{not json' };
      const malformedVisitor = { ...event('malformed-page', 'page_view', NOW, 'visitor'), metadata: '{not json' };
      const invalidId = event('bad-id', 'service_view', NOW, null, { serviceId: { nested: true } });
      for (const row of [oversized, malformedService, malformedVisitor, invalidId]) {
        await seed([row]);
        const response = await summary();
        assert.equal(response.statusCode, 503);
        assert.equal(response.body.code, 'ANALYTICS_REPORT_UNAVAILABLE');
        assert.equal(response.body.data, undefined);
        if (row === oversized) {
          const selected = calls.find(call => /WITH selected/.test(call.text)).rows[0];
          assert.equal(selected.metadata, null, 'oversized text must not cross the database result boundary');
          assert.equal(selected.oversized, true);
        }
        assert.equal((await pg.query('SELECT count(*) AS count FROM "AnalyticsEvent"')).rows[0].count, 1);
      }
    });

    await t.test('legacy aggregate cardinality overflow fails instead of truncating totals', async () => {
      await seed(Array.from({ length: 10001 }, (_, i) => event(`group-${i}`, `historical-${i}`, NOW)));
      const response = await summary();
      assert.equal(response.statusCode, 503);
      assert.equal(response.body.data, undefined);
      const grouped = calls.find(call => /to_char/.test(call.text));
      assert.equal(grouped.rows.length, 10001);
      assert.ok(grouped.values.includes(10001));
      assert.equal(calls.some(call => /WITH selected/.test(call.text)), false);
    });
  } finally {
    await pg.close();
  }
});

test('query-budget failures return 503 without starting alternative unbounded work', async () => {
  let transactions = 0;
  const app = loadAnalytics({ $transaction: async () => {
    transactions++;
    throw Object.assign(new Error('statement timeout'), { code: 'P2010' });
  } });
  const response = await invoke(app.routes.get('get /summary'), { query: {} });
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'ANALYTICS_REPORT_UNAVAILABLE');
  assert.equal(response.body.data, undefined);
  assert.equal(transactions, 1);
});
