// DHRU order protocol and storefront/business section are separate concepts.
export function getCatalogSection(protocol: string, ...labels: unknown[]): string {
  if (protocol === 'imei' || protocol === 'remote') return `dhru-${protocol}`;
  const label = labels.map(value => String(value || '')).join(' ').toLowerCase();
  if (/esim|e-sim/.test(label)) return 'esim';
  if (/subscriptions|اشتراكات/.test(label)) return 'subscriptions';
  if (/app.?stores|متاجر التطبيقات/.test(label)) return 'app-stores';
  if (/rewarble/.test(label)) return 'rewarble';
  if (/gift.?cards|game.?currency|أكواد وبطاقات/.test(label)) return 'game-currency';
  if (/top.?ups|شحن الألعاب/.test(label)) return 'topups';
  return 'dhru-server';
}
