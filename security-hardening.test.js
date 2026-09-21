const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');

process.env.JWT_SECRET = 'isolated-security-test-secret-1234567890';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.NODE_ENV = 'test';
delete process.env.TELEGRAM_BOT_TOKEN;

const { publicFileGuard } = require('./dist/middleware/publicFileGuard');
const { getTrustedProxies } = require('./dist/utils/trustedProxy');
const { extractClientIp } = require('./dist/utils/ipUtils');
const { prisma } = require('./dist/utils/prisma');
const { authenticateToken, optionalAuth } = require('./dist/middleware/auth');
const { parsePayPalRefund, applyPayPalRefund } = require('./dist/services/paypalRefunds');

after(async () => { await prisma.$disconnect(); });

function response() {
  return { statusCode: 200, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } };
}

async function serve(app, run) {
  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  try {
    await run((url, headers = {}, method = 'GET') => new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: url, headers, method }, res => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      });
      req.on('error', reject);
      req.end();
    }));
  } finally { await new Promise(resolve => server.close(resolve)); }
}

test('public static middleware blocks encoded receipts while allowing images and authenticated routes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'arad-receipt-test-'));
  try {
    fs.mkdirSync(path.join(dir, 'receipts'));
    fs.writeFileSync(path.join(dir, 'receipts', 'receipt_test.png'), 'private');
    fs.writeFileSync(path.join(dir, 'image.png'), 'public');
    const app = express();
    app.use('/uploads', publicFileGuard, express.static(dir));
    app.get('/api/transactions/id/receipt', (req, res) => res.status(401).end());
    await serve(app, async request => {
      for (const url of [
        '/uploads/receipts/receipt_test.png',
        '/uploads/%72eceipts/%72eceipt_test.png',
        '/uploads/RECEIPTS/RECEIPT_test.png',
        '/uploads/%72eceipts%2f%72eceipt_test.png',
        '/uploads/%72eceipts%5c%72eceipt_test.png',
        '/uploads/receipts/../receipts/receipt_test.png'
      ]) {
        for (const method of ['GET', 'HEAD']) {
          const result = await request(url, {}, method);
          assert.equal(result.status, 403, `${method} ${url}`);
          assert.equal(result.headers['cache-control'], 'private, no-store');
        }
      }
      assert.equal((await request('/uploads/%2572eceipts/%2572eceipt_test.png')).status, 400);
      assert.equal((await request('/uploads/%ZZ')).status, 400);
      assert.equal((await request('/uploads/image.png')).body, 'public');
      assert.equal((await request('/api/transactions/id/receipt')).status, 401);
    });
  } finally {
    assert.ok(dir.startsWith(path.join(os.tmpdir(), 'arad-receipt-test-')));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('JWTs without a version, revoked versions, and wrong types cannot authenticate', async () => {
  const original = prisma.user.findUnique;
  prisma.user.findUnique = async () => ({ id: 'user-test', role: 'user', status: 'active', tokenVersion: 8 });
  try {
    for (const version of [undefined, 1, '8', null, 8]) {
      const claims = { id: 'user-test', ...(version === undefined ? {} : { tokenVersion: version }) };
      const token = jwt.sign(claims, process.env.JWT_SECRET, { expiresIn: '1h' });
      for (const middleware of [authenticateToken, optionalAuth]) {
        const req = { headers: { authorization: `Bearer ${token}` }, query: {}, originalUrl: '/api/wallet' };
        const res = response();
        await middleware(req, res, () => {});
        assert.equal(Boolean(req.user), version === 8);
        if (middleware === authenticateToken && version !== 8) assert.equal(res.statusCode, 401);
      }
    }
  } finally { prisma.user.findUnique = original; }
});

test('public upload UUID cannot expose a stored receipt', async () => {
  const uploads = require('./dist/utils/uploads');
  const originalPath = uploads.getUploadFilePath;
  const originalFind = prisma.storedImage.findFirst;
  try {
    uploads.getUploadFilePath = () => null;
    prisma.storedImage.findFirst = async () => ({ filename: 'receipt_private.png', mimeType: 'image/png', data: 'cHJpdmF0ZQ==' });
    const router = require('./dist/routes/upload').default;
    const handler = router.stack.find(layer => layer.route?.path === '/:id' && layer.route.methods.get).route.stack[0].handle;
    const res = { ...response(), setHeader() {} };
    await handler({ params: { id: 'image-uuid' } }, res);
    assert.equal(res.statusCode, 403);
  } finally {
    uploads.getUploadFilePath = originalPath;
    prisma.storedImage.findFirst = originalFind;
  }
});

test('unsigned PayPal refunds are rejected before any ledger or wallet change', async () => {
  const paypal = require('./dist/services/paypalService');
  const refunds = require('./dist/services/paypalRefunds');
  const originalVerify = paypal.verifyPayPalWebhookSignature;
  const originalApply = refunds.applyPayPalRefund;
  let changes = 0;
  try {
    paypal.verifyPayPalWebhookSignature = async () => ({ verified: false, error: 'invalid test signature' });
    refunds.applyPayPalRefund = async () => { changes++; };
    const router = require('./dist/routes/paypal').default;
    const handler = router.stack.find(layer => layer.route?.path === '/webhook').route.stack[0].handle;
    const res = response();
    await handler({ headers: {}, body: refundEvent() }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(changes, 0);
  } finally {
    paypal.verifyPayPalWebhookSignature = originalVerify;
    refunds.applyPayPalRefund = originalApply;
  }
});

test('IP resolution ignores spoofed headers and trusts only configured proxy addresses', async () => {
  assert.equal(getTrustedProxies(''), false);
  for (const config of ['true', '1', '0.0.0.0/0', '::/0', 'loopback', '10.0.0.1/33']) {
    assert.throws(() => getTrustedProxies(config));
  }
  for (const [config, expected] of [['', '127.0.0.1'], ['127.0.0.1', '198.51.100.7']]) {
    const app = express();
    app.set('trust proxy', getTrustedProxies(config));
    app.get('/', (req, res) => res.send(extractClientIp(req)));
    await serve(app, async request => {
      const result = await request('/', {
        'cf-connecting-ip': '8.8.8.8', 'x-real-ip': '8.8.4.4',
        'x-forwarded-for': '1.1.1.1, 198.51.100.7'
      });
      assert.equal(result.body, expected);
    });
  }
  assert.equal(extractClientIp({ headers: {} }), '');
});

function refundEvent(id = 'REFUND1', amount = '3.00', type = 'PAYMENT.CAPTURE.REFUNDED') {
  return {
    id: `EVENT-${id}`, event_type: type,
    resource: {
      id, amount: { value: amount, currency_code: 'USD' },
      links: [{ rel: 'up', href: 'https://api.paypal.com/v2/payments/captures/CAPTURE1' }]
    }
  };
}

test('PayPal refund ID is resolved from the capture link or related ID, never the refund ID', () => {
  assert.equal(parsePayPalRefund(refundEvent()).captureId, 'CAPTURE1');
  const related = refundEvent();
  related.resource.links = [];
  related.resource.supplementary_data = { related_ids: { capture_id: 'CAPTURE2' } };
  assert.equal(parsePayPalRefund(related).captureId, 'CAPTURE2');
  related.resource.links = refundEvent().resource.links;
  assert.throws(() => parsePayPalRefund(related), /Conflicting/);
  const hostile = refundEvent();
  hostile.resource.links[0].href = 'https://api.paypal.com.attacker.test/v2/payments/captures/CAPTURE1';
  assert.throws(() => parsePayPalRefund(hostile), /Missing/);
  for (const amount of ['-3', '0', 'Infinity', '3garbage', '0.001', '9007199254740992']) {
    assert.throws(() => parsePayPalRefund(refundEvent('BAD', amount)), /Invalid/);
  }
});

test('PostgreSQL migrations and refund ledger preserve balances across retries, partial refunds and rollback', async () => {
  const { PGlite } = require('@electric-sql/pglite');
  const pg = await PGlite.create();
  const readMigration = name => fs.readFileSync(path.join(__dirname, 'prisma/migrations', name, 'migration.sql'), 'utf8');
  try {
    // A database that was falsely marked migrated can run the repair alone.
    const repair = readMigration('20260921000000_repair_skipped_security_baseline');
    await pg.exec(repair);
    await pg.exec(repair); // Also safe on a previously migrated installation.
    await pg.exec(`INSERT INTO "User" ("id","fullName","email","username","password","balance")
      VALUES ('user1','Test','test@example.test','test','unused',10);
      INSERT INTO "PaymentIntent" ("id","userId","orderId","captureId","amount","status")
      VALUES ('intent1','user1','ORDER1','CAPTURE1',10,'completed');
      INSERT INTO "PaymentIntent" ("id","userId","orderId","captureId","amount","status")
      VALUES ('legacy1','user1','ORDER2','CAPTURE2',10,'refunded');
      INSERT INTO "Transaction" ("id","userId","type","amount","method","status","refNo")
      VALUES ('legacy-tx','user1','refund',3,'PayPal Reversal','completed','PAYPAL_REVERSAL_CAPTURE2_EVENT-LEGACY');`);
    await pg.exec(readMigration('20260921001000_paypal_refund_ledger'));
    assert.deepEqual((await pg.query('SELECT "status","refundedAmount" FROM "PaymentIntent" WHERE id=$1', ['legacy1'])).rows[0],
      { status: 'partially_refunded', refundedAmount: 3 });

    // Adapter executes the service's queries against real, ephemeral PostgreSQL;
    // no production credentials, network, or database are used.
    let failDebit = false;
    const db = { $transaction: callback => pg.transaction(async sql => {
      const insert = async (table, data) => {
        const record = { id: require('crypto').randomUUID(), ...data };
        const keys = Object.keys(record);
        return (await sql.query(`INSERT INTO "${table}" (${keys.map(k => `"${k}"`).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`, Object.values(record))).rows[0];
      };
      return callback({
        $queryRaw: async (strings, ...values) => (await sql.query(strings.reduce((s, part, i) => s + (i ? `$${i}` : '') + part, ''), values)).rows,
        paymentIntent: {
          findUniqueOrThrow: async ({ where }) => (await sql.query('SELECT * FROM "PaymentIntent" WHERE id=$1', [where.id])).rows[0],
          update: async ({ where, data }) => sql.query('UPDATE "PaymentIntent" SET "refundedAmount"=$1,status=$2 WHERE id=$3', [data.refundedAmount, data.status, where.id])
        },
        paymentRefund: {
          findFirst: async ({ where }) => (await sql.query('SELECT * FROM "PaymentRefund" WHERE "resourceId"=$1 OR "eventId"=$2', [where.OR[0].resourceId, where.OR[1].eventId])).rows[0],
          create: ({ data }) => insert('PaymentRefund', data)
        },
        transaction: { create: ({ data }) => insert('Transaction', data) },
        user: { update: async ({ where, data }) => {
          if (failDebit) throw new Error('simulated database failure');
          return sql.query('UPDATE "User" SET balance=balance-$1 WHERE id=$2', [data.balance.decrement, where.id]);
        } }
      });
    }) };
    const state = async () => (await pg.query('SELECT balance, "refundedAmount",p.status FROM "User" u JOIN "PaymentIntent" p ON p."userId"=u.id WHERE p.id=$1', ['intent1'])).rows[0];

    const duplicate = await Promise.all([applyPayPalRefund(db, refundEvent()), applyPayPalRefund(db, refundEvent())]);
    assert.equal(duplicate.filter(item => !item.duplicate).length, 1);
    assert.deepEqual(await state(), { balance: 7, refundedAmount: 3, status: 'partially_refunded' });
    const retry = refundEvent(); retry.id = 'DIFFERENT-EVENT-SAME-REFUND';
    assert.equal((await applyPayPalRefund(db, retry)).duplicate, true);
    await assert.rejects(applyPayPalRefund(db, refundEvent('OVER', '8.00')), /remaining/);
    const mismatch = refundEvent('WRONG'); mismatch.resource.amount.currency_code = 'EUR';
    await assert.rejects(applyPayPalRefund(db, mismatch), /currency/);
    failDebit = true;
    await assert.rejects(applyPayPalRefund(db, refundEvent('FAIL', '1.00')), /simulated/);
    failDebit = false;
    assert.equal((await pg.query('SELECT id FROM "PaymentRefund" WHERE "eventId"=$1', ['EVENT-FAIL'])).rows.length, 0);
    assert.equal((await state()).balance, 7);
    await applyPayPalRefund(db, refundEvent('PART2', '2.00'));
    await applyPayPalRefund(db, refundEvent('CAPTURE1', '10.00', 'PAYMENT.CAPTURE.REVERSED'));
    assert.deepEqual(await state(), { balance: 0, refundedAmount: 10, status: 'refunded' });
    assert.equal((await applyPayPalRefund(db, refundEvent('CAPTURE1', '10.00', 'PAYMENT.CAPTURE.REVERSED'))).duplicate, true);
    const unknown = refundEvent('UNKNOWN'); unknown.resource.links[0].href = 'https://api.paypal.com/v2/payments/captures/UNKNOWN';
    await assert.rejects(applyPayPalRefund(db, unknown), error => error.status === 503);
  } finally { await pg.close(); }
});

test('OTP email success and failure logs never contain the verification code or subject', async () => {
  const https = require('node:https');
  const { EventEmitter } = require('node:events');
  const logs = [];
  const originals = { request: https.request, log: console.log, warn: console.warn, error: console.error };
  process.env.RESEND_API_KEY = 'test-only-key';
  delete require.cache[require.resolve('./dist/utils/emailService')];
  const { sendOtpEmail } = require('./dist/utils/emailService');
  try {
    for (const key of ['log', 'warn', 'error']) console[key] = (...args) => logs.push(args.join(' '));
    for (const status of [202, 400]) {
      https.request = (options, callback) => {
        const request = new EventEmitter();
        request.write = () => {};
        request.end = () => {
          const res = new EventEmitter(); res.statusCode = status;
          callback(res);
          res.emit('data', 'provider-error-containing-654321'); res.emit('end');
        };
        return request;
      };
      await sendOtpEmail('test@example.test', { code: '654321', username: 'test' });
    }
    assert.ok(logs.length > 0);
    assert.ok(logs.every(line => !line.includes('654321')));
  } finally {
    https.request = originals.request;
    for (const key of ['log', 'warn', 'error']) console[key] = originals[key];
    delete process.env.RESEND_API_KEY;
  }
});
