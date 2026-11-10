// Ask-pipeline drafting — one strong-LLM call that turns the persisted
// coding verdicts into ONE client-ready message per period.
//
// The verdicts (transactions.payload.ai_suggestion) already carry the
// model's question, reasoning, confidence, and alternatives for every
// surviving feed row. This module hands ALL of that — plus the
// internal-movement lines, the statement-coverage picture, and the
// already-open evidence requests — to a strong model and renders what
// it says. The model owns the wording and evidence type of each question;
// the runtime owns the terminal class. Every row in coding_items,
// aged_twin_asks, held_match_confirms, or document_items has already been
// filtered to a non-terminal item with no covering owner ask, so each MUST
// leave drafting as an 'ask'. Courtesy FYIs are gathered separately only
// after their accounting transition has already completed.
//
// There is deliberately NO deterministic fallback message writer here.
// A hand-templated client message drafted from transaction fields is
// exactly the legacy ask-client ladder this pipeline retires
// (CLAUDE.md: draft FROM the verdict, never the legacy layer). When the
// provider is unavailable we fail honestly and the firm retries.

import { existsSync, readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { assignExclusiveCitableEvidence } from './localEvidenceInventory.js';
// The one owner-language resolver (also behind the WhatsApp template choice).
import { ownerClientCountry, preferredOwnerTemplateLanguage } from './ownerLanguage.js';
// The shared provider transport (2026-09-13): one deadline over headers +
// body, capped by the worker's execution budget, and ONE typed failure for
// a missing key, 401/403, 429/5xx, a reset socket, a hung request and an
// unreadable body. Every one of them surfaces as ASK_PIPELINE_LLM_UNAVAILABLE
// with the typed cause attached, so the outbox dead letter names the
// provider and the outage recovery (codingConvergence.js) can re-request it.
import { callProviderJson, providerFailureReceipt, providerInvalidOutput, providerKeyMissing } from './providerTransport.js';
import { llmCall } from './llmCall.js';
import { getLane } from './modelLanes.js';
import { missingKeyNameFor, resolveTextLaneProvider } from './providerEndpoints.js';
import { anthropicStructuredRequest, typedLlmCallFailure } from './structuredRequest.js';

// Drafting a message that ships to the CLIENT is a load-bearing call —
// strong model by default, OPENAI_MODEL stays the override knob (same
// convention as transactionLlm.js).
// 2026-11-10 (owner's decision: Claude only): provider-agnostic — Anthropic
// (claude-opus-5-5) when its key is present, OpenAI (this default) only when
// no Anthropic key is configured; OPENAI_MODEL may pin either family's id.
// Effort `high`: the draft ships to the client and must cover every item it
// is handed under one handle contract (sanitizeAskMessageDraft refuses a
// draft that does not) — the most demanding writing job among the text lanes.
// The request streams: the draft for a full month is long.
const DEFAULT_MODEL = 'gpt-5.4';
const LANE_PROVIDERS = getLane('ask_drafting').providers;
const ANTHROPIC_EFFORT = 'high';
const ANTHROPIC_TIMEOUT_MS = 300_000;

// Durable request payload marker. A convergence clock can distinguish draft
// requests created before the call-local-handle boundary from requests that
// have already exercised it, so an old exhausted row is healed exactly once.
export const ASK_DRAFT_IDENTITY_CONTRACT = 'call_local_handles_v1';

export const ASK_DISPOSITIONS = Object.freeze(['ask']);

// The evidence_type vocabulary the existing evidence-request loop
// already renders in the client portal.
export const ASK_EVIDENCE_TYPES = Object.freeze([
  'business_purpose',
  'payroll_package',
  'document_discrepancy',
  'supporting_document',
  'bank_statement'
]);

// Doc-first terminal drain (Slice 3) — the vocabulary for DOCUMENT-anchored
// asks (a receipt/bill with NO bank line, chase_evidence disposition). Kept a
// separate constant so the bank-line item enum above stays byte-identical:
// 'payment_method' is the "how was this paid — cash, personal card, or an
// account we should have a statement for?" lane; 'bank_statement' is the
// existing statement-request lane pointed at the document's implied account.
export const DOC_ASK_EVIDENCE_TYPES = Object.freeze([
  'payment_method',
  'bank_statement',
  'supporting_document',
  // The needs_human doc lane: the disposition pass could not tell what the item
  // IS (business-vs-personal / purpose unclear), so the ask is for an
  // explanation, not a document — mirrors the bank-line needs_human lane, which
  // already uses this same evidence type. Already a valid DB evidence_type
  // (bank-line asks emit it), so no migration.
  'business_purpose'
]);

let dotEnvCache = null;

const readDotEnv = () => {
  if (dotEnvCache) return dotEnvCache;
  const vars = {};
  try {
    const envPath = resolvePath(process.cwd(), '.env');
    if (existsSync(envPath)) {
      for (const line of readFileSync(envPath, 'utf8').split('\n')) {
        const match = line.match(/^(\w+)=(.*)$/);
        if (match) vars[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
      }
    }
  } catch {
    // Best-effort dotenv fallback for local development.
  }
  dotEnvCache = vars;
  return vars;
};

const resolveDrafter = (openAiConfig = null) => resolveTextLaneProvider({
  providers: LANE_PROVIDERS, openAiDefaultModel: DEFAULT_MODEL, dotEnv: readDotEnv(), openAiConfig
});

const askPipelineUnavailable = (message, providerFailure = null) => {
  const error = new Error(message);
  error.statusCode = 503;
  error.code = 'ASK_PIPELINE_LLM_UNAVAILABLE';
  // The typed transport cause rides the error (and its `details`, which the
  // outbox writer persists on the dead letter): a 401 says "the key", a
  // timeout says "the deadline", a reset socket says "the network" — never
  // an anonymous "fetch failed" the recovery cannot recognise.
  if (providerFailure) {
    error.provider_failure = providerFailure;
    error.details = { provider_failure: providerFailure };
  }
  return error;
};

const malformedDraft = (message) => {
  const error = new Error(message);
  error.statusCode = 502;
  error.code = 'ASK_PIPELINE_BAD_DRAFT';
  return error;
};

const clamp = (value, max) => String(value ?? '').trim().slice(0, max);

const verdictInputFor = (suggestion = {}) => ({
  proposed_account: clamp(suggestion.proposed_account, 160),
  confidence: clamp(suggestion.confidence, 12),
  evidence_required: Boolean(suggestion.evidence_required),
  ask_client_question: clamp(suggestion.ask_client_question, 500),
  reasoning: clamp(suggestion.reasoning, 500),
  support_note: clamp(suggestion.support_note, 500),
  materiality: clamp(suggestion.materiality, 12),
  warnings: (Array.isArray(suggestion.warnings) ? suggestion.warnings : [])
    .map((warning) => clamp(warning, 200))
    .filter(Boolean)
    .slice(0, 5),
  alternatives: (Array.isArray(suggestion.alternatives) ? suggestion.alternatives : [])
    .map((alternative) => ({
      account: clamp(alternative.account, 160),
      label: clamp(alternative.label, 120),
      confidence: clamp(alternative.confidence, 12),
      reasoning: clamp(alternative.reasoning, 240)
    }))
    .filter((alternative) => alternative.account)
    .slice(0, 3)
});

// Path Y (supplementary context) — the bank-line disposition pass's read of
// the SAME line when the document matchers found nothing to match it to. It
// rides ALONGSIDE the coding verdict, never replacing it: a 'chase_evidence'
// disposition means a material money-in receipt is missing its substantiating
// report/invoice, which corroborates the "material undocumented revenue is an
// ask" rule. The drafting model treats it as a signal, not a gate. Null when
// no disposition verdict exists for the line.
const dispositionInputFor = (disposition) => {
  if (!disposition || typeof disposition !== 'object') return null;
  const value = clamp(disposition.disposition, 40);
  if (!value) return null;
  return {
    disposition: value,
    materiality: clamp(disposition.materiality, 12),
    reason: clamp(disposition.reason || disposition.unmatchable_reason, 80),
    reasoning: clamp(disposition.reasoning, 280)
  };
};

// Doc-first terminal drain (Slice 3) — the document disposition verdict
// (documentDispositionLlm), clamped verbatim like the bank-line sibling
// above. settlement_channel is the lane signal: cash/personal_card/unknown
// → the payment-method question; uncovered_account → a statement request.
const documentDispositionInputFor = (disposition) => {
  if (!disposition || typeof disposition !== 'object') return null;
  return {
    // The verdict itself — chase_evidence (settlement-channel question) vs
    // needs_human (business-purpose question). The gather feeds both now, so the
    // ask model must see which one to pick the right evidence_type.
    disposition: clamp(disposition.disposition, 24),
    settlement_channel: clamp(disposition.settlement_channel, 24),
    materiality: clamp(disposition.materiality, 12),
    expense_kind: clamp(disposition.expense_kind, 40),
    reasoning: clamp(disposition.reasoning, 280),
    downgraded_from: clamp(disposition.downgraded_from, 24)
  };
};

// The citable-basis law at the drafter's boundary. The FULL candidate list
// keeps flowing to the send-hold guard and the freshness receipt; what the
// model may SEE and NAME is the exclusive-citable subset — identity-bearing
// bases only, one line per document (assignExclusiveCitableEvidence). Before
// this, `selection: one_or_more_required` fired whenever ANY candidate
// existed, so an amount-only collision (a Careem payout named as the
// evidence for a counter deposit) or a far-dated same-token sibling (one
// Clover statement cited on four settlements) became a citation the model
// was CONTRACT-BOUND to make. Same slices as the model input (40 items,
// 8 candidates) so draft, validator and send derive identical sets.
const exclusiveCitableForCodingItems = (codingItems = []) => assignExclusiveCitableEvidence(new Map(
  (Array.isArray(codingItems) ? codingItems : []).slice(0, 40).map((item) => [
    String(item?.id || ''),
    (Array.isArray(item?.local_evidence_candidates) ? item.local_evidence_candidates : []).slice(0, 8)
  ])
));

// The prose instructions remain the semantic authority, but a dense batch can
// contain both locally evidenced and genuinely bare rows. Put the trusted
// per-item selection boundary beside each row so the model never has to infer
// an allowlist from other items' globally visible document handles. The
// candidates handed in here are already the exclusive-citable subset; an
// empty list therefore means "ask without naming a file", including when
// uncitable candidates exist for the same line.
const localEvidenceOutputContract = (candidates = [], handles) => {
  const bounded = (Array.isArray(candidates) ? candidates : []).slice(0, 8);
  const allowedDocumentRefs = bounded
    .map((candidate) => handles.documents.refFor(candidate.id || candidate.document_id))
    .filter(Boolean);
  const hasCompleted = bounded.some((candidate) => candidate.parse_status === 'completed');
  const allUnreadable = bounded.length > 0
    && bounded.every((candidate) => ['skipped', 'failed'].includes(candidate.parse_status));
  return {
    allowed_document_refs: allowedDocumentRefs,
    selection: allowedDocumentRefs.length ? 'one_or_more_required' : 'must_be_empty',
    required_action: hasCompleted
      ? 'confirm_existing_file'
      : allUnreadable
        ? 'acknowledge_and_request_readable_replacement'
        : allowedDocumentRefs.length
          ? 'acknowledge_existing_file'
          : 'no_local_file',
    required_evidence_type: hasCompleted
      ? 'business_purpose'
      : allUnreadable
        ? 'supporting_document'
        : '',
    exact_filename_required: allowedDocumentRefs.length > 0
  };
};

// Model boundary — database ids are authority-bearing runtime identifiers, not
// language. Long ids from the same import commonly share nearly every byte, so
// asking a model to copy them can turn correct reasoning into a sibling id or a
// missing row. Give every model-visible object a short call-local handle and
// keep the reversible mapping inside this process. The same persisted id gets
// the same handle wherever it appears in the call.
const buildAskDraftHandleContext = ({
  codingItems = [],
  internalMovementLines = [],
  openEvidenceRequests = [],
  appliedFyiLines = [],
  documentItems = [],
  explainedDocuments = [],
  recordedSettlements = [],
  settlementReversals = [],
  agedTwinAsks = [],
  heldMatchConfirms = []
} = {}) => {
  const indexFor = (prefix) => {
    const idToRef = new Map();
    const refToId = new Map();
    return {
      register(value) {
        const id = String(value || '');
        if (!id) return null;
        if (!idToRef.has(id)) {
          const ref = `${prefix}_${idToRef.size + 1}`;
          idToRef.set(id, ref);
          refToId.set(ref, id);
        }
        return idToRef.get(id);
      },
      refFor(value) {
        const id = String(value || '');
        return id ? idToRef.get(id) || null : null;
      },
      idFor(value) {
        const ref = String(value || '');
        return ref ? refToId.get(ref) || null : null;
      }
    };
  };

  const transactions = indexFor('transaction');
  const documents = indexFor('document');
  const requests = indexFor('request');

  for (const item of codingItems.slice(0, 40)) transactions.register(item?.id);
  // Only the exclusive-citable subset gets a model-visible handle: a document
  // the model must never name has no ref to name it by.
  const citableByTransaction = exclusiveCitableForCodingItems(codingItems);
  for (const item of codingItems.slice(0, 40)) {
    for (const candidate of citableByTransaction.get(String(item?.id || '')) || []) {
      documents.register(candidate?.id || candidate?.document_id);
    }
  }
  for (const line of internalMovementLines.slice(0, 60)) transactions.register(line?.id);
  for (const request of openEvidenceRequests.slice(0, 80)) {
    requests.register(request?.id);
    transactions.register(request?.transaction_id);
  }
  for (const line of appliedFyiLines.slice(0, 40)) transactions.register(line?.transaction_id);
  for (const doc of documentItems.slice(0, 40)) documents.register(doc?.id);
  for (const doc of explainedDocuments.slice(0, 40)) documents.register(doc?.document_id);
  for (const doc of recordedSettlements.slice(0, 40)) documents.register(doc?.document_id);
  for (const doc of settlementReversals.slice(0, 40)) documents.register(doc?.document_id);
  for (const group of agedTwinAsks.slice(0, 10)) {
    transactions.register(group?.transaction_id);
    for (const candidate of (Array.isArray(group?.candidates) ? group.candidates : []).slice(0, 5)) {
      documents.register(candidate?.document_id);
    }
  }
  for (const group of heldMatchConfirms.slice(0, 10)) {
    transactions.register(group?.transaction_id);
    for (const candidate of (Array.isArray(group?.candidates) ? group.candidates : []).slice(0, 3)) {
      documents.register(candidate?.document_id);
    }
  }

  return { transactions, documents, requests };
};

// Shapes the gathered rows into the model input. Every coding item
// carries its persisted verdict VERBATIM (clamped, never rewritten) —
// the drafting model reads the coding model's own stated reasoning, not
// a paraphrase of it.
export const buildAskDraftInput = ({
  clientProfile = {},
  codingItems = [],
  internalMovementLines = [],
  statementCoverage = [],
  openEvidenceRequests = [],
  appliedFyiLines = [],
  documentItems = [],
  explainedDocuments = [],
  recordedSettlements = [],
  settlementReversals = [],
  agedTwinAsks = [],
  heldMatchConfirms = [],
  periodStart = null,
  periodEnd = null
} = {}, handleContext = null) => {
  const handles = handleContext || buildAskDraftHandleContext({
    codingItems,
    internalMovementLines,
    openEvidenceRequests,
    appliedFyiLines,
    documentItems,
    explainedDocuments,
    recordedSettlements,
    settlementReversals,
    agedTwinAsks,
    heldMatchConfirms
  });
  return ({
  client: {
    name: clientProfile.companyName || clientProfile.company_name || '',
    // The client's country by the resolver's own rule (ownerLanguage.js): the
    // jurisdiction column wins, the profile value only when the column is
    // empty, and no country when the two disagree.
    jurisdiction: ownerClientCountry(clientProfile.persisted_identity?.jurisdiction, clientProfile.jurisdiction),
    entity_type: clientProfile.entityType || '',
    accounting_currency:
      clientProfile.accountingCurrency || clientProfile.baseCurrency || clientProfile.defaultCurrency || '',
    // The language the owner reads ('fi' | 'en'). The prompt tells the model
    // to write every owner-facing word in it; nothing translates in code. The
    // client's country is its jurisdiction column (persisted_identity).
    language: preferredOwnerTemplateLanguage(clientProfile, clientProfile.persisted_identity)
  },
  period: { start: periodStart || null, end: periodEnd || null },
  coding_items: (() => {
    const citableByTransaction = exclusiveCitableForCodingItems(codingItems);
    return codingItems.slice(0, 40).map((item) => {
    const localCandidates = citableByTransaction.get(String(item?.id || '')) || [];
    return {
      transaction_ref: handles.transactions.refFor(item.id),
      date: item.date || item.transaction_date || null,
      description: clamp(item.description, 300),
      money_in: Number(item.money_in || 0),
      money_out: Number(item.money_out || 0),
      currency: item.account_currency || item.currency || '',
      reconciliation_status: item.reconciliation_status || '',
      verdict: verdictInputFor(item.ai_suggestion || item.payload?.ai_suggestion || {}),
      bank_line_disposition: dispositionInputFor(item.bank_line_disposition),
      // The client already uploaded these artifacts. They are not formal
      // matches yet (otherwise the ordinary ask gather would have excluded the
      // line), but the drafter must never describe them as missing. The runtime
      // validates the selected refs and wording before persistence and again at
      // send through the freshness receipt.
      local_evidence_candidates: localCandidates.map((candidate) => ({
          document_ref: handles.documents.refFor(candidate.id || candidate.document_id),
          filename: clamp(candidate.filename, 200),
          document_type: clamp(candidate.document_type, 40),
          parse_status: clamp(candidate.parse_status, 24),
          date: candidate.document_date || null,
          amount: candidate.total_amount == null ? null : Number(candidate.total_amount),
          currency: candidate.currency || '',
          candidate_basis: clamp(candidate.basis, 60)
        })),
      local_evidence_output_contract: localEvidenceOutputContract(localCandidates, handles)
    };
    });
  })(),
  internal_movement_lines: internalMovementLines.slice(0, 60).map((line) => ({
    transaction_ref: handles.transactions.refFor(line.id),
    date: line.date || line.transaction_date || null,
    description: clamp(line.description, 300),
    money_in: Number(line.money_in || 0),
    money_out: Number(line.money_out || 0),
    currency: line.currency || '',
    coded_account: clamp(line.coded_account, 160)
  })),
  statement_coverage: statementCoverage.slice(0, 60).map((doc) => ({
    document_type: doc.document_type || '',
    filename: clamp(doc.filename, 200),
    bank_name: clamp(doc.statement_summary?.bank_name, 160),
    account_number: clamp(doc.statement_summary?.account_number, 64),
    iban: clamp(doc.statement_summary?.iban, 64),
    period_label: clamp(doc.period_label, 120),
    currency: doc.statement_currency || '',
    parse_status: doc.parse_status || ''
  })),
  open_evidence_requests: openEvidenceRequests.slice(0, 80).map((request) => ({
    request_ref: handles.requests.refFor(request.id),
    transaction_ref: handles.transactions.refFor(request.transaction_id),
    status: request.status || '',
    sent_at: request.sent_at || request.first_sent_at || null,
    send_count: Number(request.send_count || 0),
    evidence_type: request.evidence_type || '',
    question: clamp(request.question, 500)
  })),
  // E3 — bank lines the firm has ALREADY matched to a document and posted (a
  // confident material auto-FYI accept; payload.authorization.material_auto_fyi).
  // NOT asks, NOT pending: the model summarises them in a courtesy "Already
  // matched & posted" section the owner can correct. This completed-transition
  // input is the only transaction FYI lane; unresolved items cannot become FYIs.
  posted_matches: appliedFyiLines.slice(0, 40).map((line) => ({
    transaction_ref: handles.transactions.refFor(line.transaction_id),
    date: line.date || null,
    description: clamp(line.description, 300),
    money_in: Number(line.money_in || 0),
    money_out: Number(line.money_out || 0),
    currency: line.currency || '',
    matched_to: clamp(line.matched_document_type, 60),
    counterparty: clamp(line.counterparty, 160),
    reference: clamp(line.reference, 80),
    coded_account: clamp(line.coded_account, 160),
    journal_lines: line.journal_lines || [],
    // RT-21e: the listed settlement row this credit settled (a consolidated
    // statement), so the FYI reads "VKO5 2025 (27.1.–2.2.) · net 2452.72",
    // not the statement total.
    settlement_row: line.settlement_row && line.settlement_row.line_no != null
      ? clamp(`row ${line.settlement_row.line_no}: ${line.settlement_row.label || ''}${line.settlement_row.net != null ? ` · net ${line.settlement_row.net}` : ''}`, 200)
      : ''
  })),
  // Doc-first terminal drain (Slice 3) — uploaded documents the matchers
  // found NO bank line for, whose persisted disposition says only the OWNER
  // can resolve them (chase_evidence). Each becomes a document_asks entry.
  document_items: documentItems.slice(0, 40).map((doc) => ({
    document_ref: handles.documents.refFor(doc.id),
    document_type: clamp(doc.document_type, 40),
    counterparty: clamp(doc.counterparty, 160),
    filename: clamp(doc.filename, 200),
    amount: Number(doc.amount || 0),
    currency: doc.currency || '',
    date: doc.date || null,
    disposition: documentDispositionInputFor(doc.disposition)
  })),
  // Doc-first terminal drain (Slice 3) — documents the firm auto-explained
  // (settled outside the visible bank feed) awaiting their one-time courtesy
  // FYI. Decided but NOT posted — the drafter must never call them recorded.
  explained_documents: explainedDocuments.slice(0, 40).map((doc) => ({
    document_ref: handles.documents.refFor(doc.document_id),
    document_type: clamp(doc.document_type, 40),
    counterparty: clamp(doc.counterparty, 160),
    amount: Number(doc.amount || 0),
    currency: doc.currency || '',
    date: doc.date || null,
    expense_kind: clamp(doc.expense_kind, 40),
    settlement_channel: clamp(doc.settlement_channel, 24)
  })),
  // Twin-aging lane (design 2026-07-06 §1) — bank lines the matcher matched
  // to candidates it ITSELF judged indistinguishable, now aged past the 3-day
  // clock at 'suggested'. Each entry carries the persisted match verdicts
  // VERBATIM (clamped, never rewritten): the candidates and the matcher's own
  // tie reasoning. The drafter turns each into ONE owner question ("which of
  // these pays this line?"); the send path mints the evidence request.
  aged_twin_asks: agedTwinAsks.slice(0, 10).map((group) => ({
    transaction_ref: handles.transactions.refFor(group.transaction_id),
    date: group.date || null,
    description: clamp(group.description, 300),
    money_in: Number(group.money_in || 0),
    money_out: Number(group.money_out || 0),
    currency: group.currency || '',
    aged_days: Number(group.aged_days || 0),
    candidates: (Array.isArray(group.candidates) ? group.candidates : [])
      .slice(0, 5)
      .map((candidate) => ({
        document_ref: handles.documents.refFor(candidate.document_id),
        document_type: clamp(candidate.document_type, 40),
        counterparty: clamp(candidate.counterparty, 160),
        filename: clamp(candidate.filename, 200),
        amount: Number(candidate.amount || 0),
        currency: candidate.currency || '',
        date: candidate.date || null,
        confidence: candidate.confidence != null ? Number(candidate.confidence) : null,
        matcher_reasoning: clamp(candidate.matcher_reasoning, 280)
      }))
  })),
  // Material-hold lane (2026-08-25) — bank lines the matcher matched to ONE
  // candidate with high confidence, resting at 'suggested' only because the
  // amount is above the firm's auto-reconcile authority. Each carries the
  // matcher's persisted verdict VERBATIM; the drafter turns it into ONE
  // owner CONFIRM question; the send path mints the evidence request.
  held_match_confirms: heldMatchConfirms.slice(0, 10).map((group) => ({
    transaction_ref: handles.transactions.refFor(group.transaction_id),
    date: group.date || null,
    description: clamp(group.description, 300),
    money_in: Number(group.money_in || 0),
    money_out: Number(group.money_out || 0),
    currency: group.currency || '',
    hold_reasons: (Array.isArray(group.hold_reasons) ? group.hold_reasons : []).slice(0, 4),
    candidates: (Array.isArray(group.candidates) ? group.candidates : [])
      .slice(0, 3)
      .map((candidate) => ({
        document_ref: handles.documents.refFor(candidate.document_id),
        document_type: clamp(candidate.document_type, 40),
        counterparty: clamp(candidate.counterparty, 160),
        filename: clamp(candidate.filename, 200),
        amount: Number(candidate.amount || 0),
        currency: candidate.currency || '',
        date: candidate.date || null,
        confidence: candidate.confidence != null ? Number(candidate.confidence) : null,
        matcher_reasoning: clamp(candidate.matcher_reasoning, 280)
      }))
  })),
  // Slice 4b — documents whose settlement entry the firm has POSTED under
  // its delegated authority (DR expense / CR owner funds). Unlike
  // explained_documents these ARE recorded — the drafter says so, once,
  // as a courtesy the owner can correct.
  recorded_settlements: recordedSettlements.slice(0, 40).map((doc) => ({
    document_ref: handles.documents.refFor(doc.document_id),
    document_type: clamp(doc.document_type, 40),
    counterparty: clamp(doc.counterparty, 160),
    amount: Number(doc.amount || 0),
    currency: doc.currency || '',
    date: doc.date || null,
    expense_account: clamp(doc.expense_account, 160),
    settlement_channel: clamp(doc.settlement_channel, 24)
  })),
  // Late-bank-line reversal guard — documents the firm had recorded as paid
  // from the owner's own funds whose charge then ALSO appeared on the bank
  // statement: the owner-funds entry was reversed and the expense books once,
  // against the bank line. The drafter says so, once, as a correction FYI the
  // owner can dispute; the bank line rides along so the message can name it.
  settlement_reversals: settlementReversals.slice(0, 40).map((doc) => ({
    document_ref: handles.documents.refFor(doc.document_id),
    document_type: clamp(doc.document_type, 40),
    counterparty: clamp(doc.counterparty, 160),
    amount: Number(doc.amount || 0),
    currency: doc.currency || '',
    date: doc.date || null,
    expense_account: clamp(doc.expense_account, 160),
    settlement_channel: clamp(doc.settlement_channel, 24),
    bank_line_date: doc.bank_line_date || null,
    bank_line_description: clamp(doc.bank_line_description, 300)
  }))
  });
};

export const buildAskMessageSchema = () => ({
  type: 'object',
  additionalProperties: false,
  required: ['subject', 'message_markdown', 'summary', 'items', 'statement_requests', 'document_asks'],
  properties: {
    subject: { type: 'string' },
    message_markdown: { type: 'string' },
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['transaction_ref', 'disposition', 'question', 'evidence_type', 'fyi_note', 'skip_reason', 'local_document_refs'],
        properties: {
          transaction_ref: { type: 'string' },
          disposition: { type: 'string', enum: [...ASK_DISPOSITIONS] },
          question: { type: 'string', minLength: 1 },
          evidence_type: { type: 'string', enum: [...ASK_EVIDENCE_TYPES] },
          fyi_note: { type: 'string' },
          skip_reason: { type: 'string' },
          local_document_refs: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    statement_requests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['account_reference', 'institution', 'reason', 'request_text', 'anchor_transaction_refs'],
        properties: {
          account_reference: { type: 'string' },
          institution: { type: 'string' },
          reason: { type: 'string' },
          request_text: { type: 'string' },
          anchor_transaction_refs: { type: 'array', items: { type: 'string' } }
        }
      }
    },
    document_asks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['document_ref', 'disposition', 'question', 'evidence_type', 'skip_reason'],
        properties: {
          document_ref: { type: 'string' },
          disposition: { type: 'string', enum: ['ask'] },
          question: { type: 'string', minLength: 1 },
          evidence_type: { type: 'string', enum: [...DOC_ASK_EVIDENCE_TYPES] },
          skip_reason: { type: 'string' }
        }
      }
    }
  }
});

const instructions = `You draft the bookkeeping firm's periodic message to its client. The firm's pipeline has already coded the client's bank lines with a strong model; every coding item below carries that PERSISTED VERDICT — the proposed account, the coding model's own reasoning, its confidence, and (when it wanted client input) its ask_client_question. Your job is to turn those verdicts into ONE clear client message. Do not re-code the transactions and do not second-guess the verdicts.

Write in the owner's language. client.language is an ISO 639-1 code ("fi" = Finnish, "en" = English). Write subject, message_markdown, every question, request_text, and every other client-facing string entirely in that language, including section headings; the quoted example phrasings and section names in these instructions are illustrations in English, so render them in client.language. Keep amounts, currencies, dates, counterparty and company names, filenames, account numbers, IBANs, and document identifiers exactly as they appear in the input; never translate, convert, or reformat them. summary is internal and stays in English.

All fields ending in _ref are opaque CALL-LOCAL HANDLES, such as transaction_1, document_2, or request_3. Copy the exact handle from the input into the matching output field; do not alter, infer, shorten, or reorder its characters. Handles are only for output anchoring: never mention them in subject, message_markdown, summary, question, request_text, fyi_note, or any other client-facing prose.

open_evidence_requests is a deduplication inventory, not proof of customer contact. A draft with no sent_at and zero send_count is a question ready for review; it has NOT been sent. Never say questions were sent separately, that the client has been contacted, or that you are awaiting their reply without the corresponding delivery receipt. Do not infer delivery from an open or draft status, or from this inventory's name. If no questions in this message need an answer, acknowledge only the listed completed accounting; do not invent a claim about other messages.

For EVERY coding item, emit exactly one item with disposition "ask" and a non-empty question. The gather has already removed rows covered by an open request and rows already matched or posted. Anything still present is non-terminal, so "notify" and "skip" are not available: either would leave the row resting on neither the books nor the owner. Write ONE precise question grounded in the verdict's reasoning; sharpen the verdict's ask_client_question rather than inventing a new concern. Ask for a document only when a document should exist; set evidence_type accordingly (business_purpose when an explanation suffices, supporting_document when paper should exist, bank_statement for missing statements).

A coding item may carry local_evidence_candidates. Those are files the client has ALREADY supplied; they are plausible for this bank line but have not yet become a formal match. NEVER ask the client to send, upload, attach, or provide one of those files as though it were absent. Select at least one exact document_ref in local_document_refs and name its filename in the question and in message_markdown. When parse_status is completed, ask the client only to CONFIRM whether that existing file supports the line (evidence_type business_purpose). When every candidate is skipped or failed, say that the named file was received but Donna could not read it and ask for a clearer/readable replacement only if needed (evidence_type supporting_document). When local_evidence_candidates is empty, local_document_refs MUST be an empty array: ask plainly for what the line needs, and never name, guess, or describe any other uploaded file as this line's evidence — the runtime only lists a file on a line when it can honestly be cited for that line, and the same file is never listed on two lines. Do not select a local document that is not listed on that coding item.

Owner draws, distributions, transfers, and equity movements appear here only when Donna has NOT already posted them under authority. Ask the owner to confirm the treatment or supply the missing ownership/business-purpose fact. A true decide-and-notify item is posted first and arrives separately in posted_matches; never turn an unposted coding item into an FYI.

Material money-in with no document is ALWAYS an "ask". A MATERIAL deposit the firm RECEIVED — a payment-processor payout (Shopify, Stripe, Square, PayPal, Wise, Adyen, SumUp, …), a customer payment, or any sizeable unexplained credit — that carries no supporting document is an "ask" for the substantiating paper (the payout/settlement report, the customer invoice, or the deposit backup). A confident category is NOT a substantiated one: the net amount of a processor payout is gross sales minus fees, so booking it straight to "Sales"/revenue understates gross sales and hides the fees — a confidently-coded revenue line with money_in and no document NEVER becomes "notify" or "skip". Set evidence_type to supporting_document. If the line is instead an owner contribution, loan drawdown, refund, or transfer, ask the owner to confirm that fact unless it already appears in posted_matches.

Some coding items also carry a bank_line_disposition — a SEPARATE reconciliation pass's read of the same line after the document matchers found nothing to match it to. It is supplementary signal, never an override: your read of the verdict still governs. But when bank_line_disposition.disposition is "chase_evidence" (a material receipt/payout missing its substantiating report or invoice), treat it as corroborating the rule above — make that line an "ask" for the missing document; never "notify" or "skip" a line the disposition pass flagged as needing evidence.

A coding item may arrive with an EMPTY coding verdict (no proposed_account, no reasoning) but a populated bank_line_disposition — a bare unmatched bank line the reconciliation pass flagged for the owner, which the coder did not categorise. Do NOT treat the empty verdict as confidence. Drive these by their disposition: "chase_evidence" → an "ask" for the missing substantiating document (set evidence_type supporting_document); "needs_human" → an "ask" for the owner to explain what the line is (its business purpose / counterparty; evidence_type business_purpose). Materiality may shape how concise the question is, but it never permits omitting a gathered non-terminal row.

Judge each verdict's confidence from the WHOLE verdict, not from the absence of a question. A missing ask_client_question is not confidence: when a verdict's warnings hedge or cut against its proposed_account, when evidence_required is true, or when confidence is low, the coding model itself was unsure. The warning names exactly what is unresolved, so make the required "ask" grounded there.

Some inputs arrive as document_items — receipts, bills, or invoices the client uploaded for which NO bank line exists anywhere in the statements the firm holds. A reconciliation pass has already decided only the OWNER can resolve each one; its disposition rides along (its verdict is "disposition"; settlement_channel is where the pass thinks it settled, with its materiality and reasoning). For EVERY document_item, emit one entry in document_asks. Disposition "ask" with ONE precise question grounded in the document's counterparty, amount, and date. Choose evidence_type by the document's own disposition first, then its settlement signal:
- disposition "needs_human" — the pass could not tell what the item IS (business-vs-personal, or its purpose is unclear; read its reasoning). The answer is an EXPLANATION, not a document: set evidence_type "business_purpose" and ask the owner to confirm what the item was for and whether it is a business expense ("what was this <counterparty> charge for — is it a business expense, and how did you pay it?"). Do not demand a document for a needs_human item.
- disposition "chase_evidence" — the pass knows it is a business item but is missing where it settled. Choose from the settlement signal: "payment_method" when settlement_channel is cash, personal_card, or unknown — ask how the item was paid ("how was this paid — cash, a personal card, or a card/account we should have statements for?"); "bank_statement" when settlement_channel is uncovered_account or the coverage picture implies the paying account's statement is missing — ask for that account's statement; "supporting_document" only when the document itself implies further paper should exist.
The gather already excludes documents covered by an open evidence request. Therefore EVERY document_item must produce exactly one document_asks entry with disposition "ask" and a non-empty question. Never emit a document_asks entry for a document not listed in document_items, and never route a document_item through the transaction items array.

Some inputs arrive as aged_twin_asks — bank lines the firm's matcher matched to TWO OR MORE candidate documents it itself judged indistinguishable (same amount and counterparty; each candidate carries the matcher's own persisted reasoning), and the tie has now aged past the firm's clock without resolving on its own. Only the owner can break the tie. For EVERY aged_twin_asks entry emit one "ask" item on that entry's transaction_ref — these transaction refs are valid item anchors even though they are not listed in coding_items. Write ONE precise question asking which candidate settles the line, naming each candidate with its date, amount, and counterparty ("we have two $51.38 Exxon receipts (May 3 and May 5) and this May 4 card charge — which receipt does it pay?"). Set evidence_type to business_purpose (the answer is a choice, not a document). Never "notify" or "skip" an aged twin — the matcher already decided it cannot resolve this alone. When the same candidates plausibly pay SEVERAL listed lines (two identical charges, two identical receipts), still emit one item per listed transaction_ref, but phrase the questions so one reply can settle all of them.

Some inputs arrive as held_match_confirms — bank lines the firm's matcher matched to ONE candidate document with high confidence, resting unconfirmed only because the amount is above what the firm auto-reconciles without the owner's word. These transaction refs are valid item anchors even though they are not listed in coding_items. For EVERY held_match_confirms entry emit one "ask" item on that entry's transaction_ref: a short CONFIRM question naming the candidate with its date, amount, counterparty, and filename ("we matched your $831.35 land-lease payment on 1 Jun to the Sonoran Land Holdings bill (25-06-02_Land_Lease_831.35.pdf) — reply yes to confirm, or tell us if that's not it"). Set evidence_type to business_purpose (the answer is a confirmation, not a document). Never "notify" or "skip" a held_match_confirms entry — the firm has already decided this amount needs the owner's word, so a message that omits it leaves the line resting nowhere.

Some inputs arrive as explained_documents — small receipts or documents with no bank line that the firm has treated as settled OUTSIDE the visible bank feed (cash, the owner's personal card, or an account whose statement is simply expected later), under its standing authority. These are decided, NOT posted to the books, and NOT questions. Acknowledge them compactly in their own "Explained without a bank line" section: one line each with date, amount, and counterparty, phrased as a courtesy the owner can correct ("we've treated your $9.82 Exxon receipt as settled outside the bank account we see — likely cash or a personal card; reply if that's not right"). Never say these were recorded, booked, or posted; never turn one into a question; omit the section when explained_documents is empty.

Some inputs arrive as recorded_settlements — documents the firm has actually RECORDED in the books as paid from the owner's own funds (cash or a personal card), under its standing authority: the expense is booked to expense_account and owed back to the owner. These ARE posted — like posted_matches, it is correct to say so here (the second exception to the "never say recorded" rule below). Acknowledge them in their own "Recorded as paid from your own funds" section: one compact line each with date, amount, counterparty, and the account it was booked to, phrased as a courtesy the owner can correct ("we've recorded your $41.20 Exxon receipt as paid from your own funds and booked it to Motor vehicle expenses — reply if that's not right"). Never turn one into a question; never double-list a document in both this section and "Explained without a bank line"; omit the section when recorded_settlements is empty.

Some inputs arrive as settlement_reversals — documents the firm had earlier recorded as paid from the owner's own funds whose charge then ALSO showed up on the bank statement (bank_line_date / bank_line_description name the statement line). The firm has already CORRECTED the books: the owner-funds entry was reversed and the expense now books once, against the bank line. This is a done correction, not a question. Acknowledge each in its own "Corrected: these turned out to be on your statement" section: one compact line with date, amount, counterparty, and the statement line it matched, phrased as a courtesy the owner can dispute ("your $41.20 Exxon receipt also appeared on your statement on May 16, so we reversed the paid-from-your-own-funds entry and the expense now books against the bank line. Reply if that is wrong."). Like posted_matches and recorded_settlements it is correct to say recorded/reversed here (the third exception to the "never say recorded" rule below). Never turn one into a question; never list the same document under recorded_settlements and here; omit the section when settlement_reversals is empty.

Counterpart-statement gap check: internal_movement_lines are movements between the client's own accounts; statement_coverage lists the accounts the firm HAS statements for (bank name, account number, IBAN). A credit-card or charge-card account the client pays from the bank (a card settlement like an Amex/Visa "EPAYMENT" coded to a card-payable account) counts as such an account too — the firm cannot break the settlement into its underlying charges without the card statement. When movement descriptions name or imply an account that no statement covers, add a statement_request for that account — the firm cannot reconcile the other side without it. Consolidate to ONE request per missing account (not per transaction), name the account exactly as the bank lines name it in account_reference, write the client-facing sentence in request_text, and list the transaction refs that reference the account in anchor_transaction_refs.

Some lines arrive as posted_matches — bank lines the firm has ALREADY matched to a document (an invoice, bill, or receipt the owner sent) and posted, or coded and posted directly under the firm's standing authority (matched_to says "owner transfer (posted directly)" — e.g. an owner draw posted to owner's drawings, where no document is needed), with no question outstanding and nothing to decide. These are DONE, not pending. Never turn a posted_match into a question, and never list it under notify. Acknowledge them in a separate "Already matched & posted" section: one compact line each (or combined where natural — "we matched 3 supplier bills totalling £2,140 to their payments"), naming the date, amount, what each was matched to, and how it's been treated, phrased as a courtesy heads-up the owner can correct ("we matched your £745 invoice to the 12 May card payment and booked it to Sales — reply if that's not right"). Because posted_matches ARE matched and posted, it is correct to say so here — posted_matches and recorded_settlements are the only places the "still pending, never say recorded" rule below does NOT apply. Only summarise what posted_matches lists; never invent one. Omit the section when posted_matches is empty.

Compose message_markdown as the complete, ready-to-send message: a one-or-two-sentence opener saying what the firm finished and what it needs; a "Questions we need answered" numbered section where each question carries its date and amount so the client can find the item (document_asks belong here too — or in their own "Receipts with no bank line" subsection when that reads clearer); a "Statements to send over" section for statement requests; an "Explained without a bank line" section for explained_documents as described above; a "Recorded as paid from your own funds" section for recorded_settlements as described above; a "Corrected: these turned out to be on your statement" section for settlement_reversals as described above; and an "Already matched & posted" section for posted_matches as described above. Omit any empty section. Plain, warm, jargon-free language a business owner reads in one minute; never mention models, verdicts, pipelines, or internal tooling. Do not re-ask anything listed in open_evidence_requests.

FINAL LOCAL-EVIDENCE CHECK — inspect EACH coding item independently before returning JSON. Copy local_document_refs only from that same item's local_evidence_output_contract.allowed_document_refs; never borrow a document_ref from another item. If selection is must_be_empty, output an empty local_document_refs array. Otherwise obey required_action and required_evidence_type, and copy the selected file's exact filename into both that item's question and its own message_markdown line. A completed existing file is a confirmation question, never an upload request.

subject is a short email-style subject line. summary is one internal sentence for the firm's review surface describing what the message asks and notifies.`;

const outputTextFromResponse = (response = {}) => {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output || []) {
    for (const content of item.content || []) {
      if (typeof content.text === 'string') return content.text;
    }
  }
  return '';
};

// Trusted rehydration boundary. The model can select only handles that existed
// in this exact call; persisted ids are restored only after the response is
// back inside the runtime. Unknown handles fail the whole draft rather than
// being guessed, filtered, or allowed to anchor an ask to a sibling row.
const rehydrateAskDraftReferences = (draft = {}, handles) => {
  const failures = [];
  const resolveRef = (index, value, path) => {
    const ref = String(value || '');
    const id = index.idFor(ref);
    if (!id) failures.push(`${path}:${ref || 'missing_ref'}:not_in_input`);
    return id || '';
  };

  const items = (Array.isArray(draft.items) ? draft.items : []).map((item, index) => {
    const {
      transaction_ref: transactionRef,
      local_document_refs: localDocumentRefs,
      ...rest
    } = item || {};
    return {
      ...rest,
      transaction_id: resolveRef(handles.transactions, transactionRef, `items[${index}].transaction_ref`),
      local_document_ids: (Array.isArray(localDocumentRefs) ? localDocumentRefs : []).map((ref, refIndex) =>
        resolveRef(handles.documents, ref, `items[${index}].local_document_refs[${refIndex}]`))
    };
  });
  const statementRequests = (Array.isArray(draft.statement_requests) ? draft.statement_requests : [])
    .map((request, requestIndex) => {
      const { anchor_transaction_refs: anchorRefs, ...rest } = request || {};
      return {
        ...rest,
        anchor_transaction_ids: (Array.isArray(anchorRefs) ? anchorRefs : []).map((ref, refIndex) =>
          resolveRef(
            handles.transactions,
            ref,
            `statement_requests[${requestIndex}].anchor_transaction_refs[${refIndex}]`
          ))
      };
    });
  const documentAsks = (Array.isArray(draft.document_asks) ? draft.document_asks : [])
    .map((item, index) => {
      const { document_ref: documentRef, ...rest } = item || {};
      return {
        ...rest,
        document_id: resolveRef(handles.documents, documentRef, `document_asks[${index}].document_ref`)
      };
    });

  if (failures.length) {
    const error = malformedDraft(`Draft selected call-local handles that were not in its input: ${failures.join(', ')}.`);
    error.details = { failures };
    throw error;
  }
  return {
    ...draft,
    items,
    statement_requests: statementRequests,
    document_asks: documentAsks
  };
};

const uniqueInputIds = (values = []) => [...new Set((Array.isArray(values) ? values : [])
  .filter(Boolean)
  .map((value) => String(value)))];

// FIRST boundary: every model-visible unresolved item must leave the model
// as exactly one non-empty owner ask. The gather already removes anything
// covered by a live ask or completed accounting transition, so omission,
// notify, and skip are all malformed — each would manufacture a third state.
// This assertion is exported so the DB assembler can re-run it around injected
// draft seams and the send writer can enforce it again under the row lock.
export const assertAskDraftTerminalCoverage = (draft = {}, {
  codingItems = [],
  documentItems = [],
  agedTwinAsks = [],
  heldMatchConfirms = [],
  rejectUnknown = false
} = {}) => {
  const expectedTransactionIds = uniqueInputIds([
    ...codingItems.map((item) => item?.id),
    ...(Array.isArray(agedTwinAsks) ? agedTwinAsks : []).map((group) => group?.transaction_id),
    ...(Array.isArray(heldMatchConfirms) ? heldMatchConfirms : []).map((group) => group?.transaction_id)
  ]);
  const expectedDocumentIds = uniqueInputIds(documentItems.map((item) => item?.id));
  const expectedTransactionSet = new Set(expectedTransactionIds);
  const expectedDocumentSet = new Set(expectedDocumentIds);
  const itemsByTransaction = new Map();
  const asksByDocument = new Map();
  const failures = [];

  for (const item of Array.isArray(draft.items) ? draft.items : []) {
    const id = String(item?.transaction_id || '');
    if (!expectedTransactionSet.has(id)) {
      if (rejectUnknown) failures.push(`transaction:${id || 'missing_id'}:not_in_input`);
      continue;
    }
    const entries = itemsByTransaction.get(id) || [];
    entries.push(item);
    itemsByTransaction.set(id, entries);
  }
  for (const item of Array.isArray(draft.document_asks) ? draft.document_asks : []) {
    const id = String(item?.document_id || '');
    if (!expectedDocumentSet.has(id)) {
      if (rejectUnknown) failures.push(`document:${id || 'missing_id'}:not_in_input`);
      continue;
    }
    const entries = asksByDocument.get(id) || [];
    entries.push(item);
    asksByDocument.set(id, entries);
  }

  const assertOneAsk = ({ id, entries, kind }) => {
    if (entries.length !== 1) {
      failures.push(`${kind}:${id}:${entries.length === 0 ? 'missing' : 'duplicate'}`);
      return;
    }
    const item = entries[0];
    if (item?.disposition !== 'ask') failures.push(`${kind}:${id}:nonterminal_${item?.disposition || 'empty'}`);
    if (!clamp(item?.question, 500)) failures.push(`${kind}:${id}:empty_question`);
  };
  for (const id of expectedTransactionIds) {
    assertOneAsk({ id, entries: itemsByTransaction.get(id) || [], kind: 'transaction' });
  }
  for (const id of expectedDocumentIds) {
    assertOneAsk({ id, entries: asksByDocument.get(id) || [], kind: 'document' });
  }
  if (failures.length) {
    const error = malformedDraft(`Draft left unresolved items without one owner ask: ${failures.join(', ')}.`);
    error.details = {
      failures,
      expected_transaction_ids: expectedTransactionIds,
      expected_document_ids: expectedDocumentIds
    };
    throw error;
  }
  return {
    transaction_ids: expectedTransactionIds,
    document_ids: expectedDocumentIds
  };
};

// Existing-material boundary. A plausible local document is not missing
// evidence. The model may ask the owner to confirm the proposed pairing, or
// (for a terminal unreadable file) request a clearer replacement, but it may
// not ask for the same artifact again. Structured document selections make
// the rule enforceable without rewriting model-authored prose.
export const assertAskDraftLocalEvidenceIntegrity = (draft = {}, {
  codingItems = [],
  rejectUnknown = false
} = {}) => {
  const candidatesByTransaction = new Map();
  for (const item of Array.isArray(codingItems) ? codingItems : []) {
    const candidates = (Array.isArray(item?.local_evidence_candidates)
      ? item.local_evidence_candidates
      : []).map((candidate) => ({
        id: String(candidate?.id || candidate?.document_id || ''),
        filename: String(candidate?.filename || ''),
        parse_status: String(candidate?.parse_status || '')
      })).filter((candidate) => candidate.id);
    candidatesByTransaction.set(String(item?.id || ''), candidates);
  }
  // Lock-step with the drafter's output contract (and, through the persisted
  // freshness receipt, with send): what may be SELECTED is the
  // exclusive-citable subset, and a selection is REQUIRED only when that
  // subset is non-empty. A line whose only candidates are uncitable
  // (amount-only, or a shared document another line won) must ask without
  // naming a file — before this, `local_evidence_ignored` forced a citation
  // whenever ANY candidate existed, which is exactly how the wrong-file
  // claims shipped.
  const citableByTransaction = new Map(
    [...exclusiveCitableForCodingItems(codingItems).entries()].map(([transactionId, citable]) => [
      transactionId,
      new Set(citable.map((candidate) => String(candidate?.id || candidate?.document_id || '')).filter(Boolean))
    ])
  );

  const failures = [];
  const selectedReceipt = {};
  const messageLines = String(draft?.message_markdown || '').toLowerCase().split(/\r?\n/);
  for (const item of Array.isArray(draft?.items) ? draft.items : []) {
    const transactionId = String(item?.transaction_id || '');
    if (!candidatesByTransaction.has(transactionId)) {
      if (rejectUnknown && (item?.local_document_ids || []).length) {
        failures.push(`transaction:${transactionId || 'missing_id'}:local_documents_not_in_input`);
      }
      continue;
    }
    const candidates = candidatesByTransaction.get(transactionId) || [];
    const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
    const citableIds = citableByTransaction.get(transactionId) || new Set();
    const selectedIds = uniqueInputIds(item?.local_document_ids || []);
    const unknownIds = selectedIds.filter((id) => !byId.has(id));
    if (unknownIds.length) {
      failures.push(`transaction:${transactionId}:unknown_local_documents:${unknownIds.join('|')}`);
    }
    const uncitableIds = selectedIds.filter((id) => byId.has(id) && !citableIds.has(id));
    if (uncitableIds.length) {
      failures.push(`transaction:${transactionId}:uncitable_local_documents:${uncitableIds.join('|')}`);
    }
    if (!candidates.length && selectedIds.length) {
      failures.push(`transaction:${transactionId}:unexpected_local_document_selection`);
    }
    if (citableIds.size && !selectedIds.length) {
      failures.push(`transaction:${transactionId}:local_evidence_ignored`);
      continue;
    }
    if (!selectedIds.length) continue;

    const selected = selectedIds.map((id) => byId.get(id)).filter(Boolean);
    const question = String(item?.question || '').toLowerCase();
    for (const candidate of selected) {
      const filename = candidate.filename.toLowerCase();
      if (filename && !question.includes(filename)) {
        failures.push(`transaction:${transactionId}:question_omits_filename:${candidate.id}`);
      }
      if (filename && !messageLines.some((line) => line.includes(filename))) {
        failures.push(`transaction:${transactionId}:message_omits_filename:${candidate.id}`);
      }
    }
    const selectedCompleted = selected.some((candidate) => candidate.parse_status === 'completed');
    const selectedUnreadable = selected.length > 0
      && selected.every((candidate) => ['skipped', 'failed'].includes(candidate.parse_status));
    // The batch message contains every item's question. A legitimate request
    // to upload evidence for one bare line must not make every OTHER line with
    // completed local evidence look like a repeated upload request. Scope the
    // prose guard to this structured question plus the message line(s) that
    // name this item's selected file. The exact-filename requirement above
    // makes that association deterministic without rewriting model prose.
    const localMessageLines = selected
      .flatMap((candidate) => {
        const filename = candidate.filename.toLowerCase();
        return filename ? messageLines.filter((line) => line.includes(filename)) : [];
      });
    const combinedProse = `${question}\n${localMessageLines.join('\n')}`;
    if (selectedCompleted) {
      if (item?.evidence_type !== 'business_purpose') {
        failures.push(`transaction:${transactionId}:completed_local_evidence_wrong_type`);
      }
      if (/\b(?:send|upload|attach|provide)\b/.test(combinedProse)) {
        failures.push(`transaction:${transactionId}:reasks_completed_local_evidence`);
      }
    }
    if (selectedUnreadable
        && !/\b(?:received|unreadable|clearer|readable|replacement|could not read|couldn't read|could not process|couldn't process)\b/.test(combinedProse)) {
      failures.push(`transaction:${transactionId}:unreadable_local_evidence_not_acknowledged`);
    }
    selectedReceipt[transactionId] = selectedIds;
  }
  if (failures.length) {
    const error = malformedDraft(`Draft mishandled evidence already held locally: ${failures.join(', ')}.`);
    error.details = { failures };
    throw error;
  }
  return selectedReceipt;
};

// Schema-shape enforcement ONLY (system correctness): items must point at
// inputs we actually handed the model and strings get clamped. The model's
// wording is rendered, not rewritten; terminal coverage is refused above.
export const sanitizeAskMessageDraft = (draft = {}, { codingItems = [], internalMovementLines = [], documentItems = [], agedTwinAsks = [], heldMatchConfirms = [] } = {}) => {
  assertAskDraftTerminalCoverage(draft, {
    codingItems,
    documentItems,
    agedTwinAsks,
    heldMatchConfirms
  });
  assertAskDraftLocalEvidenceIntegrity(draft, { codingItems });
  // Twin-aging lane: an aged twin's bank line is a legitimate item anchor even
  // though it is not a coding candidate (its verdict is the MATCH ambiguity,
  // not a coding suggestion) — the send path mints its evidence request off
  // the item exactly like any other ask.
  const codingIds = new Set([
    ...codingItems.map((item) => item.id).filter(Boolean),
    ...(Array.isArray(agedTwinAsks) ? agedTwinAsks : []).map((group) => group.transaction_id).filter(Boolean),
    // Material-hold lane: a held match's bank line is likewise a legitimate
    // anchor — its verdict is the authority hold, not a coding suggestion.
    ...(Array.isArray(heldMatchConfirms) ? heldMatchConfirms : []).map((group) => group.transaction_id).filter(Boolean)
  ]);
  const anchorIds = new Set([
    ...codingIds,
    ...internalMovementLines.map((line) => line.id).filter(Boolean)
  ]);
  const documentIds = new Set(documentItems.map((doc) => doc.id).filter(Boolean));

  const seen = new Set();
  const items = (Array.isArray(draft.items) ? draft.items : [])
    .filter((item) => codingIds.has(item.transaction_id))
    .filter((item) => {
      if (seen.has(item.transaction_id)) return false;
      seen.add(item.transaction_id);
      return true;
    })
    .map((item) => ({
        transaction_id: item.transaction_id,
        disposition: 'ask',
        question: clamp(item.question, 500),
        evidence_type: ASK_EVIDENCE_TYPES.includes(item.evidence_type)
          ? item.evidence_type
          : 'supporting_document',
        fyi_note: clamp(item.fyi_note, 400),
        skip_reason: clamp(item.skip_reason, 240),
        local_document_ids: uniqueInputIds(item.local_document_ids || []).slice(0, 8)
      }));

  const statementRequests = (Array.isArray(draft.statement_requests) ? draft.statement_requests : [])
    .map((request) => ({
      account_reference: clamp(request.account_reference, 120),
      institution: clamp(request.institution, 120),
      reason: clamp(request.reason, 300),
      request_text: clamp(request.request_text, 500),
      anchor_transaction_ids: (Array.isArray(request.anchor_transaction_ids) ? request.anchor_transaction_ids : [])
        .filter((id) => anchorIds.has(id))
        .slice(0, 20)
    }))
    .filter((request) => request.request_text)
    .slice(0, 10);

  // Doc-first terminal drain (Slice 3) — same shape enforcement as items:
  // document_asks must point at documents we actually handed the model and
  // dedupe per doc. Terminal coverage above already refused omission/skip.
  const seenDocs = new Set();
  const documentAsks = (Array.isArray(draft.document_asks) ? draft.document_asks : [])
    .filter((item) => documentIds.has(item.document_id))
    .filter((item) => {
      if (seenDocs.has(item.document_id)) return false;
      seenDocs.add(item.document_id);
      return true;
    })
    .map((item) => ({
        document_id: item.document_id,
        disposition: 'ask',
        question: clamp(item.question, 500),
        evidence_type: DOC_ASK_EVIDENCE_TYPES.includes(item.evidence_type)
          ? item.evidence_type
          : 'payment_method',
        skip_reason: clamp(item.skip_reason, 240)
      }));

  const messageMarkdown = clamp(draft.message_markdown, 12000);
  if (!messageMarkdown) {
    throw malformedDraft('Drafting model returned an empty message body.');
  }

  return {
    subject: clamp(draft.subject, 200) || 'Bookkeeping questions and updates',
    message_markdown: messageMarkdown,
    summary: clamp(draft.summary, 500),
    items,
    statement_requests: statementRequests,
    document_asks: documentAsks,
    counts: {
      ask: items.filter((item) => item.disposition === 'ask').length,
      notify: items.filter((item) => item.disposition === 'notify').length,
      skip: items.filter((item) => item.disposition === 'skip').length,
      statement_requests: statementRequests.length,
      document_asks: documentAsks.filter((item) => item.disposition === 'ask').length
    }
  };
};

export const draftClientAskMessage = async ({
  clientProfile = {},
  codingItems = [],
  internalMovementLines = [],
  statementCoverage = [],
  openEvidenceRequests = [],
  appliedFyiLines = [],
  documentItems = [],
  explainedDocuments = [],
  recordedSettlements = [],
  settlementReversals = [],
  agedTwinAsks = [],
  heldMatchConfirms = [],
  periodStart = null,
  periodEnd = null,
  fetchImpl = fetch,
  openAiConfig = null
} = {}) => {
  const resolved = resolveDrafter(openAiConfig);
  if (!resolved.ok) {
    const { provider, keyName } = missingKeyNameFor(resolved, LANE_PROVIDERS);
    throw askPipelineUnavailable(
      `No model key is configured (${keyName || 'ANTHROPIC_API_KEY'}); the ask-pipeline has no fallback drafter by design.`,
      providerFailureReceipt(providerKeyMissing(provider || 'anthropic', { keyName }))
    );
  }
  const config = { apiKey: resolved.apiKey, model: resolved.model };

  const draftInputs = {
    clientProfile,
    codingItems,
    internalMovementLines,
    statementCoverage,
    openEvidenceRequests,
    appliedFyiLines,
    documentItems,
    explainedDocuments,
    recordedSettlements,
    settlementReversals,
    agedTwinAsks,
    heldMatchConfirms,
    periodStart,
    periodEnd
  };
  const handles = buildAskDraftHandleContext(draftInputs);
  const input = buildAskDraftInput(draftInputs, handles);

  let payload;
  let parsed = null;
  if (resolved.provider === 'anthropic') {
    // The same instructions, input and schema on the Messages API, through
    // the shared envelope. Every failure — no credit, a bad key, a rate
    // limit, a refusal, an output cut at max_tokens, an unreadable or
    // schema-breaking body — is the same ASK_PIPELINE_LLM_UNAVAILABLE with
    // the typed cause, exactly like the OpenAI path below.
    let call;
    try {
      call = await llmCall(anthropicStructuredRequest({
        apiKey: config.apiKey,
        model: config.model,
        system: instructions,
        user: JSON.stringify(input),
        schema: buildAskMessageSchema(),
        effort: ANTHROPIC_EFFORT,
        maxTokens: 64000,
        stream: true,
        cacheSystem: true,
        timeoutMs: ANTHROPIC_TIMEOUT_MS,
        execution: { root: { type: 'client_ask_draft', id: String(clientProfile?.id || clientProfile?.client_id || 'client') } },
        fetchImpl
      }));
    } catch (error) {
      const typed = typedLlmCallFailure('anthropic', error);
      if (!typed) throw error;
      const receipt = typed.receipt();
      throw askPipelineUnavailable(receipt.message || `Anthropic draft request failed (${receipt.code}).`, receipt);
    }
    payload = { model: call.result.model, id: call.result.response_id };
    parsed = call.result.parsed;
  } else {
    // ONE bounded call: headers + body under the deadline, capped by the
    // worker's execution budget. Every transport failure — a non-OK status, a
    // reset socket, a timeout — is the same typed cause on the same error code.
    try {
      ({ payload } = await callProviderJson({
        provider: 'openai',
        url: 'https://api.openai.com/v1/responses',
        init: {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${config.apiKey}`
          },
          body: JSON.stringify({
            model: config.model,
            instructions,
            input: JSON.stringify(input),
            store: false,
            text: {
              format: {
                type: 'json_schema',
                name: 'client_ask_message_draft',
                strict: true,
                schema: buildAskMessageSchema()
              }
            }
          })
        },
        fetchImpl
      }));
    } catch (error) {
      const receipt = providerFailureReceipt(error);
      if (!receipt) throw error;
      throw askPipelineUnavailable(receipt.message || `OpenAI draft request failed (${receipt.code}).`, receipt);
    }

    try {
      parsed = JSON.parse(outputTextFromResponse(payload));
    } catch {
      // An unreadable body is a transport-class failure (no draft exists to
      // render) and gets the same treatment as a reset socket — the outage
      // recovery re-requests it. A READABLE draft that violates the contract
      // (unknown handles, missing coverage) stays ASK_PIPELINE_BAD_DRAFT below:
      // that is the model's judgment failing, not the provider.
      const receipt = providerFailureReceipt(providerInvalidOutput('openai', {
        detail: 'the ask-message draft was not JSON', model: payload?.model || config.model
      }));
      throw askPipelineUnavailable(receipt.message, receipt);
    }
  }

  return {
    draft: sanitizeAskMessageDraft(
      rehydrateAskDraftReferences(parsed, handles),
      { codingItems, internalMovementLines, documentItems, agedTwinAsks, heldMatchConfirms }
    ),
    // The provider-RETURNED model id is the receipt: a silently-downgraded
    // deployment (stale env override) shows up HERE, not in the requested
    // config.model. Persist what actually drafted the ask so client_ask_
    // batches.model can be scored against it. (CLAUDE.md "the model id is
    // part of the receipt".)
    model: payload.model || config.model,
    response_id: payload.id || '',
    // The language the draft was asked to be written in — part of the same
    // receipt, so a batch can be read against what it was instructed.
    language: input.client.language
  };
};
