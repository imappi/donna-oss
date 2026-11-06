// buildCaseHealth — the seven-question contract, Slice 1
// (docs/session-handoff-2026-08-17-case-health-projection.md; Kari's
// 2026-08-17 go). The two-terminal-states extension made machine-readable:
//
//   > There must never be an unexplained non-terminal state.
//   > Every owner interruption must carry a known unlock condition.
//
// Every non-terminal case answers SEVEN questions, each from PERSISTED
// receipts only:
//   1. Why am I stuck?            → `blocker` (one typed, concrete blocker)
//   2. What evidence is missing?  → `missing_evidence[]`
//   3. Which integration failed?  → `integration_failures[]`
//   4. What did I do?             → `actions` (the caseTimeline events, reused
//                                   verbatim — never re-merged)
//   5. Why did I do it?           → `reasons[]` (persisted reasoning + model
//                                   id + policy basis per consequential
//                                   decision)
//   6. What should the owner answer? → `owner_question` (the persisted ask,
//                                   verbatim — this module NEVER composes a
//                                   question; a missing ask is a writer gap)
//   7. Can I recover automatically? → `recovery` (typed class)
//
// PURE projection — no DB, no LLM, no clock. The receipts persisted at the
// writers ARE the first-class state; a separately persisted "health row"
// would drift from them (the fabricated-transparency anti-pattern,
// design-donna-line-audit-timeline.md §5.1), and a third parallel spine is
// the runtime plan's anti-goal. Where the projection CANNOT answer one of
// the seven from receipts, that is a WRITER gap surfaced in `gaps[]` — the
// gap list falling out of this module's tests IS the follow-up backlog.
//
// Precedence discipline: reconcileConvergenceState is the ONE authority on
// which axis binds a row (call it, never duplicate). The blocker is a typed
// mapping of the convergence verdict's own reason, refined only by
// receipt-shaped checks (a Suspense proposal IS the persisted refusal
// receipt; a parse_error IS the persisted integration failure). No second
// precedence order is invented here.
//
// Deferred inputs, named so the hole is visible rather than silent:
// loop_runs / loop_goal_reports rows (the GoalReport is the runtime
// doctrine's convergence-verdict home) are NOT consumed in Slice 1 — loop
// events belong in caseTimeline as their own kind first (one merge policy),
// and this module will read them through that stream when that slice lands.

import {
  convergenceForReviewItem,
  convergenceForTransaction,
  isConvergenceTerminal,
  hasOpenOwnerAskInRequests,
  hasAnsweredOwnerAskInRequests,
  hasOpenSeatAskInRequests,
  hasAnsweredSeatAskInRequests,
  hasOpenAgentAskInRequests,
  collectUnappliedCascadeTxIds,
  OPEN_OWNER_ASK_STATUSES,
  ANSWERED_PROCESSING_ASK_STATUSES
} from './reconcileConvergenceState.js';
import { buildCaseTimeline } from './caseTimeline.js';
import { summarizeBankLineDispositions } from './bankLineDispositionShape.js';
import { codingPolicyFailuresForTransaction, CODING_EVIDENCE_RECONSIDERED_REFUSALS, POSTING_SOURCE_RECHECK_REFUSALS, CODING_CONFLICT_MAX_RECONSIDERATIONS, codingReconsiderationAttempts, unsettledTreatmentOnClearSource, refusedCrossWindowGroup } from './codingPolicyRecovery.js';

// Q7 — the typed recovery classes (the contract's enum, exactly; never
// stretched). A non-terminal case NONE of these honestly fits answers
// `class: null` and surfaces `no_automatic_recovery_path` in gaps — the
// violation wearing its own name, never a wrong label (the same posture as
// the cascade check in reconcileConvergenceState: asking the owner to
// discharge a system failure would be the violation dressed as terminal).
export const RECOVERY_CLASSES = Object.freeze([
  'yes',                          // nothing blocks; the case finishes itself
  'retrying',                     // a failure occurred; retry machinery owes the work
  'waiting_for_external_system',  // blocked on a system outside Donna
  'owner_action_required'         // the unlock is an owner answer/act
]);

// The owner-home aggregate buckets ("N finished · N processing · N need
// you"). Phase is the OWNER-audience read; the convergence verdict pinned on
// the block stays the violation metric (an owner-answered reply in flight
// reads 'processing' to the owner while still counting hanging in the
// convergence metric — presentation never flatters the metric).
export const CASE_PHASES = Object.freeze([
  'review_only',  // saved review, explicitly incomplete accounting
  'finished',     // auto_reconciled
  'needs_owner',  // on_owner — one of the "N need you"
  'processing',   // non-terminal but machinery owes/does the next step
  'stuck'         // non-terminal with no live machinery — the violation bucket
]);

// Q1 — the typed blocker vocabulary. Small and closed; extend here, never
// ad-hoc in a renderer.
export const BLOCKER_KINDS = Object.freeze([
  'processing_review_only', // verified retained scope; no accounting recovery contract
  'native_review_refused',    // this client's native lineage/registration/policy does not verify (F-34): hangs until repaired
  'owner_ask_undeliverable',  // a draft owner ask nobody can receive (F-32): not on the owner until it is sent or a seat exists
  'awaiting_owner_answer',    // an open ask is with the owner
  'coding_refusal',           // the coder refused (Suspense) — an owner fact is missing
  'coding_unapplied',         // a confident proposal resting on a firm click (the SUGGESTED leak)
  'reviewer_hold',            // a human hold (review_state 'held')
  'match_awaiting_authority', // a held match resting on authorization
  'matched_but_uncoded',      // match settled, account still Suspense (Leak C)
  'cascade_not_applied',      // the settle cascade failed/never landed
  'disposition_gap_unrouted', // a needs_human/chase verdict that never reached the owner
  'owner_reply_unprocessed',  // the owner answered; the resume leg owes the processing (F8)
  'integration_failure',      // a typed system failure (parse, cascade, push)
  'processing',               // not stuck — machinery is mid-flight (concrete stage attached)
  'held_by_setup_recovery',   // readiness admission is refusing this client's workers (blocked receipt attached)
  'unclassified'              // no receipt explains the state — itself a defect to surface
]);

// The named writer gaps this projection can surface. Every entry is a
// statement that a persisted receipt SHOULD exist and does not — closing
// each is its own small PR at the writer, in the same transaction as the
// write it receipts.
export const CASE_HEALTH_GAP_KINDS = Object.freeze([
  'no_open_ask_for_owner_fact',       // a refusal/chase names an owner fact; no CER was minted (§4)
  'owner_ask_without_question_text',  // on_owner via review_state, but no CER row persists the question
  'untyped_integration_failure',      // a failure receipt lacks system/retry-safe typing (§3 Q3)
  'missing_reasoning_receipt',        // a consequential decision persisted no reasoning
  'no_automatic_recovery_path',       // non-terminal and no typed recovery derivable — the violation surfaced
  'no_focus_row'                      // nothing to project over
]);

const norm = (v) => (v == null ? '' : String(v).trim().toLowerCase());

const toIso = (value) => {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  const dt = typeof value === 'number' && Number.isFinite(value) ? new Date(value) : new Date(String(value));
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString();
};

// A proposal to Suspense/unknown/absent is a REFUSAL — the coder declining
// to decide, which under the fact-vs-knowledge fork means an owner fact is
// missing. Mirrors reconcileConvergenceState's isCoded notion (kept local;
// that helper is private there — same note as operatorCaseSnapshot's
// isRealAccount).
const isRefusalAccount = (account) => {
  const a = norm(account);
  return a === '' || a === 'suspense' || a === 'unknown';
};

// The persisted coding proposal, review payload winning over the
// transaction's (the latestModelDecisionFrom precedence in
// operatorCaseSnapshot).
const codingSuggestionOf = (reviewItem, transaction) => {
  const fromReview = reviewItem?.payload?.ai_suggestion;
  if (fromReview && typeof fromReview === 'object') {
    return { value: fromReview, receipt_ref: { table: 'transaction_review_queue', id: reviewItem.id || null, path: 'payload.ai_suggestion' } };
  }
  const fromTx = transaction?.payload?.ai_suggestion;
  if (fromTx && typeof fromTx === 'object') {
    return { value: fromTx, receipt_ref: { table: 'transactions', id: transaction.id || null, path: 'payload.ai_suggestion' } };
  }
  return null;
};

const PARSE_IN_FLIGHT_STATUSES = new Set(['pending', 'processing']);
const NEEDS_OWNER_DISPOSITIONS = new Set(['needs_human', 'chase_receipt', 'chase_evidence']);

// ─── Q3: typed integration failures from persisted failure receipts ─────────
// The §3 map calls this "the biggest writer-gap family": few receipts carry
// "which system, retry-safe?" typing, so `retry_safe: null` is a visible hole
// and each such failure ALSO emits `untyped_integration_failure` — the
// writer-gap backlog, generated by the projection itself.
// The inline drain's post-parse leg failure receipt (audit_events —
// recordPostParseLegFailureInDb). The parse completed, so the document row
// carries no trace; this event is the failure's one durable record.
const POST_PARSE_LEG_FAILED_ACTION = 'document.parse.leg_failed';

const collectIntegrationFailures = ({ documents, matches, auditEvents = [], gaps }) => {
  const failures = [];
  for (const doc of documents) {
    if (!doc) continue;
    const failed = norm(doc.parse_status) === 'failed' || doc.parse_error != null;
    if (!failed) continue;
    const receipt_ref = { table: 'documents', id: doc.id || null, path: 'parse_error' };
    failures.push({
      system: 'document_parse',
      operation: 'parse',
      failure: doc.parse_error || 'parse_failed',
      last_good_state: doc.parse_stage || null,
      document_id: doc.id || null,
      retry_safe: null, // not persisted anywhere — the named writer gap
      receipt_ref
    });
    gaps.push({ kind: 'untyped_integration_failure', system: 'document_parse', receipt_ref });
  }
  for (const match of matches) {
    const cascade = match?.payload?.cascade;
    const state = norm(cascade?.state);
    if (!state || state === 'applied') continue;
    const receipt_ref = { table: 'reconciliation_matches', id: match.id || null, path: 'payload.cascade' };
    failures.push({
      system: 'reconciliation_cascade',
      operation: 'settle_cascade',
      failure: cascade.error_class || state,
      attempts: cascade.attempts ?? null,
      last_good_state: `match:${match.status || 'unknown'}`,
      retry_safe: null, // the cascade receipt carries no retry contract — writer gap
      receipt_ref
    });
    gaps.push({ kind: 'untyped_integration_failure', system: 'reconciliation_cascade', receipt_ref });
  }
  for (const ev of Array.isArray(auditEvents) ? auditEvents : []) {
    if (!ev || norm(ev.action) !== POST_PARSE_LEG_FAILED_ACTION) continue;
    const md = ev.metadata && typeof ev.metadata === 'object' ? ev.metadata : {};
    // A re-parse runs fresh legs — a receipt stamped under a superseded
    // parse run is history, not this line's current blocker.
    const doc = documents.find((d) => d && d.id === ev.resource_id) || null;
    if (doc && md.parse_run_id && doc.parse_run_id && md.parse_run_id !== doc.parse_run_id) continue;
    const receipt_ref = { table: 'audit_events', id: ev.id || null, path: 'metadata' };
    const retry_safe = md.retry_safe === true ? true : md.retry_safe === false ? false : null;
    failures.push({
      system: 'post_parse_leg',
      operation: md.leg || null,
      failure: md.error || 'leg_failed',
      last_good_state: 'parse:completed',
      document_id: ev.resource_id || null,
      retry_safe,
      receipt_ref
    });
    // The receipt carries the leg's declared retry contract — typed, so no
    // untyped_integration_failure gap unless a foreign writer omitted it.
    if (retry_safe == null) {
      gaps.push({ kind: 'untyped_integration_failure', system: 'post_parse_leg', receipt_ref });
    }
  }
  return failures;
};

// ─── Q5: the persisted "why" behind each consequential decision ─────────────
// Renders reasoning + model id + policy basis VERBATIM from the receipts the
// strong writers already persist (ai_suggestion, match_reason, disposition
// payload). A consequential decision with no persisted reasoning is a
// `missing_reasoning_receipt` gap — never paraphrased around.
const collectReasons = ({ suggestion, matches, liveDisposition, gaps }) => {
  const reasons = [];
  if (suggestion) {
    const s = suggestion.value;
    reasons.push({
      decision: 'coding',
      at: toIso(s.suggested_at),
      account: s.proposed_account || s.account_name || s.account_code || null,
      model: s.model || null,
      policy_basis: s.policy_basis || null,
      reasoning: s.reasoning || null,
      receipt_ref: suggestion.receipt_ref
    });
    if (!s.reasoning) gaps.push({ kind: 'missing_reasoning_receipt', decision: 'coding', receipt_ref: suggestion.receipt_ref });
  }
  for (const match of matches) {
    const payload = match?.payload || {};
    const reason = payload.match_reason || {};
    const authorization = payload.authorization || {};
    const receipt_ref = { table: 'reconciliation_matches', id: match.id || null };
    reasons.push({
      decision: 'match',
      at: toIso(match.created_at),
      status: match.status || null,
      model: authorization.model || null,
      summary: reason.summary || match.match_reason || null,
      reasoning: reason.reasoning || null,
      receipt_ref
    });
    if (!reason.summary && !reason.reasoning && !match.match_reason) {
      gaps.push({ kind: 'missing_reasoning_receipt', decision: 'match', receipt_ref });
    }
  }
  if (liveDisposition) {
    reasons.push({
      decision: 'disposition',
      at: null, // summarizeBankLineDispositions carries no evaluated_at; the timeline event does
      disposition: liveDisposition.disposition || null,
      model: liveDisposition.model || null,
      reasoning: liveDisposition.reasoning || null,
      receipt_ref: liveDisposition.receipt_ref
    });
    if (!liveDisposition.reasoning) {
      gaps.push({ kind: 'missing_reasoning_receipt', decision: 'disposition', receipt_ref: liveDisposition.receipt_ref });
    }
  }
  return reasons;
};

// ─── The projection ─────────────────────────────────────────────────────────
// Same inputs buildCaseTimeline takes (+ the review row the convergence
// adapters need). `timeline` optionally carries an already-built
// buildCaseTimeline result so the one assembler never merges twice; absent,
// it is built here from the same rows (pure ⇒ identical).
export const buildCaseHealth = ({
  transaction = null,
  reviewItem = null,
  documents = [],
  matches = [],
  evaluations = [],
  evidenceRequests = [],
  auditEvents = [],
  actors = [],
  timeline = null,
  // Client-level readiness admission hold, supplied by the assembler from the
  // saga row + the latest fresh runtime.readiness_admission_blocked receipt
  // ({ boundary, reason_code, retry_state, receipt_ref } or null). Before this
  // input, a book whose workers were refused by Gate 1B rendered every line as
  // "stuck for a reason that was not recorded" — the receipts existed, the
  // projection just never saw them (2026-08-31, Desert Rose/Honeybee).
  readinessHold = null
} = {}) => {
  const gaps = [];
  const documentRows = (Array.isArray(documents) ? documents : []).filter(Boolean);
  const matchRows = (Array.isArray(matches) ? matches : []).filter(Boolean);
  const evaluationRows = (Array.isArray(evaluations) ? evaluations : []).filter(Boolean);
  const askRows = (Array.isArray(evidenceRequests) ? evidenceRequests : []).filter(Boolean);

  const built = timeline && Array.isArray(timeline.events)
    ? timeline
    : buildCaseTimeline({
        transaction, documents: documentRows, matches: matchRows,
        evaluations: evaluationRows, evidenceRequests: askRows,
        auditEvents, actors
      });

  if (!transaction && !reviewItem) {
    gaps.push({ kind: 'no_focus_row' });
    return {
      convergence: null,
      phase: null,
      blocker: null,
      missing_evidence: [],
      integration_failures: [],
      actions: built.events,
      reasons: [],
      owner_question: null,
      recovery: { class: null, basis: 'no_focus_row' },
      gaps
    };
  }

  const txId = transaction?.id ?? reviewItem?.payload?.transaction_id ?? reviewItem?.item_id ?? null;

  // The live disposition verdict for this line, INV-4 applied (a settling
  // match outranks the verdict) — through the shared summarizer, so the
  // health read and the feed read can never disagree.
  const settledTxIds = new Set(
    matchRows
      .filter((m) => ['confirmed', 'auto_matched'].includes(norm(m.status)))
      .map((m) => m.bank_transaction_id ?? txId)
      .filter((id) => id != null)
  );
  const dispositionRows = evaluationRows.filter((r) => r.target_id === txId || r.target_id == null);
  const dispositionMap = summarizeBankLineDispositions(dispositionRows, { settledTransactionIds: settledTxIds });
  const rawDisposition = txId != null ? dispositionMap.get(txId) || null : null;
  const dispositionEvalRow = rawDisposition
    ? dispositionRows.filter((r) => r.matcher_family === 'bank_line_disposition').slice(-1)[0] || null
    : null;
  const liveDisposition = rawDisposition
    ? { ...rawDisposition, receipt_ref: { table: 'reconciliation_evaluations', id: dispositionEvalRow?.id || null, path: 'payload' } }
    : null;

  // The convergence verdict — THE precedence authority — through the same
  // adapters every projection site uses, with every axis this module's
  // inputs can supply (asks, cascade, disposition).
  const hasOpenOwnerAsk = hasOpenOwnerAskInRequests(askRows);
  const hasAnsweredOwnerAsk = hasAnsweredOwnerAskInRequests(askRows);
  const hasOpenSeatAsk = hasOpenSeatAskInRequests(askRows);
  const hasAnsweredSeatAsk = hasAnsweredSeatAskInRequests(askRows);
  const hasOpenAgentAsk = hasOpenAgentAskInRequests(askRows);
  const cascadeState = txId != null ? collectUnappliedCascadeTxIds(matchRows).get(txId) || null : null;
  const txForProjection = transaction && !transaction.bank_line_disposition && liveDisposition
    ? { ...transaction, bank_line_disposition: { disposition: liveDisposition.disposition } }
    : transaction || {};
  const askContext = { processingScope: transaction?.processing_scope, hasOpenOwnerAsk, hasAnsweredOwnerAsk, hasOpenSeatAsk, hasAnsweredSeatAsk, hasOpenAgentAsk, cascadeState };
  // RT-17 PR 8 — a transaction row read with the persisted column (RT-13,
  // migration 137) carries the writers' own verdict, lane suffix included;
  // render it. The in-memory adapters remain the fallback for a row handed in
  // without the column (a pure fixture), never a second opinion on one with it.
  const projected = typeof transaction?.convergence_state === 'string'
    ? { state: transaction.convergence_state, reason: transaction.convergence_reason ?? null }
    : reviewItem
      ? convergenceForReviewItem(reviewItem, txForProjection, askContext)
      : convergenceForTransaction(txForProjection, askContext);
  const convergence = {
    state: projected.state,
    reason: projected.reason,
    terminal: isConvergenceTerminal(projected)
  };

  const codingPolicyFailures = codingPolicyFailuresForTransaction({ transaction, auditEvents });
  const integration_failures = [
    ...codingPolicyFailures,
    ...collectIntegrationFailures({ documents: documentRows, matches: matchRows, auditEvents, gaps })
  ];

  const suggestion = codingSuggestionOf(reviewItem, transaction);
  const reasons = collectReasons({ suggestion, matches: matchRows, liveDisposition, gaps });

  // Q6 — the persisted owner question, verbatim. The earliest OPEN ask is
  // "the smallest question that unlocks"; this module never composes one.
  // 122 — audience-partitioned: only a CLIENT-audience ask is the owner's
  // question; a seat ask surfaces under its own kind (a colleague holds it);
  // an agent ask is Donna-owed work and renders via the convergence reason
  // ('agent_ask_unanswered'), never as a human question.
  const audienceOfAsk = (r) => {
    const a = norm(r?.audience);
    return a === 'seat' || a === 'agent' ? a : 'client';
  };
  const openAsks = askRows.filter((r) => OPEN_OWNER_ASK_STATUSES.includes(norm(r.status)));
  const openClientAsks = openAsks.filter((r) => audienceOfAsk(r) === 'client');
  const openSeatAsks = openAsks.filter((r) => audienceOfAsk(r) === 'seat');
  const repliedAsks = askRows.filter((r) => ANSWERED_PROCESSING_ASK_STATUSES.includes(norm(r.status)));
  const repliedClientAsks = repliedAsks.filter((r) => audienceOfAsk(r) === 'client');
  const repliedSeatAsks = repliedAsks.filter((r) => audienceOfAsk(r) === 'seat');
  const earliest = (rows) => rows
    .slice()
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))[0] || null;
  const firstOpenAsk = earliest(openClientAsks);
  const firstOpenSeatAsk = earliest(openSeatAsks);
  const owner_question = firstOpenAsk
    ? {
        question: firstOpenAsk.question || null,
        evidence_type: firstOpenAsk.evidence_type || null,
        sent: toIso(firstOpenAsk.first_sent_at),
        receipt_ref: { table: 'client_evidence_requests', id: firstOpenAsk.id || null }
      }
    : null;

  // Q2 — missing evidence, from receipts that SAY something is missing.
  const missing_evidence = [];
  for (const ask of openAsks) {
    const audience = audienceOfAsk(ask);
    if (audience === 'agent') continue;
    missing_evidence.push({
      kind: audience === 'seat' ? 'open_seat_ask' : 'open_owner_ask',
      evidence_type: ask.evidence_type || null,
      question: ask.question || null,
      status: norm(ask.status) || null,
      ...(audience === 'seat'
        ? {
            addressee_principal_type: ask.addressee_principal_type || null,
            addressee_principal_id: ask.addressee_principal_id || null
          }
        : {}),
      receipt_ref: { table: 'client_evidence_requests', id: ask.id || null }
    });
  }
  const refusal = suggestion && isRefusalAccount(suggestion.value.proposed_account || suggestion.value.account_name || suggestion.value.account_code);
  const dispositionNeedsOwner = liveDisposition && NEEDS_OWNER_DISPOSITIONS.has(norm(liveDisposition.disposition));
  if (!convergence.terminal || convergence.state === 'on_owner') {
    if (refusal && !openAsks.length) {
      missing_evidence.push({
        kind: 'owner_fact_unasked',
        source: 'coding_refusal',
        reasoning: suggestion.value.reasoning || null,
        receipt_ref: suggestion.receipt_ref
      });
    }
    if (dispositionNeedsOwner && !openAsks.length) {
      missing_evidence.push({
        kind: 'owner_fact_unasked',
        source: `disposition:${norm(liveDisposition.disposition)}`,
        reasoning: liveDisposition.reasoning || null,
        receipt_ref: liveDisposition.receipt_ref
      });
    }
  }

  // ── Q1 + Q7: blocker and recovery, mapped from the convergence reason ──
  // (ONE precedence — the convergence module's own — refined only by
  // receipt-shaped facts). `recovery.class: null` always travels with a
  // `no_automatic_recovery_path` gap: an unexplained non-terminal state is a
  // system defect, and this is where it becomes visible.
  let phase;
  let blocker = null;
  let recovery;
  const stuckNoPath = (basis) => {
    gaps.push({ kind: 'no_automatic_recovery_path', reason: convergence.reason, basis });
    return { class: null, basis };
  };
  // The refusal axis binds only where the coding axis is what the reason
  // points at — cascade/authority/F8/disposition reasons keep their own
  // blocker (the convergence precedence, not a second one).
  const codingBoundReasons = new Set(['coding_state:proposed', 'matched_but_uncoded', 'unclassified']);

  // An applied coding is a decision, but a current posting refusal still owes
  // operational recovery. Keep the canonical convergence result unchanged while
  // exposing that receipt instead of calling the failed publication finished.
  const activePostingFailure = codingPolicyFailures.some((failure) => failure.operation === 'posting')
    && transaction?.coding_state === 'applied';
  if (convergence.state === 'auto_reconciled' && !activePostingFailure) {
    phase = 'finished';
    blocker = null;
    recovery = { class: 'yes', basis: `terminal:${convergence.reason}` };
  } else if (convergence.state === 'on_owner' && convergence.reason === 'open_seat_ask') {
    // 122 — terminal 2 on a customer-side COLLEAGUE: the question is a seat's
    // to answer, so the blocker names the seat, never the owner.
    phase = 'needs_seat';
    blocker = {
      kind: 'awaiting_seat_answer',
      detail: firstOpenSeatAsk?.question || null,
      since: toIso(firstOpenSeatAsk?.first_sent_at),
      addressee_principal_type: firstOpenSeatAsk?.addressee_principal_type || null,
      addressee_principal_id: firstOpenSeatAsk?.addressee_principal_id || null,
      receipt_ref: firstOpenSeatAsk ? { table: 'client_evidence_requests', id: firstOpenSeatAsk.id || null } : null
    };
    recovery = { class: 'seat_action_required', basis: convergence.reason };
    if (!firstOpenSeatAsk) {
      gaps.push({ kind: 'seat_ask_without_question_text', reason: convergence.reason });
    }
  } else if (convergence.state === 'on_owner') {
    phase = 'needs_owner';
    blocker = {
      kind: 'awaiting_owner_answer',
      detail: owner_question?.question || null,
      since: owner_question?.sent || null,
      receipt_ref: owner_question?.receipt_ref || null
    };
    recovery = { class: 'owner_action_required', basis: convergence.reason };
    if (!owner_question) {
      // on_owner via review_state alone: the ask supposedly went out, but no
      // CER row persists its text — the owner interruption has no known
      // unlock condition on record. Writer gap.
      gaps.push({ kind: 'owner_ask_without_question_text', reason: convergence.reason });
    }
  } else {
    // hanging — the violation bucket; every branch names its blocker.
    const reason = convergence.reason || 'unclassified';
    const policyFailure = codingPolicyFailures[0];
    if (policyFailure && (reason==='processing_review_only' || reason==='native_chart_lineage_invalid' || reason.startsWith('native_review_refused:') || codingBoundReasons.has(reason) || reason.startsWith('reconciliation_status:') || (policyFailure.operation === 'posting' && (reason === 'coding_state:applied' || reason.startsWith('ledger_post_refused:')))) && !readinessHold) {
      // The setup question comes from the persisted receipt. It does not mint
      // an evidence ask or turn a system failure into an owner obligation, and
      // it never overrides the authoritative convergence verdict above.
      const ownerFact = policyFailure.failure_kind === 'missing_owner_fact';
      const automaticRetry = ['coding_convergence', 'ledger_auto_post'].includes(policyFailure.recovery_route);
      phase = ownerFact ? 'needs_owner' : automaticRetry ? 'processing' : 'stuck';
      blocker = {
        kind: 'integration_failure',
        detail: {
          system: policyFailure.system, failure: policyFailure.failure,
          reason_detail: policyFailure.reason_detail,
          recovery_route: policyFailure.recovery_route,
          owner_question: policyFailure.owner_question,
          unlock_condition: policyFailure.unlock_condition,
          escalation_required: policyFailure.escalation_required,
          attempts: policyFailure.attempts
        },
        receipt_ref: policyFailure.receipt_ref
      };
      recovery = ownerFact
        ? { class: 'owner_action_required', basis: 'coding_policy_profile_confirmation' }
        : automaticRetry
          ? { class: 'retrying', basis: policyFailure.recovery_route }
          : stuckNoPath('coding_policy_incident_requires_repair');
    } else if (refusedCrossWindowGroup(transaction) && (codingBoundReasons.has(reason) || reason.startsWith('reconciliation_status:'))) {
      // H-7b: a refund group refused for spanning policy windows. No worker
      // owns it until its evidence changes (codingPolicyRecovery.js), so it is
      // stuck with the persisted refusal as its named cause.
      const crossWindow = refusedCrossWindowGroup(transaction);
      phase = 'stuck';
      blocker = {
        kind: 'integration_failure',
        detail: { system: 'ledger_post', failure: crossWindow.code, message: crossWindow.message },
        receipt_ref: { table: 'transactions', id: transaction?.id || null, path: 'payload.ledger_post_refusal' }
      };
      recovery = stuckNoPath(crossWindow.code);
    } else if (reason.startsWith('cascade_')) {
      const failed = integration_failures.find((f) => f.system === 'reconciliation_cascade') || null;
      phase = 'stuck';
      blocker = {
        kind: 'cascade_not_applied',
        detail: failed ? { failure: failed.failure, attempts: failed.attempts } : null,
        receipt_ref: failed?.receipt_ref || null
      };
      recovery = stuckNoPath('cascade_has_no_retry_contract');
    } else if (reason === 'matched_pending_authority_no_grant') {
      const held = matchRows.find((m) => norm(m.status) === 'suggested') || null;
      phase = 'stuck';
      blocker = {
        kind: 'match_awaiting_authority',
        detail: held?.payload?.authorization?.reasons || null,
        receipt_ref: held ? { table: 'reconciliation_matches', id: held.id || null, path: 'payload.authorization' } : null
      };
      recovery = stuckNoPath('match_resting_on_authorization');
    } else if (reason === 'owner_answered_processing') {
      const replied = repliedClientAsks[0] || null;
      phase = 'processing';
      blocker = {
        kind: 'owner_reply_unprocessed',
        detail: replied?.question || null,
        receipt_ref: replied ? { table: 'client_evidence_requests', id: replied.id || null } : null
      };
      // The reply-resume leg exists (firmDb __shouldResumeFromClientReply):
      // the answer re-invokes the coder, applies, resolves. Its own receipt
      // of having run is the F8 follow-up; typed answer here is 'retrying'.
      recovery = { class: 'retrying', basis: 'owner_reply_resume_leg' };
    } else if (reason === 'seat_answered_processing') {
      // 122 — the F8 shape on the seat lane: the colleague answered; the
      // processing (re-code / re-disposition / request flip) is Donna's.
      const replied = repliedSeatAsks[0] || null;
      phase = 'processing';
      blocker = {
        kind: 'seat_reply_unprocessed',
        detail: replied?.question || null,
        receipt_ref: replied ? { table: 'client_evidence_requests', id: replied.id || null } : null
      };
      recovery = { class: 'retrying', basis: 'seat_reply_resume_leg' };
    } else if (reason === 'agent_ask_unanswered') {
      // 122 — an ask ON an agent is never a resting state: Donna owes the
      // answer. Surfaced as Donna-side work with the ask receipt attached.
      const agentAsk = askRows.find((r) => audienceOfAsk(r) === 'agent') || null;
      phase = 'processing';
      blocker = {
        kind: 'agent_ask_unanswered',
        detail: agentAsk?.question || null,
        receipt_ref: agentAsk ? { table: 'client_evidence_requests', id: agentAsk.id || null } : null
      };
      recovery = { class: 'retrying', basis: 'agent_ask_runtime_owes_answer' };
    } else if (reason === 'native_chart_lineage_invalid' || reason.startsWith('native_review_refused:')) {
      // F-34: the refusal's own key. A runtime-policy incident (the branch above)
      // carries the escalation when the recovery worker has receipted one; this
      // is the fallback naming the cause when it has not yet.
      phase = 'stuck';
      blocker = { kind: 'native_review_refused', detail: { reason }, receipt_ref: null };
      recovery = stuckNoPath('native_review_refused_needs_repair');
    } else if (reason === 'owner_ask_undeliverable') {
      const draft = askRows.find((r) => audienceOfAsk(r) === 'client') || null;
      phase = 'stuck';
      blocker = { kind: 'owner_ask_undeliverable', detail: draft?.question || null,
        receipt_ref: draft ? { table: 'client_evidence_requests', id: draft.id || null } : null };
      recovery = stuckNoPath('owner_ask_undeliverable_no_recipient_or_send');
    } else if (reason === 'processing_review_only') {
      const scope = transaction?.processing_scope;
      phase = scope?.review_current === true ? 'review_only' : 'stuck';
      blocker = { kind:'processing_review_only',detail:{review_current:scope?.review_current===true,
        review_reason:scope?.review_reason || 'review_receipt_missing',posting:'unavailable',accounting_ready:false},
        receipt_ref:scope?.review_current && (transaction?.review_scope || transaction?.payload?.review_scope)?.acceptance_audit
          ? {table:'audit_events',id:(transaction.review_scope || transaction.payload.review_scope).acceptance_audit.id} : null };
      recovery = stuckNoPath('processing_review_only_unqualified_accounting');
    } else if (reason.startsWith('ledger_post_refused:')) {
      // RT-23 — the ledger writer refused an APPLIED coding. The persisted
      // refusal is the cause (both writers store the sentence under `error`;
      // snapshot rows flatten payload keys, so read either shape). A clock owns
      // the next attempt while the code is one it reconsiders and its own
      // stamp has not exhausted the bound: the evidence clock counts attempts
      // per case revision, the source re-read lane records its state.
      const holder = transaction?.ledger_post_refusal || transaction?.payload?.ledger_post_refusal || null;
      const code = String(holder?.code || '').trim() || reason.slice('ledger_post_refused:'.length) || null;
      const reconsideration = transaction?.coding_evidence_reconsideration || transaction?.payload?.coding_evidence_reconsideration || null;
      const recheckState = norm((transaction?.posting_recovery || transaction?.payload?.posting_recovery)?.state);
      // Attempts count only under the current coding contract (the worker's
      // own rule, codingPolicyRecovery.js): a receipt from an earlier contract
      // is a row the clock re-admits, so it is processing, never stuck.
      const attemptsLeft = codingReconsiderationAttempts(reconsideration) < CODING_CONFLICT_MAX_RECONSIDERATIONS;
      // H-5a: an unsure treatment the verified source's clear printed tax
      // should have settled is owned by no worker — the re-read is settled and
      // the clock never re-admits it. It renders stuck with its named cause.
      const unsettled = unsettledTreatmentOnClearSource(transaction);
      const clockOwned = !unsettled && (recheckState === 'retry_pending'
        || (recheckState !== 'exhausted' && attemptsLeft
          && (CODING_EVIDENCE_RECONSIDERED_REFUSALS.includes(code) || POSTING_SOURCE_RECHECK_REFUSALS.includes(code))));
      phase = clockOwned ? 'processing' : 'stuck';
      blocker = {
        kind: 'integration_failure',
        detail: { system: 'ledger_post', failure: code, message: holder?.error || holder?.message || null,
          ...(unsettled ? { cause: unsettled.cause, source_tax: unsettled.source_tax } : {}) },
        receipt_ref: { table: 'transactions', id: transaction?.id || null, path: 'payload.ledger_post_refusal' }
      };
      recovery = clockOwned ? { class: 'retrying', basis: 'ledger_post_refusal_recovery' } : stuckNoPath(unsettled ? unsettled.cause : reason);
    } else if (codingBoundReasons.has(reason) && refusal) {
      // The §4 proof case: the coder REFUSED (Suspense) because an owner
      // fact is missing, and no ask was minted. The blocker detail is the
      // persisted refusal reasoning — rendered, never re-narrated.
      phase = 'stuck';
      blocker = {
        kind: 'coding_refusal',
        detail: suggestion.value.reasoning || null,
        receipt_ref: suggestion.receipt_ref
      };
      recovery = { class: 'owner_action_required', basis: 'coding_refusal_owner_fact' };
      if (!openAsks.length) {
        gaps.push({ kind: 'no_open_ask_for_owner_fact', source: 'coding_refusal', receipt_ref: suggestion.receipt_ref });
      }
    } else if (reason === 'coding_state:proposed') {
      phase = 'stuck';
      blocker = {
        kind: 'coding_unapplied',
        detail: suggestion
          ? { proposed_account: suggestion.value.proposed_account || null, confidence: suggestion.value.confidence ?? null }
          : null,
        receipt_ref: suggestion?.receipt_ref || null
      };
      // A confident proposal resting on a firm click is the SUGGESTED leak —
      // doctrine says it should have auto-applied or asked; no machinery
      // will move it. Surfaced, never laundered.
      recovery = stuckNoPath('suggested_resting_on_firm_click');
    } else if (reason === 'coding_state:held') {
      phase = 'stuck';
      blocker = { kind: 'reviewer_hold', detail: null, receipt_ref: reviewItem ? { table: 'transaction_review_queue', id: reviewItem.id || null } : null };
      recovery = stuckNoPath('reviewer_hold');
    } else if (reason === 'matched_but_uncoded') {
      phase = 'stuck';
      blocker = {
        kind: 'matched_but_uncoded',
        detail: suggestion ? { proposed_account: suggestion.value.proposed_account || null } : null,
        receipt_ref: suggestion?.receipt_ref || null
      };
      recovery = stuckNoPath('matched_but_uncoded');
    } else if (reason.startsWith('disposition:')) {
      const disp = reason.slice('disposition:'.length);
      phase = 'stuck';
      blocker = {
        kind: 'disposition_gap_unrouted',
        detail: { disposition: disp, reasoning: liveDisposition?.reasoning || null },
        receipt_ref: liveDisposition?.receipt_ref || null
      };
      // The verdict itself says the unlock is an owner fact/receipt — the
      // ask that carries it to the owner is what's missing (writer gap).
      recovery = { class: 'owner_action_required', basis: reason };
      if (!openAsks.length) {
        gaps.push({ kind: 'no_open_ask_for_owner_fact', source: reason, receipt_ref: liveDisposition?.receipt_ref || null });
      }
    } else {
      // No receipt explains the state. Three receipt-shaped refinements before
      // conceding: a live readiness-admission hold, a live integration
      // failure, or a parse mid-flight. The hold comes FIRST: while Gate 1B
      // refuses this client's workers, "pending parse" and stale failures are
      // symptoms of the hold, not this line's own blocker — and a doc resting
      // at parse_status 'pending' behind a hold must not render as live
      // progress.
      const failure = integration_failures[0] || null;
      const inFlightDoc = documentRows.find((d) => PARSE_IN_FLIGHT_STATUSES.has(norm(d.parse_status))) || null;
      if (readinessHold) {
        const exhausted = norm(readinessHold.retry_state) === 'exhausted';
        phase = exhausted ? 'stuck' : 'processing';
        blocker = {
          kind: 'held_by_setup_recovery',
          detail: {
            boundary: readinessHold.boundary || null,
            reason_code: readinessHold.reason_code || null
          },
          receipt_ref: readinessHold.receipt_ref || null
        };
        // While the bounded heal loop still owes retries the recovery is
        // honestly 'retrying'; an exhausted saga has no automatic path — its
        // exit is the explicit reopen action, so the class stays null and the
        // violation surfaces.
        recovery = exhausted
          ? stuckNoPath('readiness_recovery_exhausted')
          : { class: 'retrying', basis: 'readiness_recovery_in_progress' };
      } else if (failure) {
        phase = 'stuck';
        blocker = { kind: 'integration_failure', detail: { system: failure.system, failure: failure.failure }, receipt_ref: failure.receipt_ref };
        // Typed receipts (post-parse legs) declare retry_safe — but nothing
        // re-drives a dead drain leg, so the honest class is still null;
        // only the basis differs from the untyped writer-gap family.
        recovery = stuckNoPath(
          failure.retry_safe == null ? 'integration_failure_untyped_retry' : 'integration_failure_no_redrive'
        );
      } else if (inFlightDoc) {
        phase = 'processing';
        blocker = {
          kind: 'processing',
          detail: {
            stage: inFlightDoc.parse_stage || inFlightDoc.parse_status || null,
            progress_current: inFlightDoc.parse_progress_current ?? null,
            progress_total: inFlightDoc.parse_progress_total ?? null
          },
          receipt_ref: { table: 'documents', id: inFlightDoc.id || null, path: 'parse_stage' }
        };
        recovery = { class: 'yes', basis: 'parse_in_flight' };
      } else {
        phase = 'stuck';
        blocker = { kind: 'unclassified', detail: convergence.reason, receipt_ref: null };
        recovery = stuckNoPath('unclassified');
      }
    }
  }

  return {
    ...(transaction?.processing_scope?.enforced ? {accounting_ready:false,converged:false} : {}),
    convergence,
    phase,
    blocker,
    missing_evidence,
    integration_failures,
    actions: built.events,
    reasons,
    owner_question,
    recovery,
    gaps
  };
};
