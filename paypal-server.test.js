const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const net = require('node:net');
const path = require('node:path');

test('the compiled production server mounts PayPal config, create and capture before its 404 handler', { timeout: 20000 }, async () => {
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const server = spawn(process.execPath, [path.join(__dirname, 'dist/server.js')], {
    cwd: __dirname,
    env: {
      ...process.env,
      NODE_ENV: 'test', PORT: String(port),
      STARTUP_MAINTENANCE: 'false', BACKGROUND_JOBS_ENABLED: 'false',
      JWT_SECRET: 'isolated-paypal-server-test-secret',
      DATABASE_URL: 'postgresql://test:test@127.0.0.1:1/unused',
      PAYPAL_CLIENT_ID: 'server-test-client', PAYPAL_CLIENT_SECRET: 'private-test-secret',
      TELEGRAM_UPDATES_MODE: 'disabled'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`Server startup timed out: ${output}`)), 12000);
      const onData = data => {
        output += data;
        if (output.includes('Backend server is running')) { clearTimeout(timeout); resolve(); }
      };
      server.stdout.on('data', onData);
      server.stderr.on('data', onData);
      server.once('error', error => { clearTimeout(timeout); reject(error); });
      server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Server exited (${code}): ${output}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/api/wallet/paypal/client-id`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { success: true, clientId: 'server-test-client', configured: true });
    assert.equal((await fetch(`${base}/api/wallet/paypal/client-id?check=1`, { method: 'HEAD' })).status, 200);
    for (const action of ['create-order', 'capture-order']) {
      const payment = await fetch(`${base}/api/wallet/paypal/${action}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
      });
      assert.equal(payment.status, 401, `${action} must exist and require authentication`);
    }
    assert.equal((await fetch(`${base}/api/wallet/paypal/missing-route`)).status, 404);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    if (server.exitCode === null) {
      server.kill();
      await new Promise(resolve => server.once('exit', resolve));
    }
  }
});
