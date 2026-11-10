import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';

// The owner channels' connection replies, through the signed webhook routes in
// api.js (the functions SMS, Telegram and WhatsApp actually call):
// - a connection code that does not redeem gets an honest reply, and nothing
//   is marked connected;
// - a bare Telegram /start from a chat that is already connected gets the
//   reply for a connected owner, in that owner's language.
// Synthetic numbers and chat ids only.

const priorDb = process.env.DATABASE_URL;
const TOKEN = 'synthTokenAbcdefghijklmnopqrstu0123';

const captureFetch = () => {
  const sends = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sends.push({ url: String(url), options });
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 }, messages: [{ id: 'out-1' }], sid: 'SMout' }) };
  };
  return { sends, restore: () => { globalThis.fetch = originalFetch; } };
};

const tokenRow = { token_hash: 'h', firm_id: 'donna-demo-firm', client_id: 'fi-client-1', collaborator_id: 'owner-1', created_by: 'firm-user-1', expires_at: '2999-01-01T00:00:00.000Z', redeemed_at: null, revoked_at: null };
const finnishClient = [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'FI', profile: {} }], rowCount: 1 }];
const redeemSucceeds = (channel) => [
  [/select \* from client_whatsapp_bind_tokens/, { rows: [tokenRow], rowCount: 1 }],
  [/insert into client_whatsapp_bindings/, ({ params }) => ({ rows: [{ id: params[0], firm_id: params[1], client_id: params[2], collaborator_id: params[3], channel }], rowCount: 1 })],
  finnishClient
];
const redeemThrows = [[/select \* from client_whatsapp_bind_tokens/, () => { throw new Error('connection reset'); }]];

const assertNothingMarkedConnected = (pool) => {
  assert.equal(pool.matching(/insert into client_whatsapp_bindings/).length, 0, 'no binding is written');
  assert.equal(pool.matching(/update client_whatsapp_bind_tokens set redeemed_at/).length, 0, 'the token is not marked redeemed');
  assert.equal(pool.matching(/update clients set profile/).length, 0, 'the client profile is not marked connected');
};

const postTelegram = async ({ text, chatId = 15551239001, pool }) => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'telegram-seam-token';
  return requestDonnaApi({
    method: 'POST', url: '/api/donna/telegram/webhook',
    headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret', 'content-type': 'application/json' },
    body: { update_id: 7001, message: { message_id: 11, chat: { id: chatId, type: 'private' }, from: { id: chatId, is_bot: false }, text } },
    pool
  });
};

const postSms = async ({ body, pool }) => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TWILIO_AUTH_TOKEN = 'tw-seam-auth';
  process.env.TWILIO_ACCOUNT_SID = 'ACseam1';
  process.env.TWILIO_SMS_NUMBER = '+15550009999';
  delete process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL;
  delete process.env.DONNA_PUBLIC_BASE_URL;
  delete process.env.VERCEL_URL;
  const params = { MessageSid: 'SMconnect1', From: '+15551239002', Body: body };
  const publicUrl = 'https://donna.seam.invalid/api/donna/sms/webhook';
  const signedData = `${publicUrl}${Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('')}`;
  const signature = createHmac('sha1', 'tw-seam-auth').update(signedData).digest('base64');
  return requestDonnaApi({
    method: 'POST', url: '/api/donna/sms/webhook',
    headers: { host: 'donna.seam.invalid', 'x-twilio-signature': signature, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params).toString(), pool
  });
};

const postWhatsApp = async ({ body, pool }) => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.WHATSAPP_APP_SECRET = 'wa-seam-secret';
  process.env.WHATSAPP_ACCESS_TOKEN = 'wa-seam-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn-seam-1';
  const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid-connect-1', from: '15551239003', type: 'text', text: { body } }] } }] }] });
  const signature = `sha256=${createHmac('sha256', 'wa-seam-secret').update(rawBody).digest('hex')}`;
  return requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' }, body: rawBody, pool });
};

const telegramText = (send) => JSON.parse(send.options.body).text;
const smsText = (send) => new URLSearchParams(String(send.options.body)).get('Body');
const whatsappText = (send) => JSON.parse(send.options.body).text.body;

const CHANNELS = [
  { name: 'Telegram', post: ({ pool }) => postTelegram({ text: `/start ${TOKEN}`, pool }), read: telegramText, channel: 'telegram',
    connectedFi: 'Selvä, Telegram on nyt yhdistetty.' },
  { name: 'SMS', post: ({ pool }) => postSms({ body: `connect ${TOKEN}`, pool }), read: smsText, channel: 'sms',
    connectedFi: 'Selvä, tekstiviestit on nyt yhdistetty.' },
  { name: 'WhatsApp', post: ({ pool }) => postWhatsApp({ body: `connect ${TOKEN}`, pool }), read: whatsappText, channel: 'whatsapp',
    connectedFi: 'Selvä, WhatsApp on nyt yhdistetty.' }
];

for (const channel of CHANNELS) {
  await test(`${channel.name}: an expired or used connection code is answered honestly and nothing is marked connected`, async () => {
    const fetchCapture = captureFetch();
    const pool = createApiSeamPool([]);
    try {
      const response = await channel.post({ pool });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(pool.matching(/from client_whatsapp_bind_tokens/).length, 'the real redeem ran');
      assertNothingMarkedConnected(pool);
      assert.equal(fetchCapture.sends.length, 1, 'the owner gets one reply');
      const text = channel.read(fetchCapture.sends[0]);
      assert.doesNotMatch(text, /is connected|on nyt yhdistetty/, 'the reply never claims a connection');
      // No client is known, so the reply is bilingual, Finnish first.
      assert.match(text, /^[^/]*ei yhdistetty[^/]*vanhentunut tai jo käytetty[^/]* \/ .*not connected.*expired or was already used/);
    } finally { fetchCapture.restore(); }
  });

  await test(`${channel.name}: a redeem that fails for another reason says so, and nothing is marked connected`, async () => {
    const fetchCapture = captureFetch();
    const pool = createApiSeamPool(redeemThrows);
    const errors = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { errors.push(args); };
    try {
      const response = await channel.post({ pool });
      assert.equal(response.statusCode, 200, response.body);
      assertNothingMarkedConnected(pool);
      assert.equal(fetchCapture.sends.length, 1);
      const text = channel.read(fetchCapture.sends[0]);
      assert.doesNotMatch(text, /is connected|on nyt yhdistetty/);
      assert.match(text, /ei yhdistetty.* \/ .*not connected.*try again/i);
      assert.ok(errors.some((args) => /redeem failed/.test(String(args[0]))), 'the failure is logged');
    } finally { fetchCapture.restore(); console.warn = originalWarn; }
  });

  await test(`${channel.name}: a code that redeems is confirmed in the owner language`, async () => {
    const fetchCapture = captureFetch();
    const pool = createApiSeamPool(redeemSucceeds(channel.channel));
    try {
      const response = await channel.post({ pool });
      assert.equal(response.statusCode, 200, response.body);
      assert.equal(pool.matching(/insert into client_whatsapp_bindings/).length, 1);
      assert.equal(fetchCapture.sends.length, 1);
      assert.equal(channel.read(fetchCapture.sends[0]), channel.connectedFi);
    } finally { fetchCapture.restore(); }
  });
}

await test('Telegram: a bare /start from a chat already connected to a Finnish client gets the connected-owner reply in Finnish', async () => {
  const fetchCapture = captureFetch();
  const pool = createApiSeamPool([
    [/from client_whatsapp_bindings where phone_hash/, { rows: [{ id: 'tgb-1', firm_id: 'donna-demo-firm', client_id: 'fi-client-1', collaborator_id: 'owner-1', channel: 'telegram' }], rowCount: 1 }],
    finnishClient
  ]);
  try {
    const response = await postTelegram({ text: '/start', pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/from client_whatsapp_bindings[\s\S]*telegram/).length, 'the chat binding was read');
    assert.equal(fetchCapture.sends.length, 1);
    assert.equal(telegramText(fetchCapture.sends[0]), 'Täällä Donna. Tämä keskustelu on kuitteja ja nopeita kirjanpitokysymyksiä varten. Kirjoitan sinulle tänne, kun tarvitsen jotain.');
    assert.equal(pool.matching(/insert into/).length, 0, 'a bare /start writes nothing');
  } finally { fetchCapture.restore(); }
});

await test('Telegram: a bare /start from a chat connected to an English client gets the English line, unchanged', async () => {
  const fetchCapture = captureFetch();
  const pool = createApiSeamPool([
    [/from client_whatsapp_bindings where phone_hash/, { rows: [{ id: 'tgb-2', firm_id: 'donna-demo-firm', client_id: 'gb-client-1', collaborator_id: 'owner-1', channel: 'telegram' }], rowCount: 1 }],
    [/select jurisdiction, profile from clients/, { rows: [{ jurisdiction: 'GB', profile: {} }], rowCount: 1 }]
  ]);
  try {
    await postTelegram({ text: '/start', chatId: 15551239004, pool });
    assert.equal(telegramText(fetchCapture.sends[0]), "It's Donna. This chat is for receipts and quick bookkeeping questions. I'll message you here when I need one thing.");
  } finally { fetchCapture.restore(); }
});

await test('Telegram: a bare /start from an unknown chat keeps the bilingual text', async () => {
  const fetchCapture = captureFetch();
  const pool = createApiSeamPool([]);
  try {
    await postTelegram({ text: '/start', chatId: 15551239005, pool });
    assert.equal(fetchCapture.sends.length, 1);
    assert.equal(telegramText(fetchCapture.sends[0]),
      "Täällä Donna. Tämä keskustelu on kuitteja ja nopeita kirjanpitokysymyksiä varten. Kirjoitan sinulle tänne, kun tarvitsen jotain. / It's Donna. This chat is for receipts and quick bookkeeping questions. I'll message you here when I need one thing.");
  } finally { fetchCapture.restore(); }
});

test.after(() => {
  if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
});
