// Donna Loops — the (proof) Loop Library: product-authored LoopDefinitions.
//
// See docs/loops-architecture-uplift-design.md §6. A LoopDefinition is the
// product's versioned statement of "what Donna is trying to accomplish, and
// how" — goal + evaluator + allowed actions + execution budget + scenario
// suite. Firms may later tune thresholds/schedules; they do NOT author
// free-form goals. This file ships ONE concrete definition as proof that the
// projection the audit found triplicated across loopsShadowProducers.js
// (scan A / forward hook / close hook) collapses to a single declarative
// evaluator — making "add a producer" a one-spec change on the Loops side,
// the property the matcher core already has on the intelligence side.
//
// reconciliation_gap_resolution is a DETERMINISTIC goal: the intelligence
// (deciding a no_match / auto_explained verdict) already ran upstream in
// reconciliationLlmCore and is persisted in reconciliation_evaluations. The
// loop only PROJECTS that persisted verdict (+ live match state) into a gap
// case — workflow-only, no LLM, INV-13 / "render the persisted verdict".

import { evaluateGoal } from './loopGoal.js';

// The reconciliation gap goal: the target is settled (a sticky match) or
// explained-away (immaterial recurring noise the model auto-explained), so no
// human gap remains. One required criterion — reconciliation's goal is binary;
// the richness (which blocker, what owner) lives in the derived desired case,
// not in the goal lattice.
export const RECONCILIATION_GAP_GOAL = {
  key: 'reconciliation_gap_resolved',
  version: '1',
  description: 'The reconciliation target is settled by a match or explained as immaterial — no human gap remains.',
  evaluatorType: 'deterministic',
  criteria: [
    { key: 'matched_or_explained', required: true,
      description: 'A sticky match settles the target, or the verdict is auto_explained.' }
  ]
};

export const RECONCILIATION_GAP_DEFINITION = {
  key: 'reconciliation_gap_resolution',
  version: '1',
  caseType: 'reconciliation',
  description: 'Resolve an unmatched/unexplained reconciliation target into a settled or explained state.',
  triggerMatchers: [
    'reconciliation.run_completed',     // forward hook (7.1)
    'reconciliation.match_confirmed',   // close hook (7.0)
    'reconciliation.evaluation_completed', // a fresh strong-model re-match landed (PR 1) — read the new verdict
    'document.parse_completed',         // an obligation may have just become evaluable
    'manual.resume',
    'schedule.recon_sweep',             // the backfill scan (7.0), now an inbox event
    'dependency.resolved'               // an upstream case resolved (the Step 7 cascade, §6.2)
  ],
  goal: RECONCILIATION_GAP_GOAL,
  snapshotBuilder: 'buildReconciliationCaseSnapshot',
  goalEvaluator: 'evaluateReconciliationGoal',
  // Workflow-only projection: zero model calls at the loop layer (the verdict
  // was already minted upstream). Bounded all the same — INV-15.
  executionPolicy: {
    maxModelCallsPerWake: 0,
    maxToolCallsPerWake: 2,
    maxElapsedMs: 5000,
    maxRetries: 1,
    maxNoProgressRuns: 2
  },
  allowedActions: ['open_gap_case', 'resolve_gap_case', 'request_fresh_reconciliation_evaluation', 'noop'],
  // The §13.8 bounded action a WAKE of this loop performs (loopExecutionGate /
  // Step 6). The reconciliation wake is read-only — it re-evaluates the goal and
  // lets the engine receipt it (reconciliationWakeEvaluator), opening/resolving
  // nothing — so its action is 'goal_report_only', permitted at shadow+.
  wakeAction: 'goal_report_only',
  priorityPolicy: 'reconciliationPriorityV1',
  escalationPolicy: 'reconciliationEscalationV1',
  scenarioSuite: 'loop-goals'
};

// The coding loop: a client ask batch (one coding case) fans into per-question
// evidence cases that BLOCK it (§6.2 "Evidence case E blocks coding case C"). The
// batch is resolvable once every blocking evidence question has been answered —
// the typed-dependency cascade's first cross-type downstream. DETERMINISTIC like
// reconciliation: the goal reads the graph (which evidence cases block this batch)
// + each evidence case's answered state (its missing_client_answer blocker), never
// the reply's CONTENT (INV-12); the strong-model reading of the reply is the
// proposal pipeline's job, not the loop's.
export const CODING_ASK_BATCH_GOAL = {
  key: 'ask_batch_answered',
  version: '1',
  description: 'Every client question this ask batch is waiting on has been answered — the coding can proceed.',
  evaluatorType: 'deterministic',
  criteria: [
    { key: 'all_questions_answered', required: true,
      description: 'No evidence request blocking this batch is still awaiting a client answer.' }
  ]
};

export const CODING_ASK_BATCH_DEFINITION = {
  key: 'coding_ask_batch_resolution',
  version: '1',
  caseType: 'coding',
  description: 'Resolve a client ask batch by collecting every outstanding client answer.',
  triggerMatchers: [
    'dependency.resolved', // an evidence case this batch blocks resolved (the §6.2 cascade)
    'manual.resume'
  ],
  goal: CODING_ASK_BATCH_GOAL,
  goalEvaluator: 'evaluateCodingGoal',
  // Workflow-only re-projection (zero model calls): it counts answered questions
  // off persisted blocker state. Bounded all the same — INV-15.
  executionPolicy: {
    maxModelCallsPerWake: 0,
    maxToolCallsPerWake: 2,
    maxElapsedMs: 5000,
    maxRetries: 1,
    maxNoProgressRuns: 2
  },
  allowedActions: ['noop', 'resolve_coding_case'],
  // Read-only re-evaluation (like reconciliation): it re-projects the goal and lets
  // the engine receipt it; resolving the batch blocker is a producer's job.
  wakeAction: 'goal_report_only',
  scenarioSuite: 'loop-goals'
};

export const LOOP_DEFINITIONS = {
  [`${RECONCILIATION_GAP_DEFINITION.key}.v${RECONCILIATION_GAP_DEFINITION.version}`]:
    RECONCILIATION_GAP_DEFINITION,
  [`${CODING_ASK_BATCH_DEFINITION.key}.v${CODING_ASK_BATCH_DEFINITION.version}`]:
    CODING_ASK_BATCH_DEFINITION
};

export const getLoopDefinition = (key, version) =>
  LOOP_DEFINITIONS[`${key}.v${version}`] || null;

// Every LoopDefinition whose triggerMatchers include this event type. Most events
// have exactly one subscriber; a CASCADE event (dependency.resolved) is shared by
// every case-type loop, so it returns more than one — the caller disambiguates by
// case type (resolveLoopDefinitionForTrigger).
export const loopDefinitionsForTrigger = (eventType) => {
  if (!eventType) return [];
  return Object.values(LOOP_DEFINITIONS).filter(
    (def) => Array.isArray(def.triggerMatchers) && def.triggerMatchers.includes(eventType)
  );
};

// Resolve the ONE LoopDefinition for an event — the dispatch the inbox worker uses
// to route an event to its wake (design §10 Step 5 / §6.2 cascade routing). A
// single-subscriber event resolves directly; a shared cascade event
// (dependency.resolved) is disambiguated by the woken case's `caseType` so the
// coding wake never runs the reconciliation evaluator (or vice versa). Returns null
// for an unsubscribed event, or for an ambiguous one with no caseType to break the
// tie (the worker treats that as 'unhandled' / 'no_loop_for_case_type').
export const resolveLoopDefinitionForTrigger = (eventType, { caseType = null } = {}) => {
  const matches = loopDefinitionsForTrigger(eventType);
  if (matches.length <= 1) return matches[0] || null;
  if (caseType) return matches.find((def) => def.caseType === caseType) || null;
  return null;
};

// ---- the reconciliation goal evaluator -----------------------------------

// Bank-line DISPOSITION no_match reasons (bankLineDispositionLlm.js
// DISPOSITION_DEFAULT_REASON). A bare bank line the disposition pass could not
// settle is NOT firm matching work — it is a question only the BUSINESS OWNER
// can answer: what is this charge (needs_human_review), where is the receipt
// (receipt_needed), or the substantiating payout/invoice (evidence_needed).
// Per the two-terminal FIRST principle (CLAUDE.md) these must rest ON THE OWNER
// (waiting_client), never in firm limbo (waiting_firm) — so the gap they open is
// client-owned. The document-anchored no_match (any other reason) stays firm:
// matching a document to a line, or uploading a missing statement, IS firm work.
// The owner-facing QUESTION itself is drafted + sent by the ask pipeline
// (askPipeline.js); this client-owned gap carries the same line on the close
// graph so it reads as "on the owner", never as a firm-side close blocker.
const DISPOSITION_OWNER_ASK_REASONS = new Set([
  'needs_human_review', 'receipt_needed', 'evidence_needed'
]);

// The SINGLE place INV-4 (a sticky match outranks any verdict) is applied for
// the gap projection — replacing the byte-identical `not exists (sticky match)`
// subquery duplicated across scan A and the forward hook, plus the
// auto_explained-by-omission suppression and the no_candidates/forward-hook
// divergence the audit flagged. All four become explicit, typed branches here.
//
// input (all from PERSISTED workflow state — never document content):
//   { verdict, hasStickyMatch, unmatchableReason, paymentStatus,
//     hasAnyMatch, hasEvaluation, snapshotId }
// returns: { goalReport, action, desiredCase }
export const evaluateReconciliationGoal = (input = {}) => {
  const {
    verdict = null,
    hasStickyMatch = false,
    unmatchableReason = null,
    paymentStatus = null,
    hasAnyMatch = false,
    hasEvaluation = verdict != null,
    // The caller confirmed a SETTLED bank line already covers this document's
    // amount (computed upstream; the pure evaluator never queries the books).
    coveredBySettledLine = false,
    snapshotId = null
  } = input;

  // INV-4 first: a confirmed/auto_matched match settles the target regardless of
  // any verdict. Resolve any open gap; goal met.
  if (hasStickyMatch) {
    return finish('met', 'resolve_gap', null, snapshotId, [
      { key: 'matched_or_explained', status: 'met', evidenceRefs: ['sticky_match'] }
    ]);
  }

  // A FULLY-SETTLED obligation is DONE, not a gap. The strong matcher returns a
  // no_match verdict with unmatchable_reason 'already_settled' precisely when the
  // document is already accounted for by OTHER bank lines (so it declines to propose
  // a duplicate). Projecting that as a firm "no matching bank line" gap is a false
  // positive that clutters the close feed ("No matching bank line found
  // (already_settled)"). Treat it as met + resolve_gap so it never OPENS a gap — and
  // CLOSES any already open. We trust the strong matcher's settled verdict here; we do
  // not re-judge the match. Checked ahead of the verdict switch because the reason
  // rides a no_match verdict.
  if (unmatchableReason === 'already_settled') {
    return finish('met', 'resolve_gap', null, snapshotId, [
      { key: 'matched_or_explained', status: 'met', evidenceRefs: ['already_settled_verdict'] }
    ]);
  }

  switch (verdict) {
    case 'auto_explained':
      // Immaterial recurring noise the strong model explained away (7.2). No
      // case — but a correctable "auto-explained, review optional" feed chip.
      // EXPLICIT here, not suppressed by absence from a filter list.
      return finish('met', 'noop', null, snapshotId, [
        { key: 'matched_or_explained', status: 'met', evidenceRefs: ['auto_explained_verdict'] }
      ]);

    case 'no_match':
      // A bare bank-line DISPOSITION the strong model could not settle is an
      // OWNER question, not firm matching work — open a CLIENT-owned gap so it
      // rests at waiting_client (on the owner), never the waiting_firm limbo the
      // two-terminal principle forbids. blockerType stays 'unclear_match' so the
      // existing close hook (resolveReconciliationGapCaseOnMatch) still lifts it
      // when a match later settles the line; only the OWNER flips firm→client.
      if (DISPOSITION_OWNER_ASK_REASONS.has(unmatchableReason)) {
        return finish('unmet', 'open_gap', {
          caseType: 'reconciliation', blockerType: 'unclear_match',
          ownerType: 'client', gapKind: 'unmatched_verdict'
        }, snapshotId, [
          { key: 'matched_or_explained', status: 'unmet',
            evidenceRefs: ['no_match_verdict', `disposition:${unmatchableReason}`],
            nextCondition: unmatchableReason }
        ]);
      }
      // A document-anchored no_match whose amount is ALREADY accounted for by a
      // SETTLED bank line is corroborating a line the books already closed — NOT
      // firm work. The strong matcher SHOULD have said 'already_settled'; the
      // weighted matcher often misses an exact-amount line and returns
      // 'no_plausible_match' (the Failure-B class — CLAUDE.md). Honor the caller's
      // settled-line check exactly like 'already_settled': resolve any open gap,
      // never open the waiting_firm limbo the two-terminal principle forbids. (The
      // real fix is the strong matcher / Slice E; this stops the close feed filling
      // with receipts for lines that already reconciled.)
      if (coveredBySettledLine) {
        return finish('met', 'resolve_gap', null, snapshotId, [
          { key: 'matched_or_explained', status: 'met',
            evidenceRefs: ['no_match_verdict', 'covered_by_settled_line'] }
        ]);
      }
      // A document-anchored gap: the firm must reconcile it (unclear_match, waiting_firm).
      return finish('unmet', 'open_gap', {
        caseType: 'reconciliation', blockerType: 'unclear_match',
        ownerType: 'firm', gapKind: 'unmatched_verdict'
      }, snapshotId, [
        { key: 'matched_or_explained', status: 'unmet', evidenceRefs: ['no_match_verdict'],
          nextCondition: unmatchableReason || 'Match this line to a document, or confirm there is none.' }
      ]);

    case 'no_candidates':
      // The forward hook excluded this as "transient — bank statement not
      // uploaded yet". That is not a vague timing exclusion; it is a TYPED
      // blocker — missing_bank_statement — owned by the firm to upload. Modeling
      // it explicitly removes the scan-A-vs-forward-hook divergence.
      return finish('unmet', 'open_gap', {
        caseType: 'reconciliation', blockerType: 'missing_bank_statement',
        ownerType: 'firm', gapKind: 'unmatched_verdict'
      }, snapshotId, [
        { key: 'matched_or_explained', status: 'unmet', evidenceRefs: ['no_candidates_verdict'],
          nextCondition: 'Upload the bank statement covering this period so the line can be matched.' }
      ]);

    case 'proposed':
      // A match was proposed but is not yet sticky — its own confirm/auto-match
      // lifecycle handles it; the loop opens no NEW gap. Goal pending.
      return finish('indeterminate', 'noop', null, snapshotId, [
        { key: 'matched_or_explained', status: 'indeterminate', evidenceRefs: ['proposed_match'],
          nextCondition: 'Awaiting confirmation of the proposed match.' }
      ]);

    default:
      // No verdict at all. An unpaid obligation that never reached the matcher
      // (no evaluation, no match) is still a gap the firm must resolve — the
      // unevaluated_obligation shape (scan B). Otherwise: nothing to do.
      if (!hasEvaluation && !hasAnyMatch && paymentStatus === 'unpaid') {
        return finish('unmet', 'open_gap', {
          caseType: 'reconciliation', blockerType: 'unclear_match',
          ownerType: 'firm', gapKind: 'unevaluated_obligation'
        }, snapshotId, [
          { key: 'matched_or_explained', status: 'unmet', evidenceRefs: ['unpaid_obligation'],
            nextCondition: 'Reconcile or settle this outstanding obligation.' }
        ]);
      }
      return finish('indeterminate', 'noop', null, snapshotId, [
        { key: 'matched_or_explained', status: 'indeterminate', evidenceRefs: [] }
      ]);
  }
};

const finish = (_expectedStatus, action, desiredCase, snapshotId, criterionResults) => {
  const goalReport = evaluateGoal(RECONCILIATION_GAP_GOAL, criterionResults, { snapshotId });
  return { goalReport, action, desiredCase };
};

// PR 1 — the "fresh judgment pending" projection. When an upstream coding case
// resolves (a client answer just cleared a blocking question on a bank line), the
// loop must NOT re-project the line's STALE no_match verdict as a fresh gap (that
// is the Trap-2 / "stale verdict" bug). Instead it stops truthfully as WAITING and
// asks for a fresh strong-model re-match. The verdict is therefore INDETERMINATE
// here — "we don't know yet; a re-match is pending" — which deriveStopReason maps to
// `waiting`, not `authority_required` (an unmet gap) and not `goal_met`. The actual
// re-match (the LLM) runs UPSTREAM in a separate consumer; this only projects the
// "pending" goal state + signals the request. Workflow-only, no model call.
export const reconciliationFreshEvaluationRequested = (snapshotId = null) => {
  const goalReport = evaluateGoal(RECONCILIATION_GAP_GOAL, [
    { key: 'matched_or_explained', status: 'indeterminate', evidenceRefs: ['fresh_evaluation_requested'],
      nextCondition: 'Awaiting a fresh strong-model re-match — a client answer just cleared a blocking question on this line.' }
  ], { snapshotId });
  return { goalReport, action: 'request_fresh_reconciliation_evaluation' };
};

// ---- the coding (ask-batch) goal evaluator -------------------------------

// Project the answered-count into the coding goal (§6.2 cascade downstream).
//   - no blocking questions tracked yet  -> indeterminate (nothing to assert)
//   - every blocking question answered   -> met   (the batch can be coded)
//   - some still outstanding             -> unmet (waiting on the client)
// The answered count rides the criterion evidenceRefs so a partial-answer wake is
// distinguishable; the engine's progress fingerprint keys off it (the caller passes
// the count into openBlockerTypes) so each new answer registers as real progress
// rather than a false no_progress stall. Pure: it judges nothing about the books.
export const evaluateCodingGoal = ({ totalBlocking = 0, answered = 0, snapshotId = null } = {}) => {
  const total = Math.max(0, Math.floor(Number(totalBlocking) || 0));
  const done = Math.max(0, Math.min(total, Math.floor(Number(answered) || 0)));

  if (total <= 0) {
    return finishCoding('noop', snapshotId, [
      { key: 'all_questions_answered', status: 'indeterminate', evidenceRefs: [] }
    ]);
  }
  if (done >= total) {
    return finishCoding('resolve_coding_case', snapshotId, [
      { key: 'all_questions_answered', status: 'met', evidenceRefs: [`answered_${done}_of_${total}`] }
    ]);
  }
  return finishCoding('noop', snapshotId, [
    { key: 'all_questions_answered', status: 'unmet', evidenceRefs: [`answered_${done}_of_${total}`],
      nextCondition: `${total - done} of ${total} client answers still outstanding.` }
  ]);
};

const finishCoding = (action, snapshotId, criterionResults) => {
  const goalReport = evaluateGoal(CODING_ASK_BATCH_GOAL, criterionResults, { snapshotId });
  return { goalReport, action };
};
