import { Buffer } from 'node:buffer';
import { createHash, randomUUID } from 'node:crypto';

import {
  buildEvidenceStorageKey,
  createEvidenceSignedUploadUrl,
  isLocalEvidenceStorage
} from '../evidenceStorage.js';
import { registerDocumentInDb, markParseEventSentInDb } from '../parseDocumentsDb.js';
// RT-08: the producer fork — the Inngest event in the cloud, a
// `parse-document` local job on the appliance — so an owner's Telegram or
// WhatsApp document gets the same queue-owned parse as a firm upload.
import { requestParseRun } from '../desktop/parseDocumentJob.js';
import { extractAskRef, hashPhoneE164 } from './whatsappWebhookCore.js';
import { resolveCountryInboundReply, resolveCountryOpeningBinding, startInvoiceIssuance, sniffEInvoiceXml } from '../inboundCountryRegistry.js';
import { assembleClientPortalTurn, persistClientPortalTurnMessage } from '../clientPortalTurn.js';
import { findClientPortalReportRequest, generateClientPortalChatReply, generateClientPortalReportNarration, newClientPortalChatMessageId } from '../clientPortalChat.js';
import { recordOwnerMileageExpenseInDb } from '../ownerMileageExpense.js';
import { claimOwnerMediaGroupSendInDb, getFinancialReportFromDb, getOwnerMediaDocForSummaryInDb, withFirmDbClient } from '../firmDb.js';
import { localEvidenceFetch } from '../localEvidencePut.js';
import { sendOwnerMediaParseSummary } from './ownerMediaParseSummary.js';
import { resolveOwnerPortalLink, composePortalLinkReply, recordOwnerPortalLinkShare } from '../selfKnowledge.js';
import { prefetchOwnerChannelGateContext } from './ownerChannelConfig.js';
import { clientFlagActs } from '../clientConfig.js';
import { supportsStructuredOwnerReply } from '../statutoryRegistry.js';
import {
  checkEntityReadinessAdmissionWithClient,
  EntityReadinessAdmissionError
} from '../runtimeReadinessAdmission.js';

let generateClientPortalChatReplyForTests = null;
export const __setInboundComposeForTests = (fn) => { generateClientPortalChatReplyForTests = fn; };
export const __resetInboundComposeForTests = () => { generateClientPortalChatReplyForTests = null; };
let generateClientPortalReportNarrationForTests = null;
export const __setInboundNarrationForTests = (fn) => { generateClientPortalReportNarrationForTests = fn; };
export const __resetInboundNarrationForTests = () => { generateClientPortalReportNarrationForTests = null; };

export const WHATSAPP_OWNER_CONVERSATION_FLAG_KEY = 'WHATSAPP_OWNER_CONVERSATION';

// ── The owner's language on the inbound path ────────────────────────────────
//
// Every acknowledgement below is written in the owner's language: the ONE
// resolver (preferredOwnerTemplateLanguage, read per client through
// deps.getOwnerLanguage) over the client(s) the sender's number is bound to.
// Never guessed from the message. A number bound to clients that disagree, or
// no reader / no client, gets English, the historical copy, byte-identical.
export const resolveInboundOwnerLanguage = async ({ firmId, bindings = [], deps = {} } = {}) => {
  if (typeof deps.getOwnerLanguage !== 'function') return 'en';
  const seen = new Map();
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const clientId = binding?.client_id;
    if (!clientId || seen.has(clientId)) continue;
    const language = await Promise.resolve()
      .then(() => deps.getOwnerLanguage({ firmId: binding.firm_id || firmId, clientId }))
      .catch(() => 'en');
    seen.set(clientId, language === 'fi' ? 'fi' : 'en');
  }
  const languages = new Set(seen.values());
  return languages.size === 1 ? [...languages][0] : 'en';
};

// Before a client is known there is no owner language to resolve, and the
// language is never guessed from the message: such a text is bilingual,
// Finnish first, the way WhatsApp help/stopped already are. Once a binding names
// a client, ownerLanguageForBindings gives the one resolver's answer over those
// clients; with no named client it gives null, which means "send bilingual".
export const bilingualOwnerText = (fi, en) => `${fi} / ${en}`;

export const ownerLanguageForBindings = async ({ firmId, bindings = [], deps = {} } = {}) => {
  const named = (Array.isArray(bindings) ? bindings : []).filter((binding) => binding?.client_id);
  if (!named.length || typeof deps.getOwnerLanguage !== 'function') return null;
  return resolveInboundOwnerLanguage({ firmId, bindings: named, deps });
};

// The core's own owner-facing lines, per language. English is the historical
// copy, unchanged. Channel copy (config.copy) still wins where a channel
// defines the same line.
const OWNER_INVOICE_REFUSAL_COPY_FI = Object.freeze({
  issuance_gate_refused: 'Voin tehdä laskusta luonnoksen, mutta laskutusta ei ole vielä otettu käyttöön tililläsi. En ole lähettänyt mitään.',
  recipient_blocked: 'En voi laskuttaa tätä vastaanottajaa, koska hän on kieltänyt yhteydenotot. Mitään ei lähetetty.',
  no_pack_for_jurisdiction: 'Minulla ei ole vielä maasi laskutussääntöjä käytössä, joten en tehnyt luonnosta. Kerro, missä yrityksesi on rekisteröity, niin hoidan asian.',
  tax_not_supported: 'Tämä laskutustapa ei tue arvonlisäverollisia laskuja, joten en tehnyt tästä luonnosta. Käytä tähän verolliseen laskuun tuettua laskutustapaa.',
  issuer_not_configured: 'Ennen kuin voin laskuttaa puolestasi, tarvitsen yrityksesi tiedot: yrityksen nimen ja osoitteen sekä ALV-rekisteröinnin, jos sinulla on sellainen. Luonnosta ei tehty.',
  draft_invalid: 'En saanut tästä tehtyä kelvollista laskua, joten en tehnyt luonnosta. Kerro asiakas, summa ja mistä lasku on, niin yritän uudelleen.'
});

const INBOUND_CORE_COPY = Object.freeze({
  en: Object.freeze({
    chatUnavailable: 'I cannot answer from the books right now. Please try again in a moment.',
    memoryBlocked: "I can't safely reach your saved details right now, so I don't want to guess. Please try again in a moment.",
    topicOpen: "Got it — I’ll keep this question open.",
    invoiceTextRequired: 'Please reply in text with the invoice details I asked for. This invoice question remains open; attachments and voice messages cannot answer it yet.',
    invoiceContinuationUnavailable: 'Invoice continuation is unavailable. The question remains open; please retry your complete invoice instruction when invoicing is available.',
    invoiceRefusalStillOpen: ' The question remains open; reply with your complete invoice instruction to try again.',
    savedCodingExhausted: 'Your answer is saved, but coding could not finish. The issue needs repair before it can continue.',
    savedCodingPending: 'Your answer is saved. Coding has not finished yet.',
    bookedPosted: "It's on your books now — reply if that's not right.",
    bookedNotPosted: "Reply if that's not right.",
    booked: (account, tail) => `Got it — booked to ${account}. ${tail}`,
    followUpSent: 'Thanks. I sent you a follow-up question.'
  }),
  fi: Object.freeze({
    chatUnavailable: 'En pysty juuri nyt vastaamaan kirjanpidon perusteella. Kokeile hetken päästä uudelleen.',
    memoryBlocked: 'En pääse juuri nyt turvallisesti käsiksi tallennettuihin tietoihisi, enkä halua arvailla. Kokeile hetken päästä uudelleen.',
    topicOpen: 'Selvä, pidän tämän kysymyksen avoimena.',
    invoiceTextRequired: 'Vastaa tekstinä ja kerro laskun tiedot, joita kysyin. Tämä laskua koskeva kysymys on yhä auki. Liitteet ja ääniviestit eivät vielä käy vastaukseksi.',
    invoiceContinuationUnavailable: 'Laskun jatkaminen ei onnistu juuri nyt. Kysymys on yhä auki. Lähetä koko laskuohje uudelleen, kun laskutus on taas käytettävissä.',
    invoiceRefusalStillOpen: ' Kysymys on yhä auki. Vastaa koko laskuohjeella, niin yritetään uudelleen.',
    savedCodingExhausted: 'Vastauksesi on tallessa, mutta kirjausta ei saatu valmiiksi. Asia pitää korjata, ennen kuin se voi jatkua.',
    savedCodingPending: 'Vastauksesi on tallessa. Kirjaus ei ole vielä valmis.',
    bookedPosted: 'Se on nyt kirjanpidossasi. Vastaa, jos se ei ole oikein.',
    bookedNotPosted: 'Vastaa, jos se ei ole oikein.',
    booked: (account, tail) => `Selvä, kirjasin tämän tilille ${account}. ${tail}`,
    followUpSent: 'Kiitos. Lähetin sinulle vielä tarkentavan kysymyksen.'
  })
});

const coreCopyFor = (language) => INBOUND_CORE_COPY[language] || INBOUND_CORE_COPY.en;
const invoiceRefusalFor = (language, reason) => {
  const table = language === 'fi' ? OWNER_INVOICE_REFUSAL_COPY_FI : OWNER_INVOICE_COMMAND_REFUSAL_COPY;
  return table[reason] || table.draft_invalid;
};
const capabilityActs = ({ config, capability, clientId, gateContext, env }) => {
  const declared = config.capabilities?.[capability];
  if (declared !== true && !(declared === undefined && config.channel === 'telegram')) return false;
  if (config.channel !== 'whatsapp') return true;
  return clientFlagActs({ flagKey: WHATSAPP_OWNER_CONVERSATION_FLAG_KEY, snapshot: gateContext?.snapshotsByClient?.[clientId] || null, envFallback: () => false, env });
};

const sanitizeId = (value = '') => String(value || randomUUID()).replace(/[^a-zA-Z0-9_:-]/g, '_').slice(0, 140);
const sha256Hex = (bytes) => createHash('sha256').update(Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || '')).digest('hex');

export const defaultRegisterEvidenceDocument = async ({
  firmId,
  clientId,
  evidenceRequest,
  message,
  stored,
  descriptor,
  source = 'messaging',
  documentIdPrefix = 'msg_doc'
} = {}) => {
  const document = {
    id: `${documentIdPrefix}_${sanitizeId(message.id)}`,
    client_id: clientId,
    document_type: descriptor.kind === 'image' ? 'receipt' : undefined,
    filename: stored.filename,
    storage_provider: stored.provider,
    storage_bucket: stored.bucket,
    storage_object_key: stored.key,
    checksum_sha256: stored.checksum_sha256,
    file_size: stored.size,
    mime_type: stored.content_type,
    evidence_request_id: evidenceRequest.id,
    transaction_id: evidenceRequest.transaction_id || null,
    payload: {
      source,
      inbound_reply_id: message.id,
      media_id: descriptor.id,
      evidence_request_id: evidenceRequest.id,
      transaction_id: evidenceRequest.transaction_id || null,
      evidence_context: { request_id: evidenceRequest.id, transaction_id: evidenceRequest.transaction_id || null }
    }
  };
  const registration = await registerDocumentInDb({ firmId, document });
  if (registration.created && registration.parse_run_id) {
    await requestParseRun({
      firmId: firmId || registration.document.firm_id,
      documentId: registration.document.id,
      parseRunId: registration.parse_run_id,
      clientId: registration.document.client_id,
      documentType: registration.document.document_type
    });
    await markParseEventSentInDb({ firmId: firmId || registration.document.firm_id, documentId: registration.document.id, parseRunId: registration.parse_run_id });
  }
  return registration.document || document;
};


export const defaultRegisterOwnerInitiatedDocument = async ({
  firmId,
  clientId,
  message,
  stored,
  descriptor,
  source = 'messaging',
  documentIdPrefix = 'msg_doc'
} = {}) => {
  const document = {
    id: `${documentIdPrefix}_${sanitizeId(message.id)}`,
    client_id: clientId,
    document_type: descriptor.kind === 'image' ? 'receipt' : undefined,
    filename: stored.filename,
    storage_provider: stored.provider,
    storage_bucket: stored.bucket,
    storage_object_key: stored.key,
    checksum_sha256: stored.checksum_sha256,
    file_size: stored.size,
    mime_type: stored.content_type,
    payload: {
      source,
      channel: source,
      owner_initiated: true,
      inbound_reply_id: message.id,
      media_id: descriptor.id,
      // Telegram albums (multi-file sends) arrive as N separate messages
      // sharing media_group_id. Persisting it is what lets the post-parse
      // summary coalesce the group into ONE combined message instead of N
      // per-file lines (the 2026-07-21 repetition report).
      ...(message.media_group_id != null ? { media_group_id: String(message.media_group_id) } : {})
    }
  };
  const registration = await registerDocumentInDb({ firmId, document });
  if (registration.created && registration.parse_run_id) {
    await requestParseRun({
      firmId: firmId || registration.document.firm_id,
      documentId: registration.document.id,
      parseRunId: registration.parse_run_id,
      clientId: registration.document.client_id,
      documentType: registration.document.document_type
    });
    await markParseEventSentInDb({ firmId: firmId || registration.document.firm_id, documentId: registration.document.id, parseRunId: registration.parse_run_id });
  }
  return registration.document || document;
};

export const storeInboundMediaAsEvidence = async ({
  firmId,
  clientId,
  evidenceRequest,
  message,
  media,
  descriptor,
  // In local mode the signed URL is origin-relative and the runtime has no
  // TCP listener, so a Node-side PUT runs IN-PROCESS (localEvidencePut.js —
  // the same token check, admission and store as the HTTP route). An
  // injected fetchImpl (fixtures, the cloud's real fetch) still wins.
  fetchImpl = null,
  env = process.env,
  source = 'messaging'
} = {}) => {
  const bytes = media.bytes || Buffer.alloc(0);
  if (!bytes.length) throw Object.assign(new Error('Inbound media was empty.'), { code: 'INBOUND_MEDIA_EMPTY', statusCode: 400 });
  const checksum = media.sha256 || sha256Hex(bytes);
  const filename = media.filename || descriptor.filename || `${source}-${message.id || randomUUID()}`;
  const bucket = env.DONNA_EVIDENCE_BUCKET || env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence';
  const key = buildEvidenceStorageKey({ firmId, clientId, evidenceRequestId: evidenceRequest.id, transactionId: evidenceRequest.transaction_id || null, checksum, filename });
  // Inbound owner media is a second caller of the local signed-upload helper.
  // Bind it to the same ready generation as the interactive upload route so
  // an invalidation before the internal PUT cannot leave detached bytes.
  const signed = isLocalEvidenceStorage()
    ? await withFirmDbClient(async (client) => {
        await client.query('begin');
        try {
          const admission = await checkEntityReadinessAdmissionWithClient({
            client,
            firmId,
            clientId,
            boundary: 'upload_sign',
            resourceType: 'inbound_evidence_upload',
            resourceId: key
          });
          if (!admission.allowed) {
            await client.query('commit');
            throw new EntityReadinessAdmissionError(admission);
          }
          const result = await createEvidenceSignedUploadUrl({
            bucket,
            key,
            readinessClaim: admission.enforced ? {
              firm_id: firmId,
              client_id: clientId,
              entity_dependency_digest: admission.entity_dependency_digest
            } : null
          });
          await client.query('commit');
          return result;
        } catch (error) {
          await client.query('rollback').catch(() => {});
          throw error;
        }
      })
    : await createEvidenceSignedUploadUrl({ bucket, key });
  const transport = fetchImpl || (isLocalEvidenceStorage() ? localEvidenceFetch : globalThis.fetch);
  const upload = await transport(signed.signed_url, { method: 'PUT', headers: { 'Content-Type': media.mimeType || descriptor.mimeType || 'application/octet-stream', 'x-upsert': 'false' }, body: bytes });
  if (!upload.ok) {
    const detail = await upload.text().catch(() => '');
    throw Object.assign(new Error(detail || `Evidence storage upload failed with ${upload.status}.`), { code: 'EVIDENCE_STORAGE_UPLOAD_FAILED', statusCode: upload.status });
  }
  return { provider: signed.provider || 'supabase_storage', bucket, key, checksum_sha256: checksum, size: bytes.length, content_type: media.mimeType || descriptor.mimeType || 'application/octet-stream', filename };
};

const cleanReplyExcerpt = (text = '', max = 240) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
const askCurrentNeed = (ask = {}) => String(ask.question || ask.request_payload?.question || ask.request_payload?.current_need || ask.evidence_type || 'requested evidence').trim();

// Owner-reply keyword lists match whole words and phrases only. A letter is any
// Unicode letter or digit (\p{L}\p{N}), so Finnish ä, ö and å count as letters:
// JavaScript's \b does not, and a plain substring match reads "kohta" inside
// "henkilökohtainen" or "later" inside "collateral". Entries are regex sources.
const ownerReplyKeywords = (...entries) =>
  new RegExp(`(?<![\\p{L}\\p{N}])(?:${entries.join('|')})(?![\\p{L}\\p{N}])`, 'iu');
const CLARIFICATION_KEYWORDS = ownerReplyKeywords('which', 'what', 'who', 'where', 'when', 'why', 'how', 'mikä', 'mitä', 'kumpi', 'which receipt', 'tarkoitat');
const DEFER_KEYWORDS = ownerReplyKeywords('tomorrow', 'later', 'tonight', 'next week', 'send it', 'send this', "i'll send", 'i will send', 'palaan', 'huomenna', 'myöhemmin', 'kohta');
// 'not sure' / 'en ole varma' are the keywords the ask templates invite.
const PARTIAL_KEYWORDS = ownerReplyKeywords('partial', 'some of', 'not sure', 'maybe', 'i think', 'only have', 'missing', "don'?t have all", 'osittain', 'ehkä', 'en ole varma');
const CANNOT_ANSWER_KEYWORDS = ownerReplyKeywords("can'?t", 'cannot', 'unable', 'no idea', "don'?t know", 'en tiedä', 'ei onnistu');

export const assessEvidenceTopicTurn = ({ ask = {}, text = '', descriptor = null } = {}) => {
  if (descriptor && !descriptor.deferred) {
    return { outcome: 'answered_with_media', terminal: true, can_resolve: true, still_missing: [], reason: 'owner_sent_media_evidence' };
  }
  const reply = String(text || '').trim();
  if (!reply) return { outcome: 'unsupported', terminal: false, can_resolve: false, still_missing: [askCurrentNeed(ask)], reason: 'empty_or_unsupported_owner_turn' };
  const lower = reply.toLowerCase();
  if (/\?\s*$/.test(reply) || CLARIFICATION_KEYWORDS.test(reply)) {
    return { outcome: 'clarification_requested', terminal: false, can_resolve: false, still_missing: [askCurrentNeed(ask)], reason: 'owner_asked_clarifying_question' };
  }
  if (DEFER_KEYWORDS.test(lower)) {
    return { outcome: 'defer_later', terminal: false, can_resolve: false, still_missing: [askCurrentNeed(ask)], reason: 'owner_deferred_evidence' };
  }
  if (PARTIAL_KEYWORDS.test(lower)) {
    return { outcome: 'partial_answer', terminal: false, can_resolve: false, still_missing: [askCurrentNeed(ask)], reason: 'owner_supplied_partial_or_uncertain_answer' };
  }
  if (CANNOT_ANSWER_KEYWORDS.test(lower)) {
    return { outcome: 'needs_review', terminal: false, can_resolve: false, still_missing: [askCurrentNeed(ask)], reason: 'owner_cannot_answer_without_help' };
  }
  return { outcome: 'answered', terminal: true, can_resolve: true, still_missing: [], reason: 'owner_supplied_text_answer' };
};

export const buildEvidenceTopicState = ({ ask = {}, turn = {}, now, channel, actorId, inboundMessageId, documentIds = [] } = {}) => {
  const at = now || new Date().toISOString();
  const previous = ask.request_payload?.evidence_topic && typeof ask.request_payload.evidence_topic === 'object'
    ? ask.request_payload.evidence_topic
    : {};
  const assessment = {
    outcome: turn.outcome || 'unsupported',
    can_resolve: turn.can_resolve === true,
    still_missing: Array.isArray(turn.still_missing) ? turn.still_missing : [],
    reason: turn.reason || ''
  };
  const entry = {
    at,
    channel,
    actor_id: actorId || null,
    inbound_message_id: inboundMessageId || null,
    outcome: assessment.outcome,
    terminal: turn.terminal === true,
    reply_excerpt: cleanReplyExcerpt(turn.text || ''),
    document_ids: Array.isArray(documentIds) ? documentIds.filter(Boolean) : []
  };
  const turns = [...(Array.isArray(previous.turns) ? previous.turns : []), entry].slice(-10);
  return {
    version: 1,
    status: turn.terminal ? 'answered' : 'open',
    channel,
    current_need: askCurrentNeed(ask),
    last_owner_message_at: at,
    last_donna_message_at: previous.last_donna_message_at || null,
    last_assessment: assessment,
    turns
  };
};

// A resolved reply should tell the owner WHAT DONNA DID, not just "handled".
// When the reply AUTO-RECONCILED the line — a confident strong-model recode that
// APPLIED the coding (__shouldApplyReplyRecode) and posted it to the internal
// ledger — we speak the consequence: the account it was booked to. When the line
// did NOT auto-reconcile (parked for firm review, or the model kept it open with
// a follow-up), we fall back to the channel's generic acknowledgement. We NEVER
// claim a booking that didn't happen — the line is rendered from the persisted
// recode verdict, not from optimism (honest-promise rail).
export const buildResolvedReplyText = ({ resolved = {}, fallback = '', language = 'en' } = {}) => {
  const copy = coreCopyFor(language);
  const recode = resolved && typeof resolved === 'object' ? resolved.recode : null;
  const clarification = resolved?.evidence_request?.response_payload?.reply_processing?.clarification;
  if (resolved?.evidence_request?.status === 'open' && recode?.needsClarification === true
    && typeof clarification === 'string' && clarification.trim()) {
    // The follow-up question already reached the owner through the gated ask
    // fan-out (ownerReplyRecovery.js): acknowledge, do not send it twice.
    const followUp = recode.follow_up_delivery;
    if (Array.isArray(followUp?.delivered) && followUp.delivered.length) {
      return copy.followUpSent;
    }
    // The one owner-send gate (ownerAskDelivery.js) holds QUESTIONS to the
    // owner; it does not silence Donna's answer to a message the owner sent.
    // So while it refuses — send containment, readiness, or an answer it could
    // not read (it fails closed) — the reply to the owner's own message only
    // acknowledges the answer, and the clarification waits on the ask for
    // release. The gate's answer is the one the follow-up delivery already got.
    if (!followUp || followUp.refused || followUp.error) {
      return recode.exhausted ? copy.savedCodingExhausted : copy.savedCodingPending;
    }
    return clarification.trim();
  }
  if (!recode || recode.applied !== true) {
    if (resolved?.evidence_request?.status === 'replied' || recode?.error || recode?.skipped) {
      return recode?.exhausted ? copy.savedCodingExhausted : copy.savedCodingPending;
    }
    return fallback;
  }
  const suggestion = recode.suggestion && typeof recode.suggestion === 'object' ? recode.suggestion : {};
  const account = String(suggestion.account_label || suggestion.account_name || suggestion.proposed_account || '').replace(/\s+/g, ' ').trim();
  if (!account) return fallback;
  const tail = recode.posted === true ? copy.bookedPosted : copy.bookedNotPosted;
  return copy.booked(account, tail);
};

const bindingActorId = (binding = {}, fallback = 'messaging:webhook') => String(binding.collaborator_id || binding.verified_set_by || binding.opted_in_set_by || fallback);

export const resolveInboundAnchor = async ({ message, from, firmId, deps = {}, env = process.env, config = {}, gateContext: suppliedGateContext = null } = {}) => {
  const phoneHash = hashPhoneE164(from);
  const bindings = await deps.getBindingsByPhoneHash({ phoneHash });
  if (!bindings.length) return { status: 'unbound', phoneHash, bindings: [] };
  const gateContext = suppliedGateContext || await prefetchOwnerChannelGateContext({ bindings, firmId, loadSnapshot: deps.loadClientConfigSnapshot });
  let anchor = null;
  const contextId = config.extractContextId?.(message);
  if (contextId) {
    const delivery = await deps.getDeliveryByMessageId?.({ messageId: contextId });
    if (!delivery?.ask_id || !delivery?.client_id) anchor = { failed: true, reason: 'foreign_or_missing_context' };
    else {
      const binding = bindings.find((row) => row.client_id === delivery.client_id);
      anchor = binding ? { askId: delivery.ask_id, clientId: delivery.client_id, binding, source: 'context_id' } : { failed: true, reason: 'foreign_or_missing_context' };
    }
  }
  if (!anchor) {
    const ref = extractAskRef(config.extractText?.(message) || '');
    if (ref) {
      const matches = [];
      for (const binding of bindings) {
        const ask = await deps.getOpenAskByRef({ firmId, clientId: binding.client_id, askRef: ref });
        if (ask) matches.push({ ask, binding });
      }
      anchor = matches.length === 1 ? { askId: matches[0].ask.id, clientId: matches[0].ask.client_id, binding: matches[0].binding, ask: matches[0].ask, source: 'ref' } : { failed: true, reason: 'ref_not_unique' };
    }
  }
  if (!anchor || anchor.failed) return { status: 'unanchored', reason: anchor?.reason || 'missing_anchor', phoneHash, bindings, gateContext };
  if (!config.allowsClient(anchor.clientId, gateContext, env)) return { status: 'flag_off', phoneHash, bindings, anchor, gateContext };
  return { status: 'anchored', phoneHash, bindings, gateContext, ...anchor };
};

// FI-10 issuance UX: the owner-initiated entry. A bound owner's UNANCHORED text —
// today a dead-end nudge — is, for a FINLAND_INVOICING-flagged client bound to
// exactly ONE client, read by the issuance intake ("laskuta Asiakas Oy 500€ …").
// Returns null whenever the hook does not apply (flag off, media, multi-binding,
// missing deps) — the caller then nudges byte-identically to today. A verdict of
// not_invoice ALSO falls back to the standard nudge.
export const maybeStartInvoiceIssuance = async ({ message, from, firmId, env = process.env, deps = {}, config = {}, anchor, text, descriptor } = {}) => {
  if (anchor?.status !== 'unanchored') return null;
  if (descriptor || !String(text || '').trim()) return null;
  if (typeof deps.invoiceIssuanceFlagActs !== 'function' || typeof deps.createIssuedInvoiceDraft !== 'function') return null;
  const bindings = anchor.bindings || [];
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  const clientId = binding.client_id;
  if (!config.allowsClient(clientId, anchor.gateContext, env)) return null;
  // A flag we cannot confirm does not act (the envFallback-false semantics): any
  // failure here degrades to the pre-existing nudge, never to a broken webhook.
  let flagActs = false;
  try {
    flagActs = await (deps.invoiceIssuanceEntryActs || deps.invoiceIssuanceFlagActs)({ firmId, clientId });
  } catch {
    flagActs = false;
  }
  if (!flagActs) return null;

  const actorId = bindingActorId(binding, config.actorFallback);
  // Dedup BEFORE the model call — a Meta redelivery must not re-run the intake.
  const claim = await deps.claimInboundMessage({ firmId, inboundMessageId: message.id, clientId, phoneHash: anchor.phoneHash, providerPayload: { message, actor_id: actorId } });
  if (!claim.claimed) return { status: 'duplicate', reason: claim.reason || 'already_processed' };

  const sellerContext = typeof deps.getInvoiceSellerContext === 'function'
    ? await deps.getInvoiceSellerContext({ firmId, clientId })
    : {};
  // C-1: does FINLAND_QUOTES act? Fail-closed like the invoicing gate — a
  // quote intent with the flag off falls back to the standard nudge with zero
  // side effects (the intake returns not_invoice before any escalation).
  let quotesEnabled = false;
  if (typeof deps.quoteIssuanceFlagActs === 'function') {
    try {
      quotesEnabled = await deps.quoteIssuanceFlagActs({ firmId, clientId });
    } catch {
      quotesEnabled = false;
    }
  }
  // FI-13 13.4: does FINLAND_ALV_INVOICING act? Fail-closed — an unreadable flag
  // keeps issuance exempt (byte-identical), never a broken webhook. The route
  // additionally requires an effective alv_registration for the invoice date.
  let alvFlagActs = false;
  if (typeof deps.alvInvoicingFlagActs === 'function') {
    try {
      alvFlagActs = await deps.alvInvoicingFlagActs({ firmId, clientId });
    } catch {
      alvFlagActs = false;
    }
  }
  const start = deps.startInvoiceIssuance || startInvoiceIssuance;
  const result = await start({
    firmId,
    clientId,
    messageText: text,
    actorId,
    flagActs: true,
    alvFlagActs,
    sellerContext,
    createDraftImpl: deps.createIssuedInvoiceDraft,
    createAsk: deps.createInvoiceIssuanceAsk,
    // G-8: "hyvitä lasku 2026001" needs the original-invoice lookup.
    resolveCreditContext: typeof deps.getIssuedInvoiceCreditContext === 'function'
      ? ({ originalInvoiceNumber }) => deps.getIssuedInvoiceCreditContext({ firmId, clientId, originalInvoiceNumber })
      : null,
    // C-1: the quote (tarjous) lanes.
    quotesEnabled,
    resolveQuoteContext: typeof deps.getIssuedQuoteContext === 'function'
      ? ({ quoteNumber }) => deps.getIssuedQuoteContext({ firmId, clientId, quoteNumber })
      : null,
    createQuoteDraftImpl: deps.createIssuedQuoteDraft,
    declineQuoteImpl: deps.declineIssuedQuote,
    message,
    phoneHash: anchor.phoneHash,
    sendText: ({ text: outbound, ask }) => deps.sendText({ to: from, text: outbound, ask }),
    apiKey: env.ANTHROPIC_API_KEY,
    fetchImpl: deps.fetchImpl,
    // The owner's language (the one resolver, above); absent ⇒ the lane's Finnish.
    ...(config.language ? { language: config.language } : {})
  });
  if (result.action === 'not_invoice' || result.action === 'skipped') {
    await deps.sendText({ to: from, text: config.copy.unanchored });
    return { status: 'nudged', reason: 'unanchored' };
  }
  await deps.recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: result.ask?.id || null, client_id: clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: result.ask?.id || null, provider_payload: { inbound: { type: 'text', anchor: 'invoice_issuance_intent', invoice_issuance: result.action } } } });
  return { status: 'invoice_issuance', result };
};

// ── The jurisdiction-neutral owner-invoice turn entry (kernel-audit M2) ──────
//
// `ownerInvoiceCommand.js` shipped with NO CALLER AT ALL: nothing in this file
// or `api.js` invoked it, so the whole lane was unreachable code. This is the
// entry. It is the jurisdiction-neutral sibling of `maybeStartInvoiceIssuance`
// above — not a "US sibling"; there is no US-specific behaviour anywhere in it.
// The market comes from the client's own jurisdiction, via the pack.
//
// WHY IT RUNS SECOND, and refuses when the FI lane is live. G12's fork is a
// client getting TWO issuance lifecycles. `maybeStartInvoiceIssuance` owns the
// Finnish lane on a real book today, so it is tried first and, when it acts,
// this hook is never reached. Ordering alone is not enough, though: across turns
// a flag could act for one message and not the next. So the FI issuance flag is
// checked here too, and a client on the Finnish lane is refused outright rather
// than served by both. That is the collision the canary write-up names, closed
// at the entry rather than left to call order.
//
// Returns null whenever the hook does not apply — the caller then nudges
// byte-identically to today. Never throws: a failure here degrades to the
// standard nudge, never to a broken webhook.
export const maybeRunOwnerInvoiceCommand = async ({ message, from, firmId, env = process.env, deps = {}, config = {}, anchor, text, descriptor } = {}) => {
  if (anchor?.status !== 'unanchored') return null;
  if (descriptor || !String(text || '').trim()) return null;
  if (typeof deps.runOwnerInvoiceCommand !== 'function') return null;
  const bindings = anchor.bindings || [];
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  const clientId = binding.client_id;
  if (!config.allowsClient(clientId, anchor.gateContext, env)) return null;

  // The G12 collision guard. A client whose Finnish issuance lane acts is served
  // by that lane only — never by both.
  if (typeof deps.invoiceIssuanceFlagActs === 'function') {
    let fiLaneActs = false;
    try {
      fiLaneActs = await deps.invoiceIssuanceFlagActs({ firmId, clientId });
    } catch {
      // A flag we cannot READ is the dangerous direction here: assuming "off"
      // would open the second lifecycle this guard exists to prevent. Fail
      // toward the existing lane.
      fiLaneActs = true;
    }
    if (fiLaneActs) return null;
  }

  const actorId = bindingActorId(binding, config.actorFallback);
  let result;
  try {
    // OWNER_INVOICE_COMMAND is checked INSIDE the command, before its claim and
    // before any model call, so a flag-off client costs one flag read and
    // touches nothing. The source message is the command's own natural key —
    // this hook deliberately does NOT claim it through `claimInboundMessage`,
    // because that key cannot stop a replay from burning an invoice number
    // (G13(a)); the command's claim is the one that can.
    result = await deps.runOwnerInvoiceCommand({
      firmId,
      clientId,
      sourceMessageId: message.id,
      sourceChannel: config.channel === 'whatsapp' ? 'whatsapp' : config.channel,
      principalActorType: 'owner',
      principalActorId: actorId,
      channelBinding: { phone_hash: anchor.phoneHash },
      messageText: text,
      env
    });
  } catch {
    return null;
  }
  if (!result) return null;

  // Not-an-invoice and flag-off both fall back to the standard nudge, exactly
  // as the Finnish lane's not_invoice verdict does.
  if (result.status === 'skipped') return null;
  if (result.status === 'refused' && result.reason === 'not_an_invoice_command') return null;

  // A replay resolved to the first outcome, or another worker holds the
  // message: acknowledge nothing and send nothing. Sending again is how a
  // redelivery becomes a second message to the owner.
  if (result.status === 'duplicate' || result.status === 'in_flight') {
    return { status: 'owner_invoice_command', reason: result.status, result };
  }

  const outbound = result.status === 'asked'
    ? result.question
    : result.status === 'drafted'
      ? config.copy.ownerInvoiceCommandDrafted
      : invoiceRefusalFor(config.language, result.reason);
  await deps.sendText({ to: from, text: outbound });
  await deps.recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: result.evidenceRequestId || null, client_id: clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: result.evidenceRequestId || null, provider_payload: { inbound: { type: 'text', anchor: 'owner_invoice_command', owner_invoice_command: result.status, refusal_reason: result.reason || null } } } });
  return { status: 'owner_invoice_command', result };
};

// Every refusal the owner can actually see, named. CLOSED, mirroring
// OWNER_COMMAND_REFUSAL_REASONS — a refusal with no sentence would rest in a
// state that is neither "Donna handled it" nor "Donna asked you something",
// which is the violation the two-terminal-states rail exists to catch.
// `not_an_invoice_command` is absent on purpose: it falls back to the standard
// unanchored nudge above rather than announcing a lane the owner never invoked.
const OWNER_INVOICE_COMMAND_REFUSAL_COPY = Object.freeze({
  issuance_gate_refused: 'I can draft that invoice, but invoicing isn\'t switched on for your account yet. I haven\'t sent anything.',
  recipient_blocked: 'I can\'t invoice that contact — they\'ve unsubscribed or are marked do-not-contact. Nothing was sent.',
  no_pack_for_jurisdiction: 'I don\'t have the invoicing rules for your country set up yet, so I haven\'t drafted anything. Tell me where your business is registered and I\'ll get it sorted.',
  tax_not_supported: 'Declared VAT/sales-tax invoicing is not supported in this invoice lane, so I haven\'t drafted this one. Please use a supported invoicing route for this tax invoice.',
  issuer_not_configured: 'Before I can invoice for you I need your own business details on file — your business name and address, and your VAT registration status if you have one. Nothing was drafted.',
  draft_invalid: 'I couldn\'t make that into a valid invoice, so I haven\'t drafted anything. Tell me the customer, the amount and what it\'s for, and I\'ll try again.'
});

// FI-9 (R) receive-media hook (design:
// docs/design-donna-finland-fi9-receive-and-ap-post.md §R.4 lane 3, the
// maybeStartInvoiceIssuance pattern): a bound owner's UNANCHORED WhatsApp
// DOCUMENT — today a dead-end nudge — is, for a FINLAND_EINVOICE_RECEIVE-
// flagged client bound to exactly ONE client, downloaded and content-sniffed;
// a recognised Finvoice/UBL e-invoice XML mints a supplier_bill document and
// fires the parse event (the worker's e-invoice lane does the actual read).
// Returns null whenever the hook does not apply — the caller then nudges
// byte-identically to today. Ordering is deliberate: download + sniff are
// PURE and happen before any side effect, so a non-e-invoice document leaves
// zero trace; the dedup claim happens before the first write, so a Meta
// redelivery cannot re-mint.
export const maybeReceiveEInvoiceMedia = async ({ message, from, firmId, env = process.env, deps = {}, config = {}, anchor, descriptor } = {}) => {
  if (anchor?.status !== 'unanchored') return null;
  if (!descriptor || descriptor.kind !== 'document' || descriptor.deferred) return null;
  if (typeof deps.einvoiceReceiveFlagActs !== 'function' || typeof deps.downloadMedia !== 'function') return null;
  const bindings = anchor.bindings || [];
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  const clientId = binding.client_id;
  if (!config.allowsClient(clientId, anchor.gateContext, env)) return null;
  // A flag we cannot confirm does not act (envFallback-false semantics): any
  // failure degrades to the pre-existing nudge, never a broken webhook.
  let flagActs = false;
  try {
    flagActs = await (deps.einvoiceReceiveEntryActs || deps.einvoiceReceiveFlagActs)({ firmId, clientId });
  } catch {
    flagActs = false;
  }
  if (!flagActs) return null;

  let media = null;
  try {
    media = await deps.downloadMedia({ mediaId: descriptor.id, mediaUrl: descriptor.url, env, fetchImpl: deps.fetchImpl || globalThis.fetch, message, descriptor });
  } catch {
    return null;
  }
  if (!sniffEInvoiceXml(media?.bytes)) return null;

  const actorId = bindingActorId(binding, config.actorFallback);
  const claim = await deps.claimInboundMessage({ firmId, inboundMessageId: message.id, clientId, phoneHash: anchor.phoneHash, providerPayload: { message, actor_id: actorId } });
  if (!claim.claimed) return { status: 'duplicate', reason: claim.reason || 'already_processed' };

  const storeMedia = deps.storeMedia || storeInboundMediaAsEvidence;
  const stored = await storeMedia({
    firmId,
    clientId,
    // Unanchored — no ask exists; the synthetic id only namespaces the storage key.
    evidenceRequest: { id: `einvoice_${sanitizeId(message.id)}`, transaction_id: null },
    message,
    media,
    descriptor,
    env,
    // undefined ⇒ storeInboundMediaAsEvidence picks the transport for the host.
    fetchImpl: deps.fetchImpl,
    source: config.source
  });
  const document = {
    id: `msg_doc_${sanitizeId(message.id)}`,
    client_id: clientId,
    document_type: 'supplier_bill',
    filename: stored.filename,
    storage_provider: stored.provider,
    storage_bucket: stored.bucket,
    storage_object_key: stored.key,
    checksum_sha256: stored.checksum_sha256,
    file_size: stored.size,
    mime_type: stored.content_type,
    payload: {
      source: config.source,
      inbound_reply_id: message.id,
      media_id: descriptor.id,
      einvoice_inbound: true
    }
  };
  const registerDocument = deps.registerDocument || registerDocumentInDb;
  const registration = await registerDocument({ firmId, document });
  if (registration.created && registration.parse_run_id) {
    await requestParseRun({
      firmId: firmId || registration.document.firm_id,
      documentId: registration.document.id,
      parseRunId: registration.parse_run_id,
      clientId: registration.document.client_id,
      documentType: registration.document.document_type
    });
    await markParseEventSentInDb({ firmId: firmId || registration.document.firm_id, documentId: registration.document.id, parseRunId: registration.parse_run_id });
  }
  const documentId = registration.document?.id || document.id;
  await deps.recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: null, client_id: clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: null, provider_payload: { inbound: { type: descriptor.kind, media_id: descriptor.id, document_id: documentId, anchor: 'einvoice_inbound' } } } });
  await deps.sendText({ to: from, text: config.copy.einvoiceReceived || config.copy.mediaSaved });
  return { status: 'einvoice_received', documentId };
};



const maybeReceiveOwnerInitiatedMedia = async ({ message, from, firmId, env = process.env, deps, config, anchor, descriptor } = {}) => {
  const candidateClientId = anchor?.bindings?.length === 1 ? anchor.bindings[0]?.client_id : null;
  if (!capabilityActs({ config, capability: 'ownerInitiatedMedia', clientId: candidateClientId, gateContext: anchor?.gateContext, env })) return null;
  if (!descriptor || descriptor.deferred) return null;
  const bindings = Array.isArray(anchor?.bindings) ? anchor.bindings : [];
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  const clientId = binding?.client_id;
  if (!clientId) return null;
  if (typeof config.allowsClient === 'function' && !config.allowsClient(clientId, anchor.gateContext, env)) return null;
  const actorId = bindingActorId(binding, config.actorFallback);
  const expectedDocumentId = `${config.documentIdPrefix || 'msg_doc'}_${sanitizeId(message.id)}`;
  const claim = await deps.claimInboundMessage({ firmId, inboundMessageId: message.id, clientId, phoneHash: anchor.phoneHash, providerPayload: { message, actor_id: actorId, owner_initiated_media: true } });
  if (!claim.claimed) {
    // F-2 (burned-claim ack, half 2): a redelivery of an update whose first
    // attempt died AFTER claiming but BEFORE registering the document (crash,
    // function timeout) used to exit here silently — the owner's photo
    // vanished with no retry coming (the 2026-07-16 silent-receipt incident's
    // exit path). The document row is the completion receipt: if it exists,
    // the first attempt got the photo saved and this redelivery stays silent
    // as before; if it does not, tell the owner to re-send. A lookup failure
    // stays silent (never nag on uncertain evidence).
    if (config.copy?.mediaFailed) {
      let existing;
      try {
        existing = await (deps.getOwnerMediaDoc || getOwnerMediaDocForSummaryInDb)({ firmId, documentId: expectedDocumentId });
      } catch {
        existing = { unknown: true };
      }
      if (!existing) {
        await deps.sendText({ to: from, text: config.copy.mediaFailed });
        return { status: 'owner_media_resend_requested', clientId, documentId: expectedDocumentId };
      }
    }
    return { status: 'duplicate', reason: claim.reason || 'already_processed' };
  }
  const media = await deps.downloadMedia({ mediaId: descriptor.id, mediaUrl: descriptor.url, env, fetchImpl: deps.fetchImpl || globalThis.fetch, message, descriptor });
  const evidenceRequest = { id: null, client_id: clientId, transaction_id: null };
  const storeMedia = deps.storeMedia || storeInboundMediaAsEvidence;
  const stored = await storeMedia({ firmId, clientId, evidenceRequest, message, media, descriptor, env, fetchImpl: deps.fetchImpl || globalThis.fetch, source: config.source });
  const registerDocument = deps.registerOwnerInitiatedDocument || defaultRegisterOwnerInitiatedDocument;
  const document = await registerDocument({ firmId, clientId, message, stored, descriptor, source: config.source, documentIdPrefix: config.documentIdPrefix });
  const documentId = document.id || document.document_id;
  await deps.recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: null, client_id: clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: null, provider_payload: { inbound: { type: descriptor.kind, media_id: descriptor.id, document_id: documentId, anchor: 'owner_initiated_media' } } } });
  // F-3 (docs/donna-telegram-receipt-silence-diagnostic.md §7): a byte-dup
  // registers as a `duplicate_pending` placeholder that never fires a parse,
  // so no post-parse leg will ever speak for it — and the "Reading it now"
  // ack would be a lie. Route the dup reply through the summary module: same
  // copy, same claim ledger (exactly-once), same OWNER_MEDIA_PARSE_SUMMARY
  // gates. When the gates skip it (flag off, no binding), fall through to
  // today's ack byte-identically. Best-effort: a summary failure never fails
  // the registration.
  if (String(document.parse_status || '') === 'duplicate_pending') {
    let summary = null;
    try {
      summary = await (deps.sendOwnerMediaParseSummary || sendOwnerMediaParseSummary)({ firmId, documentId, env });
    } catch {
      summary = null;
    }
    if (summary?.sent) return { status: 'owner_media_duplicate', clientId, documentId };
  }
  // One ack per album: a Telegram multi-file send arrives as N separate
  // messages sharing media_group_id, and each used to ack on its own (the
  // 2026-07-21 repetition report). The first member to reach this point
  // claims the group-ack ledger row and speaks (plural copy); siblings
  // register silently. A claim-read failure fails OPEN to acking — a
  // duplicate ack beats a silent save. Single files (no media_group_id)
  // keep today's path byte-identically.
  const mediaGroupId = message.media_group_id != null ? String(message.media_group_id) : null;
  if (mediaGroupId) {
    let groupAck = null;
    try {
      groupAck = await (deps.claimOwnerMediaGroupSend || claimOwnerMediaGroupSendInDb)({
        firmId, clientId, mediaGroupId, kind: 'ack', phoneHash: anchor.phoneHash
      });
    } catch {
      groupAck = { claimed: true };
    }
    if (!groupAck?.claimed) {
      return { status: 'owner_media_registered', clientId, documentId, group_ack: 'skipped' };
    }
  }
  // The ack is a receipt and must name its destination: a binding can point at
  // a different client than the sender assumes (the 2026-07-20 honeybee
  // misbinding — two live incarnations, the link minted against the old one),
  // and an unnamed "got it" hides that for weeks. Best-effort: a name lookup
  // failure degrades to the unnamed ack, never blocks it. Channels without a
  // mediaSavedFor copy keep today's ack byte-identically.
  const plainAck = (mediaGroupId && config.copy.mediaSavedMany) || config.copy.mediaSaved;
  const namedAck = (mediaGroupId && config.copy.mediaSavedForMany) || config.copy.mediaSavedFor;
  let mediaAckText = plainAck;
  if (typeof namedAck === 'function' && typeof deps.getClientDisplayName === 'function') {
    try {
      const clientName = await deps.getClientDisplayName({ firmId, clientId });
      if (clientName) mediaAckText = namedAck(clientName);
    } catch {
      mediaAckText = plainAck;
    }
  }
  await deps.sendText({ to: from, text: mediaAckText });
  return { status: 'owner_media_registered', clientId, documentId };
};

const maybeAnswerGeneralOwnerChat = async ({ message, from, firmId, env = process.env, deps, config, anchor, text } = {}) => {
  const candidateClientId = anchor?.bindings?.length === 1 ? anchor.bindings[0]?.client_id : null;
  if (!capabilityActs({ config, capability: 'generalOwnerChat', clientId: candidateClientId, gateContext: anchor?.gateContext, env })) return null;
  if (!String(text || '').trim()) return null;
  const bindings = Array.isArray(anchor?.bindings) ? anchor.bindings : [];
  if (bindings.length !== 1) return null;
  const binding = bindings[0];
  const clientId = binding?.client_id;
  if (!clientId) return null;
  if (typeof config.allowsClient === 'function' && !config.allowsClient(clientId, anchor.gateContext, env)) return null;
  const actorId = bindingActorId(binding, config.actorFallback);
  const claim = await deps.claimInboundMessage({ firmId, inboundMessageId: message.id, clientId, phoneHash: anchor.phoneHash, providerPayload: { message, actor_id: actorId, general_owner_chat: true } });
  if (!claim.claimed) return { status: 'duplicate', reason: claim.reason || 'already_processed' };
  const userMessageRow = await (deps.appendClientPortalChatMessage || persistClientPortalTurnMessage)({
    firmId,
    clientId,
    id: newClientPortalChatMessageId({ clientId, kind: 'user' }),
    role: 'user',
    content: String(text || '').trim(),
    payload: { actor_id: actorId, channel: config.channel, inbound_message_id: message.id },
    actorType: 'client'
  });
  const principal = { principalType: 'firm_collaborator', principalId: actorId, clientIds: [clientId] };
  // surface/channel feed the flag-gated self-knowledge pack (selfKnowledge.js);
  // for every un-staged client the pack is null and the turn is byte-identical.
  const assembled = await (deps.assembleClientPortalTurn || assembleClientPortalTurn)({ firmId, clientId, userMessageRow, ownerPrincipal: principal, surface: 'owner_channel', channel: config.channel });
  if (assembled.ownerMemory?.shortCircuit) {
    const content = coreCopyFor(config.language).memoryBlocked;
    await (deps.appendClientPortalChatMessage || persistClientPortalTurnMessage)({ firmId, clientId, id: newClientPortalChatMessageId({ clientId, kind: 'assistant' }), role: 'assistant', content, payload: { actions: [], memory_status: 'blocked' }, actorType: 'system' });
    await deps.sendText({ to: from, text: content });
    return { status: 'general_chat', clientId, shortCircuit: true };
  }
  // The self-knowledge block rides the same system-prompt-appendix seam as the
  // governed memory block; null pack (flag off) keeps the prompt byte-identical.
  const selfKnowledge = assembled.selfKnowledge || null;
  // Audit L4 — the K1 grounding block joins the same appendix seam (the
  // owner_channel lane the seam declares). null (flag off / seam failure)
  // keeps the prompt byte-identical.
  const knowledgeGrounding = assembled.knowledgeGrounding || null;
  const promptExtra = [assembled.ownerMemory?.systemPromptExtra, selfKnowledge?.systemPromptExtra, knowledgeGrounding?.answer?.grounding_block]
    .filter(Boolean).join('\n\n') || null;
  const reply = await (deps.generateClientPortalChatReply || generateClientPortalChatReplyForTests || generateClientPortalChatReply)({
    context: assembled.ownerMemory?.promptContext || assembled.context,
    history: assembled.ownerMemory?.promptHistory || assembled.history.slice(0, -1),
    userMessage: String(text || '').trim(),
    validAskIds: assembled.validAskIds,
    assistantName: assembled.assistantName,
    memoryExtra: promptExtra,
    allowPortalLink: selfKnowledge?.portal_link_enabled === true,
    ...(deps.callClientPortalChatModel ? { __callAnthropic: deps.callClientPortalChatModel } : {})
  });
  if (reply.kind !== 'ok') {
    await deps.sendText({ to: from, text: config.copy.chatUnavailable || coreCopyFor(config.language).chatUnavailable });
    return { status: 'general_chat_unavailable', reason: reply.reason || reply.code || 'unknown' };
  }
  // `today` = the anchor the model was given this turn; it rides the persisted
  // report_request receipt (requested_today) so period-vs-now drift is
  // queryable from data (the "this year → 2025" incident class).
  const reportRequest = findClientPortalReportRequest(reply, {
    today: (assembled.ownerMemory?.promptContext || assembled.context)?.today
  });
  let finalReply = reply;
  let reportResult = null;
  if (reportRequest) {
    const getReport = deps.getFinancialReport || getFinancialReportFromDb;
    try {
      reportResult = await getReport({
        firmId,
        clientId,
        periodStart: reportRequest.period_start,
        periodEnd: reportRequest.period_end,
        basis: reportRequest.basis
      });
    } catch (error) {
      console.warn('[inbound-owner-chat] report read failed', error?.message || error);
      await deps.sendText({ to: from, text: config.copy.chatUnavailable || coreCopyFor(config.language).chatUnavailable });
      return { status: 'general_chat_unavailable', reason: 'report_read_failed' };
    }
    const narration = await (deps.generateClientPortalReportNarration || generateClientPortalReportNarrationForTests || generateClientPortalReportNarration)({
      context: assembled.ownerMemory?.promptContext || assembled.context,
      report: reportResult,
      request: reportRequest,
      userMessage: String(text || '').trim(),
      assistantName: assembled.assistantName,
      ...(deps.callClientPortalReportNarrationModel ? { __callAnthropic: deps.callClientPortalReportNarrationModel } : {})
    });
    if (narration.kind !== 'ok') {
      await deps.sendText({ to: from, text: config.copy.chatUnavailable || coreCopyFor(config.language).chatUnavailable });
      return { status: 'general_chat_unavailable', reason: narration.reason || narration.code || 'report_narration_failed' };
    }
    finalReply = narration;
  }
  let resolved = null;
  let mileage = null;
  let portalLink = null;
  const action = (Array.isArray(reply.actions) ? reply.actions : []).find((candidate) =>
    (candidate?.type === 'answer_evidence_request' && assembled.validAskIds.includes(candidate.evidence_request_id) && String(candidate.reply_text || '').trim())
    || candidate?.type === 'record_mileage'
    // Defence in depth beyond the sanitizer: the runtime re-checks the flag
    // verdict from the assembled pack, never trusts the model's emission.
    || (candidate?.type === 'share_portal_link' && selfKnowledge?.portal_link_enabled === true));
  if (action?.type === 'answer_evidence_request') {
    resolved = await deps.resolveEvidenceRequest({ firmId, evidenceRequestId: action.evidence_request_id, reply: action.reply_text, actorId, actorType: 'client' });
  } else if (action?.type === 'record_mileage') {
    const recordMileage = deps.recordOwnerMileageExpense || recordOwnerMileageExpenseInDb;
    mileage = await recordMileage({ firmId, clientId, action, actorId, sourceMessageId: message.id, model: reply.model, language: config.language || 'en' });
  } else if (action?.type === 'share_portal_link') {
    // The deep link is resolved DETERMINISTICALLY (never model-typed); an unset
    // base URL degrades to a named instruction (the ownerDigest posture). The
    // send is receipted three ways: this audit event (best-effort), the
    // assistant-message payload, and the delivery ledger below.
    portalLink = (deps.resolveOwnerPortalLink || resolveOwnerPortalLink)({ clientId, env });
    try {
      const auditShare = deps.recordOwnerPortalLinkShare
        || ((args) => withFirmDbClient((dbClient) => recordOwnerPortalLinkShare(dbClient, args)));
      await auditShare({
        firmId,
        clientId,
        actorId,
        channel: config.channel,
        status: portalLink.status,
        linkPath: portalLink.path,
        selfKnowledgeVersion: selfKnowledge?.receipt?.self_knowledge_version || null,
        selfKnowledgeFingerprint: selfKnowledge?.receipt?.self_knowledge_fingerprint || null,
        configSnapshotId: selfKnowledge?.receipt?.config_snapshot_id || null
      });
    } catch (error) {
      console.warn('[inbound-owner-chat] portal-link audit write failed', error?.message || error);
      portalLink = { ...portalLink, audit: 'failed' };
    }
  }
  const outboundText = resolved
    ? buildResolvedReplyText({ resolved, fallback: finalReply.text, language: config.language })
    : mileage?.status === 'booked'
      ? mileage.consequence
      : portalLink
        ? composePortalLinkReply({ text: finalReply.text, link: portalLink, language: config.language })
        : finalReply.text;
  const assistantMessage = await (deps.appendClientPortalChatMessage || persistClientPortalTurnMessage)({
    firmId,
    clientId,
    id: newClientPortalChatMessageId({ clientId, kind: 'assistant' }),
    role: 'assistant',
    content: outboundText,
    payload: {
      actions: finalReply.actions,
      ...(reportRequest ? { report_request: reportRequest, report_result: { period_start: reportResult?.period_start || null, period_end: reportResult?.period_end || null, draft: reportResult?.draft || null } } : {}),
      ...(resolved || mileage?.status === 'booked' || portalLink ? { applied_action: action } : {}),
      ...(mileage ? { mileage_result: mileage } : {}),
      ...(portalLink ? { portal_link: portalLink } : {}),
      // The capability-context version is part of the receipt (like the model
      // id): which self-knowledge pack the model was answering from.
      ...(selfKnowledge ? { self_knowledge: selfKnowledge.receipt } : {}),
      // K1 grounding receipt — which sources grounded this answer, if any.
      ...(knowledgeGrounding?.receipt ? { knowledge_grounding: knowledgeGrounding.receipt } : {})
    },
    model: finalReply.model || reply.model,
    actorType: 'llm'
  });
  await deps.recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: action?.type === 'answer_evidence_request' ? action.evidence_request_id : null, client_id: clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: resolved?.evidence_request?.id || null, provider_payload: { inbound: { type: 'text', anchor: 'general_owner_chat', assistant_message_id: assistantMessage.id, action_applied: Boolean(resolved || mileage?.status === 'booked' || portalLink?.status === 'sent'), ...(portalLink ? { portal_link: { status: portalLink.status, path: portalLink.path || null } } : {}), ...(selfKnowledge ? { self_knowledge_version: selfKnowledge.receipt.self_knowledge_version, self_knowledge_fingerprint: selfKnowledge.receipt.self_knowledge_fingerprint } : {}) } } } });
  await deps.sendText({ to: from, text: outboundText });
  return { status: 'general_chat', clientId, actionApplied: Boolean(resolved || mileage?.status === 'booked' || portalLink?.status === 'sent'), resolved, mileage, portalLink, report: reportRequest ? { request: reportRequest } : null };
};

export const processAnchoredInboundMessage = async ({ message, from, firmId, env = process.env, deps = {}, config = {} } = {}) => {
  let sendText = deps.sendText;
  const text = config.extractText(message) || '';
  const descriptor = config.mediaDescriptor(message);
  const anchor = await resolveInboundAnchor({ message, from, firmId, env, deps, config });
  if (anchor.status === 'unbound') { await sendText({ to: from, text: config.copy.unbound }); return { status: 'nudged', reason: 'unbound' }; }
  if (anchor.status === 'flag_off') return { status: 'skipped', reason: 'flag_off' };
  // From here a client is known (the anchored one, or the number's bindings):
  // every reply below speaks the owner's language. A channel without copyFor
  // keeps its one copy.
  if (typeof config.copyFor === 'function') {
    const languageBindings = anchor.status === 'anchored'
      ? (anchor.bindings || []).filter((binding) => binding?.client_id === anchor.clientId)
      : anchor.bindings;
    const language = await resolveInboundOwnerLanguage({ firmId, bindings: languageBindings, deps });
    config = { ...config, language, copy: config.copyFor(language) };
  }
  // The voice-note nudge rides the descriptor (built before the client is
  // known); the channel copy carries the same line in the owner's language.
  const deferredText = (item) => (config.language && item?.deferredReason === 'voice_deferred' ? config.copy.voiceDeferred : null)
    || item?.deferredText || config.copy.voiceDeferred;
  if (anchor.status !== 'anchored') {
    if (descriptor?.deferred) { await sendText({ to: from, text: deferredText(descriptor) }); return { status: 'nudged', reason: descriptor.deferredReason || 'voice_deferred' }; }
    const issuance = await maybeStartInvoiceIssuance({ message, from, firmId, env, deps, config, anchor, text, descriptor });
    if (issuance) return issuance;
    // Kernel-audit M2: the jurisdiction-neutral owner-invoice turn entry. Runs
    // AFTER the Finnish lane and refuses outright for a client that lane serves
    // (the G12 double-lifecycle guard lives in the hook). Born off — with no
    // OWNER_INVOICE_COMMAND stage row this returns null and nothing changes.
    const ownerInvoice = await maybeRunOwnerInvoiceCommand({ message, from, firmId, env, deps, config, anchor, text, descriptor });
    if (ownerInvoice) return ownerInvoice;
    // FI-9 (R): mutually exclusive with the issuance hook (text-only vs
    // document-only); null falls through to the standard nudge byte-identically.
    const einvoice = await maybeReceiveEInvoiceMedia({ message, from, firmId, env, deps, config, anchor, descriptor });
    if (einvoice) return einvoice;
    const ownerMedia = await maybeReceiveOwnerInitiatedMedia({ message, from, firmId, env, deps, config, anchor, descriptor });
    if (ownerMedia) return ownerMedia;
    const generalOwnerChat = await maybeAnswerGeneralOwnerChat({ message, from, firmId, env, deps, config, anchor, text });
    if (generalOwnerChat) return generalOwnerChat;
    await sendText({ to: from, text: config.copy.unanchored });
    return { status: 'nudged', reason: anchor.reason || 'unanchored' };
  }

  const actorId = bindingActorId(anchor.binding, config.actorFallback);
  const ask = anchor.ask || (typeof deps.getAskById === 'function' ? await deps.getAskById({ firmId, clientId: anchor.clientId, askId: anchor.askId }) : null);
  const recordLedger = deps.recordLedger;
  // A question from the owner invoice command has one real consumer. Keep
  // this exact anchored lane out of generic evidence-topic interpretation.
  if (ask?.evidence_type === 'owner_invoice_command') {
    // This consumer reads explicit text only. A photo or voice reply must not
    // enter generic evidence resolution and mark the invoice question replied
    // without either a draft or a successor question.
    if (descriptor) {
      await sendText({ to: from, text: coreCopyFor(config.language).invoiceTextRequired });
      return { status: 'topic_open', reason: 'owner_invoice_text_required', askId: anchor.askId };
    }
    if (typeof deps.runOwnerInvoiceCommand !== 'function') {
      await sendText({ to: from, text: coreCopyFor(config.language).invoiceContinuationUnavailable });
      return { status: 'topic_open', askId: anchor.askId };
    }
    const result = await deps.runOwnerInvoiceCommand({
      firmId, clientId: anchor.clientId, sourceMessageId: message.id,
      sourceChannel: config.channel, principalActorType: 'owner', principalActorId: actorId,
      channelBinding: { phone_hash: anchor.phoneHash }, messageText: text,
      continuationAskId: ask.id, env
    });
    if (result?.status === 'duplicate' || result?.status === 'in_flight') {
      return { status: 'owner_invoice_command', reason: result.status, result };
    }
    const outbound = result?.status === 'asked' ? result.question
      : result?.status === 'drafted' ? config.copy.ownerInvoiceCommandDrafted
        : `${invoiceRefusalFor(config.language, result?.reason)}${coreCopyFor(config.language).invoiceRefusalStillOpen}`;
    await sendText({ to: from, text: outbound });
    await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel,
      ask_id: result?.evidenceRequestId || anchor.askId, client_id: anchor.clientId,
      recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id,
      resolved_request_id: ['drafted', 'asked'].includes(result?.status) ? anchor.askId : null,
      provider_payload: { inbound: { type: 'text', anchor: anchor.source, owner_invoice_command: result?.status } } } });
    return { status: 'owner_invoice_command', result };
  }
  const claim = await deps.claimInboundMessage({ firmId, inboundMessageId: message.id, clientId: anchor.clientId, phoneHash: anchor.phoneHash, providerPayload: { message, actor_id: actorId } });
  if (!claim.claimed) return { status: 'duplicate', reason: claim.reason || 'already_processed' };

  if (config.capabilities?.persistOwnerThread) {
    try {
      await (deps.appendClientPortalChatMessage || persistClientPortalTurnMessage)({ firmId, clientId: anchor.clientId, id: newClientPortalChatMessageId({ clientId: anchor.clientId, kind: 'user' }), role: 'user', content: String(text || '').trim() || `[${descriptor?.kind || 'message'}]`, payload: { actor_id: actorId, channel: config.channel, inbound_message_id: message.id, ask_id: anchor.askId }, actorType: 'client' });
    } catch (error) {
      console.warn('[inboundCore] owner-thread persistence failed', error?.message || error);
    }
    const channelSendText = sendText;
    sendText = async (outbound = {}) => {
      // Send FIRST, persist after: a failed channel send must not leave a
      // phantom Donna reply in the thread. Persistence failure still warns and
      // never blocks — the delivery result is returned either way.
      const delivery = await channelSendText(outbound);
      const content = String(outbound?.text || '').trim();
      if (content) {
        try {
          await (deps.appendClientPortalChatMessage || persistClientPortalTurnMessage)({
            firmId,
            clientId: anchor.clientId,
            id: newClientPortalChatMessageId({ clientId: anchor.clientId, kind: 'assistant' }),
            role: 'assistant',
            content,
            payload: { actions: [], channel: config.channel, inbound_message_id: message.id, ask_id: anchor.askId },
            actorType: 'system'
          });
        } catch (error) {
          console.warn('[inboundCore] Donna owner-thread persistence failed', error?.message || error);
        }
      }
      return delivery;
    };
  }

  if (descriptor?.deferred) { await sendText({ to: from, text: deferredText(descriptor) }); return { status: 'nudged', reason: descriptor.deferredReason || 'deferred' }; }

  const resolveEvidenceRequest = deps.resolveEvidenceRequest;
  const openingBinding = resolveCountryOpeningBinding(ask);
  const isOpeningBalance = Boolean(openingBinding);
  const openingFlagReader = openingBinding ? deps[openingBinding.flagReaderKey] : null;
  const openingBalanceFlagActs = isOpeningBalance && typeof openingFlagReader === 'function'
    ? await openingFlagReader({ firmId, clientId: anchor.clientId, ask })
    : false;
  const openingBalanceEntityType = typeof openingBinding?.readEntityType === 'function'
    ? await openingBinding.readEntityType({ deps, firmId, clientId: anchor.clientId }) : undefined;
  const resolveOpening = openingBinding ? (deps[openingBinding.resolverKey] || openingBinding.resolve) : null;
  const countryReply = resolveCountryInboundReply(ask);
  if (countryReply) return countryReply.run({ descriptor, sendText, from, config, deps, firmId, anchor, ask, text, message, actorId, env, recordLedger });
  if (!descriptor) {
    if (!String(text || '').trim()) { await sendText({ to: from, text: config.copy.unanchored }); return { status: 'nudged', reason: 'unsupported_message_type' }; }
    if (isOpeningBalance) {
      const result = await resolveOpening({
        firmId,
        clientId: anchor.clientId,
        ask,
        replyText: text,
        message,
        phoneHash: anchor.phoneHash,
        actorId,
        flagActs: openingBalanceFlagActs,
        entityType: openingBalanceEntityType,
        apiKey: env.ANTHROPIC_API_KEY,
        fetchImpl: deps.fetchImpl,
        sendText: ({ text: outbound }) => sendText({ to: from, text: outbound }),
        createAsk: deps[openingBinding.createAskKey],
        resolveAsk: deps.resolveOpeningBalanceAsk,
        confirmOpeningBalanceIntakeImpl: deps.confirmOpeningBalanceIntake,
        runTrialBalanceIntakeImpl: deps.runTrialBalanceIntake,
        classifyOpeningIntakeImpl: deps.classifyOpeningIntake,
        postImpl: deps[openingBinding.postKey],
        language: config.language || 'en'
      });
      await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: anchor.askId, provider_payload: { inbound: { type: 'text', anchor: anchor.source, opening_balance: result.action } } } });
      return { status: 'opening_balance', askId: anchor.askId, result };
    }
    const turn = assessEvidenceTopicTurn({ ask, text, descriptor: null });
    if (!supportsStructuredOwnerReply(ask) && !turn.terminal && typeof deps.recordEvidenceTopicTurn === 'function') {
      const topicState = buildEvidenceTopicState({ ask, turn: { ...turn, text }, now: deps.now?.() || new Date().toISOString(), channel: config.channel, actorId, inboundMessageId: message.id, documentIds: [] });
      const recorded = await deps.recordEvidenceTopicTurn({ firmId, evidenceRequestId: anchor.askId, topicState, actorId, actorType: 'client' });
      await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: null, provider_payload: { inbound: { type: 'text', anchor: anchor.source, evidence_topic: { outcome: turn.outcome, status: 'open' } } } } });
      await sendText({ to: from, text: config.copy.topicOpen || coreCopyFor(config.language).topicOpen });
      return { status: 'topic_open', askId: anchor.askId, result: recorded, topicState };
    }
    const resolved = await resolveEvidenceRequest({ firmId, evidenceRequestId: anchor.askId, reply: text, actorId, actorType: 'client' });
    await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: resolved?.evidence_request?.status === 'resolved' ? (resolved.evidence_request.id || anchor.askId) : null, provider_payload: { inbound: { type: 'text', anchor: anchor.source } } } });
    await sendText({ to: from, text: buildResolvedReplyText({ resolved, fallback: config.copy.textResolved, language: config.language }) });
    return { status: resolved?.evidence_request?.status === 'replied' ? 'reply_saved'
      : resolved?.evidence_request?.status === 'open' ? 'topic_open' : 'resolved', askId: anchor.askId, result: resolved };
  }

  const media = await deps.downloadMedia({ mediaId: descriptor.id, mediaUrl: descriptor.url, env, fetchImpl: deps.fetchImpl || globalThis.fetch, message, descriptor });
  const evidenceRequest = anchor.ask || { id: anchor.askId, client_id: anchor.clientId, transaction_id: null };
  const storeMedia = deps.storeMedia || storeInboundMediaAsEvidence;
  const stored = await storeMedia({ firmId, clientId: anchor.clientId, evidenceRequest, message, media, descriptor, env, fetchImpl: deps.fetchImpl || globalThis.fetch, source: config.source });
  const registerEvidenceDocument = deps.registerEvidenceDocument || defaultRegisterEvidenceDocument;
  const document = await registerEvidenceDocument({ firmId, clientId: anchor.clientId, evidenceRequest, message, stored, descriptor, source: config.source, documentIdPrefix: config.documentIdPrefix });
  const documentId = document.id || document.document_id;
  if (isOpeningBalance) {
    const documentText = typeof deps.getDocumentText === 'function' ? await deps.getDocumentText({ firmId, clientId: anchor.clientId, documentId, document }) : (document.documentText || document.text || '');
    const result = await resolveOpening({
      firmId,
      clientId: anchor.clientId,
      ask,
      documentText,
      replyText: text,
      message,
      phoneHash: anchor.phoneHash,
      actorId,
      flagActs: openingBalanceFlagActs,
      entityType: openingBalanceEntityType,
      apiKey: env.ANTHROPIC_API_KEY,
      fetchImpl: deps.fetchImpl,
      sendText: ({ text: outbound }) => sendText({ to: from, text: outbound }),
      createAsk: deps[openingBinding.createAskKey],
      resolveAsk: deps.resolveOpeningBalanceAsk,
      confirmOpeningBalanceIntakeImpl: deps.confirmOpeningBalanceIntake,
      runTrialBalanceIntakeImpl: deps.runTrialBalanceIntake,
      classifyOpeningIntakeImpl: deps.classifyOpeningIntake,
      postImpl: deps[openingBinding.postKey],
      language: config.language || 'en'
    });
    await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: anchor.askId, provider_payload: { inbound: { type: descriptor.kind, media_id: descriptor.id, document_id: documentId, anchor: anchor.source, opening_balance: result.action } } } });
    return { status: 'opening_balance', askId: anchor.askId, documentId, result };
  }
  const resolved = await resolveEvidenceRequest({ firmId, evidenceRequestId: anchor.askId, reply: text, documentIds: [documentId].filter(Boolean), actorId, actorType: 'client' });
  await recordLedger({ entry: { message_id: message.id, provider: config.provider, channel: config.channel, ask_id: anchor.askId, client_id: anchor.clientId, recipient_phone_hash: anchor.phoneHash, inbound_reply_id: message.id, resolved_request_id: resolved?.evidence_request?.status === 'resolved' ? (resolved.evidence_request.id || anchor.askId) : null, provider_payload: { inbound: { type: descriptor.kind, media_id: descriptor.id, document_id: documentId, anchor: anchor.source } } } });
  await sendText({ to: from, text: config.copy.mediaSaved });
  return { status: 'media_registered', askId: anchor.askId, documentId, result: resolved };
};
