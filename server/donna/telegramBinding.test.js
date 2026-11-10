import test from 'node:test';
import assert from 'node:assert/strict';

import {
  __mintWhatsAppBindTokenWithClient,
  __redeemWhatsAppBindTokenWithClient,
  __getActiveTelegramBindingForClientWithClient,
  __getActiveTelegramBindingsByPhoneHashWithClient,
  __claimInboundTelegramMessageWithClient,
  __getTelegramDeliveryByMessageIdWithClient,
  deliverTelegramEvidenceAsksAfterSend
} from './firmDb.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';

const CHAT_ID = '12345678';

// A minimal fake pg client over the tables the telegram binding/delivery paths
// touch. Mirrors whatsappBinding.test.js's fake, extended for the telegram
// channel discriminator and the delivery-ledger read.
const makeFakeClient = ({ tokens = [], bindings = [], asks = [], profile = null, configStages = [] } = {}) => {
  const state = { tokens: [...tokens], bindings: [...bindings], ledger: new Map(), asks: [...asks], profile, configStages: [...configStages] };
  const auditRows = [];
  const client = {
    state,
    auditRows,
    query: async (sql, params = []) => {
      const text = String(sql).toLowerCase();
      if (['begin', 'commit', 'rollback'].includes(text.trim())) return { rows: [] };
      if (text.includes('insert into client_whatsapp_bind_tokens')) {
        const row = { token_hash: params[0], firm_id: params[1], client_id: params[2], collaborator_id: params[3], created_by: params[4], expires_at: params[5], redeemed_at: null, revoked_at: null };
        state.tokens.push(row); return { rows: [row] };
      }
      if (text.includes('from client_whatsapp_bind_tokens')) return { rows: state.tokens.filter((row) => row.token_hash === params[0]) };
      if (text.includes('update client_whatsapp_bind_tokens')) {
        const token = state.tokens.find((row) => row.token_hash === params[0]);
        if (token) { token.redeemed_at = new Date().toISOString(); token.redeemed_phone_e164 = params[1]; }
        return { rows: token ? [token] : [] };
      }
      if (text.includes('insert into client_whatsapp_bindings')) {
        const row = { id: params[0], firm_id: params[1], client_id: params[2], collaborator_id: params[3], phone_e164: params[4], phone_hash: params[5], verified_set_by: params[6], opted_in_set_by: params[6], channel: params[7] || 'whatsapp', revoked_at: null, verified_at: new Date().toISOString() };
        const index = state.bindings.findIndex((existing) => existing.firm_id === row.firm_id && existing.client_id === row.client_id && existing.collaborator_id === row.collaborator_id && existing.phone_hash === row.phone_hash && (existing.channel || 'whatsapp') === row.channel);
        if (index >= 0) state.bindings[index] = { ...state.bindings[index], ...row, revoked_at: null };
        else state.bindings.push(row);
        return { rows: [row] };
      }
      if (text.includes('from client_whatsapp_bindings') && text.includes('client_id = $2')) {
        const wantsTelegram = text.includes("'telegram'");
        return { rows: state.bindings.filter((row) => row.firm_id === params[0] && row.client_id === params[1] && !row.revoked_at && (!wantsTelegram || (row.channel || 'whatsapp') === 'telegram')).slice(0, 1) };
      }
      if (text.includes('from client_whatsapp_bindings') && text.includes('phone_hash = $1')) {
        const wantsTelegram = text.includes("'telegram'");
        return { rows: state.bindings.filter((row) => row.phone_hash === params[0] && !row.revoked_at && (!wantsTelegram || (row.channel || 'whatsapp') === 'telegram')) };
      }
      if (text.includes('select profile from clients')) return { rows: [{ profile: state.profile }] };
      if (text.includes('update clients set profile')) return { rows: [] };
      // Config control plane — the sensitive-ask portal notice reads
      // OWNER_PORTAL_LINK through readClientConfigSnapshot.
      if (text.includes('from client_capability_config')) return { rows: state.configStages };
      if (text.includes('from cohort_capability_config')) return { rows: [] };
      if (text.includes('from client_evidence_requests')) {
        return { rows: state.asks.filter((row) => row.firm_id === params[0] && row.client_id === params[1] && row.id === params[2]).slice(0, 1) };
      }
      if (text.includes('insert into message_delivery_ledger')) {
        // Two insert shapes share this table: the 8-param inbound claim
        // (provider_payload at $8) and the 17-param full record (ask_id at $5,
        // provider_payload at $17). Distinguish by arity.
        const isFullRecord = params.length > 8;
        const row = isFullRecord
          ? { id: params[0], message_id: params[1], channel: params[2], provider: params[3], ask_id: params[4], client_id: params[5], recipient_phone_hash: params[6], template_name: params[7], sent_at: params[8], failed_at: params[11], failure_reason: params[12], fallback_triggered_at: params[13], provider_payload: JSON.parse(params[16] || '{}') }
          : { id: params[0], message_id: params[1], channel: params[2], provider: params[3], client_id: params[4], recipient_phone_hash: params[5], inbound_reply_id: params[6], provider_payload: JSON.parse(params[7] || '{}') };
        const key = `${row.provider}:${row.message_id}`;
        if (state.ledger.has(key)) {
          // Claim insert is `do nothing` (empty ⇒ not claimed); record insert is
          // `do update` (returns the row).
          return { rows: isFullRecord ? [state.ledger.get(key)] : [] };
        }
        state.ledger.set(key, row); return { rows: [row] };
      }
      if (text.includes('from message_delivery_ledger')) {
        const found = [...state.ledger.values()].find((row) => row.provider === 'telegram' && row.message_id === params[0]);
        return { rows: found ? [found] : [] };
      }
      if (text.includes('insert into audit_events')) {
        const action = String(text.match(/'(whatsapp|telegram|owner_portal_link)\.[^']+'/)?.[0] || '').replaceAll("'", '');
        auditRows.push({ params, action, actor_id: params[2] });
        return { rows: [{}] };
      }
      return { rows: [] };
    }
  };
  return client;
};

test('redeem with channel=telegram stores the chat_id under a tgb_ binding and audits', async () => {
  const client = makeFakeClient();
  await __mintWhatsAppBindTokenWithClient({ client, firmId: 'firm', clientId: 'client', collaboratorId: 'collab', actorId: 'owner-1', tokenHash: 'tok', expiresAt: new Date(Date.now() + 60_000).toISOString() });
  const binding = await __redeemWhatsAppBindTokenWithClient({ client, tokenHash: 'tok', phoneE164: CHAT_ID, actorId: 'telegram:webhook', channel: 'telegram' });
  assert.equal(binding.channel, 'telegram');
  assert.equal(binding.phone_e164, CHAT_ID);
  assert.equal(binding.phone_hash, hashPhoneE164(CHAT_ID));
  assert.match(binding.id, /^tgb_/);
  const verified = client.auditRows.find((row) => row.action === 'whatsapp.binding.verified');
  assert.ok(verified);
  assert.equal(verified.actor_id, 'telegram:webhook');
});

test('telegram binding readers only return telegram-channel rows', async () => {
  const phoneHash = hashPhoneE164(CHAT_ID);
  const client = makeFakeClient({ bindings: [
    { id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: phoneHash, channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() },
    { id: 'wab_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: '+15551234567', phone_hash: hashPhoneE164('+15551234567'), channel: 'whatsapp', revoked_at: null, verified_at: new Date().toISOString() }
  ] });
  const one = await __getActiveTelegramBindingForClientWithClient({ client, firmId: 'firm', clientId: 'client' });
  assert.equal(one.id, 'tgb_1');
  const byHash = await __getActiveTelegramBindingsByPhoneHashWithClient({ client, phoneHash });
  assert.equal(byHash.length, 1);
  assert.equal(byHash[0].channel, 'telegram');
});

test('claimInboundTelegramMessage is idempotent per message_id and audits on first claim', async () => {
  const client = makeFakeClient();
  const first = await __claimInboundTelegramMessageWithClient({ client, firmId: 'firm', inboundMessageId: 'tg_42', clientId: 'client', phoneHash: 'h' });
  assert.equal(first.claimed, true);
  const second = await __claimInboundTelegramMessageWithClient({ client, firmId: 'firm', inboundMessageId: 'tg_42', clientId: 'client', phoneHash: 'h' });
  assert.equal(second.claimed, false);
  assert.ok(client.auditRows.find((row) => row.action === 'telegram.inbound.received'));
});

test('deliverTelegramEvidenceAsksAfterSend gates off, then sends and receipts the outbound message_id', async () => {
  const client = makeFakeClient({
    bindings: [{ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() }],
    asks: [{ id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'What was the Delta charge for?', request_payload: { period: 'June 2026' } }]
  });

  // Flag off ⇒ skipped, nothing sent.
  const off = await deliverTelegramEvidenceAsksAfterSend({ client, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask-1'], env: {} });
  assert.deepEqual(off, { skipped: true, reason: 'flag_off' });

  // Flag on ⇒ sends via injected deliverOwnerMessage, receipts the send id.
  const sent = [];
  const result = await deliverTelegramEvidenceAsksAfterSend({
    client, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask-1'],
    env: { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'client' },
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sent.push(args); return { ok: true, id: '9001', body: { ok: true } }; }
    }
  });
  assert.deepEqual(result, { sent: 1 });
  assert.equal(sent[0].channel, 'telegram');
  assert.equal(sent[0].recipient.phone_e164, CHAT_ID);
  assert.match(sent[0].template.bodyParameters.join(' '), /June 2026/);
  const ledgerRow = await __getTelegramDeliveryByMessageIdWithClient({ client, messageId: '9001' });
  assert.ok(ledgerRow, 'outbound send id is receipted so a tapped reply can anchor back');
  assert.equal(ledgerRow.provider, 'telegram');
  assert.equal(ledgerRow.message_id, '9001');
});

test('blocked sensitive ask over Telegram degrades to the named portal instruction when no base URL is set', async () => {
  const db = makeFakeClient({
    bindings: [{ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() }],
    asks: [{ id: 'ask_s', firm_id: 'firm', client_id: 'client', question: 'reply with your IBAN', request_payload: {} }],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const sends = [];
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_s'],
    // No PUBLIC_APP_URL / APP_BASE_URL ⇒ the ownerDigest degrade posture: an
    // instruction naming where to look, never a dead link, never silence.
    env: { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'client' },
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9002', body: { ok: true } }; }
    }
  });
  assert.equal(sends.length, 1, 'only the notice rides the channel, never the blocked ask');
  assert.equal(sends[0].template.name, 'donna_sensitive_ask_notice_v1');
  const text = sends[0].template.bodyParameters[0];
  assert.ok(!text.toLowerCase().includes('iban'), 'question content never rides the channel');
  assert.ok(!text.includes('http'), 'no dead link in the degrade copy');
  assert.match(text, /Open your Donna portal/);
  assert.match(text, /What I still need from you/);
  const notice = db.state.ledger.get('telegram:9002');
  assert.ok(notice, 'the notice send is receipted in the delivery ledger');
  assert.equal(notice.provider_payload.link_status, 'no_base_url');
  const audit = db.auditRows.find((row) => row.action === 'owner_portal_link.shared');
  assert.ok(audit, 'the degrade send is still audited');
  assert.equal(JSON.parse(audit.params[4]).status, 'no_base_url');
});

// ── Consolidated ask digest ─────────────────────────────────────────────────
//
// The 2026-07-29 report: uploading one receipt woke the loop, which re-drafted
// the client's whole open-ask set, and this deliverer fanned it out as five
// separate Telegram messages. A chat is not a worklist.

const digestFixture = () => makeFakeClient({
  bindings: [{ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() }],
  asks: [
    { id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'What was this Garden Complex purchase for?', request_payload: { period: 'July 2026' } },
    { id: 'ask-2', firm_id: 'firm', client_id: 'client', question: 'What was this Cafe Bar Magia charge for?', request_payload: { period: 'July 2026' } },
    { id: 'ask-3', firm_id: 'firm', client_id: 'client', question: 'What was this KUILI BARBACOA charge for?', request_payload: { period: 'July 2026' } }
  ]
});

const TG_ENV = { TELEGRAM_ENABLED: 'true', TELEGRAM_CLIENTS: 'client' };

test('three open asks arrive as ONE Telegram message, not three', async () => {
  const db = digestFixture();
  const sends = [];
  const result = await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1', 'ask-2', 'ask-3'],
    env: TG_ENV,
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9100', body: { ok: true } }; }
    }
  });
  assert.equal(sends.length, 1, 'exactly one message carries the whole batch');
  assert.equal(result.sent, 3);
  assert.equal(result.digest, true);
  const text = sends[0].template.bodyParameters[0];
  assert.match(text, /Garden Complex/);
  assert.match(text, /Cafe Bar Magia/);
  assert.match(text, /KUILI BARBACOA/);
});

test('the digest still receipts one ledger row per ask, keyed uniquely', async () => {
  const db = digestFixture();
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1', 'ask-2', 'ask-3'],
    env: TG_ENV,
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async () => ({ ok: true, id: '9100', body: { ok: true } })
    }
  });
  // (provider, message_id) is unique, so the shared send id cannot be the key;
  // it rides batch_message_id instead, exactly as the email deliverer does.
  for (const askId of ['ask-1', 'ask-2', 'ask-3']) {
    const row = db.state.ledger.get(`telegram:9100_${askId}`);
    assert.ok(row, `ask ${askId} has its own delivery receipt`);
    assert.equal(row.ask_id, askId);
    assert.equal(row.provider_payload.batch_message_id, '9100');
    assert.equal(row.provider_payload.digest_size, 3);
  }
});

test('a single ask is byte-identical to the pre-digest path, so tapped-reply anchoring survives', async () => {
  const db = digestFixture();
  const sends = [];
  const result = await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1'],
    env: TG_ENV,
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9101', body: { ok: true } }; }
    }
  });
  assert.deepEqual(result, { sent: 1 });
  assert.equal(sends[0].template.name, 'donna_evidence_ask_v1');
  const row = await __getTelegramDeliveryByMessageIdWithClient({ client: db, messageId: '9101' });
  assert.ok(row, 'the bare send id is still the ledger key for a single ask');
  assert.equal(row.ask_id, 'ask-1');
});

test('a sensitive ask never joins the digest and keeps its own portal fallback', async () => {
  const db = makeFakeClient({
    bindings: [{ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() }],
    asks: [
      { id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'What was this Garden Complex purchase for?', request_payload: { period: 'July 2026' } },
      { id: 'ask-2', firm_id: 'firm', client_id: 'client', question: 'What was this Cafe charge for?', request_payload: { period: 'July 2026' } },
      { id: 'ask_s', firm_id: 'firm', client_id: 'client', question: 'reply with your IBAN', request_payload: { period: 'July 2026' } }
    ]
  });
  const sends = [];
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1', 'ask-2', 'ask_s'],
    env: TG_ENV,
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: `92${sends.length}`, body: { ok: true } }; }
    }
  });
  const digest = sends.find((s) => s.template.name === 'donna_evidence_ask_digest_v1');
  assert.ok(digest, 'the two safe asks still consolidate');
  assert.ok(!digest.template.bodyParameters[0].toLowerCase().includes('iban'), 'the sensitive ask never rides the channel');
  assert.match(digest.template.bodyParameters[0], /Garden Complex/);
  const fallback = db.state.ledger.get('telegram:telegram_fallback_ask_s');
  assert.ok(fallback, 'the blocked ask keeps its own visible fallback receipt');
});

test('a failed digest send is receipted as failed for every ask in it', async () => {
  const db = digestFixture();
  const result = await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1', 'ask-2', 'ask-3'],
    env: TG_ENV,
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async () => ({ ok: false, reason: 'TELEGRAM_SEND_FAILED' })
    }
  });
  assert.equal(result.sent, 0);
  assert.equal(result.failed, 3);
  for (const askId of ['ask-1', 'ask-2', 'ask-3']) {
    const row = db.state.ledger.get(`telegram:telegram_digest_fallback_${askId}`);
    assert.ok(row, `ask ${askId} records the failure`);
    assert.equal(row.failure_reason, 'TELEGRAM_SEND_FAILED');
    assert.ok(row.fallback_triggered_at, 'the fallback trail stays per-request');
  }
});

test('the portal link is attached to a digest when OWNER_PORTAL_LINK acts', async () => {
  const db = makeFakeClient({
    bindings: [{ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() }],
    asks: [
      { id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'What was this Garden Complex purchase for?', request_payload: { period: 'July 2026' } },
      { id: 'ask-2', firm_id: 'firm', client_id: 'client', question: 'What was this Cafe charge for?', request_payload: { period: 'July 2026' } }
    ],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const sends = [];
  const result = await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1', 'ask-2'],
    env: { ...TG_ENV, PUBLIC_APP_URL: 'https://app.example.com' },
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9300', body: { ok: true } }; }
    }
  });
  assert.equal(result.portal_link, true);
  assert.match(sends[0].template.bodyParameters[0], /https:\/\/app\.example\.com/);
});

test('no portal base URL degrades to a digest with no link, never a dead one', async () => {
  const db = makeFakeClient({
    bindings: [{ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() }],
    asks: [
      { id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'What was this Garden Complex purchase for?', request_payload: { period: 'July 2026' } },
      { id: 'ask-2', firm_id: 'firm', client_id: 'client', question: 'What was this Cafe charge for?', request_payload: { period: 'July 2026' } }
    ],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const sends = [];
  const result = await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client',
    evidenceRequestIds: ['ask-1', 'ask-2'],
    env: TG_ENV,
    deps: {
      OWNER_CHANNELS: { TELEGRAM: 'telegram' },
      deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9400', body: { ok: true } }; }
    }
  });
  assert.equal(result.portal_link, false);
  assert.ok(!sends[0].template.bodyParameters[0].includes('http'), 'no dead link');
  assert.equal(result.sent, 2, 'the digest still sends');
});

// ── The owner's language ────────────────────────────────────────────────────
//
// The deliverer reads the profile once per batch and the ONE resolver decides:
// a Finnish owner reads Finnish, rendered through the real Telegram renderer;
// the language sent is recorded on every ledger row.

const fiBinding = () => ({ id: 'tgb_1', firm_id: 'firm', client_id: 'client', collaborator_id: 'c', phone_e164: CHAT_ID, phone_hash: hashPhoneE164(CHAT_ID), channel: 'telegram', revoked_at: null, verified_at: new Date().toISOString() });

test('a Finnish owner gets the Finnish ask, affordance tail and period fallback; the ledger records fi', async () => {
  const { renderTelegramTemplate } = await import('./channels/telegram.js');
  const db = makeFakeClient({
    profile: { jurisdiction: 'FI', assistant_name: 'Aino' },
    bindings: [fiBinding()],
    asks: [{ id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'Mikä oli 42,00 euron veloitus?', request_payload: {} }]
  });
  const sends = [];
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask-1'], env: TG_ENV,
    deps: { OWNER_CHANNELS: { TELEGRAM: 'telegram' }, deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9301', body: { ok: true } }; } }
  });
  assert.equal(sends[0].template.language, 'fi');
  assert.equal(sends[0].template.bodyParameters[0], 'tämä kausi', 'the period fallback is Finnish');
  const { name: templateName, bodyParameters, assistantName, language } = sends[0].template;
  const text = renderTelegramTemplate({ templateName, bodyParameters, assistantName, language });
  assert.equal(text, "Aino tarvitsee sinulta yhden asian (tämä kausi): Mikä oli 42,00 euron veloitus? Vastaa kuvalla, kirjoita vastaus tai vastaa 'en ole varma'. Ref: ASK1");
  assert.doesNotMatch(text, /[–—]/, 'Telegram voice rule: no em or en dash');
  const row = await __getTelegramDeliveryByMessageIdWithClient({ client: db, messageId: '9301' });
  assert.equal(row.provider_payload.language, 'fi');
});

test('an English owner keeps the English ask byte-identically; the ledger records en', async () => {
  const { renderTelegramTemplate } = await import('./channels/telegram.js');
  const db = makeFakeClient({
    profile: { jurisdiction: 'US' },
    bindings: [fiBinding()],
    asks: [{ id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'What was the Delta charge for?', request_payload: {} }]
  });
  const sends = [];
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask-1'], env: TG_ENV,
    deps: { OWNER_CHANNELS: { TELEGRAM: 'telegram' }, deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9302', body: { ok: true } }; } }
  });
  assert.equal(sends[0].template.bodyParameters[0], 'this period');
  const { name: templateName, bodyParameters, assistantName, language } = sends[0].template;
  assert.equal(renderTelegramTemplate({ templateName, bodyParameters, assistantName, language }), "Donna needs one thing for this period: What was the Delta charge for? — reply with a photo, answer in words, or reply 'not sure'. Ref: ASK1");
  const row = await __getTelegramDeliveryByMessageIdWithClient({ client: db, messageId: '9302' });
  assert.equal(row.provider_payload.language, 'en');
});

test('a Finnish owner gets the Finnish digest, and every per-ask ledger row records fi', async () => {
  const db = makeFakeClient({
    profile: { jurisdiction: 'FI' },
    bindings: [fiBinding()],
    asks: [
      { id: 'ask-1', firm_id: 'firm', client_id: 'client', question: 'Mikä tämä ostos oli?', request_payload: { period: 'heinäkuu 2026' } },
      { id: 'ask-2', firm_id: 'firm', client_id: 'client', question: 'Oliko tämä työmatka?', request_payload: { period: 'heinäkuu 2026' } }
    ]
  });
  const sends = [];
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask-1', 'ask-2'], env: TG_ENV,
    deps: { OWNER_CHANNELS: { TELEGRAM: 'telegram' }, deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9303', body: { ok: true } }; } }
  });
  const text = sends[0].template.bodyParameters[0];
  assert.match(text, /^Donna tarvitsee sinulta 2 asiaa \(heinäkuu 2026\):/);
  assert.match(text, /Vastaa tähän kuvalla tai kirjoittamalla\. Jos vastaat vain yhteen, mainitse sen Ref\./);
  const rows = [...db.state.ledger.values()].filter((row) => row.template_name === 'donna_evidence_ask_digest_v1');
  assert.deepEqual(rows.map((row) => row.provider_payload.language), ['fi', 'fi']);
});

test('a blocked sensitive ask sends the Finnish portal notice to a Finnish owner', async () => {
  const db = makeFakeClient({
    profile: { jurisdiction: 'FI' },
    bindings: [fiBinding()],
    asks: [{ id: 'ask_s', firm_id: 'firm', client_id: 'client', question: 'reply with your IBAN', request_payload: {} }],
    configStages: [{ flag_key: 'OWNER_PORTAL_LINK', stage: 'canary', source: 'test', client_id: 'client' }]
  });
  const sends = [];
  await deliverTelegramEvidenceAsksAfterSend({
    client: db, firmId: 'firm', clientId: 'client', evidenceRequestIds: ['ask_s'], env: TG_ENV,
    deps: { OWNER_CHANNELS: { TELEGRAM: 'telegram' }, deliverOwnerMessage: async (args) => { sends.push(args); return { ok: true, id: '9304', body: { ok: true } }; } }
  });
  assert.equal(sends.length, 1);
  assert.match(sends[0].template.bodyParameters[0], /^Hei, täällä Donna\. Minulla on sinulle kysymys, joka on liian arkaluonteinen/);
  assert.match(sends[0].template.bodyParameters[0], /\(ref [A-Z0-9_]+\)$/);
  assert.doesNotMatch(sends[0].template.bodyParameters[0], /IBAN/);
  const notice = db.state.ledger.get('telegram:9304');
  assert.equal(notice.provider_payload.language, 'fi');
});
