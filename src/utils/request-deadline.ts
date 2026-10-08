export class RequestDeadlineError extends Error {
  status = 504;
  constructor() { super('Catalog request timed out. Please retry shortly.'); }
}

export async function withinDeadline<T>(work: Promise<T>, timeoutMs = 25000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new RequestDeadlineError()), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Limit provider fan-out and stop scheduling new work once the catalog budget expires.
export async function mapWithinDeadline<T, R>(items: T[], mapper: (item: T) => Promise<R>, concurrency = 24, timeoutMs = 22000): Promise<R[]> {
  const deadline = Date.now() + timeoutMs;
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  await withinDeadline(Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed) {
      const index = cursor++;
      if (index >= items.length) return;
      if (Date.now() >= deadline) { failed = true; throw new RequestDeadlineError(); }
      try { results[index] = await mapper(items[index]); }
      catch (error) { failed = true; throw error; }
    }
  })), timeoutMs).catch((error) => { failed = true; throw error; });
  return results;
}
