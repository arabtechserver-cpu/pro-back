const fs = require('fs');
const data = JSON.parse(fs.readFileSync('dhru_imei_list.json', 'utf8'));
data.SUCCESS[0].LIST.forEach(group => {
  group.SERVICES.forEach(s => {
    if (s.SERVICEID == 1500500003) console.log(JSON.stringify(s, null, 2));
  });
});
