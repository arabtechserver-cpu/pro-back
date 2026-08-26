import { DHRU_USERNAME, DHRU_API_KEY, DHRU_API_URL } from './utils/dhru-api';
import fs from 'fs';

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
  fs.writeFileSync('dhru_imei_list.json', JSON.stringify(await response.json(), null, 2));
}

async function run() {
  await testDhru('imeiservicelist', {});
}
run();
