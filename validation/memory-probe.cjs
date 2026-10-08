// Local benchmark instrumentation; never loaded by the production image.
if (process.send) {
  const originalExit = process.exit;
  process.once('beforeExit', code => {
    if (process.connected) process.send({ kind: 'before-exit', code, handles: process._getActiveHandles().map(handle => handle.constructor.name) }, () => {});
  });
  process.exit = function (code) {
    if (process.connected) process.send({ kind: 'explicit-exit', code, stack: new Error('Explicit process.exit').stack }, () => {});
    return originalExit.call(process, code);
  };
  const report = () => { if (process.connected) process.send({ kind: 'memory-sample', rss: process.memoryUsage().rss }, () => {}); };
  process.on('uncaughtExceptionMonitor', error => {
    if (process.connected) process.send({ kind: 'fatal-error', name: error?.name, code: error?.code, message: error?.message }, () => {});
  });
  report();
  setInterval(report, 50).unref();
}
