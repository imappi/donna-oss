import { makeJevTrialProvider } from './jevTrialProvider.js';
// Doc-first terminal drain Slice 2 — the document no-line DISPOSITION
// producer (docs/donna-doc-first-terminal-drain-plan.md §3, the mirror of
// bankLineDispositionLlm.js pointed at documents).
//
// THE POPULATION: parsed, amount-bearing reconcilable documents (receipt /
// supplier_bill / sales_invoice / issued_receipt / payment_confirmation)
// for which the family matchers found NO bank line — the rows Slice 1
// surfaces as `parsed_no_match` violations in "Parsed · no terminal yet".
// Under the two-terminal-states principle such a doc has exactly two legal
// resting places, and ONE strong-model call decides the fork (Kari,
// 2026-07-05: "they belong to either (i) ask a user, or (ii) auto-reconcile
// with 'Explained'"):
//
//   - 'auto_explain'   — a self-explanatory business expense settled OUTSIDE
//                        the visible feed (cash, the owner's personal card,
//                        or an account whose statement is simply expected
//                        later). Donna finishes the row: "Explained". The doc
//                        REMAINS matcher-eligible — a late statement line
//                        attaches normally and upgrades the evidence; the
//                        line was never a precondition for finishing the row.
//   - 'chase_evidence' — only the OWNER can resolve it ("how was this paid —
//                        cash, personal card, or an account we should have a
//                        statement for?", or a statement request for a
//                        specific uncovered account). Slice 3 mints the
//                        doc-anchored client_evidence_request off this
//                        verdict; until the ask lands the row counts hanging.
//   - 'needs_human'    — safe fallback on model failure / genuine weirdness.
//                        NOT a terminal: stays `parsed_no_match`, surfaced in
//                        the violation section, never laundered.
//
// WHAT auto_explain WRITES (and deliberately does NOT — plan §3): the
// reconciliation_evaluations verdict row + (act mode only) a
// `documents.payload.no_line_disposition` merge + audit events. It does NOT
// set payment_status='paid' (the receipt is evidence of the EXPENSE, not of
// which account settled it) and does NOT post a ledger entry (the eventual
// cash/personal-card entry goes through the L1 propose path — a named
// follow-up slice, out of scope here).
//
// F3 (2026-07): the act-mode stamp reconciles the payload holder on EVERY
// verdict, not only auto_explain — a superseding chase_evidence/needs_human
// verdict REMOVES a stale settle object (audited, before_state carried) so
// the gap guards / ask gather / convergence / UI re-render off the fresh
// verdict row; a re-settle preserves an already-true owner_notified marker
// (no duplicate FYI). The one refusal: a settle whose settlement JOURNAL was
// already posted is never silently un-settled (doc/ledger split-brain) —
// that supersede is receipted 'document.disposition.supersede_blocked' and
// the ledger unwind is the F4 needs_ledger_adjustment follow-up.
//
// TRUST-THE-STRONG-LLM BOUNDARY (plan §4): no expense-kind allow/veto lists,
// no per-kind amount ceilings — receiptAutoExplain's `fuel`-on-a-never-list
// gate is exactly the weak-model-era pattern that would keep the canonical
// Exxon receipt hanging forever, and this module does NOT extend it. The
// deterministic Keep-layer guards that DO bind:
//   - auto_explain REQUIRES materiality 'immaterial'. A material
//     auto_explain would need a covering delegated-authority grant (the 040
//     substrate) to settle honestly; no doc-disposition grant archetype
//     exists yet (grants are match-shaped: A–D proof + archetype), so the
//     lookup is a named seam and the fail-closed result is a DOWNGRADE to
//     chase_evidence (on the owner) — never a silent settle, and never the
//     firm-click limbo.
//   - auto_explain below the confidence floor falls to needs_human (low
//     confidence stays proposed — visible, never posted).
//   - model/transport failure fails closed to needs_human.
//   - every verdict is receipted (evaluation row + audit, model id carried —
//     the model id is part of the receipt); the act-mode payload merge
//     records before_state in its audit event (reversible).
//
// MODE: 'shadow' writes ONLY the evaluation row (payload.matcher_mode
// 'shadow') so a week of verdicts can be read before anything acts; 'act'
// additionally merges the payload verdict Slice 1's UI + convergence metric
// render, on the auto_explain leg. Gating (the plane flag
// DOCUMENT_NO_LINE_DISPOSITION, envFallback false) lives in the caller
// (loopsShadowProducers.runDocumentTerminalDrain) — this module only takes
// the resolved mode. NEVER throws; per-doc failures fall toward a human.

import { extractJson } from './extractJson.js';
import { CASH_FUNDING_OWNER_QUESTION, jevDispositionEnabled, loadJevDispositionEvidence, decideJevDisposition, withJevHandoff } from './jevDisposition.js';
import {
  DEFAULT_MODEL,
  getApiKey,
  getModel,
  proposeMatchesViaAnthropic,
  recordReconciliationEvaluation,
  makeEvaluationId,
  loadFirmContext,
  formatFirmAnchor,
  formatKnownCounterparties
} from './reconciliationLlmCore.js';

import {
  getDispositionMaterialityPolicy,
  exceedsMaterialityCeiling
} from './dispositionMateriality.js';
import { resolveOpenAiCompatibleEndpoint } from './providerEndpoints.js';
import { toIsoDay } from './dates.js';
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
import { amountText, dayText } from './salesRecognitionGap.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

const LOG_TAG = 'documentDispositionLlm';

// Constants live in the dependency-free leaf (documentDispositionShape.js)
// so loopsShadowProducers' module-level gap-guard SQL can reference them
// without tripping the core ↔ firmDb ↔ loopsShadowProducers import cycle's
// TDZ. Re-exported here so importers/tests resolve them from the producer,
// mirroring bankLineDispositionLlm.js.
export {
  DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
  DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
  DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION,
  DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY
} from './documentDispositionShape.js';
import {
  DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
  DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
  DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION,
  NO_SETTLEMENT_OBLIGATION_TYPES
} from './documentDispositionShape.js';

// The reconcilable document kinds — LOCK-STEP with RECONCILABLE_DOCUMENT_KINDS
// in src/lib/documentsInbox.js (the Slice-1 selector this sweep drains).
// Server modules don't import src/lib here to keep this file's dependency
// profile identical to bankLineDispositionLlm.js; the lock-step is pinned by
// documentDispositionLlm.test.js against the src/lib export.
export const RECONCILABLE_DOC_TYPES = Object.freeze([
  'receipt',
  'supplier_bill',
  'sales_invoice',
  'issued_receipt',
  'payment_confirmation'
]);

const DISPOSITIONS = new Set(['auto_explain', 'chase_evidence', 'needs_human']);
// The owner-reply-only answer "it is still unpaid": never a verdict, never
// stamped. Valid only on a lane that accepts it (ownerReply.stillOpen).
export const OBLIGATION_OPEN = 'obligation_open';
// The owner-reply-only answers that settle a RECORD rather than a verdict,
// each valid only where the asking lane offers it (ownerReply.laneAnswers,
// salesRecognitionGap.noSettlementAskLaneAnswers):
//   - "credit_deducted": a supplier credit note was deducted from bill X (the
//     model names X in "deducted_from_bill"); recorded as a credit application;
//   - "shortfall_bank_fee": the payment's shortfall was a bank fee; recorded
//     on the match.
// A clear answer that cannot be recorded falls to the unclear path.
export const CREDIT_DEDUCTED = 'credit_deducted';
export const SHORTFALL_BANK_FEE = 'shortfall_bank_fee';
const laneAnswerOffered = (disposition, ownerReply) =>
  (disposition === CREDIT_DEDUCTED && Boolean(ownerReply?.laneAnswers?.creditDeducted))
  || (disposition === SHORTFALL_BANK_FEE && Boolean(ownerReply?.laneAnswers?.bankFee));
const MATERIALITIES = new Set(['immaterial', 'material']);
const SETTLEMENT_CHANNELS = new Set(['cash', 'personal_card', 'uncovered_account', 'unknown']);

// Policy-path transport law: N consecutive transport-class failures under a
// seated rung = a systemic endpoint/config problem — abort the sweep loudly
// (value mirrors bankLineDispositionLlm's).
const TRANSPORT_FAILURE_ABORT_THRESHOLD = 5;

// F5 — bound on MODEL CALLS per sweep. Re-entrant via the policy-version
// incremental guard (a capped sweep's remainder drains next tick); COUNTED
// (stats.truncated_remainder + a log line), never silent. Tuning knob
// (env-legitimate per the config-plane rail).
export const DEFAULT_DOCUMENT_DISPOSITION_SWEEP_LIMIT = 40;
const getSweepLimit = () => {
  const raw = Number(process?.env?.DOCUMENT_DISPOSITION_SWEEP_LIMIT);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_DOCUMENT_DISPOSITION_SWEEP_LIMIT;
};

// Keep-layer confidence floor for the SETTLING verdict only: an auto_explain
// below this falls to needs_human (visible), never a quiet settle. Tuning
// knob (env-legitimate per the config-plane rail): DOCUMENT_DISPOSITION_CONFIDENCE_FLOOR.
export const DEFAULT_AUTO_EXPLAIN_CONFIDENCE_FLOOR = 0.75;
export const getAutoExplainConfidenceFloor = () => {
  const raw = Number(process?.env?.DOCUMENT_DISPOSITION_CONFIDENCE_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_AUTO_EXPLAIN_CONFIDENCE_FLOOR;
};

// auto_explain settles the doc; both chase_evidence and needs_human ride a
// no_match verdict — the REASON distinguishes them downstream:
//   - 'evidence_needed' is in loopGoalRegistry's DISPOSITION_OWNER_ASK_REASONS,
//     so the gap case opens CLIENT-owned (on the owner) and Slice 3's ask leg
//     drafts the payment-method / statement question off it.
//   - 'document_needs_review' is deliberately NOT in that set: a needs_human
//     doc is a firm-side VIOLATION to surface (waiting_firm, hanging), never
//     laundered onto the owner with no ask they could answer.
const DISPOSITION_TO_VERDICT = Object.freeze({
  auto_explain: 'auto_explained',
  chase_evidence: 'no_match',
  needs_human: 'no_match'
});
const DISPOSITION_DEFAULT_REASON = Object.freeze({
  chase_evidence: 'evidence_needed',
  needs_human: 'document_needs_review'
});

// ── RT-10 (audit F-08) — the needs_human LANE ──────────────────────────────
//
// needs_human used to be a RESTING state: the verdict stamped, the doc
// surfaced in the violation section, and nothing drove it anywhere — the
// firm-side limbo the first principle forbids. It is now a TRANSITION with a
// named lane, decided in the SAME transaction as the verdict and carried on
// the verdict row's payload (`payload.lane`):
//
//   - a JUDGMENT needs_human (the model looked and could not dispose, or a
//     Keep-layer downgrade below the floor) → an OWNER ask, doc-anchored,
//     evidence_type 'business_purpose', through the ONE ask writer (open-ask
//     dedup per document, deterministic id, its own audit). Bounded: at most
//     OWNER_ASK_MAX_GENERATIONS such asks per document, ever — after that the
//     lane rests 'owner_ask_exhausted' (surfaced, never a third nag).
//   - a TECHNICAL needs_human (NO model judgment existed: no key, transport
//     error, unparseable reply, producer throw — the 2026-08-17 lesson: an ask
//     minted from an HTTP error is a question the owner cannot answer) → a
//     scheduled MACHINE re-run: the verdict carries `lane.machine_rerun` with a
//     due time, the sweep's incremental guard re-picks the doc once it is due,
//     and a `local_jobs` row for the drain function is enqueued at that time
//     so the appliance scheduler actually runs it (cloud: the hourly cron
//     does). Bounded to MACHINE_RERUN_MAX_ATTEMPTS; then
//     'machine_rerun_exhausted' — surfaced as the system failure it is.
//
// Ask existence is never plane-gated: the lane runs in shadow and act mode
// alike ("staging decides whether the match auto-reconciles, it must never
// decide whether the ask EXISTS" — the held-material lane's precedent).
export const TECHNICAL_NEEDS_HUMAN_REASONS = Object.freeze([
  'no_api_key', 'no_document', 'transport_error', 'producer_error',
  'invalid_llm_response', 'policy_model_mismatch', 'policy_endpoint_unconfigured'
]);
export const isTechnicalNeedsHuman = (semantic) => {
  if (!semantic || semantic.disposition !== 'needs_human') return false;
  const reason = String(semantic.unmatchable_reason || '');
  return TECHNICAL_NEEDS_HUMAN_REASONS.includes(reason) || reason.startsWith('api_error');
};
export const MACHINE_RERUN_MAX_ATTEMPTS = 3;
export const MACHINE_RERUN_BACKOFF_MS = Object.freeze([10 * 60_000, 60 * 60_000, 6 * 60 * 60_000]);
export const machineRerunDueAt = (attempt, nowMs = Date.now()) => {
  const idx = Math.max(0, Math.min((Number(attempt) || 1) - 1, MACHINE_RERUN_BACKOFF_MS.length - 1));
  return new Date(nowMs + MACHINE_RERUN_BACKOFF_MS[idx]).toISOString();
};
export const OWNER_ASK_MAX_GENERATIONS = 2;
export const NEEDS_HUMAN_ASK_EVIDENCE_TYPE = 'business_purpose';
const OWNER_QUESTION_FACTS = new Set(['business_purpose', 'payment_method', 'bank_statement', 'supporting_document']);
const ownerQuestionFact = semantic => semantic.owner_question && OWNER_QUESTION_FACTS.has(semantic.owner_question_evidence_type)
  ? semantic.owner_question_evidence_type : NEEDS_HUMAN_ASK_EVIDENCE_TYPE;
// The desktop manifest function the re-run rides (handlerManifest.js); its
// runner sweeps every enrolled client, and the guard re-picks the due doc.
export const DOCUMENT_DISPOSITION_RERUN_FUNCTION_ID = 'document-terminal-drain';

// The lane's two writers, lazily imported (the static chain
// documentDispositionLlm → firmDb is the TDZ cycle documentDispositionShape.js
// exists to avoid; firmDb itself lazy-imports this module the same way).
// A sweep OWNER / test injects `laneDeps` to override.
const defaultNeedsHumanLaneDeps = () => ({
  mintOwnerAsk: async (args) => (await import('./firmDb.js')).__createClientEvidenceRequestWithClient(args),
  enqueueRerun: async (args) => (await import('./desktop/localJobQueue.js')).enqueueLocalJob(args)
});

const moneyLabel = (amount, currency) => {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  return `${currency ? `${currency} ` : ''}${n.toFixed(2)}`;
};

// Finnish names for the document kinds the disposition lane asks about, in the
// words an owner uses for their own papers. Anything else is "tosite".
const FINNISH_DOCUMENT_KIND = Object.freeze({
  receipt: 'Kuitti',
  supplier_bill: 'Ostolasku',
  sales_invoice: 'Myyntilasku',
  issued_receipt: 'Myyntikuitti',
  payment_confirmation: 'Maksuvahvistus',
  credit_note: 'Hyvityslasku'
});

// The Finnish header names the counterparty, amount, date and file inside the
// brackets so nothing from the evidence has to be inflected:
// "Kuitti (Lumikki Oy, 41,20 EUR, päivätty 14.5.2025, kuitti.pdf)".
const finnishDocumentHeader = (document = {}, { money = true } = {}) => {
  const who = document.vendor_name || document.customer_name || '';
  const amount = money && Number.isFinite(Number(document.total_amount)) && document.total_amount !== null && document.total_amount !== ''
    ? amountText(document.total_amount, document.currency, 'fi') : '';
  const date = money && document.document_date ? `päivätty ${dayText(toIsoDay(document.document_date), 'fi')}` : '';
  const parts = [who, amount, date, document.filename || ''].filter(Boolean);
  const kind = FINNISH_DOCUMENT_KIND[document.document_type] || 'Tosite';
  return parts.length ? `${kind} (${parts.join(', ')})` : kind;
};

// The cash-funding guard's question, as the owner reads it. The stored fact
// stays the English CASH_FUNDING_OWNER_QUESTION (a receipt staff read).
const FINNISH_CASH_FUNDING_QUESTION = 'Kuitin mukaan se maksettiin käteisellä. Maksettiinko se yrityksen kassasta vai omista rahoistasi?';

// Preserve the model's actual missing fact and its lifecycle type. Internal
// reasoning is an audit receipt, not owner-facing prose. Legacy verdicts have
// only a business-purpose question; never invent an expense or payment premise.
// `language` is the owner's (preferredOwnerTemplateLanguage); the caller that
// holds the client profile passes it.
export const buildNeedsHumanOwnerQuestion = ({ document = {}, semantic = {}, language = 'en' } = {}) => {
  const modelQuestion = semantic.owner_question && OWNER_QUESTION_FACTS.has(semantic.owner_question_evidence_type)
    ? semantic.owner_question : null;
  if (language === 'fi') {
    const question = modelQuestion === CASH_FUNDING_OWNER_QUESTION ? FINNISH_CASH_FUNDING_QUESTION
      : modelQuestion || 'Mitä tämä tosite koskee, ja miten se liittyy yrityksesi toimintaan?';
    return `${finnishDocumentHeader(document)}: ${question}`;
  }
  const kind = String(document.document_type || 'document').replace(/_/g, ' ');
  const who = document.vendor_name || document.customer_name || '';
  const money = moneyLabel(document.total_amount, document.currency);
  const when = document.document_date ? ` dated ${toIsoDay(document.document_date)}` : '';
  const file = document.filename ? ` (${document.filename})` : '';
  const question = modelQuestion || 'What is this document for, and how does it relate to your business?';
  return `About the ${kind}${who ? ` from ${who}` : ''}${money ? ` for ${money}` : ''}${when}${file}: ${question}`;
};

// The bounded clarification after an UNCLEAR owner reply (the answer leg):
// one more ask, phrased for the lane that was answered, never a third.
export const buildOwnerReplyClarificationQuestion = ({ document = {}, answeredEvidenceType = 'payment_method', language = 'en' } = {}) => {
  if (language === 'fi') {
    const header = finnishDocumentHeader(document, { money: false });
    if (answeredEvidenceType === 'bank_statement') {
      return `${header}: Kiitos vastauksestasi! Emme vieläkään pystyneet päättelemään, miltä tililtä se maksettiin. Mikä pankki- tai korttitili se oli? Voisitko lähettää sen tilin tiliotteen kyseiseltä kaudelta?`;
    }
    return `${header}: Kiitos vastauksestasi! Emme pystyneet päättelemään vastauksestasi, miten se maksettiin. Maksettiinko se käteisellä, omalla kortillasi vai yrityksen tililtä, jonka tiliotteita meillä ei vielä ole?`;
  }
  const kind = String(document.document_type || 'document').replace(/_/g, ' ');
  const who = document.vendor_name || document.customer_name ? ` from ${document.vendor_name || document.customer_name}` : '';
  const file = document.filename ? ` (${document.filename})` : '';
  if (answeredEvidenceType === 'bank_statement') {
    return `Thanks — we still could not tell which account paid the ${kind}${who}${file}. Which bank or card account was it, and could you upload that account's statement for the period?`;
  }
  return `Thanks — we could not tell from your answer how the ${kind}${who}${file} was paid. Was it cash, a personal card, or a business account we don't yet have statements for?`;
};

// The owner's language for a question this lane mints: one profile read, at the
// mint, through the one resolver (the pure builders above take the result).
const readOwnerLanguage = async ({ client, firmId, clientId }) => {
  const row = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1', [firmId, clientId])).rows?.[0];
  return preferredOwnerTemplateLanguage(row?.profile, row);
};

const countOwnerAsksForDocument = async ({ client, firmId, clientId, documentId, evidenceType }) => {
  const result = await client.query(
    `select count(*)::int as n
       from client_evidence_requests
      where firm_id = $1 and client_id = $2
        and request_payload->>'document_id' = $3
        and evidence_type = $4
        and coalesce(audience, 'client') = 'client'`,
    [firmId, clientId, documentId, evidenceType]
  );
  return Number(result.rows?.[0]?.n || 0);
};

const readPriorDispositionLane = async ({ client, firmId, clientId, documentId }) => {
  const result = await client.query(
    `select payload->'lane' as lane
       from reconciliation_evaluations
      where firm_id = $1 and client_id = $2
        and target_type = $3 and target_id = $4 and matcher_family = $5
      limit 1`,
    [firmId, clientId, DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, documentId, DOCUMENT_NO_LINE_DISPOSITION_FAMILY]
  );
  const lane = result.rows?.[0]?.lane;
  return lane && typeof lane === 'object' ? lane : null;
};

// counterpartyRole for loadFirmContext (the same known-counterparties roster
// the family matchers render): money-out evidence names a supplier, money-in
// evidence names a customer.
const COUNTERPARTY_ROLE_BY_TYPE = Object.freeze({
  receipt: 'supplier',
  supplier_bill: 'supplier',
  payment_confirmation: 'supplier',
  sales_invoice: 'customer',
  issued_receipt: 'customer'
});
const MONEY_IN_TYPES = new Set(['sales_invoice', 'issued_receipt']);

const ZERO_STATS = () => ({
  evaluated: 0,
  auto_explained: 0,
  chase_evidence: 0,
  needs_human: 0,
  stamp_failures: 0,
  skipped_existing: 0,
  skipped_already_asked: 0,
  // Doc ids this sweep stamped a verdict on (for the caller's gap pass).
  evaluated_target_ids: [],
  // Doc ids the ACT-mode auto_explain leg settled this sweep (payload merged)
  // — the caller resolves any stale open gap case on these instead of opening.
  settled_doc_ids: [],
  // F5 — eligible docs this sweep did NOT evaluate because the per-sweep
  // model-call bound hit. Counted, never silent; the next sweep drains them.
  truncated_remainder: 0,
  // F3 — docs whose STALE auto_explain payload holder this sweep unwound
  // because a superseding non-settle verdict landed (the fresh verdict row
  // now drives the gap/ask/UI readers again).
  superseded: 0,
  // Policy-path transport law (mirrors bankLineDispositionLlm): transport-
  // class failures under a seated rung are counted + skipped (no stamp);
  // a model mismatch or a failure run aborts the sweep with the reason here.
  transport_failures: 0,
  aborted_reason: null,
  // RT-10 — where the needs_human verdicts went: an owner ask minted in the
  // stamp's transaction, a machine re-run scheduled, or a bound exhausted.
  owner_asks_minted: 0,
  reruns_scheduled: 0,
  lanes_exhausted: 0,
  mode: 'shadow',
  disabled: false,
  disabled_reason: null
});
const DISABLED_STATS = (reason) => ({ ...ZERO_STATS(), disabled: true, disabled_reason: reason });

const clampConfidence = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
};

// SAFE fallback — fails toward a human (a wrongly-settled doc is a silent
// misstatement; an extra violation row is recoverable).
const safeDisposition = (reason) => ({
  disposition: 'needs_human',
  downgraded_from: null,
  materiality: 'material',
  expense_kind: 'unknown',
  settlement_channel: 'unknown',
  confidence: 0,
  reasoning: '',
  materiality_ceiling: null,
  unmatchable_reason: reason || 'invalid_llm_response'
});

// Parse + validate the strong model's disposition JSON. NEVER throws.
// Deterministic Keep-layer guards (plan §4) applied in order:
//   1. material auto_explain → DOWNGRADE to chase_evidence (on the owner;
//      the delegated-authority-grant seam would go here — no doc-disposition
//      grant archetype exists yet, so the fail-closed branch always runs).
//   2. auto_explain below the confidence floor → needs_human (visible).
// A downgrade records the model's original call in `downgraded_from` so the
// receipt shows what the model said, not only what the guard allowed.
export const parseDocumentDispositionResponse = (text, {
  confidenceFloor = getAutoExplainConfidenceFloor(),
  // F1 Keep-layer ceiling — when provided, an UNPROMPTED-sweep auto_explain
  // above the ceiling downgrades to chase_evidence (on the owner) regardless
  // of the model's own materiality label. Deliberately NOT applied in
  // owner-reply mode: the ask was the material escalation and the owner's
  // answer resolves it (the parser's own mode comment below).
  amount = null,
  documentType = null,
  materialityCeiling = null,
  // RT-11b — WHERE the ceiling came from ('env' | 'pack:<id>' | 'unset'); the
  // ceiling is the client's pack value in the pack's home currency and the
  // compare is raw (the same currency-blind arithmetic as Gate E), so the
  // receipt names the source rather than hiding a rate table.
  materialityCeilingSource = null,
  // Slice 4a (docs/donna-settlement-answer-and-ledger-entry-plan.md §2):
  // owner-reply mode — `{ answeredEvidenceType }` when the model is reading
  // the OWNER'S ANSWER to a doc-anchored ask, null on the unprompted sweep.
  // The guard set changes because the escalation already happened:
  //   - the materiality veto LIFTS when the answer confirms the settlement
  //     channel (cash / personal_card) — the ask WAS the material escalation
  //     and the answer resolves it; downgrading to chase_evidence would
  //     re-ask what was just answered.
  //   - chase_evidence is allowed ONLY as the single lane change (a
  //     'payment_method' ask answered with an account we lack coverage of
  //     ⇒ 'uncovered_account', the statement lane). Anything else coerces
  //     to needs_human: an unclear answer is read by a HUMAN, never bounced
  //     back to the owner (ping-pong guard).
  //   - the confidence floor still binds (an unclear reply is needs_human,
  //     not a guessed settle).
  //   - "obligation_open" (the owner says it is still unpaid) is a valid
  //     answer ONLY where the asking lane accepts it (`ownerReply.stillOpen`,
  //     salesRecognitionGap's no-settlement lanes); anywhere else it is not a
  //     disposition and falls to needs_human like any unknown value.
  ownerReply = null
} = {}) => {
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    return safeDisposition('invalid_llm_response');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return safeDisposition('invalid_llm_response');
  }

  const disposition = DISPOSITIONS.has(parsed.disposition)
    || (parsed.disposition === OBLIGATION_OPEN && ownerReply?.stillOpen)
    || laneAnswerOffered(parsed.disposition, ownerReply) ? parsed.disposition : 'needs_human';
  const materiality = MATERIALITIES.has(parsed.materiality) ? parsed.materiality : 'material';
  const expense_kind = typeof parsed.expense_kind === 'string'
    ? parsed.expense_kind.replace(/[^a-z0-9_]/gi, '').slice(0, 40) || 'unknown'
    : 'unknown';
  const settlement_channel = SETTLEMENT_CHANNELS.has(parsed.settlement_channel)
    ? parsed.settlement_channel
    : 'unknown';
  const confidence = clampConfidence(parsed.confidence);
  const reasoning = typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 280) : '';

  let safe = disposition;
  let downgraded_from = null;
  let coercedReason = null;
  if (!ownerReply) {
    if (disposition === 'auto_explain'
        && (materiality !== 'immaterial' || exceedsMaterialityCeiling(amount, materialityCeiling))) {
      // Material by the model's own label OR by the deterministic amount
      // ceiling (F1) — either way the settle is refused and the doc goes to
      // the owner. The ceiling half is the Keep-layer guard the model's
      // self-reported materiality can't override.
      safe = 'chase_evidence';
      downgraded_from = 'auto_explain';
    } else if (disposition === 'auto_explain' && confidence < confidenceFloor) {
      safe = 'needs_human';
      downgraded_from = 'auto_explain';
    }
  } else {
    const confirmedChannel = settlement_channel === 'cash' || settlement_channel === 'personal_card';
    if (disposition === 'auto_explain' && materiality !== 'immaterial' && !confirmedChannel) {
      safe = 'needs_human';
      downgraded_from = 'auto_explain';
      coercedReason = 'owner_reply_unclear';
    } else if (disposition === 'auto_explain' && confidence < confidenceFloor) {
      safe = 'needs_human';
      downgraded_from = 'auto_explain';
      coercedReason = 'owner_reply_unclear';
    } else if ((disposition === OBLIGATION_OPEN || disposition === CREDIT_DEDUCTED || disposition === SHORTFALL_BANK_FEE) && confidence < confidenceFloor) {
      safe = 'needs_human';
      downgraded_from = disposition;
      coercedReason = 'owner_reply_unclear';
    } else if (disposition === CREDIT_DEDUCTED && !String(parsed.deducted_from_bill || '').replace(/[^a-z0-9]/gi, '')) {
      // "Deducted" without a bill Donna can look up is not recordable.
      safe = 'needs_human';
      downgraded_from = CREDIT_DEDUCTED;
      coercedReason = 'owner_reply_unclear';
    } else if (disposition === 'chase_evidence') {
      const laneChange = ownerReply.answeredEvidenceType === 'payment_method'
        && settlement_channel === 'uncovered_account';
      if (!laneChange) {
        safe = 'needs_human';
        downgraded_from = 'chase_evidence';
        coercedReason = 'owner_reply_unclear';
      }
    }
  }

  // A credit note has no business purpose of its own: it corrects an invoice.
  // Its owner question is about settlement (which invoice it reduces, or a
  // refund), so it is a payment_method fact that the credit application
  // answers; labelled business_purpose it would outlive its own settlement.
  if (documentType === 'credit_note' && parsed.owner_question_evidence_type === 'business_purpose') {
    parsed.owner_question_evidence_type = 'payment_method';
    parsed.owner_question_evidence_type_coerced_from = 'business_purpose';
  }
  const funding_source = settlement_channel === 'personal_card' ? 'owner'
    : ['owner','company_cash'].includes(parsed.funding_source) ? parsed.funding_source : 'unknown';
  if (safe === 'auto_explain' && settlement_channel === 'cash' && funding_source === 'unknown' && !MONEY_IN_TYPES.has(documentType)) {
    safe = 'needs_human';
    parsed.owner_question = CASH_FUNDING_OWNER_QUESTION;
    parsed.owner_question_evidence_type = 'payment_method';
  }
  return {
    funding_source,
    disposition: safe,
    // The bill the owner named, as printed (bounded); read only on that answer.
    ...(safe === CREDIT_DEDUCTED ? { deducted_from_bill: String(parsed.deducted_from_bill).trim().slice(0, 40) } : {}),
    downgraded_from,
    materiality,
    expense_kind,
    settlement_channel,
    confidence,
    reasoning,
    ...(typeof parsed.owner_question === 'string' && parsed.owner_question.trim()
      && OWNER_QUESTION_FACTS.has(parsed.owner_question_evidence_type)
      ? { owner_question: parsed.owner_question.trim(), owner_question_evidence_type: parsed.owner_question_evidence_type,
        ...(parsed.owner_question_evidence_type_coerced_from ? { owner_question_evidence_type_coerced_from: parsed.owner_question_evidence_type_coerced_from } : {}) } : {}),
    // Receipted only when the ceiling actually bound this verdict — the
    // owner-reply leg is exempt, so its receipts honestly carry null.
    materiality_ceiling: !ownerReply && Number.isFinite(materialityCeiling) ? materialityCeiling : null,
    materiality_ceiling_source: !ownerReply && materialityCeiling != null ? (materialityCeilingSource ?? null) : null,
    unmatchable_reason: parsed.unmatchable_reason
      ? String(parsed.unmatchable_reason).slice(0, 80)
      : coercedReason
  };
};

const SYSTEM_PROMPT = `You triage a single parsed evidence DOCUMENT (a receipt, supplier bill, sales invoice, issued receipt, or payment confirmation) for a bookkeeping firm's client.

The reconciliation matchers have already run and found NO bank line for this document in the client's bank feed. Your job is to decide how a competent bookkeeper, with this firm's context, would dispose of the document. You are NOT matching it to anything.

Choose exactly one disposition:
- "auto_explain": the document is a self-explanatory, immaterial business expense (or receipt of funds) that was clearly settled OUTSIDE the bank feed you can see — paid in cash, on the owner's personal card, or through an account whose statement simply hasn't been uploaded yet. This identifies settlement only; the books are complete only after a settlement journal. For cash, establish funding_source as owner or company_cash; a CASH label alone does not establish whose money it was. If unknown, use needs_human with a payment_method owner question asking whose cash paid it; if its statement line ever arrives it will attach on its own. Use this ONLY when the amount is immaterial AND the document is clearly identifiable AND clearly business.
- "chase_evidence": only the business OWNER can resolve it — the bookkeeper would ask "how was this paid: cash, a personal card, or a card/account we should have a statement for?", or would request the statement of a specific account the firm doesn't have coverage of. Material amounts with no visible settlement are the strongest signal.
- "needs_human": anything ambiguous, possibly personal, possibly a duplicate, an unusual amount for the vendor, or otherwise unclear. The default whenever you are not confident.

Also name where you think it settled:
- "settlement_channel": "cash" | "personal_card" | "uncovered_account" | "unknown". Use "uncovered_account" when the bank-feed coverage summary implies the paying account's statement is missing (e.g. the document's date falls outside the covered range, or a known card account isn't in the feed).

Discipline (both failure directions are real):
- Do NOT "auto_explain" to clear the queue. A wrongly explained personal charge or duplicate is a silent misstatement.
- Do NOT "chase_evidence"/"needs_human" a textbook small cash receipt the firm clearly does not need the owner to narrate — that is materiality-blind over-asking.
- "Waiting for the statement" is NOT an answer — decide now: confident it settled outside the visible feed ⇒ auto_explain; the owner must say (or upload) ⇒ chase_evidence.

Output a single JSON object with this exact shape, nothing else:
{
  "disposition": "auto_explain" | "chase_evidence" | "needs_human",
  "materiality": "immaterial" | "material",
  "expense_kind": "<short snake_case kind, e.g. fuel, software_subscription, or unknown>",
  "settlement_channel": "cash" | "personal_card" | "uncovered_account" | "unknown",
  "funding_source": "owner" | "company_cash" | "unknown",
  "confidence": 0.0,
  "reasoning": "One sentence. Do NOT repeat the raw document text verbatim.",
  "owner_question": "For needs_human, the precise missing fact only the owner can supply; otherwise empty.",
  "owner_question_evidence_type": "business_purpose" | "payment_method" | "bank_statement" | "supporting_document"
}

Rules:
- For needs_human, write one complete owner-facing question grounded in the supplied evidence, naming the document rather than internal candidate handles. Do not ask about facts or files already supplied. Choose the evidence type for THAT fact: payment_method for how a document settled (including credit application), business_purpose only for its business relationship or use, bank_statement for a missing account statement, supporting_document for another missing source. A sales invoice or credit note is not a purchase expense. Keep internal reasoning separate from the question.
- "auto_explain" REQUIRES "materiality": "immaterial". If it is material, it is at most "chase_evidence".
- confidence is 0..1: how sure a competent bookkeeper would be of this disposition given only the document header + firm context.
- Return ONLY valid JSON. No markdown, no commentary.`;

// The language of the one owner-facing field (askPipeline's drafter rule):
// `language` is the owner's (preferredOwnerTemplateLanguage), carried on
// firmContext.ownerLanguage by the caller that read the client profile. It
// governs only how owner_question is WRITTEN; the decision, the answer shape
// and every other field are untouched. Absent ⇒ the prompt is the historical
// one, byte for byte.
export const ownerQuestionLanguageInstruction = (language) => (language ? `

Owner language: "${language}" (ISO 639-1; "fi" = Finnish, "en" = English). The business owner reads "owner_question", so write that question entirely in this language, in plain everyday words (in Finnish, the informal sinä form). Keep amounts, currencies, dates, counterparty and company names, filenames and document identifiers exactly as they appear in the input. Every other field, including "reasoning", stays in English. The language changes nothing about what you decide.` : '');
export const buildDocumentDispositionSystemPrompt = ({ ownerLanguage = null } = {}) =>
  `${SYSTEM_PROMPT}${ownerQuestionLanguageInstruction(ownerLanguage)}`;

// Pure prompt builder: the parsed document HEADER (never raw content —
// INV-12-adjacent PII discipline: extracted fields only) + the firm context
// the bank-line producer renders (identity anchor, known counterparties) +
// the doc-specific signal the fork turns on: the client's bank-feed COVERAGE
// (does the feed even span this document's date?).
export const buildDocumentDispositionUserPrompt = ({ document, firmContext = null } = {}) => {
  const sections = [];
  const amount = Number(document?.total_amount ?? 0);
  const direction = MONEY_IN_TYPES.has(document?.document_type) ? 'money_in' : 'money_out';
  sections.push(`Document (no committed settlement; inspect supplied bank candidates before concluding no payment exists):
  id=${document?.id || ''}
  type=${document?.document_type || 'unknown'} (direction=${direction})
  counterparty="${document?.vendor_name || document?.customer_name || ''}"
  amount=${Number.isFinite(amount) ? amount : 0} ${document?.currency || ''}
  date=${document?.document_date || 'unknown'}
  payment_status=${document?.payment_status || 'unknown'}
  filename="${document?.filename || ''}"`);

  const coverage = firmContext?.bankFeedCoverage;
  if (coverage && coverage.lineCount > 0) {
    sections.push(`Client's bank-feed coverage (the lines the matchers searched):
  ${coverage.lineCount} bank lines from ${coverage.firstDate || 'unknown'} to ${coverage.lastDate || 'unknown'}.
  If this document's date falls INSIDE that range and still has no line, it likely settled outside the visible feed (cash / personal card / an uncovered account). If it falls OUTSIDE the range, the covering statement may simply be missing.`);
  } else {
    sections.push(`Client's bank-feed coverage: NO bank lines uploaded yet — the matchers had nothing to search. A missing statement is the likeliest gap.`);
  }

  const role = COUNTERPARTY_ROLE_BY_TYPE[document?.document_type] || 'supplier';
  const firmAnchor = formatFirmAnchor(
    firmContext?.clientIdentity,
    direction === 'money_in'
      ? 'This document evidences money the firm RECEIVED (or invoiced). The counterparty is whoever pays the firm — never the firm itself.'
      : 'This document evidences money the firm PAID (or owes). The counterparty is whoever the firm paid — never the firm itself.'
  );
  if (firmAnchor) sections.push(firmAnchor);

  const knownCounterparties = formatKnownCounterparties(
    firmContext?.knownCounterparties,
    role === 'customer'
      ? { noun: 'customers', verb: 'invoices', selfNoun: 'an unrelated party' }
      : { noun: 'suppliers', verb: 'pays', selfNoun: 'an unrelated party' }
  );
  if (knownCounterparties) sections.push(knownCounterparties);

  return sections.join('\n\n');
};

// Slice 4a (docs/donna-settlement-answer-and-ledger-entry-plan.md §2) — the
// ANSWER-leg prompt: the owner has replied to a doc-anchored ask; the model
// reads the answer and disposes. Same output shape as the sweep prompt so
// the parser is shared; the guard differences live in the parser's
// owner-reply mode, not in trusting the model less.
// The asking lane may accept "it is still unpaid" as an answer
// (salesRecognitionGap's stillOpen); the model is told so, and what it means
// on that lane. Without it the prompt is the historical one, byte for byte.
export const buildOwnerReplySystemPrompt = ({ stillOpen = null, laneAnswers = null } = {}) => {
  const stillOpenLine = stillOpen
    ? `- "obligation_open": the owner says it is STILL UNPAID, i.e. ${stillOpen.meaning}. The question invited exactly this answer, so it is a clear, valid answer in any wording or language ("still unpaid", "not paid yet", "vielä maksamatta", "ei oo vielä maksettu"); it is not unclear and it settles nothing. Use "settlement_channel": "unknown". A partial payment, a dispute, or a payment the owner cannot place is not this; it is "needs_human".\n`
    : '';
  // The lane's record-settling answers (salesRecognitionGap.noSettlementAskLaneAnswers).
  const creditLine = laneAnswers?.creditDeducted
    ? `- "${CREDIT_DEDUCTED}": the owner says ${laneAnswers.creditDeducted.meaning}. The question invited exactly this answer. Put the bill's number exactly as the owner wrote it in "deducted_from_bill" (e.g. "4730"). Use it only when the owner names one bill; "deducted, I think" with no bill, or two bills, is "needs_human".\n`
    : '';
  const feeLine = laneAnswers?.bankFee
    ? `- "${SHORTFALL_BANK_FEE}": the owner says ${laneAnswers.bankFee.meaning}. The question invited exactly this answer, in any wording or language ("bank fee", "pankin palvelumaksu", "pankkikulu", "the bank took it").\n`
    : '';
  const extraDispositions = [stillOpen ? OBLIGATION_OPEN : null, laneAnswers?.creditDeducted ? CREDIT_DEDUCTED : null,
    laneAnswers?.bankFee ? SHORTFALL_BANK_FEE : null].filter(Boolean).map((d) => ` | "${d}"`).join('');
  return `You triage a single parsed evidence DOCUMENT (a receipt, supplier bill, sales invoice, issued receipt, or payment confirmation) for a bookkeeping firm's client.

The reconciliation matchers found NO bank line for this document, the firm asked the business OWNER how it settled, and the owner has now ANSWERED. Your job is to read the owner's answer and dispose of the document.

The owner's word is authoritative evidence about how the document was paid. A clear answer like "cash" or "on my own card" settles the question EVEN FOR A MATERIAL AMOUNT — the ask was the escalation, and the answer resolves it.

Choose exactly one disposition:
- "auto_explain": the owner's answer clearly confirms the document settled OUTSIDE the visible bank feed — paid in cash ("settlement_channel": "cash") or on a personal card / with personal funds ("personal_card"). Take a clear statement at its word; do not second-guess it.
- "chase_evidence": ONLY when the owner's answer names a business account or card whose statement the firm does not have — "settlement_channel" MUST be "uncovered_account" (this becomes a statement request). NEVER use this to re-ask how the document was paid.
- "needs_human": the answer is unclear, contradictory, off-topic, or raises something a bookkeeper must read (e.g. "that was personal", "I think you have that twice", a dispute).
${stillOpenLine}${creditLine}${feeLine}
Output a single JSON object with this exact shape, nothing else:
{
  "disposition": "auto_explain" | "chase_evidence" | "needs_human"${extraDispositions},${laneAnswers?.creditDeducted ? '\n  "deducted_from_bill": "<the bill number the owner named, only with ' + CREDIT_DEDUCTED + '>",' : ''}
  "materiality": "immaterial" | "material",
  "expense_kind": "<short snake_case kind, e.g. fuel, software_subscription, or unknown>",
  "settlement_channel": "cash" | "personal_card" | "uncovered_account" | "unknown",
  "funding_source": "owner" | "company_cash" | "unknown",
  "confidence": 0.0,
  "reasoning": "One sentence. Do NOT repeat the raw document text or the owner's answer verbatim."
}

Rules:
- A cash answer must also identify whose funds paid it; if unknown ask that precise missing fact. A clear personally funded cash / personal-card answer ⇒ "auto_explain" with the matching settlement_channel, even if "materiality" is "material".
- "materiality" still reports your honest read of the amount — do not shade it to fit the disposition.
- confidence is 0..1: how clearly the owner's answer resolves the question.
- Return ONLY valid JSON. No markdown, no commentary.`;
};
const OWNER_REPLY_SYSTEM_PROMPT = buildOwnerReplySystemPrompt();

// The reply is OWNER-authored content headed to the model — pass it verbatim
// (it is the evidence being read) but bounded, and never echo it back into
// receipts (the parser truncates reasoning; prompts are not persisted).
const OWNER_REPLY_MAX_CHARS = 600;

export const buildOwnerReplyUserPrompt = ({
  document,
  firmContext = null,
  askedQuestion = '',
  answeredEvidenceType = 'payment_method',
  ownerReply = '',
  replyDocumentCount = 0
} = {}) => {
  const base = buildDocumentDispositionUserPrompt({ document, firmContext });
  const reply = String(ownerReply || '').slice(0, OWNER_REPLY_MAX_CHARS);
  const lines = [
    `The firm asked (${answeredEvidenceType || 'payment_method'} lane): "${String(askedQuestion || '').slice(0, 300)}"`,
    reply
      ? `The owner answered: "${reply}"`
      : 'The owner answered with NO text.'
  ];
  const docCount = Number(replyDocumentCount) || 0;
  if (docCount > 0) {
    lines.push(`The owner also uploaded ${docCount} document(s) with the answer — they will be parsed and matched separately; do not wait for them.`);
  }
  return `${base}\n\nOwner's answer to the firm's question:\n  ${lines.join('\n  ')}`;
};

// One strong-model call → a disposition. Shared Anthropic transport from the
// core, this module's parser. NEVER throws; safe fallback on every failure.
export const proposeDocumentDisposition = async ({
  document,
  firmContext = null,
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl,
  // Q7 shape (the #1748 follow-up, 2026-08-19): the resolved deciding
  // transport when a policy seats a non-claude rung. With a transport the
  // Anthropic key is not required — the core rides the compatible endpoint.
  transport = null,
  jevEnabled = false
} = {}) => {
  if (jevEnabled) {
    const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: firmContext?.clientIdentity?.jurisdiction ?? null });
    const amount = Number(document?.total_amount ?? 0);
    const chosen = await decideJevDisposition({ provider:firmContext?.jevProvider, kind: 'document', direction: MONEY_IN_TYPES.has(document?.document_type) ? 'money_in' : 'money_out', amount, materialityCeiling: materialityPolicy.ceiling, fetchImpl,
      observation: { summary: buildDocumentDispositionUserPrompt({ document: { ...document, id: 'document_1' }, firmContext }), extracted_summary: document?.parse_summary || null }, localEvidence: firmContext?.localEvidence });
    if (!chosen.needsReasoning) return { ...parseDocumentDispositionResponse(JSON.stringify(chosen.semantic), { confidenceFloor: 0, documentType:document?.document_type, amount, materialityCeiling: materialityPolicy.ceiling, materialityCeilingSource: materialityPolicy.source }),
      model: chosen.semantic.model, model_source: 'response', decision_engine: 'jev', jev_first: chosen.receipt };
    const next = await proposeDocumentDisposition({ document, firmContext, apiKey, model, fetchImpl, transport });
    return withJevHandoff(isTechnicalNeedsHuman(next) ? { ...next, transport_failure: true } : next, chosen.receipt);
  }
  if (!apiKey && !transport) return safeDisposition('no_api_key');
  if (!document || !document.id) return safeDisposition('no_document');

  const userPrompt = buildDocumentDispositionUserPrompt({ document, firmContext })
    + (firmContext?.localEvidence ? `\nExtracted focal document: ${JSON.stringify(document?.parse_summary || {})}\nLocal evidence inventory: ${JSON.stringify(firmContext.localEvidence)}` : '');
  // F1 — the deterministic ceiling the parser applies to any unprompted-sweep
  // auto_explain (the amount is the document's own total, the same number the
  // prompt renders).
  const docAmount = Number(document?.total_amount ?? 0);
  // RT-11b — the ceiling follows the client's pack (home currency), resolved
  // from the same clientIdentity the firm anchor renders; env is the only
  // override; no pack ⇒ the unset marker and the guard fails closed.
  const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: firmContext?.clientIdentity?.jurisdiction ?? null });
  const materialityCeiling = materialityPolicy.ceiling;
  try {
    const result = await proposeMatchesViaAnthropic({
      systemPrompt: buildDocumentDispositionSystemPrompt({ ownerLanguage: firmContext?.ownerLanguage }),
      userPrompt,
      candidateBankLines: [],
      model,
      apiKey,
      fetchImpl,
      parse: (text) => parseDocumentDispositionResponse(text, { documentType:document?.document_type, amount: docAmount, materialityCeiling, materialityCeilingSource: materialityPolicy.source }),
      logTag: LOG_TAG,
      // llmCall requires a typed execution root; this call rides the
      // reconciliation_reasoning lane (same as the family matchers).
      transport: transport
        ? { ...transport, execution: transport.execution || { root: { type: 'reconciliation_reasoning', id: document.id } } }
        : null
    });
    // Defensive normalization: anything that isn't a valid disposition
    // object (the core's shape can shift under it) collapses safe. Non-OK
    // transport THROWS inside the core (retry-then-throw) and lands in the
    // catch below as 'transport_error'.
    if (!result || !DISPOSITIONS.has(result.disposition)) {
      return safeDisposition(result?.unmatchable_reason || 'invalid_llm_response');
    }
    return result;
  } catch (error) {
    console.error(`[${LOG_TAG}] disposition call threw`, {
      document_id: document.id,
      error: error?.message || String(error)
    });
    // The #1711 mismatch guard: the reply came from a model the policy did
    // not name — marked so the sweep ABORTS with nothing stamped (never
    // laundered as transport, never a needs_human under the requested id).
    if (error?.code === 'POLICY_MODEL_MISMATCH') {
      return { ...safeDisposition('policy_model_mismatch'), transport_failure: true, model_mismatch: true };
    }
    // On the POLICY path a transport-class throw is marked (no model judgment
    // existed — the sweep skips the stamp, the incremental guard re-picks).
    // The KEYED path keeps its historical fail-closed-to-needs_human stamp:
    // a transport-class failure (a typed provider failure since 2026-09-13,
    // the same event as before) is a TECHNICAL needs_human that RT-10 routes
    // to a bounded MACHINE re-run — never an owner question — and the
    // convergence projection names it (`disposition:needs_human:machine_rerun`).
    // That lane IS the keyed path's recovery worker; widening it is its own
    // slice.
    return transport
      ? { ...safeDisposition('transport_error'), transport_failure: true }
      : safeDisposition('transport_error');
  }
};

// Audit-as-precondition writer (audit_events, 001 schema; G2 PR-12 — the
// tracked bestEffort follow-up, flipped). Runs inside the caller's
// transaction (the sweep's per-doc mini-transaction / the answer leg's
// stamp+resolve txn), so the receipt commits WITH the verdict it describes —
// and a failed audit now THROWS (tagged `auditPrecondition`) so that
// transaction rolls back: a verdict can no longer commit without its
// receipt. The callers' txn handlers own the rollback + the per-doc
// failure accounting (the doc falls to the next sweep).
const auditDispositionEvent = async ({ client, firmId, clientId, action, documentId, metadata }) => {
  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', null, $3, 'document', $4, $5::jsonb)`,
      [firmId, clientId, action, documentId, JSON.stringify(metadata || {})]
    );
    return true;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.auditPrecondition = true;
    console.error(`[${LOG_TAG}] audit write failed — failing the disposition transaction`, {
      document_id: documentId,
      action,
      error: failure.message
    });
    throw failure;
  }
};

// Stamp one document's verdict (+ act-mode payload merge + audits).
// Slice 4a additive params (sweep call sites unchanged, byte-identical):
//   extraReceipt      — extra keys merged into the disposition receipt (both
//                       the evaluation payload and the payload merge), e.g.
//                       { settled_by: 'owner_reply', evidence_request_id }.
//   ownerNotified     — the FYI marker seed. The sweep seeds false (the
//                       decide-and-notify digest FYI is owed); an
//                       owner-CONFIRMED settle seeds true — the owner's own
//                       answer is the notification (plan §2, decision #1).
//   settleAuditAction — the settle audit's action name; the answer leg
//                       writes 'document.disposition.owner_confirmed'.
// RT-10 — decide the needs_human lane (owner ask / machine re-run / an
// exhausted bound), writing the lane's own receipts, inside the caller's
// transaction. Returns the lane object the verdict payload carries. Throws
// on a failed mint or audit so the per-doc transaction rolls back: a
// needs_human verdict cannot commit without its lane.
const resolveNeedsHumanLane = async ({
  client, firmId, clientId, document, semantic, mode, evaluationId, laneDeps = null,
  // The owner language the sweep already read for the prompt; absent ⇒ read here.
  ownerLanguage = null
}) => {
  const deps = { ...defaultNeedsHumanLaneDeps(), ...(laneDeps || {}) };
  const reason = semantic.unmatchable_reason || DISPOSITION_DEFAULT_REASON.needs_human;
  const now = new Date().toISOString();
  if (isTechnicalNeedsHuman(semantic)) {
    const prior = await readPriorDispositionLane({ client, firmId, clientId, documentId: document.id });
    const priorAttempt = prior?.kind === 'machine_rerun' ? (Number(prior.attempt) || 0) : 0;
    const attempt = priorAttempt + 1;
    if (attempt > MACHINE_RERUN_MAX_ATTEMPTS) {
      const lane = { kind: 'machine_rerun_exhausted', attempts: priorAttempt, reason, exhausted_at: now };
      await auditDispositionEvent({
        client, firmId, clientId,
        action: 'document.disposition.machine_rerun_exhausted',
        documentId: document.id,
        metadata: { lane, evaluation_id: evaluationId, matcher_mode: mode }
      });
      return lane;
    }
    const dueAt = machineRerunDueAt(attempt);
    let jobId = null;
    try {
      const job = await deps.enqueueRerun({
        client,
        functionId: DOCUMENT_DISPOSITION_RERUN_FUNCTION_ID,
        runAt: dueAt,
        dedupeKey: `machine-rerun:${DOCUMENT_NO_LINE_DISPOSITION_FAMILY}:${document.id}:${attempt}`,
        payload: {
          firm_id: firmId, client_id: clientId,
          target_type: DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, target_id: document.id,
          attempt, reason
        },
        maxAttempts: 1
      });
      jobId = job?.id ?? null;
    } catch (error) {
      // The persisted lane + the guard still re-run it on the next sweep;
      // the job row is the appliance's timing receipt, not the lane itself.
      console.warn(`[${LOG_TAG}] machine re-run enqueue failed (the due lane still re-picks on the next sweep)`, {
        document_id: document.id,
        error: error?.message || String(error)
      });
    }
    const lane = {
      kind: 'machine_rerun', attempt, max_attempts: MACHINE_RERUN_MAX_ATTEMPTS,
      due_at: dueAt, reason, function_id: DOCUMENT_DISPOSITION_RERUN_FUNCTION_ID, job_id: jobId, scheduled_at: now
    };
    await auditDispositionEvent({
      client, firmId, clientId,
      action: 'document.disposition.machine_rerun_scheduled',
      documentId: document.id,
      metadata: { lane, evaluation_id: evaluationId, matcher_mode: mode }
    });
    return lane;
  }
  const evidenceType = ownerQuestionFact(semantic);
  const generations = await countOwnerAsksForDocument({
    client, firmId, clientId, documentId: document.id, evidenceType
  });
  if (generations >= OWNER_ASK_MAX_GENERATIONS) {
    const lane = { kind: 'owner_ask_exhausted', asks: generations, reason, exhausted_at: now };
    await auditDispositionEvent({
      client, firmId, clientId,
      action: 'document.disposition.owner_ask_exhausted',
      documentId: document.id,
      metadata: { lane, evaluation_id: evaluationId, matcher_mode: mode }
    });
    return lane;
  }
  const mintOutcome = {};
  const request = await deps.mintOwnerAsk({
    client,
    firmId,
    clientId,
    documentId: document.id,
    question: buildNeedsHumanOwnerQuestion({ document, semantic, language: ownerLanguage || await readOwnerLanguage({ client, firmId, clientId }) }),
    evidenceType,
    actorId: 'system',
    requestContext: {
      lane: 'needs_human_disposition',
      disposition: 'needs_human',
      unmatchable_reason: reason,
      evaluation_id: evaluationId,
      matcher_mode: mode
    },
    mintOutcome
  });
  const lane = {
    kind: 'owner_ask',
    evidence_request_id: request?.id || null,
    evidence_type: evidenceType,
    minted: mintOutcome.minted ?? null,
    minted_at: now
  };
  await auditDispositionEvent({
    client, firmId, clientId,
    action: 'document.disposition.owner_asked',
    documentId: document.id,
    metadata: { lane, evaluation_id: evaluationId, matcher_mode: mode }
  });
  return lane;
};

const stampDocumentDisposition = async ({
  client, firmId, clientId, document, semantic, model, mode,
  extraReceipt = null,
  ownerNotified = false,
  settleAuditAction = 'document.disposition.auto_explained',
  // RT-10 — the needs_human lane: 'sweep' decides it here (owner ask or
  // machine re-run, same txn); 'owner_reply' defers to the answer leg,
  // which must resolve the answered request FIRST (else the writer's
  // open-ask dedup would collapse the clarification onto it).
  needsHumanLane = 'sweep',
  laneDeps = null,
  ownerLanguage = null
}) => {
  const verdict = DISPOSITION_TO_VERDICT[semantic.disposition] || 'no_match';
  const reason = semantic.unmatchable_reason || DISPOSITION_DEFAULT_REASON[semantic.disposition] || null;
  const evaluationId = makeEvaluationId({
    clientId,
    targetType: DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
    targetId: document.id,
    matcherFamily: DOCUMENT_NO_LINE_DISPOSITION_FAMILY
  });
  let lane = null;
  if (semantic.disposition === 'needs_human' && needsHumanLane === 'sweep') {
    lane = await resolveNeedsHumanLane({ client, firmId, clientId, document, semantic, mode, evaluationId, laneDeps, ownerLanguage });
  }
  const dispositionReceipt = {
    // RT-10: the lane a needs_human verdict took (owner_ask / machine_rerun /
    // an exhausted bound) — absent on every other disposition.
    ...(lane ? { lane } : {}),
    policy_version: DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION,
    disposition: semantic.disposition,
    downgraded_from: semantic.downgraded_from || null,
    materiality: semantic.materiality,
    // F1 receipt half — the resolved deterministic ceiling in force for this
    // verdict (null on the owner-reply leg, where no ceiling binds).
    materiality_ceiling: semantic.materiality_ceiling ?? null,
    materiality_ceiling_source: semantic.materiality_ceiling_source ?? null,
    expense_kind: semantic.expense_kind,
    settlement_channel: semantic.settlement_channel,
    funding_source: semantic.funding_source || null,
    confidence: semantic.confidence,
    reasoning: semantic.reasoning || '',
    ...(semantic.jev_first ? { decision_engine: semantic.decision_engine, jev_first: semantic.jev_first } : {}),
    // The #1748-shape policy receipt — present ONLY under a seated rung, so
    // no-policy receipts stay byte-identical. model_source carries the
    // provenance class the core stamped (response-proven vs requested).
    ...(semantic.policy_basis
      ? { policy_basis: semantic.policy_basis, policy_model: semantic.policy_model || null, model_source: semantic.model_source || null }
      : {}),
    ...(extraReceipt || {})
  };
  const stamped = await recordReconciliationEvaluation({
    client,
    firmId,
    clientId,
    targetType: DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
    targetId: document.id,
    matcherFamily: DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
    verdict,
    unmatchableReason: reason,
    proposalCount: 0,
    candidateCount: 1,
    eligibleCount: 1,
    // The provider-RETURNED model id when the call reached the provider
    // (the receipt); the requested string on the safe error paths.
    model: semantic.model || model,
    payload: { ...dispositionReceipt, matcher_mode: mode },
    logTag: LOG_TAG
  });

  await auditDispositionEvent({
    client, firmId, clientId,
    action: 'document.disposition.evaluated',
    documentId: document.id,
    metadata: {
      ...dispositionReceipt,
      verdict,
      unmatchable_reason: reason,
      matcher_mode: mode,
      model: semantic.model || model,
      evaluation_id: evaluationId
    }
  });

  // The payload-merge reconciliation — ACT mode reconciles the persisted
  // no_line_disposition holder on EVERY verdict (F3: the merge used to be
  // written only on auto_explain and removed by nothing, a one-way ratchet a
  // superseding chase_evidence/needs_human verdict could never unwind — the
  // stale settle then blocked the gap guards, the ask gather, and the UI
  // forever). Shadow mode never touches the document. before_state rides
  // every audit event (reversibility: restore the prior sub-object — or its
  // absence — to undo).
  let settled = false;
  let superseded = false;
  if (mode === 'act') {
    try {
      const prior = await client.query(
        `select payload->'no_line_disposition' as before_state,
                coalesce(payload->'settlement_entry'->>'journal_id', '') as settlement_journal_id
           from documents where id = $1 and firm_id = $2 and client_id = $3`,
        [document.id, firmId, clientId]
      );
      if (prior.rows.length) {
        const beforeState = prior.rows[0]?.before_state ?? null;
        const settlementJournalId = prior.rows[0]?.settlement_journal_id || '';
        if (semantic.disposition === 'auto_explain') {
          // The settling merge — the persisted verdict Slice 1 renders
          // (documentsInbox.noLineDispositionFor) and the convergence metric
          // settles on.
          const merge = {
            no_line_disposition: {
              ...dispositionReceipt,
              model: semantic.model || model,
              evaluation_id: evaluationId,
              evaluated_at: new Date().toISOString(),
              // Slice 3 — the decide-and-notify FYI marker: the ask-batch draft
              // gathers auto-explained docs on owner_notified 'false'
              // (ASK_BATCH_DOC_EXPLAINED_FYI_SQL) and the single send chokepoint
              // flips it true, so each settle is FYI'd to the owner exactly once.
              // Slice 4a: an owner-CONFIRMED settle seeds true — no FYI owed.
              // F3: a RE-settle preserves an already-flipped marker — the sweep
              // default must never re-arm a duplicate FYI for a doc the owner
              // already heard about.
              owner_notified: ownerNotified === true || beforeState?.owner_notified === true
            }
          };
          const upd = await client.query(
            `update documents
                set payload = coalesce(payload, '{}'::jsonb) || $4::jsonb,
                    updated_at = now()
              where id = $1 and firm_id = $2 and client_id = $3`,
            [document.id, firmId, clientId, JSON.stringify(merge)]
          );
          if ((upd.rowCount || 0) > 0) {
            settled = true;
            await auditDispositionEvent({
              client, firmId, clientId,
              action: settleAuditAction,
              documentId: document.id,
              metadata: {
                ...dispositionReceipt,
                model: semantic.model || model,
                evaluation_id: evaluationId,
                before_state: beforeState
              }
            });
          }
        } else if (beforeState && beforeState.disposition === 'auto_explain') {
          // F3 — a superseding non-settle verdict UNWINDS the stale settle so
          // every reader (gap guards, ask gather, convergence, UI) re-renders
          // off the fresh verdict row instead of the dead payload holder…
          if (settlementJournalId) {
            // …EXCEPT when a settlement journal was already posted off the old
            // settle: silently un-settling the doc while the ledger keeps the
            // journal is doc/ledger split-brain (F2's corrected lesson). The
            // supersede is refused and receipted — driving this to a proposed
            // reversal is the F4 needs_ledger_adjustment follow-up, not a
            // silent unlink.
            await auditDispositionEvent({
              client, firmId, clientId,
              action: 'document.disposition.supersede_blocked',
              documentId: document.id,
              metadata: {
                ...dispositionReceipt,
                model: semantic.model || model,
                evaluation_id: evaluationId,
                before_state: beforeState,
                settlement_journal_id: settlementJournalId
              }
            });
          } else {
            const upd = await client.query(
              `update documents
                  set payload = coalesce(payload, '{}'::jsonb) - 'no_line_disposition',
                      updated_at = now()
                where id = $1 and firm_id = $2 and client_id = $3`,
              [document.id, firmId, clientId]
            );
            if ((upd.rowCount || 0) > 0) {
              superseded = true;
              await auditDispositionEvent({
                client, firmId, clientId,
                action: 'document.disposition.superseded',
                documentId: document.id,
                metadata: {
                  ...dispositionReceipt,
                  model: semantic.model || model,
                  evaluation_id: evaluationId,
                  before_state: beforeState
                }
              });
            }
          }
        }
      }
    } catch (error) {
      // G2 PR-12: an audit failure is a precondition failure — rethrow so the
      // per-doc transaction rolls back cleanly (the PG txn is aborted at this
      // point anyway; swallowing would only turn the rollback into a
      // poisoned-commit failure with a misleading warn). Non-audit merge
      // failures keep the F3 posture: verdict row still authoritative.
      if (error?.auditPrecondition) throw error;
      console.warn(`[${LOG_TAG}] payload merge reconciliation failed (verdict row still authoritative)`, {
        document_id: document.id,
        error: error?.message || String(error)
      });
    }
  }

  return { stamped, settled, superseded, lane };
};

// Sweep one client's no-line reconcilable documents. Loads firm context +
// bank-feed coverage ONCE, then evaluates each eligible doc and stamps a
// verdict. Optionally scoped to `documentIds` (the orchestrator pass hands
// the run's just-evaluated doc targets; null = full-client sweep, e.g. the
// backfill for the existing Exxon-class backlog). NEVER throws on a per-doc
// failure — that doc falls toward a human and the sweep continues. The
// caller owns gating (plane flag); the SWEEP owns its transaction posture
// (F5): callers must NOT hold a transaction open across this — model calls
// run bare and each doc's stamp commits in its own mini-transaction.
export const runDocumentDispositionForClient = async ({
  client,
  firmId,
  clientId,
  documentIds = null,
  mode = 'shadow',
  apiKeyOverride,
  modelOverride,
  fetchImpl,
  // The #1748 shape (2026-08-19 follow-up): the lane's active model-policy
  // row (reconciliation_reasoning), resolved by the sweep OWNER
  // (loopsShadowProducers.documentTerminalDrainForClient). A non-claude
  // qualified rung decides this sweep over the openai_compatible endpoint —
  // same prompts, parser, Keep-layer gates. An active policy with no
  // endpoint fails LOUD (nothing stamped), never silently back to the
  // strong model.
  decidingPolicy = null,
  // RT-10 — the needs_human lane's writers (owner ask / re-run enqueue);
  // null ⇒ the real ones. Tests inject stubs.
  laneDeps = null,
  jevEnabled: jevEnabledOverride
} = {}) => {
  const stats = ZERO_STATS();
  stats.mode = mode === 'act' ? 'act' : 'shadow';

  if (!client || !firmId || !clientId) return DISABLED_STATS('missing_ids');
  const scoped = Array.isArray(documentIds)
    ? documentIds.map((id) => String(id)).filter(Boolean)
    : null;
  if (scoped && !scoped.length) return stats;
  const jevEnabled = await jevDispositionEnabled(client, firmId, clientId, jevEnabledOverride, { decidedBy: 'document_disposition' });
  const policyModel = !jevEnabled && typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  let transport = null;
  if (policyModel && !policyModel.startsWith('claude')) {
    try {
      transport = {
        provider: 'openai_compatible',
        endpoint: resolveOpenAiCompatibleEndpoint({}),
        model: policyModel
      };
    } catch {
      return DISABLED_STATS('policy_endpoint_unconfigured');
    }
  }
  // Key-gate AFTER transport resolution: the Anthropic key gates only the
  // Anthropic-decided path — a seated non-claude rung rides the compatible
  // endpoint above and must not require the key (Kari, 2026-08-19).
  const apiKey = apiKeyOverride ?? getApiKey();
  if (!apiKey && !transport && !jevEnabled) return DISABLED_STATS('no_anthropic_api_key');
  const policyBasis = policyModel ? (decidingPolicy?.basis || 'experiment') : null;


  // 1. Candidate no-line docs — LOCK-STEP with Slice 1's
  //    selectNoLineReconcilableDocs population: parsed (or the deliberate
  //    skipped payment_confirmation lane), reconcilable kind, amount-bearing,
  //    and NO live (suggested/auto_matched/confirmed) match — a live match
  //    outranks any verdict (INV-4; a suggested one is a proposal the human
  //    resolves, not a doc-first hang).
  const docResult = await client.query(
    `select d.id, d.document_type, d.vendor_name, d.customer_name, d.filename,
            d.total_amount, d.currency, d.document_date, d.payment_status, d.parse_summary
       from documents d
      where d.firm_id = $1 and d.client_id = $2
        and (
          d.parse_status = 'completed'
          or (d.parse_status = 'skipped' and d.document_type = 'payment_confirmation')
        )
        and d.document_type = any($3::text[])
        and d.total_amount is not null
        and ($4::text[] is null or d.id = any($4::text[]))
        and not exists (
          select 1 from reconciliation_matches m
           where m.firm_id = d.firm_id and m.client_id = d.client_id
             and m.matched_object_id = d.id
             and m.matched_object_type <> 'bank_line'
             and m.status in ('suggested', 'auto_matched', 'confirmed')
        )
        -- 2026-09-13: a document whose family matcher never got a provider
        -- answer (reconciliationProviderFailure.js receipt) has NO matching
        -- judgment yet — it is not a no-line document, and dispositioning it
        -- would ask the owner for evidence the book may already hold. The
        -- convergence clock re-drives the matcher first; the receipt clears
        -- when the strong model has actually run.
        and not (coalesce(d.payload, '{}'::jsonb) ? 'reconciliation_provider_failure')
        -- A selected action refused by a writer is not an absent payment.
        -- Its existing convergence recovery owns the next attempt. A scoped
        -- negative leaves invoice obligations open. Settlement evidence still
        -- needs this disposition owner to establish funding or ask for it.
        and not exists (select 1 from reconciliation_evaluations e
          where e.firm_id=d.firm_id and e.client_id=d.client_id and e.target_id=d.id
            and e.payload->>'decision_engine'='jev'
            and e.verdict <> 'superseded'
            and ((d.document_type = any($5::text[]) and e.unmatchable_reason='jev_no_settlement')
              or e.payload->>'next_action' in ('reconsider_current_evidence','retry_writer')))
        -- RT-27: a credit note applied in full (or an invoice credited in full)
        -- already rests explained on the credit-application holder; a second
        -- verdict would re-open a settled document as an owner question.
        and coalesce(d.payload->'no_line_disposition'->>'lane', '') not in ('credit_note_applied', 'credited_in_full', 'settled_through_reminder')
      order by d.document_date desc nulls last, d.id desc`,
    [firmId, clientId, [...RECONCILABLE_DOC_TYPES], scoped, NO_SETTLEMENT_OBLIGATION_TYPES]
  );
  const candidates = docResult.rows || [];
  if (!candidates.length) return stats;

  // 2. Exclude docs already escalated to the owner — an open doc-anchored
  //    client_evidence_request (request_payload.document_id; LOCK-STEP with
  //    OPEN_DOC_ASK_STATUSES) means the doc is terminal-on-owner already; a
  //    second verdict would double-handle it.
  const docIds = candidates.map((d) => d.id);
  const askedResult = await client.query(
    `select request_payload->>'document_id' as document_id
       from client_evidence_requests
      where firm_id = $1 and client_id = $2
        and status in ('draft', 'open', 'replied')
        and request_payload->>'document_id' = any($3::text[])`,
    [firmId, clientId, docIds]
  );
  const alreadyAsked = new Set((askedResult.rows || []).map((r) => r.document_id).filter(Boolean));
  const bareDocs = candidates.filter((d) => !alreadyAsked.has(d.id));
  stats.skipped_already_asked = candidates.length - bareDocs.length;
  if (!bareDocs.length) return stats;

  // 3. Incremental guard — idempotent at the strong-model-CALL level, exactly
  //    like the bank-line sweep: skip docs already carrying a verdict at the
  //    CURRENT policy version (a version bump is the deliberate re-run lever).
  //    EXCEPTION: a shadow-mode verdict does NOT satisfy an ACT-mode sweep —
  //    the canary's first act pass must be able to settle the docs the shadow
  //    week only observed (the payload merge never ran), so act mode only
  //    skips prior ACT verdicts.
  const bareDocIds = bareDocs.map((d) => d.id);
  const priorResult = await client.query(
    `select target_id
       from reconciliation_evaluations
      where firm_id = $1 and client_id = $2
        and target_type = $3 and matcher_family = $4
        and payload->>'policy_version' = $5
        and ($6::text is distinct from 'act' or payload->>'matcher_mode' = 'act')
        and not (
          payload->'lane'->>'kind' = 'machine_rerun'
          and coalesce((payload->'lane'->>'due_at')::timestamptz, now()) <= now()
        )
        and target_id = any($7::text[])`,
    [
      firmId,
      clientId,
      DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
      DOCUMENT_NO_LINE_DISPOSITION_FAMILY,
      DOCUMENT_NO_LINE_DISPOSITION_POLICY_VERSION,
      stats.mode,
      bareDocIds
    ]
  );
  const alreadyEvaluated = new Set((priorResult.rows || []).map((r) => r.target_id));
  const toEvaluate = bareDocs.filter((d) => !alreadyEvaluated.has(d.id));
  stats.skipped_existing = bareDocs.length - toEvaluate.length;
  if (!toEvaluate.length) return stats;

  // 4. Firm context, loaded once per sweep: identity anchor + known
  //    counterparties (per predominant role — suppliers unless the batch is
  //    all money-in) + the bank-feed COVERAGE summary the fork turns on.
  const coverageResult = await client.query(
    `select count(*)::int as line_count,
            min(transaction_date) as first_date,
            max(transaction_date) as last_date
       from transactions
      where firm_id = $1 and client_id = $2`,
    [firmId, clientId]
  );
  const covRow = coverageResult.rows[0] || {};
  const bankFeedCoverage = {
    lineCount: Number(covRow.line_count || 0),
    firstDate: covRow.first_date ? String(covRow.first_date).slice(0, 10) : null,
    lastDate: covRow.last_date ? String(covRow.last_date).slice(0, 10) : null
  };

  const allMoneyIn = toEvaluate.every((d) => MONEY_IN_TYPES.has(d.document_type));
  const { clientIdentity, knownCounterparties } = await loadFirmContext({
    client,
    firmId,
    clientId,
    document: { payment_status: null },
    settledCount: 0,
    counterpartyRole: allMoneyIn ? 'customer' : 'supplier',
    paymentStatusIsSettlementSignal: false
  });
  // The owner's language, read once per sweep through the one resolver: the
  // prompt is told which language to write owner_question in, and the mint
  // wraps it in the same language. A failed read leaves the prompt historical
  // and the mint reads again.
  let ownerLanguage = null;
  try { ownerLanguage = await readOwnerLanguage({ client, firmId, clientId }); } catch { ownerLanguage = null; }

  // A claude-family policy rung rides the anthropic transport as a model
  // override (same as the fixed sweeps); a non-claude rung rides `transport`.
  const model = modelOverride ?? policyModel ?? getModel();

  // F5 — bound the model calls per sweep, with a COUNTED remainder. The
  // incremental guard above makes the sweep re-entrant.
  const sweepLimit = getSweepLimit();
  const bounded = toEvaluate.slice(0, sweepLimit);
  stats.truncated_remainder = toEvaluate.length - bounded.length;
  if (stats.truncated_remainder > 0) {
    console.log(`[${LOG_TAG}] sweep capped at ${sweepLimit} model calls; ${stats.truncated_remainder} eligible docs remain for the next sweep`, {
      client_id: clientId, mode: stats.mode
    });
  }

  // 5. Evaluate each doc; per-doc failures fall toward a human. Each doc's
  //    stamp (verdict row + audit + act-mode payload merge) commits in its
  //    OWN mini-transaction (F5): no caller holds a txn across the model
  //    calls, and a failure at doc N never rolls back N−1 paid-for verdicts.
  let consecutiveTransportFailures = 0;
  for (const document of bounded) {
    const localEvidence = jevEnabled ? await loadJevDispositionEvidence(client, firmId, clientId, { documentId: document.id }) : null;
    stats.evaluated += 1;
    let semantic;
    try {
      semantic = await proposeDocumentDisposition({
        document,
        firmContext: { clientIdentity, knownCounterparties, bankFeedCoverage, ownerLanguage, ...(jevEnabled ? { localEvidence, jevProvider:await makeJevTrialProvider({client,firmId,clientId,resourceType:'document',resourceId:document.id,decisionKind:'document_disposition'}) } : {}) },
        apiKey,
        model,
        transport,
        fetchImpl,
        jevEnabled
      });
    } catch (error) {
      console.warn(`[${LOG_TAG}] disposition failed; falling toward human`, {
        document_id: document.id,
        error: error?.message || String(error)
      });
      semantic = transport || jevEnabled
        ? { ...safeDisposition('producer_error'), transport_failure: true }
        : safeDisposition('producer_error');
    }
    // Policy-path transport law (the bank-line sweep's, mirrored — the
    // 2026-08-17 stale-endpoint incident's lesson). Mismatch aborts the WHOLE
    // sweep before any counter or stamp: the reply came from a model the
    // policy did not name, so nothing about it may persist. A transport-class
    // failure (no model judgment existed) skips the stamp so the incremental
    // guard re-picks the doc after the endpoint is fixed; a run of them is a
    // systemic config problem — abort loudly. The KEYED path never sets these
    // markers, so its historical fail-closed-to-needs_human stamp is
    // byte-identical.
    if (semantic.model_mismatch) {
      stats.aborted_reason = 'policy_model_mismatch';
      console.error(`[${LOG_TAG}] sweep ABORTED on model mismatch — policy names "${transport?.model}"; nothing stamped`, {
        client_id: clientId,
        document_id: document.id
      });
      break;
    }
    if (semantic.transport_failure) {
      stats.transport_failures += 1;
      consecutiveTransportFailures += 1;
      console.warn(`[${LOG_TAG}] transport-class failure — doc left unevaluated (no stamp)`, {
        document_id: document.id,
        reason: semantic.unmatchable_reason || null
      });
      if (consecutiveTransportFailures >= TRANSPORT_FAILURE_ABORT_THRESHOLD) {
        stats.aborted_reason = 'transport_failure_run';
        console.error(`[${LOG_TAG}] sweep ABORTED after ${consecutiveTransportFailures} consecutive transport failures — endpoint/config problem; nothing further attempted`, {
          client_id: clientId
        });
        break;
      }
      continue;
    }
    consecutiveTransportFailures = 0;
    if (policyBasis) {
      semantic.policy_basis = policyBasis;
      semantic.policy_model = policyModel;
    }

    if (semantic.disposition === 'auto_explain') stats.auto_explained += 1;
    else if (semantic.disposition === 'chase_evidence') stats.chase_evidence += 1;
    else stats.needs_human += 1;

    let stamped = false;
    let settled = false;
    let superseded = false;
    let lane = null;
    try {
      await client.query('begin');
      ({ stamped, settled, superseded, lane } = await stampDocumentDisposition({
        client, firmId, clientId, document, semantic, model, mode: stats.mode, laneDeps, ownerLanguage
      }));
      await client.query('commit');
    } catch (error) {
      try { await client.query('rollback'); } catch { /* best-effort */ }
      stamped = false;
      settled = false;
      superseded = false;
      console.warn(`[${LOG_TAG}] per-doc stamp transaction failed; doc falls to the next sweep`, {
        document_id: document.id,
        error: error?.message || String(error)
      });
    }
    if (!stamped) stats.stamp_failures += 1;
    else stats.evaluated_target_ids.push(String(document.id));
    if (settled) stats.settled_doc_ids.push(String(document.id));
    if (superseded) stats.superseded += 1;
    if (stamped && lane?.kind === 'owner_ask') stats.owner_asks_minted += 1;
    else if (stamped && lane?.kind === 'machine_rerun') stats.reruns_scheduled += 1;
    else if (stamped && lane && String(lane.kind).endsWith('_exhausted')) stats.lanes_exhausted += 1;
  }

  return stats;
};

// ── Slice 4a — the ANSWER leg (docs/donna-settlement-answer-and-ledger-entry-plan.md §2) ──
//
// When the owner answers a doc-anchored ask, the reply must reach a terminal:
// ONE reply-informed re-disposition reads the answer with the doc + firm
// context, and the upserted verdict (one row per doc/family — last wins)
// REPLACES the chase_evidence verdict that minted the ask, so the ask-batch
// gather stops re-asking and the projection re-renders honestly:
//   auto_explain    → settle merge (verdict_source 'owner_reply',
//                     owner_notified true — the answer IS the notification)
//                     + request resolved.
//   chase_evidence  → the ONE lane change (statement request): request
//                     resolved; the batch drafter picks the doc up again off
//                     the new verdict through the normal Slice-3 loop.
//   needs_human     → request resolved; the doc returns to the violation
//                     section for a HUMAN to read the reply — visible, never
//                     bounced back to the owner and never firm-click limbo.
// The request flips 'resolved' ONLY in the same transaction as a successful
// verdict stamp: flipping without a new verdict would let the sweep re-draft
// the very question the owner just answered.
//
// The model call runs OUTSIDE the transaction (never hold a txn open across
// a network call — the firm pool is max 2); a missing key / transport error
// falls to safeDisposition (needs_human) so the answer is still consumed
// toward a HUMAN instead of resting in the replied limbo. Caller owns the
// flag gate (rides DOCUMENT_NO_LINE_DISPOSITION — an ask can only exist
// where that flag acts, so the question and its answer are live together).
export const runOwnerReplyRedisposition = async ({
  client,
  firmId,
  clientId,
  documentId,
  evidenceRequestId,
  answeredEvidenceType = 'payment_method',
  askedQuestion = '',
  ownerReply = '',
  replyDocumentIds = [],
  actorId = 'system',
  apiKeyOverride,
  modelOverride,
  fetchImpl,
  // The #1748 shape (2026-08-19 follow-up): the reconciliation_reasoning
  // lane's active policy row, resolved by the answer leg's owner (firmDb).
  // A seated non-claude rung decides the re-disposition over the compatible
  // endpoint and must not require the Anthropic key.
  decidingPolicy = null,
  // RT-10 — the clarification ask's writer; null ⇒ the real one.
  laneDeps = null,
  jevEnabled: jevEnabledOverride,
  // The asking lane's "still unpaid" answer ({ meaning, recheckDays },
  // salesRecognitionGap.noSettlementAskStillOpen), or null where the lane has
  // none. The reader is told it is a valid answer; its consequence is below.
  stillOpen = null,
  // The asking lane's record-settling answers ({ creditDeducted?, bankFee?,
  // matchedDocument }, salesRecognitionGap.noSettlementAskLaneAnswers) and the
  // writers that record them ({ creditDeducted, bankFee }: async ({ client,
  // firmId, clientId, documentId, request, billNumber, actorId }) →
  // { recorded, ... }). Null where the lane has none.
  laneAnswers = null,
  laneRecorders = null
} = {}) => {
  const ownerReplyMode = { answeredEvidenceType, ...(stillOpen ? { stillOpen } : {}), ...(laneAnswers ? { laneAnswers } : {}) };
  const result = {
    stamped: false,
    settled: false,
    request_resolved: false,
    disposition: null,
    skipped: null,
    // RT-10: the lane an unclear reply took — a bounded clarification ask
    // (its id here) or the exhausted bound.
    lane: null,
    clarification_request_id: null
  };
  if (!client || !firmId || !clientId || !documentId || !evidenceRequestId) {
    result.skipped = 'missing_ids';
    return result;
  }
  const jevEnabled = await jevDispositionEnabled(client, firmId, clientId, jevEnabledOverride, { decidedBy: 'document_disposition' });
  const policyModel = !jevEnabled && typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
    ? decidingPolicy.deciding_model.trim()
    : null;
  let transport = null;
  if (policyModel && !policyModel.startsWith('claude')) {
    try {
      transport = {
        provider: 'openai_compatible',
        endpoint: resolveOpenAiCompatibleEndpoint({}),
        model: policyModel
      };
    } catch {
      // Fail LOUD, stamp NOTHING, resolve NOTHING: the request stays
      // 'replied' (visible — the F8 owner_reply_unprocessed blocker) and the
      // owner's answer is preserved for a re-drive once the endpoint is
      // configured. Never a junk verdict, never a silent strong-model swap.
      console.error(`[${LOG_TAG}] owner-reply re-disposition refused — active policy with no compatible endpoint`, {
        document_id: documentId,
        evidence_request_id: evidenceRequestId,
        policy_model: policyModel
      });
      result.skipped = 'policy_endpoint_unconfigured';
      return result;
    }
  }
  const policyBasis = policyModel ? (decidingPolicy?.basis || 'experiment') : null;

  const resolveRequest = async ({ disposition, via }) => {
    const flipped = await client.query(
      `update client_evidence_requests
          set status = 'resolved',
              resolved_at = coalesce(resolved_at, now()),
              resolved_by = $4,
              response_payload = coalesce(response_payload, '{}'::jsonb) || $5::jsonb,
              updated_at = now()
        where firm_id = $1 and client_id = $2 and id = $3
          and status in ('draft', 'open', 'replied')`,
      [firmId, clientId, evidenceRequestId, actorId, JSON.stringify({ resolved_by_disposition: via })]
    );
    if ((flipped.rowCount || 0) > 0) {
      result.request_resolved = true;
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, 'system', $3, $4, 'client_evidence_request', $5, $6::jsonb)`,
        [firmId, clientId, actorId, 'evidence_request.resolve', evidenceRequestId, JSON.stringify({
          document_id: documentId,
          disposition: disposition || null,
          via
        })]
      );
    }
  };

  // The doc header — the sweep's SELECT shape WITHOUT the live-match
  // exclusion, so a moot ask (a line matched while the question was out)
  // can be recognized and closed instead of re-disposed.
  const docResult = await client.query(
    `select d.id, d.document_type, d.vendor_name, d.customer_name, d.filename,
            d.total_amount, d.currency, d.document_date, d.payment_status, d.parse_summary
       from documents d
      where d.firm_id = $1 and d.client_id = $2 and d.id = $3
      limit 1`,
    [firmId, clientId, documentId]
  );
  const document = docResult.rows[0] || null;
  if (!document) {
    result.skipped = 'document_not_found';
    return result;
  }

  const liveMatch = await client.query(
    `select 1
       from reconciliation_matches m
      where m.firm_id = $1 and m.client_id = $2
        and m.matched_object_id = $3
        and m.matched_object_type <> 'bank_line'
        and m.status in ('suggested', 'auto_matched', 'confirmed')
      limit 1`,
    [firmId, clientId, documentId]
  );
  // A question asked ABOUT a matched document (a sales payment's shortfall)
  // is not made moot by that match.
  if (liveMatch.rows.length && !laneAnswers?.matchedDocument) {
    // INV-4: a live match outranks any verdict — the ask is moot and the
    // match is the terminal. Consume the answer by resolving the request.
    await client.query('begin');
    try {
      await resolveRequest({ disposition: null, via: 'live_match' });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      console.warn(`[${LOG_TAG}] moot-ask resolve failed`, {
        document_id: documentId,
        error: error?.message || String(error)
      });
    }
    result.skipped = 'live_match';
    return result;
  }

  // Firm context (the sweep's step 4, single-doc role) + the model call —
  // both OUTSIDE any transaction. Key-gate AFTER transport resolution: a
  // seated non-claude rung rides the compatible endpoint and must not
  // require the Anthropic key (Kari, 2026-08-19).
  const apiKey = apiKeyOverride ?? getApiKey();
  const model = modelOverride ?? policyModel ?? getModel();
  let semantic;
  if (!apiKey && !transport && !jevEnabled) {
    // RT-10: no model judgment can exist without a key — stamp NOTHING,
    // resolve NOTHING. The request stays 'replied' (F8's visible
    // owner_answered_processing) with the owner's answer preserved for a
    // re-drive once a key is configured; a needs_human stamped here would
    // have resolved the ask off an infrastructure gap.
    result.skipped = 'no_api_key';
    return result;
  } else {
    try {
      const coverageResult = await client.query(
        `select count(*)::int as line_count,
                min(transaction_date) as first_date,
                max(transaction_date) as last_date
           from transactions
          where firm_id = $1 and client_id = $2`,
        [firmId, clientId]
      );
      const covRow = coverageResult.rows[0] || {};
      const bankFeedCoverage = {
        lineCount: Number(covRow.line_count || 0),
        firstDate: covRow.first_date ? String(covRow.first_date).slice(0, 10) : null,
        lastDate: covRow.last_date ? String(covRow.last_date).slice(0, 10) : null
      };
      const { clientIdentity, knownCounterparties } = await loadFirmContext({
        client,
        firmId,
        clientId,
        document: { payment_status: null },
        settledCount: 0,
        counterpartyRole: COUNTERPARTY_ROLE_BY_TYPE[document.document_type] || 'supplier',
        paymentStatusIsSettlementSignal: false
      });
      const localEvidence = jevEnabled ? await loadJevDispositionEvidence(client, firmId, clientId, { documentId }) : null;
      const userPrompt = buildOwnerReplyUserPrompt({
        document: jevEnabled ? { ...document, id: 'document_1' } : document,
        firmContext: { clientIdentity, knownCounterparties, bankFeedCoverage },
        askedQuestion,
        answeredEvidenceType,
        ownerReply,
        replyDocumentCount: Array.isArray(replyDocumentIds) ? replyDocumentIds.filter(Boolean).length : 0
      });
      const strongOwnerReply = () => proposeMatchesViaAnthropic({
        systemPrompt: stillOpen || laneAnswers ? buildOwnerReplySystemPrompt({ stillOpen, laneAnswers }) : OWNER_REPLY_SYSTEM_PROMPT,
        userPrompt: userPrompt + (jevEnabled ? `\nExtracted focal document: ${JSON.stringify(document.parse_summary || {})}\nLocal evidence inventory: ${JSON.stringify(localEvidence)}` : ''),
        candidateBankLines: [],
        model,
        apiKey,
        fetchImpl,
        parse: (text) => parseDocumentDispositionResponse(text, { documentType:document.document_type, ownerReply: ownerReplyMode }),
        logTag: LOG_TAG,
        transport: transport
          ? { ...transport, execution: transport.execution || { root: { type: 'reconciliation_reasoning', id: documentId } } }
          : null
      });
      if (jevEnabled) {
        const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: clientIdentity?.jurisdiction ?? null });
        const chosen = await decideJevDisposition({ provider:await makeJevTrialProvider({client,firmId,clientId,resourceType:'document',resourceId:documentId,decisionKind:'document_disposition'}), kind: 'document', direction:MONEY_IN_TYPES.has(document.document_type) ? 'money_in' : 'money_out', observation: { summary: userPrompt, extracted_summary: document.parse_summary || null }, localEvidence, amount: Number(document.total_amount), materialityCeiling: materialityPolicy.ceiling, ownerReply: ownerReplyMode, fetchImpl });
        semantic = chosen.needsReasoning
          ? withJevHandoff(await strongOwnerReply(), chosen.receipt)
          : { ...parseDocumentDispositionResponse(JSON.stringify(chosen.semantic), { confidenceFloor: 0, documentType:document.document_type, ownerReply: ownerReplyMode }), model: chosen.semantic.model, model_source: 'response', decision_engine: 'jev', jev_first: chosen.receipt };
      } else semantic = await strongOwnerReply();
      if (!semantic || !(DISPOSITIONS.has(semantic.disposition) || (stillOpen && semantic.disposition === OBLIGATION_OPEN)
        || laneAnswerOffered(semantic.disposition, ownerReplyMode))) {
        semantic = safeDisposition(semantic?.unmatchable_reason || 'invalid_llm_response');
      }
    } catch (error) {
      console.error(`[${LOG_TAG}] owner-reply disposition call threw`, {
        document_id: documentId,
        error: error?.message || String(error)
      });
      // Policy-path transport law: no model judgment existed (or the reply
      // came from a model the policy did not name) — stamp NOTHING, resolve
      // NOTHING; the request stays 'replied' (visible) with the owner's
      // answer preserved for a re-drive. The KEYED path keeps its historical
      // fail-closed-to-needs_human stamp, byte-identical.
      // RT-10: the KEYED path now matches the policy path — a transport
      // throw is no judgment, so nothing is stamped and the request stays
      // 'replied' (visible), never a needs_human that resolves the ask.
      result.skipped = transport && error?.code === 'POLICY_MODEL_MISMATCH' ? 'policy_model_mismatch' : 'transport_failure';
      return result;
    }
  }
  // RT-10: a non-OK provider reply the core short-circuited (api_error_<n>)
  // is transport-class too — same posture, nothing stamped.
  if (isTechnicalNeedsHuman(semantic)) {
    result.skipped = String(semantic.unmatchable_reason || 'transport_failure');
    return result;
  }
  if (policyBasis) {
    semantic.policy_basis = policyBasis;
    semantic.policy_model = policyModel;
  }
  result.disposition = semantic.disposition;

  // "Still unpaid" on a lane that accepts it: the obligation is open and the
  // owner said so. Nothing is stamped or posted and no clarification is sent;
  // the ask goes back to the owner ('open', still projecting on_owner) with
  // the answer and its date on its topic record, and its due date moves out
  // by the lane's recheckDays so the existing re-ask clock asks again later.
  // obligation_open_acknowledged is the marker that clock reads: the owner
  // answered, so sends before it are not "ignored" sends. A payment posted
  // against the document still closes the ask
  // (resolveOpenSettlementRequestsForDocument).
  if (semantic.disposition === OBLIGATION_OPEN) {
    const at = new Date();
    const recheckAt = new Date(at.getTime() + Number(stillOpen.recheckDays) * 86400000).toISOString();
    await client.query('begin');
    try {
      const current = (await client.query(
        `select * from client_evidence_requests
          where firm_id = $1 and client_id = $2 and id = $3 and status = 'replied'
          for update`,
        [firmId, clientId, evidenceRequestId]
      )).rows[0];
      if (current) {
        const prior = current.request_payload?.evidence_topic || {};
        const replyKey = ownerReplyIdentity(current);
        const turn = { at: at.toISOString(), channel: prior.channel || 'owner_reply',
          actor_id: current.response_payload?.reply_processing?.actor_id || null, reply_key: replyKey,
          outcome: OBLIGATION_OPEN, terminal: false,
          reply_excerpt: String(current.response_payload?.reply || '').slice(0, 240), question: current.question };
        // 'answered', not 'open': the owner did answer, so the topic reminder
        // sweep (which reminds open topics a day after the owner's last
        // message) leaves it alone; the re-ask clock owns when to ask again.
        const topic = { ...prior, version: 1, status: 'answered', last_owner_message_at: at.toISOString(),
          original_question: prior.original_question || current.question, current_need: current.question,
          last_assessment: { outcome: OBLIGATION_OPEN, can_resolve: false, reason: 'owner_reports_still_unpaid', recheck_at: recheckAt },
          turns: [...(prior.turns || []), turn].slice(-10) };
        const acknowledged = { at: at.toISOString(), reply_key: replyKey, send_count: Number(current.send_count || 0), recheck_at: recheckAt };
        await client.query(
          `update client_evidence_requests
              set status = 'open', resolved_at = null, resolved_by = null, due_at = $4::timestamptz,
                  request_payload = request_payload || jsonb_build_object(
                    'evidence_topic', $5::jsonb,
                    'obligation_open_acknowledged', $6::jsonb,
                    'evidence_request', coalesce(request_payload->'evidence_request', '{}'::jsonb) || jsonb_build_object('status', 'open')),
                  updated_at = now()
            where firm_id = $1 and client_id = $2 and id = $3`,
          [firmId, clientId, evidenceRequestId, recheckAt, JSON.stringify(topic), JSON.stringify(acknowledged)]
        );
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, 'evidence_request.owner_reported_still_open', 'client_evidence_request', $4, $5::jsonb)`,
          [firmId, clientId, actorId, evidenceRequestId, JSON.stringify({ document_id: documentId, ...acknowledged })]
        );
        result.obligation_open = true;
        result.lane = { kind: OBLIGATION_OPEN, recheck_at: recheckAt };
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback');
      console.warn(`[${LOG_TAG}] owner-reply still-open acknowledgement failed (request left replied)`, {
        document_id: documentId, evidence_request_id: evidenceRequestId, error: error?.message || String(error)
      });
    }
    return result;
  }

  // A record-settling answer on a lane that offers it: the record is written
  // by its own writer (a supplier credit application; a bank fee on the
  // match) and the ask resolves in the same transaction. Nothing is stamped
  // or posted. When the writer refuses (no such bill, another supplier,
  // nothing open, the shortfall moved), nothing is written and the answer
  // takes the unclear path below, exactly as an unclear reply would.
  if (semantic.disposition === CREDIT_DEDUCTED || semantic.disposition === SHORTFALL_BANK_FEE) {
    const recorder = semantic.disposition === CREDIT_DEDUCTED ? laneRecorders?.creditDeducted : laneRecorders?.bankFee;
    const kind = semantic.disposition === CREDIT_DEDUCTED ? 'owner_stated_credit_deduction' : 'owner_stated_bank_fee';
    let recorded = null;
    await client.query('begin');
    try {
      const current = (await client.query(
        `select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3 and status = 'replied' for update`,
        [firmId, clientId, evidenceRequestId]
      )).rows[0];
      if (current && recorder) {
        // Resolve first, so the writer's own ask resolution leaves this one to us.
        await resolveRequest({ disposition: semantic.disposition, via: kind });
        recorded = await recorder({ client, firmId, clientId, documentId, request: current,
          billNumber: semantic.deducted_from_bill || null, actorId, evidenceRequestId });
      }
      if (recorded?.recorded) {
        await client.query(
          `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, 'system', $3, $4, 'client_evidence_request', $5, $6::jsonb)`,
          [firmId, clientId, actorId, `evidence_request.${kind}`, evidenceRequestId, JSON.stringify({ document_id: documentId, ...recorded })]
        );
        await client.query('commit');
        result.lane = { kind, ...recorded };
        return result;
      }
      await client.query('rollback');
      result.request_resolved = false;
    } catch (error) {
      await client.query('rollback');
      result.request_resolved = false;
      console.warn(`[${LOG_TAG}] owner-reply lane answer could not be recorded (request left replied)`, {
        document_id: documentId, evidence_request_id: evidenceRequestId, error: error?.message || String(error)
      });
      result.skipped = 'lane_answer_record_failed';
      return result;
    }
    // Not recordable: the unclear path, with the reason on the receipt.
    semantic = { ...semantic, disposition: 'needs_human', downgraded_from: semantic.disposition,
      unmatchable_reason: `owner_answer_not_recordable:${recorded?.refusals?.[0]?.code || recorded?.reason || 'no_recorder'}`.slice(0, 80) };
    delete semantic.deducted_from_bill;
    result.disposition = semantic.disposition;
    result.lane_answer_refused = { kind, refusals: recorded?.refusals || [], reason: recorded?.reason || null };
  }

  // Stamp + flip, atomically: the verdict replaces the chase_evidence row
  // (upsert, one row per doc/family) and the request leaves the open set in
  // the same commit. A failed stamp leaves the request 'replied' — visible,
  // and never a resolved-request/stale-verdict split the sweep would re-ask.
  await client.query('begin');
  try {
    const { stamped, settled } = await stampDocumentDisposition({
      client,
      firmId,
      clientId,
      document,
      semantic,
      model: semantic.model || model,
      mode: 'act',
      extraReceipt: {
        // Provenance on EVERY answer-leg receipt (an owner-reply verdict is
        // a different animal from a sweep verdict — renderers and the plan's
        // Slice 4b consumer key on it); on the auto_explain merge this IS
        // the "settled by the owner's word" record.
        verdict_source: 'owner_reply',
        actor_id: actorId,
        evidence_request_id: evidenceRequestId
      },
      ownerNotified: true,
      settleAuditAction: 'document.disposition.owner_confirmed',
      needsHumanLane: 'owner_reply'
    });
    result.stamped = stamped;
    result.settled = settled;
    if (stamped) {
      await resolveRequest({ disposition: semantic.disposition, via: 'owner_reply_redisposition' });
    }
    // RT-10: an UNCLEAR reply (needs_human here is the parser's
    // owner_reply_unclear coercion) may not rest "for a human to read" —
    // there is no human but the owner. One bounded clarification ask, after
    // the answered request is resolved (so the writer's open-ask dedup does
    // not collapse the new question onto the old one); at the bound the
    // lane rests owner_ask_exhausted, surfaced. Same transaction.
    if (stamped && semantic.disposition === 'needs_human') {
      const deps = { ...defaultNeedsHumanLaneDeps(), ...(laneDeps || {}) };
      const evidenceType = answeredEvidenceType || 'payment_method';
      const evaluationId = makeEvaluationId({
        clientId,
        targetType: DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE,
        targetId: documentId,
        matcherFamily: DOCUMENT_NO_LINE_DISPOSITION_FAMILY
      });
      const generations = await countOwnerAsksForDocument({ client, firmId, clientId, documentId, evidenceType });
      let lane;
      if (generations < OWNER_ASK_MAX_GENERATIONS) {
        const mintOutcome = {};
        const clarification = await deps.mintOwnerAsk({
          client,
          firmId,
          clientId,
          documentId,
          question: buildOwnerReplyClarificationQuestion({ document, answeredEvidenceType: evidenceType, language: await readOwnerLanguage({ client, firmId, clientId }) }),
          evidenceType,
          actorId,
          requestContext: {
            lane: 'owner_reply_clarification',
            prior_evidence_request_id: evidenceRequestId,
            evaluation_id: evaluationId
          },
          mintOutcome
        });
        lane = {
          kind: 'owner_ask', clarification: true, evidence_type: evidenceType,
          evidence_request_id: clarification?.id || null, minted: mintOutcome.minted ?? null,
          minted_at: new Date().toISOString()
        };
        result.clarification_request_id = clarification?.id || null;
      } else {
        lane = { kind: 'owner_ask_exhausted', asks: generations, reason: 'owner_reply_unclear', exhausted_at: new Date().toISOString() };
      }
      await client.query(
        `update reconciliation_evaluations
            set payload = coalesce(payload, '{}'::jsonb) || $6::jsonb
          where firm_id = $1 and client_id = $2
            and target_type = $3 and target_id = $4 and matcher_family = $5`,
        [firmId, clientId, DOCUMENT_NO_LINE_DISPOSITION_TARGET_TYPE, documentId, DOCUMENT_NO_LINE_DISPOSITION_FAMILY, JSON.stringify({ lane })]
      );
      await auditDispositionEvent({
        client, firmId, clientId,
        action: lane.kind === 'owner_ask' ? 'document.disposition.owner_asked' : 'document.disposition.owner_ask_exhausted',
        documentId,
        metadata: { lane, evaluation_id: evaluationId, matcher_mode: 'act', via: 'owner_reply_redisposition' }
      });
      result.lane = lane;
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    console.warn(`[${LOG_TAG}] owner-reply stamp/resolve failed (request left replied)`, {
      document_id: documentId,
      evidence_request_id: evidenceRequestId,
      error: error?.message || String(error)
    });
  }

  return result;
};

// Test-only exports.
export const __safeDisposition = safeDisposition;
export const __DISPOSITION_TO_VERDICT = DISPOSITION_TO_VERDICT;
export const __DISPOSITION_DEFAULT_REASON = DISPOSITION_DEFAULT_REASON;
export const __SYSTEM_PROMPT = SYSTEM_PROMPT;
