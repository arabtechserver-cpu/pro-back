const assert = require("assert");
const dhruApi = require("./dist/utils/dhru-api.js");
const orderResponse = require("./dist/utils/order-response.js");

const normalizeProviderCustomFields =
  dhruApi.normalizeProviderCustomFields || ((fields) => fields);

const normalized = normalizeProviderCustomFields(
  { custom_PlayerID: "51470430069" },
  JSON.stringify([
    {
      id: "custom_PlayerID",
      field_id: "PlayerID",
      name: "custom_PlayerID",
      label: "custom_PlayerID",
      required: true
    }
  ])
);

assert.deepEqual(normalized, { PlayerID: "51470430069" });

const structuredNotes = JSON.stringify({
  userNote: null,
  rawImei: null,
  customFields: { custom_PlayerID: "51470430069" },
  events: [{ action: "ORDER_CREATED" }]
});
assert.equal(orderResponse.parseOrderMetadata(structuredNotes).visibleNote, null);
assert.equal(
  orderResponse.parseOrderMetadata(
    JSON.stringify({ userNote: "ملاحظة العميل", events: [] })
  ).visibleNote,
  "ملاحظة العميل"
);
assert.equal(orderResponse.parseOrderMetadata("legacy note").visibleNote, "legacy note");

const buildOrderFieldDetails =
  orderResponse.buildOrderFieldDetails || (() => []);
assert.deepEqual(
  buildOrderFieldDetails(
    JSON.stringify([
      {
        id: "custom_QNT",
        field_id: "QNT",
        label: "QNT",
        type: "text",
        required: true
      },
      {
        id: "custom_email",
        field_id: "email",
        label: "email",
        type: "text",
        required: true
      }
    ]),
    { QNT: "2", custom_QNT: "2", custom_email: "belalabdaltwap@gmail.com" }
  ),
  [
    {
      id: "custom_QNT",
      providerFieldId: "QNT",
      label: "QNT",
      type: "text",
      required: true,
      value: "2",
      missing: false
    },
    {
      id: "custom_email",
      providerFieldId: "email",
      label: "email",
      type: "text",
      required: true,
      value: "belalabdaltwap@gmail.com",
      missing: false
    }
  ]
);

const getOrderServiceType =
  orderResponse.getOrderServiceType || (() => "unknown");
assert.equal(getOrderServiceType("IMEI Service"), "imei");
assert.equal(getOrderServiceType("Server Service"), "server");
assert.equal(getOrderServiceType("Remote Service"), "remote");

const resolveOrderServiceType =
  orderResponse.resolveOrderServiceType || (() => "unknown");
assert.equal(resolveOrderServiceType("server", "IMEI Service", "IMEI Group"), "server");
assert.equal(resolveOrderServiceType(null, "Remote Service", "General"), "remote");
assert.equal(resolveOrderServiceType(null, null, "IMEI Tools"), "imei");

console.log("order dispatch field tests passed");
