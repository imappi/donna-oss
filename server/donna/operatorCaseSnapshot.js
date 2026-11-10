// getOperatorCaseSnapshot — the BookCaseSnapshot read model
// (donna-operator-runtime-contract.md §1; PRD FR-1..4, FR-19).
//
// ONE server-side assembler of a focused "book checkout" from PERSISTED
// state only. Every reasoning turn and every artifact surface checks out
// the book the SAME way — per-prompt partial context assembly is the
// documented whack-a-mole source (the thinner-call receipts), so it is
// forbidden. The artifact drawer's per-transaction explanation block was
// the proto-CaseSnapshot; this promotes it to the contract shape and adds
// the document pipeline_state focus.
//
// Contract rules honoured here:
//   - Assembled from persisted state only; a stale FE payload never feeds
//     this (the #200/#201 lesson, generalized).
//   - `include` is a BUDGET control, not a correctness control: an omitted
//     (or not-yet-built) block is marked ABSENT with a reason, never
//     dropped silently — a thin context is visible, not invisible.
//   - One implementation, N consumers (artifact drawer, chat turns,
//     support tooling). Drift between them is a bug by definition, so the
//     consumers call THIS, they do not re-assemble.
//
// Slice A scope: `transaction` and `document` focus. The blocks the
// contract reserves for later phases (book_context §1, blockers §7,
// allowed_actions §2/registry, context_at_decision §10) are returned
// ABSENT with a reason so the shape is stable and the gap is legible.

import crypto from 'node:crypto';
import {
  queryFirmDb as defaultQueryFirmDb,
  recordDocumentSignedUrlCreatedInDb as defaultRecordSignedUrlAudit,
  DEFAULT_FIRM_ID
} from './firmDb.js';
import { generateMatchExplanation as defaultGenerateMatchExplanation } from './matchExplanation.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';
// The two-terminal-states projection (the FIRST principle's home). Pure /
// dependency-free, so importing it keeps this assembler unit-testable with
// injected deps. Slice C reads the row's terminal state THROUGH this module —
// it never re-implements the policy (CLAUDE.md: "call it, never duplicate").
import {
  convergenceForReviewItem,
  convergenceForTransaction,
  isConvergenceTerminal
} from './reconcileConvergenceState.js';
// The pure per-line timeline merge (Slice 1 of the line-audit-timeline
// design). The QUERIES live here — this file is the one place that reads —
// the merge policy lives there, unit-testable without a DB.
import { buildCaseTimeline } from './caseTimeline.js';
import { askAudienceOf } from './askAudience.js';
import { latestAssignmentFromComments } from './mentions/commentEvents.js';
// The seven-question projection (Slice 1 of the case-health contract). Pure:
// it re-reads the SAME rows the timeline block loads (and reuses the built
// timeline verbatim — never a second merge), so mounting it here adds no
// query and cannot drift from the timeline's receipts.
import { buildCaseHealth } from './caseHealth.js';

export const SNAPSHOT_FOCUS_TYPES = Object.freeze([
  'transaction', 'document', 'match', 'case', 'client', 'period'
]);

// The full include vocabulary (contract §1). Slice A assembles the
// starred ones; the rest resolve to an absent block until their phase.
export const SNAPSHOT_INCLUDE_BLOCKS = Object.freeze([
  'transactions', 'documents', 'matches', 'cases', 'audit', 'facts',
  'playbooks', 'policies', 'chart', 'contacts', 'prior_corrections',
  'posting_state', 'locked_periods', 'asks', 'pipeline_state',
  // Slice C — the L1 compression layer. Both are PURE derivations over the
  // focus rows this assembler already fetched (no extra query), gated on
  // `include` so default callers are byte-identical in DATA (the blocks
  // resolve to absent('not_included') until a caller opts in). Kept OUT of
  // DEFAULT_INCLUDE on purpose: no live behaviour change without greenlight.
  'convergence', 'risk_flags',
  // The per-line audit timeline (design-donna-line-audit-timeline.md,
  // Slice 1): every persisted receipt touching the focused line — triage
  // evaluations, matches with their authority/cascade receipts, the coding
  // proposal, the ask lifecycle, audit events — merged into ONE time-ordered
  // event stream (caseTimeline.js, pure), with the two-terminal verdict
  // pinned on the block. Same greenlight rule as Slice C: NOT in
  // DEFAULT_INCLUDE, so default callers are byte-identical until the drawer
  // opts in.
  'timeline',
  // The seven-question case-health projection (caseHealth.js, pure; the
  // 2026-08-17 contract): blocker · missing evidence · integration failures
  // · actions · reasons · owner question · typed recovery, plus the writer
  // gaps. Shares the timeline block's row load — zero queries of its own.
  // Same greenlight rule: NOT in DEFAULT_INCLUDE.
  'case_health'
]);

const DEFAULT_INCLUDE = Object.freeze([
  'transactions', 'documents', 'matches', 'audit', 'pipeline_state'
]);

class SnapshotInputError extends Error {
  constructor(message) {
    super(message);
    this.statusCode = 400;
  }
}

// A block that exists in the shape but carries no data — present:false +
// a reason, so a missing block degrades context VISIBLY (contract §1).
const absent = (reason) => ({ present: false, reason });

// A signed evidence URL is a bearer-by-possession capability to a source
// PDF: anyone holding the string can fetch the object, with no session.
// It therefore gets the SAME TTL the /documents/:id/download route uses
// (api.js) rather than a week-long one — the shorter the window, the less
// a leaked explanation payload is worth. Keep the two in step.
const SIGNED_URL_TTL_SECONDS = 300;

// Content hash over the deterministic body (NOT the wall-clock fields) —
// the replay anchor (§10). Identical persisted state ⇒ identical id.
const computeSnapshotId = (body) =>
  'snap_' + crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 16);

// Shape a document's parse pipeline_state for the snapshot. Exported
// because the feed chat reuses it to build its per-row pipeline_states
// array (the snapshot's THIRD consumer, #396): ONE shaper, so the block
// is byte-identical across the artifact drawer, the per-transaction chat,
// and the feed chat — drift between consumers is the documented
// whack-a-mole the contract forbids.
export const pipelineStateFromDoc = (doc) => {
  if (!doc) return absent('no_document_in_focus');
  return {
    present: true,
    document_id: doc.id || null,
    parse_status: doc.parse_status ?? null,
    parse_stage: doc.parse_stage ?? null,
    parse_progress_current: doc.parse_progress_current ?? null,
    parse_progress_total: doc.parse_progress_total ?? null,
    parse_summary: doc.parse_summary ?? null,
    parse_error: doc.parse_error ?? null,
    parse_run_id: doc.parse_run_id ?? null
  };
};

// The persisted strong-model verdict, read FROM THE DATA — the model-id
// rail (CLAUDE.md "the model id is part of the receipt"): never infer the
// model from a code default. review payload wins over the transaction's.
const latestModelDecisionFrom = ({ reviewItem, transaction }) => {
  const suggestion =
    (reviewItem?.payload?.ai_suggestion && typeof reviewItem.payload.ai_suggestion === 'object'
      ? { source: 'review_payload', value: reviewItem.payload.ai_suggestion }
      : null) ||
    (transaction?.payload?.ai_suggestion && typeof transaction.payload.ai_suggestion === 'object'
      ? { source: 'transaction_payload', value: transaction.payload.ai_suggestion }
      : null);
  if (!suggestion) return absent('no_persisted_model_decision');
  const s = suggestion.value;
  return {
    present: true,
    source: suggestion.source,
    model: s.model ?? null,
    prompt_version: s.prompt_version ?? null,
    proposed_account: s.proposed_account ?? null,
    evidence_required: typeof s.evidence_required === 'boolean' ? s.evidence_required : null,
    // The coding model's persisted tax verdict (transactionLlm TAX_TREATMENT_OPTIONS): a concrete
    // treatment is a settled call, the 'GST check' sentinel means a tax decision is still owed.
    tax_treatment: typeof s.tax_treatment === 'string' ? s.tax_treatment : null,
    reasoning: s.reasoning ? String(s.reasoning).slice(0, 500) : null
  };
};

// ─── Slice C: the L1 compression layer (convergence + risk flags) ───────────
//
// Two PURE derivations over the already-fetched focus rows. They are the
// "compressed read" the runtime doctrine asks for (CLAUDE.md L1): a decision
// starts from accounting-relevant signal — the row's terminal state and its
// risk flags — not scattered rows. They DECIDE nothing: convergence reads the
// FIRST-principle projection, risk flags FLAG for the Slice-D preflight (the
// Keep layer refuses; it never substitutes the model's judgment). Every flag
// that needs context this snapshot didn't load resolves to `unknown` with a
// reason — a thin context is VISIBLE, never silently absent (contract §1).

export const RISK_FLAG_KINDS = Object.freeze([
  'suspense_exposure',       // coded to Suspense/unknown — the matched-but-uncoded leak surface
  'evidence_required',       // the persisted model verdict said this line needs evidence
  'materiality_band',        // is the amount material? (needs the client threshold — Slice D/G)
  'first_use_account',       // first time this account is proposed for the client (needs history)
  'duplicate_risk',          // a duplicate-candidate signal exists (needs the dup index)
  'tax_treatment_required'   // a tax-treatment decision is owed (needs the persisted tax verdict)
]);

export const RISK_FLAG_STATES = Object.freeze(['flagged', 'clear', 'unknown']);

const riskFlag = (status, reason, extra = {}) => ({ status, reason, ...extra });

// A real posted account — not absent, not Suspense/unknown. Mirrors the
// isCoded notion in reconcileConvergenceState (kept local; that helper is
// private there) so the suspense-exposure flag and the convergence
// matched-but-uncoded leak agree on what "coded" means.
const isRealAccount = (account) => {
  const a = account == null ? '' : String(account).trim().toLowerCase();
  return a !== '' && a !== 'suspense' && a !== 'unknown';
};

const txAmountMagnitude = (tx) => {
  if (!tx) return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : Number(v));
  const inAmt = n(tx.money_in);
  const outAmt = n(tx.money_out);
  const flat = n(tx.amount);
  const candidates = [inAmt, outAmt, flat].filter((v) => Number.isFinite(v) && v !== 0);
  if (!candidates.length) return Number.isFinite(flat) ? Math.abs(flat) : null;
  return Math.abs(candidates[0]);
};

// context (optional, injected by a caller that has the extra signal — Slice
// D/G will supply it): { materialityThreshold, knownAccountKeys, duplicateRisk,
// duplicateCandidateIds, taxTreatmentRequired }. Absent context ⇒ unknown flag.
export const deriveCaseRiskFlags = ({
  transaction = null,
  reviewItem = null,
  latestModelDecision = null,
  context = {}
} = {}) => {
  if (!transaction && !reviewItem) return absent('no_focus_row');
  const payload = reviewItem?.payload || {};
  const codedAccount =
    transaction?.account_name || transaction?.account_code ||
    payload.account_name || payload.account_code || null;
  const proposedAccount =
    (latestModelDecision?.present ? latestModelDecision.proposed_account : null) ||
    payload.ai_suggestion?.proposed_account || null;

  // 1. suspense_exposure — always derivable from the focus row.
  const suspense_exposure = isRealAccount(codedAccount)
    ? riskFlag('clear', `coded:${codedAccount}`)
    : riskFlag('flagged', codedAccount ? `coded:${codedAccount}` : 'no_coded_account', { coded_account: codedAccount });

  // 2. evidence_required — render the PERSISTED model verdict (the rail), not a re-inference.
  const ev = latestModelDecision?.present ? latestModelDecision.evidence_required : null;
  const evidence_required = typeof ev === 'boolean'
    ? riskFlag(ev ? 'flagged' : 'clear', 'persisted_model_verdict')
    : riskFlag('unknown', 'no_persisted_model_decision');

  // 3. materiality_band — surface the amount always; the band needs the client
  //    threshold (Slice D/G). Honest: unknown band, visible magnitude.
  const magnitude = txAmountMagnitude(transaction);
  const threshold = typeof context.materialityThreshold === 'number' ? context.materialityThreshold : null;
  const materiality_band = magnitude == null
    ? riskFlag('unknown', 'no_amount_on_focus_row')
    : threshold == null
      ? riskFlag('unknown', 'no_materiality_threshold_in_context', { amount: magnitude, currency: transaction?.account_currency || transaction?.currency || null, band: 'unknown' })
      : riskFlag(magnitude >= threshold ? 'flagged' : 'clear', 'threshold_applied', { amount: magnitude, currency: transaction?.account_currency || transaction?.currency || null, band: magnitude >= threshold ? 'material' : 'immaterial' });

  // 4. first_use_account — needs the client's account history (Slice C+ / G).
  const knownAccounts = Array.isArray(context.knownAccountKeys) ? context.knownAccountKeys : null;
  const first_use_account = !proposedAccount
    ? riskFlag('unknown', 'no_proposed_account')
    : knownAccounts == null
      ? riskFlag('unknown', 'no_account_history_in_context', { account: proposedAccount })
      : riskFlag(knownAccounts.includes(proposedAccount) ? 'clear' : 'flagged', 'history_applied', { account: proposedAccount });

  // 5. duplicate_risk — needs the duplicate index (Slice D).
  const dupIds = Array.isArray(context.duplicateCandidateIds) ? context.duplicateCandidateIds : null;
  const duplicate_risk = typeof context.duplicateRisk === 'boolean'
    ? riskFlag(context.duplicateRisk ? 'flagged' : 'clear', 'context_signal', dupIds ? { candidate_ids: dupIds } : {})
    : dupIds != null
      ? riskFlag(dupIds.length ? 'flagged' : 'clear', 'context_signal', { candidate_ids: dupIds })
      : riskFlag('unknown', 'no_duplicate_index_in_context');

  // 6. tax_treatment_required — RENDER the persisted model verdict (the rail), not a re-inference.
  //    The coding model writes `tax_treatment` (transactionLlm.js TAX_TREATMENT_OPTIONS, persisted
  //    in `ai_suggestion`): a concrete treatment ('GST 9%' / 'No GST' / 'Out of scope') is a SETTLED
  //    call ⇒ clear; the 'GST check' sentinel is the model explicitly saying a tax decision is OWED
  //    before coding ⇒ flagged. (The earlier "blocked — no persisted tax verdict" was wrong against
  //    the tree: the verdict exists as the enum, the snapshot was just reading a phantom boolean the
  //    model never writes — the legacy-layer trap CLAUDE.md warns about.) An injected
  //    context.taxTreatmentRequired boolean still overrides (e.g. a jurisdiction rule).
  const taxCtx = typeof context.taxTreatmentRequired === 'boolean' ? context.taxTreatmentRequired : null;
  const taxTreatment = latestModelDecision?.present && typeof latestModelDecision.tax_treatment === 'string'
    ? latestModelDecision.tax_treatment.trim() : null;
  // 'GST check' = a tax decision is owed; the concrete treatments = settled. Mirror of
  // TAX_TREATMENT_OPTIONS, inlined so this pure leaf imports no LLM module.
  const taxFromVerdict = taxTreatment === 'GST check'
    ? true
    : (taxTreatment === 'GST 9%' || taxTreatment === 'No GST' || taxTreatment === 'Out of scope')
      ? false
      : null;
  const taxSignal = taxCtx ?? taxFromVerdict;
  const tax_treatment_required = typeof taxSignal === 'boolean'
    ? riskFlag(
        taxSignal ? 'flagged' : 'clear',
        taxCtx != null ? 'context_signal' : 'persisted_model_verdict',
        taxTreatment ? { tax_treatment: taxTreatment } : {}
      )
    : riskFlag('unknown', 'no_persisted_tax_verdict');

  const flags = {
    suspense_exposure, evidence_required, materiality_band,
    first_use_account, duplicate_risk, tax_treatment_required
  };
  return {
    present: true,
    flags,
    // The compressed roll-up the L1 read leads with: which flags fired, and
    // how many couldn't be evaluated for lack of loaded context (visible gap).
    flagged: RISK_FLAG_KINDS.filter((k) => flags[k].status === 'flagged'),
    unknown: RISK_FLAG_KINDS.filter((k) => flags[k].status === 'unknown')
  };
};

// The row's two-terminal-states verdict, projected THROUGH reconcileConvergenceState
// (never re-derived). `hasOpenOwnerAsk` comes from the client_evidence_requests
// table, which this v1 assembler does NOT read — so owner-ask is detected only via
// the review_state (asked_client/waiting) path, and the block carries an honest
// caveat when the CER table wasn't consulted (a future slice can enrich it).
export const deriveCaseConvergence = ({
  reviewItem = null,
  transaction = null,
  hasOpenOwnerAsk = null,
  // 122 — the seat/agent audience signals; absent means not loaded, which
  // fails toward hanging exactly like the projection's own defaults.
  hasOpenSeatAsk = false,
  hasAnsweredSeatAsk = false,
  hasOpenAgentAsk = false
} = {}) => {
  if (!reviewItem && !transaction) return absent('no_focus_row');
  // RT-17 PR 8 — the focus row is read `select *`, so it carries the persisted
  // verdict (RT-13, migration 137) the writers derived with EVERY axis — the
  // asks this assembler never read included. Render it; the v1 caveat is
  // moot for a row that carries the column.
  if (typeof transaction?.convergence_state === 'string') {
    const persistedProjection = { state: transaction.convergence_state, reason: transaction.convergence_reason ?? null };
    return {
      present: true,
      state: persistedProjection.state,
      reason: persistedProjection.reason,
      terminal: isConvergenceTerminal(persistedProjection),
      owner_ask_signal: 'persisted_column',
      caveat: null
    };
  }
  const ownerAskKnown = typeof hasOpenOwnerAsk === 'boolean';
  const opts = {
    hasOpenOwnerAsk: ownerAskKnown ? hasOpenOwnerAsk : false,
    hasOpenSeatAsk: hasOpenSeatAsk === true,
    hasAnsweredSeatAsk: hasAnsweredSeatAsk === true,
    hasOpenAgentAsk: hasOpenAgentAsk === true
  };
  const projection = reviewItem
    ? convergenceForReviewItem(reviewItem, transaction || {}, opts)
    : convergenceForTransaction(transaction || {}, opts);
  return {
    present: true,
    state: projection.state,
    reason: projection.reason,
    terminal: isConvergenceTerminal(projection),
    owner_ask_signal: ownerAskKnown ? 'loaded' : 'review_state_only',
    caveat: ownerAskKnown ? null : 'open_owner_ask_table_not_read_v1'
  };
};

const shapeAuditEvent = (row) => ({
  actor_type: row.actor_type || null,
  action: row.action || null,
  resource_type: row.resource_type || null,
  // The model id, when the event recorded one — keeps the timeline
  // answerable to "which model decided this" without a second lookup.
  model: row.metadata?.model || row.metadata?.ai_suggestion?.model || null,
  created_at: row.created_at || null
});

// ─── Focus resolvers ─────────────────────────────────────────────────────

// transaction focus: the promoted artifact-drawer block — tx + review +
// best match + matched document — plus the rendered explanation.
const resolveTransactionFocus = async ({
  d, firmId, clientId, focusId, wantMatches, createSignedUrl, actorId
}) => {
  // Every focus read is scoped by client_id, not just firm_id. The routes
  // authorize the caller against the NAMED `client_id` only, so a firm-only
  // predicate here let an authorized caller resolve any row in the firm by
  // supplying someone else's focus id. Under the shared-firm topology (one
  // firm, every customer a client) that boundary is the CUSTOMER boundary.
  // An id belonging to another client now resolves to `null` — the same
  // present:false shape as a nonexistent id, so this leaks no existence
  // oracle either.
  const txRow = await d.queryFirmDb(
    'select * from transactions where firm_id = $1 and client_id = $2 and id = $3',
    [firmId, clientId, focusId]
  );
  const transaction = txRow.rows[0] || null;

  const reviewRow = await d.queryFirmDb(
    `select * from transaction_review_queue
      where firm_id = $1 and client_id = $2
        and item_id = $3 and item_type = 'transaction'
      order by created_at desc limit 1`,
    [firmId, clientId, focusId]
  );
  const reviewItem = reviewRow.rows[0] || null;

  let match = null;
  let document = null;
  if (wantMatches) {
    const matchRow = await d.queryFirmDb(
      `select * from reconciliation_matches
        where firm_id = $1 and client_id = $2 and bank_transaction_id = $3
          and status in ('suggested', 'confirmed', 'auto_matched')
        order by match_confidence desc limit 1`,
      [firmId, clientId, focusId]
    );
    match = matchRow.rows[0] || null;
    if (match?.matched_object_id) {
      const docRow = await d.queryFirmDb(
        'select * from documents where firm_id = $1 and client_id = $2 and id = $3',
        [firmId, clientId, match.matched_object_id]
      );
      document = docRow.rows[0] || null;
    }
  }

  // The proactive ask-client question is sent to the owner, so it is worded
  // in the owner's language (one profile read, the one resolver).
  const clientRow = await d.queryFirmDb(
    'select jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1',
    [firmId, clientId]
  );
  const ownerRow = clientRow.rows?.[0] || null;
  const explanation = d.generateMatchExplanation({
    transaction, match, document, reviewItem, language: preferredOwnerTemplateLanguage(ownerRow?.profile, ownerRow)
  });
  // Same optional signed-URL augmentation the artifact-drawer block did,
  // so this stays a drop-in for that consumer. Best-effort.
  if (explanation && !explanation.documentUrl && document?.storage_bucket && document?.storage_object_key && createSignedUrl) {
    try {
      explanation.documentUrl = await createSignedUrl({
        bucket: document.storage_bucket,
        key: document.storage_object_key,
        expiresIn: SIGNED_URL_TTL_SECONDS
      });
      // Minting a download capability is an auditable event wherever it
      // happens. The /documents/:id/download route already records one;
      // this path minted the same kind of URL and recorded nothing, so
      // "who obtained a link to this PDF" had no answer here. Best-effort
      // on purpose, matching that route's own `.catch(() => null)`: an
      // audit-write blip must not fail an otherwise-authorized read.
      if (d.recordSignedUrlAudit) {
        await Promise.resolve(
          d.recordSignedUrlAudit({ firmId, document, actorId: actorId || 'system' })
        ).catch(() => null);
      }
    } catch { /* signed URL is optional */ }
  }

  return {
    focusState: {
      present: transaction != null || reviewItem != null,
      type: 'transaction',
      id: focusId,
      transaction,
      review_item: reviewItem,
      explanation
    },
    match,
    document
  };
};

// document focus: the doc itself + its pipeline_state (the parse-stall
// READING·1-OF-1 diagnostic, now first-class on the snapshot).
const resolveDocumentFocus = async ({ d, firmId, clientId, focusId }) => {
  // client-scoped for the same reason as the transaction focus above:
  // `focus_id` is caller-supplied and was never checked against the scope
  // the route actually authorized.
  const docRow = await d.queryFirmDb(
    'select * from documents where firm_id = $1 and client_id = $2 and id = $3',
    [firmId, clientId, focusId]
  );
  const document = docRow.rows[0] || null;
  return {
    focusState: {
      present: document != null,
      type: 'document',
      id: focusId,
      document
    },
    match: null,
    document
  };
};

// ─── Public assembler ──────────────────────────────────────────────────

export const getOperatorCaseSnapshot = async ({
  firmId,
  clientId,
  focus = {},
  include = null,
  // The authenticated principal, for the signed-URL audit. Absent ⇒
  // 'system', which is honest rather than wrong — but the routes thread
  // the real caller so a minted download capability is attributable.
  actorId = null,
  // Optional extra signal for the Slice-C risk flags (materialityThreshold,
  // knownAccountKeys, duplicateCandidateIds, …). Pure injection; absent ⇒ the
  // dependent flags resolve to `unknown` with a reason. Slice D/G supplies it.
  riskContext = {},
  deps = {}
} = {}) => {
  const d = {
    queryFirmDb: defaultQueryFirmDb,
    generateMatchExplanation: defaultGenerateMatchExplanation,
    createSignedUrl: null,
    recordSignedUrlAudit: defaultRecordSignedUrlAudit,
    now: () => new Date(),
    ...deps
  };
  const resolvedFirmId = firmId || DEFAULT_FIRM_ID;
  if (!clientId) throw new SnapshotInputError('client_id is required.');

  const focusType = focus.type || 'transaction';
  const focusId = focus.id || null;
  if (!SNAPSHOT_FOCUS_TYPES.includes(focusType)) {
    throw new SnapshotInputError(`Unknown focus type '${focusType}'.`);
  }
  if (!focusId) throw new SnapshotInputError('focus.id is required.');

  const includeSet = new Set(
    Array.isArray(include) && include.length ? include : DEFAULT_INCLUDE
  );
  const wants = (block) => includeSet.has(block);

  let resolved;
  if (focusType === 'transaction') {
    resolved = await resolveTransactionFocus({
      d,
      firmId: resolvedFirmId,
      clientId,
      focusId,
      wantMatches: wants('matches') || wants('documents'),
      createSignedUrl: d.createSignedUrl,
      actorId
    });
  } else if (focusType === 'document') {
    resolved = await resolveDocumentFocus({ d, firmId: resolvedFirmId, clientId, focusId });
  } else {
    // Valid focus type, resolver not built yet — visible gap, stable shape.
    resolved = { focusState: { ...absent('focus_type_not_yet_supported'), type: focusType, id: focusId }, match: null, document: null };
  }

  // pipeline_state — from the focused document, or the matched document
  // of a focused transaction.
  const pipelineState = wants('pipeline_state')
    ? pipelineStateFromDoc(resolved.document)
    : absent('not_included');

  // latest_model_decision — the persisted verdict (model id read from data).
  const latestModelDecision = latestModelDecisionFrom({
    reviewItem: resolved.focusState?.review_item || null,
    transaction: resolved.focusState?.transaction || null
  });

  // convergence — the row's two-terminal-states verdict (Slice C). Pure
  // projection over the focus rows; no extra query. Absent unless included.
  if (resolved.focusState?.transaction) {
    const { attachCurrentNativeReviewProjection } = await import('./db/snapshot.js');
    await attachCurrentNativeReviewProjection({firmId:resolvedFirmId,rows:[resolved.focusState.transaction],
      client:{query:(...args)=>d.queryFirmDb(...args)}});
  }
  const convergence = wants('convergence')
    ? deriveCaseConvergence({
        reviewItem: resolved.focusState?.review_item || null,
        transaction: resolved.focusState?.transaction || null,
        hasOpenOwnerAsk: null   // CER table not read in v1 — caveat carried on the block
      })
    : absent('not_included');

  // risk_flags — the L1 risk read (Slice C). Pure derivation; flags needing
  // context not loaded here resolve to `unknown` (a visible gap), not absent.
  const riskFlags = wants('risk_flags')
    ? deriveCaseRiskFlags({
        transaction: resolved.focusState?.transaction || null,
        reviewItem: resolved.focusState?.review_item || null,
        latestModelDecision,
        context: riskContext || {}
      })
    : absent('not_included');

  // related — the focus's graph neighborhood (matches/documents for now).
  const related = (wants('matches') || wants('documents'))
    ? { present: true, match: resolved.match, document: resolved.document }
    : absent('not_included');

  // audit_timeline — ordered events touching the focus (and its review row).
  let auditTimeline;
  if (wants('audit')) {
    const ids = [focusId, resolved.focusState?.review_item?.id].filter(Boolean);
    try {
      const events = await d.queryFirmDb(
        `select actor_type, action, resource_type, metadata, created_at
           from audit_events
          where firm_id = $1 and client_id = $2 and resource_id = any($3)
          order by created_at desc limit 50`,
        [resolvedFirmId, clientId, ids]
      );
      auditTimeline = { present: true, events: events.rows.map(shapeAuditEvent) };
    } catch (err) {
      auditTimeline = absent(`audit_query_failed:${err?.message || 'error'}`);
    }
  } else {
    auditTimeline = absent('not_included');
  }

  // timeline — the per-line audit timeline (Slice 1 of
  // design-donna-line-audit-timeline.md): all persisted receipts for the
  // focused bank line, merged time-ordered by the pure builder, with the
  // two-terminal verdict pinned on the block. Transaction focus only in v1;
  // any other focus is a visible gap, not an error. Assembled from PERSISTED
  // state only — no model call renders or narrates anything here (§5.1).
  //
  // case_health rides the SAME load: both blocks project over the same
  // receipt rows (§5.2 — one assembler, one read), and health reuses the
  // built timeline verbatim, so wanting either block fetches once and
  // wanting both cannot diverge.
  let timeline;
  let caseHealth;
  const wantsCaseRows = wants('timeline') || wants('case_health');
  if (!wantsCaseRows) {
    timeline = absent('not_included');
    caseHealth = absent('not_included');
  } else if (focusType !== 'transaction') {
    timeline = wants('timeline') ? absent('timeline_focus_not_yet_supported') : absent('not_included');
    caseHealth = wants('case_health') ? absent('case_health_focus_not_yet_supported') : absent('not_included');
  } else {
    try {
      const txMatches = await d.queryFirmDb(
        `select * from reconciliation_matches
          where firm_id = $1 and client_id = $2 and bank_transaction_id = $3
          order by created_at asc`,
        [resolvedFirmId, clientId, focusId]
      );
      const matchRows = txMatches.rows || [];
      const matchedDocIds = matchRows.map((m) => m.matched_object_id).filter(Boolean);
      const documentIds = [...new Set([
        resolved.focusState?.transaction?.document_id,
        ...matchedDocIds
      ].filter(Boolean))];
      const timelineDocuments = documentIds.length
        ? await d.queryFirmDb(
            `select * from documents
              where firm_id = $1 and client_id = $2 and id = any($3)
              order by uploaded_at asc nulls last, created_at asc`,
            [resolvedFirmId, clientId, documentIds]
          )
        : { rows: [] };
      // Family matchers stamp their verdict on the DOCUMENT they evaluated;
      // the bank-line disposition producer stamps the transaction itself —
      // both belong to this line's story.
      const evalRows = await d.queryFirmDb(
        `select * from reconciliation_evaluations
          where firm_id = $1 and client_id = $2
            and (target_id = $3 or target_id = any($4))
          order by evaluated_at asc`,
        [resolvedFirmId, clientId, focusId, matchedDocIds]
      );
      const cerRows = await d.queryFirmDb(
        `select * from client_evidence_requests
          where firm_id = $1 and client_id = $2 and transaction_id = $3
          order by created_at asc`,
        [resolvedFirmId, clientId, focusId]
      );
      const evidenceRequests = cerRows.rows || [];
      // Universal mentions (slice 3): the line's comment-lane chat rows join
      // the same timeline — only kind 'comment'/'thread_resolution'; plain
      // conversation stays a chat-surface concern (fromChatComment re-checks).
      const commentRows = await d.queryFirmDb(
        `select * from transaction_chat_messages
          where firm_id = $1 and client_id = $2 and transaction_id = $3
            and payload->>'kind' in ('comment', 'thread_resolution')
          order by created_at asc limit 100`,
        [resolvedFirmId, clientId, focusId]
      );
      // Audit events key their resource_id on the tx, its review row, its
      // matches, or its asks — and the auto-explain writers key the line in
      // metadata.bank_transaction_id instead. One query covers both shapes.
      const auditIds = [
        focusId,
        resolved.focusState?.review_item?.id,
        ...documentIds,
        ...matchRows.map((m) => m.id),
        ...evidenceRequests.map((r) => r.id)
      ].filter(Boolean);
      const auditRows = await d.queryFirmDb(
        `with related_audit as (select * from audit_events
          where firm_id = $1 and client_id = $2
            and (resource_id = any($3) or metadata->>'bank_transaction_id' = $4)),
          recent_audit as (select * from related_audit order by created_at desc, id desc limit 200),
          current_policy as (select * from related_audit
            where resource_id = $4 and action in ('transaction.coding.policy_failed', 'transaction.coding.policy_recovered')
            order by id desc limit 1)
          select * from (select * from recent_audit union select * from current_policy) visible_audit
          order by created_at asc, id asc`,
        [resolvedFirmId, clientId, auditIds, focusId]
      );
      // Resolve persisted actor ids to their durable display names in this
      // ONE assembler. The renderer must never guess that a human was "You"
      // or hide a missing identity behind a generic role label.
      const actorRows = await d.queryFirmDb(
        `select id, user_id, email, name, 'firm'::text as actor_type
           from firm_members
          where firm_id = $1
         union all
         select id, user_id, email, name, 'client'::text as actor_type
           from firm_collaborators
          where firm_id = $1`,
        [resolvedFirmId]
      );
      const built = buildCaseTimeline({
        transaction: resolved.focusState?.transaction || null,
        documents: timelineDocuments.rows || [],
        matches: matchRows,
        evaluations: evalRows.rows || [],
        evidenceRequests,
        auditEvents: auditRows.rows || [],
        chatMessages: (commentRows.rows || []).map((row) => ({ ...row, chat_table: 'transaction_chat_messages' })),
        actors: actorRows.rows || []
      });
      // Client-level Gate 1B hold: when the saga is not ready AND a fresh
      // admission-blocked receipt exists (the workers refresh it on every
      // refused tick, so 60 minutes separates a live hold from history), the
      // case-health projection names the hold instead of conceding
      // "unclassified". Receipt-shaped by construction: the saga row plus the
      // audit event ARE the persisted state. An EXHAUSTED saga is the
      // exception to freshness: discovery no longer re-refuses it every tick
      // (entityReadinessExhaustedRestSql), so the saga row itself is the live
      // hold until the owner's Reopen — the latest refusal of any age still
      // names the boundary, and the saga's own attempt receipt stands in when
      // none was ever written.
      let readinessHold = null;
      const sagaRows = await d.queryFirmDb(
        'select state, retry_state, reason_code, latest_attempt_id from entity_readiness_sagas where firm_id = $1 and client_id = $2',
        [resolvedFirmId, clientId]
      );
      const sagaRow = sagaRows.rows?.[0] || null;
      if (sagaRow && sagaRow.state !== 'ready') {
        const exhausted = sagaRow.state === 'failed' && sagaRow.retry_state === 'exhausted';
        const blockedRows = await d.queryFirmDb(
          `select id, metadata from audit_events
            where firm_id = $1 and client_id = $2
              and action = 'runtime.readiness_admission_blocked'
              and coalesce(metadata->>'responsible_system','') <> 'donna_processing_scope'
              and ($3::boolean or created_at > now() - interval '60 minutes')
            order by id desc limit 1`,
          [resolvedFirmId, clientId, exhausted]
        );
        const blocked = blockedRows.rows?.[0] || null;
        if (blocked) {
          readinessHold = {
            boundary: blocked.metadata?.boundary || null,
            // An old refusal may predate this episode; the saga names its own.
            reason_code: (exhausted && sagaRow.reason_code) || blocked.metadata?.reason_code || null,
            retry_state: sagaRow.retry_state || null,
            receipt_ref: { table: 'audit_events', id: blocked.id || null }
          };
        } else if (exhausted) {
          readinessHold = {
            boundary: null,
            reason_code: sagaRow.reason_code || null,
            retry_state: sagaRow.retry_state,
            receipt_ref: sagaRow.latest_attempt_id == null ? null
              : { table: 'audit_events', id: Number(sagaRow.latest_attempt_id) }
          };
        }
      }
      // The terminal verdict, pinned on the block — computed WITH the real
      // open-ask signal (this block loaded the asks, so unlike the v1
      // convergence block it does not carry the null-CER caveat).
      // 122 — audience-partitioned: only a CLIENT ask is the owner signal; a
      // seat/agent ask feeds its own axis of the generalized projection.
      const liveAskStatus = (r) => ['open', 'replied'].includes(String(r.status || '').toLowerCase());
      const hasOpenOwnerAsk = evidenceRequests.some(
        (r) => askAudienceOf(r) === 'client' && liveAskStatus(r)
      );
      const terminal = deriveCaseConvergence({
        reviewItem: resolved.focusState?.review_item || null,
        transaction: resolved.focusState?.transaction || null,
        hasOpenOwnerAsk,
        hasOpenSeatAsk: evidenceRequests.some(
          (r) => askAudienceOf(r) === 'seat' && ['draft', 'open'].includes(String(r.status || '').toLowerCase())
        ),
        hasAnsweredSeatAsk: evidenceRequests.some(
          (r) => askAudienceOf(r) === 'seat' && String(r.status || '').toLowerCase() === 'replied'
        ),
        hasOpenAgentAsk: evidenceRequests.some(
          (r) => askAudienceOf(r) === 'agent' && ['draft', 'open', 'replied'].includes(String(r.status || '').toLowerCase())
        )
      });
      // Slice 4 (/assign): who holds the artifact — a projection over the
      // persisted assign comments (latest un-redacted one wins), never a
      // store. Null = never assigned.
      const assignment = latestAssignmentFromComments(commentRows.rows || []);
      timeline = wants('timeline')
        ? { present: true, terminal, assignment, events: built.events, gaps: built.gaps }
        : absent('not_included');
      caseHealth = wants('case_health')
        ? {
            present: true,
            ...buildCaseHealth({
              transaction: resolved.focusState?.transaction || null,
              reviewItem: resolved.focusState?.review_item || null,
              documents: timelineDocuments.rows || [],
              matches: matchRows,
              evaluations: evalRows.rows || [],
              evidenceRequests,
              auditEvents: auditRows.rows || [],
              actors: actorRows.rows || [],
              timeline: built,
              readinessHold
            })
          }
        : absent('not_included');
    } catch (err) {
      timeline = wants('timeline')
        ? absent(`timeline_query_failed:${err?.message || 'error'}`)
        : absent('not_included');
      caseHealth = wants('case_health')
        ? absent(`case_health_query_failed:${err?.message || 'error'}`)
        : absent('not_included');
    }
  }

  // Blocks reserved for later phases — present in the shape, absent in
  // data, with the contract section that will fill them.
  const body = {
    firm_id: resolvedFirmId,
    client_id: clientId,
    focus: { type: focusType, id: focusId },
    focus_state: resolved.focusState,
    pipeline_state: pipelineState,
    latest_model_decision: latestModelDecision,
    convergence,
    risk_flags: riskFlags,
    context_at_decision: absent('not_persisted_yet_contract_§10'),
    audit_timeline: auditTimeline,
    timeline,
    case_health: caseHealth,
    related,
    book_context: absent('deferred_contract_§1_later_slice'),
    blockers: absent('deferred_contract_§7'),
    allowed_actions: absent('deferred_tool_registry_contract_§2'),
    include: [...includeSet]
  };

  return {
    ...body,
    snapshot_id: computeSnapshotId(body),
    generated_at: d.now().toISOString()
  };
};
