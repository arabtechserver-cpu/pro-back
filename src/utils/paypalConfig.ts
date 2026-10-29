const DEFAULT_PAYPAL_CLIENT_ID = 'BAAbEQaWk1wH9kFIGVcnl3bBqttl4pQAzD_bnhnYtI25cmXaUTI-M78p7c7nS7gm7tkA9K8OJs-rViTBrw';

// The browser SDK and REST API must use the same merchant application.
export function getPayPalConfig() {
  const clientId = process.env.PAYPAL_CLIENT_ID?.trim() || DEFAULT_PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET?.trim() || '';
  const mode = process.env.PAYPAL_MODE?.trim() || 'live';
  return {
    clientId,
    clientSecret,
    configured: Boolean(clientId && clientSecret),
    baseUrl: mode === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com'
  };
}

export function getPublicPayPalConfig() {
  const { clientId, configured } = getPayPalConfig();
  return { clientId: configured ? clientId : '', configured };
}
