export class AsyncGate {
  private active = 0;
  private waiting: Array<{ resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  constructor(private concurrency: number, private maxQueue = 100, private waitMs = 5000) {}
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      if (this.waiting.length >= this.maxQueue) throw new Error('Provider is busy. Please retry shortly.');
      await new Promise<void>((resolve, reject) => {
        const entry = { resolve, reject, timer: undefined as unknown as ReturnType<typeof setTimeout> };
        entry.timer = setTimeout(() => {
          this.waiting = this.waiting.filter(item => item !== entry);
          reject(new Error('Provider queue timed out. Please retry shortly.'));
        }, this.waitMs);
        this.waiting.push(entry);
      });
    } else this.active++;
    try { return await work(); }
    finally {
      const next = this.waiting.shift();
      if (next) { clearTimeout(next.timer); next.resolve(); }
      else this.active--;
    }
  }
}
