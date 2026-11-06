import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { processSmsInboundMessage, downloadTwilioMedia, handleSmsComplianceCommand, isSmsHelp, isSmsStop, SMS_INBOUND_COPY } from './channels/smsInbound.js';
import { verifyTwilioWebhookSignature } from './channels/smsWebhookCore.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';

const envOn = { SMS_ENABLED: 'true', SMS_CLIENTS: 'client-1', TWILIO_ACCOUNT_SID: 'AC123', TWILIO_AUTH_TOKEN: 'secret' };
const binding = { id: 'sms-binding-1', client_id: 'client-1', collaborator_id: 'collab-1', phone_hash: hashPhoneE164('+15551234567'), phone_e164: '+15551234567' };

const makeDeps = (overrides = {}) => {
  const calls = { texts: [], resolved: [], claims: [], registered: [], ledger: [], downloads: [], stores: [] };
  const processed = new Set();
  const deps = {
    getBindingsByPhoneHash: async () => overrides.bindings || [binding],
    getOpenAskByRef: async ({ clientId, askRef }) => (overrides.openByRef || {})[`${clientId}:${askRef}`] || null,
    claimInboundMessage: async ({ inboundMessageId, ...rest }) => { calls.claims.push({ inboundMessageId, ...rest }); if (processed.has(inboundMessageId)) return { claimed: false }; processed.add(inboundMessageId); return { claimed: true }; },
    resolveEvidenceRequest: async (args) => { calls.resolved.push(args); return { evidence_request: { id: args.evidenceRequestId, status: 'replied' } }; },
    sendText: async (args) => { calls.texts.push(args); return { ok: true }; },
    downloadMedia: async (args) => { calls.downloads.push(args); return { bytes: Buffer.from('image'), mimeType: 'image/jpeg', filename: 'receipt.jpg', sha256: 'sum' }; },
    storeMedia: async (args) => { calls.stores.push(args); return { provider: 'supabase_storage', bucket: 'donna-evidence', key: 'key', checksum_sha256: 'sum', size: 5, content_type: 'image/jpeg', filename: 'receipt.jpg' }; },
    registerEvidenceDocument: async (args) => { calls.registered.push(args); return { id: 'doc-sms-1', client_id: args.clientId }; },
    recordLedger: async (args) => { calls.ledger.push(args); return args.entry; },
    ...overrides.deps
  };
  return { deps, calls };
};

test('verifyTwilioWebhookSignature accepts valid signature and rejects tampering', () => {
  const url = 'https://donna.example/api/donna/sms/webhook';
  const params = { Body: 'Ref: ABC123', From: '+15551234567', MessageSid: 'SM1' };
  const signature = createHmac('sha1', 'secret').update(`${url}Body${params.Body}From${params.From}MessageSid${params.MessageSid}`).digest('base64');
  assert.equal(verifyTwilioWebhookSignature({ url, params, signature, authToken: 'secret' }), true);
  assert.equal(verifyTwilioWebhookSignature({ url, params, signature, authToken: 'wrong' }), false);
  assert.equal(verifyTwilioWebhookSignature({ url, params: { ...params, Body: 'tampered' }, signature, authToken: 'secret' }), false);
  assert.equal(verifyTwilioWebhookSignature({ url, params, signature: 'short', authToken: 'secret' }), false);
});

test('SMS Ref-anchored text resolves the ask with the bound owner actor', async () => {
  const { deps, calls } = makeDeps({ openByRef: { 'client-1:23DEF456': { id: 'ask_abc123def456', client_id: 'client-1', transaction_id: 'tx-1' } } });
  const result = await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps, message: { MessageSid: 'SM.ref', Body: 'personal Ref: 23DEF456' } });
  assert.equal(result.status, 'reply_saved');
  assert.equal(calls.resolved[0].evidenceRequestId, 'ask_abc123def456');
  assert.equal(calls.resolved[0].actorId, 'collab-1');
  assert.equal(calls.ledger[0].entry.provider, 'twilio');
  assert.equal(calls.texts.at(-1).text, 'Your answer is saved. Coding has not finished yet.');
});

test('SMS unanchored and unbound messages nudge only', async () => {
  const anchored = makeDeps();
  const result = await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps: anchored.deps, message: { MessageSid: 'SM.no-ref', Body: 'yes' } });
  assert.equal(result.status, 'nudged');
  assert.equal(anchored.calls.resolved.length, 0);
  assert.equal(anchored.calls.texts[0].text, SMS_INBOUND_COPY.unanchored);

  const unbound = makeDeps({ bindings: [] });
  const nudged = await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps: unbound.deps, message: { MessageSid: 'SM.unbound', Body: 'Ref: 23DEF456' } });
  assert.equal(nudged.status, 'nudged');
  assert.equal(unbound.calls.claims.length, 0);
  assert.equal(unbound.calls.texts[0].text, SMS_INBOUND_COPY.unbound);
});

test('SMS voice note refuses honestly with real copy, never undefined text', async () => {
  const { deps, calls } = makeDeps();
  const result = await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps, message: { MessageSid: 'SM.voice', Body: '', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME2', MediaContentType0: 'audio/ogg' } });
  assert.equal(result.status, 'nudged');
  assert.equal(result.reason, 'voice_deferred');
  assert.equal(typeof SMS_INBOUND_COPY.voiceDeferred, 'string');
  assert.ok(SMS_INBOUND_COPY.voiceDeferred.length > 0);
  assert.equal(calls.texts[0].text, SMS_INBOUND_COPY.voiceDeferred);
  assert.equal(calls.downloads.length, 0, 'a deferred voice note is never downloaded');
});

test('SMS MMS downloads, registers evidence, fires parse seam through register hook, and settles ask', async () => {
  const { deps, calls } = makeDeps({ openByRef: { 'client-1:23DEF456': { id: 'ask_abc123def456', client_id: 'client-1', transaction_id: 'tx-1' } } });
  const result = await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps, message: { MessageSid: 'SM.media', Body: 'Ref: 23DEF456', NumMedia: '1', MediaUrl0: 'https://api.twilio.com/media/ME1', MediaContentType0: 'image/jpeg' } });
  assert.equal(result.status, 'media_registered');
  assert.equal(calls.downloads[0].mediaUrl, 'https://api.twilio.com/media/ME1');
  assert.equal(calls.registered[0].clientId, 'client-1');
  assert.equal(calls.resolved[0].documentIds[0], 'doc-sms-1');
  assert.equal(calls.texts.at(-1).text, SMS_INBOUND_COPY.mediaSaved);
});

test('SMS redelivery is idempotent on Twilio MessageSid', async () => {
  const { deps, calls } = makeDeps({ openByRef: { 'client-1:23DEF456': { id: 'ask_abc123def456', client_id: 'client-1' } } });
  const message = { MessageSid: 'SM.dupe', Body: 'Ref: 23DEF456' };
  await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps, message });
  const second = await processSmsInboundMessage({ from: '+15551234567', firmId: 'firm', env: envOn, deps, message });
  assert.equal(second.status, 'duplicate');
  assert.equal(calls.resolved.length, 1);
});

test('STOP and HELP keywords are deterministic and STOP revokes bindings', async () => {
  assert.equal(isSmsStop('stop'), true);
  assert.equal(isSmsStop('unsubscribe'), true);
  assert.equal(isSmsHelp('help'), true);
  assert.equal(isSmsStop('not sure'), false);
  const calls = { texts: [], revoked: [] };
  const help = await handleSmsComplianceCommand({ body: 'HELP', from: '+15551234567', deps: { sendText: async (args) => { calls.texts.push(args); } } });
  assert.equal(help.action, 'help');
  assert.equal(calls.texts[0].text, SMS_INBOUND_COPY.help);
  const stop = await handleSmsComplianceCommand({ body: 'STOP', from: '+15551234567', bindings: [binding], deps: { sendText: async (args) => { calls.texts.push(args); }, revokeBinding: async (args) => { calls.revoked.push(args); } } });
  assert.equal(stop.action, 'stop');
  assert.equal(calls.revoked[0].bindingId, 'sms-binding-1');
  assert.equal(calls.texts.at(-1).text, SMS_INBOUND_COPY.stopped);
});

test('downloadTwilioMedia uses HTTP basic auth and injected fetch', async () => {
  let auth;
  const media = await downloadTwilioMedia({ mediaUrl: 'https://api.twilio.com/media/ME1', env: envOn, fetchImpl: async (_url, options) => { auth = options.headers.Authorization; return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => Buffer.from('test') }; } });
  assert.match(auth, /^Basic /);
  assert.equal(media.mimeType, 'image/png');
  assert.equal(media.size, 4);
});
