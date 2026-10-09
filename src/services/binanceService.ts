import crypto from 'crypto';
import axios from 'axios';

const BINANCE_PAY_API_KEY = process.env.BINANCE_PAY_API_KEY;
const BINANCE_PAY_SECRET_KEY = process.env.BINANCE_PAY_SECRET_KEY;
const BINANCE_PAY_BASE_URL = 'https://bpay.binanceapi.com';

export interface BinanceCreateOrderResult {
  merchantTradeNo: string;
  prepayId?: string;
  checkoutUrl?: string;
  universalUrl?: string;
  qrContent?: string;
  expireTime?: number;
  raw?: any;
}

export interface BinanceOrderQueryResult {
  merchantTradeNo: string;
  status: 'PAID' | 'PENDING' | 'INITIAL' | 'CANCELED' | 'EXPIRED' | 'ERROR';
  orderAmount: number;
  currency: string;
  transactionId?: string;
  prepayId?: string;
  raw?: any;
}

function buildHeaders(jsonBody: string): {
  'Content-Type': string;
  'BinancePay-Timestamp': string;
  'BinancePay-Nonce': string;
  'BinancePay-Certificate-SN': string;
  'BinancePay-Signature': string;
} {
  if (!BINANCE_PAY_API_KEY || !BINANCE_PAY_SECRET_KEY) {
    throw new Error('Binance Pay API credentials are not configured in server environment');
  }

  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${timestamp}\n${nonce}\n${jsonBody}\n`;
  const signature = crypto
    .createHmac('sha512', BINANCE_PAY_SECRET_KEY)
    .update(payload)
    .digest('hex')
    .toUpperCase();

  return {
    'Content-Type': 'application/json',
    'BinancePay-Timestamp': timestamp,
    'BinancePay-Nonce': nonce,
    'BinancePay-Certificate-SN': BINANCE_PAY_API_KEY,
    'BinancePay-Signature': signature
  };
}

export async function createBinanceOrder(
  amountUSD: number,
  returnUrl: string,
  cancelUrl: string,
  customTradeNo?: string
): Promise<BinanceCreateOrderResult> {
  const merchantTradeNo = customTradeNo || `BP_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const formattedAmount = Number(amountUSD.toFixed(2));

  const payloadObj = {
    env: {
      terminalType: 'WEB'
    },
    merchantTradeNo,
    orderAmount: formattedAmount,
    currency: 'USDT',
    description: 'Arab Tech Pro Server Wallet Topup',
    goodsDetails: [
      {
        goodsType: '02',
        goodsCategory: 'Z000',
        referenceGoodsId: 'WALLET_TOPUP',
        goodsName: 'Wallet Balance Deposit',
        goodsDetail: `Topup deposit of $${formattedAmount} USD via Binance Pay`
      }
    ],
    returnUrl,
    cancelUrl
  };

  const jsonBody = JSON.stringify(payloadObj);
  const headers = buildHeaders(jsonBody);

  try {
    const response = await axios.post(
      `${BINANCE_PAY_BASE_URL}/binancepay/openapi/v3/order`,
      jsonBody,
      { headers, timeout: 15000 }
    );

    const body = response.data;
    if (body.status !== 'SUCCESS' || !body.data) {
      const errCode = body.code || 'UNKNOWN';
      const errMsg = body.errorMessage || 'Failed to create Binance Pay order';
      throw new Error(`[Binance Pay Error ${errCode}] ${errMsg}`);
    }

    const data = body.data;
    return {
      merchantTradeNo,
      prepayId: data.prepayId,
      checkoutUrl: data.checkoutUrl,
      universalUrl: data.universalUrl,
      qrContent: data.qrContent,
      expireTime: data.expireTime,
      raw: data
    };
  } catch (error: any) {
    const axiosError = error?.response?.data;
    if (axiosError) {
      const code = axiosError.code || error.response?.status;
      const message = axiosError.errorMessage || axiosError.message || 'Unknown error';
      if (code === '400004' || message.includes('Invalid API-key')) {
        throw new Error(
          'مفتاح Binance Pay يتطلب تفعيل الصلاحيات أو ضبط إعدادات الـ IP من لوحة باينانس (Binance Pay Merchant / API Restrictions).'
        );
      }
      throw new Error(`خطأ بوابة باينانس (${code}): ${message}`);
    }
    throw new Error(error.message || 'تعذر الاتصال بخوادم Binance Pay');
  }
}

export async function queryBinanceOrder(
  merchantTradeNo: string,
  prepayId?: string
): Promise<BinanceOrderQueryResult> {
  const payloadObj: Record<string, string> = { merchantTradeNo };
  if (prepayId) {
    payloadObj.prepayId = prepayId;
  }

  const jsonBody = JSON.stringify(payloadObj);
  const headers = buildHeaders(jsonBody);

  try {
    const response = await axios.post(
      `${BINANCE_PAY_BASE_URL}/binancepay/openapi/v2/order/query`,
      jsonBody,
      { headers, timeout: 15000 }
    );

    const body = response.data;
    if (body.status !== 'SUCCESS' || !body.data) {
      const errCode = body.code || 'UNKNOWN';
      const errMsg = body.errorMessage || 'Failed to query Binance Pay order';
      throw new Error(`[Binance Pay Error ${errCode}] ${errMsg}`);
    }

    const data = body.data;
    const rawAmount = parseFloat(data.orderAmount || data.totalFee || '0');

    return {
      merchantTradeNo: data.merchantTradeNo || merchantTradeNo,
      status: (data.status as any) || 'PENDING',
      orderAmount: isNaN(rawAmount) ? 0 : rawAmount,
      currency: data.currency || 'USDT',
      transactionId: data.transactionId,
      prepayId: data.prepayId,
      raw: data
    };
  } catch (error: any) {
    const axiosError = error?.response?.data;
    if (axiosError) {
      const code = axiosError.code || error.response?.status;
      const message = axiosError.errorMessage || axiosError.message || 'Unknown error';
      throw new Error(`خطأ استعلام طلب باينانس (${code}): ${message}`);
    }
    throw new Error(error.message || 'تعذر الاستعلام عن حالة طلب باينانس');
  }
}

export function verifyBinanceWebhookHeader(
  headers: Record<string, string | string[] | undefined>
): {
  timestamp: string;
  nonce: string;
  signature: string;
  certSn: string;
} | null {
  const getHeader = (name: string): string => {
    const val = headers[name.toLowerCase()] || headers[name];
    return Array.isArray(val) ? val[0] : (val || '');
  };

  const timestamp = getHeader('binancepay-timestamp');
  const nonce = getHeader('binancepay-nonce');
  const signature = getHeader('binancepay-signature');
  const certSn = getHeader('binancepay-certificate-sn');

  if (!timestamp || !nonce || !signature) {
    return null;
  }

  return { timestamp, nonce, signature, certSn };
}
