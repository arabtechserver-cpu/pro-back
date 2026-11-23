const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-1234567890abcdef1234567890';

const { prisma } = require('./dist/utils/prisma');

function getRouteHandler(router, method, routePath) {
  const layer = router.stack.find((l) => l.route?.path === routePath && l.route.methods?.[method.toLowerCase()]);
  if (!layer) throw new Error(`Route not found: ${method} ${routePath}`);
  const stack = layer.route.stack.map((s) => s.handle);
  return stack[stack.length - 1];
}

function makeRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    downloaded: null,
    set() { return this; },
    setHeader(name, val) {
      this.headers[name.toLowerCase()] = val;
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
    download(filePath, fileName) {
      this.downloaded = { filePath, fileName };
      return this;
    }
  };
}

function loadRouter() {
  delete require.cache[require.resolve('./dist/routes/mobileCashier')];
  return require('./dist/routes/mobileCashier').default;
}

test('GET /product downloadUrl resolution and GET /download streaming', async () => {
  const origFindMany = prisma.cashierPlan.findMany;
  const origUrl = process.env.MOBILE_CASHIER_DOWNLOAD_URL;
  const origInstallerPath = process.env.MOBILE_CASHIER_INSTALLER_PATH;
  const origNodeEnv = process.env.NODE_ENV;

  prisma.cashierPlan.findMany = async () => [];

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'arpro-dl-test-'));
  const fakeExe = path.join(tmpDir, 'ar-pro-Setup-9.9.9.exe');
  fs.writeFileSync(fakeExe, 'MZ-test-installer');

  try {
    // 1. HTTPS MOBILE_CASHIER_DOWNLOAD_URL takes priority
    process.env.MOBILE_CASHIER_DOWNLOAD_URL = 'https://cdn.arabproserver.com/ar-pro-Setup-1.2.2.exe';
    process.env.MOBILE_CASHIER_INSTALLER_PATH = fakeExe;
    let router = loadRouter();
    let res = makeRes();
    await getRouteHandler(router, 'GET', '/product')({}, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.downloadUrl, 'https://cdn.arabproserver.com/ar-pro-Setup-1.2.2.exe');

    // 2. Falls back to /api/mobile-cashier/download when MOBILE_CASHIER_INSTALLER_PATH exists
    process.env.MOBILE_CASHIER_DOWNLOAD_URL = 'http://insecure.example.com/setup.exe';
    process.env.MOBILE_CASHIER_INSTALLER_PATH = fakeExe;
    res = makeRes();
    await getRouteHandler(router, 'GET', '/product')({}, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.downloadUrl, '/api/mobile-cashier/download');

    // 3. GET /download serves configured file when present
    res = makeRes();
    await getRouteHandler(router, 'GET', '/download')({}, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/octet-stream');
    assert.deepEqual(res.downloaded, { filePath: fakeExe, fileName: 'ar-pro-Setup-9.9.9.exe' });

    // 4. Rejects non-HTTPS URL and returns null in production when no local installer is configured
    delete process.env.MOBILE_CASHIER_INSTALLER_PATH;
    process.env.MOBILE_CASHIER_DOWNLOAD_URL = 'http://insecure.example.com/setup.exe';
    process.env.NODE_ENV = 'production';
    router = loadRouter();
    res = makeRes();
    await getRouteHandler(router, 'GET', '/product')({}, res, () => {});
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.downloadUrl, null);

    // 5. GET /download returns 404 when no installer exists
    res = makeRes();
    await getRouteHandler(router, 'GET', '/download')({}, res, () => {});
    assert.equal(res.statusCode, 404);
    assert.equal(res.body.code, 'INSTALLER_UNAVAILABLE');
  } finally {
    prisma.cashierPlan.findMany = origFindMany;
    if (origUrl === undefined) delete process.env.MOBILE_CASHIER_DOWNLOAD_URL;
    else process.env.MOBILE_CASHIER_DOWNLOAD_URL = origUrl;
    if (origInstallerPath === undefined) delete process.env.MOBILE_CASHIER_INSTALLER_PATH;
    else process.env.MOBILE_CASHIER_INSTALLER_PATH = origInstallerPath;
    if (origNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = origNodeEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
