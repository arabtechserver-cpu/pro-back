import { createHash } from 'crypto';
import { getPayPalConfig } from '../utils/paypalConfig';
import { PayPalGatewayError } from '../utils/paypalError';
import { getPayPalAccessToken } from '../services/paypalService';

// Authenticates only. It never creates, captures or refunds a payment.
export async function checkPayPalCredentials() {
  const config = getPayPalConfig();
  const diagnostics = {
    mode: config.mode,
    clientIdSource: config.clientIdSource,
    clientIdFingerprint: createHash('sha256').update(config.clientId).digest('hex').slice(0, 12),
    clientIdLength: config.clientId.length,
    clientSecretPresent: Boolean(config.clientSecret),
    clientSecretLength: config.clientSecret.length
  };
  try {
    await getPayPalAccessToken();
    return { success: true, ...diagnostics };
  } catch (error) {
    return { success: false, ...diagnostics, code: error instanceof PayPalGatewayError ? error.code : 'PAYPAL_CHECK_FAILED' };
  }
}

if (require.main === module) {
  checkPayPalCredentials().then(result => {
    console.log(JSON.stringify(result, null, 2));
    if (!result.success) process.exitCode = 1;
  });
}
