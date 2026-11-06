// Donna Loops — the goal-regression / reopen decision (goal-first uplift,
// design §13.10). PURE leaf: it DECIDES, it never writes.
//
// See docs/loops-architecture-uplift-design.md §13.10 ("met once" is not "met
// forever") and §8 (the legacy-state bug class this guards against). The state
// machine we shipped through Phase 7 has no answer for a goal that was MET and
// is later INVALIDATED: a confirmed/sticky match gets rejected (INV-4 in
// reverse), a document correction changes totals, an externally-voided posting
// undoes the books, or a client retracts prior evidence. Without this leaf a
// terminal `case_status='resolved'` + `GoalReport(status='met')` is sticky
// forever — exactly the "stopping conflated with success / render the legacy
// terminal state over the live truth" failure §8 exists to kill.
//
// The §13.10 semantics this module encodes:
//   - a TERMINAL case can receive a regression event → it REOPENS (leaves its
//     terminal status; case_version bumps);
//   - a still-open case whose goal transiently went met → a NEW CASE VERSION
//     (the version bump alone invalidates any in-flight run, INV-16, and forces
//     a fresh evaluation);
//   - the prior `GoalReport(status='met')` stays IMMUTABLE — we only reference
//     its id; the *latest* status flips to unmet/indeterminate via a NEW report
//     (INV-17, supersede-never-mutate).
//
// CLAUDE.md "Keep"-layer discipline: this is system-correctness routing (which
// version/state transition a regression event implies), NOT an intelligence
// substitute. It does NOT judge the books — it does not decide whether the goal
// is now unmet; that verdict is a FRESH `evaluateGoal` pass (the strong-model
// judgment) on the reopened version, persisted as a new report a surface renders
// by reading. This module only bounds and orders the reopen around that verdict.
//
// What it does NOT do (waits for the engine, Steps 5/7): it persists nothing —
// no `loop_goal_reports` row, no `bookkeeping_case_events` regression pointer,
// no terminal-state read. The caller (the LoopRun engine) performs the writes
// from this decision. Pure: no I/O, no LLM, no DB.
//
// Imports only loopRun.js (`nextCaseVersion`) and loopGoal.js (vocabulary +
// `evaluateGoal`); loopRun itself imports only loopGoal, so this stays
// cycle-free for the worker to import, like the other goal leaves.

import { nextCaseVersion } from './loopRun.js';
import { GOAL_STATUSES, evaluateGoal } from './loopGoal.js';

export { nextCaseVersion };

// ---- vocabulary ----------------------------------------------------------

// The §13.10 causes that can un-meet a goal. A regression event MUST name one of
// these — an unknown kind is REFUSED (the repo's "we still refuse hallucinated
// keys" reflex; a silent pass here would let any event masquerade as a
// regression and reopen cases at will).
export const REGRESSION_KINDS = [
  'match_rejected',     // a confirmed/sticky reconciliation match was rejected (INV-4 reversed)
  'document_corrected', // a correction changed totals / the goal's target moved
  'posting_voided',     // an externally-voided ledger/Xero posting undid the result
  'evidence_retracted'  // the client retracted evidence the goal was met on
];

// Producer status (assessed 2026-06-21). match_rejected (onReconciliationMatchRejected)
// and document_corrected (onDocumentCorrected) are wired at real write sites. The other
// two are vocabulary-only — the pure gate below handles them, but NO producer enqueues
// them yet, and the kinds stay listed so the gate keeps refusing anything outside them:
//   - evidence_retracted: no write site for a client retracting prior evidence.
//   - posting_voided: BLOCKED — and not for lack of a write site alone. The only Xero
//     void (clearXeroMirrorForClientBestEffort) is a TEARDOWN path (client
//     reset/disconnect; cases are purged anyway), and the only live-book reversal
//     (postLedgerAdjustmentInDb) touches a ledger journal NO goal depends on — the
//     reconciliation goal is met by a sticky reconciliation_matches row, the coding goal
//     by answered questions, neither by a posting standing. A void can't un-meet a goal
//     today, so a producer would only churn resolved cases (reopen → re-eval still-met →
//     re-close). Unblocking needs an EXTERNAL Xero-void detector AND a posting-dependent
//     goal criterion. Full assessment + the rejected anchors:
//     docs/decision-2026-06-21-posting-voided-regression-blocked.md

// The three decisions this module emits. 'reopen' and 'new_case_version' both
// bump the case version; 'reopen' additionally implies leaving a TERMINAL status.
export const REGRESSION_DECISIONS = ['reopen', 'new_case_version', 'ignore'];

// The "met once" states — the only goal statuses there is something to regress
// FROM. A goal that is unmet/indeterminate/impossible was never achieved, so a
// regression event against it is a no-op (the live case already pursues it).
export const ACHIEVED_GOAL_STATUSES = ['met', 'waived'];

// Terminal case statuses. Mirrors caseManager.LOOP_TERMINAL_STATUSES plus
// `engineering_escalated` (classifyClosure treats an escalated case as terminal).
// Inlined rather than imported so this leaf stays free of caseManager's DB deps.
const TERMINAL_CASE_STATUSES = new Set([
  'resolved', 'superseded', 'unsupported', 'abandoned', 'engineering_escalated'
]);

const isAchieved = (status) => ACHIEVED_GOAL_STATUSES.includes(status);

// ---- regression event normalization --------------------------------------

// A regression event is `{ id, kind, occurredAt?, supersedesReportId?,
// objectiveChanged?, detail? }`. id + a known kind are required; everything else
// is optional metadata carried into the receipt. `objectiveChanged` is an
// optional hint from the (possibly model-assisted) producer that the correction
// moved the goal's TARGET (e.g. corrected totals), defaulting from the kind —
// it is receipt metadata for downstream spec re-resolution, NOT a reopen-vs-new
// discriminator (terminality is that, below).
const OBJECTIVE_CHANGING_KINDS = new Set(['document_corrected']);

export const validateRegressionEvent = (event) => {
  if (!event || typeof event !== 'object') {
    throw new Error('regression event must be an object');
  }
  if (!event.id) throw new Error('regression event needs an id');
  if (!REGRESSION_KINDS.includes(event.kind)) {
    throw new Error(`regression event kind "${event.kind}" is unknown — refused`);
  }
  return {
    id: String(event.id),
    kind: event.kind,
    occurredAt: event.occurredAt ?? null,
    supersedesReportId: event.supersedesReportId ?? null,
    objectiveChanged: typeof event.objectiveChanged === 'boolean'
      ? event.objectiveChanged
      : OBJECTIVE_CHANGING_KINDS.has(event.kind),
    detail: event.detail ?? null
  };
};

// Idempotency key so a re-delivered regression event reopens a case ONCE
// (design §13.4, same shape as loopGoal.buildLoopRunKey).
export const buildRegressionKey = ({ caseId, regressionEventId }) => {
  if (!caseId || !regressionEventId) {
    throw new Error('buildRegressionKey needs caseId + regressionEventId');
  }
  return `regress:${caseId}:${regressionEventId}`;
};

// ---- decideRegression: the gate ------------------------------------------

// THE decision. Given a case's terminal-ness, its CURRENT (latest) goal report,
// and a regression event, decide whether to reopen, mint a new case version, or
// ignore. Non-mutating: returns a decision + receipt; the engine performs the
// version bump, the status transition, and the superseding report write.
//
// Gate (an event is IGNORED unless there is a met goal to un-meet):
//   - no current report                         -> ignore 'no_current_report'
//   - current report not met/waived             -> ignore 'goal_not_achieved'
//   - event targets a report that is no longer
//     the latest (supersedesReportId mismatch)  -> ignore 'stale_event'
// Otherwise it ACTS:
//   - terminal case      -> 'reopen'           (reactivate; version++)
//   - still-open case     -> 'new_case_version' (invalidate in place; version++)
// Both reference the prior report by id (it stays immutable, INV-17) and declare
// `mints: 'superseding_goal_report'` — the fresh evaluation the engine records.
export const decideRegression = ({
  caseStatus = null,
  terminal,
  currentGoalReport = null,
  regressionEvent,
  caseVersion,
  asOf = null
} = {}) => {
  const event = validateRegressionEvent(regressionEvent);
  const regressionKey = buildRegressionKey({
    caseId: regressionEvent.caseId ?? regressionEvent.case_id ?? 'unknown',
    regressionEventId: event.id
  });

  // Terminality: an explicit boolean wins; otherwise derive from caseStatus.
  // One of the two must be supplied — a regression decision hinges on it.
  let isTerminal;
  if (typeof terminal === 'boolean') {
    isTerminal = terminal;
  } else if (caseStatus != null) {
    isTerminal = TERMINAL_CASE_STATUSES.has(caseStatus);
  } else {
    throw new Error('decideRegression needs `terminal` (boolean) or `caseStatus`');
  }

  const currentReportId = currentGoalReport?.id ?? null;
  const ignore = (reason) => ({
    decision: 'ignore',
    reason,
    kind: event.kind,
    fromTerminal: isTerminal,
    currentReportId,
    supersededReportId: null,
    nextCaseVersion: null,
    mints: null,
    regressionKey,
    decidedAt: asOf
  });

  if (!currentGoalReport) return ignore('no_current_report');

  // Validate the current report's status loudly (it should come from our own
  // evaluateGoal, but refuse a corrupt/hallucinated status rather than mis-gate).
  if (!GOAL_STATUSES.includes(currentGoalReport.status)) {
    throw new Error(`currentGoalReport.status "${currentGoalReport.status}" is invalid`);
  }
  if (!isAchieved(currentGoalReport.status)) return ignore('goal_not_achieved');

  // Idempotency / staleness: if the event names the report it expected to
  // supersede and that is not the latest, a newer report already moved past it.
  if (event.supersedesReportId != null && currentReportId != null &&
      event.supersedesReportId !== currentReportId) {
    return ignore('stale_event');
  }

  const decision = isTerminal ? 'reopen' : 'new_case_version';
  return {
    decision,
    reason: isTerminal ? 'terminal_case_regressed' : 'open_case_regressed',
    kind: event.kind,
    objectiveChanged: event.objectiveChanged, // downstream spec re-resolution hint
    fromTerminal: isTerminal,
    currentReportId,
    supersededReportId: currentReportId,      // the prior met report — kept immutable
    nextCaseVersion: nextCaseVersion(caseVersion), // validates a positive-int version
    mints: 'superseding_goal_report',
    regressionKey,
    decidedAt: asOf
  };
};

// ---- mintSupersedingReport: the fresh evaluation -------------------------

// Build the superseding GoalReport content for a reopened/bumped case version.
// This is where `evaluateGoal` (the goal runtime) gets reused: the new report is
// a FRESH evaluation against the post-regression criterion results, stamped with
// a `supersedes` pointer to the prior report's id. The prior report is NEVER
// mutated (INV-17) — we only reference it. Pure: it builds the report object;
// the engine persists it (append-only) downstream.
//
// `regressed` reports whether the fresh status actually left the achieved set.
// If a "regression" event re-evaluates back to met/waived (the underlying state
// recovered, or the event did not in fact invalidate the goal), `regressed` is
// false and the engine can record the met report as a normal new receipt rather
// than treating it as a true reopen — "met once is not met forever" cuts both
// ways, and we never FORCE an unmet verdict the criteria do not support.
export const mintSupersedingReport = ({
  goalSpec,
  criterionResults = [],
  supersededReportId = null,
  snapshotId = null,
  evaluatorVersion = null,
  waived = false
} = {}) => {
  const report = evaluateGoal(goalSpec, criterionResults, {
    snapshotId,
    evaluatorVersion,
    waived
  });
  return {
    report: { ...report, supersedes: supersededReportId ?? null },
    regressed: !isAchieved(report.status)
  };
};
