export class RequestQueueError extends Error {
  constructor(public code: 'QUEUE_FULL' | 'QUEUE_TIMEOUT' | 'REQUEST_ABORTED') { super(code); }
}

// Queue request metadata, not decoded payloads. Large jobs cannot block all reads.
export class RequestScheduler {
  private active = 0;
  private heavyActive = 0;
  private pending: Array<{ heavy: boolean; start: () => void }> = [];
  constructor(private concurrency = 16, private heavyConcurrency = 2, private capacity = 128, private waitMs = 22000) {}
  acquire(heavy: boolean, signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) return Promise.reject(new RequestQueueError('REQUEST_ABORTED'));
    if (!this.pending.length && this.available(heavy)) return Promise.resolve(this.reserve(heavy));
    if (this.pending.length >= this.capacity) return Promise.reject(new RequestQueueError('QUEUE_FULL'));
    return new Promise((resolve, reject) => {
      const remove = () => {
        const index = this.pending.indexOf(entry);
        if (index >= 0) this.pending.splice(index, 1);
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      };
      const fail = (code: 'QUEUE_TIMEOUT' | 'REQUEST_ABORTED') => { remove(); reject(new RequestQueueError(code)); this.drain(); };
      const abort = () => fail('REQUEST_ABORTED');
      const timer = setTimeout(() => fail('QUEUE_TIMEOUT'), this.waitMs);
      const entry = { heavy, start: () => { remove(); resolve(this.reserve(heavy)); } };
      this.pending.push(entry);
      signal?.addEventListener('abort', abort, { once: true });
      this.drain();
    });
  }
  private available(heavy: boolean) { return this.active < this.concurrency && (!heavy || this.heavyActive < this.heavyConcurrency); }
  private reserve(heavy: boolean): () => void {
    this.active++; if (heavy) this.heavyActive++;
    let released = false;
    return () => {
      if (released) return;
      released = true; this.active--; if (heavy) this.heavyActive--; this.drain();
    };
  }
  private drain() {
    while (this.active < this.concurrency) {
      const next = this.pending.find(entry => this.available(entry.heavy));
      if (!next) break;
      next.start();
    }
  }
}
