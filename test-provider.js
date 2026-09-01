const https = require("https");

const data = new URLSearchParams();
data.append("username", "test");
data.append("key", "test");
data.append("apiaccesskey", "test");
data.append("action", "accountinfo");
data.append("requestformat", "JSON");

fetch("https://ea-unlocker.com/api/index.php", {
  method: "POST",
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json"
  },
  body: data.toString()
}).then(res => res.text()).then(t => console.log("Response:", t)).catch(console.error);
