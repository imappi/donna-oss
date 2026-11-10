import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import {
  claimInboundTelegramMessageInDb,
  getActiveTelegramBindingsByPhoneHashInDb,
  getTelegramDeliveryByMessageIdInDb,
  getOpenWhatsAppEvidenceRequestByRefInDb,
  revokeWhatsAppBindingInDb,
  recordMessageDeliveryLedgerInDb,
  resolveClientEvidenceRequestInDb,
  recordEvidenceTopicTurnInDb,
  getFinancialReportFromDb,
  getClientEntityAxisFromDb,
  getClientDisplayNameInDb,
  getClientEvidenceRequestByIdInDb,
  getClientOwnerLanguageInDb,
  withFirmDbClient
} from '../firmDb.js';
import { telegramInboundMessageId } from './telegramWebhookCore.js';
import {
  singaporeGstFilingFlagActsInDb,
  getGstReturnByIdInDb,
  getActiveCorpPassMandateInDb,
  markGstReturnFiledInDb,
  cancelGstReturnInDb,
  getSingaporeFilerContextInDb
} from '../statutoryRegistry.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { createIrasSubmitGstF5 } from '../inboundCountryRegistry.js';
import { bilingualOwnerText, processAnchoredInboundMessage, resolveInboundOwnerLanguage } from './inboundCore.js';
import { telegramEnvAllowsClient, sendTelegramText, telegramApiUrl } from './telegram.js';
import { resolveAssistantName } from '../assistantIdentity.js';
import { ownerChannelAllowsClient } from './ownerChannelConfig.js';

// The assistant's SELF-references interpolate the per-client name (D-PA-3);
// "Donna portal" stays — that is the product brand. Default build is
// byte-identical to the pre-rename copy. The unbound fast-path has no
// resolvable client, so it keeps the default.
//
// `language` is the owner's (preferredOwnerTemplateLanguage); anything but 'fi'
// gets the English copy, unchanged. The Finnish copy holds the same voice rule
// (no em or en dashes) and invites LOPETA, which isTelegramStop accepts.
// `unbound` is sent before any client is known for the chat, so it is
// bilingual and identical in both (bilingualOwnerText).
const TELEGRAM_UNBOUND = bilingualOwnerText(
  'Yhdistä Telegram ensin Donna-portaalistasi, niin hoidan tämän.',
  "Connect Telegram from your Donna portal first, then I'll pick this up."
);
const buildTelegramInboundCopyFi = (name) => Object.freeze({
  textResolved: 'Selvä, hoidettu.',
  mediaSaved: 'Selvä. Luen sitä nyt.',
  mediaSavedFor: (clientName) => `Selvä. Tallensin sen yrityksen ${clientName} tietoihin. Luen sitä nyt.`,
  mediaSavedMany: 'Selvä. Luen niitä nyt.',
  mediaSavedForMany: (clientName) => `Selvä. Tallensin ne yrityksen ${clientName} tietoihin. Luen niitä nyt.`,
  mediaFailed: 'En saanut tallennettua sitä kuvaa. Lähetä se uudelleen.',
  topicOpen: 'Selvä. Pidän tämän kysymyksen avoimena.',
  unanchored: 'Vastaa suoraan siihen kysymykseen, johon vastaat (napauta Vastaa), tai lisää viestiin sen Ref, niin yhdistän sen oikein.',
  voiceDeferred: 'En osaa vielä kuunnella ääniviestejä. Kirjoita vastaus tai lähetä kuva, niin hoidan sen.',
  unbound: TELEGRAM_UNBOUND,
  started: `Täällä ${name}. Tämä keskustelu on kuitteja ja nopeita kirjanpitokysymyksiä varten. Kirjoitan sinulle tänne, kun tarvitsen jotain.`,
  help: `Täällä ${name}. Tämä keskustelu on kuitteja ja nopeita kirjanpitokysymyksiä varten. Vastaa LOPETA, niin katkaisen yhteyden.`,
  stopped: 'Yhteys katkaistu. En lähetä enää viestejä tähän keskusteluun, ellet yhdistä uudelleen Donna-portaalistasi. Avoimet kysymykset odottavat portaalissa.'
});

export const buildTelegramInboundCopy = ({ assistantName, language = 'en' } = {}) => {
  const name = resolveAssistantName({ assistant_name: assistantName });
  if (language === 'fi') return buildTelegramInboundCopyFi(name);
  return Object.freeze({
    textResolved: "Got it. That's handled.",
    // A photo parses asynchronously; the "booked to X" follow-up rides the
    // reconcile-confirm surface once it settles.
    // Voice rule (clientPortalChat.js system prompt, held for static copy
    // too per Kari 2026-07-21): never an em or en dash; comma, colon, or a
    // new sentence instead. telegramInbound.test.js pins this for every
    // copy string.
    mediaSaved: "Got it. Reading it now.",
    // The named variant is a RECEIPT: it tells the owner WHICH client the
    // photo was filed under, so a misbound chat (the 2026-07-20 honeybee
    // incident, the link minted against a stale client incarnation) is
    // visible on the first upload instead of after weeks of misfiling.
    mediaSavedFor: (clientName) => `Got it. Saved for ${clientName}. Reading it now.`,
    // Plural variants for a multi-file send (a Telegram album): the group
    // ack fires once for the whole album, so it speaks about "them".
    mediaSavedMany: 'Got it. Reading them now.',
    mediaSavedForMany: (clientName) => `Got it. Saved for ${clientName}. Reading them now.`,
    // The save-failure receipt (F-2, docs/donna-telegram-receipt-silence-
    // diagnostic.md §7): sent when a photo's processing died before the
    // document registered, so the owner knows to re-send instead of assuming
    // it landed. A re-send of an already-saved photo just dedups, so the ask
    // is safe even when it crosses a slow first attempt.
    mediaFailed: 'I could not save that photo. Please send it again.',
    topicOpen: "Got it. I’ll keep this question open.",
    unanchored: "Reply right on the question you're answering (tap Reply), or add its Ref and I'll match it.",
    voiceDeferred: "I can't do voice notes yet. Type your answer or send a photo and I'll take it.",
    unbound: TELEGRAM_UNBOUND,
    started: `It's ${name}. This chat is for receipts and quick bookkeeping questions. I'll message you here when I need one thing.`,
    help: `It's ${name}. This chat is for receipts and quick bookkeeping questions. Reply STOP to disconnect.`,
    stopped: "You're disconnected. I won't message this chat again unless you reconnect from your Donna portal. Open questions remain in the portal."
  });
};

export const TELEGRAM_INBOUND_COPY = buildTelegramInboundCopy();
const TELEGRAM_INBOUND_COPY_FI = buildTelegramInboundCopy({ language: 'fi' });
const telegramInboundCopyFor = (language) => (language === 'fi' ? TELEGRAM_INBOUND_COPY_FI : TELEGRAM_INBOUND_COPY);

// Texts the webhook sends outside the anchored path (api.js). `language` is the
// owner language once a binding names a client (ownerLanguageForBindings); null
// means no client is known, and the text is bilingual, Finnish first. English
// is the historical copy, unchanged.
//   connected:      after a /start <token> binding is redeemed
//   connectInvalid: the /start token did not redeem (expired, used, unknown);
//                   nothing was connected, and no client is known (bilingual)
//   connectFailed:  the redeem failed for another reason; nothing was connected
//   started:        a bare /start: in the owner language when the chat is
//                   already connected to a client, bilingual otherwise
//   mediaFailed:    a photo whose processing threw in the webhook
const TELEGRAM_WEBHOOK_LINES = Object.freeze({
  en: Object.freeze({
    connected: 'Got it. Telegram is connected.',
    connectInvalid: 'Telegram is not connected: that connection link has expired or was already used. Get a new link from your Donna portal.',
    connectFailed: 'Telegram is not connected: something went wrong on my side. Please try again in a moment.'
  }),
  fi: Object.freeze({
    connected: 'Selvä, Telegram on nyt yhdistetty.',
    connectInvalid: 'Telegramia ei yhdistetty: yhdistämislinkki on vanhentunut tai jo käytetty. Hae uusi linkki Donna-portaalistasi.',
    connectFailed: 'Telegramia ei yhdistetty, koska yhdistäminen epäonnistui minun päässäni. Yritä hetken päästä uudelleen.'
  })
});
export const telegramWebhookText = (key, language = null) => {
  const lineFor = (lang) => TELEGRAM_WEBHOOK_LINES[lang][key] ?? telegramInboundCopyFor(lang)[key];
  return language ? lineFor(language === 'fi' ? 'fi' : 'en') : bilingualOwnerText(lineFor('fi'), lineFor('en'));
};

const sha256Hex = (bytes) => createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')).digest('hex');

export const telegramKeyword = (body = '') => String(body || '').trim().toUpperCase();
// Narrower than SMS (no carrier CTIA keywords). STOP/LOPETA disconnect the
// channel; a cancel-flavoured word mid-conversation must cancel a draft, not
// the channel — so it is excluded here, same reasoning as WhatsApp.
export const TELEGRAM_STOP_KEYWORDS = Object.freeze(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'QUIT', 'LOPETA']);
export const TELEGRAM_HELP_KEYWORDS = Object.freeze(['HELP', 'APUA']);
export const isTelegramStop = (body = '') => TELEGRAM_STOP_KEYWORDS.includes(telegramKeyword(body));
export const isTelegramHelp = (body = '') => TELEGRAM_HELP_KEYWORDS.includes(telegramKeyword(body));

// Telegram media download is a two-hop: getFile(file_id) → result.file_path,
// then GET the file host with the token. Mirrors downloadWhatsAppMedia /
// downloadTwilioMedia (bytes + mime + checksum shape for storeInboundMediaAsEvidence).
export const downloadTelegramMedia = async ({ mediaId, env = process.env, fetchImpl = globalThis.fetch, descriptor = null } = {}) => {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '').trim();
  if (!mediaId || !botToken || typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('Telegram media download is not configured.'), { code: 'TELEGRAM_MEDIA_NOT_CONFIGURED', statusCode: 503 });
  }
  const metaResponse = await fetchImpl(`${telegramApiUrl({ botToken, method: 'getFile' })}?file_id=${encodeURIComponent(mediaId)}`, { method: 'GET' });
  const meta = await metaResponse.json().catch(() => ({}));
  const filePath = meta?.result?.file_path;
  if (!metaResponse.ok || meta?.ok === false || !filePath) {
    throw Object.assign(new Error(meta?.description || `Telegram getFile failed with ${metaResponse.status}.`), { code: 'TELEGRAM_MEDIA_METADATA_FAILED', statusCode: metaResponse.status });
  }
  const bytesResponse = await fetchImpl(`https://api.telegram.org/file/bot${botToken}/${filePath}`, { method: 'GET' });
  if (!bytesResponse.ok) {
    throw Object.assign(new Error(`Telegram media download failed with ${bytesResponse.status}.`), { code: 'TELEGRAM_MEDIA_DOWNLOAD_FAILED', statusCode: bytesResponse.status });
  }
  const bytes = Buffer.from(await bytesResponse.arrayBuffer());
  const filename = String(filePath).split('/').pop() || `telegram-${mediaId}`;
  // Telegram's file CDN serves photos as application/octet-stream regardless of
  // content, and the evidence bucket's MIME allowlist refuses that generic type
  // with 415 — the silent-photo bug (docs/donna-telegram-receipt-silence-
  // diagnostic.md §7, 2026-07-20). The descriptor already names the real type
  // (photo ⇒ image/jpeg, document ⇒ the sender-declared mime), so the generic
  // header must never shadow it: trust the header only when it is specific.
  const headerMime = (bytesResponse.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
  const mimeType = headerMime && headerMime !== 'application/octet-stream'
    ? headerMime
    : (descriptor?.mimeType || headerMime || 'application/octet-stream');
  return { bytes, mimeType, filename, sha256: sha256Hex(bytes), size: bytes.length };
};

const mediaDescriptor = (message = {}) => {
  // A photo arrives as an array of sizes (ascending); the last is the largest.
  if (Array.isArray(message.photo) && message.photo.length) {
    const largest = message.photo[message.photo.length - 1];
    if (largest?.file_id) return { kind: 'image', id: largest.file_id, mimeType: 'image/jpeg', filename: `telegram-${message.message_id || 'image'}.jpg` };
  }
  if (message.document?.file_id) {
    return { kind: 'document', id: message.document.file_id, mimeType: message.document.mime_type || 'application/octet-stream', filename: message.document.file_name || `telegram-${message.message_id || 'document'}` };
  }
  if (message.voice?.file_id || message.audio?.file_id) {
    const id = message.voice?.file_id || message.audio?.file_id;
    return { kind: 'audio', id, mimeType: message.voice?.mime_type || message.audio?.mime_type || 'audio/ogg', filename: `telegram-${message.message_id || 'audio'}.ogg`, deferred: true, deferredReason: 'voice_deferred', deferredText: TELEGRAM_INBOUND_COPY.voiceDeferred };
  }
  return null;
};

const telegramConfig = {
  provider: 'telegram',
  channel: 'telegram',
  source: 'telegram',
  documentIdPrefix: 'tg_doc',
  actorFallback: 'telegram:webhook',
  capabilities: { generalOwnerChat: true, ownerInitiatedMedia: true, persistOwnerThread: true },
  copy: TELEGRAM_INBOUND_COPY,
  copyFor: telegramInboundCopyFor,
  allowsClient: (clientId, gateContext, env) => ownerChannelAllowsClient({ channel: 'telegram', clientId, gateContext, envFallback: telegramEnvAllowsClient, env }),
  extractText: (message = {}) => message.text || message.caption || '',
  // A tapped reply carries reply_to_message; its message_id is the outbound ask
  // message_id we recorded in the delivery ledger, so it anchors like WhatsApp's
  // context.id. A plain typed reply has no context → falls through to Ref match.
  extractContextId: (message = {}) => (message.reply_to_message?.message_id != null ? String(message.reply_to_message.message_id) : ''),
  mediaDescriptor
};

const defaultDeps = (deps = {}) => ({
  loadClientConfigSnapshot: deps.loadClientConfigSnapshot || (({ firmId, clientId }) => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId }))),
  getBindingsByPhoneHash: deps.getBindingsByPhoneHash || getActiveTelegramBindingsByPhoneHashInDb,
  getDeliveryByMessageId: deps.getDeliveryByMessageId || getTelegramDeliveryByMessageIdInDb,
  getOpenAskByRef: deps.getOpenAskByRef || getOpenWhatsAppEvidenceRequestByRefInDb,
  getAskById: deps.getAskById || getClientEvidenceRequestByIdInDb,
  claimInboundMessage: deps.claimInboundMessage || claimInboundTelegramMessageInDb,
  getClientDisplayName: deps.getClientDisplayName || getClientDisplayNameInDb,
  // The owner's language for the acknowledgement copy (inboundCore picks it).
  getOwnerLanguage: deps.getOwnerLanguage || getClientOwnerLanguageInDb,
  resolveEvidenceRequest: deps.resolveEvidenceRequest || resolveClientEvidenceRequestInDb,
  recordEvidenceTopicTurn: deps.recordEvidenceTopicTurn || recordEvidenceTopicTurnInDb,
  appendClientPortalChatMessage: deps.appendClientPortalChatMessage,
  assembleClientPortalTurn: deps.assembleClientPortalTurn,
  generateClientPortalChatReply: deps.generateClientPortalChatReply,
  generateClientPortalReportNarration: deps.generateClientPortalReportNarration,
  callClientPortalChatModel: deps.callClientPortalChatModel,
  callClientPortalReportNarrationModel: deps.callClientPortalReportNarrationModel,
  getFinancialReport: deps.getFinancialReport || getFinancialReportFromDb,
  recordLedger: deps.recordLedger || recordMessageDeliveryLedgerInDb,
  sendText: deps.sendText || sendTelegramText,
  downloadMedia: deps.downloadMedia || downloadTelegramMedia,
  storeMedia: deps.storeMedia,
  registerEvidenceDocument: deps.registerEvidenceDocument,
  registerOwnerInitiatedDocument: deps.registerOwnerInitiatedDocument,
  recordOwnerMileageExpense: deps.recordOwnerMileageExpense,
  // Operational self-knowledge / share_portal_link seams (selfKnowledge.js) —
  // inboundCore falls back to the real resolvers when these are absent.
  resolveOwnerPortalLink: deps.resolveOwnerPortalLink,
  recordOwnerPortalLinkShare: deps.recordOwnerPortalLinkShare,
  // Persisted legal-form reader for the opening-balance intake — soft-fails to
  // inboundCore's 'toiminimi' default (byte-identical when unset/unreadable).
  getClientEntityType: deps.getClientEntityType || getClientEntityAxisFromDb,
  // SG-3 slice P — the GST F5 filing confirm lane (Telegram is the SG-first
  // channel). The default channel is the IRAS adapter, whose DEFAULT transport
  // refuses (typed, retryable) until F-SG-2 confirms the wire protocol — the
  // row stays pending, the ask stays open, never a false filing receipt. The
  // CorpPass lookup is the fail-closed legal-authorization gate.
  gstFilingFlagActs: deps.gstFilingFlagActs || singaporeGstFilingFlagActsInDb,
  getGstReturn: deps.getGstReturn || getGstReturnByIdInDb,
  getCorpPassMandate: deps.getCorpPassMandate || getActiveCorpPassMandateInDb,
  markGstReturnFiled: deps.markGstReturnFiled || markGstReturnFiledInDb,
  cancelGstReturn: deps.cancelGstReturn || cancelGstReturnInDb,
  submitGstF5: deps.submitGstF5 || createIrasSubmitGstF5({
    resolveFiler: ({ firmId, clientId }) => getSingaporeFilerContextInDb({ firmId, clientId })
  }),
  resolveGstReturnAsk: deps.resolveGstReturnAsk
    || (({ firmId, askId, resolutionNote, actorId }) => resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: askId, resolutionNote, actorId, actorType: 'client' })),
  fetchImpl: deps.fetchImpl
});

export const handleTelegramComplianceCommand = async ({ body = '', from = '', firmId = 'donna-demo-firm', bindings = null, deps = {} } = {}) => {
  const sendText = deps.sendText || sendTelegramText;
  const getOwnerLanguage = deps.getOwnerLanguage || getClientOwnerLanguageInDb;
  if (isTelegramHelp(body)) {
    const language = await resolveInboundOwnerLanguage({ firmId, bindings: bindings || [], deps: { getOwnerLanguage } });
    await sendText({ to: from, text: telegramInboundCopyFor(language).help });
    return { handled: true, action: 'help' };
  }
  if (!isTelegramStop(body)) return { handled: false };
  const activeBindings = bindings || await (deps.getBindingsByPhoneHash || getActiveTelegramBindingsByPhoneHashInDb)({ phoneHash: deps.phoneHash });
  // Read before revoking: the language follows the clients this chat was bound to.
  const language = await resolveInboundOwnerLanguage({ firmId, bindings: activeBindings || [], deps: { getOwnerLanguage } });
  const revokeBinding = deps.revokeBinding || revokeWhatsAppBindingInDb;
  for (const binding of activeBindings || []) {
    await revokeBinding({ firmId: binding.firm_id || firmId, clientId: binding.client_id, bindingId: binding.id, actorId: binding.collaborator_id || 'telegram:webhook' }).catch(() => null);
  }
  await sendText({ to: from, text: telegramInboundCopyFor(language).stopped });
  return { handled: true, action: 'stop', revoked: (activeBindings || []).length };
};

export const processTelegramInboundMessage = ({ message, from, firmId = 'donna-demo-firm', env = process.env, deps = {} } = {}) => {
  // The reconcile core keys idempotency off message.id; Telegram's is message_id.
  const normalizedMessage = { ...message, id: message.id || telegramInboundMessageId({ chatId: message.chat?.id, messageId: message.message_id }) };
  return processAnchoredInboundMessage({ message: normalizedMessage, from, firmId, env, deps: defaultDeps(deps), config: telegramConfig });
};
