import { dhruApiRequest } from './src/utils/dhru-api';
import * as fs from 'fs';

async function fetchDhru() {
  console.log('Fetching IMEI services...');
  const imeiList = await dhruApiRequest('imeiservicelist');
  fs.writeFileSync('../dhru_imei_services.json', JSON.stringify(imeiList, null, 2));
  console.log('Saved to dhru_imei_services.json');

  console.log('Fetching Server services...');
  const serverList = await dhruApiRequest('serverservicelist');
  fs.writeFileSync('../dhru_server_services.json', JSON.stringify(serverList, null, 2));
  console.log('Saved to dhru_server_services.json');
}

fetchDhru();
