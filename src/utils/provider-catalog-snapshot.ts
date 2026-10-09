import { createReadStream, createWriteStream } from 'fs';
import { mkdir, rename, unlink } from 'fs/promises';
import path from 'path';
import { createGzip, createGunzip } from 'zlib';
import { pipeline } from 'stream/promises';
import { Readable } from 'stream';
import { createInterface } from 'readline';
import { randomUUID } from 'crypto';

export function providerCatalogSnapshotPath(): string {
  return path.join(process.env.FOXRELOAD_CATALOG_CACHE_DIR || path.join(process.cwd(), 'backups', '.catalog'), 'foxreload.jsonl.gz');
}

export async function saveProviderCatalogSnapshot(filePath: string, fingerprint: string, products: any[], catalog: any, timestamp = Date.now()): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  async function* records() {
    yield JSON.stringify({ version: 1, fingerprint, timestamp, catalog }) + '\n';
    for (const product of products) yield JSON.stringify({ product }) + '\n';
    yield JSON.stringify({ complete: true, count: products.length }) + '\n';
  }
  try {
    await pipeline(Readable.from(records()), createGzip(), createWriteStream(temporary, { mode: 0o600, flags: 'wx' }));
    await rename(temporary, filePath);
  } finally { await unlink(temporary).catch(() => {}); }
}

export async function loadProviderCatalogSnapshot(filePath: string, fingerprint: string): Promise<{ timestamp: number; products: any[]; catalog: any } | null> {
  const input = createReadStream(filePath);
  const decoded = createGunzip();
  input.on('error', error => decoded.destroy(error));
  const lines = createInterface({ input: input.pipe(decoded), crlfDelay: Infinity });
  let header: any;
  let complete = false;
  const products: any[] = [];
  try {
    for await (const line of lines) {
      const record = JSON.parse(line);
      if (!header) {
        header = record;
        if (header.version !== 1 || header.fingerprint !== fingerprint || !Number.isFinite(header.timestamp)
          || Date.now() - header.timestamp > 24 * 60 * 60 * 1000 || header.timestamp > Date.now() + 60000) return null;
      } else if (record.complete === true) {
        if (complete || record.count !== products.length) return null;
        complete = true;
      } else {
        if (complete || !record.product?.id || !Number.isFinite(record.product.costPrice)) return null;
        products.push(record.product);
      }
    }
    return complete ? { timestamp: header.timestamp, products, catalog: header.catalog || { sections: {} } } : null;
  } catch { return null; }
  finally { lines.close(); input.destroy(); decoded.destroy(); }
}
