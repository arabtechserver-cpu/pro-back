import crypto from 'crypto';
import axios from 'axios';

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

function getCredentials(): { apiKey: string; secretKey: string } {
  const apiKey = process.env.BINANCE_PAY_API_KEY;
  const secretKey = process.env.BINANCE_PAY_SECRET_KEY;

  if (!apiKey || !secretKey) {
    const err: any = new Error(
      'بيانات بوابة Binance Pay غير متوفرة في متغيرات بيئة الخادم (BINANCE_PAY_API_KEY و BINANCE_PAY_SECRET_KEY). تأكد من إضافتها في لوحة Dokploy / .env وإعادة تشغيل الحاوية.'
    );
    err.isOperational = true;
    err.status = 503;
    throw err;
  }

  return { apiKey, secretKey };
}

function buildHeaders(jsonBody: string): {
  'Content-Type': string;
  'BinancePay-Timestamp': string;
  'BinancePay-Nonce': string;
  'BinancePay-Certificate-SN': string;
  'BinancePay-Signature': string;
} {
  const { apiKey, secretKey } = getCredentials();

  const timestamp = Date.now().toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const payload = `${timestamp}\n${nonce}\n${jsonBody}\n`;
  const signature = crypto
    .createHmac('sha512', secretKey)
    .update(payload)
    .digest('hex')
    .toUpperCase();

  return {
    'Content-Type': 'application/json',
    'BinancePay-Timestamp': timestamp,
    'BinancePay-Nonce': nonce,
    'BinancePay-Certificate-SN': apiKey,
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
      const err: any = new Error(`[Binance Pay Error ${errCode}] ${errMsg}`);
      err.isOperational = true;
      throw err;
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
      const code = String(axiosError.code || error.response?.status || 'UNKNOWN');
      const message = String(axiosError.errorMessage || axiosError.message || '');
      if (code === '400004' || message.includes('Invalid API-key')) {
        const ipMatch = message.match(/request ip:\s*([0-9a-fA-F.:]+)/);
        const requestIp = ipMatch ? ipMatch[1] : '';
        const ipHint = requestIp ? ` (عنوان IP خادمك الذي يحتاج إذن: ${requestIp})` : '';
        const err: any = new Error(
          `خطأ باينانس (400004): مفتاح API غير مفعل أو عنوان IP مقيد في باينانس${ipHint}. يرجى تفعيل مفاتيح التاجر Binance Pay Merchant أو إضافة عنوان IP إلى القائمة البيضاء في إعدادات API في Binance.`
        );
        err.isOperational = true;
        err.status = 400;
        throw err;
      }
      const err: any = new Error(`خطأ بوابة باينانس (${code}): ${message || 'فشل معالجة الطلب'}`);
      err.isOperational = true;
      err.status = 400;
      throw err;
    }
    throw error;
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
