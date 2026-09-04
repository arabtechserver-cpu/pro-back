const assert = require("assert");
const {
  isQuantityField,
  extractQuantityLimits,
  getServiceQuantityConfig,
  enrichCustomFieldsWithQuantity
} = require("./dist/utils/provider-quantity.js");

// 1. isQuantityField tests
assert.equal(isQuantityField(null, "QNT"), true);
assert.equal(isQuantityField(null, "custom_QNT"), true);
assert.equal(isQuantityField(null, "quantity"), true);
assert.equal(isQuantityField(null, "الكمية"), true);
assert.equal(isQuantityField({ reqid: "QNT" }), true);
assert.equal(isQuantityField({ field_id: "QNT" }), true);
assert.equal(isQuantityField({ fieldname: "custom_QNT" }), true);
assert.equal(isQuantityField({ name: "QNT" }), true);
assert.equal(isQuantityField({ label: "Quantity" }), true);
assert.equal(isQuantityField(null, "email"), false);
assert.equal(isQuantityField({ reqid: "IMEI" }), false);

// 2. extractQuantityLimits tests
// Case A: Explicit provider fields QNT_MIN / QNT_MAX
const service1 = {
  SERVICENAME: "Falcon FRP Tool Credits",
  QNT_MIN: "5",
  QNT_MAX: "500"
};
const limits1 = extractQuantityLimits(service1);
assert.equal(limits1.supportsQty, true);
assert.equal(limits1.minQty, 5);
assert.equal(limits1.maxQty, 500);

// Case B: Custom field with QNT in requiresCustom
const service2 = {
  SERVICENAME: "Cheetah Tool Credit",
  requiresCustom: JSON.stringify([
    { field_id: "Username", type: "text" },
    { field_id: "QNT", description: "Min: 10, Max: 1000", type: "text" }
  ])
};
const limits2 = extractQuantityLimits(service2);
assert.equal(limits2.supportsQty, true);
assert.equal(limits2.minQty, 10);
assert.equal(limits2.maxQty, 1000);

// Case C: Service name with "Credit Any Qnt"
const service3 = {
  SERVICENAME: "MAT AUTH TOOL Credit Any Qnt (Min 20)",
  info: "Instant credit delivery"
};
const limits3 = extractQuantityLimits(service3);
assert.equal(limits3.supportsQty, true);
assert.equal(limits3.minQty, 20);
assert.equal(limits3.maxQty, 0); // 0 = unlimited

// Case D: Non-quantity service
const service4 = {
  SERVICENAME: "iPhone Carrier Check",
  requiresCustom: JSON.stringify([{ field_id: "IMEI", type: "text" }])
};
const limits4 = extractQuantityLimits(service4);
assert.equal(limits4.supportsQty, false);
assert.equal(limits4.minQty, 1);
assert.equal(limits4.maxQty, 0);

// Case E: Service with delivery time range (1-24 Hours) must NOT support quantity
const service5 = {
  SERVICENAME: "EFT Pro 1 Year Activation",
  TIME: "1-24 Hours",
  INFO: "Delivery time: 1-24 Hours for all users"
};
const limits5 = extractQuantityLimits(service5);
assert.equal(limits5.supportsQty, false);

// Case F: Fixed credit pack (e.g. Chimera 150 Credits) must NOT support quantity
const service6 = {
  SERVICENAME: "Chimera Tool 150 Credits",
  INFO: "Server credits package"
};
const limits6 = extractQuantityLimits(service6);
assert.equal(limits6.supportsQty, false);

// Case G: Tool activation period must NOT support quantity
const service7 = {
  SERVICENAME: "UnlockTool 3 Months Activation",
  INFO: "Instant activation 3 months"
};
const limits7 = extractQuantityLimits(service7);
assert.equal(limits7.supportsQty, false);

// Case H: IMEI bypass service with min_quantity: 1 and ECID must NOT support quantity
const service8 = {
  name: "iEZPro Premium for A12 Bypass Passcode With Signal - MAC TOOL",
  groupName: "⚡ iEZPro Tools | Direct Source",
  api_service_type: "imei",
  category_name: "IMEI Service",
  min_quantity: 1,
  requiresCustom: JSON.stringify({
    ecid: { reqid: "ecid", fieldname: "custom_ecid", fieldtype: "text", required: "1" }
  })
};
const limits8 = extractQuantityLimits(service8);
assert.equal(limits8.supportsQty, false);
assert.equal(limits8.minQty, 1);
assert.equal(limits8.maxQty, 0);

// Case I: Non-quantity service must filter out any leftover synthetic custom_QNT
const fieldsWithStaleQNT = [
  { field_id: "ecid", name: "custom_ecid", type: "text" },
  { field_id: "custom_QNT", name: "QNT", type: "quantity" }
];
const cleanedFields = enrichCustomFieldsWithQuantity(fieldsWithStaleQNT, limits8);
assert.equal(cleanedFields.length, 1);
assert.equal(cleanedFields[0].field_id, "ecid");

console.log("provider quantity tests passed successfully");

