import test from 'node:test';
import assert from 'node:assert/strict';

import { downloadWhatsAppMedia, processWhatsAppInboundMessage, resolveWhatsAppInboundAnchor, WHATSAPP_INBOUND_COPY } from './channels/whatsappInbound.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';

const envOn = { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'client-1', WHATSAPP_ACCESS_TOKEN: 'token' };
const binding = { id: 'binding-1', client_id: 'client-1', collaborator_id: 'collab-1', phone_hash: hashPhoneE164('+447700900123'), phone_e164: '+447700900123' };

const makeDeps = (overrides = {}) => {
  const calls = { texts: [], resolved: [], topics: [], claims: [], registered: [], ledger: [], downloads: [], stores: [], thread: [], configReads: 0 };
  const processed = new Set();
  const deps = {
    getBindingsByPhoneHash: async () => overrides.bindings || [binding],
    getDeliveryByMessageId: async ({ messageId }) => (overrides.deliveries || {})[messageId] || null,
    getOpenAskByRef: async ({ clientId, askRef }) => (overrides.openByRef || {})[`${clientId}:${askRef}`] || null,
    loadClientConfigSnapshot: async () => { calls.configReads += 1; return overrides.snapshot || null; },
    // Mirrors the production default (getClientEvidenceRequestByIdInDb): the
    // dispatch loads the ask row to key off evidence_type; generic asks here.
    getAskById: async ({ askId }) => (overrides.asksById || {})[askId] || null,
    claimInboundMessage: async ({ inboundMessageId, ...rest }) => {
      calls.claims.push({ inboundMessageId, ...rest });
      if (processed.has(inboundMessageId)) return { claimed: false };
      processed.add(inboundMessageId);
      return { claimed: true };
    },
    resolveEvidenceRequest: async (args) => { calls.resolved.push(args); return { evidence_request: { id: args.evidenceRequestId, status: 'replied' } }; },
    recordEvidenceTopicTurn: async (args) => {
      calls.topics.push(args);
      return {
        evidence_request: {
          id: args.evidenceRequestId,
          status: 'open',
          request_payload: { evidence_topic: args.topicState }
        }
      };
    },
    sendText: async (args) => { calls.texts.push(args); return { ok: true }; },
    downloadMedia: async (args) => { calls.downloads.push(args); return { bytes: Buffer.from('image'), mimeType: 'image/jpeg', filename: 'receipt.jpg', sha256: 'sum' }; },
    storeMedia: async (args) => { calls.stores.push(args); return { provider: 'supabase_storage', bucket: 'donna-evidence', key: 'key', checksum_sha256: 'sum', size: 5, content_type: 'image/jpeg', filename: 'receipt.jpg' }; },
    registerEvidenceDocument: async (args) => { calls.registered.push(args); return { id: 'doc-1', client_id: args.clientId }; },
    recordLedger: async (args) => { calls.ledger.push(args); return args.entry; },
    appendClientPortalChatMessage: async (args) => { calls.thread.push(args); return args; },
    ...overrides.deps
  };
  return { deps, calls };
};

test('context.id anchors through delivery ledger and wrong context does not resolve', async () => {
  const { deps, calls } = makeDeps({ deliveries: { 'wamid.template': { ask_id: 'ask-1', client_id: 'client-1' } } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.reply', type: 'text', text: { body: 'personal' }, context: { id: 'wamid.template' } } });
  assert.equal(result.status, 'reply_saved');
  assert.equal(calls.resolved[0].evidenceRequestId, 'ask-1');
  assert.equal(calls.resolved[0].actorId, 'collab-1');
  assert.equal(calls.resolved[0].actorType, 'client');
  assert.equal(calls.texts.at(-1).text, 'Your answer is saved. Coding has not finished yet.');
  assert.equal(calls.thread[0].content, 'personal', 'anchored owner reply persists to the shared portal thread');

  const foreign = makeDeps({ deliveries: { 'wamid.foreign': { ask_id: 'ask-2', client_id: 'other-client' } } });
  const nudged = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps: foreign.deps, message: { id: 'wamid.reply-2', type: 'text', text: { body: 'personal' }, context: { id: 'wamid.foreign' } } });
  assert.equal(nudged.status, 'nudged');
  assert.equal(foreign.calls.resolved.length, 0);
  assert.equal(foreign.calls.texts[0].text, WHATSAPP_INBOUND_COPY.unanchored);
});

test('WhatsApp free-form owner chat is config-plane dark by default and the query runs', async () => {
  const { deps, calls } = makeDeps({ snapshot: { OWNER_CHANNEL_WHATSAPP: { stage: 'auto' } } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: {}, deps, message: { id: 'wamid.dark-chat', type: 'text', text: { body: 'How are my books?' } } });
  assert.equal(result.status, 'nudged');
  assert.ok(calls.configReads > 0);
  assert.equal(calls.thread.length, 0);
});

test('flagged WhatsApp free-form turn lands in the same owner thread used by the portal', async () => {
  const { deps, calls } = makeDeps({ snapshot: { OWNER_CHANNEL_WHATSAPP: { stage: 'auto' }, WHATSAPP_OWNER_CONVERSATION: { stage: 'auto' } }, deps: {
    assembleClientPortalTurn: async ({ userMessageRow }) => ({ context: { client: { id: 'client-1' }, today: '2026-07-31' }, history: [userMessageRow], validAskIds: [], assistantName: 'Donna' }),
    generateClientPortalChatReply: async () => ({ kind: 'ok', text: 'Your books are current.', actions: [], model: 'test' })
  } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: {}, deps, message: { id: 'wamid.live-chat', type: 'text', text: { body: 'How are my books?' } } });
  assert.equal(result.status, 'general_chat');
  assert.deepEqual(calls.thread.map((row) => row.role), ['user', 'assistant']);
  assert.equal(calls.thread[0].content, 'How are my books?');
});

test('Ref-token fallback anchors an open ask', async () => {
  const { deps, calls } = makeDeps({ openByRef: { 'client-1:23DEF456': { id: 'ask_abc123def456', client_id: 'client-1', transaction_id: 'tx-1' } } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.ref', type: 'text', text: { body: 'It was for client dinner with Acme. Ref: 23DEF456' } } });
  assert.equal(result.status, 'reply_saved');
  assert.equal(calls.resolved[0].evidenceRequestId, 'ask_abc123def456');
});

test('Ref-token fallback keeps not sure replies open as evidence topics', async () => {
  const { deps, calls } = makeDeps({
    openByRef: {
      'client-1:23DEF456': {
        id: 'ask_abc123def456',
        client_id: 'client-1',
        transaction_id: 'tx-1',
        status: 'open',
        question: 'Please send the receipt for this client dinner.'
      }
    }
  });
  const result = await processWhatsAppInboundMessage({
    from: '+447700900123', firmId: 'firm', env: envOn, deps,
    message: { id: 'wamid.not_sure', type: 'text', text: { body: 'not sure. Ref: 23DEF456' } }
  });
  assert.equal(result.status, 'topic_open');
  assert.equal(calls.resolved.length, 0);
  assert.equal(calls.topics.length, 1);
  assert.equal(calls.topics[0].evidenceRequestId, 'ask_abc123def456');
  assert.equal(calls.topics[0].topicState.status, 'open');
  assert.equal(calls.topics[0].topicState.last_assessment.outcome, 'partial_answer');
  assert.equal(calls.texts.at(-1).text, WHATSAPP_INBOUND_COPY.topicOpen);
});

test('unanchored messages nudge and never resolve, even for bound numbers', async () => {
  const { deps, calls } = makeDeps();
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.unanchored', type: 'text', text: { body: 'yes' } } });
  assert.equal(result.status, 'nudged');
  assert.equal(calls.resolved.length, 0);
  assert.equal(calls.texts[0].text, WHATSAPP_INBOUND_COPY.unanchored);
});

test('media reply downloads, registers evidence for the anchored client, and settles the ask', async () => {
  const { deps, calls } = makeDeps({ deliveries: { 'wamid.template': { ask_id: 'ask-1', client_id: 'client-1' } } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.media', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' }, context: { id: 'wamid.template' } } });
  assert.equal(result.status, 'media_registered');
  assert.equal(calls.downloads[0].mediaId, 'media-1');
  assert.equal(calls.registered[0].clientId, 'client-1');
  assert.equal(calls.resolved[0].documentIds[0], 'doc-1');
  assert.equal(calls.texts.at(-1).text, WHATSAPP_INBOUND_COPY.mediaSaved);
});

test('idempotent redelivery processes the same inbound wamid once', async () => {
  const { deps, calls } = makeDeps({ deliveries: { 'wamid.template': { ask_id: 'ask-1', client_id: 'client-1' } } });
  const message = { id: 'wamid.dupe', type: 'image', image: { id: 'media-1' }, context: { id: 'wamid.template' } };
  await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message });
  const second = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message });
  assert.equal(second.status, 'duplicate');
  assert.equal(calls.resolved.length, 1);
  assert.equal(calls.registered.length, 1);
});

test('unbound number gets portal nudge only', async () => {
  const { deps, calls } = makeDeps({ bindings: [] });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.unbound', type: 'text', text: { body: 'Ref: 23DEF456' } } });
  assert.equal(result.status, 'nudged');
  assert.equal(calls.claims.length, 0);
  assert.equal(calls.resolved.length, 0);
  assert.equal(calls.texts[0].text, WHATSAPP_INBOUND_COPY.unbound);
});

test('voice notes are deferred without download or resolution', async () => {
  const { deps, calls } = makeDeps({ deliveries: { 'wamid.template': { ask_id: 'ask-1', client_id: 'client-1' } } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.audio', type: 'audio', audio: { id: 'audio-1' }, context: { id: 'wamid.template' } } });
  assert.equal(result.status, 'nudged');
  assert.equal(calls.downloads.length, 0);
  assert.equal(calls.resolved.length, 0);
  assert.equal(calls.texts.at(-1).text, WHATSAPP_INBOUND_COPY.voiceDeferred);
});

test('downloadWhatsAppMedia uses injected fetch for Meta metadata and bytes', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (String(url).includes('graph.facebook.com')) return { ok: true, json: async () => ({ url: 'https://media.example/file', mime_type: 'image/png', file_size: 4 }) };
    return { ok: true, headers: new Map([['content-type', 'image/png']]), arrayBuffer: async () => Buffer.from('test') };
  };
  const media = await downloadWhatsAppMedia({ mediaId: 'media-1', env: { WHATSAPP_ACCESS_TOKEN: 'token' }, fetchImpl });
  assert.equal(calls.length, 2);
  assert.equal(media.mimeType, 'image/png');
  assert.equal(media.size, 4);
});

// ----- G-9 — WhatsApp opt-out parity (docs/design-donna-finland-fi15-g9-retention-optout.md)

test('WhatsApp opt-out keywords are exact whole-message matches; confirm-lane words never match', async () => {
  const { isWhatsAppStop, isWhatsAppHelp } = await import('./channels/whatsappInbound.js');
  assert.equal(isWhatsAppStop('lopeta'), true);
  assert.equal(isWhatsAppStop(' STOP '), true);
  assert.equal(isWhatsAppStop('unsubscribe'), true);
  // Exact match only — an instruction containing the word is not an opt-out.
  assert.equal(isWhatsAppStop('lopeta laskutus'), false);
  // D-G9-6: the confirm-first lane's vocabulary must never disconnect the
  // channel — kyllä/ei/peru belong to draft confirmation, CANCEL/END are
  // CTIA-only keywords deliberately absent from the WhatsApp set.
  assert.equal(isWhatsAppStop('peru'), false);
  assert.equal(isWhatsAppStop('ei'), false);
  assert.equal(isWhatsAppStop('kyllä'), false);
  assert.equal(isWhatsAppStop('cancel'), false);
  assert.equal(isWhatsAppStop('end'), false);
  assert.equal(isWhatsAppHelp('apua'), true);
  assert.equal(isWhatsAppHelp('HELP'), true);
  assert.equal(isWhatsAppHelp('apua tarvitsen'), false);
});

test('LOPETA revokes every active binding and confirms with the bilingual stopped copy', async () => {
  const { handleWhatsAppComplianceCommand } = await import('./channels/whatsappInbound.js');
  const calls = { texts: [], revoked: [] };
  const secondBinding = { ...binding, id: 'binding-2', client_id: 'client-2', firm_id: 'firm-x', collaborator_id: null };
  const result = await handleWhatsAppComplianceCommand({
    body: 'lopeta',
    from: '+447700900123',
    firmId: 'firm',
    bindings: [binding, secondBinding],
    deps: {
      sendText: async (args) => { calls.texts.push(args); },
      revokeBinding: async (args) => { calls.revoked.push(args); }
    }
  });
  assert.deepEqual(result, { handled: true, action: 'stop', revoked: 2 });
  assert.equal(calls.revoked.length, 2);
  assert.equal(calls.revoked[0].bindingId, 'binding-1');
  assert.equal(calls.revoked[0].actorId, 'collab-1');
  assert.equal(calls.revoked[1].firmId, 'firm-x');
  assert.equal(calls.revoked[1].actorId, 'whatsapp:webhook');
  assert.equal(calls.texts.length, 1);
  assert.equal(calls.texts[0].text, WHATSAPP_INBOUND_COPY.stopped);
  assert.match(WHATSAPP_INBOUND_COPY.stopped, /Yhteys katkaistu/u);
  assert.match(WHATSAPP_INBOUND_COPY.stopped, /You're disconnected/u);
});

test('APUA replies with help; ordinary text is not handled and flows to anchored processing', async () => {
  const { handleWhatsAppComplianceCommand } = await import('./channels/whatsappInbound.js');
  const calls = { texts: [], revoked: [] };
  const deps = {
    sendText: async (args) => { calls.texts.push(args); },
    revokeBinding: async (args) => { calls.revoked.push(args); }
  };
  const help = await handleWhatsAppComplianceCommand({ body: 'APUA', from: '+447700900123', bindings: [binding], deps });
  assert.deepEqual(help, { handled: true, action: 'help' });
  assert.equal(calls.texts[0].text, WHATSAPP_INBOUND_COPY.help);
  assert.match(WHATSAPP_INBOUND_COPY.help, /LOPETA/u);
  const passthrough = await handleWhatsAppComplianceCommand({ body: 'Tämä on vuokra', from: '+447700900123', bindings: [binding], deps });
  assert.deepEqual(passthrough, { handled: false });
  assert.equal(calls.revoked.length, 0);
  assert.equal(calls.texts.length, 1);
});

// ── The owner's language ────────────────────────────────────────────────────

const fiAsk = { 'client-1:23DEF456': { id: 'ask_abc123def456', client_id: 'client-1', transaction_id: 'tx-1', status: 'open', question: 'Lähetä kuitti tästä illallisesta.' } };

test("a Finnish owner's 'en ole varma' keeps the ask open and is answered in Finnish", async () => {
  const reads = [];
  const { deps, calls } = makeDeps({ openByRef: fiAsk, deps: { getOwnerLanguage: async (args) => { reads.push(args); return 'fi'; } } });
  const result = await processWhatsAppInboundMessage({
    from: '+447700900123', firmId: 'firm', env: envOn, deps,
    message: { id: 'wamid.fi.not_sure', type: 'text', text: { body: 'En ole varma. Ref: 23DEF456' } }
  });
  assert.equal(result.status, 'topic_open');
  assert.equal(calls.resolved.length, 0, 'never resolved as an answer');
  assert.equal(calls.topics[0].topicState.last_assessment.outcome, 'partial_answer');
  assert.equal(calls.texts.at(-1).text, 'Selvä, pidän tämän kysymyksen avoimena.');
  assert.deepEqual(reads, [{ firmId: 'firm', clientId: 'client-1' }], 'the language is read for the anchored client');
});

test('a Finnish owner gets the Finnish media and unanchored acknowledgements; an English owner the historical ones', async () => {
  const fiMedia = makeDeps({ openByRef: fiAsk, deps: { getOwnerLanguage: async () => 'fi' } });
  await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps: fiMedia.deps, message: { id: 'wamid.fi.media', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' }, caption: 'Ref: 23DEF456' } });
  assert.equal(fiMedia.calls.texts.at(-1).text, 'Selvä, luen sitä nyt.');

  const fiNudge = makeDeps({ deps: { getOwnerLanguage: async () => 'fi' } });
  await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps: fiNudge.deps, message: { id: 'wamid.fi.nudge', type: 'text', text: { body: 'kyllä' } } });
  assert.equal(fiNudge.calls.texts[0].text, 'Vastaa suoraan siihen kysymykseen, johon vastaat, tai lisää viestiin sen Ref, niin yhdistän sen oikein.');

  const enMedia = makeDeps({ openByRef: fiAsk, deps: { getOwnerLanguage: async () => 'en' } });
  await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps: enMedia.deps, message: { id: 'wamid.en.media', type: 'image', image: { id: 'media-1', mime_type: 'image/jpeg' }, caption: 'Ref: 23DEF456' } });
  assert.equal(enMedia.calls.texts.at(-1).text, 'Got it — reading that now.');
});

test('a number bound to clients whose owners read different languages gets English, never a guess', async () => {
  const second = { ...binding, id: 'binding-2', client_id: 'client-2' };
  const { deps, calls } = makeDeps({ bindings: [binding, second], deps: { getOwnerLanguage: async ({ clientId }) => (clientId === 'client-1' ? 'fi' : 'en') } });
  await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.mixed', type: 'text', text: { body: 'kyllä' } } });
  assert.equal(calls.texts[0].text, WHATSAPP_INBOUND_COPY.unanchored);
});

test('an owner-invoice question answered with a photo is refused in the owner language', async () => {
  const ask = { id: 'ask_inv', client_id: 'client-1', evidence_type: 'owner_invoice_command', status: 'open' };
  const { deps, calls } = makeDeps({ openByRef: { 'client-1:AB12CD34': ask }, deps: { getOwnerLanguage: async () => 'fi' } });
  const result = await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: 'wamid.inv.photo', type: 'image', image: { id: 'media-2', mime_type: 'image/jpeg' }, caption: 'Ref: AB12CD34' } });
  assert.equal(result.reason, 'owner_invoice_text_required');
  assert.equal(calls.texts.at(-1).text, 'Vastaa tekstinä ja kerro laskun tiedot, joita kysyin. Tämä laskua koskeva kysymys on yhä auki. Liitteet ja ääniviestit eivät vielä käy vastaukseksi.');
});

test('the FI and GB opening-balance lanes are handed the owner language (English when no Finnish owner)', async () => {
  const seen = [];
  const lane = (language, evidenceType) => makeDeps({
    deliveries: { 'wamid.ob': { ask_id: 'ask-ob', client_id: 'client-1' } },
    asksById: { 'ask-ob': { id: 'ask-ob', client_id: 'client-1', evidence_type: evidenceType, request_payload: { kind: evidenceType } } },
    deps: {
      ...(language ? { getOwnerLanguage: async () => language } : {}),
      openingBalanceFlagActs: async () => true,
      gbOpeningBalanceFlagActs: async () => true,
      getClientEntityType: async () => 'oy',
      resolveOpeningBalanceInbound: async (args) => { seen.push(['fi_lane', args.language]); return { action: 'nudge' }; },
      resolveGbOpeningBalanceInbound: async (args) => { seen.push(['gb_lane', args.language]); return { action: 'nudge' }; }
    }
  });
  let n = 0;
  for (const [language, kind] of [['fi', 'opening_balance'], [null, 'opening_balance'], ['fi', 'gb_opening_balance'], [null, 'gb_opening_balance']]) {
    const { deps } = lane(language, kind);
    n += 1;
    await processWhatsAppInboundMessage({ from: '+447700900123', firmId: 'firm', env: envOn, deps, message: { id: `wamid.ob-${n}`, type: 'text', text: { body: 'luvut' }, context: { id: 'wamid.ob' } } });
  }
  assert.deepEqual(seen, [['fi_lane', 'fi'], ['fi_lane', 'en'], ['gb_lane', 'fi'], ['gb_lane', 'en']]);
});

test('WhatsApp texts sent before a client is known are bilingual; the connected line follows the redeemed client', async () => {
  const { whatsappWebhookText, buildWhatsAppInboundCopy } = await import('./channels/whatsappInbound.js');
  assert.equal(WHATSAPP_INBOUND_COPY.unbound, "Yhdistä WhatsApp ensin Donna-portaalistasi, niin hoidan tämän. / Connect WhatsApp from your Donna portal first, then I'll pick this up.");
  assert.equal(buildWhatsAppInboundCopy({ language: 'fi' }).unbound, WHATSAPP_INBOUND_COPY.unbound);
  assert.equal(whatsappWebhookText('connectFirst'), 'Yhdistä WhatsApp ensin Donna-portaalistasi. / Please connect WhatsApp from your Donna portal first.');
  assert.equal(whatsappWebhookText('connected', 'en'), 'Got it. WhatsApp is connected.');
  assert.equal(whatsappWebhookText('connected', 'fi'), 'Selvä, WhatsApp on nyt yhdistetty.');
  assert.equal(whatsappWebhookText('connected'), 'Selvä, WhatsApp on nyt yhdistetty. / Got it. WhatsApp is connected.');
});
