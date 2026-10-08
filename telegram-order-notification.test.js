const assert = require('node:assert/strict');
const { test } = require('node:test');
const { normalizeTelegramAdminChatIds } = require('./dist/utils/telegram-config');

assert.deepEqual(normalizeTelegramAdminChatIds(['', '7053196033', '7053196033'], ''), ['7053196033']);

// Recipients are persisted in the database and survive a process/container refresh.
// Sending the customer response no longer waits for Telegram; api-reliability.test.js
// checks order creation with a stalled notification request.
test('Telegram recipients persist in the DB and merge with the environment on reload', async () => {
  process.env.TELEGRAM_ADMIN_CHAT_ID = 'env-admin';
  const { prisma } = require('./dist/utils/prisma');
  const originalUpsert = prisma.setting.upsert;
  const originalFind = prisma.setting.findUnique;
  let stored;
  prisma.setting.upsert = async args => {
    assert.equal(args.where.key, 'telegram_admin_chat_ids');
    stored = args.update.value;
    return { value: stored };
  };
  prisma.setting.findUnique = async args => {
    assert.equal(args.where.key, 'telegram_admin_chat_ids');
    return { value: stored };
  };
  try {
    const telegram = require('./dist/utils/telegramService');
    assert.deepEqual(await telegram.saveAdminChatIdsToDb(['db-admin', 'db-admin', '']), ['db-admin', 'env-admin']);
    assert.deepEqual(await telegram.refreshAdminIds(), ['db-admin', 'env-admin']);
    assert.deepEqual(telegram.getAdminChatIds(), ['db-admin', 'env-admin']);
  } finally { prisma.setting.upsert = originalUpsert; prisma.setting.findUnique = originalFind; }
});
