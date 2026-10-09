import { Response } from 'express';

export function* dhruCatalogChunks(groups: any[], objectFormat: boolean, totalServices: number, catalogComplete = true): Generator<string> {
  yield '{"SUCCESS":[{"LIST":' + (objectFormat ? '{' : '[');
  for (let index = 0; index < groups.length; index++) {
    const { SERVICES, services, services_map, ...metadata } = groups[index];
    if (index) yield ',';
    if (objectFormat) yield JSON.stringify(metadata.GROUPID) + ':';
    yield JSON.stringify(metadata).slice(0, -1) + ',"SERVICES":' + (objectFormat ? '{' : '[');
    for (let serviceIndex = 0; serviceIndex < SERVICES.length; serviceIndex++) {
      const service = SERVICES[serviceIndex];
      if (serviceIndex) yield ',';
      if (objectFormat) yield JSON.stringify(String(service.SERVICEID)) + ':';
      yield JSON.stringify(service);
    }
    yield (objectFormat ? '}' : ']') + '}';
  }
  const status = { total_groups: groups.length, total_services: totalServices, catalog_complete: catalogComplete,
    ...(!catalogComplete ? { refreshing_sources: ['foxreload'], MESSAGE: 'Local services are ready. Additional provider services are refreshing; retry shortly.' } : {}) };
  yield (objectFormat ? '}' : ']') + ',' + JSON.stringify(status).slice(1) + ']}';
}

export async function streamDhruCatalog(res: Response, groups: any[], objectFormat: boolean, totalServices: number, catalogComplete = true): Promise<void> {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const write = async (chunk: string) => {
    if (res.destroyed || res.writableEnded) throw new Error('Catalog response closed');
    if (res.write(chunk)) return;
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { res.off('drain', drained); res.off('close', closed); res.off('error', failed); };
      const drained = () => { cleanup(); resolve(); };
      const closed = () => { cleanup(); reject(new Error('Catalog response closed')); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      res.once('drain', drained); res.once('close', closed); res.once('error', failed);
    });
  };
  let buffer = '';
  for (const chunk of dhruCatalogChunks(groups, objectFormat, totalServices, catalogComplete)) {
    buffer += chunk;
    if (buffer.length >= 32768) { await write(buffer); buffer = ''; }
  }
  if (buffer) await write(buffer);
  res.end();
}
