const assert = require("assert");
const fs = require("fs");

let transactionQuery = {};
let apiActivation = {};
try {
  transactionQuery = require("./dist/utils/transaction-query.js");
  apiActivation = require("./dist/utils/api-activation.js");
} catch {}

const normalizeTransactionListQuery =
  transactionQuery.normalizeTransactionListQuery || (() => ({}));
const buildAdminTransactionPageQuery =
  transactionQuery.buildAdminTransactionPageQuery || (() => ({}));
const prepareApiActivation =
  apiActivation.prepareApiActivation || (() => { throw new Error("not implemented"); });

const normalizedQuery = normalizeTransactionListQuery({
  limit: "999",
  cursor: "tx-cursor",
  status: "pending",
  search: "  Mina  "
});
assert.deepEqual(normalizedQuery, {
  limit: 50,
  cursor: "tx-cursor",
  status: "pending",
  search: "Mina"
});

const pageQuery = buildAdminTransactionPageQuery(normalizedQuery);
assert.equal(pageQuery.take, 51, "one extra row is required to calculate hasMore");
assert.deepEqual(pageQuery.cursor, { id: "tx-cursor" });
assert.equal(pageQuery.skip, 1);
assert.equal(pageQuery.select.receiptImage, undefined, "large receipt images must not be selected in list requests");
assert.equal(pageQuery.where.status, "pending");
assert.ok(Array.isArray(pageQuery.where.OR), "search must be handled by the database");

assert.throws(
  () => prepareApiActivation({ apiSiteName: "Store", apiSiteUrl: "https://store.test", confirmActivation: false }, null, () => "new-key"),
  /confirmation/i
);

const existingKeyActivation = prepareApiActivation(
  { apiSiteName: "  Store  ", apiSiteUrl: "https://store.test/", confirmActivation: true },
  "ATS-existing",
  () => "ATS-new"
);
assert.deepEqual(existingKeyActivation, {
  apiEnabled: true,
  apiSiteName: "Store",
  apiSiteUrl: "https://store.test/",
  apiKey: "ATS-existing"
});

const newKeyActivation = prepareApiActivation(
  { apiSiteName: "Store", apiSiteUrl: "https://store.test", confirmActivation: true },
  null,
  () => "ATS-new"
);
assert.equal(newKeyActivation.apiKey, "ATS-new");
assert.equal(newKeyActivation.apiEnabled, true);

const prismaSchema = fs.readFileSync("./prisma/schema.prisma", "utf8");
const transactionModel = prismaSchema.match(/model Transaction \{[\s\S]*?\n\}/)?.[0] || "";
assert.match(transactionModel, /@@index\(\[createdAt\]\)/, "transaction chronology needs an index");
assert.match(transactionModel, /@@index\(\[status, createdAt\]\)/, "status pagination needs a compound index");

console.log("wallet and API activation regression tests passed");
