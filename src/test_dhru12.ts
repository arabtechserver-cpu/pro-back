import { DHRU_USERNAME, DHRU_API_KEY, DHRU_API_URL } from './utils/dhru-api';
const fs = require('fs');

async function testDhru(action: string, params: any) {
  const data = new URLSearchParams({
    username: DHRU_USERNAME,
    key: DHRU_API_KEY,
    action: action,
    ...params
  });
  const response = await fetch(DHRU_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: data
  });
  console.log('\n--- Action: ' + action + ' ---');
  console.log('Params:', JSON.stringify(params));
  console.log('Result:', await response.json());
}

async function run() {
  const data = JSON.parse(fs.readFileSync('dhru_imei_list.json', 'utf8'));
  let serviceId: string | null = null;
  data.SUCCESS[0].LIST.forEach((group: any) => {
    group.SERVICES.forEach((s: any) => {
      if (!s['Requires.Custom'] && serviceId === null && parseFloat(s.CREDIT) > 0) {
        serviceId = s.SERVICEID;
      }
    });
  });
  console.log("Testing with another IMEI service:", serviceId);
  if (serviceId) {
    await testDhru('placeimeiorder', { 'SERVICEID': String(serviceId), 'IMEI': '354481114263571' });
  }
}
run();
