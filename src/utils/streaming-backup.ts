import { open } from 'fs/promises';
import { pagedRows } from './paged-rows';

export async function writeBackupSnapshot(
  filePath: string,
  collections: Record<string, { model: any; select?: Record<string, boolean> }>,
  metadata: Record<string, unknown>,
  summaryKeys: Record<string, string>
): Promise<Record<string, number>> {
  const file = await open(filePath, 'w', 0o600);
  const counts: Record<string, number> = {};
  // Async writes are awaited: at most one small page and one row are retained.
  const write = async (text: string) => { await file.write(text, null, 'utf8'); };
  try {
    await write(JSON.stringify(metadata).slice(0, -1));
    let hasFields = Object.keys(metadata).length > 0;
    for (const [name, collection] of Object.entries(collections)) {
      await write(`${hasFields ? ',' : ''}${JSON.stringify(name)}:[`);
      hasFields = true;
      let count = 0;
      for await (const row of pagedRows(collection.model, collection.select ? { select: collection.select } : {}, ['storedImages', 'transactions'].includes(name) ? 1 : 25)) {
        await write((count ? ',' : '') + JSON.stringify(row));
        count++;
      }
      counts[name] = count;
      await write(']');
    }
    const summary: Record<string, number> = {};
    for (const [key, name] of Object.entries(summaryKeys)) summary[key] = counts[name] || 0;
    await write(`${hasFields ? ',' : ''}"summary":${JSON.stringify(summary)}}`);
    return counts;
  } finally { await file.close(); }
}
