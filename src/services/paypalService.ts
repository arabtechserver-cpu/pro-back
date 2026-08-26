import axios from 'axios';

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';

const BASE_URL = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';

// 1. Generate OAuth2 Access Token from PayPal
export async function getPayPalAccessToken(): Promise<string> {
  try {
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
    throw new Error('فشل الحصول على رمز الوصول من PayPal');
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
            description: 'شحن محفظة - GSM Team Store'
          }
        ],
        application_context: {
          brand_name: 'GSM Team Store',
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
    throw new Error('فشل إنشاء طلب الدفع عبر PayPal');
  }
}

// 3. Capture PayPal Order v2
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
    // If order was already captured or not found
    if (error?.response?.data?.name === 'UNPROCESSABLE_ENTITY') {
      return { status: 'ALREADY_CAPTURED', raw: error?.response?.data };
    }
    throw new Error('فشل تأكيد عملية الدفع من PayPal');
  }
}
