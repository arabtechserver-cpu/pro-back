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
  console.log('Result:', JSON.stringify(await response.json()).substring(0, 1000));
}

async function run() {
  await testDhru('imeiservicelist', {});
}
run();
