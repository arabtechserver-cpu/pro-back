import type { Options, Store, ClientRateLimitInfo } from 'express-rate-limit';

// Deny new identities when full instead of evicting active security counters.
export class BoundedRateLimitStore implements Store {
  localKeys = true;
  private entries = new Map<string, { totalHits: number; resetTime: Date }>();
  private windowMs = 60000;
  constructor(private capacity = 2000) {}
  init(options: Options) { this.windowMs = options.windowMs; }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.resetTime.getTime() <= now) {
      for (const [id, value] of this.entries) if (value.resetTime.getTime() <= now) this.entries.delete(id);
      if (this.entries.size >= this.capacity) return { totalHits: Number.MAX_SAFE_INTEGER, resetTime: new Date(now + this.windowMs) };
      entry = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      this.entries.set(key, entry);
    }
    entry.totalHits++;
    return { ...entry };
  }
  async decrement(key: string) { const entry = this.entries.get(key); if (entry && entry.totalHits > 0) entry.totalHits--; }
  async resetKey(key: string) { this.entries.delete(key); }
  async resetAll() { this.entries.clear(); }
}
