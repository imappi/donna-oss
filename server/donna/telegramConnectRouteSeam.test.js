// Route-seam tests for the Telegram self-serve connect trio (row 17's last
// named absence — retires scripts/bind_telegram_chat_directly.js as the only
// way to bind):
//   GET  /telegram/binding-state   — channel verdict + active binding
//   POST /telegram/connect-token   — one-time token; t.me deep link when
//                                    TELEGRAM_BOT_USERNAME is set, manual
//                                    /start command always
//   POST /telegram/bindings/revoke — disconnect by binding id
//
// The redeem half is NOT here — the Telegram webhook already consumes
// "/start <token>" with channel='telegram' through the shared bind-token
// store (its pins live with the webhook/binding-store tests). These tests
// cover the ROUTE seam only.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { extractTelegramStartToken } from './channels/telegramWebhookCore.js';

const TOKEN = 'telegram-connect-seam';
const priorToken = process.env.DONNA_ACCESS_TOKEN;
const priorDb = process.env.DATABASE_URL;
const priorBot = process.env.TELEGRAM_BOT_USERNAME;
process.env.DONNA_ACCESS_TOKEN = TOKEN;
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
const auth = { authorization: `Bearer ${TOKEN}` };

test.after(() => {
  if (priorToken === undefined) delete process.env.DONNA_ACCESS_TOKEN; else process.env.DONNA_ACCESS_TOKEN = priorToken;
  if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
  if (priorBot === undefined) delete process.env.TELEGRAM_BOT_USERNAME; else process.env.TELEGRAM_BOT_USERNAME = priorBot;
});

const TELEGRAM_BINDING_ROW = {
  id: 'tgb_1', firm_id: 'firm-1', client_id: 'c-1', channel: 'telegram',
  phone_e164: '123456789', created_at: '2026-08-01T10:00:00.000Z', verified_at: '2026-08-01T10:00:00.000Z'
};

await test('GET telegram/binding-state: no config → channel_acts false, binding rendered from the telegram channel row', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  delete process.env.TELEGRAM_ENABLED;
  delete process.env.TELEGRAM_CLIENTS;
  const pool = createApiSeamPool([
    [/coalesce\(channel, 'whatsapp'\) = 'telegram'/, { rows: [TELEGRAM_BINDING_ROW], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/telegram/binding-state?client_id=c-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.channel_acts, false);
  assert.deepEqual(response.json.binding, {
    id: 'tgb_1', created_at: '2026-08-01T10:00:00.000Z', masked_chat_id: '••••6789'
  });
  // The binding read must be channel-scoped — a WhatsApp row must never
  // satisfy the Telegram card.
  assert.equal(pool.matching(/= 'telegram'/).length, 1);
});

await test('GET telegram/binding-state: config-plane canary → channel_acts true, no binding → null', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    [/from client_capability_config/, { rows: [{ flag_key: 'OWNER_CHANNEL_TELEGRAM', stage: 'canary', source: 'test', client_id: 'c-1' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({ url: '/api/donna/firms/telegram/binding-state?client_id=c-1', headers: auth, pool });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.channel_acts, true);
  assert.equal(response.json.binding, null);
});

await test('POST telegram/connect-token: mints once; deep link only when TELEGRAM_BOT_USERNAME is set', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TELEGRAM_BOT_USERNAME = '@your-bot-name';
  const pool = createApiSeamPool([]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/telegram/connect-token',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { client_id: 'c-1' }, pool
  });
  assert.equal(response.statusCode, 201, response.body);
  const mints = pool.matching(/insert into client_whatsapp_bind_tokens/);
  assert.equal(mints.length, 1, 'exactly one token minted into the shared store');
  // The manual fallback and the deep link carry the SAME token, and it must
  // be the shape the webhook's extractor actually redeems.
  const startToken = extractTelegramStartToken(response.json.start_command);
  assert.ok(startToken.length >= 16, `start_command must carry an extractable token, got ${response.json.start_command}`);
  assert.ok(startToken.length <= 64, 'token must fit Telegram’s 64-char start payload');
  assert.equal(response.json.t_me_url, `https://t.me/your-bot-name?start=${encodeURIComponent(startToken)}`, 'the @ is stripped from the username');
  assert.match(response.json.expires_at, /^\d{4}-\d{2}-\d{2}T/);
});

await test('POST telegram/connect-token: without TELEGRAM_BOT_USERNAME the deep link is null, the command remains', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  delete process.env.TELEGRAM_BOT_USERNAME;
  const pool = createApiSeamPool([]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/telegram/connect-token',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { client_id: 'c-1' }, pool
  });
  assert.equal(response.statusCode, 201, response.body);
  assert.equal(response.json.t_me_url, null);
  assert.ok(extractTelegramStartToken(response.json.start_command), 'manual /start command still redeemable');
});

await test('POST telegram/connect-token: client_id required', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/telegram/connect-token',
    headers: { ...auth, 'content-type': 'application/json' },
    body: {}, pool
  });
  assert.equal(response.statusCode, 400);
  assert.equal(pool.matching(/insert into client_whatsapp_bind_tokens/).length, 0);
});

await test('POST telegram/bindings/revoke: revokes by id through the shared writer', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([
    [/update client_whatsapp_bindings set revoked_at/, { rows: [{ ...TELEGRAM_BINDING_ROW, revoked_at: '2026-08-02T12:00:00.000Z' }], rowCount: 1 }]
  ]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/telegram/bindings/revoke',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { client_id: 'c-1', binding_id: 'tgb_1' }, pool
  });
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json.revoked, true);
  assert.equal(pool.matching(/insert into audit_events/).length, 1, 'revocation is audited');
});

await test('POST telegram/bindings/revoke: unknown binding → 404, revoked false', async () => {
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const pool = createApiSeamPool([]);
  const response = await requestDonnaApi({
    method: 'POST', url: '/api/donna/firms/telegram/bindings/revoke',
    headers: { ...auth, 'content-type': 'application/json' },
    body: { client_id: 'c-1', binding_id: 'tgb_missing' }, pool
  });
  assert.equal(response.statusCode, 404);
  assert.equal(response.json.revoked, false);
});
