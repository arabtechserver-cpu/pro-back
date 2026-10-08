const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const scriptParent = path.resolve(__dirname, '..');
const root = fs.existsSync(path.join(scriptParent, 'backend')) ? scriptParent : path.dirname(scriptParent);
const backendDir = process.env.BENCHMARK_BACKEND_DIR || (fs.existsSync(path.join(root, 'backend')) ? path.join(root, 'backend') : scriptParent);
const frontendDir = process.env.BENCHMARK_FRONTEND_DIR || path.join(root, fs.existsSync(path.join(root, 'frontend')) ? 'frontend' : 'pro-front');
const processes = [];
const memory = { frontend: 0, backend: 0 };
const peaks = { frontend: 0, backend: 0, combined: 0 };
let requests = 0, maxResponseMs = 0;
const statuses = {};
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
function start(name, args, cwd, environment) {
  const launched = Date.now();
  const child = spawn(process.execPath, ['--require', path.join(__dirname, 'memory-probe.cjs'), ...args], {
    cwd, env: { ...process.env, ...environment, NODE_ENV: 'production', NODE_OPTIONS: '--max-semi-space-size=2' },
    windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  // Do not print application logs: they may contain production configuration.
  child.stdout.resume();
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics = (diagnostics + data.toString()).slice(-16000); });
  child.appName = name;
  child.safeDiagnostics = () => {
    const envFile = path.join(backendDir, '.env');
    const values = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8').split(/\r?\n/).map(line => line.slice(line.indexOf('=') + 1).trim().replace(/^['"]|['"]$/g, '')).filter(value => value.length > 5) : [];
    let result = diagnostics;
    for (const value of [...values, ...Object.values(process.env)].filter(value => value && value.length > 5)) result = result.split(value).join('[redacted]');
    return result.slice(-5000);
  };
  processes.push(child);
  child.on('exit', (code, signal) => { child.exitedAfterMs = Date.now() - launched; child.exitSignal = signal; });
  child.on('message', message => {
    if (message.kind === 'before-exit') { child.beforeExit = message; return; }
    if (message.kind === 'explicit-exit') { child.explicitExit = message; return; }
    if (message.kind === 'fatal-error') { child.fatal = { name: message.name, code: message.code }; return; }
    if (message.kind !== 'memory-sample') return;
    memory[name] = message.rss;
    peaks[name] = Math.max(peaks[name], message.rss);
    peaks.combined = Math.max(peaks.combined, memory.frontend + memory.backend);
  });
  return child;
}
async function ready(url, child) {
  const until = Date.now() + 30000;
  while (Date.now() < until) {
    if (child.exitCode !== null) {
      console.error(JSON.stringify({ app: child.appName, exitCode: child.exitCode, exitedAfterMs: child.exitedAfterMs, exitSignal: child.exitSignal, beforeExit: child.beforeExit, explicitExit: child.explicitExit, diagnostics: child.safeDiagnostics() }));
      throw new Error('Application exited before readiness');
    }
    try { const res = await fetch(url, { signal: AbortSignal.timeout(2000) }); await res.arrayBuffer(); if (res.ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('Application readiness timed out');
}
async function request(route) {
  const begin = performance.now();
  const response = await fetch(`http://127.0.0.1:3105${route}`, { signal: AbortSignal.timeout(30000) });
  await response.arrayBuffer();
  maxResponseMs = Math.max(maxResponseMs, performance.now() - begin);
  requests++; statuses[response.status] = (statuses[response.status] || 0) + 1;
}
(async () => {
  try {
    await assertFree(5105); await assertFree(3105);
    const backend = start('backend', ['--env-file=.env', 'dist/server.js'], backendDir, {
      PORT: '5105', STARTUP_MAINTENANCE: 'false', BACKGROUND_JOBS_ENABLED: 'false', TELEGRAM_UPDATES_MODE: 'disabled'
    });
    await ready('http://127.0.0.1:5105/api/health', backend);
    const frontend = start('frontend', ['.next/standalone/server.js'], frontendDir, {
      PORT: '3105', HOSTNAME: '127.0.0.1', INTERNAL_API_URL: 'http://127.0.0.1:5105', NEXT_TELEMETRY_DISABLED: '1'
    });
    await ready('http://127.0.0.1:3105/ar/login', frontend);
    await sleep(1000);
    const baselineMiB = Object.fromEntries(Object.entries(memory).map(([name, rss]) => [name, +(rss / 1048576).toFixed(2)]));
    const routes = ['/ar/login', '/ar/pricing', '/ar/purchase', '/ar/register', '/en/pricing', '/api/dhru/services?view=pricing', '/api/health'];
    // Read-only public routes, no authentication, payments or order submission.
    let next = 0;
    await Promise.all(Array.from({ length: 32 }, async () => {
      while (next < 640) { const index = next++; await request(routes[index % routes.length]); }
    }));
    await sleep(3000);
    await ready('http://127.0.0.1:5105/api/health', backend);
    if (processes.some(child => child.exitCode !== null)) {
      for (const child of processes.filter(child => child.exitCode !== null)) console.error(JSON.stringify({ app: child.appName, exitCode: child.exitCode, exitedAfterMs: child.exitedAfterMs, exitSignal: child.exitSignal, beforeExit: child.beforeExit, explicitExit: child.explicitExit, fatal: child.fatal, diagnostics: child.safeDiagnostics() }));
      console.error(JSON.stringify({ requests, statuses, peaks }));
      throw new Error('Application exited during load');
    }
    const result = {
      platform: process.platform, node: process.version, instrumentedRss: true,
      backgroundJobsAndStartupMaintenance: false, databaseOperations: 'read-only', concurrency: 32, memoryLimitApplied: false,
      requests, statuses, maxResponseMs: +maxResponseMs.toFixed(2), baselineMiB,
      backendBeforeExit: backend.beforeExit || null,
      peakMiB: Object.fromEntries(Object.entries(peaks).map(([name, rss]) => [name, +(rss / 1048576).toFixed(2)])),
      finalMiB: Object.fromEntries(Object.entries(memory).map(([name, rss]) => [name, +(rss / 1048576).toFixed(2)])),
      note: 'Windows production RSS sample; does not validate Linux cgroup usage, Docker caps, image transforms, real provider latency or background jobs.'
    };
    fs.writeFileSync(path.join(__dirname, 'low-memory-results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    if (result.peakMiB.combined * 1048576 >= 500000000) throw new Error('Combined RSS exceeds the 500 MB target');
    if (statuses[200] !== requests) throw new Error('Load test had non-success responses');
  } finally {
    for (const child of processes.reverse()) {
      if (child.exitCode !== null) continue;
      const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
    }
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
