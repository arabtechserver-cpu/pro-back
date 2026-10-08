export function databaseClientUrl(rawUrl: string | undefined): string | undefined {
  if (!rawUrl) return rawUrl;
  const url = new URL(rawUrl);
  if (['postgresql:', 'postgres:'].includes(url.protocol) && !url.searchParams.has('connection_limit')) {
    // Client pool only: never change server configuration or a supplied pool limit.
    url.searchParams.set('connection_limit', '2');
  }
  return url.toString();
}
