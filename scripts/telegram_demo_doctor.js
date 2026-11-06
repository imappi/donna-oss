#!/usr/bin/env node
// Demo doctor: one command that checks every link in the Telegram owner-loop
// chain for a client and prints PASS/FAIL with the reason — so you stop guessing
// token vs allowlist vs binding vs webhook vs delivery. Twin of the WhatsApp
// doctor, minus the Meta/template limbs Telegram doesn't have.
//
// Reads env (TELEGRAM_BOT_TOKEN, gate vars, webhook secret) and the firm DB.
// Nothing is mutated. No secrets are printed.
//
// Usage:
//   node --env-file=.env.demo scripts/telegram_demo_doctor.js --client honeybee-hills-apiary
//   node --env-file=.env.demo scripts/telegram_demo_doctor.js --client honeybee-hills-apiary --ask cer-honeybee-hero-delta-2026-06

import { DEFAULT_FIRM_ID, withFirmDbClient } from '../server/donna/firmDb.js';
import { telegramApiUrl } from '../server/donna/channels/telegram.js';

const arg = (name, fallback = null) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};

const CLIENT_ID = arg('client', 'honeybee-hills-apiary');
const ASK_ID = arg('ask', 'cer-honeybee-hero-delta-2026-06');

const mask = (v) => (v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)} (len ${String(v).length})` : '(unset)');
const line = (ok, label, detail) => console.log(`  ${ok ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`);

const main = async () => {
  const token = String(process.env.TELEGRAM_BOT_TOKEN || '').trim();
  const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();

  console.log(`\nTelegram demo doctor — firm=${DEFAULT_FIRM_ID} client=${CLIENT_ID}\n`);

  console.log('Env gate:');
  line(String(process.env.TELEGRAM_ENABLED).toLowerCase() === 'true', 'TELEGRAM_ENABLED=true', process.env.TELEGRAM_ENABLED || '(unset)');
  const clients = String(process.env.TELEGRAM_CLIENTS || '').split(',').map((s) => s.trim());
  line(clients.includes(CLIENT_ID), `TELEGRAM_CLIENTS includes ${CLIENT_ID}`, process.env.TELEGRAM_CLIENTS || '(unset)');
  line(Boolean(token), 'TELEGRAM_BOT_TOKEN set', mask(token));
  line(Boolean(secret), 'TELEGRAM_WEBHOOK_SECRET set', mask(secret));

  console.log('\nTelegram Bot API (is the token valid, and is the webhook registered?):');
  if (token) {
    try {
      const me = await fetch(telegramApiUrl({ botToken: token, method: 'getMe' })).then((r) => r.json()).catch(() => ({}));
      if (me?.ok && me.result) line(true, 'token valid (getMe)', `@${me.result.username || me.result.id}`);
      else line(false, 'getMe failed', me?.description || 'token invalid?');

      const hook = await fetch(telegramApiUrl({ botToken: token, method: 'getWebhookInfo' })).then((r) => r.json()).catch(() => ({}));
      const info = hook?.result || {};
      line(Boolean(info.url), 'webhook registered', info.url || 'NONE — run set_telegram_webhook.js');
      // has_custom_certificate/pending_update_count/last_error_message are the useful signals.
      if (info.last_error_message) line(false, 'webhook last error', `${info.last_error_message} (at ${info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : '?'})`);
      if (info.pending_update_count) line(info.pending_update_count === 0, 'pending updates', String(info.pending_update_count));
    } catch (err) {
      line(false, 'Telegram API call errored', err?.message || String(err));
    }
  } else {
    line(false, 'skipped', 'TELEGRAM_BOT_TOKEN missing from env');
  }

  console.log('\nDatabase state:');
  await withFirmDbClient(async (client) => {
    const q = (text, params) => client.query(text, params).catch((e) => ({ rows: [], error: e }));

    const c = await q('select id from clients where firm_id = $1 and id = $2', [DEFAULT_FIRM_ID, CLIENT_ID]);
    line(c.rows.length > 0, `client ${CLIENT_ID} exists under ${DEFAULT_FIRM_ID}`, c.error ? c.error.message : (c.rows.length ? '' : 'NOT FOUND — wrong firm?'));

    const ask = await q('select id, status, transaction_id from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3', [DEFAULT_FIRM_ID, CLIENT_ID, ASK_ID]);
    const askRow = ask.rows[0];
    line(Boolean(askRow) && askRow.status === 'open', `hero ask ${ASK_ID} is open`, askRow ? `status=${askRow.status} txn=${askRow.transaction_id || 'null'}` : 'NOT FOUND');

    const b = await q("select id, phone_e164, channel from client_whatsapp_bindings where firm_id = $1 and client_id = $2 and coalesce(channel,'whatsapp') = 'telegram' and revoked_at is null", [DEFAULT_FIRM_ID, CLIENT_ID]);
    line(b.rows.length > 0, 'active Telegram binding exists', b.rows.length ? `chat_id=${b.rows[0].phone_e164}` : 'NONE — run bind_telegram_chat_directly.js');

    const led = await q("select sent_at, failed_at, failure_reason, template_name, provider from message_delivery_ledger where ask_id = $1 and provider = 'telegram' order by created_at desc limit 3", [ASK_ID]);
    if (led.rows.length) {
      console.log('\nLast Telegram send attempts for this ask (most recent first):');
      for (const r of led.rows) {
        if (r.sent_at) line(true, `sent_at ${r.sent_at}`, r.template_name || '');
        else line(false, `failed_at ${r.failed_at || '?'}`, r.failure_reason || 'no reason recorded');
      }
    } else {
      console.log('\n  (no telegram delivery-ledger rows yet for this ask — send has not been attempted, or failed before recording)');
    }
  });

  console.log('\nRead top-to-bottom: the first ❌ is what to fix next.\n');
};

main().then(() => process.exit(0), (err) => { console.error('[doctor] FAILED', err); process.exit(1); });
