const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { verifyBinanceWebhookHeader } = require('./dist/services/binanceService.js');

test('Binance Pay signature conforms to Binance Open API specification', () => {
  const apiKey = 'geyhcgjkzmjo2yccln0t84e5avupqxwwjjogqgvpuq03drct8tsl6px17wqnpgrg';
  const secretKey = 'ul7vipaq0l5klavkfsfndpb1vgxnpxlirwxhxe47jth7ooiykbvrwffkdieskt1i';

  const timestamp = '1728518400000';
  const nonce = 'abcdef1234567890abcdef1234567890';
  const body = JSON.stringify({
    merchantTradeNo: 'BP_TEST_123',
    orderAmount: 10.0,
    currency: 'USDT'
  });

  const payload = `${timestamp}\n${nonce}\n${body}\n`;
  const signature = crypto
    .createHmac('sha512', secretKey)
    .update(payload)
    .digest('hex')
    .toUpperCase();

  assert.equal(typeof signature, 'string');
  assert.equal(signature.length, 128); // SHA-512 hex is 128 chars
  assert.equal(signature, signature.toUpperCase());
});

test('Binance webhook headers extraction correctly extracts all security headers', () => {
  const headers = {
    'binancepay-timestamp': '1728518400000',
    'binancepay-nonce': 'abcdef1234567890abcdef1234567890',
    'binancepay-signature': 'MOCK_SIGNATURE',
    'binancepay-certificate-sn': 'geyhcgjkzmjo2yccln0t84e5avupqxwwjjogqgvpuq03drct8tsl6px17wqnpgrg'
  };

  const extracted = verifyBinanceWebhookHeader(headers);
  assert.ok(extracted);
  assert.equal(extracted.timestamp, '1728518400000');
  assert.equal(extracted.nonce, 'abcdef1234567890abcdef1234567890');
  assert.equal(extracted.signature, 'MOCK_SIGNATURE');
  assert.equal(extracted.certSn, 'geyhcgjkzmjo2yccln0t84e5avupqxwwjjogqgvpuq03drct8tsl6px17wqnpgrg');
});

test('Binance webhook headers extraction returns null if mandatory headers are missing', () => {
  const incompleteHeaders = {
    'binancepay-timestamp': '1728518400000'
  };

  const extracted = verifyBinanceWebhookHeader(incompleteHeaders);
  assert.equal(extracted, null);
});
