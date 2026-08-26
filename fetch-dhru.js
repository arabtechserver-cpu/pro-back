const fs = require('fs');

async function fetchDhru() {
  console.log('Fetching IMEI services...');
  
  const imeiData = new URLSearchParams({
    username: 'mina15g4y',
    key: '3AE-27F-14D-104-830-375-6D',
    action: 'imeiservicelist'
  });
  
  const imeiRes = await fetch('https://arab-tech1.online/api/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: imeiData
  });
  
  const imeiList = await imeiRes.json();
  fs.writeFileSync('../dhru_imei_services.json', JSON.stringify(imeiList, null, 2));
  console.log('Saved to dhru_imei_services.json');

  console.log('Fetching Server services...');
  const serverData = new URLSearchParams({
    username: 'mina15g4y',
    key: '3AE-27F-14D-104-830-375-6D',
    action: 'serverservicelist'
  });
  
  const serverRes = await fetch('https://arab-tech1.online/api/v1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: serverData
  });
  
  const serverList = await serverRes.json();
  fs.writeFileSync('../dhru_server_services.json', JSON.stringify(serverList, null, 2));
  console.log('Saved to dhru_server_services.json');
}

fetchDhru();
