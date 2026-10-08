// Approximate retained JS memory without creating a second serialized payload.
export function estimateBytes(value: unknown, seen = new Set<object>()): number {
  if (typeof value === 'string') return 24 + value.length * 2;
  if (value === null || value === undefined) return 8;
  if (typeof value !== 'object') return 16;
  if (seen.has(value)) return 8;
  seen.add(value);
  let size = 64;
  if (Buffer.isBuffer(value)) return size + value.byteLength;
  for (const [key, item] of Object.entries(value)) size += 24 + key.length * 2 + estimateBytes(item, seen);
  return size;
}

export class BoundedCache<K, V> {
  private entries = new Map<K, { value: V; bytes: number; expiresAt: number }>();
  private bytes = 0;
  constructor(private maxEntries: number, private maxBytes: number, private ttlMs: number) {}
  get size() { this.prune(); return this.entries.size; }
  get retainedBytes() { this.prune(); return this.bytes; }
  get(key: K): V | undefined {
    const entry = this.entries.get(key);
    if (!entry) return;
    if (entry.expiresAt <= Date.now()) { this.delete(key); return; }
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }
  set(key: K, value: V): boolean {
    this.delete(key);
    this.prune();
    const bytes = estimateBytes(value) + estimateBytes(key);
    if (bytes > this.maxBytes) return false;
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.delete(oldest.value);
    }
    this.entries.set(key, { value, bytes, expiresAt: Date.now() + this.ttlMs });
    this.bytes += bytes;
    return true;
  }
  delete(key: K): boolean {
    const entry = this.entries.get(key);
    if (!entry) return false;
    this.bytes -= entry.bytes;
    return this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
  private prune() {
    const now = Date.now();
    for (const [key, entry] of this.entries) if (entry.expiresAt <= now) this.delete(key);
  }
}
