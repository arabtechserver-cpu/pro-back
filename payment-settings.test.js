const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const http = require('node:http');

process.env.JWT_SECRET = 'test-jwt-secret-for-security-hardening-tests-only-min-32-chars';
process.env.DATABASE_URL = 'postgresql://test:test@127.0.0.1:1/unused';
process.env.NODE_ENV = 'test';

const { prisma } = require('./dist/utils/prisma');

test('Payment methods validation, sanitation and persistence', async (t) => {
  let dbStore = {};

  prisma.setting = {
    findUnique: async ({ where }) => {
      const val = dbStore[where.key];
      return val ? { key: where.key, value: val } : null;
    },
    upsert: async ({ where, update, create }) => {
      const val = update?.value || create?.value;
      dbStore[where.key] = val;
      return { key: where.key, value: val };
    }
  };

  prisma.user = {
    findUnique: async ({ where }) => {
      if (where.id === 'admin1' || where.email === 'admin@test.com') {
        return {
          id: 'admin1',
          username: 'admin',
          email: 'admin@test.com',
          role: 'admin',
          status: 'active',
          tokenVersion: 1
        };
      }
      return null;
    }
  };

  const { loadConfig, saveConfig } = require('./dist/routes/currencies');

  const initial = await loadConfig();
  assert.ok(initial.bankak, 'Should have bankak config');
  assert.ok(initial.cryptoBnb, 'Should have cryptoBnb config');

  const testConfig = {
    ...initial,
    bankak: {
      ...initial.bankak,
      accountNumber: '99887766',
      accountName: 'Test Beneficiary'
    },
    cryptoBnb: {
      ...initial.cryptoBnb,
      address: '0x9999999999999999999999999999999999999999',
      transferName: 'BNB-SECURE'
    },
    customMethods: [
      {
        id: 'usdt_trc20',
        nameAr: 'تيذر USDT (شبكة TRC20)',
        nameEn: 'Tether USDT TRC20',
        type: 'crypto',
        accountOrAddress: 'TX11111111111111111111111111111111',
        network: 'TRON (TRC20)',
        instructionsAr: 'حول لعنوان TRON ثم ارفق الإشعار',
        isActive: true
      }
    ]
  };

  const saved = await saveConfig(testConfig);
  assert.strictEqual(saved, true, 'Saving config to DB store should succeed');

  const reloaded = await loadConfig();
  assert.strictEqual(reloaded.bankak.accountNumber, '99887766');
  assert.strictEqual(reloaded.bankak.accountName, 'Test Beneficiary');
  assert.strictEqual(reloaded.cryptoBnb.address, '0x9999999999999999999999999999999999999999');
  assert.strictEqual(reloaded.cryptoBnb.transferName, 'BNB-SECURE');
  assert.strictEqual(reloaded.customMethods.length, 1);
  assert.strictEqual(reloaded.customMethods[0].id, 'usdt_trc20');

  // Test HTTP endpoints with Express server
  const jwt = require('jsonwebtoken');
  const app = express();
  app.use(express.json());
  const settingsRouter = require('./dist/routes/settings').default;
  app.use('/api/settings', settingsRouter);

  const server = await new Promise(resolve => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;

  const adminToken = jwt.sign(
    { id: 'admin1', email: 'admin@test.com', role: 'admin', tokenVersion: 1 },
    process.env.JWT_SECRET
  );

  const request = (reqPath, method = 'GET', body = null, headers = {}) => {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        path: reqPath,
        method,
        headers: {
          'Content-Type': 'application/json',
          ...headers
        }
      }, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode, data });
          }
        });
      });
      req.on('error', reject);
      if (body) req.write(JSON.stringify(body));
      req.end();
    });
  };

  // 1. Unauthorized request should be 401
  const unauth = await request('/api/settings/payment-methods');
  assert.strictEqual(unauth.status, 401, 'Unauthenticated GET should return 401');

  // 2. Authorized GET should succeed
  const getRes = await request('/api/settings/payment-methods', 'GET', null, {
    Authorization: `Bearer ${adminToken}`
  });
  assert.strictEqual(getRes.status, 200, 'Admin GET should return 200');
  assert.strictEqual(getRes.data.success, true);
  assert.strictEqual(getRes.data.paymentMethods.bankak.accountNumber, '99887766');

  // 3. Authorized POST should update data
  const postRes = await request('/api/settings/payment-methods', 'POST', {
    paymentMethods: {
      ...getRes.data.paymentMethods,
      bankak: {
        ...getRes.data.paymentMethods.bankak,
        nameAr: 'بنك الخرطوم المميز VIP'
      },
      vodafone: {
        nameAr: 'فودافون كاش مصر الرسمي',
        walletNumber: '01000000000',
        instructionsAr: 'تعليمات جديدة',
        instructionsEn: 'New instructions',
        isActive: true
      }
    }
  }, {
    Authorization: `Bearer ${adminToken}`
  });
  assert.strictEqual(postRes.status, 200, 'Admin POST should return 200');
  assert.strictEqual(postRes.data.success, true);
  assert.strictEqual(postRes.data.paymentMethods.bankak.nameAr, 'بنك الخرطوم المميز VIP');
  assert.strictEqual(postRes.data.paymentMethods.vodafone.nameAr, 'فودافون كاش مصر الرسمي');
  assert.strictEqual(postRes.data.paymentMethods.vodafone.walletNumber, '01000000000');

  // 4. Invalid email in PayPal should return 400
  const badPaypal = await request('/api/settings/payment-methods', 'POST', {
    paymentMethods: {
      paypal: {
        email: 'invalid-email-address',
        isActive: true
      }
    }
  }, {
    Authorization: `Bearer ${adminToken}`
  });
  assert.strictEqual(badPaypal.status, 400, 'Invalid email should return 400');

  await new Promise(resolve => server.close(resolve));
});
