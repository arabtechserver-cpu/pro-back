import { DHRU_USERNAME, DHRU_API_KEY, DHRU_API_URL } from './utils/dhru-api';

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
  await testDhru('placeimeiorder', { 'SERVICEID': '', 'IMEI': '123456789012345' });
  await testDhru('placeimeiorder', { 'SERVICEID': '1', 'IMEI': '123456789012345', 'serviceid': 'empty' });
  await testDhru('placeimeiorder', { 'SERVICEID': '1', 'IMEI': '123456789012345', 'ID': '1' });
}
run();
