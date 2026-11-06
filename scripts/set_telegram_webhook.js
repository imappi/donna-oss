#!/usr/bin/env node
// Register (or clear) the Telegram webhook so updates POST to Donna. Telegram
// echoes the secret_token you set here in the X-Telegram-Bot-Api-Secret-Token
// header on every delivery; the webhook (handleTelegramWebhook) checks it. Set
// TELEGRAM_WEBHOOK_SECRET to the SAME value in the deployed env.
//
// There is no template review and no business verification — once this points
// at your deploy, inbound replies flow immediately.
//
// Usage:
//   node --env-file=.env.demo scripts/set_telegram_webhook.js \
//     --url https://<your-deploy>/api/donna/telegram/webhook
//   node --env-file=.env.demo scripts/set_telegram_webhook.js --info     # show current
//   node --env-file=.env.demo scripts/set_telegram_webhook.js --delete   # unregister

import { telegramApiUrl } from '../server/donna/channels/telegram.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const botToken = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

const call = async (method, body) => {
  const res = await fetch(telegramApiUrl({ botToken, method }), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {})
  });
  return res.json().catch(() => ({}));
};

const main = async () => {
  if (!botToken) { console.error('[telegram-webhook] TELEGRAM_BOT_TOKEN is not set.'); process.exit(2); }

  if (arg('info')) {
    const info = await call('getWebhookInfo', {});
    console.log('[telegram-webhook] current:', JSON.stringify(info.result || info, null, 2));
    return;
  }
  if (arg('delete')) {
    const del = await call('deleteWebhook', { drop_pending_updates: false });
    console.log('[telegram-webhook] deleteWebhook:', JSON.stringify(del));
    return;
  }
  const url = arg('url');
  if (!url || url === true) { console.error('[telegram-webhook] --url <https-endpoint> is required (or --info / --delete).'); process.exit(2); }
  if (!secret) { console.error('[telegram-webhook] TELEGRAM_WEBHOOK_SECRET is not set — refusing to register an unauthenticated webhook.'); process.exit(2); }

  const result = await call('setWebhook', {
    url,
    secret_token: secret,
    // Only the update kinds the owner loop consumes.
    allowed_updates: ['message', 'edited_message'],
    drop_pending_updates: false
  });
  if (result.ok) console.log(`[telegram-webhook] registered ${url} (secret header enforced).`);
  else { console.error('[telegram-webhook] setWebhook FAILED:', JSON.stringify(result)); process.exit(1); }
};

main().then(() => process.exit(0), (err) => { console.error('[telegram-webhook] FAILED', err); process.exit(1); });
