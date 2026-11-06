// Slice 4b — the settlement LEDGER ENTRY producer
// (docs/donna-settlement-answer-and-ledger-entry-plan.md §3).
//
// THE POPULATION: money-out documents whose persisted no_line_disposition is
// settled (`disposition='auto_explain'`) with `settlement_channel` cash or
// personal_card — whether by the owner's word (Slice 4a, verdict_source
// 'owner_reply') or an immaterial unprompted auto_explain — and which do NOT
// yet carry a settlement journal (`payload.settlement_entry.journal_id`).
// Those docs are "explained" but the books are still MISSING the entry:
// DR the expense account / CR the owner's-funds account (901 Director loan).
//
// PROPOSE → VALIDATE → EXPLAIN → COMMIT, with the migration-034 proposal card
// as the receipt's home: the card observes, the named writer
// (firmDb.postDocumentSettlementJournalWithClient) writes — the grammar is a
// router, never a second accounting backend (INV-1). Money-IN docs (a sales
// invoice settled in cash) are a DIFFERENT journal (the owner drew the cash)
// and are excluded here by type — a future slice designs that case on purpose.
//
// TRUST-THE-STRONG-LLM BOUNDARY (plan §5): the model decides WHICH expense
// account (from the client's own chart — the same menu every coding surface
// proposes from), with the doc header + the disposition receipt + the firm
// anchor. The Keep layer refuses: an account not on the handed chart, a
// below-floor confidence acting (the card rests `proposed` — the visible
// exception, never a silent settle and never a quiet park), an unbalanced
// entry / locked period / duplicate (the writer's deterministic guards), an
// unaudited write. No keyword lists, no per-kind ceilings.
//
// AUTHORITY (plan decision #3, ratified): decide-and-notify. A material entry
// WITHOUT the owner's word cannot exist (4a's immaterial-only veto stands on
// the unprompted path), so every material entry is owner-authorized by
// construction — the authority basis ('owner_reply' + request id, or
// 'immaterial_auto_explain') rides the journal payload, the card, and the
// audit event.
//
// GATING (plan §6 — born on the plane, NO env pair):
//   ∅ / off / dry_run → inert (disabled; byte-identical to no producer)
//   shadow            → proposal cards minted + sized; NO ledger write, NO
//                       payment_status touch (the sizing read before acting)
//   canary / auto     → act: post through the named writer + the recorded-FYI
//                       marker (owner_notified:false) the ask-batch digest
//                       gathers ("Recorded as paid from your own funds —
//                       reply if wrong").
//
// WIRING: called OUTSIDE runShadow (runShadow's contract forbids accounting
// writes) from loopsShadowProducers.runDocumentTerminalDrain and
// onReconciliationRunCompleted, both AFTER their runShadow pass returns.
// NEVER throws; per-doc failures roll back that doc's txn and continue.
// firmDb is imported DYNAMICALLY at run time (cycle safety — the 4a
// firmDb→documentDispositionLlm precedent, in the other direction).
//
// THE LATE-BANK-LINE CASE (plan §3's named follow-up — BUILT 2026-07-21): an
// entry-settled doc stays matcher-eligible. If a bank line later confirms
// against it (the owner was wrong — it DID hit the feed), the guard surfaces
// `needs_ledger_adjustment` and proposes the reversal via
// postLedgerAdjustmentInDb — never silently double-count, never auto-un-post
// (the reverseExecutor disposition precedent). Detection rides
// firmDb.applyDocumentPaymentStatusAfterMatch (the one funnel every settle
// cascade runs); the reversal producer is the sibling module
// documentSettlementReversal.js, keyed on this module's
// payload.settlement_entry.journal_id marker. The FORWARD direction is closed
// in GATHER_SQL below: a doc that already carries a settled bank-line match
// never mints an owner-funds entry in the first place.

import { resolveCodingPolicy, codingPolicyReceipt, assertCodingPolicyReceipt, isCodingPolicyError } from './codingPolicy.js';
import { toIsoDay } from './dates.js';
import { codingGuidanceVariantForSnapshot } from './codingGuidanceVariant.js';
import { extractJson } from './extractJson.js';
import { createHash } from 'node:crypto';
import { normalizeLedgerCurrency } from './ledgerCurrency.js';
import {
  DEFAULT_MODEL,
  getApiKey,
  getModel,
  proposeMatchesViaAnthropic,
  loadFirmContext,
  formatFirmAnchor,
  formatKnownCounterparties
} from './reconciliationLlmCore.js';
import { clientFlagActs, clientFlagObserves, readClientConfigSnapshot } from './clientConfig.js';
import { resolveOpenAiCompatibleEndpoint } from './providerEndpoints.js';
import { summarizeCheckReport, proposalCardIsAppliable } from './operatorContract.js';
import { persistProposalCard, persistApplyReceipt, supersedeProposalCard } from './proposalStore.js';
import {
  DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY,
  DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE,
  documentSettlementProposalId
} from './documentDispositionShape.js';
import {
  getDispositionMaterialityPolicy,
  exceedsMaterialityCeiling
} from './dispositionMateriality.js';

export {
  DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY,
  DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE,
  documentSettlementProposalId
} from './documentDispositionShape.js';

const LOG_TAG = 'documentSettlementEntry';

// Money-in kinds — LOCK-STEP with documentDispositionLlm's MONEY_IN_TYPES
// (pinned by test): their cash settlement is the owner DRAWING the receipt,
// a different journal shape, deliberately out of scope (module header).
export const SETTLEMENT_MONEY_IN_TYPES = Object.freeze(['sales_invoice', 'issued_receipt']);

// The settlement channels that mean "the owner's own funds paid this" —
// the only ones the DR-expense / CR-owner-funds entry is true for.
export const SETTLEMENT_ENTRY_CHANNELS = Object.freeze(['cash', 'personal_card']);

// Bounded LLM calls per sweep (the gather is re-entrant — the next sweep
// picks up where this one capped).
const SETTLEMENT_SWEEP_LIMIT = 20;

// Keep-layer confidence floor for the PROPOSED expense account: below it the
// card rests `proposed` (visible exception), never posts. Tuning knob
// (env-legitimate per the config-plane rail).
export const DEFAULT_SETTLEMENT_ACCOUNT_CONFIDENCE_FLOOR = 0.75;
export const getSettlementAccountConfidenceFloor = () => {
  const raw = Number(process?.env?.DOCUMENT_SETTLEMENT_ACCOUNT_CONFIDENCE_FLOOR);
  return Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : DEFAULT_SETTLEMENT_ACCOUNT_CONFIDENCE_FLOOR;
};

const ZERO_STATS = () => ({
  gathered: 0,
  cards_minted: 0,
  cards_existing: 0,
  posted: 0,
  rested_proposed: 0,
  post_failures: 0,
  posted_document_ids: [],
  // Policy-path transport law (mirrors the disposition sweeps): a transport-
  // class failure under a seated rung skips the doc (no null-account card
  // minted off an HTTP error); a mismatch or a failure run aborts, reason here.
  transport_failures: 0,
  aborted_reason: null,
  mode: 'shadow',
  disabled: false,
  disabled_reason: null
});
const DISABLED_STATS = (reason) => ({ ...ZERO_STATS(), disabled: true, disabled_reason: reason });

// Policy-path transport law: N consecutive transport-class failures under a
// seated rung = a systemic endpoint/config problem — abort the sweep loudly
// (value mirrors bankLineDispositionLlm's).
const TRANSPORT_FAILURE_ABORT_THRESHOLD = 5;

const clampConfidence = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
};

// ── The expense-account proposer ─────────────────────────────────────────

const SETTLEMENT_ACCOUNT_SYSTEM_PROMPT = `You code ONE expense document to a client's chart of accounts for a bookkeeping firm.

The document is a business expense that settled OUTSIDE the client's visible bank feed (paid in cash or with the owner's personal funds). The firm is about to record it as: DEBIT an expense account / CREDIT the owner's-funds account. Choose the expense account and the source-supported tax treatment from the supplied jurisdiction policy. The existing writer separates deductible tax; never choose the account default as a substitute for the document's treatment.

You are handed the client's chart of accounts. Pick EXACTLY ONE account name FROM THAT LIST — copy it verbatim. Never invent, rename, or combine account names. If nothing fits well, pick the closest reasonable account with an honestly low confidence.

Output a single JSON object with this exact shape, nothing else:
{
  "account": "<one account name copied verbatim from the chart>",
  "tax_treatment": "<one supplied tax treatment>",
  "confidence": 0.0,
  "reasoning": "One sentence. Do NOT repeat the raw document text verbatim."
}

Rules:
- confidence is 0..1: how sure a competent bookkeeper with this firm's context would be of this coding.
- Return ONLY valid JSON. No markdown, no commentary.`;

// Pure prompt builder: the parsed doc HEADER (extracted fields only, never
// raw content), the persisted disposition receipt (the strong pass that
// settled the doc), the handed chart, and the firm anchor.
// The coding policy this lane's prompt renders for one document: the client's
// jurisdiction, the document's business date and the guidance variant the
// sweep read from config (FIK-2). Its receipt is stamped on the card and
// re-checked before a persisted card posts. null without a jurisdiction.
export const settlementCodingPolicy = (firmContext, document = {}) => {
  const jurisdiction = firmContext?.clientIdentity?.jurisdiction;
  if (!jurisdiction) return null;
  const day = document?.document_date ? toIsoDay(document.document_date) : null;
  return resolveCodingPolicy({ jurisdiction, businessDate: /^\d{4}-\d{2}-\d{2}$/.test(day || '') ? day : null,
    guidanceVariant: firmContext.codingGuidanceVariant ?? null });
};

// A persisted card was decided under the current policy when its receipt still
// matches. A card minted before receipts existed carries none: it was decided
// under the authored guidance, so it stands only while no reviewed variant is
// selected.
const settlementCardPolicyCurrent = (current, stamped) => {
  if (!current) return true;
  if (!stamped) return current.guidanceVariant === null;
  try { assertCodingPolicyReceipt(current, stamped); return true; }
  catch (error) { if (isCodingPolicyError(error)) return false; throw error; }
};

export const buildSettlementAccountUserPrompt = ({
  document = {},
  disposition = {},
  accountOptions = [],
  firmContext = null,
  codingPolicy = null
} = {}) => {
  const sections = [];
  if (firmContext?.clientIdentity?.jurisdiction) {
    const policy = codingPolicy || resolveCodingPolicy({jurisdiction:firmContext.clientIdentity.jurisdiction,
      guidanceVariant:firmContext.codingGuidanceVariant ?? null});
    sections.push(`Tax treatments: ${JSON.stringify(policy.taxTreatmentOptions)}\n${policy.taxInstructions}`);
  }
  sections.push(`Source tax and lines: ${JSON.stringify({tax_amount:document.tax_amount,
    parse_summary:document.parse_summary,lines:document.lines})}`);
  const amount = Number(document?.total_amount ?? 0);
  sections.push(`Document (settled outside the bank feed):
  type=${document?.document_type || 'unknown'}
  counterparty="${document?.vendor_name || document?.customer_name || ''}"
  amount=${Number.isFinite(amount) ? amount : 0} ${document?.currency || ''}
  date=${document?.document_date || 'unknown'}
  filename="${document?.filename || ''}"`);

  sections.push(`The firm's settlement verdict for this document (already decided — do not re-litigate):
  settlement_channel=${disposition?.settlement_channel || 'unknown'}
  expense_kind=${disposition?.expense_kind || 'unknown'}
  reasoning="${String(disposition?.reasoning || '').slice(0, 280)}"`);

  const options = (Array.isArray(accountOptions) ? accountOptions : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  sections.push(`Client's chart of accounts (pick ONE name verbatim):
${options.map((name) => `  - ${name}`).join('\n')}`);

  const firmAnchor = formatFirmAnchor(
    firmContext?.clientIdentity,
    'This document evidences money the firm PAID with the owner\'s own funds. The counterparty is whoever the firm paid — never the firm itself.'
  );
  if (firmAnchor) sections.push(firmAnchor);

  const knownCounterparties = formatKnownCounterparties(
    firmContext?.knownCounterparties,
    { noun: 'suppliers', verb: 'pays', selfNoun: 'an unrelated party' }
  );
  if (knownCounterparties) sections.push(knownCounterparties);

  return sections.join('\n\n');
};

// Parse + sanitize the model's account pick. HANDED-IDS-ONLY: the returned
// name must be on the handed chart (exact match, then unique case-insensitive
// match canonicalized to the chart's spelling). Anything else → account null
// (the in-chart check fails and the card rests proposed). NEVER throws.
export const parseSettlementAccountResponse = (text, { accountOptions = [] } = {}) => {
  const fallback = { account: null, confidence: 0, reasoning: '' };
  let parsed;
  try {
    parsed = extractJson(text);
  } catch {
    return fallback;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback;

  const options = (Array.isArray(accountOptions) ? accountOptions : [])
    .map((name) => String(name || '').trim())
    .filter(Boolean);
  const requested = String(parsed.account || '').trim();
  let account = null;
  if (requested && options.includes(requested)) {
    account = requested;
  } else if (requested) {
    const lower = requested.toLowerCase();
    const matches = options.filter((name) => name.toLowerCase() === lower);
    if (matches.length === 1) account = matches[0];
  }

  return {
    account,
    ...(typeof parsed.tax_treatment === 'string' ? {tax_treatment:parsed.tax_treatment} : {}),
    confidence: clampConfidence(parsed.confidence),
    reasoning: typeof parsed.reasoning === 'string' ? parsed.reasoning.slice(0, 280) : ''
  };
};

// One strong-model call → an expense-account proposal. NEVER throws; a
// transport/parse failure returns the null-account fallback (the card rests
// proposed with the in-chart check failed — visible, never guessed).
export const proposeSettlementExpenseAccount = async ({
  document,
  disposition = {},
  accountOptions = [],
  firmContext = null,
  codingPolicy = null,
  apiKey,
  model = DEFAULT_MODEL,
  fetchImpl,
  // The #1748 shape (2026-08-19 follow-up): the resolved deciding transport
  // when a policy seats a non-claude rung — the Anthropic key then gates
  // nothing on this call.
  transport = null
} = {}) => {
  if (!apiKey && !transport) return { account: null, confidence: 0, reasoning: '', model };
  const userPrompt = buildSettlementAccountUserPrompt({ document, disposition, accountOptions, firmContext, codingPolicy });
  try {
    const result = await proposeMatchesViaAnthropic({
      systemPrompt: SETTLEMENT_ACCOUNT_SYSTEM_PROMPT,
      userPrompt,
      candidateBankLines: [],
      model,
      apiKey,
      fetchImpl,
      parse: (text) => parseSettlementAccountResponse(text, { accountOptions }),
      logTag: LOG_TAG,
      // llmCall requires a typed execution root; this call rides the
      // reconciliation_reasoning lane (same as the family matchers).
      transport: transport
        ? { ...transport, execution: transport.execution || { root: { type: 'reconciliation_reasoning', id: document?.id } } }
        : null
    });
    if (!result || typeof result !== 'object') return { account: null, confidence: 0, reasoning: '', model };
    return result;
  } catch (error) {
    console.error(`[${LOG_TAG}] account proposal call threw`, {
      document_id: document?.id,
      error: error?.message || String(error)
    });
    // Policy-path transport law: a mismatch or transport-class throw under a
    // seated rung is MARKED so the sweep skips the doc — a null-account card
    // minted off an HTTP error would freeze the proposal on junk (the
    // existing-card short-circuit never re-asks the model). The KEYED path
    // keeps its historical null-account fallback, byte-identical.
    if (error?.code === 'POLICY_MODEL_MISMATCH') {
      return { account: null, confidence: 0, reasoning: '', model, transport_failure: true, model_mismatch: true };
    }
    return transport
      ? { account: null, confidence: 0, reasoning: '', model, transport_failure: true }
      : { account: null, confidence: 0, reasoning: '', model };
  }
};

// ── The proposal card (migration 034 / operatorContract shapes) ──────────

// Enrich the picked chart NAME with the client's ledger_accounts row when one
// exists: the ledger account id is keyed on code||xero_account_id||name, so
// posting name-only against a coded chart row would MINT A DUPLICATE account.
const resolveExpenseAccountRow = async ({ client, firmId, clientId, accountName }) => {
  if (!accountName) return null;
  const result = await client.query(
    `select code, name, account_type, tax_type, canonical_role
       from ledger_accounts
      where firm_id = $1 and client_id = $2 and status = 'active'
        and (lower(name) = lower($3) or lower(payload->>'palette_name') = lower($3))
      order by code nulls last
      limit 1`,
    [firmId, clientId, accountName]
  ).catch(() => ({ rows: [] }));
  const row = result.rows[0];
  if (!row) return null;
  return {
    code: row.code || '',
    name: row.name || accountName,
    type: row.account_type || '',
    tax_type: row.tax_type || '',
    canonical_role: row.canonical_role || null
  };
};

// F1 — the settlement post is a terminalizing auto path, so the deterministic
// immateriality ceiling binds HERE too (defense-in-depth behind the parser-side
// ceiling upstream): an 'immaterial_auto_explain'-authorized entry above the
// ceiling rests proposed — the visible exception, never an auto-post. The
// 'owner_reply' basis is exempt by construction (the owner's answer IS the
// material authorization; plan decision #3).
const ceilingRefusesPost = ({ document, authorityBasis, materialityCeiling }) =>
  authorityBasis !== 'owner_reply'
  && exceedsMaterialityCeiling(Number(document?.total_amount || 0), materialityCeiling);

const buildSettlementChecks = ({ document, proposal, confidenceFloor, authorityBasis, materialityCeiling }) => summarizeCheckReport([
  {
    name: 'document_currency',
    status: normalizeLedgerCurrency(document?.currency) ? 'pass' : 'fail',
    detail: normalizeLedgerCurrency(document?.currency) ? null
      : 'Confirm the document currency in its conversation before posting. No currency has been assumed.'
  },
  {
    name: 'amount_positive',
    status: Number(document?.total_amount || 0) > 0 ? 'pass' : 'fail',
    detail: Number(document?.total_amount || 0) > 0 ? null : 'Document amount is not positive.'
  },
  {
    name: 'expense_account_in_chart',
    status: proposal?.account ? 'pass' : 'fail',
    detail: proposal?.account ? null : 'The proposed expense account is not on the client\'s chart.'
  },
  {
    name: 'materiality_ceiling',
    status: ceilingRefusesPost({ document, authorityBasis, materialityCeiling }) ? 'fail' : 'pass',
    detail: ceilingRefusesPost({ document, authorityBasis, materialityCeiling })
      ? `Amount ${Number(document?.total_amount || 0)} exceeds the ${materialityCeiling} immateriality ceiling without owner authorization — the entry stays proposed.`
      : null
  },
  {
    name: 'confidence_floor',
    status: clampConfidence(proposal?.confidence) >= confidenceFloor ? 'pass' : 'requires_review',
    detail: clampConfidence(proposal?.confidence) >= confidenceFloor
      ? null
      : `Confidence ${clampConfidence(proposal?.confidence)} is below the ${confidenceFloor} floor — the entry stays proposed.`
  }
]);

const buildSettlementProposalCard = ({
  document,
  disposition,
  proposal,
  expenseAccountRow,
  ownerFundsLabel,
  authorityBasis,
  checks,
  model
}) => {
  const amount = Number(document?.total_amount || 0);
  const accountLabel = expenseAccountRow?.code
    ? `${expenseAccountRow.code} · ${expenseAccountRow.name}`
    : (proposal?.account || '');
  return {
    proposal_id: documentSettlementProposalId(document.id),
    type: DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE,
    // A system-produced correction of the books' state (the missing entry),
    // not an operator utterance — state_correction is the intent vocabulary's
    // home for it (OPERATOR_INTENTS, plan §3.1).
    triage_source: 'state_correction',
    plan_id: null,
    targets: [String(document.id)],
    blast_radius: {
      transactions: 0,
      documents: 1,
      decided_rows: 0,
      client_visible: true,
      unattended_future_behavior: false
    },
    writer: 'postDocumentSettlementJournalWithClient',
    reversibility: 'reversible_via_adjustment',
    before_after: [{
      target: String(document.id),
      before: {
        payment_status: document.payment_status ?? null,
        settlement_journal: null
      },
      after: {
        payment_status: 'paid',
        settlement_journal: `DR ${accountLabel || 'expense'} / CR ${ownerFundsLabel} — ${amount} ${document.currency || ''}`.trim()
      }
    }],
    before_after_total: 1,
    checks,
    preconditions: [{
      object: String(document.id),
      expected_payment_status: document.payment_status ?? null,
      expected_updated_at: document.updated_at ? new Date(document.updated_at).toISOString() : null
    }],
    review_mode: 'accountant_approval',
    detail: {
      expense_account: proposal?.account || null,
      expense_account_code: expenseAccountRow?.code || null,
      confidence: clampConfidence(proposal?.confidence),
      reasoning: proposal?.reasoning || '',
      amount,
      currency: document.currency || '',
      settlement_channel: disposition?.settlement_channel || null,
      verdict_source: disposition?.verdict_source || null,
      evidence_request_id: disposition?.evidence_request_id || null,
      authority_basis: authorityBasis,
      owner_funds_account: ownerFundsLabel,
      model: model || null
    },
    warnings: proposal?.account
      ? []
      : ['The model did not return an account from the handed chart — the entry rests proposed.']
  };
};

// ── The producer ─────────────────────────────────────────────────────────

// The gather: money-out docs settled to the owner's own funds, no journal
// yet. Keyed PURELY on the persisted verdict merge (render-the-persisted-
// verdict): shadow-mode dispositions never merged a payload, so they never
// gather here — the entry chain only ever starts from an ACTED settle.
const GATHER_SQL = `
  select d.id, d.document_type, d.vendor_name, d.customer_name, d.filename,
         d.total_amount, d.currency, d.document_date, d.payment_status, d.updated_at,
         d.tax_amount, d.parse_summary,
         (select jsonb_agg(to_jsonb(l) order by l.line_no) from document_lines l where l.firm_id=d.firm_id and l.client_id=d.client_id and l.document_id=d.id) as lines,
         d.payload->'no_line_disposition' as no_line_disposition
    from documents d
   where d.firm_id = $1 and d.client_id = $2
     and d.payload->'no_line_disposition'->>'disposition' = 'auto_explain'
     and d.payload->'no_line_disposition'->>'settlement_channel' = any($3::text[])
     and (d.payload->'no_line_disposition'->>'settlement_channel' = 'personal_card'
       or d.payload->'no_line_disposition'->>'funding_source' = 'owner')
     and coalesce(d.payload->'settlement_entry'->>'journal_id', '') = ''
     and d.document_type <> all($4::text[])
     and d.total_amount is not null and d.total_amount > 0
     and ($5::text[] is null or d.id = any($5::text[]))
     and not exists (
       select 1 from reconciliation_matches m
        where m.firm_id = d.firm_id
          and m.matched_object_id = d.id
          and m.matched_object_type <> 'bank_line'
          and m.status in ('confirmed', 'auto_matched')
     )
   order by d.document_date nulls last, d.id
   limit ${SETTLEMENT_SWEEP_LIMIT}`;

const authorityBasisFor = (disposition = {}) =>
  disposition?.verdict_source === 'owner_reply' ? 'owner_reply' : 'immaterial_auto_explain';

// Post ONE doc's settlement entry through the named writer + persist the
// apply receipt, inside the caller's open transaction.
const postSettlementForDocument = async ({
  client, firmId, clientId, document, disposition, detail, checks, proposalId, model, postJournalFn
}) => {
  const posted = await postJournalFn({
    client,
    firmId,
    clientId,
    document,
    expenseAccount: {
      code: detail.expense_account_code || '',
      name: detail.expense_account,
      tax_treatment:detail.tax_treatment || '',
      xero_tax_type: detail.tax_treatment ? '' : detail.expense_account_tax_type || ''
    },
    settlement: {
      settlement_channel: disposition?.settlement_channel || null,
      verdict_source: disposition?.verdict_source || null,
      evidence_request_id: disposition?.evidence_request_id || null
    },
    authorityBasis: detail.authority_basis,
    actorId: disposition?.actor_id || 'system',
    model
  });
  await persistApplyReceipt({
    client, firmId, clientId,
    receipt: {
      proposal_id: proposalId,
      model: String(model || ''),
      prompt_version: null,
      context_snapshot_id: null,
      candidate_ids_seen: [String(document.id)],
      candidate_ids_rejected: [],
      facts_available: [],
      facts_used: [],
      facts_conflicted: [],
      examples_available: [],
      examples_used: [],
      playbooks_used: [],
      policies_used: [],
      checks,
      final_writer: 'postDocumentSettlementJournalWithClient',
      audit_event_ids: posted?.audit_event_id ? [posted.audit_event_id] : [],
      rows_touched: [posted?.journal_id, String(document.id)].filter(Boolean),
      per_target: [{ target: String(document.id), applied: true, error: null }],
      operator_words: null
    }
  });
  return posted;
};

// Sweep one client's settled-without-entry documents. Flag-gated on the
// plane (∅ inert); `documentIds` scopes to a run's targets (null = full
// backlog sweep). LLM calls run OUTSIDE any transaction; each doc's card
// mint (+ act-mode post + receipt) commits atomically per doc. NEVER throws.
export const runDocumentSettlementEntriesForClient = async ({
  client,
  firmId,
  clientId,
  documentIds = null,
  env = process.env,
  apiKeyOverride,
  modelOverride,
  fetchImpl,
  // Test seams; default to the dynamically-imported firmDb (cycle safety).
  accountOptionsFn = null,
  postJournalFn = null,
  // The #1748 shape (2026-08-19 follow-up): the reconciliation_reasoning
  // lane's active policy row, resolved by the sweep OWNER
  // (loopsShadowProducers). A seated non-claude rung decides the expense-
  // account pick over the compatible endpoint; an active policy with no
  // endpoint fails LOUD, never silently back to the strong model.
  decidingPolicy = null
} = {}) => {
  const stats = ZERO_STATS();
  try {
    if (!client || !firmId || !clientId) return DISABLED_STATS('missing_ids');

    const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
    const flag = {
      flagKey: DOCUMENT_SETTLEMENT_LEDGER_ENTRY_FLAG_KEY,
      snapshot,
      envFallback: () => false, // born on the plane — a DB stage row is the ONLY on
      env
    };
    if (!clientFlagObserves(flag)) return DISABLED_STATS('flag_off');
    stats.mode = clientFlagActs(flag) ? 'act' : 'shadow';

    const policyModel = typeof decidingPolicy?.deciding_model === 'string' && decidingPolicy.deciding_model.trim()
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
    if (!apiKey && !transport) return DISABLED_STATS('no_anthropic_api_key');
    const policyBasis = policyModel ? (decidingPolicy?.basis || 'experiment') : null;

    const scoped = Array.isArray(documentIds)
      ? documentIds.map((id) => String(id)).filter(Boolean)
      : null;
    if (scoped && !scoped.length) return stats;

    const gathered = await client.query(GATHER_SQL, [
      firmId, clientId,
      [...SETTLEMENT_ENTRY_CHANNELS],
      [...SETTLEMENT_MONEY_IN_TYPES],
      scoped
    ]);
    const candidates = gathered.rows || [];
    stats.gathered = candidates.length;
    if (!candidates.length) return stats;

    // The lazily-bound firmDb surface (dynamic import — cycle safety).
    let firmDbModule = null;
    const firmDb = async () => {
      if (!firmDbModule) firmDbModule = await import('./firmDb.js');
      return firmDbModule;
    };
    const optionsFn = accountOptionsFn
      || (async () => (await firmDb()).getClientAccountOptionsFromDb({ firmId, clientId }));
    const postFn = postJournalFn
      || (async (args) => (await firmDb()).postDocumentSettlementJournalWithClient(args));
    const ownerFundsLabelOf = async () => {
      if (postJournalFn) return '901 · Director loan';
      const mod = await firmDb();
      const acct = mod.DOCUMENT_SETTLEMENT_OWNER_FUNDS_ACCOUNT || { code: '901', name: 'Director loan' };
      return `${acct.code} · ${acct.name}`;
    };

    const accountOptions = await optionsFn();
    const ownerFundsLabel = await ownerFundsLabelOf();
    // A claude-family policy rung rides the anthropic transport as a model
    // override (same as the fixed sweeps); a non-claude rung rides `transport`.
    const model = modelOverride ?? policyModel ?? getModel();
    const confidenceFloor = getSettlementAccountConfidenceFloor();

    // Firm context once per sweep (identity anchor + supplier roster) —
    // money-out only, so the role is always 'supplier'.
    const { clientIdentity, knownCounterparties } = await loadFirmContext({
      client,
      firmId,
      clientId,
      document: { payment_status: null },
      settledCount: 0,
      counterpartyRole: 'supplier',
      paymentStatusIsSettlementSignal: false
    });
    // RT-11b — the ceiling follows the client's pack (home currency); env is
    // the only override; no pack ⇒ the unset marker and the post refuses.
    const materialityPolicy = getDispositionMaterialityPolicy({ jurisdiction: clientIdentity?.jurisdiction ?? null });
    const materialityCeiling = materialityPolicy.ceiling;
    // FIK-2: the sweep's prompt renders the same guidance variant coding selects.
    const firmContext = { clientIdentity, knownCounterparties, codingGuidanceVariant: codingGuidanceVariantForSnapshot(snapshot) };

    let consecutiveTransportFailures = 0;
    for (const document of candidates) {
      const disposition = document.no_line_disposition || {};
      let proposalId = documentSettlementProposalId(document.id);
      let supersedesProposalId = null;
      try {
        // Idempotency at the strong-model-CALL level: an existing card is the
        // PERSISTED proposal — shadow has nothing more to do; act consumes the
        // card's own detail instead of re-asking the model.
        const existing = await client.query(
          `select pc.id, pc.status, pc.check_status, pc.detail
             from proposal_cards pc
            where pc.firm_id = $2 and pc.client_id = $3
              and pc.proposal_type = $4
              and (pc.id = $1 or exists (
                select 1 from proposal_targets pt where pt.proposal_id = pc.id
                  and pt.firm_id = $2 and pt.client_id = $3
                  and pt.object_type = 'document' and pt.object_id = $5))
            order by pc.created_at desc, pc.id desc
            limit 1`,
          [proposalId, firmId, clientId, DOCUMENT_SETTLEMENT_ENTRY_PROPOSAL_TYPE, String(document.id)]
        );
        let existingCard = existing.rows[0] || null;
        // A repaired denomination needs a fresh proposal and checks. Supersede
        // the immutable old card through its existing writer, preserving its
        // historical wording/checks instead of mutating a failed card to green.
        if (existingCard?.status === 'proposed' && Object.hasOwn(existingCard.detail || {}, 'currency')
          && normalizeLedgerCurrency(existingCard.detail.currency) !== normalizeLedgerCurrency(document.currency)) {
          supersedesProposalId = existingCard.id;
          const revision = createHash('sha256').update(`${existingCard.id}|${normalizeLedgerCurrency(document.currency) || 'unknown'}`).digest('hex').slice(0, 16);
          proposalId = `${documentSettlementProposalId(document.id)}-${revision}`;
          existingCard = null;
        }
        // The same supersede when the card was decided under another coding
        // policy (FIK-2: a guidance-variant switch, or a receipt that no longer
        // matches). The stale card stays as the historical record; a fresh
        // proposal is made under the current policy, never posted from the old.
        const codingPolicy = settlementCodingPolicy(firmContext, document);
        if (existingCard?.status === 'proposed' && !settlementCardPolicyCurrent(codingPolicy, existingCard.detail?.coding_policy)) {
          supersedesProposalId = existingCard.id;
          const revision = createHash('sha256').update(`${existingCard.id}|policy|${JSON.stringify(codingPolicyReceipt(codingPolicy))}`).digest('hex').slice(0, 16);
          proposalId = `${documentSettlementProposalId(document.id)}-${revision}`;
          existingCard = null;
        }

        if (existingCard) {
          proposalId = existingCard.id;
          stats.cards_existing += 1;
          if (stats.mode !== 'act') continue;
          if (existingCard.status !== 'proposed') continue;
          const detail = existingCard.detail || {};
          // F1 — deterministic ceiling re-checked at post time, so a card
          // minted BEFORE the ceiling existed (no materiality_ceiling check
          // in its persisted check report) can't auto-post above it either.
          const appliable = ['pass', 'warning'].includes(existingCard.check_status)
            && normalizeLedgerCurrency(document.currency)
            && detail.expense_account
            && !ceilingRefusesPost({
              document,
              authorityBasis: detail.authority_basis || authorityBasisFor(disposition),
              materialityCeiling
            });
          if (!appliable) {
            stats.rested_proposed += 1;
            continue;
          }
          await client.query('begin');
          try {
            const posted = await postSettlementForDocument({
              client, firmId, clientId, document, disposition,
              detail, checks: null, proposalId,
              model: detail.model || model, postJournalFn: postFn
            });
            await client.query('commit');
            if (posted?.journal_id) {
              stats.posted += 1;
              stats.posted_document_ids.push(String(document.id));
            }
          } catch (error) {
            await client.query('rollback');
            stats.post_failures += 1;
            console.warn(`[${LOG_TAG}] act-from-card post failed`, {
              document_id: document.id,
              error: error?.message || String(error)
            });
          }
          continue;
        }

        // Fresh doc: ONE strong-model call proposes the expense account
        // (outside any transaction — never hold a txn across a network call).
        const proposal = await proposeSettlementExpenseAccount({
          document,
          disposition,
          accountOptions,
          firmContext,
          codingPolicy,
          apiKey,
          model,
          transport,
          fetchImpl
        });
        // Policy-path transport law (mirrors the disposition sweeps): a
        // mismatch aborts the WHOLE sweep (a reply from a model the policy
        // did not name persists as nothing); a transport-class failure skips
        // the doc — no null-account card minted off an HTTP error, the next
        // sweep re-picks it. The KEYED path never sets these markers.
        if (proposal.model_mismatch) {
          stats.aborted_reason = 'policy_model_mismatch';
          console.error(`[${LOG_TAG}] sweep ABORTED on model mismatch — policy names "${transport?.model}"; nothing minted`, {
            client_id: clientId,
            document_id: document.id
          });
          break;
        }
        if (proposal.transport_failure) {
          stats.transport_failures += 1;
          consecutiveTransportFailures += 1;
          console.warn(`[${LOG_TAG}] transport-class failure — doc skipped (no card)`, {
            document_id: document.id
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
        const expenseAccountRow = proposal.account
          ? await resolveExpenseAccountRow({ client, firmId, clientId, accountName: proposal.account })
          : null;
        const authorityBasis = authorityBasisFor(disposition);
        const checks = buildSettlementChecks({ document, proposal, confidenceFloor, authorityBasis, materialityCeiling });
        const card = buildSettlementProposalCard({
          document,
          disposition,
          proposal,
          expenseAccountRow,
          ownerFundsLabel,
          authorityBasis,
          checks,
          model: proposal.model || model
        });
        card.proposal_id = proposalId;
        if (proposal.tax_treatment) card.detail.tax_treatment = proposal.tax_treatment;
        // The policy the prompt was built under, re-checked before this card
        // can post from its persisted detail.
        if (codingPolicy) card.detail.coding_policy = codingPolicyReceipt(codingPolicy);
        // The #1748-shape policy receipt — present ONLY under a seated rung,
        // so no-policy cards stay byte-identical.
        if (policyBasis) {
          card.detail.policy_basis = policyBasis;
          card.detail.policy_model = policyModel;
          card.detail.model_source = proposal.model_source || null;
        }
        if (expenseAccountRow?.tax_type) {
          card.detail.expense_account_tax_type = expenseAccountRow.tax_type;
        }
        // F1 receipt half — the resolved ceiling this card was checked under,
        // and (RT-11b) where it came from.
        card.detail.materiality_ceiling = Number.isFinite(materialityCeiling) ? materialityCeiling : null;
        card.detail.materiality_ceiling_source = materialityPolicy.source;

        const shouldPost = stats.mode === 'act'
          && checks.status === 'pass'
          && proposalCardIsAppliable(card);

        // The card commits in its OWN transaction, BEFORE any post: it is
        // the durable receipt of the proposal, so a failed post (e.g. a
        // locked period's 409) leaves a visible `proposed` card and the next
        // sweep retries the post off the persisted card without re-asking
        // the model.
        await client.query('begin');
        try {
          const persistence = { client, firmId, clientId, objectType: 'document', modelName: proposal.model || model };
          const minted = supersedesProposalId
            ? await supersedeProposalCard({ ...persistence, oldProposalId: supersedesProposalId, newCard: card })
            : await persistProposalCard({ ...persistence, card });
          if (minted?.created) stats.cards_minted += 1;
          await client.query('commit');
        } catch (error) {
          await client.query('rollback');
          stats.post_failures += 1;
          console.warn(`[${LOG_TAG}] card mint failed`, {
            document_id: document.id,
            error: error?.message || String(error)
          });
          continue;
        }

        if (shouldPost) {
          await client.query('begin');
          try {
            const posted = await postSettlementForDocument({
              client, firmId, clientId, document, disposition,
              detail: card.detail, checks, proposalId,
              model: proposal.model || model, postJournalFn: postFn
            });
            await client.query('commit');
            if (posted?.journal_id) {
              stats.posted += 1;
              stats.posted_document_ids.push(String(document.id));
            }
          } catch (error) {
            await client.query('rollback');
            stats.post_failures += 1;
            console.warn(`[${LOG_TAG}] settlement post failed (card rests proposed)`, {
              document_id: document.id,
              error: error?.message || String(error)
            });
          }
        } else if (stats.mode === 'act') {
          stats.rested_proposed += 1;
        }
      } catch (error) {
        stats.post_failures += 1;
        console.warn(`[${LOG_TAG}] settlement entry failed; doc left as-is`, {
          document_id: document.id,
          error: error?.message || String(error)
        });
      }
    }

    return stats;
  } catch (error) {
    console.warn(`[${LOG_TAG}] sweep failed (no-throw contract)`, {
      firm_id: firmId,
      client_id: clientId,
      error: error?.message || String(error)
    });
    return { ...stats, disabled: true, disabled_reason: 'producer_error' };
  }
};

// Test-only exports.
export const __SETTLEMENT_ACCOUNT_SYSTEM_PROMPT = SETTLEMENT_ACCOUNT_SYSTEM_PROMPT;
export const __GATHER_SQL = GATHER_SQL;
export const __buildSettlementProposalCard = buildSettlementProposalCard;
export const __buildSettlementChecks = buildSettlementChecks;
