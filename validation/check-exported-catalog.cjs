// Read-only check: no server bootstrap, cron, order placement or database writes.
const path = require('node:path');
const envPath = path.join(__dirname, '..', '.env');
if (require('node:fs').existsSync(envPath)) process.loadEnvFile(envPath);
const { prisma } = require('../dist/utils/prisma');
const { getDhruCompatibleMergedCatalog } = require('../dist/services/unifiedCatalogService');
const { getFoxreloadAllProducts, getFoxreloadFullCatalog, getFoxreloadEsimProducts, callFoxreloadApi } = require('../dist/services/foxreloadService');

(async () => {
  const started = performance.now();
  if (process.argv.includes('--probe')) {
    const page = await callFoxreloadApi('/api/products/?withStockOnly=true&limit=200&includeDescendants=true', 'GET', undefined, 'en', 'usd', undefined, 10000);
    console.log(JSON.stringify({ ok: page.ok, status: page.status, pageItems: page.data?.items?.length || 0,
      providerTotal: page.data?.total, hasNextPage: Boolean(page.data?.nextCursor),
      elapsedMs: Math.round(performance.now() - started) }, null, 2));
    return;
  }
  const esimOnly = process.argv.includes('--esim');
  if (esimOnly) await getFoxreloadEsimProducts(false, 15 * 60 * 1000);
  else if (!process.argv.includes('--available')) await Promise.all([getFoxreloadFullCatalog(), getFoxreloadAllProducts(false, 15 * 60 * 1000)]);
  const warmupMs = Math.round(performance.now() - started);
  const requestStarted = performance.now();
  const catalog = await getDhruCompatibleMergedCatalog(8, esimOnly ? 'server' : 'all', esimOnly ? 'esim' : undefined);
  const sections = {};
  const protocols = {};
  const ids = new Set();
  for (const group of catalog.groupsList) {
    sections[group.section_id] = (sections[group.section_id] || 0) + group.SERVICES.length;
    protocols[group.service_type] = (protocols[group.service_type] || 0) + group.SERVICES.length;
    for (const service of group.SERVICES) {
      if (ids.has(service.SERVICEID)) throw new Error('Duplicate exported service ID');
      ids.add(service.SERVICEID);
      if (service.ID !== service.SERVICEID || !service.SERVICETYPE) throw new Error('Invalid service protocol metadata');
    }
  }
  console.log(JSON.stringify({
    totalServices: catalog.totalServices, groups: catalog.groupsList.length,
    catalogComplete: catalog.catalogComplete, refreshingSources: catalog.refreshingSources,
    sections, protocols, elapsedMs: Math.round(performance.now() - started),
    warmupMs, warmCatalogRequestMs: Math.round(performance.now() - requestStarted),
    processRssMiB: Number((process.memoryUsage().rss / 1048576).toFixed(2))
  }, null, 2));
})().catch(error => {
  // Avoid logging upstream URLs, payloads or credentials.
  console.error(error.name === 'RequestDeadlineError' ? 'Catalog deadline exceeded' : 'Read-only catalog check failed');
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
  if (process.argv.includes('--available') || process.argv.includes('--esim')) process.exit(process.exitCode || 0);
});
