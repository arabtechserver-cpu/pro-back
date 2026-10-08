const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
process.env.JWT_SECRET = 'isolated-memory-test-secret-at-least-32-characters';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.NODE_ENV = 'test';
delete process.env.TELEGRAM_BOT_TOKEN;
const { prisma } = require('./dist/utils/prisma');
after(() => prisma.$disconnect());
const { BoundedCache } = require('./dist/utils/bounded-cache');
const { AsyncGate } = require('./dist/utils/async-gate');
const { BoundedRateLimitStore } = require('./dist/utils/bounded-rate-limit-store');
const { writeBackupSnapshot } = require('./dist/utils/streaming-backup');
const { createResourceGuard } = require('./dist/middleware/resourceGuard');
const otp = require('./dist/utils/adminOtp');

test('cache obeys byte, entry, LRU and non-sliding expiration bounds', () => {
  const oldNow = Date.now;
  let now = 1000; Date.now = () => now;
  try {
    const cache = new BoundedCache(2, 300, 100);
    cache.set('a', 'small'); cache.set('b', 'small');
    cache.get('a'); cache.set('c', 'small');
    assert.equal(cache.get('b'), undefined);
    assert.equal(cache.set('oversized', 'x'.repeat(1000)), false);
    assert.ok(cache.retainedBytes <= 300);
    now += 99; assert.equal(cache.get('a'), 'small');
    now++; assert.equal(cache.get('a'), undefined);
    assert.equal(cache.size, 0); assert.equal(cache.retainedBytes, 0);
  } finally { Date.now = oldNow; }
});

test('rate limiter at capacity denies new identities without resetting existing counters', async () => {
  const oldNow = Date.now; let now = 1000; Date.now = () => now;
  try {
  const store = new BoundedRateLimitStore(2);
  store.init({ windowMs: 10 });
  await store.increment('a'); await store.increment('b');
  assert.equal((await store.increment('c')).totalHits, Number.MAX_SAFE_INTEGER);
  assert.equal((await store.increment('a')).totalHits, 2);
  now += 11;
  assert.equal((await store.increment('c')).totalHits, 1);
  } finally { Date.now = oldNow; }
});

test('provider gate bounds queued work and releases slots after success and failure', async () => {
  const gate = new AsyncGate(1, 1, 1000);
  let release, running = 0, peak = 0;
  const first = gate.run(async () => { peak = Math.max(peak, ++running); await new Promise(r => { release = r; }); running--; });
  const second = gate.run(async () => { peak = Math.max(peak, ++running); running--; throw new Error('expected'); });
  const rejectedSecond = assert.rejects(second, /expected/);
  await assert.rejects(gate.run(async () => {}), /busy/);
  release(); await first; await rejectedSecond;
  await gate.run(async () => {}); assert.equal(peak, 1);
  const timeoutGate = new AsyncGate(1, 1, 5);
  let unblock;
  const held = timeoutGate.run(() => new Promise(r => { unblock = r; }));
  await assert.rejects(timeoutGate.run(async () => {}), /timed out/);
  unblock(); await held; await timeoutGate.run(async () => {});
});

test('backups stream all rows with correct cursors, large-field pages and valid empty JSON', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'arad-stream-test-'));
  const records = Array.from({ length: 53 }, (_, i) => ({ id: String(i).padStart(3, '0'), text: 'اختبار', quote: '"\\' }));
  const calls = [];
  const model = { async findMany(query) {
    calls.push(query);
    assert.deepEqual(query.orderBy, { id: 'asc' });
    const start = query.cursor ? records.findIndex(row => row.id === query.cursor.id) + query.skip : 0;
    return records.slice(start, start + query.take);
  } };
  try {
    const file = path.join(dir, 'backup.json');
    const counts = await writeBackupSnapshot(file, { users: { model }, transactions: { model } }, {}, { totalUsers: 'users' });
    const result = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.deepEqual(result.users, records); assert.deepEqual(result.transactions, records);
    assert.equal(counts.users, 53); assert.equal(result.summary.totalUsers, 53);
    assert.ok(calls.slice(3).every(query => query.take === 1));
    await writeBackupSnapshot(file, {}, {}, {});
    assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')), { summary: {} });
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('disconnected heavy mutations keep their slot; queued work resumes only after completion', async () => {
  const guard = createResourceGuard(2, 1, 10, 1000);
  function response() {
    const res = new EventEmitter();
    Object.assign(res, { setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; }, end() {} });
    return res;
  }
  const req = Object.assign(new EventEmitter(), { path: '/api/transactions', method: 'POST', complete: true });
  const first = response(); let admitted = 0;
  await guard(req, first, () => admitted++);
  first.destroyed = true; first.emit('close');
  const waiting = response(); const queued = guard(req, waiting, () => admitted++);
  await Promise.resolve(); assert.equal(waiting.statusCode, undefined); assert.equal(admitted, 1);
  first.end(); first.emit('finish');
  await queued; assert.equal(admitted, 2); waiting.emit('finish');
});

test('scheduler allows small reads past a busy large job and removes cancelled waiters', async () => {
  const { RequestScheduler } = require('./dist/utils/request-scheduler');
  const scheduler = new RequestScheduler(2, 1, 2, 1000);
  const heavy = await scheduler.acquire(true);
  const controller = new AbortController();
  const queued = scheduler.acquire(true, controller.signal);
  const rejection = assert.rejects(queued, /REQUEST_ABORTED/);
  const read = await scheduler.acquire(false); // Does not wait behind the large job.
  controller.abort(); await rejection; read(); heavy();
  const next = await scheduler.acquire(true); next();
  const serial = new RequestScheduler(1, 1, 1, 5);
  const held = await serial.acquire(false);
  const waiting = serial.acquire(false);
  const timedOut = assert.rejects(waiting, /QUEUE_TIMEOUT/);
  await assert.rejects(serial.acquire(false), /QUEUE_FULL/);
  await timedOut; held(); (await serial.acquire(false))();
});

test('admin OTP is one-use, replacement invalidates old challenges, resends preserve attempts and expiry', () => {
  const oldNow = Date.now; let now = 1000000; Date.now = () => now;
  const user = { id: 'test-admin', username: 'admin', email: 'admin@example.test' };
  try {
    const old = otp.createAdminOtpChallenge(user), current = otp.createAdminOtpChallenge(user);
    assert.equal(otp.verifyAdminOtp(old.challengeToken, old.code).success, false);
    assert.equal(otp.verifyAdminOtp(current.challengeToken, current.code).success, true);
    assert.equal(otp.verifyAdminOtp(current.challengeToken, current.code).success, false);
    const guessing = otp.createAdminOtpChallenge(user);
    for (let i = 0; i < 4; i++) assert.equal(otp.verifyAdminOtp(guessing.challengeToken, 'not-a-code').success, false);
    now += 61000;
    const resent = otp.resendAdminOtp(guessing.challengeToken); assert.equal(resent.success, true);
    assert.notEqual(resent.code, guessing.code);
    otp.verifyAdminOtp(guessing.challengeToken, 'bad');
    assert.equal(otp.verifyAdminOtp(guessing.challengeToken, resent.code).success, false);
    const expired = otp.createAdminOtpChallenge(user); now += 240000;
    const lastResend = otp.resendAdminOtp(expired.challengeToken); assert.equal(lastResend.success, true);
    now += 60001;
    assert.equal(otp.verifyAdminOtp(expired.challengeToken, lastResend.code).success, false);
  } finally { Date.now = oldNow; }
});

test('concurrent user OTP sends reserve once and valid reset code permits only one password update', async () => {
  const email = require('./dist/utils/emailService');
  const oldEmail = email.sendOtpEmailViaLoops, oldFind = prisma.user.findUnique, oldUpdate = prisma.user.update;
  const delivered = []; let updates = 0;
  email.sendOtpEmailViaLoops = async (_, body) => { delivered.push(body.code); };
  prisma.user.findUnique = async () => { await new Promise(r => setImmediate(r)); return { id: 'otp-user' }; };
  prisma.user.update = async () => { updates++; return {}; };
  const router = require('./dist/routes/auth').default;
  const handler = route => router.stack.find(layer => layer.route?.path === route).route.stack.at(-1).handle;
  const response = () => ({ statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
  const oldLog = console.log, logs = []; console.log = (...args) => logs.push(args.join(' '));
  try {
    const body = { email: 'otp-race@example.test', type: 'forgot_password' };
    const sends = [response(), response()];
    await Promise.all(sends.map(res => handler('/send-otp')({ body }, res)));
    assert.equal(delivered.length, 1); assert.equal(sends.filter(res => res.statusCode === 429).length, 1);
    assert.ok(logs.every(line => !line.includes(delivered[0])));
    const resets = [response(), response()];
    await Promise.all(resets.map(res => handler('/forgot-password')({ body: { email: body.email, otp: delivered[0], newPassword: 'strong-password-123!' } }, res)));
    assert.equal(updates, 1); assert.equal(resets.filter(res => res.body.success).length, 1);
    const registration = response();
    await handler('/send-otp')({ body: { email: 'purpose@example.test', type: 'registration' } }, registration);
    const misuse = response();
    await handler('/forgot-password')({ body: { email: 'purpose@example.test', otp: delivered.at(-1), newPassword: 'strong-password-123!' } }, misuse);
    assert.equal(misuse.body.success, false); assert.equal(updates, 1);
  } finally { email.sendOtpEmailViaLoops = oldEmail; prisma.user.findUnique = oldFind; prisma.user.update = oldUpdate; console.log = oldLog; }
});

test('application connection pool preserves explicit settings', () => {
  const { databaseClientUrl } = require('./dist/utils/database-client-url');
  assert.equal(new URL(databaseClientUrl('postgresql://a:b@localhost/db')).searchParams.get('connection_limit'), '2');
  assert.equal(new URL(databaseClientUrl('postgresql://a:b@localhost/db?connection_limit=7')).searchParams.get('connection_limit'), '7');
});

test('32 simultaneous public pricing requests share a single DB read and serialized snapshot', async () => {
  const oldFind = prisma.dhruCategory.findMany;
  let calls = 0;
  prisma.dhruCategory.findMany = async () => {
    calls++; await new Promise(resolve => setImmediate(resolve));
    return [{ id: 'catalog-test', name: 'Server Service', dhruServices: [{ id: 'service-test', name: 'Test Service', credit: 2, margin: 8, info: '', groupName: 'Group', isActive: true }] }];
  };
  const module = require('./dist/routes/dhru'); module.invalidateDhruServicesCache();
  const handler = module.default.stack.find(layer => layer.route?.path === '/services').route.stack.at(-1).handle;
  const response = () => ({ headers: {}, setHeader(key, value) { this.headers[key] = value; }, type() { return this; }, status(code) { this.statusCode = code; return this; }, send(body) { this.body = body; return this; }, end() {}, json(body) { this.error = body; } });
  try {
    const responses = Array.from({ length: 32 }, response);
    await Promise.all(responses.map(res => handler({ query: { view: 'pricing' }, headers: {} }, res)));
    assert.equal(calls, 1); assert.ok(responses.every(res => res.body === responses[0].body));
    const parsed = JSON.parse(responses[0].body); assert.equal(parsed[0].services[0].id, 'service-test');
    assert.equal(parsed[0].services[0].credit, undefined);
    const unchanged = response();
    await handler({ query: {}, headers: { 'if-none-match': responses[0].headers.ETag } }, unchanged);
    assert.equal(unchanged.statusCode, 304); assert.equal(calls, 1);
    module.invalidateDhruServicesCache();
    await handler({ query: {}, headers: {} }, response()); assert.equal(calls, 2);
  } finally { prisma.dhruCategory.findMany = oldFind; module.invalidateDhruServicesCache(); }
});
