const assert = require("assert");
const fs = require("fs");
const path = require("path");
const providers = require("./dist/routes/providers.js");
const providerServiceIds = require("./dist/utils/provider-service-id.js");

function run() {
  assert.equal(
    providers.normalizeApiUrl("https://arab-tech1.online/api/v1"),
    "https://arab-tech1.online/api/v1"
  );

  assert.equal(typeof providers.extractProviderAccountInfo, "function");
  assert.equal(typeof providers.getProviderApiErrorMessage, "function");
  assert.equal(typeof providers.isProviderApiSuccess, "function");

  const normalizeRequestedServiceTypes =
    providers.normalizeRequestedServiceTypes || (() => []);
  assert.deepEqual(
    normalizeRequestedServiceTypes(["imei", "remote", "invalid", "imei"]),
    ["imei", "remote"]
  );
  assert.deepEqual(
    normalizeRequestedServiceTypes(undefined),
    ["imei", "server", "remote"]
  );
  assert.deepEqual(normalizeRequestedServiceTypes([]), []);

  const getProviderServiceType =
    providers.getProviderServiceType || (() => "unknown");
  assert.equal(getProviderServiceType("IMEI Service"), "imei");
  assert.equal(getProviderServiceType("Server Service"), "server");
  assert.equal(getProviderServiceType("Remote Service"), "remote");

  const getProviderServiceApiActions =
    providers.getProviderServiceApiActions || (() => []);
  assert.deepEqual(
    getProviderServiceApiActions(["imei", "remote"]),
    [
      { type: "imei", action: "imeiservicelist" },
      { type: "remote", action: "remoteservicelist" }
    ]
  );

  const normalizeProviderApiServiceType =
    providers.normalizeProviderApiServiceType || (() => "unknown");
  assert.equal(normalizeProviderApiServiceType("SERVER SERVICE", "imei"), "server");
  assert.equal(normalizeProviderApiServiceType(undefined, "remote"), "remote");

  const explicitTypeServices = providers.parseAllProviderServices(
    {
      data: {
        SUCCESS: [{
          LIST: {
            test: {
              GROUPNAME: "Mixed Provider Group",
              SERVICES: [{ SERVICEID: "type-1", SERVICENAME: "Provider Typed", SERVICETYPE: "SERVER" }]
            }
          }
        }]
      }
    },
    undefined
  );
  assert.equal(explicitTypeServices[0].service_type, "server");
  assert.equal(explicitTypeServices[0].api_service_type, "server");

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

  const firstProviderServiceId = providerServiceIds.buildProviderServiceId("provider-a", "1477000001");
  const secondProviderServiceId = providerServiceIds.buildProviderServiceId("provider-b", "1477000001");
  assert.notEqual(firstProviderServiceId, secondProviderServiceId);
  assert.equal(providerServiceIds.getProviderRemoteServiceId(firstProviderServiceId), "1477000001");
  assert.equal(providerServiceIds.getProviderRemoteServiceId(secondProviderServiceId), "1477000001");
  assert.equal(providerServiceIds.getProviderRemoteServiceId("1477000001"), "1477000001");

  const imeiPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dhru_imei_services.json"), "utf8"));
  const serverPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "dhru_server_services.json"), "utf8"));
  const parsedServices = providers.parseAllProviderServices({ data: imeiPayload }, { data: serverPayload });
  assert.ok(parsedServices.length >= 1171, "expected every provider service to be parsed");
  const serviceWithEmail = parsedServices.find((service) => service.service_id === "1477000001");
  assert.equal(serviceWithEmail.group_name, "Haafedk Tool iCloud");
  assert.equal(serviceWithEmail.customFields[0].name, "custom_Email");
  assert.equal(serviceWithEmail.customFields[0].required, true);

  const prismaSchema = fs.readFileSync(path.join(__dirname, "prisma", "schema.prisma"), "utf8");
  assert.match(prismaSchema, /apiServiceType\s+String\?\s+@map\("api_service_type"\)/);

  console.log("providers regression tests passed");
}

run();
