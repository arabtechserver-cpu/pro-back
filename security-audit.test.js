const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const sharp = require('sharp');
const axios = require('axios');
const jwt = require('jsonwebtoken');
process.env.JWT_SECRET = 'security-audit-isolated-secret-at-least-32-characters';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.NODE_ENV = 'production';
delete process.env.TELEGRAM_BOT_TOKEN;
const { prisma } = require('./dist/utils/prisma');
after(() => prisma.$disconnect());
const { sanitizeImageDataUri, InvalidImageError } = require('./dist/utils/safe-image');
const { browserWriteGuard } = require('./dist/middleware/browserWriteGuard');
const { publicImageGuard } = require('./dist/middleware/publicFileGuard');
const { getTrustedProxies } = require('./dist/utils/trustedProxy');
const { turnstileMiddleware } = require('./dist/middleware/turnstileMiddleware');
const binance = require('./dist/services/binanceService');
function response() {
  return { statusCode: 200, headers: {}, status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }, setHeader(key, value) { this.headers[key] = value; } };
}
const uri = (type, buffer) => `data:image/${type};base64,${buffer.toString('base64')}`;

test('valid raster uploads are decoded and metadata/trailing payloads are discarded', async () => {
  for (const format of ['jpeg', 'png', 'webp', 'gif']) {
    const source = await sharp({ create: { width: 8, height: 8, channels: 3, background: 'red' } })
      .withMetadata().toFormat(format).toBuffer();
    const result = await sanitizeImageDataUri(uri(format, source), true);
    const metadata = await sharp(result.buffer).metadata();
    assert.equal(metadata.format, 'webp');
    assert.equal(metadata.width, 8);
    assert.equal(metadata.exif, undefined);
  }
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  const payload = Buffer.from('<script>injected-payload</script>');
  const clean = await sanitizeImageDataUri(uri('png', Buffer.concat([png, payload])));
  assert.equal(clean.buffer.includes(payload), false);
});

test('upload decoder rejects signatures without real images, SVG, bad base64, mismatched MIME and oversized dimensions', async () => {
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer();
  for (const input of [null, {}, uri('png', Buffer.from([0x89,0x50,0x4e,0x47])),
    uri('jpeg', png), uri('svg+xml', Buffer.from('<svg/>')), 'data:image/png;base64,###',
    uri('png', png).replace(/=+$/, '') + '=garbage']) {
    await assert.rejects(() => sanitizeImageDataUri(input), InvalidImageError);
  }
  const big = await sharp({ create: { width: 4001, height: 4000, channels: 3, background: 'red' } }).png().toBuffer();
  await assert.rejects(() => sanitizeImageDataUri(uri('png', big)), InvalidImageError);
});

test('browser writes reject foreign/subdomain origins, cross-site forms and originless session cookies', () => {
  for (const headers of [{ origin: 'https://attacker.example' }, { origin: 'https://evil.arabtechproserver.tech' },
    { origin: 'http://localhost:3000' }, { origin: 'null' }, { 'sec-fetch-site': 'cross-site' },
    { cookie: 'admin_token=session' }, { cookie: 'other=x; user_token=session' }]) {
    const res = response(); let passed = false;
    browserWriteGuard({ method: 'POST', headers }, res, () => { passed = true; });
    assert.equal(passed, false); assert.equal(res.statusCode, 403);
  }
  for (const headers of [{ origin: 'https://arabtechproserver.tech', cookie: 'admin_token=session' },
    { authorization: 'Bearer server-client' }, {}]) {
    let passed = false;
    browserWriteGuard({ method: 'POST', headers }, response(), () => { passed = true; });
    assert.equal(passed, true);
  }
});

test('public images, deposit receipts and article thumbnails reject executable payloads before database writes', async () => {
  const image = uri('svg+xml', Buffer.from('<svg onload="alert(1)"/>'));
  const entries = [
    ['upload', '/', { image }],
    ['transactions', '/', { amount: 10, method: 'test', refNo: 'test', receiptImage: image }],
    ['blog', '/post', { titleEn: 'test', imageUrl: image }]
  ];
  const originalFind = prisma.transaction.findFirst, originalCount = prisma.transaction.count;
  prisma.transaction.findFirst = async () => null;
  prisma.transaction.count = async () => 0;
  try {
    for (const [module, path, body] of entries) {
      const router = require(`./dist/routes/${module}`).default;
      const handler = router.stack.find(layer => layer.route?.path === path && layer.route.methods.post).route.stack.at(-1).handle;
      const res = response(); await handler({ body, user: { id: 'test-user' } }, res);
      assert.equal(res.statusCode, 400, module);
    }
  } finally { prisma.transaction.findFirst = originalFind; prisma.transaction.count = originalCount; }
});

test('deposit admission checks precede image work and every failed save cleans only its own receipt', async () => {
  const router = require('./dist/routes/transactions').default;
  const handler = router.stack.find(layer => layer.route?.path === '/' && layer.route.methods.post).route.stack.at(-1).handle;
  const images = require('./dist/utils/safe-image');
  const telegram = require('./dist/utils/telegramService');
  const original = {
    find: prisma.transaction.findFirst, count: prisma.transaction.count, transaction: prisma.$transaction,
    user: prisma.user.findUnique, sanitize: images.sanitizeImageDataUri, notify: telegram.sendTelegramPhotoNotification,
    open: fs.promises.open, uploads: process.env.UPLOADS_DIR, random: crypto.randomBytes, error: console.error
  };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arad-receipt-cleanup-'));
  const image = uri('png', await sharp({ create: { width: 2, height: 2, channels: 3, background: 'red' } }).png().toBuffer());
  const scenarios = [
    ['duplicate-pending', 400, false], ['duplicate-completed', 400, false], ['cooldown', 429, false], ['daily-limit', 429, false],
    ['race-pending', 400, false], ['race-completed', 400, false], ['race-cooldown', 429, false], ['race-limit', 429, false],
    ['rollback', 500, false], ['partial-write', 500, false], ['existing-file', 500, false],
    ['success', 200, true], ['post-commit-error', 500, true]
  ];
  try {
    console.error = () => {};
    telegram.sendTelegramPhotoNotification = async () => {};
    for (const [scenario, expectedStatus, committed] of scenarios) {
      const dir = path.join(root, scenario);
      fs.mkdirSync(dir);
      process.env.UPLOADS_DIR = dir;
      let decoded = 0, writes = 0;
      images.sanitizeImageDataUri = async (...args) => { decoded++; return original.sanitize(...args); };
      const state = scenario.replace(/^race-/, 'duplicate-');
      const checks = rejection => ({
        findFirst: async query => query.where.refNo
          ? (rejection.endsWith('pending') || rejection.endsWith('completed') ? { status: rejection.endsWith('pending') ? 'pending' : 'completed' } : null)
          : (rejection.endsWith('cooldown') ? { id: 'recent' } : null),
        count: async () => rejection.endsWith('limit') ? 5 : 0,
        create: async ({ data }) => { writes++; return { id: 'test-deposit', ...data }; }
      });
      const preflight = checks(scenario.startsWith('race-') ? '' : scenario);
      prisma.transaction.findFirst = preflight.findFirst;
      prisma.transaction.count = preflight.count;
      prisma.$transaction = async (work, options) => {
        assert.equal(options.isolationLevel, 'Serializable');
        const result = await work({ transaction: checks(scenario.startsWith('race-') ? state : '') });
        if (scenario === 'rollback') throw new Error('isolated transaction rollback');
        return result;
      };
      prisma.user.findUnique = async () => {
        if (scenario === 'post-commit-error') throw new Error('isolated post-commit failure');
        return null;
      };
      fs.promises.open = async (...args) => {
        const file = await original.open(...args);
        if (scenario === 'partial-write') {
          const write = file.writeFile.bind(file);
          file.writeFile = async buffer => { await write(buffer.subarray(0, 1)); throw new Error('isolated disk write failure'); };
        }
        return file;
      };
      if (scenario === 'existing-file') {
        crypto.randomBytes = () => Buffer.alloc(16, 1);
        fs.mkdirSync(path.join(dir, 'receipts'));
        fs.writeFileSync(path.join(dir, 'receipts', `receipt_${Buffer.alloc(16, 1).toString('hex')}.webp`), 'existing receipt');
      } else crypto.randomBytes = original.random;
      const res = response();
      await handler({ body: { amount: 10, method: 'test', refNo: 'isolated-ref', receiptImage: image }, user: { id: 'test-user' } }, res);
      assert.equal(res.statusCode, expectedStatus, scenario);
      const receipts = path.join(dir, 'receipts');
      const files = fs.existsSync(receipts) ? fs.readdirSync(receipts) : [];
      assert.equal(files.length, committed || scenario === 'existing-file' ? 1 : 0, scenario);
      if (['duplicate-pending', 'duplicate-completed', 'cooldown', 'daily-limit'].includes(scenario)) {
        assert.equal(decoded, 0, scenario); assert.equal(writes, 0, scenario);
      }
      if (committed) {
        assert.equal(writes, 1, scenario);
        assert.equal((await sharp(fs.readFileSync(path.join(receipts, files[0]))).metadata()).format, 'webp');
      }
      if (scenario === 'existing-file') assert.equal(fs.readFileSync(path.join(receipts, files[0]), 'utf8'), 'existing receipt');
    }
  } finally {
    prisma.transaction.findFirst = original.find; prisma.transaction.count = original.count;
    prisma.$transaction = original.transaction; prisma.user.findUnique = original.user;
    images.sanitizeImageDataUri = original.sanitize; telegram.sendTelegramPhotoNotification = original.notify;
    fs.promises.open = original.open; crypto.randomBytes = original.random; console.error = original.error;
    if (original.uploads === undefined) delete process.env.UPLOADS_DIR; else process.env.UPLOADS_DIR = original.uploads;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public media denies executable files and encoded receipts; proxy trust defaults to none', () => {
  for (const path of ['/payload.html', '/shell.php', '/image.svg', '/%72eceipts/image.png', '/%2572eceipts/image.png']) {
    const res = response(); let passed = false;
    publicImageGuard({ path }, res, () => { passed = true; }); assert.equal(passed, false);
  }
  let passed = false;
  publicImageGuard({ path: '/article_uuid.webp' }, response(), () => { passed = true; }); assert.equal(passed, true);
  const old = process.env.TRUSTED_PROXY_CIDRS;
  try { delete process.env.TRUSTED_PROXY_CIDRS; assert.equal(getTrustedProxies(), false); }
  finally { if (old === undefined) delete process.env.TRUSTED_PROXY_CIDRS; else process.env.TRUSTED_PROXY_CIDRS = old; }
});

test('production Turnstile fails closed for disable flags, invalid secrets, failed verification and wrong hostnames', async () => {
  const keys = ['TURNSTILE_SECRET', 'DISABLE_TURNSTILE', 'DISABLE_CLOUDFLARE', 'NEXT_PUBLIC_DISABLE_TURNSTILE', 'STRICT_TURNSTILE'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const oldFetch = global.fetch;
  try {
    keys.forEach(key => delete process.env[key]); process.env.TURNSTILE_SECRET = 'isolated-test-secret';
    for (const result of [
      { success: false, 'error-codes': ['hostname-mismatch'] },
      { success: false, 'error-codes': ['invalid-input-secret'] },
      { success: true, hostname: 'attacker.example' }, { success: 'true', hostname: 'arabtechproserver.tech' },
      { success: true, hostname: 'arabtechproserver.tech' }
    ]) {
      global.fetch = async () => ({ ok: true, json: async () => result });
      const res = response(); let passed = false;
      await turnstileMiddleware({ body: { turnstileToken: 'valid-test-token' }, headers: {}, socket: {} }, res, () => { passed = true; });
      assert.equal(passed, result.success === true && result.hostname === 'arabtechproserver.tech');
    }
    for (const key of ['DISABLE_TURNSTILE', 'DISABLE_CLOUDFLARE', 'NEXT_PUBLIC_DISABLE_TURNSTILE']) {
      process.env[key] = 'true'; let passed = false; const res = response();
      await turnstileMiddleware({ body: {}, headers: {}, socket: {} }, res, () => { passed = true; });
      assert.equal(passed, false); assert.equal(res.statusCode, 503); delete process.env[key];
    }
  } finally {
    global.fetch = oldFetch;
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  }
});

test('AI customer middleware cannot read account data using revoked or versionless JWTs', async () => {
  const router = require('./dist/routes/ai').default;
  const middleware = router.stack.find(layer => layer.route?.path === '/chat').route.stack[1].handle;
  const find = prisma.user.findUnique;
  prisma.user.findUnique = async () => ({ id: 'user', role: 'user', status: 'active', tokenVersion: 9 });
  try {
    for (const version of [undefined, 8, 9]) {
      const token = jwt.sign({ id: 'user', ...(version === undefined ? {} : { tokenVersion: version }) }, process.env.JWT_SECRET);
      const req = { headers: { authorization: `Bearer ${token}` }, query: {}, originalUrl: '/api/ai/chat' };
      await middleware(req, response(), () => {});
      assert.equal(Boolean(req.user), version === 9);
    }
  } finally { prisma.user.findUnique = find; }
});

test('authentication distinguishes invalid sessions from lookup failures for safe logout', async () => {
  const { authenticateToken } = require('./dist/middleware/auth');
  const originalFind = prisma.user.findUnique, originalError = console.error;
  const token = jwt.sign({ id: 'admin-test', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  const request = value => ({ headers: { authorization: `Bearer ${value}` }, query: {}, originalUrl: '/api/auth/logout' });
  let lookups = 0, admitted = 0;
  try {
    console.error = () => {};
    prisma.user.findUnique = async () => { lookups++; throw new Error('isolated database failure'); };
    const unavailable = response();
    await authenticateToken(request(token), unavailable, () => admitted++);
    assert.equal(unavailable.statusCode, 503);
    assert.equal(unavailable.body.code, 'AUTH_UNAVAILABLE');
    assert.equal(admitted, 0);
    for (const invalid of ['invalid-token', jwt.sign({ id: 'admin-test', tokenVersion: 1 }, process.env.JWT_SECRET, { expiresIn: -1 })]) {
      const res = response();
      await authenticateToken(request(invalid), res, () => admitted++);
      assert.equal(res.statusCode, 401); assert.equal(res.body.code, 'INVALID_SESSION');
    }
    assert.equal(lookups, 1);
    prisma.user.findUnique = async () => ({ id: 'admin-test', role: 'admin', status: 'active', tokenVersion: 2 });
    const revoked = response();
    await authenticateToken(request(token), revoked, () => admitted++);
    assert.equal(revoked.statusCode, 401); assert.equal(revoked.body.code, 'INVALID_SESSION');
    prisma.user.findUnique = async () => ({ id: 'admin-test', role: 'admin', status: 'active', tokenVersion: 1 });
    await authenticateToken(request(token), response(), () => admitted++);
    assert.equal(admitted, 1);
  } finally { prisma.user.findUnique = originalFind; console.error = originalError; }
});

test('server limits both analytics aliases before parsing large bodies without changing webhook bytes', async () => {
  const express = require('express');
  const expressModule = require.cache[require.resolve('express')];
  const serverPath = require.resolve('./dist/server');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arad-parser-test-'));
  const keys = ['UPLOADS_DIR', 'STARTUP_MAINTENANCE', 'BACKGROUND_JOBS_ENABLED'];
  const environment = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const listeners = Object.fromEntries(['uncaughtException', 'unhandledRejection'].map(name => [name, new Set(process.listeners(name))]));
  const originalVerify = binance.verifyBinanceWebhookSignature, originalError = console.error, originalLog = console.log;
  let server, capturedRawBody;
  try {
    const source = fs.readFileSync(path.join(__dirname, 'src', 'server.ts'), 'utf8');
    assert.ok(source.indexOf("app.use('/api', globalApiLimiter)") < source.indexOf('app.use(createResourceGuard())'));
    process.env.UPLOADS_DIR = root;
    process.env.STARTUP_MAINTENANCE = 'false';
    process.env.BACKGROUND_JOBS_ENABLED = 'false';
    console.error = () => {}; console.log = () => {};
    expressModule.exports = Object.assign(() => {
      const app = express();
      const listen = app.listen;
      app.listen = (_port, _host, callback) => {
        server = listen.call(app, 0, '127.0.0.1', callback);
        return server;
      };
      return app;
    }, express);
    binance.verifyBinanceWebhookSignature = async (_headers, rawBody) => { capturedRawBody = rawBody; return false; };
    require(serverPath);
    expressModule.exports = express;
    assert.ok(server);
    await once(server, 'listening');
    const base = `http://127.0.0.1:${server.address().port}`;
    const send = (route, body) => fetch(`${base}${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body,
      signal: AbortSignal.timeout(3000)
    });
    const oversized = JSON.stringify({ eventName: 'page_view', padding: 'x'.repeat(9000) });
    for (const alias of ['analytics', 'telemetry']) {
      const res = await send(`/api/${alias}/events`, oversized);
      assert.equal(res.status, 413, alias);
      assert.equal((await res.json()).error, 'Request body exceeds the allowed size', alias);
    }
    assert.equal((await send('/api/unknown-parser-test', oversized)).status, 404);
    const raw = '{ "bizStatus" : "PAY_SUCCESS", "data" : {} }';
    assert.equal((await send('/api/wallet/binance/webhook', raw)).status, 401);
    assert.equal(capturedRawBody.toString('utf8'), raw);
    const health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    assert.equal(health.status, 200);
    assert.equal(health.headers.has('x-ratelimit-limit'), false);
  } finally {
    expressModule.exports = express;
    binance.verifyBinanceWebhookSignature = originalVerify;
    console.error = originalError; console.log = originalLog;
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    for (const name of Object.keys(listeners)) {
      for (const listener of process.listeners(name)) if (!listeners[name].has(listener)) process.removeListener(name, listener);
    }
    for (const key of keys) { if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key]; }
    delete require.cache[serverPath];
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Binance cryptographic validation rejects unsigned, stale and altered webhooks; matching paid events credit exactly once', async () => {
  const pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const originalPost = axios.post, originalQuery = binance.queryBinanceOrder;
  const originalFind = prisma.paymentIntent.findUnique, originalTransaction = prisma.$transaction;
  const membership = require('./dist/utils/membershipUpgrade'), telegram = require('./dist/utils/telegramService');
  const originalUpgrade = membership.checkAndAutoUpgradeMembership, originalNotify = telegram.sendTelegramPhotoNotification;
  const savedKey = process.env.BINANCE_PAY_API_KEY, savedSecret = process.env.BINANCE_PAY_SECRET_KEY;
  process.env.BINANCE_PAY_API_KEY = 'isolated-key'; process.env.BINANCE_PAY_SECRET_KEY = 'isolated-secret';
  let certCalls = 0, credited = 0, writes = 0, completed = false;
  const intent = { id: 'intent', userId: 'owner', orderId: 'payment-test', amount: 10, currency: 'USDT', status: 'created' };
  let paid = { merchantTradeNo: 'payment-test', status: 'PAID', orderAmount: 10, currency: 'USDT', transactionId: 'capture-test' };
  const raw = Buffer.from('{ "bizStatus": "PAY_SUCCESS", "data": { "merchantTradeNo": "payment-test" } }');
  const headers = { 'binancepay-timestamp': Date.now().toString(), 'binancepay-nonce': 'A'.repeat(32), 'binancepay-certificate-sn': 'test-cert' };
  const signed = (body = raw) => ({ ...headers, 'binancepay-signature': crypto.sign('RSA-SHA256',
    Buffer.concat([Buffer.from(`${headers['binancepay-timestamp']}\n${headers['binancepay-nonce']}\n`), body, Buffer.from('\n')]), pair.privateKey).toString('base64') });
  axios.post = async () => { certCalls++; return { data: { status: 'SUCCESS', data: [{ certSerial: 'test-cert', certPublic: pair.publicKey.export({ type: 'spki', format: 'pem' }) }] } }; };
  binance.queryBinanceOrder = async () => paid;
  prisma.paymentIntent.findUnique = async () => intent;
  prisma.$transaction = async callback => callback({
    paymentIntent: { updateMany: async () => { if (completed) return { count: 0 }; completed = true; return { count: 1 }; } },
    transaction: { create: async () => { writes++; return {}; } },
    user: { update: async () => { credited += 10; return { fullName: 'Test', username: 'test', balance: credited }; } }
  });
  membership.checkAndAutoUpgradeMembership = async () => {};
  telegram.sendTelegramPhotoNotification = async () => {};
  try {
    assert.equal(await binance.verifyBinanceWebhookSignature({}, raw), false); assert.equal(certCalls, 0);
    assert.equal(await binance.verifyBinanceWebhookSignature(signed(), raw), true);
    assert.equal(await binance.verifyBinanceWebhookSignature(signed(), Buffer.from('{}')), false);
    assert.equal(await binance.verifyBinanceWebhookSignature({ ...signed(), 'binancepay-timestamp': '1000000000000' }, raw), false);
    const handler = require('./dist/routes/binance').default.stack.find(layer => layer.route?.path === '/webhook').route.stack.at(-1).handle;
    const unsigned = response(); await handler({ headers: {}, rawBody: raw, body: JSON.parse(raw) }, unsigned);
    assert.equal(unsigned.statusCode, 401); assert.equal(credited, 0);
    for (const changes of [{ orderAmount: 0 }, { orderAmount: 9.99 }, { currency: 'USD' }, { merchantTradeNo: 'other' }, { status: 'PENDING' }, { transactionId: undefined }]) {
      const correct = paid; paid = { ...correct, ...changes }; const res = response();
      await handler({ headers: signed(), rawBody: raw, body: JSON.parse(raw) }, res);
      assert.equal(res.statusCode, 409); assert.equal(credited, 0); paid = correct;
    }
    for (let i = 0; i < 2; i++) {
      const res = response(); await handler({ headers: signed(), rawBody: raw, body: JSON.parse(raw) }, res);
      assert.equal(res.statusCode, 200);
    }
    assert.equal(credited, 10); assert.equal(writes, 1); assert.equal(certCalls, 1);
    binance.queryBinanceOrder = async () => { throw new Error('provider unavailable'); };
    const retry = response(); await handler({ headers: signed(), rawBody: raw, body: JSON.parse(raw) }, retry);
    assert.equal(retry.statusCode, 503);
  } finally {
    axios.post = originalPost; binance.queryBinanceOrder = originalQuery;
    prisma.paymentIntent.findUnique = originalFind; prisma.$transaction = originalTransaction;
    membership.checkAndAutoUpgradeMembership = originalUpgrade; telegram.sendTelegramPhotoNotification = originalNotify;
    if (savedKey === undefined) delete process.env.BINANCE_PAY_API_KEY; else process.env.BINANCE_PAY_API_KEY = savedKey;
    if (savedSecret === undefined) delete process.env.BINANCE_PAY_SECRET_KEY; else process.env.BINANCE_PAY_SECRET_KEY = savedSecret;
  }
});
