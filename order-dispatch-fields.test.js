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

console.log("order dispatch field tests passed");
