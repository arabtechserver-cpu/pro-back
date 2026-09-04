const assert = require("assert");
const {
  serializeAdminServiceCategories,
  serializePricingServiceCategories
} = require("./dist/utils/admin-service-response.js");

const categories = [
  {
    id: "category-1",
    name: "Unlocking",
    dhruServices: [
      {
        id: "service-1",
        dhruId: "remote-1",
        name: "Raw service name",
        originalName: "Original service name",
        groupName: "Apple",
        credit: "3.5",
        margin: "1.25",
        time: "1-24 Hours",
        info: "Details",
        isActive: true,
        requiresCustom: [{ label: "IMEI" }],
        createdAt: new Date(),
        updatedAt: new Date()
      },
      {
        id: "service-qty",
        dhruId: "remote-qty",
        name: "Cheetah Tool Credit Any Qnt (Min: 5, Max: 1000)",
        originalName: "Cheetah Tool Credit Any Qnt (Min: 5, Max: 1000)",
        groupName: "Cheetah",
        credit: "1.0",
        margin: "0.20",
        time: "Instant",
        info: "Credits any quantity",
        isActive: true,
        requiresCustom: JSON.stringify([
          { field_id: "Username", name: "Username", type: "text" },
          { field_id: "QNT", name: "QNT", type: "quantity", min_quantity: 5, max_quantity: 1000 }
        ]),
        createdAt: new Date(),
        updatedAt: new Date()
      }
    ]
  }
];

const result = serializeAdminServiceCategories(categories, (name) => `Clean: ${name}`);

assert.equal(result.length, 1);
assert.equal("dhruServices" in result[0], false, "the raw services array must not be sent twice");
assert.deepEqual(result[0].services[0], {
  id: "service-1",
  dhruId: "remote-1",
  name: "Clean: Raw service name",
  originalName: "Original service name",
  groupName: "Apple",
  credit: 3.5,
  margin: 1.25,
  price: 4.75,
  finalPrice: 4.75,
  sellingPrice: 4.75,
  time: "1-24 Hours",
  info: "Details",
  isActive: true,
  requiresCustom: [{ label: "IMEI" }],
  supportsQty: false,
  supports_quantity: false,
  minQty: 1,
  maxQty: 0,
  min_quantity: 1,
  max_quantity: 0
});

// Quantity service assertions
const qtyService = result[0].services[1];
assert.equal(qtyService.supportsQty, true);
assert.equal(qtyService.minQty, 5);
assert.equal(qtyService.maxQty, 1000);

const pricingResult = serializePricingServiceCategories(categories, (name) => `Clean: ${name}`);
assert.deepEqual(pricingResult[0].services[0], {
  id: "service-1",
  dhruId: "remote-1",
  name: "Clean: Raw service name",
  groupName: "Apple",
  credit: 3.5,
  margin: 1.25,
  price: 4.75,
  finalPrice: 4.75,
  sellingPrice: 4.75,
  time: "1-24 Hours",
  isActive: true,
  info: "Details",
  originalName: "Original service name",
  requiresCustom: [
    {
      label: "IMEI"
    }
  ],
  supportsQty: false,
  supports_quantity: false,
  minQty: 1,
  maxQty: 0,
  min_quantity: 1,
  max_quantity: 0
});

assert.equal(pricingResult[0].services[1].supportsQty, true);
assert.equal(pricingResult[0].services[1].minQty, 5);
assert.equal(pricingResult[0].services[1].maxQty, 1000);

console.log("admin service response tests passed");
