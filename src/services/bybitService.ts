import crypto from 'crypto';
import axios from 'axios';

const BYBIT_API_BASE_URL = 'https://api.bybit.com';
let cachedServerTimeOffsetMs = 0;
let lastTimeSync = 0;

export interface BybitDepositRecord {
  coin: string;
  chain: string;
  amount: string;
  txID: string;
  status: number;
  toAddress: string;
  tag?: string;
  depositFee?: string;
  successAt?: string;
  confirmations?: string;
  fromAddress?: string;
  id?: string;
}

export interface BybitDepositAddressChain {
  chainType: string;
  addressDeposit: string;
  tagDeposit: string;
  chain: string;
}

function getCredentials(): { apiKey: string; apiSecret: string } {
  const apiKey = process.env.BYBIT_API_KEY || 'iVmwUmsEWYKfjgxijs';
  const apiSecret = process.env.BYBIT_API_SECRET || 'vOpsLzh89l033pKReXEGPWNMPH3W82Vj65MW';

  if (!apiKey || !apiSecret) {
    const err: any = new Error(
      'بيانات بوابة Bybit غير متوفرة في متغيرات بيئة الخادم (BYBIT_API_KEY و BYBIT_API_SECRET).'
    );
    err.isOperational = true;
    err.status = 503;
    throw err;
  }

  return { apiKey, apiSecret };
}

async function getSynchronizedTimestamp(): Promise<string> {
  const now = Date.now();
  if (now - lastTimeSync > 5 * 60 * 1000) {
    try {
      const res = await axios.get(`${BYBIT_API_BASE_URL}/v5/market/time`, { timeout: 5000 });
      if (res.data?.result?.timeNano) {
        const serverMs = Math.floor(Number(res.data.result.timeNano) / 1000000);
        cachedServerTimeOffsetMs = serverMs - now;
        lastTimeSync = now;
      }
    } catch {
      // Fallback to local time if time-sync endpoint fails
    }
  }
  return (now + cachedServerTimeOffsetMs).toString();
}

async function buildHeaders(payloadToSign: string): Promise<{
  'X-BAPI-API-KEY': string;
  'X-BAPI-TIMESTAMP': string;
  'X-BAPI-RECV-WINDOW': string;
  'X-BAPI-SIGN': string;
  'Content-Type': string;
}> {
  const { apiKey, apiSecret } = getCredentials();
  const timestamp = await getSynchronizedTimestamp();
  const recvWindow = '10000';
  const rawPayload = `${timestamp}${apiKey}${recvWindow}${payloadToSign}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(rawPayload).digest('hex');

  return {
    'X-BAPI-API-KEY': apiKey,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': recvWindow,
    'X-BAPI-SIGN': signature,
    'Content-Type': 'application/json'
  };
}

export async function fetchBybitDepositAddresses(coin = 'USDT'): Promise<BybitDepositAddressChain[]> {
  try {
    const queryString = `coin=${encodeURIComponent(coin)}`;
    const headers = await buildHeaders(queryString);
    const response = await axios.get(`${BYBIT_API_BASE_URL}/v5/asset/deposit/query-address?${queryString}`, {
      headers,
      timeout: 10000
    });

    if (response.data?.retCode === 0 && Array.isArray(response.data?.result?.chains)) {
      return response.data.result.chains;
    }
  } catch (error: any) {
    console.warn('[Bybit Fetch Deposit Addresses Warning]:', error?.message || error);
  }
  return [];
}

export async function fetchBybitDepositRecords(coin = 'USDT', limit = 50): Promise<BybitDepositRecord[]> {
  const queryString = `coin=${encodeURIComponent(coin)}&limit=${Math.min(limit, 50)}`;
  const headers = await buildHeaders(queryString);

  const response = await axios.get(`${BYBIT_API_BASE_URL}/v5/asset/deposit/query-record?${queryString}`, {
    headers,
    timeout: 10000
  });

  if (response.data?.retCode !== 0) {
    throw new Error(`[Bybit API Error ${response.data?.retCode}] ${response.data?.retMsg || 'Failed to query deposit records'}`);
  }

  const rows = response.data?.result?.rows;
  return Array.isArray(rows) ? rows : [];
}

export async function verifyBybitDepositRecord(params: {
  txId: string;
  expectedAmount: number;
  acceptedAddresses?: string[];
}): Promise<{
  verified: boolean;
  deposit?: BybitDepositRecord;
  reason?: string;
}> {
  const cleanTxId = (params.txId || '').trim().toLowerCase();
  if (!cleanTxId) {
    return { verified: false, reason: 'رقم أو هاش المعاملة مطلوب' };
  }

  const records = await fetchBybitDepositRecords('USDT', 50);
  const matched = records.find((r) => (r.txID || '').trim().toLowerCase() === cleanTxId);

  if (!matched) {
    return {
      verified: false,
      reason: 'لم يتم العثور على المعاملة في سجلات Bybit بعد. يرجى التأكد من الهاش والانتظار قليلاً لتأكيد الشبكة.'
    };
  }

  // Bybit V5 deposit status: 3 = Success
  if (matched.status !== 3) {
    const statusMsg = matched.status === 1 ? 'قيد المعالجة من الشبكة' : matched.status === 2 ? 'قيد الفحص والأمان' : 'غير مكتملة';
    return {
      verified: false,
      reason: `حالة الإيداع في Bybit هي (${statusMsg}). يجب الانتظار حتى تكتمل التأكيدات ويصبح الإيداع ناجحاً.`
    };
  }

  const depositAmount = parseFloat(matched.amount);
  if (isNaN(depositAmount) || depositAmount <= 0) {
    return { verified: false, reason: 'مبلغ الإيداع غير صالح' };
  }

  // Verify amount with small epsilon
  if (depositAmount < params.expectedAmount - 0.01) {
    return {
      verified: false,
      reason: `المبلغ المستلم في Bybit ($${depositAmount} USDT) أقل من المبلغ المطلوب ($${params.expectedAmount} USDT).`
    };
  }

  // Verify recipient address matches our merchant deposit address
  if (params.acceptedAddresses && params.acceptedAddresses.length > 0) {
    const toAddress = (matched.toAddress || '').trim().toLowerCase();
    const isOurAddress = params.acceptedAddresses.some((addr) => addr.trim().toLowerCase() === toAddress);
    if (!isOurAddress) {
      return {
        verified: false,
        reason: 'عنوان المحفظة المستلمة في Bybit لا يطابق عنوان المنصة المعتمد.'
      };
    }
  }

  return {
    verified: true,
    deposit: matched
  };
}
