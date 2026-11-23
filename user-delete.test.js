const test = require('node:test');
const assert = require('node:assert/strict');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890abcdef1234567890';

const { prisma } = require('./dist/utils/prisma');

function getRouteHandlers(router, method, path) {
  const layer = router.stack.find((l) => l.route?.path === path && l.route.methods?.[method.toLowerCase()]);
  if (!layer) throw new Error(`Route not found: ${method} ${path}`);
  // Return final route handler (skipping isAdmin middleware which is tested separately)
  const stack = layer.route.stack.map((s) => s.handle);
  return stack[stack.length - 1];
}

function makeRes() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    }
  };
}

function loadUsersRouter() {
  delete require.cache[require.resolve('./dist/routes/users')];
  return require('./dist/routes/users').default;
}

test('GET /api/users filters deletedAt: null in findMany and stats counts', async () => {
  const origFindMany = prisma.user.findMany;
  const origCount = prisma.user.count;
  const capturedFindMany = [];
  const capturedCounts = [];

  prisma.user.findMany = async (args) => {
    capturedFindMany.push(args);
    return [];
  };
  prisma.user.count = async (args) => {
    capturedCounts.push(args);
    return 0;
  };

  try {
    const router = loadUsersRouter();
    const handler = getRouteHandlers(router, 'GET', '/');
    const res = makeRes();
    await handler({ query: { q: 'mina', status: 'suspended' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(capturedFindMany.length, 1);
    assert.equal(capturedFindMany[0].where.deletedAt, null);
    assert.equal(capturedCounts.length, 3);
    for (const c of capturedCounts) {
      assert.equal(c.where.deletedAt, null);
    }
  } finally {
    prisma.user.findMany = origFindMany;
    prisma.user.count = origCount;
  }
});

test('DELETE /api/users/:id hard-deletes users without financial records (including walletTransaction)', async () => {
  const origUser = { ...prisma.user };
  const origTx = { ...prisma.transaction };
  const origOrder = { ...prisma.order };
  const origIntent = { ...prisma.paymentIntent };
  const origPurchase = { ...prisma.cashierPurchase };
  const origWalletTx = { ...prisma.walletTransaction };
  const origTransaction = prisma.$transaction;

  const calls = [];
  prisma.user.findUnique = async () => ({
    id: 'user-no-fin-1',
    email: 'clean@example.test',
    username: 'cleanuser',
    role: 'user',
    deletedAt: null
  });
  prisma.transaction.findFirst = async () => null;
  prisma.order.findFirst = async () => null;
  prisma.paymentIntent.findFirst = async () => null;
  prisma.cashierPurchase.findFirst = async () => null;
  prisma.$transaction = async (cb) =>
    cb({
      walletTransaction: {
        deleteMany: async (args) => {
          calls.push({ op: 'walletTransaction.deleteMany', args });
          return { count: 1 };
        }
      },
      user: {
        delete: async (args) => {
          calls.push({ op: 'user.delete', args });
          return {};
        }
      }
    });

  try {
    const router = loadUsersRouter();
    const handler = getRouteHandlers(router, 'DELETE', '/:id');
    const res = makeRes();
    await handler({ params: { id: 'user-no-fin-1' }, user: { id: 'admin-1', role: 'super_admin' } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.archived, false);
    assert.deepEqual(calls, [
      { op: 'walletTransaction.deleteMany', args: { where: { userId: 'user-no-fin-1' } } },
      { op: 'user.delete', args: { where: { id: 'user-no-fin-1' } } }
    ]);
  } finally {
    Object.assign(prisma.user, origUser);
    Object.assign(prisma.transaction, origTx);
    Object.assign(prisma.order, origOrder);
    Object.assign(prisma.paymentIntent, origIntent);
    Object.assign(prisma.cashierPurchase, origPurchase);
    Object.assign(prisma.walletTransaction, origWalletTx);
    prisma.$transaction = origTransaction;
  }
});

test('DELETE /api/users/:id archives user with any financial record, releases identifiers, and is idempotent', async () => {
  const relationCases = ['transaction', 'order', 'paymentIntent', 'cashierPurchase'];

  for (const rel of relationCases) {
    const origUser = { ...prisma.user };
    const origTx = { ...prisma.transaction };
    const origOrder = { ...prisma.order };
    const origIntent = { ...prisma.paymentIntent };
    const origPurchase = { ...prisma.cashierPurchase };

    const updates = [];
    let currentUser = {
      id: '7c627a41-a6a2-441e-8783-c36e7767e5b6',
      email: 'mina15g4y@gmail.com',
      username: 'mina15g4y',
      role: 'user',
      deletedAt: null
    };

    prisma.user.findUnique = async () => currentUser;
    prisma.transaction.findFirst = async () => (rel === 'transaction' ? { id: 'tx-1' } : null);
    prisma.order.findFirst = async () => (rel === 'order' ? { id: 'ord-1' } : null);
    prisma.paymentIntent.findFirst = async () => (rel === 'paymentIntent' ? { id: 'pi-1' } : null);
    prisma.cashierPurchase.findFirst = async () => (rel === 'cashierPurchase' ? { id: 'cp-1' } : null);
    prisma.user.update = async (args) => {
      updates.push(args);
      currentUser = { ...currentUser, ...args.data };
      return currentUser;
    };

    try {
      const router = loadUsersRouter();
      const handler = getRouteHandlers(router, 'DELETE', '/:id');

      const res1 = makeRes();
      await handler({ params: { id: currentUser.id }, user: { id: 'admin-1', role: 'super_admin' } }, res1);
      assert.equal(res1.statusCode, 200);
      assert.equal(res1.body.success, true);
      assert.equal(res1.body.archived, true);

      const data1 = updates[0].data;
      assert.equal(data1.status, 'suspended');
      assert.ok(data1.deletedAt instanceof Date);
      assert.equal(data1.googleSub, null);
      assert.equal(data1.apiEnabled, false);
      assert.equal(data1.apiKey, null);
      assert.deepEqual(data1.tokenVersion, { increment: 1 });
      assert.match(data1.email, /^deleted_7c627a41_[a-z0-9]+__mina15g4y@gmail\.com$/);
      assert.match(data1.username, /^deleted_7c627a41_[a-z0-9]+__mina15g4y$/);

      // Second DELETE call must preserve existing prefixed email/username & deletedAt
      const res2 = makeRes();
      await handler({ params: { id: currentUser.id }, user: { id: 'admin-1', role: 'super_admin' } }, res2);
      assert.equal(res2.statusCode, 200);
      assert.equal(updates[1].data.email, data1.email);
      assert.equal(updates[1].data.username, data1.username);
      assert.equal(updates[1].data.deletedAt, data1.deletedAt);
    } finally {
      Object.assign(prisma.user, origUser);
      Object.assign(prisma.transaction, origTx);
      Object.assign(prisma.order, origOrder);
      Object.assign(prisma.paymentIntent, origIntent);
      Object.assign(prisma.cashierPurchase, origPurchase);
    }
  }
});

test('POST user mutation routes return 404 for soft-deleted users', async () => {
  const origFindUnique = prisma.user.findUnique;
  const origUpdateMany = prisma.user.updateMany;
  const origUpdate = prisma.user.update;

  prisma.user.findUnique = async () => ({
    id: 'archived-user-1',
    role: 'user',
    status: 'suspended',
    deletedAt: new Date()
  });
  prisma.user.updateMany = async ({ where }) => {
    assert.equal(where.deletedAt, null);
    return { count: 0 };
  };
  prisma.user.update = async ({ where }) => {
    assert.equal(where.deletedAt, null);
    const err = new Error('Record to update not found.');
    err.code = 'P2025';
    throw err;
  };

  try {
    const router = loadUsersRouter();
    const cases = [
      { path: '/toggle-status', body: { userId: 'archived-user-1', newStatus: 'active' } },
      { path: '/change-password', body: { userId: 'archived-user-1', newPassword: 'NewStrongPassword1!' } },
      { path: '/update-balance', body: { userId: 'archived-user-1', newBalance: 10 } },
      { path: '/update-api-settings', body: { userId: 'archived-user-1', apiEnabled: true } }
    ];

    for (const c of cases) {
      const handler = getRouteHandlers(router, 'POST', c.path);
      const res = makeRes();
      await handler({ body: c.body, user: { id: 'admin-1', role: 'super_admin' } }, res);
      assert.equal(res.statusCode, 404, `Expected 404 for ${c.path}`);
    }
  } finally {
    prisma.user.findUnique = origFindUnique;
    prisma.user.updateMany = origUpdateMany;
    prisma.user.update = origUpdate;
  }
});
