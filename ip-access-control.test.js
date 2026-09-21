const assert = require('assert');

// Helper to create mock Express Response
function createMockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    },
    setHeader(key, val) {
      this.headers[key] = val;
      return this;
    }
  };
}

async function runTests() {
  console.log('--- Starting Dashboard IP Access Control Test Suite ---');

  // Test 1: IP Normalization & Validation
  console.log('[Test 1] Testing IP Normalization and Validation...');
  const { normalizeIp, isValidIp, areIpsEqual, extractClientIp, MAX_ALLOWED_IPS } = require('./dist/utils/ipUtils');

  // IPv4 normalizations
  assert.strictEqual(normalizeIp(' 192.168.1.100 '), '192.168.1.100', 'Whitespace should be trimmed');
  assert.strictEqual(normalizeIp('::ffff:192.168.1.100'), '192.168.1.100', 'IPv4-mapped IPv6 prefix should be stripped');
  assert.strictEqual(normalizeIp('::ffff:10.0.0.1'), '10.0.0.1', 'IPv4-mapped IPv6 should be converted to clean IPv4');
  assert.strictEqual(normalizeIp('::1'), '127.0.0.1', 'IPv6 loopback should be normalized to 127.0.0.1');
  assert.strictEqual(normalizeIp('192.168.1.1:8080'), '192.168.1.1', 'IPv4 with port should be stripped');

  // IPv4 & IPv6 validation
  assert.strictEqual(isValidIp('192.168.1.1'), true, 'Valid IPv4');
  assert.strictEqual(isValidIp('::ffff:192.168.1.1'), true, 'Valid IPv4-mapped IPv6');
  assert.strictEqual(isValidIp('2001:0db8:85a3:0000:0000:8a2e:0370:7334'), true, 'Valid IPv6');
  assert.strictEqual(isValidIp('invalid.ip.string'), false, 'Invalid IP should return false');
  assert.strictEqual(isValidIp('999.999.999.999'), false, 'Out-of-range IP should return false');

  // Semantic equality
  assert.strictEqual(areIpsEqual('192.168.1.1', '::ffff:192.168.1.1'), true, 'Equal IPv4 and mapped IPv6');
  assert.strictEqual(areIpsEqual('::1', '127.0.0.1'), true, 'Equal loopbacks');
  assert.strictEqual(areIpsEqual('10.0.0.1', '10.0.0.2'), false, 'Different IPs');
  console.log('✓ Test 1 passed: Normalization and validation working properly.');

  // Test 2: Trusted Proxy & Header Resolution
  console.log('[Test 2] Testing Client IP Extraction from Proxy Headers...');
  const reqCloudflare = {
    headers: {
      'cf-connecting-ip': '203.0.113.195',
      'x-real-ip': '10.0.0.1',
      'x-forwarded-for': '10.0.0.2, 10.0.0.3'
    },
    ip: '10.0.0.4',
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.strictEqual(extractClientIp(reqCloudflare), '10.0.0.4', 'Untrusted CF-Connecting-IP must not override Express resolution');

  const reqXRealIp = {
    headers: {
      'x-real-ip': '198.51.100.42',
      'x-forwarded-for': '10.0.0.2'
    },
    ip: '10.0.0.4'
  };
  assert.strictEqual(extractClientIp(reqXRealIp), '10.0.0.4', 'Untrusted X-Real-IP must not override Express resolution');

  const reqForwarded = {
    headers: {
      'x-forwarded-for': '203.0.113.50, 10.0.0.1, 10.0.0.2'
    },
    ip: '10.0.0.1'
  };
  assert.strictEqual(extractClientIp(reqForwarded), '10.0.0.1', 'Only the IP resolved against trusted proxies is used');

  const reqDirect = {
    headers: {},
    ip: '192.168.1.5'
  };
  assert.strictEqual(extractClientIp(reqDirect), '192.168.1.5', 'req.ip fallback works');
  console.log('✓ Test 2 passed: Trusted proxy header resolution works accurately.');

  // Test 3: Dashboard IP Guard Middleware Logic
  console.log('[Test 3] Testing Dashboard IP Guard Middleware...');
  const { dashboardIpGuard } = require('./dist/middleware/dashboardIpGuard');
  const ipAccessService = require('./dist/services/ipAccessService');

  // Mock logDashboardAccess to prevent external DB dependency during unit testing
  const loggedEntries = [];
  const originalLog = ipAccessService.logDashboardAccess;
  ipAccessService.logDashboardAccess = async (entry) => {
    loggedEntries.push(entry);
  };

  // Case A: IP restriction disabled -> should allow all IPs
  let originalCheckIpAccess = ipAccessService.checkIpAccess;
  let originalIsIpRestrictionEnabled = ipAccessService.isIpRestrictionEnabled;

  ipAccessService.isIpRestrictionEnabled = async () => false;
  ipAccessService.checkIpAccess = async () => ({ allowed: true, restrictionEnabled: false });

  let nextCalled = false;
  let res = createMockResponse();
  let req = {
    headers: { 'cf-connecting-ip': '8.8.8.8' },
    user: { id: 'admin-1', role: 'admin', username: 'admin' }
  };

  await dashboardIpGuard(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'When restriction is disabled, request must pass through to next()');
  assert.strictEqual(res.statusCode, 200);

  // Case B: IP restriction enabled + Unauthorized IP -> must return 403 IP_NOT_ALLOWED
  ipAccessService.isIpRestrictionEnabled = async () => true;
  ipAccessService.checkIpAccess = async () => ({ allowed: false, restrictionEnabled: true });

  nextCalled = false;
  res = createMockResponse();
  req = {
    headers: { 'cf-connecting-ip': '198.51.100.99', 'user-agent': 'Mozilla/5.0 Test' },
    ip: '198.51.100.99',
    user: { id: 'admin-1', role: 'admin', username: 'admin' }
  };

  await dashboardIpGuard(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, false, 'Unauthorized IP must NOT call next()');
  assert.strictEqual(res.statusCode, 403, 'Unauthorized IP must receive HTTP 403');
  assert.strictEqual(res.body.code, 'IP_NOT_ALLOWED', 'Error code must be IP_NOT_ALLOWED');
  assert.strictEqual(res.body.currentIp, '198.51.100.99', 'Response must communicate client IP');
  assert.strictEqual(loggedEntries.length, 1, 'Blocked access attempt must be logged in access logs');
  assert.strictEqual(loggedEntries[0].status, 'blocked');

  // Case C: IP restriction enabled + Authorized IP -> must call next()
  ipAccessService.checkIpAccess = async (ip) => ({
    allowed: ip === '198.51.100.99',
    restrictionEnabled: true
  });

  nextCalled = false;
  res = createMockResponse();
  await dashboardIpGuard(req, res, () => { nextCalled = true; });
  assert.strictEqual(nextCalled, true, 'Authorized IP must call next()');

  // Restore mocks
  ipAccessService.checkIpAccess = originalCheckIpAccess;
  ipAccessService.isIpRestrictionEnabled = originalIsIpRestrictionEnabled;
  ipAccessService.logDashboardAccess = originalLog;
  console.log('✓ Test 3 passed: Dashboard IP Guard middleware enforces access strictly.');

  // Test 4: Lockout Prevention Logic
  console.log('[Test 4] Testing Lockout Prevention Rules...');
  const { verifyAdminCanToggleProtection } = ipAccessService;
  const { prisma } = require('./dist/utils/prisma');

  // When disabling protection: always allowed
  const disableResult = await verifyAdminCanToggleProtection('1.2.3.4', false);
  assert.strictEqual(disableResult.ok, true, 'Disabling protection should never trigger lockout');

  // Mock prisma for lockout testing
  const originalFindMany = prisma.allowedDashboardIP.findMany;

  // Case: No allowed IPs in DB -> cannot enable
  prisma.allowedDashboardIP.findMany = async () => [];
  const emptyLock = await verifyAdminCanToggleProtection('41.128.50.20', true);
  assert.strictEqual(emptyLock.ok, false, 'Must reject enabling protection when list is empty');
  assert.ok(emptyLock.reason.length > 0);

  // Case: Current Admin IP not in allowed list -> cannot enable
  prisma.allowedDashboardIP.findMany = async () => [
    { id: '1', ipAddress: '192.168.1.50', isActive: true }
  ];
  const missingAdminLock = await verifyAdminCanToggleProtection('41.128.50.20', true);
  assert.strictEqual(missingAdminLock.ok, false, 'Must reject enabling protection when admin current IP is absent');

  // Case: Current Admin IP IS in allowed list -> can enable
  prisma.allowedDashboardIP.findMany = async () => [
    { id: '1', ipAddress: '41.128.50.20', isActive: true }
  ];
  const validAdminLock = await verifyAdminCanToggleProtection('41.128.50.20', true);
  assert.strictEqual(validAdminLock.ok, true, 'Must allow enabling when admin current IP is present and active');

  prisma.allowedDashboardIP.findMany = originalFindMany;
  console.log('✓ Test 4 passed: Lockout prevention correctly validates admin presence before enabling.');

  // Test 5: Maximum 2 Allowed IPs Limit & Duplicate Prevention
  console.log('[Test 5] Testing Max Limit (2 IPs) & Duplicate Validation...');
  assert.strictEqual(MAX_ALLOWED_IPS, 2, 'Maximum allowed IPs must be strictly 2');

  const { addAllowedIp } = ipAccessService;
  const originalCount = prisma.allowedDashboardIP.count;
  const originalCreate = prisma.allowedDashboardIP.create;

  // Simulate count already 2 -> addAllowedIp must throw
  prisma.allowedDashboardIP.count = async () => 2;
  prisma.allowedDashboardIP.findMany = async () => [
    { id: '1', ipAddress: '10.0.0.1', isActive: true },
    { id: '2', ipAddress: '10.0.0.2', isActive: true }
  ];
  await assert.rejects(
    async () => {
      await addAllowedIp({ ipAddress: '1.1.1.1', label: 'Test 3rd IP' });
    },
    /حد أقصى|Max/i,
    'Attempting to add a 3rd allowed IP must be rejected'
  );

  // Simulate duplicate IP -> addAllowedIp must throw
  prisma.allowedDashboardIP.count = async () => 1;
  prisma.allowedDashboardIP.findMany = async () => [
    { id: '1', ipAddress: '8.8.8.8', isActive: true }
  ];
  await assert.rejects(
    async () => {
      await addAllowedIp({ ipAddress: '::ffff:8.8.8.8', label: 'Duplicate' });
    },
    /مسجل بالفعل|duplicate/i,
    'Duplicate IP must be rejected even with different formatting'
  );

  prisma.allowedDashboardIP.count = originalCount;
  prisma.allowedDashboardIP.findMany = originalFindMany;
  console.log('✓ Test 5 passed: Maximum 2 allowed IPs limit and duplicate check enforced.');

  console.log('--- ALL 5 IP ACCESS CONTROL TESTS PASSED SUCCESSFULLY ---');
}

runTests().catch((err) => {
  console.error('Test Suite Failed:', err);
  process.exit(1);
});
