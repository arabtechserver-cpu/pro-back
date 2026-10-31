export function databaseClientUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  const url = new URL(rawUrl);
  if (['postgresql:', 'postgres:'].includes(url.protocol) && !url.searchParams.has('connection_limit')) {
    // Avoid pool starvation: 2 connections deadlocked under any concurrency or CRON polling.
    url.searchParams.set('connection_limit', process.env.DATABASE_CONNECTION_LIMIT || '15');
  }
  return url.toString();
}
