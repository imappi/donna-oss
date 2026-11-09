import test from 'node:test';
import assert from 'node:assert/strict';

import { deliverOwnerMessage, OWNER_CHANNELS } from './channels/index.js';
import { sendWhatsAppTemplate, sendWhatsAppText } from './channels/whatsapp.js';

test('sendWhatsAppTemplate is inert without Meta config', async () => {
  const result = await sendWhatsAppTemplate({ to: '+447700900123', templateName: 'donna_evidence_ask_v1', deps: { accessToken: '', phoneNumberId: '' } });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'WHATSAPP_NOT_CONFIGURED');
});

test('sendWhatsAppTemplate posts Meta Cloud API template payload with injected fetch', async () => {
  const calls = [];
  const result = await sendWhatsAppTemplate({
    to: '+447700900123',
    templateName: 'donna_evidence_ask_v1',
    bodyParameters: ['June', 'receipt for IKEA', 'ABC123'],
    metadata: { ask_id: 'ask_1' },
    deps: {
      accessToken: 'test-token',
      phoneNumberId: '12345',
      fetchImpl: async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) };
      }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'wamid.1');
  assert.equal(calls[0].url, 'https://graph.facebook.com/v20.0/12345/messages');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-token');
  assert.equal(calls[0].body.template.name, 'donna_evidence_ask_v1');
  assert.deepEqual(calls[0].body.template.components[0].parameters.map((p) => p.text), ['June', 'receipt for IKEA', 'ABC123']);
});

test('deliverOwnerMessage delegates whatsapp channel to template adapter', async () => {
  const result = await deliverOwnerMessage({
    channel: OWNER_CHANNELS.WHATSAPP,
    recipient: { phone_e164: '+447700900123' },
    template: { name: 'donna_evidence_ask_v1', bodyParameters: ['July', 'question', 'REF'] },
    deps: { accessToken: 'token', phoneNumberId: 'pnid', fetchImpl: async () => ({ ok: true, json: async () => ({ messages: [{ id: 'wamid.2' }] }) }) }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'wamid.2');
});

test('sendWhatsAppText posts sparse operational text payload', async () => {
  let body;
  const result = await sendWhatsAppText({
    to: '+447700900123',
    text: 'Got it.',
    deps: { accessToken: 'token', phoneNumberId: 'pnid', fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ messages: [{ id: 'wamid.text' }] }) }; } }
  });
  assert.equal(result.ok, true);
  assert.equal(body.type, 'text');
  assert.equal(body.text.body, 'Got it.');
});

import { sendSmsText, renderSmsTemplate } from './channels/sms.js';

test('sendSmsText posts Twilio Messaging API payload with injected fetch', async () => {
  const calls = [];
  const result = await sendSmsText({
    to: '+15551234567',
    text: 'Need one thing. Ref: ASK123',
    deps: {
      accountSid: 'AC123',
      authToken: 'secret',
      from: '+15550000000',
      statusCallback: 'https://example.test/api/donna/sms/webhook',
      fetchImpl: async (url, options) => { calls.push({ url, options, body: new URLSearchParams(options.body) }); return { ok: true, json: async () => ({ sid: 'SM123' }) }; }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'SM123');
  assert.equal(calls[0].url, 'https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json');
  assert.equal(calls[0].body.get('To'), '+15551234567');
  assert.equal(calls[0].body.get('From'), '+15550000000');
  assert.equal(calls[0].body.get('Body'), 'Need one thing. Ref: ASK123');
  assert.match(calls[0].options.headers.Authorization, /^Basic /);
});

test('deliverOwnerMessage delegates sms channel to Twilio text adapter', async () => {
  let body;
  const result = await deliverOwnerMessage({
    channel: OWNER_CHANNELS.SMS,
    recipient: { phone_e164: '+15551234567' },
    template: { name: 'donna_evidence_ask_v1', bodyParameters: ['June', 'receipt for IKEA', 'ABC123'] },
    deps: { accountSid: 'AC123', authToken: 'secret', from: '+15550000000', fetchImpl: async (_url, options) => { body = new URLSearchParams(options.body); return { ok: true, json: async () => ({ sid: 'SM124' }) }; } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, 'SM124');
  assert.equal(body.get('Body'), renderSmsTemplate({ templateName: 'donna_evidence_ask_v1', bodyParameters: ['June', 'receipt for IKEA', 'ABC123'] }));
});

import { sendTelegramMessage, renderTelegramTemplate, telegramEnvAllowsClient } from './channels/telegram.js';

test('sendTelegramMessage is inert without a bot token', async () => {
  const result = await sendTelegramMessage({ chatId: '12345', text: 'hi', deps: { botToken: '' } });
  assert.equal(result.ok, false);
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'TELEGRAM_NOT_CONFIGURED');
});

test('sendTelegramMessage posts sendMessage payload and returns stringified message_id', async () => {
  let captured;
  const result = await sendTelegramMessage({
    chatId: 55512345,
    text: 'Got it — booked to Travel.',
    deps: {
      botToken: 'BOTTOKEN:abc',
      fetchImpl: async (url, options) => { captured = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ ok: true, result: { message_id: 4242 } }) }; }
    }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, '4242');
  assert.equal(captured.url, 'https://api.telegram.org/botBOTTOKEN:abc/sendMessage');
  assert.equal(captured.body.chat_id, 55512345);
  assert.equal(captured.body.text, 'Got it — booked to Travel.');
});

test('sendTelegramMessage surfaces a Telegram application error (ok:false in body)', async () => {
  const result = await sendTelegramMessage({ chatId: '1', text: 'x', deps: { botToken: 't', fetchImpl: async () => ({ ok: true, json: async () => ({ ok: false, description: 'chat not found' }) }) } });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'chat not found');
});

test('telegramEnvAllowsClient honours the enable flag and allowlist', () => {
  assert.equal(telegramEnvAllowsClient('c1', {}), false);
  assert.equal(telegramEnvAllowsClient('c1', { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'c1,c2' }), true);
  assert.equal(telegramEnvAllowsClient('c9', { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'c1,c2' }), false);
  assert.equal(telegramEnvAllowsClient('c1', { TELEGRAM_ENABLED: 'false', TELEGRAM_CLIENTS: 'c1' }), false);
});

test('deliverOwnerMessage delegates telegram channel to the code-side text adapter', async () => {
  let body;
  const result = await deliverOwnerMessage({
    channel: OWNER_CHANNELS.TELEGRAM,
    recipient: { phone_e164: '987654321' },
    template: { name: 'donna_evidence_ask_v1', bodyParameters: ['June', 'receipt for IKEA', 'ABC123'] },
    deps: { botToken: 'BOTTOKEN:abc', fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true, result: { message_id: 77 } }) }; } }
  });
  assert.equal(result.ok, true);
  assert.equal(result.id, '77');
  assert.equal(body.chat_id, '987654321');
  assert.equal(body.text, renderTelegramTemplate({ templateName: 'donna_evidence_ask_v1', bodyParameters: ['June', 'receipt for IKEA', 'ABC123'] }));
});

// ── Owner-language templates (SMS + Telegram render code-side) ──────────────
//
// English is pinned byte-for-byte to the historical copy; Finnish is the sinä
// form with correct plurals. Both keep "Ref:" verbatim (extractAskRef anchors a
// reply on the word "ref").

const EN_TEMPLATES = {
  donna_evidence_ask_v1: [['June', 'receipt for IKEA?', 'ABC123'], "Donna needs one thing for June: receipt for IKEA? — reply with a photo, answer in words, or reply 'not sure'. Ref: ABC123"],
  donna_close_queue_v1: [['June', '3', '1'], "Donna is almost ready to close June. Open: 3 questions, 1 missing receipts. Reply 'show' to go through them one by one."],
  donna_decision_check_v1: [['the IKEA charge', 'Office supplies', 'ABC123'], "Donna treated the IKEA charge as Office supplies based on your past rules. Reply 'correct' or 'wrong'. Ref: ABC123"]
};

test('SMS and Telegram English templates are byte-identical to the historical copy, with and without a language', () => {
  for (const render of [renderSmsTemplate, renderTelegramTemplate]) {
    for (const [templateName, [bodyParameters, expected]] of Object.entries(EN_TEMPLATES)) {
      assert.equal(render({ templateName, bodyParameters }), expected);
      assert.equal(render({ templateName, bodyParameters, language: 'en' }), expected);
    }
    assert.equal(render({ templateName: 'donna_evidence_ask_v1' }), "Donna needs one thing for this period: one thing — reply with a photo, answer in words, or reply 'not sure'. Ref: ASK");
  }
});

test('SMS and Telegram Finnish templates: sinä form, correct plurals, the Finnish keywords, Ref kept', () => {
  for (const render of [renderSmsTemplate, renderTelegramTemplate]) {
    const ask = render({ templateName: 'donna_evidence_ask_v1', bodyParameters: ['kesäkuu 2026', 'Mikä oli IKEA-ostos?', 'ABC123'], assistantName: 'Aino', language: 'fi' });
    assert.equal(ask, "Aino tarvitsee sinulta yhden asian (kesäkuu 2026): Mikä oli IKEA-ostos? Vastaa kuvalla, kirjoita vastaus tai vastaa 'en ole varma'. Ref: ABC123");
    assert.equal(
      render({ templateName: 'donna_close_queue_v1', bodyParameters: ['kesäkuu 2026', '3', '2'], language: 'fi' }),
      "Donna on melkein valmis sulkemaan kauden (kesäkuu 2026). Avoinna: 3 kysymystä, 2 puuttuvaa kuittia. Vastaa 'näytä', niin käydään ne läpi yksi kerrallaan."
    );
    assert.match(render({ templateName: 'donna_close_queue_v1', bodyParameters: ['kesäkuu 2026', '1', '1'], language: 'fi' }), /Avoinna: 1 kysymys, 1 puuttuva kuitti\./);
    assert.equal(
      render({ templateName: 'donna_decision_check_v1', bodyParameters: ['IKEA-veloituksen', 'Toimistotarvikkeet', 'ABC123'], language: 'fi' }),
      "Donna kirjasi IKEA-veloituksen aiempien sääntöjesi perusteella näin: Toimistotarvikkeet. Vastaa 'oikein' tai 'väärin'. Ref: ABC123"
    );
    for (const templateName of Object.keys(EN_TEMPLATES)) {
      const text = render({ templateName, language: 'fi' });
      assert.doesNotMatch(text, /\b(this period|needs|reply)\b/i, `${templateName}: no English left in the Finnish default`);
      assert.doesNotMatch(text, /[–—]/, `${templateName}: no em or en dash`);
    }
  }
});

test('deliverOwnerMessage passes the owner language to the SMS and Telegram renderers', async () => {
  let smsBody;
  await deliverOwnerMessage({
    channel: OWNER_CHANNELS.SMS,
    recipient: { phone_e164: '+358401234567' },
    template: { name: 'donna_evidence_ask_v1', bodyParameters: ['kesäkuu', 'kuitti?', 'ABC123'], language: 'fi' },
    deps: { accountSid: 'AC123', authToken: 'secret', from: '+15550000000', fetchImpl: async (_url, options) => { smsBody = new URLSearchParams(options.body); return { ok: true, json: async () => ({ sid: 'SM125' }) }; } }
  });
  assert.match(smsBody.get('Body'), /^Donna tarvitsee sinulta yhden asian \(kesäkuu\): kuitti\?/);
  let tgBody;
  await deliverOwnerMessage({
    channel: OWNER_CHANNELS.TELEGRAM,
    recipient: { phone_e164: '987654321' },
    template: { name: 'donna_evidence_ask_v1', bodyParameters: ['kesäkuu', 'kuitti?', 'ABC123'], language: 'fi' },
    deps: { botToken: 'BOTTOKEN:abc', fetchImpl: async (_url, options) => { tgBody = JSON.parse(options.body); return { ok: true, json: async () => ({ ok: true, result: { message_id: 78 } }) }; } }
  });
  assert.match(tgBody.text, /^Donna tarvitsee sinulta yhden asian \(kesäkuu\): kuitti\?/);
});
