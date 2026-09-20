import axios from 'axios';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';

const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

// 1. Generate OAuth2 Access Token from PayPal
export async function getPayPalAccessToken(): Promise<string> {
  try {
    if (!PAYPAL_CLIENT_ID || !PAYPAL_CLIENT_SECRET) {
      throw new Error('بيانات الاعتماد الخاصة بـ PayPal غير متوفرة في إعدادات السيرفر.');
    }

    const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
    const response = await axios({
      url: `${BASE_URL}/v1/oauth2/token`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${auth}`
      },
      data: 'grant_type=client_credentials'
    });

    return response.data.access_token;
  } catch (error: any) {
    console.error('[PayPal Token Error]:', error?.response?.data || error?.message);
    throw new Error('فشل الحصول على رمز الدخول من سيرفر PayPal. يرجى التحقق من صحة مفاتيح الـ API.');
  }
}

// 2. Create PayPal Order v2
export async function createPayPalOrder(amountUSD: number, returnUrl: string, cancelUrl: string) {
  try {
    const accessToken = await getPayPalAccessToken();
    const formattedAmount = Number(amountUSD).toFixed(2);

    const response = await axios({
      url: `${BASE_URL}/v2/checkout/orders`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      data: {
        intent: 'CAPTURE',
        purchase_units: [
          {
            amount: {
              currency_code: 'USD',
              value: formattedAmount
            },
            description: 'شحن رصيد محفظة - سيرفر عرب تك برو (Arab Tech Pro Server)'
          }
        ],
        application_context: {
          brand_name: 'Arab Tech Pro Server',
          locale: 'ar-EG',
          user_action: 'PAY_NOW',
          return_url: returnUrl,
          cancel_url: cancelUrl
        }
      }
    });

    const orderData = response.data;
    const approvalLink = orderData.links?.find((link: any) => link.rel === 'approve');

    return {
      orderId: orderData.id,
      approvalUrl: approvalLink ? approvalLink.href : null,
      raw: orderData
    };
  } catch (error: any) {
    console.error('[PayPal Create Order Error]:', error?.response?.data || error?.message);
    const errorDetail = error?.response?.data?.details?.[0]?.description || error?.response?.data?.message || error?.message;
    throw new Error(`فشل إنشاء طلب الدفع عبر PayPal: ${errorDetail}`);
  }
}

// 3. Get PayPal Order Details v2
export async function getPayPalOrderDetails(orderId: string) {
  try {
    const accessToken = await getPayPalAccessToken();
    const response = await axios({
      url: `${BASE_URL}/v2/checkout/orders/${orderId}`,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });
    return response.data;
  } catch (error: any) {
    console.error('[PayPal Get Order Details Error]:', error?.response?.data || error?.message);
    throw new Error('فشل التحقق من تفاصيل الطلب من PayPal');
  }
}

// 4. Capture PayPal Order v2 (Strictly verifies live capture)
export async function capturePayPalOrder(orderId: string) {
  try {
    const accessToken = await getPayPalAccessToken();

    const response = await axios({
      url: `${BASE_URL}/v2/checkout/orders/${orderId}/capture`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      }
    });

    return response.data;
  } catch (error: any) {
    console.error('[PayPal Capture Order Error]:', error?.response?.data || error?.message);
    const errorName = error?.response?.data?.name;
    const errorIssue = error?.response?.data?.details?.[0]?.issue;
    const errorDesc = error?.response?.data?.details?.[0]?.description || error?.response?.data?.message || error?.message;

    // If order was already captured, inspect order details to see if it really completed
    if (errorIssue === 'ORDER_ALREADY_CAPTURED' || errorName === 'UNPROCESSABLE_ENTITY') {
      try {
        const details = await getPayPalOrderDetails(orderId);
        if (details.status === 'COMPLETED') {
          return details;
        }
      } catch (_) {}
    }

    throw new Error(`فشل تأكيد عملية الدفع من PayPal: ${errorDesc || 'لم يتم تأكيد الدفع من قبل العميل على موقع PayPal'}`);
  }
}

// 5. Verify PayPal Webhook Signature via official PayPal REST API
export async function verifyPayPalWebhookSignature(
  headers: Record<string, string | string[] | undefined>,
  body: any
): Promise<{ verified: boolean; error?: string }> {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    return { verified: false, error: 'PAYPAL_WEBHOOK_ID is not configured on server' };
  }

  const getHeader = (name: string): string => {
    const val = headers[name.toLowerCase()] || headers[name];
    return Array.isArray(val) ? val[0] : (val || '');
  };

  const authAlgo = getHeader('paypal-auth-algo');
  const certUrl = getHeader('paypal-cert-url');
  const transmissionId = getHeader('paypal-transmission-id');
  const transmissionSig = getHeader('paypal-transmission-sig');
  const transmissionTime = getHeader('paypal-transmission-time');

  if (!authAlgo || !certUrl || !transmissionId || !transmissionSig || !transmissionTime) {
    return { verified: false, error: 'Missing required PayPal signature headers' };
  }

  try {
    const parsedCertUrl = new URL(certUrl);
    if (parsedCertUrl.protocol !== 'https:') {
      return { verified: false, error: 'Insecure certificate URL protocol' };
    }
    const host = parsedCertUrl.hostname.toLowerCase();
    if (!host.endsWith('.paypal.com') && host !== 'paypal.com') {
      return { verified: false, error: 'Untrusted certificate URL host' };
    }
  } catch (_) {
    return { verified: false, error: 'Invalid certificate URL format' };
  }

  try {
    const accessToken = await getPayPalAccessToken();
    const response = await axios({
      url: `${BASE_URL}/v1/notifications/verify-webhook-signature`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`
      },
      data: {
        auth_algo: authAlgo,
        cert_url: certUrl,
        transmission_id: transmissionId,
        transmission_sig: transmissionSig,
        transmission_time: transmissionTime,
        webhook_id: webhookId,
        webhook_event: body
      }
    });

    const status = response.data?.verification_status;
    if (status === 'SUCCESS') {
      return { verified: true };
    }
    return { verified: false, error: `PayPal verification returned status: ${status}` };
  } catch (error: any) {
    const errorMsg = error?.response?.data?.message || error?.message || 'Verification request failed';
    return { verified: false, error: errorMsg };
  }
}

