#!/usr/bin/env node
// Demo helper: bind an owner's Telegram chat to a client DIRECTLY in the DB,
// bypassing the t.me/<bot>?start=<token> deep-link tap. Handy when you already
// know the chat_id (message the bot once, read it from getUpdates).
//
// It mints a bind token and immediately redeems it with channel='telegram', so
// it reuses the exact tested code path the webhook uses (binding row + client
// profile update + audit event) — just without the round-trip. The chat_id is
// stored where phone_e164 goes (the binding's identity slot) and hashed with the
// SAME hashPhoneE164 the inbound anchor uses.
//
// ⚠️ HASH SALT MUST MATCH THE DEPLOYED SERVER (phoneHashSalt = WHATSAPP_PHONE_HASH_SALT
// || WHATSAPP_APP_SECRET). The deployed webhook computes the same hash to find the
// binding when the owner replies. This script prints the hash + salt source so you
// can confirm both sides agree.
//
// Find the chat_id (after the owner messages the bot once):
//   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
//
// Usage:
//   node --env-file=.env.demo scripts/bind_telegram_chat_directly.js \
//     --client honeybee-hills-apiary --chat-id 12345678

import { randomBytes } from 'node:crypto';

import { DEFAULT_FIRM_ID, mintWhatsAppBindTokenInDb, redeemWhatsAppBindTokenInDb } from '../server/donna/firmDb.js';
import { hashWhatsAppToken, hashPhoneE164 } from '../server/donna/channels/whatsappWebhookCore.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CLIENT_ID = arg('client');
const CHAT_ID = arg('chat-id');

const main = async () => {
  if (!CLIENT_ID || !CHAT_ID) {
    console.error('[telegram-bind] --client <id> and --chat-id <telegram chat id> are required.');
    console.error('  e.g. --client honeybee-hills-apiary --chat-id 12345678');
    process.exit(2);
  }
  if (!/^-?\d{5,}$/.test(String(CHAT_ID))) {
    console.error(`[telegram-bind] --chat-id must be a Telegram chat id (integer). Got: ${CHAT_ID}`);
    process.exit(2);
  }

  const saltSource = process.env.WHATSAPP_PHONE_HASH_SALT
    ? 'WHATSAPP_PHONE_HASH_SALT'
    : (process.env.WHATSAPP_APP_SECRET ? 'WHATSAPP_APP_SECRET (fallback)' : 'NONE (!)');

  const token = randomBytes(24).toString('base64url');
  const tokenHash = hashWhatsAppToken(token);
  await mintWhatsAppBindTokenInDb({
    firmId: DEFAULT_FIRM_ID,
    clientId: CLIENT_ID,
    collaboratorId: null,
    actorId: 'script:bind_telegram_chat_directly',
    tokenHash,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString()
  });
  const binding = await redeemWhatsAppBindTokenInDb({ tokenHash, phoneE164: String(CHAT_ID), actorId: 'script:bind_telegram_chat_directly', channel: 'telegram' });

  console.log(`[telegram-bind] bound chat ${CHAT_ID} to client ${CLIENT_ID} (binding ${binding?.id}).`);
  console.log(`[telegram-bind] phone_hash=${hashPhoneE164(String(CHAT_ID))} (salt source: ${saltSource})`);
  console.log('[telegram-bind] The deployed webhook must compute the SAME hash to match inbound replies —');
  console.log('[telegram-bind] i.e. this salt source must equal production. Now run send_honeybee_hero_ask_telegram.js.');
};

main().then(() => process.exit(0), (err) => { console.error('[telegram-bind] FAILED', err); process.exit(1); });
