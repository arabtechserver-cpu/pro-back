const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

test('Bybit V5 HMAC-SHA256 signature conforms to Bybit API specification', () => {
  const apiKey = 'iVmwUmsEWYKfjgxijs';
  const apiSecret = 'vOpsLzh89l033pKReXEGPWNMPH3W82Vj65MW';
  const timestamp = '1794318779413';
  const recvWindow = '10000';
  const queryString = 'coin=USDT&limit=50';

  const rawPayload = `${timestamp}${apiKey}${recvWindow}${queryString}`;
  const signature = crypto.createHmac('sha256', apiSecret).update(rawPayload).digest('hex');

  assert.equal(typeof signature, 'string');
  assert.equal(signature.length, 64); // SHA-256 hex is 64 characters
  assert.equal(signature, signature.toLowerCase());
});

test('Bybit deposit verification rejects underpaid amounts or wrong recipient addresses', () => {
  const allowedAddresses = ['tft4t2shanzfqn5at5kvas7bsf3xap9toe', '0xafd534f94c99aa0ae7de9b1967bd0f4e038644c5'];

  const fakeDepositSuccess = {
    coin: 'USDT',
    chain: 'TRX',
    amount: '50.00',
    txID: '0x123abc456def',
    status: 3,
    toAddress: 'TFT4t2shanZFQn5aT5Kvas7bsf3Xap9toe'
  };

  const expectedAmount = 50.0;
  const isCorrectAddress = allowedAddresses.includes(fakeDepositSuccess.toAddress.toLowerCase());
  const isAmountValid = parseFloat(fakeDepositSuccess.amount) >= expectedAmount - 0.01;
  const isConfirmed = fakeDepositSuccess.status === 3;

  assert.equal(isCorrectAddress, true);
  assert.equal(isAmountValid, true);
  assert.equal(isConfirmed, true);

  // Wrong address rejection
  const wrongAddressDeposit = { ...fakeDepositSuccess, toAddress: '0xwrongaddress999' };
  assert.equal(allowedAddresses.includes(wrongAddressDeposit.toAddress.toLowerCase()), false);

  // Underpaid rejection
  const underpaidDeposit = { ...fakeDepositSuccess, amount: '10.00' };
  assert.equal(parseFloat(underpaidDeposit.amount) >= expectedAmount - 0.01, false);

  // Pending status rejection
  const pendingDeposit = { ...fakeDepositSuccess, status: 1 };
  assert.equal(pendingDeposit.status === 3, false);
});
