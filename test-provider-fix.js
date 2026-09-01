const { makeProviderApiCall } = require("./dist/routes/providers.js");

(async () => {
  const result = await makeProviderApiCall("https://ea-unlocker.com", "omar", "WRONG_KEY", "accountinfo", {});
  console.log("Result:", result);
})();
