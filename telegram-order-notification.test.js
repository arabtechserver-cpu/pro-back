const assert = require("assert");
const fs = require("fs");

let telegramConfig = {};
try {
  telegramConfig = require("./dist/utils/telegram-config.js");
} catch {}

const normalizeTelegramAdminChatIds =
  telegramConfig.normalizeTelegramAdminChatIds || (() => []);

assert.deepEqual(
  normalizeTelegramAdminChatIds(["", "7053196033", "7053196033"], ""),
  ["7053196033"],
  "Telegram recipients must be unique and must not contain an empty chat ID"
);

const dockerfile = fs.readFileSync("Dockerfile", "utf8");
assert.match(
  dockerfile,
  /COPY\s+telegram_admins\.json\s+\.\/telegram_admins\.json/,
  "The runtime image must include persisted Telegram admin chat IDs"
);

const ordersSource = fs.readFileSync("src/routes/orders.ts", "utf8");
assert.match(
  ordersSource,
  /await\s+sendTelegramPhotoNotification\(\{\s*caption\s*\}\)/,
  "Order creation must await Telegram delivery"
);

console.log("telegram order notification tests passed");
