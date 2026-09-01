const assert = require("assert");
const providers = require("./dist/routes/providers.js");

function run() {
  assert.equal(
    providers.normalizeApiUrl("https://arab-tech1.online/api/v1"),
    "https://arab-tech1.online/api/v1"
  );

  assert.equal(typeof providers.extractProviderAccountInfo, "function");
  assert.equal(typeof providers.getProviderApiErrorMessage, "function");
  assert.equal(typeof providers.isProviderApiSuccess, "function");

  assert.deepEqual(
    providers.extractProviderAccountInfo({
      SUCCESS: [{ AccountInfo: { credit: "57.84", currency: "USD" } }]
    }),
    { balance: 57.84, currency: "USD" }
  );

  assert.deepEqual(
    providers.extractProviderAccountInfo({
      RESULT: { credit: "24.87", currency: "USD" }
    }),
    { balance: 24.87, currency: "USD" }
  );

  assert.equal(
    providers.isProviderApiSuccess({ error: "<html><body>404 Not Found</body></html>" }),
    false
  );

  assert.equal(
    providers.getProviderApiErrorMessage({ ERROR: [{ MESSAGE: "Invalid API key" }] }),
    "Invalid API key"
  );

  console.log("providers regression tests passed");
}

run();
