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
  requiresCustom: [{ label: "IMEI" }]
});

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
  isActive: true
});

console.log("admin service response tests passed");
