import { DHRU_USERNAME, DHRU_API_KEY, DHRU_API_URL } from './utils/dhru-api';

function generateValidIMEI() {
    let pos;
    let str = new Array(15);
    let sum = 0;
    let final_digit = 0;
    let t = 0;
    let len_offset = 0;
    
    // Apple TAC as an example
    let imeiStr = "35448111426357"; 
    
    for (pos = 0; pos < 14; pos++) {
        let n = parseInt(imeiStr.charAt(pos));
        if (pos % 2 !== 0) {
            n = n * 2;
            if (n > 9) {
                n = (n % 10) + 1;
            }
        }
        sum += n;
    }
    final_digit = (10 - (sum % 10)) % 10;
    return imeiStr + final_digit;
}

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
  const validImei = generateValidIMEI();
  console.log("Valid IMEI:", validImei);
  await testDhru('placeimeiorder', { 'SERVICEID': '1500500003', 'IMEI': validImei });
}
run();
