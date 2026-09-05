// Avoid starting the production Telegram listener when loading route helpers.
require.cache[require.resolve('./dist/utils/telegramService')] = { exports: {} };
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { extractCustomFields, normalizeCustomField } = require('./dist/routes/providers');
const { extractQuantityLimits, getServiceQuantityConfig } = require('./dist/utils/provider-quantity');
test('provider quantity field survives normalization and storage', () => {
 const fields = extractCustomFields({ 'Requires.Custom': {
 QNT: { reqid: 'QNT', fieldname: 'Quantity', min: 5, max: 50, required: '1' },
 hidden: { fieldname: 'Internal', adminonly: '1' },
 email: { fieldname: 'Email', adminonly: '0', required: '1' }
 }}).map(normalizeCustomField).filter(Boolean);
 assert.deepEqual(fields.map(f => f.field_id), ['QNT', 'email']);
 const config = getServiceQuantityConfig({ providerId: 'p1', name: 'Provider service', requiresCustom: JSON.stringify(fields) });
 assert.equal(config.supportsQty, true); assert.equal(config.minQty, 5); assert.equal(config.maxQty, 50);
});
test('explicit limits need no quantity keyword', () => {
 assert.deepEqual(extractQuantityLimits({ SERVICENAME: 'Provider service', MINQNT: '5', MAXQNT: '100' }), { supportsQty: true, minQty: 5, maxQty: 100 });
});
test('local services do not acquire provider quantity controls', () => {
 assert.equal(getServiceQuantityConfig({ providerId: null, name: 'Any Qty Credits', supportsQty: true }).supportsQty, false);
});
test('real provider QNT on IMEI service is retained', () => {
 assert.equal(extractQuantityLimits({ SERVICETYPE: 'imei', requiresCustom: JSON.stringify([
 { id: 'custom_IMEI', field_id: 'IMEI' }, { id: 'custom_QNT', field_id: 'QNT', type: 'quantity', min_quantity: 3 }
 ]) }).supportsQty, true);
});
test('normalization preserves API identity across repeated imports', () => {
 const field = normalizeCustomField({ id: 'custom_Email', label: 'Email', type: 'email', required: true });
 assert.equal(field.field_id, 'Email'); assert.equal(normalizeCustomField(field).id, 'custom_Email');
});
const { parseAllProviderServices } = require('./dist/routes/providers');
test('provider email-only service keeps its exact fields even in IMEI endpoint', () => {
 const [service] = parseAllProviderServices({ data: [{ GROUPNAME: 'IMEI', SERVICES: [{ SERVICEID: '1', SERVICENAME: 'Activation', 'Requires.Custom': { Email: { fieldname: 'custom_Email', required: '1' } } }] }] });
 assert.deepEqual(service.customFields.map(f => f.field_id), ['Email']);
});
test('provider required IMEI is not changed to optional', () => {
 const [service] = parseAllProviderServices({ data: [{ GROUPNAME: 'IMEI', SERVICES: [{ SERVICEID: '1', SERVICENAME: 'Check', 'Requires.Custom': { IMEI: { fieldname: 'IMEI', required: '1' } } }] }] });
 assert.equal(service.customFields[0].required, true);
});
test('stored default limits do not hide limits from the real provider quantity field', () => {
 const config = getServiceQuantityConfig({ providerId: 'p', name: 'Service', supportsQty: false, minQty: 1, maxQty: 0,
 requiresCustom: JSON.stringify([{ id: 'custom_QNT', field_id: 'QNT', min_quantity: 5, max_quantity: 50 }]) });
 assert.equal(config.minQty, 5); assert.equal(config.maxQty, 50);
});
test('service lists preserve real QNT fields and quantity support', () => {
 const { serializeAdminServiceCategories, serializePricingServiceCategories } = require('./dist/utils/admin-service-response');
 const categories = [{ id:'c', name:'Server', dhruServices:[{ id:'s', providerId:'p', name:'Service', requiresCustom:JSON.stringify([{ id:'custom_QNT', field_id:'QNT', min_quantity:5, max_quantity:50 }]) }] }];
 for (const serialize of [serializeAdminServiceCategories, serializePricingServiceCategories]) {
  const service = serialize(categories, name => name)[0].services[0];
  assert.equal(service.supportsQty,true); assert.equal(service.minQty,5);
 }
});
