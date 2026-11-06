#!/usr/bin/env node
// Throwaway "does it land?" smoke test for the Telegram owner channel. NO DB,
// NO binding — just proves a @BotFather token can push a free-form message to a
// chat_id. This is the first beat of the build (instant gratification): send a
// message to the bot from your own Telegram, read the chat_id from getUpdates,
// then run this.
//
// Find your chat_id (after you've messaged the bot at least once):
//   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
//     | python3 -c 'import sys,json;print([u["message"]["chat"]["id"] for u in json.load(sys.stdin)["result"] if "message" in u])'
//
// Usage:
//   node --env-file=.env.demo scripts/telegram_send_test.js --chat-id 12345678 --text "Hello from Donna"
//   (or: TELEGRAM_TEST_CHAT_ID=12345678 node --env-file=.env.demo scripts/telegram_send_test.js)

import { sendTelegramMessage, isTelegramConfigured } from '../server/donna/channels/telegram.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const chatId = arg('chat-id', process.env.TELEGRAM_TEST_CHAT_ID || '');
const text = arg('text', "It's Donna. Telegram channel is live — reply and I'll pick it up.");

const main = async () => {
  if (!isTelegramConfigured()) {
    console.error('[telegram-send-test] TELEGRAM_BOT_TOKEN is not set. Add it (from @BotFather) to your env file.');
    process.exit(2);
  }
  if (!chatId) {
    console.error('[telegram-send-test] --chat-id <id> is required (or set TELEGRAM_TEST_CHAT_ID).');
    console.error('  Get it from getUpdates after you message the bot once — see the header of this script.');
    process.exit(2);
  }
  const result = await sendTelegramMessage({ chatId, text });
  if (!result.ok) {
    console.error('[telegram-send-test] FAILED:', result.error || result.reason || result);
    process.exit(1);
  }
  console.log(`[telegram-send-test] sent message_id=${result.id} to chat ${chatId}. Check your Telegram.`);
};

main().then(
  () => process.exit(0),
  (err) => { console.error('[telegram-send-test] FAILED', err); process.exit(1); }
);
