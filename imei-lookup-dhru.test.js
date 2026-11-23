const assert = require('node:assert/strict');
const { test } = require('node:test');
const { EventEmitter } = require('node:events');
const dns = require('node:dns');
const https = require('node:https');
const { promisify } = require('node:util');

process.env.JWT_SECRET = 'imei-lookup-fixture-only-no-real-authentication';
dns.lookup = (_host, callback) => callback(null, '8.8.8.8', 4);
dns.lookup[promisify.custom] = async () => ({ address: '8.8.8.8', family: 4 });
require.cache[require.resolve('./dist/utils/telegramService')] = { exports: {} };
const prisma = {};
require.cache[require.resolve('./dist/utils/prisma')] = { exports: { prisma } };

const { placeImeiOrder, getImeiOrder } = require('./dist/utils/dhru-api');
const { makeProviderApiCall, parseAllProviderServices } = require('./dist/routes/providers');
const { getImeiLookupIdentifier, isImeiLookupIdentifier } = require('./dist/utils/imei-lookup-dhru');
const { dispatchOrderToProvider } = require('./dist/services/orderDispatchService');

const provider = {
  apiUrl: 'https://api.imeilookup.com/dhru/api/index.php',
  username: 'fixture-user',
  apiKey: 'fixture-key'
};

test('IMEILookup reads a grouped catalog and requires the documented identifier', () => {
  const response = { data: { SUCCESS: [{ LIST: { Apple: { GROUPNAME: 'Apple Basic Info', GROUPTYPE: 'IMEI', SERVICES: {
    1: { SERVICEID: 1, SERVICENAME: 'Apple Model Check [IMEI/SN]', CREDIT: '0.10', TIME: 'Instant', INFO: 'Example output', CUSTOM: { allow: '0', customname: '' } },
    2: { SERVICEID: 2, SERVICENAME: 'Apple Device Info', CREDIT: '0.15', TIME: 'Instant' }
  } } } }] } };
  const [mixed, imei] = parseAllProviderServices(response, undefined, undefined, provider.apiUrl);

  assert.equal(mixed.group_name, 'Apple Basic Info');
  assert.equal(mixed.credit, 0.10);
  assert.equal(mixed.time, 'Instant');
  assert.equal(mixed.info, '');
  assert.equal(mixed.supportsQty, false);
  assert.deepEqual(mixed.customFields.map(({ field_id, label, required }) => ({ field_id, label, required })), [
    { field_id: 'IMEI', label: 'IMEI or Serial Number', required: true }
  ]);
  assert.equal(imei.customFields[0].label, 'IMEI');
  assert.equal(getImeiLookupIdentifier(null, { IMEI: '000AB123' }), '000AB123');
  assert.equal(isImeiLookupIdentifier('000AB123'), true);
  assert.equal(isImeiLookupIdentifier('000 AB123'), false);
});

test('IMEILookup serializes orders and their references as XML and avoids legacy order retries', async (t) => {
  const calls = [];
  const completed = { SUCCESS: [{ STATUS: 4, CODE: 'Manufacturer: Apple\nModel: Phone' }] };
  const success = { SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 'REF-42' }] };
  const rejected = { ERROR: [{ MESSAGE: 'Invalid action.' }] };
  const account = { SUCCESS: [{ AccoutInfo: { creditraw: '1.00', currency: 'USD' } }] };
  const replies = [account, success, completed, rejected];
  t.mock.method(https, 'request', (options, callback) => {
    assert.equal(options.servername, 'api.imeilookup.com');
    assert.equal(options.path, '/dhru/api/index.php');
    assert.equal(options.rejectUnauthorized, true);
    const request = new EventEmitter();
    request.write = (body) => calls.push(new URLSearchParams(body));
    request.end = () => {
      const response = new EventEmitter();
      response.statusCode = 200;
      callback(response);
      response.emit('data', JSON.stringify(replies.shift()));
      response.emit('end');
    };
    return request;
  });

  const balance = await makeProviderApiCall(provider.apiUrl, provider.username, provider.apiKey, 'accountinfo');
  assert.deepEqual(balance.data, account);

  prisma.order = {
    findUnique: async () => ({ id: 'order-1', serviceId: 'service-1', quantity: 1, targetInput: 'IMEI: 000AB123', notes: JSON.stringify({ rawImei: '000AB123' }) }),
    updateMany: async () => ({ count: 1 }),
    update: async ({ data }) => data
  };
  prisma.dhruService = {
    findUnique: async () => ({ id: 'service-1', dhruId: '1', apiServiceType: 'imei', credit: 0.10, apiProvider: provider })
  };
  const dispatched = await dispatchOrderToProvider('order-1');
  assert.equal(dispatched.success, true);
  assert.equal(dispatched.apiOrderId, 'REF-42');
  assert.equal(dispatched.order.status, 'processing');
  assert.equal(JSON.parse(dispatched.order.notes).dispatchServiceType, 'imei');
  assert.deepEqual(await getImeiOrder('REF-42', provider), completed);
  assert.deepEqual(await placeImeiOrder('2', '019000000000000', {}, provider), rejected);
  assert.ok((await placeImeiOrder('2', '000 AB123', {}, provider)).ERROR);

  assert.deepEqual(calls.map(body => [body.get('action'), body.get('parameters')]), [
    ['accountinfo', null],
    ['placeimeiorder', '<PARAMETERS><ID>1</ID><IMEI>000AB123</IMEI></PARAMETERS>'],
    ['getimeiorder', '<PARAMETERS><ID>REF-42</ID></PARAMETERS>'],
    ['placeimeiorder', '<PARAMETERS><ID>2</ID><IMEI>019000000000000</IMEI></PARAMETERS>']
  ]);
  assert.ok(calls.every(body => body.get('apiaccesskey') === 'fixture-key' && !body.has('key') && !body.has('parameters[ID]')));
});
