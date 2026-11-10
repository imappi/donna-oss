import { finlandInvoiceIssuanceEntryActsInDb, finlandEInvoiceReceiveEntryActsInDb } from '../issuanceRegistry.js';
import { Buffer } from 'node:buffer';

import {
  claimInboundWhatsAppMessageInDb,
  getActiveWhatsAppBindingsByPhoneHashInDb,
  getOpenWhatsAppEvidenceRequestByRefInDb,
  getWhatsAppDeliveryByMessageIdInDb,
  recordMessageDeliveryLedgerInDb,
  revokeWhatsAppBindingInDb,
  resolveClientEvidenceRequestInDb,
  recordEvidenceTopicTurnInDb,
  createOpeningBalanceEvidenceRequestInDb,
  getClientEvidenceRequestByIdInDb,
  getClientEntityAxisFromDb,
  getClientOwnerLanguageInDb,
  openingBalanceWhatsAppFlagActsInDb,
  gbOpeningBalanceFlagActsInDb,
  createGbOpeningBalanceEvidenceRequestInDb,
  postGbOpeningBalanceJournalFromDb,
  finlandInvoicingWhatsAppFlagActsInDb,
  finlandAlvInvoicingWhatsAppFlagActsInDb,
  finlandEInvoiceReceiveWhatsAppFlagActsInDb,
  createInvoiceIssuanceEvidenceRequestInDb,
  createIssuedInvoiceDraftInDb,
  supersedeIssuedInvoiceDraftInDb,
  cancelIssuedInvoiceInDb,
  markIssuedInvoiceIssuedInDb,
  getIssuedInvoiceByIdInDb,
  getIssuedInvoiceCreditContextInDb,
  finlandQuotesWhatsAppFlagActsInDb,
  createIssuedQuoteDraftInDb,
  supersedeIssuedQuoteDraftInDb,
  cancelIssuedQuoteInDb,
  markIssuedQuoteSentInDb,
  declineIssuedQuoteInDb,
  getIssuedQuoteByIdInDb,
  getIssuedQuoteContextInDb,
  getInvoiceSellerContextInDb,
  runOwnerInvoiceCommandInDb,
  persistFinlandSellerIdentityInDb,
  postSalesInvoiceJournalFromDb,
  postCreditNoteJournalFromDb,
  withFirmDbClient
} from '../firmDb.js';
import {
  finlandAlvFilingWhatsAppFlagActsInDb,
  getAlvReturnByIdInDb,
  getActiveSuomifiMandateInDb,
  markAlvReturnFiledInDb,
  cancelAlvReturnInDb,
  singaporeGstFilingFlagActsInDb,
  getGstReturnByIdInDb,
  getActiveCorpPassMandateInDb,
  markGstReturnFiledInDb,
  cancelGstReturnInDb,
  getSingaporeFilerContextInDb
} from '../statutoryRegistry.js';
import { readClientConfigSnapshot } from '../clientConfig.js';
import { sendEmail as sendTransactionalEmail } from '../email/resendClient.js';
import { createIlmoitinSubmitAlvReturn } from '../inboundCountryRegistry.js';
import { createIrasSubmitGstF5 } from '../inboundCountryRegistry.js';
import { whatsappEnvAllowsClient } from './whatsappWebhookCore.js';
import { sendWhatsAppText } from './whatsapp.js';
import { processAnchoredInboundMessage, resolveInboundAnchor, storeInboundMediaAsEvidence } from './inboundCore.js';
import { resolveAssistantName } from '../assistantIdentity.js';
import { ownerChannelAllowsClient } from './ownerChannelConfig.js';

// D-PA-3 (design-donna-personal-agent.md §5): the assistant's SELF-references
// interpolate the per-client name; "Donna portal" / "Donna-portaalista" stay —
// that is the product brand, not the assistant. Default build is byte-identical
// to the pre-rename copy. The unbound fast-path has no resolvable client, so it
// keeps the default.
//
// `language` is the owner's (preferredOwnerTemplateLanguage); anything but 'fi'
// gets the English copy, unchanged. help/stopped are bilingual already and stay
// identical in both (they run before any client is resolved for the number).
export const buildWhatsAppInboundCopy = ({ assistantName, language = 'en' } = {}) => {
  const name = resolveAssistantName({ assistant_name: assistantName });
  const help = `Tämä on ${name} — kuittikuvat ja kirjanpitokysymykset tähän numeroon. Vastaa LOPETA, niin katkaisen yhteyden. / It's ${name}. This number is for receipts and quick bookkeeping questions. Reply LOPETA or STOP to disconnect.`;
  const stopped = "Yhteys katkaistu. En lähetä enää viestejä tähän numeroon, ellet yhdistä uudelleen Donna-portaalista. Avoimet kysymykset odottavat portaalissa. / You're disconnected. I won't message this number again unless you reconnect from your Donna portal. Open questions remain in the portal.";
  if (language === 'fi') {
    return Object.freeze({
      textResolved: 'Selvä, hoidettu.',
      mediaSaved: 'Selvä, luen sitä nyt.',
      topicOpen: 'Selvä, pidän tämän kysymyksen avoimena.',
      unanchored: 'Vastaa suoraan siihen kysymykseen, johon vastaat, tai lisää viestiin sen Ref, niin yhdistän sen oikein.',
      voiceDeferred: 'En osaa vielä kuunnella ääniviestejä. Kirjoita vastaus tai lähetä kuva, niin hoidan sen.',
      unbound: 'Yhdistä WhatsApp ensin Donna-portaalistasi, niin hoidan tämän.',
      einvoiceReceived: 'Sain verkkolaskun. Luen sen ja kirjaan sen ostolaskuksi.',
      ownerInvoiceCommandDrafted: 'Tein laskusta luonnoksen. Se odottaa hyväksyntääsi, ennen kuin se lähtee.',
      help,
      stopped
    });
  }
  return Object.freeze({
    textResolved: "Got it. That's handled.",
    // Forward-looking: a photo parses asynchronously, then (when it reconciles)
    // the owner gets the "booked to X" follow-up from evidenceReplyConfirm.js.
    mediaSaved: "Got it — reading that now.",
    topicOpen: "Got it — I’ll keep this question open.",
    unanchored: "Reply right on the question you're answering, or add its Ref and I'll match it.",
    voiceDeferred: "I can't do voice notes yet. Type your answer or send a photo and I'll take it.",
    unbound: "Connect WhatsApp from your Donna portal first, then I'll pick this up.",
    einvoiceReceived: "Got the e-invoice — I'm reading it and will book it as a supplier bill.",
    // Kernel-audit M2 — the owner-invoice command drafted. Deliberately says
    // DRAFTED and not SENT: every third-party send holds for the owner's
    // approval at canary, so telling them it went out would be a lie about the
    // state of their own book.
    ownerInvoiceCommandDrafted: "Drafted that invoice — it's waiting for your approval before it goes out.",
    // G-9 (D-G9-7) — the compliance lane, bilingual Finnish-first: the WhatsApp
    // number is the Finnish delivery surface (§1A) but bindings are not
    // Finland-only.
    help,
    stopped
  });
};

export const WHATSAPP_INBOUND_COPY = buildWhatsAppInboundCopy();
const WHATSAPP_INBOUND_COPY_FI = buildWhatsAppInboundCopy({ language: 'fi' });
const whatsappInboundCopyFor = (language) => (language === 'fi' ? WHATSAPP_INBOUND_COPY_FI : WHATSAPP_INBOUND_COPY);

// G-9 (D-G9-6) — the opt-out keyword set. Exact whole-message match only
// ("lopeta laskutus" is an instruction, not an opt-out). Deliberately NARROWER
// than the SMS set: CANCEL/END are CTIA carrier keywords with no WhatsApp
// mandate, and the Finland lane is confirm-first ("Vahvista vastaamalla
// 'kyllä'. Peru vastaamalla 'ei'…") — a cancel-flavored word mid-confirmation
// must cancel the DRAFT, never the channel. PERU/EI are excluded for the same
// collision reason.
export const WHATSAPP_STOP_KEYWORDS = Object.freeze(['STOP', 'STOPALL', 'UNSUBSCRIBE', 'QUIT', 'LOPETA']);
export const WHATSAPP_HELP_KEYWORDS = Object.freeze(['HELP', 'APUA']);

export const whatsappKeyword = (body = '') => String(body || '').trim().toUpperCase();
export const isWhatsAppStop = (body = '') => WHATSAPP_STOP_KEYWORDS.includes(whatsappKeyword(body));
export const isWhatsAppHelp = (body = '') => WHATSAPP_HELP_KEYWORDS.includes(whatsappKeyword(body));

// G-9 (D-G9-5) — the SMS compliance lane's WhatsApp mirror
// (handleSmsComplianceCommand in smsInbound.js). Runs BEFORE anchored
// processing; STOP revokes every active binding for the phone through the
// already-audited revoker ('whatsapp.binding.revoked'). Opt-out closes the
// CHANNEL only: evidence already received stays under KPL 2:10 retention and
// open asks stay on the owner, reachable via the portal (D-G9-8).
export const handleWhatsAppComplianceCommand = async ({ body = '', from = '', firmId = 'donna-demo-firm', bindings = null, deps = {} } = {}) => {
  const sendText = deps.sendText || sendWhatsAppText;
  if (isWhatsAppHelp(body)) {
    await sendText({ to: from, text: WHATSAPP_INBOUND_COPY.help });
    return { handled: true, action: 'help' };
  }
  if (!isWhatsAppStop(body)) return { handled: false };
  const activeBindings = bindings || await (deps.getBindingsByPhoneHash || getActiveWhatsAppBindingsByPhoneHashInDb)({ phoneHash: deps.phoneHash });
  const revokeBinding = deps.revokeBinding || revokeWhatsAppBindingInDb;
  for (const binding of activeBindings || []) {
    await revokeBinding({ firmId: binding.firm_id || firmId, clientId: binding.client_id, bindingId: binding.id, actorId: binding.collaborator_id || 'whatsapp:webhook' }).catch(() => null);
  }
  await sendText({ to: from, text: WHATSAPP_INBOUND_COPY.stopped });
  return { handled: true, action: 'stop', revoked: (activeBindings || []).length };
};

const graphVersion = (env = process.env) => String(env.WHATSAPP_GRAPH_API_VERSION || 'v20.0').replace(/^\/+/, '');

const mediaDescriptor = (message = {}) => {
  const type = String(message.type || '').trim();
  if (type === 'image' && message.image?.id) return { kind: 'image', id: message.image.id, mimeType: message.image.mime_type || 'image/jpeg', filename: `whatsapp-${message.id || 'image'}.jpg` };
  if (type === 'document' && message.document?.id) return { kind: 'document', id: message.document.id, mimeType: message.document.mime_type || 'application/pdf', filename: message.document.filename || `whatsapp-${message.id || 'document'}` };
  if (type === 'audio' && message.audio?.id) return { kind: 'audio', id: message.audio.id, mimeType: message.audio.mime_type || 'audio/ogg', filename: `whatsapp-${message.id || 'audio'}.ogg`, deferred: true, deferredReason: 'voice_deferred', deferredText: WHATSAPP_INBOUND_COPY.voiceDeferred };
  return null;
};

export const downloadWhatsAppMedia = async ({ mediaId, env = process.env, fetchImpl = globalThis.fetch } = {}) => {
  const accessToken = String(env.WHATSAPP_ACCESS_TOKEN || '').trim();
  if (!mediaId || !accessToken || typeof fetchImpl !== 'function') {
    const error = new Error('WhatsApp media download is not configured.');
    error.code = 'WHATSAPP_MEDIA_NOT_CONFIGURED';
    error.statusCode = 503;
    throw error;
  }
  const metaResponse = await fetchImpl(`https://graph.facebook.com/${graphVersion(env)}/${encodeURIComponent(mediaId)}`, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
  const meta = await metaResponse.json().catch(() => ({}));
  if (!metaResponse.ok || !meta?.url) {
    const error = new Error(meta?.error?.message || `WhatsApp media metadata failed with ${metaResponse.status}.`);
    error.code = 'WHATSAPP_MEDIA_METADATA_FAILED';
    error.statusCode = metaResponse.status;
    throw error;
  }
  const bytesResponse = await fetchImpl(meta.url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } });
  if (!bytesResponse.ok) {
    const error = new Error(`WhatsApp media download failed with ${bytesResponse.status}.`);
    error.code = 'WHATSAPP_MEDIA_DOWNLOAD_FAILED';
    error.statusCode = bytesResponse.status;
    throw error;
  }
  const bytes = Buffer.from(await bytesResponse.arrayBuffer());
  return { bytes, mimeType: meta.mime_type || bytesResponse.headers?.get?.('content-type') || 'application/octet-stream', filename: meta.filename || null, sha256: meta.sha256 || undefined, size: Number(meta.file_size || bytes.length) };
};

export const storeWhatsAppMediaAsEvidence = (args = {}) => storeInboundMediaAsEvidence({ ...args, source: 'whatsapp' });

const whatsappConfig = {
  provider: 'meta',
  channel: 'whatsapp',
  source: 'whatsapp',
  documentIdPrefix: 'wa_doc',
  actorFallback: 'whatsapp:webhook',
  capabilities: { generalOwnerChat: true, ownerInitiatedMedia: true, persistOwnerThread: true },
  copy: WHATSAPP_INBOUND_COPY,
  copyFor: whatsappInboundCopyFor,
  allowsClient: (clientId, gateContext, env) => ownerChannelAllowsClient({ channel: 'whatsapp', clientId, gateContext, envFallback: whatsappEnvAllowsClient, env }),
  extractText: (message = {}) => message.text?.body || message.caption || '',
  extractContextId: (message = {}) => String(message.context?.id || '').trim(),
  mediaDescriptor
};

const defaultDeps = (deps = {}) => ({
  loadClientConfigSnapshot: deps.loadClientConfigSnapshot || (({ firmId, clientId }) => withFirmDbClient((client) => readClientConfigSnapshot(client, { firmId, clientId }))),
  getBindingsByPhoneHash: deps.getBindingsByPhoneHash || getActiveWhatsAppBindingsByPhoneHashInDb,
  getDeliveryByMessageId: deps.getDeliveryByMessageId || getWhatsAppDeliveryByMessageIdInDb,
  getOpenAskByRef: deps.getOpenAskByRef || getOpenWhatsAppEvidenceRequestByRefInDb,
  claimInboundMessage: deps.claimInboundMessage || claimInboundWhatsAppMessageInDb,
  resolveEvidenceRequest: deps.resolveEvidenceRequest || resolveClientEvidenceRequestInDb,
  recordEvidenceTopicTurn: deps.recordEvidenceTopicTurn || recordEvidenceTopicTurnInDb,
  appendClientPortalChatMessage: deps.appendClientPortalChatMessage,
  assembleClientPortalTurn: deps.assembleClientPortalTurn,
  generateClientPortalChatReply: deps.generateClientPortalChatReply,
  callClientPortalChatModel: deps.callClientPortalChatModel,
  // Context-id anchors carry only ask_id; the specialized dispatch (opening
  // balance, invoice issuance) needs the ask ROW to key off evidence_type —
  // without this default those replies would fall through to the generic path.
  getAskById: deps.getAskById || getClientEvidenceRequestByIdInDb,
  // FI-13 slice 13.2: the persisted legal-form reader for the opening-balance
  // intake — an Oy switcher's equity must map to the Oy accounts, not the
  // toiminimi private account. Soft-fails to null ⇒ inboundCore's 'toiminimi'
  // default (byte-identical for a client whose form is unset/unreadable).
  getClientEntityType: deps.getClientEntityType || getClientEntityAxisFromDb,
  // The owner's language for the acknowledgement copy (inboundCore picks it).
  getOwnerLanguage: deps.getOwnerLanguage || getClientOwnerLanguageInDb,
  resolveOpeningBalanceInbound: deps.resolveOpeningBalanceInbound,
  resolveGbOpeningBalanceInbound: deps.resolveGbOpeningBalanceInbound,
  createOpeningBalanceAsk: deps.createOpeningBalanceAsk || createOpeningBalanceEvidenceRequestInDb,
  createGbOpeningBalanceAsk: deps.createGbOpeningBalanceAsk || createGbOpeningBalanceEvidenceRequestInDb,
  // Resolve the answered opening_balance ask on each transition (two-terminal-states):
  // maps the route's closeAnsweredAsk call onto the existing evidence-request closer so
  // exactly one opening_balance ask is ever open per client.
  resolveOpeningBalanceAsk: deps.resolveOpeningBalanceAsk
    || (({ firmId, askId, resolutionNote, actorId }) => resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: askId, resolutionNote, actorId, actorType: 'client' })),
  confirmOpeningBalanceIntake: deps.confirmOpeningBalanceIntake,
  runTrialBalanceIntake: deps.runTrialBalanceIntake,
  classifyOpeningIntake: deps.classifyOpeningIntake,
  postOpeningBalanceJournal: deps.postOpeningBalanceJournal,
  postGbOpeningBalanceJournal: deps.postGbOpeningBalanceJournal || postGbOpeningBalanceJournalFromDb,
  getDocumentText: deps.getDocumentText,
  openingBalanceFlagActs: deps.openingBalanceFlagActs || openingBalanceWhatsAppFlagActsInDb,
  gbOpeningBalanceFlagActs: deps.gbOpeningBalanceFlagActs || gbOpeningBalanceFlagActsInDb,
  // FI-10 issuance UX (design: docs/design-donna-finland-fi10-issuance-ux.md).
  // The transmit email must NOT soft-degrade: a failed/skipped Resend send throws,
  // so the issue motion fails honestly (the confirm ask stays open, the owner is
  // told, the next "kyllä" retries) instead of minting a false transmit receipt.
  invoiceIssuanceEntryActs: deps.invoiceIssuanceEntryActs || deps.invoiceIssuanceFlagActs || finlandInvoiceIssuanceEntryActsInDb,
  einvoiceReceiveEntryActs: deps.einvoiceReceiveEntryActs || deps.einvoiceReceiveFlagActs || finlandEInvoiceReceiveEntryActsInDb,
  invoiceIssuanceFlagActs: deps.invoiceIssuanceFlagActs || finlandInvoicingWhatsAppFlagActsInDb,
  // FI-13 13.4 — the ALV side of issuance: the flag alone never adds VAT (the
  // route also requires an effective alv_registration on the invoice date).
  alvInvoicingFlagActs: deps.alvInvoicingFlagActs || finlandAlvInvoicingWhatsAppFlagActsInDb,
  // FI-9 (R) — gates the unanchored-media e-invoice receive hook.
  einvoiceReceiveFlagActs: deps.einvoiceReceiveFlagActs || finlandEInvoiceReceiveWhatsAppFlagActsInDb,
  createInvoiceIssuanceAsk: deps.createInvoiceIssuanceAsk || createInvoiceIssuanceEvidenceRequestInDb,
  resolveInvoiceIssuanceAsk: deps.resolveInvoiceIssuanceAsk
    || (({ firmId, askId, resolutionNote, actorId }) => resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: askId, resolutionNote, actorId, actorType: 'client' })),
  createIssuedInvoiceDraft: deps.createIssuedInvoiceDraft || createIssuedInvoiceDraftInDb,
  supersedeIssuedInvoiceDraft: deps.supersedeIssuedInvoiceDraft || supersedeIssuedInvoiceDraftInDb,
  cancelIssuedInvoice: deps.cancelIssuedInvoice || cancelIssuedInvoiceInDb,
  markIssuedInvoiceIssued: deps.markIssuedInvoiceIssued || markIssuedInvoiceIssuedInDb,
  getIssuedInvoice: deps.getIssuedInvoice || getIssuedInvoiceByIdInDb,
  getInvoiceSellerContext: deps.getInvoiceSellerContext || getInvoiceSellerContextInDb,
  // Kernel-audit M2 — the jurisdiction-neutral owner-invoice turn entry. Behind
  // OWNER_INVOICE_COMMAND, born off on the config plane, and refused outright
  // for any client the Finnish lane above serves (the G12 collision guard).
  runOwnerInvoiceCommand: deps.runOwnerInvoiceCommand || runOwnerInvoiceCommandInDb,
  // F-U1 — persist owner-supplied Y-tunnus / IBAN back to the profile on issue.
  persistFinlandSellerIdentity: deps.persistFinlandSellerIdentity || persistFinlandSellerIdentityInDb,
  postSalesInvoiceJournal: deps.postSalesInvoiceJournal || postSalesInvoiceJournalFromDb,
  // G-8 — the credit-note (hyvityslasku) lanes: the AR-reversal writer and the
  // original-invoice lookup the intake needs for "hyvitä lasku 2026001".
  postCreditNoteJournal: deps.postCreditNoteJournal || postCreditNoteJournalFromDb,
  getIssuedInvoiceCreditContext: deps.getIssuedInvoiceCreditContext || getIssuedInvoiceCreditContextInDb,
  // C-1 — the quote (tarjous) lanes (design:
  // docs/design-donna-finland-c1-quote-send.md): its own dark FINLAND_QUOTES
  // gate, its own store writers on its own numbering series; no post leg
  // exists (a tarjous books nothing).
  quoteIssuanceFlagActs: deps.quoteIssuanceFlagActs || finlandQuotesWhatsAppFlagActsInDb,
  createIssuedQuoteDraft: deps.createIssuedQuoteDraft || createIssuedQuoteDraftInDb,
  supersedeIssuedQuoteDraft: deps.supersedeIssuedQuoteDraft || supersedeIssuedQuoteDraftInDb,
  cancelIssuedQuote: deps.cancelIssuedQuote || cancelIssuedQuoteInDb,
  markIssuedQuoteSent: deps.markIssuedQuoteSent || markIssuedQuoteSentInDb,
  declineIssuedQuote: deps.declineIssuedQuote || declineIssuedQuoteInDb,
  getIssuedQuote: deps.getIssuedQuote || getIssuedQuoteByIdInDb,
  getIssuedQuoteContext: deps.getIssuedQuoteContext || getIssuedQuoteContextInDb,
  transmitFinvoice: deps.transmitFinvoice,
  transmitInvoicePdf: deps.transmitInvoicePdf,
  // FI-3 slice P — the ALV filing confirm lane (design:
  // docs/design-donna-finland-fi3-alv-return.md). The default channel is FI-8's
  // Ilmoitin/ApitamoPKI adapter (docs/design-donna-finland-fi8-omavero-adapter.md):
  // it renders + validates the VSRALVKV record, but its DEFAULT transport
  // refuses (typed, retryable) until F-FI8-R1 confirms the wire protocol — the
  // row stays pending, the ask stays open, never a false filing receipt.
  alvFilingFlagActs: deps.alvFilingFlagActs || finlandAlvFilingWhatsAppFlagActsInDb,
  getAlvReturn: deps.getAlvReturn || getAlvReturnByIdInDb,
  // G-3: the Suomi.fi mandate (veroasioiden hoito) the transmit gate requires —
  // no valid recorded mandate, no filing (ALV_FILING_MANDATE_REQUIRED).
  getSuomifiMandate: deps.getSuomifiMandate || getActiveSuomifiMandateInDb,
  markAlvReturnFiled: deps.markAlvReturnFiled || markAlvReturnFiledInDb,
  cancelAlvReturn: deps.cancelAlvReturn || cancelAlvReturnInDb,
  submitAlvReturn: deps.submitAlvReturn || createIlmoitinSubmitAlvReturn({
    resolveFiler: ({ firmId, clientId }) => getInvoiceSellerContextInDb({ firmId, clientId })
  }),
  resolveAlvReturnAsk: deps.resolveAlvReturnAsk
    || (({ firmId, askId, resolutionNote, actorId }) => resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: askId, resolutionNote, actorId, actorType: 'client' })),
  // SG-3 slice P — the GST F5 filing confirm lane (the ALV lane's SG twin).
  // Same fail-closed posture: the IRAS adapter's default transport refuses
  // typed until F-SG-2 confirms the wire protocol; the CorpPass lookup is the
  // legal-authorization gate.
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
  sendInvoiceEmail: deps.sendInvoiceEmail || (async ({ to, subject, text, attachments }) => {
    const result = await sendTransactionalEmail({ to, subject, text, attachments });
    if (!result?.ok) {
      const error = new Error(result?.error || result?.reason || 'Invoice email send failed.');
      error.code = 'INVOICE_EMAIL_SEND_FAILED';
      throw error;
    }
    return result;
  }),
  recordLedger: deps.recordLedger || recordMessageDeliveryLedgerInDb,
  sendText: deps.sendText || sendWhatsAppText,
  downloadMedia: deps.downloadMedia || downloadWhatsAppMedia,
  storeMedia: deps.storeMedia || storeWhatsAppMediaAsEvidence,
  registerEvidenceDocument: deps.registerEvidenceDocument,
  fetchImpl: deps.fetchImpl
});

export const resolveWhatsAppInboundAnchor = (args = {}) => resolveInboundAnchor({ ...args, deps: defaultDeps(args.deps), config: whatsappConfig });

export const processWhatsAppInboundMessage = ({ message, from, firmId = 'donna-demo-firm', env = process.env, deps = {} } = {}) =>
  processAnchoredInboundMessage({ message, from, firmId, env, deps: defaultDeps(deps), config: whatsappConfig });
