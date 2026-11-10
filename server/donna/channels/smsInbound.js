import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';

import {
  claimInboundSmsMessageInDb,
  getActiveSmsBindingsByPhoneHashInDb,
  getOpenWhatsAppEvidenceRequestByRefInDb,
  revokeWhatsAppBindingInDb,
  recordMessageDeliveryLedgerInDb,
  resolveClientEvidenceRequestInDb,
  recordEvidenceTopicTurnInDb,
  getClientEntityAxisFromDb,
  getClientOwnerLanguageInDb,
  withFirmDbClient
} from '../firmDb.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { bilingualOwnerText, processAnchoredInboundMessage, resolveInboundOwnerLanguage } from './inboundCore.js';
import { smsEnvAllowsClient, sendSmsText } from './sms.js';
import { resolveAssistantName } from '../assistantIdentity.js';
import { ownerChannelAllowsClient } from './ownerChannelConfig.js';

// D-PA-3 (design-donna-personal-agent.md §5): the assistant's SELF-references
// interpolate the per-client name; "Donna portal" stays — that is the product
// brand, not the assistant. Default build is byte-identical to the pre-rename
// copy. The unbound fast-path has no resolvable client, so it keeps the default.
//
// `language` is the owner's (preferredOwnerTemplateLanguage); anything but 'fi'
// gets the English copy, unchanged. The Finnish help text invites LOPETA, which
// isSmsStop accepts. `unbound` is sent before any client is known for the
// number, so it is bilingual and identical in both (bilingualOwnerText).
const SMS_UNBOUND = bilingualOwnerText(
  'Yhdistä tekstiviestit ensin Donna-portaalistasi, niin hoidan tämän.',
  "Connect SMS from your Donna portal first, then I'll pick this up."
);
export const buildSmsInboundCopy = ({ assistantName, language = 'en' } = {}) => {
  const name = resolveAssistantName({ assistant_name: assistantName });
  if (language === 'fi') {
    return Object.freeze({
      textResolved: 'Selvä, hoidettu.',
      mediaSaved: 'Selvä, tallennettu.',
      topicOpen: 'Selvä, pidän tämän kysymyksen avoimena.',
      unanchored: 'Vastaa suoraan siihen kysymykseen, johon vastaat, tai lisää viestiin sen Ref, niin yhdistän sen oikein.',
      unbound: SMS_UNBOUND,
      voiceDeferred: 'En osaa vielä kuunnella ääniviestejä. Kirjoita vastaus tai lähetä kuva, niin hoidan sen.',
      help: `Täällä ${name}. Tämä numero on nopeita kirjanpitokysymyksiä ja kuitteja varten. Vastaa LOPETA, niin katkaisen yhteyden.`,
      stopped: 'Yhteys katkaistu. En lähetä enää viestejä tähän numeroon, ellet yhdistä uudelleen portaalistasi.'
    });
  }
  return Object.freeze({
    textResolved: "Got it. That's handled.",
    mediaSaved: "Got it, that's saved.",
    topicOpen: "Got it — I’ll keep this question open.",
    unanchored: "Reply right on the question you're answering, or add its Ref and I'll match it.",
    unbound: SMS_UNBOUND,
    voiceDeferred: "I can't do voice notes yet. Type your answer or send a photo and I'll take it.",
    help: `It's ${name}. This line is for quick bookkeeping questions and receipts. Reply STOP to disconnect.`,
    stopped: "You're disconnected. I won't text this number again unless you reconnect from your portal."
  });
};

export const SMS_INBOUND_COPY = buildSmsInboundCopy();
const SMS_INBOUND_COPY_FI = buildSmsInboundCopy({ language: 'fi' });
const smsInboundCopyFor = (language) => (language === 'fi' ? SMS_INBOUND_COPY_FI : SMS_INBOUND_COPY);

// The webhook's confirmation after a binding token is redeemed. The redeemed
// binding names the client, so the owner language picks one line; with no
// client (the redeem failed) there is no owner language and the line is
// bilingual. English is the historical line, unchanged.
const SMS_CONNECTED = Object.freeze({ en: 'Got it. SMS is connected.', fi: 'Selvä, tekstiviestit on nyt yhdistetty.' });
export const smsConnectedText = (language = null) => (language
  ? (language === 'fi' ? SMS_CONNECTED.fi : SMS_CONNECTED.en)
  : bilingualOwnerText(SMS_CONNECTED.fi, SMS_CONNECTED.en));

const sha256Hex = (bytes) => createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')).digest('hex');

export const smsKeyword = (body = '') => String(body || '').trim().toUpperCase();
// LOPETA / APUA are the Finnish keywords the Finnish copy invites.
export const isSmsStop = (body = '') => ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'LOPETA'].includes(smsKeyword(body));
export const isSmsHelp = (body = '') => ['HELP', 'APUA'].includes(smsKeyword(body));

export const downloadTwilioMedia = async ({ mediaUrl, env = process.env, fetchImpl = globalThis.fetch } = {}) => {
  const accountSid = String(env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = String(env.TWILIO_AUTH_TOKEN || '').trim();
  if (!mediaUrl || !accountSid || !authToken || typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('Twilio media download is not configured.'), { code: 'TWILIO_MEDIA_NOT_CONFIGURED', statusCode: 503 });
  }
  const response = await fetchImpl(mediaUrl, { method: 'GET', headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` } });
  if (!response.ok) throw Object.assign(new Error(`Twilio media download failed with ${response.status}.`), { code: 'TWILIO_MEDIA_DOWNLOAD_FAILED', statusCode: response.status });
  const bytes = Buffer.from(await response.arrayBuffer());
  return { bytes, mimeType: response.headers?.get?.('content-type') || 'application/octet-stream', filename: mediaUrl.split('/').pop() || 'sms-media', sha256: sha256Hex(bytes), size: bytes.length };
};

const mediaDescriptor = (message = {}) => {
  const count = Number(message.numMedia || message.NumMedia || 0);
  if (!count) return null;
  const url = message.mediaUrl0 || message.MediaUrl0;
  if (!url) return null;
  const mimeType = message.mediaContentType0 || message.MediaContentType0 || 'application/octet-stream';
  if (mimeType.startsWith('audio/')) return { kind: 'audio', id: url, url, mimeType, filename: `sms-${message.id || message.MessageSid || 'audio'}`, deferred: true, deferredReason: 'voice_deferred', deferredText: SMS_INBOUND_COPY.voiceDeferred };
  const kind = mimeType.startsWith('image/') ? 'image' : 'document';
  return { kind, id: url, url, mimeType, filename: `sms-${message.id || message.MessageSid || 'media'}` };
};

const smsConfig = {
  provider: 'twilio',
  channel: 'sms',
  source: 'sms',
  documentIdPrefix: 'sms_doc',
  actorFallback: 'sms:webhook',
  capabilities: { generalOwnerChat: false, ownerInitiatedMedia: false, persistOwnerThread: true },
  copy: SMS_INBOUND_COPY,
  copyFor: smsInboundCopyFor,
  allowsClient: (clientId, gateContext, env) => ownerChannelAllowsClient({ channel: 'sms', clientId, gateContext, envFallback: smsEnvAllowsClient, env }),
  extractText: (message = {}) => message.body || message.Body || '',
  extractContextId: () => '',
  mediaDescriptor
};

const defaultDeps = (deps = {}) => ({
  loadClientConfigSnapshot: deps.loadClientConfigSnapshot || (({ firmId, clientId }) => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId }))),
  getBindingsByPhoneHash: deps.getBindingsByPhoneHash || getActiveSmsBindingsByPhoneHashInDb,
  getOpenAskByRef: deps.getOpenAskByRef || getOpenWhatsAppEvidenceRequestByRefInDb,
  claimInboundMessage: deps.claimInboundMessage || claimInboundSmsMessageInDb,
  resolveEvidenceRequest: deps.resolveEvidenceRequest || resolveClientEvidenceRequestInDb,
  recordEvidenceTopicTurn: deps.recordEvidenceTopicTurn || recordEvidenceTopicTurnInDb,
  recordLedger: deps.recordLedger || recordMessageDeliveryLedgerInDb,
  sendText: deps.sendText || sendSmsText,
  downloadMedia: deps.downloadMedia || downloadTwilioMedia,
  storeMedia: deps.storeMedia,
  registerEvidenceDocument: deps.registerEvidenceDocument,
  // FI-13 slice 13.2: persisted legal-form reader for the opening-balance intake
  // (Oy equity → Oy accounts). Soft-fails to inboundCore's 'toiminimi' default.
  getClientEntityType: deps.getClientEntityType || getClientEntityAxisFromDb,
  // The owner's language for the acknowledgement copy (inboundCore picks it).
  getOwnerLanguage: deps.getOwnerLanguage || getClientOwnerLanguageInDb,
  fetchImpl: deps.fetchImpl
});


export const handleSmsComplianceCommand = async ({ body = '', from = '', firmId = 'donna-demo-firm', bindings = null, deps = {} } = {}) => {
  const sendText = deps.sendText || sendSmsText;
  const getOwnerLanguage = deps.getOwnerLanguage || getClientOwnerLanguageInDb;
  if (isSmsHelp(body)) {
    const language = await resolveInboundOwnerLanguage({ firmId, bindings: bindings || [], deps: { getOwnerLanguage } });
    await sendText({ to: from, text: smsInboundCopyFor(language).help });
    return { handled: true, action: 'help' };
  }
  if (!isSmsStop(body)) return { handled: false };
  const activeBindings = bindings || await (deps.getBindingsByPhoneHash || getActiveSmsBindingsByPhoneHashInDb)({ phoneHash: deps.phoneHash });
  // Read before revoking: the language follows the clients this number was bound to.
  const language = await resolveInboundOwnerLanguage({ firmId, bindings: activeBindings || [], deps: { getOwnerLanguage } });
  const revokeBinding = deps.revokeBinding || revokeWhatsAppBindingInDb;
  for (const binding of activeBindings || []) {
    await revokeBinding({ firmId: binding.firm_id || firmId, clientId: binding.client_id, bindingId: binding.id, actorId: binding.collaborator_id || 'sms:webhook' }).catch(() => null);
  }
  await sendText({ to: from, text: smsInboundCopyFor(language).stopped });
  return { handled: true, action: 'stop', revoked: (activeBindings || []).length };
};

export const processSmsInboundMessage = ({ message, from, firmId = 'donna-demo-firm', env = process.env, deps = {} } = {}) => {
  const normalizedMessage = { ...message, id: message.id || message.MessageSid || message.SmsSid };
  return processAnchoredInboundMessage({ message: normalizedMessage, from, firmId, env, deps: defaultDeps(deps), config: smsConfig });
};
