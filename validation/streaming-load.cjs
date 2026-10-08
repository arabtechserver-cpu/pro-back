const http = require('node:http');
const { spawn } = require('node:child_process');
const { createHash } = require('node:crypto');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const scriptParent = path.resolve(__dirname, '..');
const root = fs.existsSync(path.join(scriptParent, 'frontend')) ? scriptParent : path.dirname(scriptParent);
const frontendDir = process.env.BENCHMARK_FRONTEND_DIR || path.join(root, fs.existsSync(path.join(root, 'frontend')) ? 'frontend' : 'pro-front');
const part = Buffer.alloc(64 * 1024, 97);
const size = 6 * 1024 * 1024;
const expectedHash = createHash('sha256');
for (let bytes = 0; bytes < size; bytes += part.length) expectedHash.update(part);
const digest = expectedHash.digest('hex');
let active = 0, peakActive = 0, peakRss = 0, frontend;
const backend = http.createServer(async (req, res) => {
  active++; peakActive = Math.max(peakActive, active);
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length; hash.update(chunk);
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  res.setHeader('content-type', 'application/json');
  res.once('finish', () => active--);
  res.end(JSON.stringify({ bytes, hash: hash.digest('hex') }));
});
(async () => {
  try {
    await new Promise((resolve, reject) => { backend.once('error', reject); backend.listen(5000, '127.0.0.1', resolve); });
    const occupied = http.createServer();
    await new Promise((resolve, reject) => { occupied.once('error', reject); occupied.listen(3105, '127.0.0.1', () => occupied.close(resolve)); });
    frontend = spawn(process.execPath, ['--require', path.join(__dirname, 'memory-probe.cjs'), '.next/standalone/server.js'], {
      cwd: frontendDir, env: { ...process.env, NODE_ENV: 'production', NODE_OPTIONS: '--max-semi-space-size=2', PORT: '3105', HOSTNAME: '127.0.0.1', INTERNAL_API_URL: 'http://127.0.0.1:5000', NEXT_TELEMETRY_DISABLED: '1' },
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
    });
    frontend.stdout.resume(); frontend.stderr.resume();
    frontend.on('message', message => { if (message.kind === 'memory-sample') peakRss = Math.max(peakRss, message.rss); });
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { const res = await fetch('http://127.0.0.1:3105/ar/login'); await res.arrayBuffer(); if (res.ok) { ready = true; break; } } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(ready, 'frontend must start');
    const started = performance.now();
    await Promise.all(Array.from({ length: 12 }, async () => {
      let remaining = size;
      const body = new ReadableStream({ pull(controller) {
        if (!remaining) { controller.close(); return; }
        const chunk = part.subarray(0, Math.min(part.length, remaining)); remaining -= chunk.length; controller.enqueue(chunk);
      } });
      const res = await fetch('http://127.0.0.1:3105/api/upload/stream-validation', {
        method: 'POST', body, duplex: 'half', headers: { 'content-type': 'application/octet-stream' }, signal: AbortSignal.timeout(30000)
      });
      assert.equal(res.status, 200);
      const response = await res.json();
      assert.equal(response.bytes, size); assert.equal(response.hash, digest);
    }));
    assert.equal(peakActive, 2, 'large uploads wait rather than being rejected');
    const receipt = await fetch('http://127.0.0.1:3105/uploads/receipts/private-file.png');
    assert.equal(receipt.status, 403); await receipt.arrayBuffer();
    console.log(JSON.stringify({ successfulUploads: 12, concurrentClients: 12, totalBytes: size * 12, maxConcurrentBackendStreams: peakActive,
      elapsedMs: +(performance.now() - started).toFixed(2), frontendPeakMiB: +(peakRss / 1048576).toFixed(2), receiptsDenied: true,
      memoryLimitApplied: false, backend: 'isolated streaming mock; no production database or real uploaded files' }, null, 2));
  } finally {
    if (frontend && frontend.exitCode === null) { const exited = new Promise(resolve => frontend.once('exit', resolve)); frontend.kill(); await exited; }
    backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
