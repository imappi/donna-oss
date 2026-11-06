import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { createApiSeamPool, requestDonnaApi } from './testSupport/apiSeamHarness.js';
import {
  __setInboundComposeForTests,
  __resetInboundComposeForTests,
  __setInboundNarrationForTests,
  __resetInboundNarrationForTests
} from './channels/inboundCore.js';

const priorSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
const priorDb = process.env.DATABASE_URL;
process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret';
process.env.DATABASE_URL = 'postgres://seam.invalid/donna';

await test('Telegram group refusal is named, ledgered, and never replies into the group', async () => {
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret';
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  const sends = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { sends.push(args); return { ok: true, json: async () => ({ ok: true }) }; };
  const pool = createApiSeamPool([
    [/insert into message_delivery_ledger/, { rows: [{ id: 'delivery-group-refusal' }], rowCount: 1 }]
  ]);
  try {
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret', 'content-type': 'application/json' },
      body: {
        update_id: 9001,
        message: { message_id: 77, chat: { id: -100123, type: 'group' }, from: { id: 42, is_bot: false }, text: 'Ref INV-1 paid' }
      }, pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json, { received: true });
    const [ledger] = pool.matching(/insert into message_delivery_ledger/);
    assert.ok(ledger, 'the refusal receipt reached the real delivery-ledger writer');
    assert.equal(ledger.params[1], 'tg_-100123_77');
    assert.equal(ledger.params[12], 'group_chat_unsupported');
    assert.match(ledger.params.at(-1), /group_chat_unsupported/);
    assert.equal(sends.length, 0, 'the route never sends a reply into a group');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// NOTE for future additions: every test below re-sets its env INSIDE the test
// body. With top-level `await test(...)`, the after-hook at the bottom fires
// after the FIRST test completes and interleaves into later tests — module-level
// env cannot be trusted past test one (learned in
// xeroEnrichmentJurisdictionSeam.test.js, where it nulled the pool mid-call).

await test('WhatsApp: an unbound sender gets the named portal refusal — replied to the sender, nothing processed, nothing written', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.WHATSAPP_APP_SECRET = 'wa-seam-secret';
  process.env.WHATSAPP_ACCESS_TOKEN = 'wa-seam-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn-seam-1';
  const sends = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sends.push({ url: String(url), options });
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid-out' }] }) };
  };
  const pool = createApiSeamPool([]);
  const rawBody = JSON.stringify({
    entry: [{ changes: [{ value: { messages: [
      { id: 'wamid-in-1', from: '15551230001', type: 'text', text: { body: 'Ref INV-9 paid' } }
    ] } }] }]
  });
  const signature = `sha256=${createHmac('sha256', 'wa-seam-secret').update(rawBody).digest('hex')}`;
  try {
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/whatsapp/webhook',
      headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' },
      body: rawBody, pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json, { received: true });
    assert.ok(pool.matching(/client_whatsapp_bindings/).length >= 1, 'the binding read must actually run (unmatched-SQL trap)');
    assert.equal(sends.length, 1, 'the refusal is a reply to the sender, never silence');
    const sent = JSON.parse(sends[0].options.body);
    assert.equal(sent.to, '+15551230001');
    assert.match(sent.text.body, /connect WhatsApp from your Donna portal/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'an unbound message must not write anything');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('SMS: an unbound sender gets the named portal refusal through the signed Twilio route — replied, nothing processed', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TWILIO_AUTH_TOKEN = 'tw-seam-auth';
  process.env.TWILIO_ACCOUNT_SID = 'ACseam1';
  process.env.TWILIO_SMS_NUMBER = '+15550009999';
  delete process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL;
  delete process.env.DONNA_PUBLIC_BASE_URL;
  delete process.env.VERCEL_URL;
  const sends = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    sends.push({ url: String(url), options });
    return { ok: true, json: async () => ({ sid: 'SMout1' }) };
  };
  const params = { MessageSid: 'SMin1', From: '+15551230002', Body: 'Ref INV-9 paid' };
  const rawBody = new URLSearchParams(params).toString();
  const publicUrl = 'https://donna.seam.invalid/api/donna/sms/webhook';
  const signedData = `${publicUrl}${Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('')}`;
  const signature = createHmac('sha1', 'tw-seam-auth').update(signedData).digest('base64');
  const pool = createApiSeamPool([]);
  try {
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/sms/webhook',
      headers: {
        host: 'donna.seam.invalid',
        'x-twilio-signature': signature,
        'content-type': 'application/x-www-form-urlencoded'
      },
      body: rawBody, pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.deepEqual(response.json, { received: true });
    assert.ok(pool.matching(/client_whatsapp_bindings/).length >= 1, 'the SMS binding read (shared bindings table) must actually run');
    assert.equal(sends.length, 1, 'the refusal is a reply to the sender, never silence');
    const sent = new URLSearchParams(String(sends[0].options.body));
    assert.equal(sent.get('To'), '+15551230002');
    assert.match(sent.get('Body'), /Connect SMS from your Donna portal/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'an unbound message must not write anything');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('WhatsApp: bound audio defers before the compose boundary', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.WHATSAPP_APP_SECRET = 'wa-seam-secret'; process.env.WHATSAPP_ACCESS_TOKEN = 'token'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn';
  __setInboundComposeForTests(async () => { throw new Error('voice must not compose'); });
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url, options }); return { ok: true, json: async () => ({ messages: [{ id: 'out' }] }) }; };
  const pool = createApiSeamPool([[/from client_whatsapp_bindings/, { rows: [{ id: 'b1', firm_id: 'donna-demo-firm', client_id: 'gb-1', collaborator_id: 'owner-1', channel: 'whatsapp' }], rowCount: 1 }]]);
  const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wa-audio', from: '15551230001', type: 'audio', audio: { id: 'audio-1' } }] } }] }] });
  const signature = `sha256=${createHmac('sha256', 'wa-seam-secret').update(rawBody).digest('hex')}`;
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature }, body: rawBody, pool });
    assert.equal(response.statusCode, 200, response.body); assert.ok(pool.matching(/client_whatsapp_bindings/).length); assert.ok(sends.length >= 1);
    assert.match(JSON.parse(sends.at(-1).options.body).text.body, /voice/i);
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); }
});

await test('SMS: bound audio defers before the compose boundary', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TWILIO_AUTH_TOKEN = 'tw-auth'; process.env.TWILIO_ACCOUNT_SID = 'AC1'; process.env.TWILIO_SMS_NUMBER = '+15550009999';
  __setInboundComposeForTests(async () => { throw new Error('voice must not compose'); });
  const sends = []; const originalFetch = globalThis.fetch; globalThis.fetch = async (url, options) => { sends.push({ url, options }); return { ok: true, json: async () => ({ sid: 'out' }) }; };
  const params = { MessageSid: 'SMaudio', From: '+15551230002', Body: '', NumMedia: '1', MediaUrl0: 'https://example.test/a', MediaContentType0: 'audio/ogg' };
  const rawBody = new URLSearchParams(params).toString(); const publicUrl = 'https://donna.seam.invalid/api/donna/sms/webhook';
  const signature = createHmac('sha1', 'tw-auth').update(`${publicUrl}${Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('')}`).digest('base64');
  const pool = createApiSeamPool([[/from client_whatsapp_bindings/, { rows: [{ id: 'b1', firm_id: 'donna-demo-firm', client_id: 'gb-1', collaborator_id: 'owner-1', channel: 'sms' }], rowCount: 1 }]]);
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/sms/webhook', headers: { host: 'donna.seam.invalid', 'x-twilio-signature': signature }, body: rawBody, pool });
    assert.equal(response.statusCode, 200, response.body); assert.ok(pool.matching(/client_whatsapp_bindings/).length); assert.ok(sends.length >= 1);
    assert.match(new URLSearchParams(String(sends.at(-1).options.body)).get('Body'), /voice/i);
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); }
});

const boundOwnerChatResponders = ({ channel, clientId = 'gb-bound-1' } = {}) => [
  [/select jurisdiction, entity_type, profile from clients/, {
    rows: [{ jurisdiction: 'GB', entity_type: 'gb-ltd', profile: { jurisdiction: 'gb', entityType: 'gb-ltd' } }], rowCount: 1
  }],
  [/select company_name, jurisdiction, profile from clients/, {
    rows: [{ company_name: 'Bound Owner Ltd', jurisdiction: 'GB', profile: { jurisdiction: 'gb', entityType: 'gb-ltd' } }], rowCount: 1
  }],
  [/from client_whatsapp_bindings where phone_hash/, {
    rows: [{ id: `binding-${channel}`, firm_id: 'donna-demo-firm', client_id: clientId, collaborator_id: 'owner-1', channel }],
    rowCount: 1
  }],
  [/from client_capability_config/, {
    rows: [
      { flag_key: `OWNER_CHANNEL_${channel.toUpperCase()}`, stage: 'auto', source: 'seam', client_id: clientId },
      ...(channel === 'whatsapp' ? [{ flag_key: 'WHATSAPP_OWNER_CONVERSATION', stage: 'auto', source: 'seam', client_id: clientId }] : [])
    ],
    rowCount: channel === 'whatsapp' ? 2 : 1
  }],
  [/select 1 from clients/, { rows: [{ '?column?': 1 }], rowCount: 1 }],
  [/select id from clients/, { rows: [{ id: clientId }], rowCount: 1 }],
  [/insert into client_chat_messages/, ({ params }) => ({
    rows: [{ id: params[0], firm_id: params[1], client_id: params[2], role: params[3], content: params[4], payload: JSON.parse(params[5]), model: params[6], model_version: params[7], actor_type: params[8], created_at: '2026-08-01T12:00:00.000Z' }],
    rowCount: 1
  })],
  [/insert into message_delivery_ledger/, ({ params }) => ({ rows: [{ id: params[0] }], rowCount: 1 })]
];

const assertBoundOwnerChatPersistence = (pool, channel) => {
  assert.ok(pool.matching(new RegExp(`from client_whatsapp_bindings[\\s\\S]*${channel}`)).length, `${channel} binding query ran`);
  assert.ok(pool.matching(/insert into message_delivery_ledger/).length >= 2, 'inbound claim and outbound delivery receipt writes ran');
  assert.equal(pool.matching(/insert into client_chat_messages/).length, 2, 'user and assistant client_chat_messages writes ran');
  assert.ok(pool.matching(/insert into audit_events/).length >= 1, 'inbound audit_events write ran');
};

await test('Telegram: bound private text traverses the signed route, persists both turns, and sends the composed reply', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'telegram-seam-token';
  const injected = 'Telegram bound reply from the compose seam.';
  __setInboundComposeForTests(async () => ({ kind: 'ok', text: injected, actions: [], model: 'seam-model' }));
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), options }); return { ok: true, json: async () => ({ ok: true, result: { message_id: 901 } }) }; };
  const pool = createApiSeamPool(boundOwnerChatResponders({ channel: 'telegram' }));
  try {
    const response = await requestDonnaApi({
      method: 'POST', url: '/api/donna/telegram/webhook',
      headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret', 'content-type': 'application/json' },
      body: { update_id: 9101, message: { message_id: 501, chat: { id: 15551231111, type: 'private' }, from: { id: 15551231111, is_bot: false }, text: 'How are my books looking?' } }, pool
    });
    assert.equal(response.statusCode, 200, response.body);
    assertBoundOwnerChatPersistence(pool, 'telegram');
    assert.ok(sends.some(({ options }) => JSON.parse(options.body).text === injected), 'Telegram send carried the injected reply');
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); }
});

await test('WhatsApp: bound text traverses the signed route, persists both turns, and sends the composed reply', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.WHATSAPP_APP_SECRET = 'wa-seam-secret';
  process.env.WHATSAPP_ACCESS_TOKEN = 'wa-seam-token';
  process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn-seam-1';
  const injected = 'WhatsApp bound reply from the compose seam.';
  __setInboundComposeForTests(async () => ({ kind: 'ok', text: injected, actions: [], model: 'seam-model' }));
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), options }); return { ok: true, json: async () => ({ messages: [{ id: 'wamid-bound-out' }] }) }; };
  const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wamid-bound-in', from: '15551232222', type: 'text', text: { body: 'How are my books looking?' } }] } }] }] });
  const signature = `sha256=${createHmac('sha256', 'wa-seam-secret').update(rawBody).digest('hex')}`;
  const pool = createApiSeamPool(boundOwnerChatResponders({ channel: 'whatsapp' }));
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' }, body: rawBody, pool });
    assert.equal(response.statusCode, 200, response.body);
    assertBoundOwnerChatPersistence(pool, 'whatsapp');
    assert.ok(sends.some(({ options }) => JSON.parse(options.body).text.body === injected), 'WhatsApp send carried the injected reply');
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); }
});

await test('Telegram: report request uses the narration seam and sends its narration without a live model call', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'telegram-seam-token';
  const narrated = 'Your seam-generated report narration is ready.';
  __setInboundComposeForTests(async () => ({ kind: 'ok', text: 'Preparing the report.', model: 'seam-compose', actions: [{ type: 'request_report', report_type: 'pnl', period_start: '2026-01-01', period_end: '2026-07-31', basis: 'accrual', reason: 'Owner asked for year-to-date P&L.' }] }));
  let narrationCalls = 0;
  __setInboundNarrationForTests(async ({ request }) => { narrationCalls += 1; assert.equal(request.report_type, 'pnl'); return { kind: 'ok', text: narrated, actions: [], model: 'seam-narration' }; });
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), options }); return { ok: true, json: async () => ({ ok: true, result: { message_id: 902 } }) }; };
  const pool = createApiSeamPool(boundOwnerChatResponders({ channel: 'telegram' }));
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret', 'content-type': 'application/json' }, body: { update_id: 9102, message: { message_id: 502, chat: { id: 15551233333, type: 'private' }, from: { id: 15551233333 }, text: 'Show my year-to-date profit and loss.' } }, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal(narrationCalls, 1, 'the narration seam handled the model boundary');
    assert.ok(pool.matching(/from ledger_lines[\s\S]*join ledger_journals/).length, 'the financial-report ledger binding query ran');
    assert.equal(pool.matching(/insert into client_chat_messages/).length, 2, 'report request persisted user and narrated assistant turns');
    assert.ok(sends.some(({ options }) => JSON.parse(options.body).text === narrated), 'Telegram send carried the injected narration');
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); __resetInboundNarrationForTests(); }
});

await test('Telegram: bound voice defers before the compose boundary and sends the parity copy', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
  process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret';
  process.env.TELEGRAM_BOT_TOKEN = 'telegram-seam-token';
  __setInboundComposeForTests(async () => { throw new Error('voice must not compose'); });
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), options }); return { ok: true, json: async () => ({ ok: true }) }; };
  const pool = createApiSeamPool(boundOwnerChatResponders({ channel: 'telegram' }));
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret', 'content-type': 'application/json' }, body: { update_id: 9103, message: { message_id: 503, chat: { id: 15551234444, type: 'private' }, from: { id: 15551234444 }, voice: { file_id: 'voice-1', mime_type: 'audio/ogg' } } }, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/from client_whatsapp_bindings[\s\S]*telegram/).length, 'Telegram binding query ran');
    assert.ok(sends.length >= 1, 'the deferral was sent');
    assert.match(JSON.parse(sends.at(-1).options.body).text, /can't do voice notes yet/i);
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); }
});

const signTwilio = ({ params, token, url = 'https://donna.seam.invalid/api/donna/sms/webhook' }) =>
  createHmac('sha1', token).update(`${url}${Object.keys(params).sort().map((key) => `${key}${params[key]}`).join('')}`).digest('base64');

await test('SMS: bound text is refused before compose because general owner chat is disabled', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TWILIO_AUTH_TOKEN = 'tw-bound'; process.env.TWILIO_ACCOUNT_SID = 'ACbound'; process.env.TWILIO_SMS_NUMBER = '+15550009999';
  process.env.SMS_ENABLED = 'true'; process.env.SMS_CLIENTS = 'gb-1';
  delete process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL; delete process.env.DONNA_PUBLIC_BASE_URL; delete process.env.VERCEL_URL;
  __setInboundComposeForTests(async () => { throw new Error('SMS text must not compose'); });
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url, options }); return { ok: true, json: async () => ({ sid: 'out' }) }; };
  const params = { MessageSid: 'SMboundText', From: '+15551230003', Body: 'What did I spend last month?' };
  const pool = createApiSeamPool([
    [/from client_whatsapp_bindings/, { rows: [{ id: 'sms-binding', firm_id: 'donna-demo-firm', client_id: 'gb-1', collaborator_id: 'owner-1', channel: 'sms' }], rowCount: 1 }],
    [/from client_capability_config/, { rows: [], rowCount: 0 }]
  ]);
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/sms/webhook', headers: { host: 'donna.seam.invalid', 'x-twilio-signature': signTwilio({ params, token: 'tw-bound' }) }, body: new URLSearchParams(params).toString(), pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the bound-sender query ran');
    assert.ok(pool.matching(/client_capability_config/).length, 'the config-plane query ran');
    assert.equal(sends.length, 1);
    assert.match(new URLSearchParams(String(sends[0].options.body)).get('Body'), /Reply right on the question|add its Ref/i);
  } finally { globalThis.fetch = originalFetch; __resetInboundComposeForTests(); }
});

for (const variant of [
  { name: 'edited_message', update: { update_id: 9101, edited_message: { message_id: 81, chat: { id: 51, type: 'private' }, from: { id: 51, is_bot: false }, text: 'hello' } }, queries: true },
  { name: 'non-message update', update: { update_id: 9102, callback_query: { id: 'callback-1' } }, queries: false }
]) {
  await test(`Telegram: ${variant.name} pins the accepted update shape`, async () => {
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret'; process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
    const sends = []; const originalFetch = globalThis.fetch; globalThis.fetch = async (...args) => { sends.push(args); return { ok: true, json: async () => ({ ok: true }) }; };
    const pool = createApiSeamPool([]);
    try {
      const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret' }, body: variant.update, pool });
      assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json, { received: true });
      assert.equal(pool.matching(/client_whatsapp_bindings/).length > 0, variant.queries, 'binding query execution matches the update branch');
      assert.equal(sends.length, variant.queries ? 1 : 0);
      if (variant.queries) assert.match(JSON.parse(sends[0][1].body).text, /Connect Telegram/i);
    } finally { globalThis.fetch = originalFetch; }
  });
}

await test('Telegram: a private unbound text runs binding lookup and replies with the portal refusal', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret'; process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  const sends = []; const originalFetch = globalThis.fetch; globalThis.fetch = async (...args) => { sends.push(args); return { ok: true, json: async () => ({ ok: true }) }; };
  const pool = createApiSeamPool([]);
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret' }, body: { update_id: 9201, message: { message_id: 82, chat: { id: 52, type: 'private' }, from: { id: 52 }, text: 'hello' } }, pool });
    assert.equal(response.statusCode, 200, response.body); assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'binding lookup ran');
    assert.match(JSON.parse(sends[0][1].body).text, /Connect Telegram/i);
  } finally { globalThis.fetch = originalFetch; }
});

await test('WhatsApp: delivered and read callbacks write delivery receipts without a binding lookup', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.WHATSAPP_APP_SECRET = 'wa-status-secret';
  const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid-status-1', status: 'delivered', timestamp: '1700000000' }, { id: 'wamid-status-1', status: 'read', timestamp: '1700000001' }] } }] }] });
  const signature = `sha256=${createHmac('sha256', 'wa-status-secret').update(rawBody).digest('hex')}`;
  const pool = createApiSeamPool([[/insert into message_delivery_ledger/, { rows: [{ id: 'receipt' }], rowCount: 1 }]]);
  const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature }, body: rawBody, pool });
  assert.equal(response.statusCode, 200, response.body); assert.equal(pool.matching(/insert into message_delivery_ledger/).length, 2, 'both status writes ran');
  assert.equal(pool.matching(/client_whatsapp_bindings/).length, 0);
});

for (const media of [
  { type: 'image', payload: { id: 'wa-image-1', mime_type: 'image/jpeg' } },
  { type: 'document', payload: { id: 'wa-document-1', mime_type: 'application/pdf', filename: 'invoice.pdf' } }
]) {
  await test(`WhatsApp: bound ${media.type} reaches the owner-media idempotency claim`, async () => {
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.WHATSAPP_APP_SECRET = 'wa-media-secret'; process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn';
    process.env.WHATSAPP_ENABLED = 'true'; process.env.WHATSAPP_CLIENTS = 'gb-1';
    const message = { id: `wamid-${media.type}`, from: '15551230004', type: media.type, [media.type]: media.payload };
    const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const signature = `sha256=${createHmac('sha256', 'wa-media-secret').update(rawBody).digest('hex')}`;
    const pool = createApiSeamPool([
      [/from client_whatsapp_bindings/, { rows: [{ id: 'wa-binding', firm_id: 'donna-demo-firm', client_id: 'gb-1', collaborator_id: 'owner-1', channel: 'whatsapp' }], rowCount: 1 }],
      [/from client_capability_config/, { rows: [{ flag_key: 'WHATSAPP_OWNER_CONVERSATION', stage: 'auto', source: 'seam', client_id: 'gb-1' }], rowCount: 1 }],
      [/insert into message_delivery_ledger/, { rows: [], rowCount: 0 }]
    ]);
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature }, body: rawBody, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'bound-sender lookup ran');
    assert.ok(pool.matching(/client_capability_config/).length, 'config-plane lookup ran');
    assert.ok(pool.matching(/insert into message_delivery_ledger/).length, 'owner-media idempotency claim ran');
  });
}

for (const channel of ['telegram', 'whatsapp', 'sms']) {
  await test(`${channel}: invalid signature is rejected before any database query`, async () => {
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TELEGRAM_WEBHOOK_SECRET = 'right'; process.env.WHATSAPP_APP_SECRET = 'right'; process.env.TWILIO_AUTH_TOKEN = 'right';
    const pool = createApiSeamPool([]);
    const request = channel === 'telegram'
      ? { url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'wrong' }, body: { update_id: 1 } }
      : channel === 'whatsapp'
        ? { url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': 'sha256=bad' }, body: '{}' }
        : { url: '/api/donna/sms/webhook', headers: { host: 'donna.seam.invalid', 'x-twilio-signature': 'bad' }, body: 'MessageSid=bad' };
    const response = await requestDonnaApi({ method: 'POST', ...request, pool });
    assert.equal(response.statusCode, 401, response.body); assert.equal(pool.queries.length, 0, 'authentication short-circuits before DB access');
  });

  await test(`${channel}: missing signature environment fails closed before any database query`, async () => {
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna';
    if (channel === 'telegram') delete process.env.TELEGRAM_WEBHOOK_SECRET;
    if (channel === 'whatsapp') delete process.env.WHATSAPP_APP_SECRET;
    if (channel === 'sms') delete process.env.TWILIO_AUTH_TOKEN;
    const pool = createApiSeamPool([]);
    const request = channel === 'telegram'
      ? { url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'present' }, body: { update_id: 1 } }
      : channel === 'whatsapp'
        ? { url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': 'sha256=present' }, body: '{}' }
        : { url: '/api/donna/sms/webhook', headers: { host: 'donna.seam.invalid', 'x-twilio-signature': 'present' }, body: 'MessageSid=missing-env' };
    const response = await requestDonnaApi({ method: 'POST', ...request, pool });
    assert.equal(response.statusCode, 401, response.body); assert.equal(pool.queries.length, 0, 'missing auth configuration short-circuits before DB access');
  });
}

// --- 10A table-close pins: the branches the enumeration table exposed. Each
// pins OBSERVED current behavior (probed before pinning); none required a
// production change, so there are no parked rows.

await test('Telegram: an unbound photo gets the portal refusal at the binding gate — media never dispatches, nothing written', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret'; process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), body: options?.body }); return { ok: true, json: async () => ({ ok: true }) }; };
  const pool = createApiSeamPool([]);
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret' }, body: { update_id: 9301, message: { message_id: 91, chat: { id: 61, type: 'private' }, from: { id: 61 }, photo: [{ file_id: 'photo-unbound-1', width: 10, height: 10 }] } }, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the binding refusal precedes media dispatch');
    assert.equal(sends.length, 1);
    assert.match(JSON.parse(sends[0].body).text, /Connect Telegram from your Donna portal/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'an unbound photo must not write anything');
  } finally { globalThis.fetch = originalFetch; }
});

await test('WhatsApp: unbound audio gets the portal refusal at the binding gate, never the voice deferral', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.WHATSAPP_APP_SECRET = 'wa-seam-secret'; process.env.WHATSAPP_ACCESS_TOKEN = 'wa-seam-token'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn-seam-1';
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), body: options?.body }); return { ok: true, json: async () => ({ messages: [{ id: 'out' }] }) }; };
  const pool = createApiSeamPool([]);
  const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [{ id: 'wa-unbound-audio', from: '15551230009', type: 'audio', audio: { id: 'audio-unbound-1' } }] } }] }] });
  const signature = `sha256=${createHmac('sha256', 'wa-seam-secret').update(rawBody).digest('hex')}`;
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature }, body: rawBody, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the binding refusal precedes the audio branch');
    assert.equal(sends.length, 1);
    assert.match(JSON.parse(sends[0].body).text.body, /connect WhatsApp from your Donna portal/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'an unbound audio message must not write anything');
  } finally { globalThis.fetch = originalFetch; }
});

await test('SMS: bound image lands in the ask-nudge lane — SMS declares ownerInitiatedMedia: false, so no owner-media claim runs', async () => {
  // Deliberate capability declaration (smsInbound.js `capabilities`), not a
  // gap: unlike WhatsApp, SMS media never enters the owner-media pipeline.
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TWILIO_AUTH_TOKEN = 'tw-media'; process.env.TWILIO_ACCOUNT_SID = 'ACmedia'; process.env.TWILIO_SMS_NUMBER = '+15550009999';
  process.env.SMS_ENABLED = 'true'; process.env.SMS_CLIENTS = 'gb-1';
  delete process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL; delete process.env.DONNA_PUBLIC_BASE_URL; delete process.env.VERCEL_URL;
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), body: options?.body }); return { ok: true, json: async () => ({ sid: 'out' }) }; };
  const params = { MessageSid: 'SMboundImage', From: '+15551230002', Body: '', NumMedia: '1', MediaUrl0: 'https://example.test/receipt.jpg', MediaContentType0: 'image/jpeg' };
  const pool = createApiSeamPool([
    [/from client_whatsapp_bindings/, { rows: [{ id: 'sms-binding', firm_id: 'donna-demo-firm', client_id: 'gb-1', collaborator_id: 'owner-1', channel: 'sms' }], rowCount: 1 }],
    [/from client_capability_config/, { rows: [{ flag_key: 'WHATSAPP_OWNER_CONVERSATION', stage: 'auto', source: 'seam', client_id: 'gb-1' }], rowCount: 1 }]
  ]);
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/sms/webhook', headers: { host: 'donna.seam.invalid', 'x-twilio-signature': signTwilio({ params, token: 'tw-media' }) }, body: new URLSearchParams(params).toString(), pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the bound-sender query ran');
    assert.equal(sends.length, 1);
    assert.match(new URLSearchParams(String(sends[0].body)).get('Body'), /Reply right on the question|add its Ref/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'no owner-media claim and no other write ran');
  } finally { globalThis.fetch = originalFetch; }
});

await test('SMS: unbound media gets the same portal refusal as unbound text — the binding gate precedes type dispatch', async () => {
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TWILIO_AUTH_TOKEN = 'tw-seam-auth'; process.env.TWILIO_ACCOUNT_SID = 'ACseam1'; process.env.TWILIO_SMS_NUMBER = '+15550009999';
  delete process.env.TWILIO_WEBHOOK_PUBLIC_BASE_URL; delete process.env.DONNA_PUBLIC_BASE_URL; delete process.env.VERCEL_URL;
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), body: options?.body }); return { ok: true, json: async () => ({ sid: 'out' }) }; };
  const params = { MessageSid: 'SMunboundImage', From: '+15551230005', Body: '', NumMedia: '1', MediaUrl0: 'https://example.test/receipt.jpg', MediaContentType0: 'image/jpeg' };
  const pool = createApiSeamPool([]);
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/sms/webhook', headers: { host: 'donna.seam.invalid', 'x-twilio-signature': signTwilio({ params, token: 'tw-seam-auth' }) }, body: new URLSearchParams(params).toString(), pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the binding refusal precedes media dispatch');
    assert.equal(sends.length, 1);
    assert.match(new URLSearchParams(String(sends[0].body)).get('Body'), /Connect SMS from your Donna portal/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'an unbound media message must not write anything');
  } finally { globalThis.fetch = originalFetch; }
});

await test('Telegram: a bound sticker falls through to the ask-nudge lane — no text, no media descriptor, nothing written', async () => {
  // Location and contact messages take the same lane: the normalizer yields
  // neither text nor a media descriptor, so all three converge downstream.
  process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.TELEGRAM_WEBHOOK_SECRET = 'telegram-seam-secret'; process.env.TELEGRAM_BOT_TOKEN = 'bot-token';
  const sends = []; const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => { sends.push({ url: String(url), body: options?.body }); return { ok: true, json: async () => ({ ok: true }) }; };
  const pool = createApiSeamPool(boundOwnerChatResponders({ channel: 'telegram', clientId: 'gb-1' }));
  try {
    const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/telegram/webhook', headers: { 'x-telegram-bot-api-secret-token': 'telegram-seam-secret' }, body: { update_id: 9302, message: { message_id: 92, chat: { id: 62, type: 'private' }, from: { id: 62 }, sticker: { file_id: 'sticker-1' } } }, pool });
    assert.equal(response.statusCode, 200, response.body);
    assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the bound-sender query ran');
    assert.equal(sends.length, 1);
    assert.match(JSON.parse(sends[0].body).text, /Reply right on the question|add its Ref/i);
    assert.equal(pool.matching(/insert into/).length, 0, 'a sticker turn must not write anything');
  } finally { globalThis.fetch = originalFetch; }
});

for (const other of [
  { type: 'sticker', payload: { id: 'wa-sticker-1', mime_type: 'image/webp' } },
  { type: 'location', payload: { latitude: 51.5, longitude: -0.12 } },
  { type: 'contacts', payload: [{ name: { formatted_name: 'Synthetic Contact' } }] }
]) {
  await test(`WhatsApp: a bound ${other.type} message falls through to the ask-nudge lane and writes nothing`, async () => {
    process.env.DATABASE_URL = 'postgres://seam.invalid/donna'; process.env.WHATSAPP_APP_SECRET = 'wa-other-secret'; process.env.WHATSAPP_ACCESS_TOKEN = 'wa-token'; process.env.WHATSAPP_PHONE_NUMBER_ID = 'pn';
    const sends = []; const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => { sends.push({ url: String(url), body: options?.body }); return { ok: true, json: async () => ({ messages: [{ id: 'out' }] }) }; };
    const message = { id: `wamid-${other.type}`, from: '15551230009', type: other.type, [other.type]: other.payload };
    const rawBody = JSON.stringify({ entry: [{ changes: [{ value: { messages: [message] } }] }] });
    const signature = `sha256=${createHmac('sha256', 'wa-other-secret').update(rawBody).digest('hex')}`;
    const pool = createApiSeamPool(boundOwnerChatResponders({ channel: 'whatsapp', clientId: 'gb-1' }));
    try {
      const response = await requestDonnaApi({ method: 'POST', url: '/api/donna/whatsapp/webhook', headers: { 'x-hub-signature-256': signature }, body: rawBody, pool });
      assert.equal(response.statusCode, 200, response.body);
      assert.ok(pool.matching(/client_whatsapp_bindings/).length, 'the bound-sender query ran');
      assert.equal(sends.length, 1);
      assert.match(JSON.parse(sends[0].body).text.body, /Reply right on the question|add its Ref/i);
      assert.equal(pool.matching(/insert into/).length, 0, `a ${other.type} turn must not write anything`);
    } finally { globalThis.fetch = originalFetch; }
  });
}

test.after(() => {
  if (priorSecret === undefined) delete process.env.TELEGRAM_WEBHOOK_SECRET; else process.env.TELEGRAM_WEBHOOK_SECRET = priorSecret;
  if (priorDb === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = priorDb;
});
