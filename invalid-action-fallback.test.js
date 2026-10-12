const assert = require('node:assert/strict');
const https = require('node:https');
const { EventEmitter } = require('node:events');
const dns = require('node:dns');
const { promisify } = require('node:util');

const originalLookup = dns.lookup;
dns.lookup = (_host, callback) => callback(null, '8.8.8.8', 4);
dns.lookup[promisify.custom] = async () => ({ address: '8.8.8.8', family: 4 });

const dhru = require('./dist/utils/dhru-api');

async function testInvalidActionFallbacks() {
  const originalRequest = https.request;
  const calls = [];

  try {
    // Test 1: placeImeiOrder cascades to placeserverorder when provider returns Invalid Action
    https.request = (options, callback) => {
      const emitter = new EventEmitter();
      let body = '';
      emitter.write = (chunk) => { body += chunk; };
      emitter.end = () => {
        const parsedBody = new URLSearchParams(body);
        const action = parsedBody.get('action');
        calls.push({ action, body: parsedBody });

        const res = new EventEmitter();
        res.statusCode = 200;

        let responsePayload;
        if (action === 'placeimeiorder') {
          responsePayload = JSON.stringify({
            ERROR: [{ MESSAGE: 'Invalid Action' }],
            apiversion: '1.0'
          });
        } else if (action === 'placeserverorder') {
          responsePayload = JSON.stringify({
            SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 'REF-SERVER-123' }],
            apiversion: '1.0'
          });
        }

        queueMicrotask(() => {
          callback(res);
          res.emit('data', responsePayload);
          res.emit('end');
        });
      };
      return emitter;
    };

    calls.length = 0;
    const res = await dhru.placeImeiOrder('service-1', '123456789012345', {}, {
      apiUrl: 'https://mock.provider.com/api/index.php',
      username: 'user',
      apiKey: 'key'
    });

    assert.equal(res?.SUCCESS?.[0]?.REFERENCEID, 'REF-SERVER-123');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].action, 'placeimeiorder');
    assert.equal(calls[1].action, 'placeserverorder');

    // Test 2: placeServerOrder cascades to placeimeiorder when provider returns Invalid Action
    calls.length = 0;
    https.request = (options, callback) => {
      const emitter = new EventEmitter();
      let body = '';
      emitter.write = (chunk) => { body += chunk; };
      emitter.end = () => {
        const parsedBody = new URLSearchParams(body);
        const action = parsedBody.get('action');
        calls.push({ action, body: parsedBody });

        const res = new EventEmitter();
        res.statusCode = 200;

        let responsePayload;
        if (action === 'placeserverorder') {
          responsePayload = JSON.stringify({
            ERROR: [{ MESSAGE: 'Invalid Action' }],
            apiversion: '1.0'
          });
        } else if (action === 'placeimeiorder') {
          responsePayload = JSON.stringify({
            SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 'REF-IMEI-456' }],
            apiversion: '1.0'
          });
        }

        queueMicrotask(() => {
          callback(res);
          res.emit('data', responsePayload);
          res.emit('end');
        });
      };
      return emitter;
    };

    const res2 = await dhru.placeServerOrder('service-2', 1, {}, '123456789012345', {
      apiUrl: 'https://mock.provider.com/api/index.php',
      username: 'user',
      apiKey: 'key'
    });

    assert.equal(res2?.SUCCESS?.[0]?.REFERENCEID, 'REF-IMEI-456');
    assert.equal(calls.length, 2);
    assert.equal(calls[0].action, 'placeserverorder');
    assert.equal(calls[1].action, 'placeimeiorder');

    // Test 3: Fallback to unified placeorder when both specialized actions return Invalid Action
    calls.length = 0;
    https.request = (options, callback) => {
      const emitter = new EventEmitter();
      let body = '';
      emitter.write = (chunk) => { body += chunk; };
      emitter.end = () => {
        const parsedBody = new URLSearchParams(body);
        const action = parsedBody.get('action');
        calls.push({ action, body: parsedBody });

        const res = new EventEmitter();
        res.statusCode = 200;

        let responsePayload;
        if (action === 'placeserverorder' || action === 'placeimeiorder') {
          responsePayload = JSON.stringify({
            ERROR: [{ MESSAGE: 'Invalid Action' }],
            apiversion: '1.0'
          });
        } else if (action === 'placeorder') {
          responsePayload = JSON.stringify({
            SUCCESS: [{ MESSAGE: 'Order received', REFERENCEID: 'REF-GENERIC-789' }],
            apiversion: '1.0'
          });
        }

        queueMicrotask(() => {
          callback(res);
          res.emit('data', responsePayload);
          res.emit('end');
        });
      };
      return emitter;
    };

    const res3 = await dhru.placeServerOrder('service-3', 1, {}, 'input123', {
      apiUrl: 'https://mock.provider.com/api/index.php',
      username: 'user',
      apiKey: 'key'
    });

    assert.equal(res3?.SUCCESS?.[0]?.REFERENCEID, 'REF-GENERIC-789');
    assert.equal(calls.length, 3);
    assert.equal(calls[0].action, 'placeserverorder');
    assert.equal(calls[1].action, 'placeimeiorder');
    assert.equal(calls[2].action, 'placeorder');

    console.log('invalid action fallback tests passed');
  } finally {
    https.request = originalRequest;
    dns.lookup = originalLookup;
  }
}

testInvalidActionFallbacks().catch((err) => {
  console.error('Test Failed:', err);
  process.exit(1);
});
