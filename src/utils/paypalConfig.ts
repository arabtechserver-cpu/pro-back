const DEFAULT_PAYPAL_CLIENT_ID = 'BAAbEQaWk1wH9kFIGVcnl3bBqttl4pQAzD_bnhnYtI25cmXaUTI-M78p7c7nS7gm7tkA9K8OJs-rViTBrw';

function cleanEnvironmentValue(value: string | undefined): string {
  const trimmed = value?.trim() || '';
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

// The browser SDK and REST API must use the same merchant application.
export function getPayPalConfig() {
  const configuredClientId = cleanEnvironmentValue(process.env.PAYPAL_CLIENT_ID);
  const clientId = configuredClientId || DEFAULT_PAYPAL_CLIENT_ID;
  const clientSecret = cleanEnvironmentValue(process.env.PAYPAL_CLIENT_SECRET);
  const mode = (cleanEnvironmentValue(process.env.PAYPAL_MODE) || 'live').toLowerCase();
  const validMode = mode === 'live' || mode === 'sandbox';
  return {
    clientId,
    clientSecret,
    mode,
    validMode,
    clientIdSource: configuredClientId ? 'environment' : 'default',
    configured: Boolean(validMode && clientId && clientSecret),
    baseUrl: mode === 'sandbox' ? 'https://api-m.sandbox.paypal.com' : 'https://api-m.paypal.com'
  };
}

export function getPublicPayPalConfig() {
  const { clientId, configured } = getPayPalConfig();
  return { clientId: configured ? clientId : '', configured };
}
