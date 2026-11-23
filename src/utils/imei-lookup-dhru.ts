export function isImeiLookupDhruEndpoint(apiUrl?: string | null): boolean {
  if (!apiUrl) return false;
  try {
    const url = new URL(apiUrl.includes('://') ? apiUrl : `https://${apiUrl}`);
    return url.origin === 'https://api.imeilookup.com' && url.pathname === '/dhru/api/index.php';
  } catch {
    return false;
  }
}

export function getImeiLookupIdentifier(raw: unknown, fields?: Record<string, unknown> | null, target?: string | null): string {
  const identifier = raw || fields?.IMEI || fields?.imei || fields?.custom_IMEI || target;
  return typeof identifier === 'string' ? identifier.trim() : '';
}

export function isImeiLookupIdentifier(identifier: string): boolean {
  return /^[a-z0-9]+$/i.test(identifier);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function buildImeiLookupDhruForm(
  username: string,
  apiKey: string,
  action: string,
  parameters: { ID?: string; IMEI?: string }
): URLSearchParams {
  const form = new URLSearchParams({ username, apiaccesskey: apiKey, action, requestformat: 'JSON' });
  if (action === 'placeimeiorder' || action === 'getimeiorder') {
    const id = `<ID>${escapeXml(parameters.ID ?? '')}</ID>`;
    const identifier = action === 'placeimeiorder' ? `<IMEI>${escapeXml(parameters.IMEI ?? '')}</IMEI>` : '';
    form.set('parameters', `<PARAMETERS>${id}${identifier}</PARAMETERS>`);
  }
  return form;
}
