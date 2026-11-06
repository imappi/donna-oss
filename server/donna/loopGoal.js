// Donna Loops — the goal runtime (design proof for the goal-first uplift).
//
// See docs/loops-architecture-uplift-design.md. The Loops we shipped through
// Phase 7 are a thorough STATE MACHINE with no first-class GOAL: a case knows
// its status but not what it is trying to achieve or how we will know it is
// done. This leaf adds the missing object — the goal, its report, and the
// bounded-run accounting around it — as PURE functions so the concept can be
// proven (and scenario-tested) in-sandbox before any table/wiring lands.
//
// Dependency-free on purpose (only node builtins): a goal report is the
// generalization of a reconciliation_evaluations verdict, and like that verdict
// it must be a thing surfaces RENDER BY READING — never a render-time inference
// (INV-13 / "render the persisted verdict"). Keeping this module import-free
// from the rest of server/donna means a reader (firmDb snapshot, a case panel)
// can depend on it without widening an import cycle, exactly like
// bankLineDispositionShape.js.
//
// Nothing here calls an LLM. A model-assisted evaluator (does this reply answer
// the question?) produces the `criterionResults` this module rolls up; that call
// happens upstream, inside a bounded LoopRun, and persists its result. This
// module only PROJECTS already-decided criteria into a GoalReport — the same
// Keep-layer discipline as caseManager.rebuildCaseStatus.

import crypto from 'node:crypto';

// ---- vocabulary ----------------------------------------------------------

// A GoalReport's overall status, and the per-criterion status (same set).
export const GOAL_STATUSES = ['met', 'unmet', 'indeterminate', 'waived', 'impossible'];
export const CRITERION_STATUSES = GOAL_STATUSES;

// The three evaluator classes = CLAUDE.md's two-layer model made explicit:
//   deterministic    -> system-correctness scaffolding (KEEP: balances, doc
//                       exists, posted, sync ok, no hard blockers)
//   model_assisted   -> the strong-LLM judgment (semantic sufficiency, "same
//                       commercial event") — persisted, never re-judged at render
//   human_authorized -> the human correction surface ("the human word is terminal")
export const EVALUATOR_TYPES = ['deterministic', 'model_assisted', 'human_authorized'];

// Why a bounded LoopRun stopped (the inspiration's hard-stop set). Distinct
// from CLOSURE_REASONS below: a run stops every wake; a case closes once.
export const STOP_REASONS = [
  'goal_met', 'waiting', 'authority_required',
  'budget_exhausted', 'no_progress', 'failed', 'superseded'
];

// Why a CASE terminated — kept on its own axis so "stopped" is never read as
// "succeeded" (design §11 / feedback #9). Engineering escalation and budget
// exhaustion are valid safe terminations but NOT successful bookkeeping.
export const CLOSURE_REASONS = [
  'goal_met', 'goal_waived', 'unsupported', 'engineering_escalation',
  'superseded', 'abandoned', 'budget_exhausted', 'human_cancelled'
];

// The "was the intended outcome achieved?" axis — derived from the report,
// independent of case_status (where the workflow is) and closure_reason (why).
export const GOAL_OUTCOMES = ['achieved', 'not_achieved', 'pending', 'waived'];

const DEFAULT_MAX_NO_PROGRESS_RUNS = 2;

// ---- GoalSpec / criterion normalization ----------------------------------

// A criterion in a GoalSpec is either a bare key ('reply_received') or an
// object { key, required?, description? }. Required defaults to true — a goal
// is met only when every required criterion is satisfied.
const normalizeCriterion = (c) => {
  if (typeof c === 'string') return { key: c, required: true };
  if (!c || typeof c !== 'object' || !c.key) {
    throw new Error('GoalSpec criterion must be a key string or { key, ... }');
  }
  return { key: c.key, required: c.required !== false, description: c.description || null };
};

export const validateGoalSpec = (spec) => {
  if (!spec || typeof spec !== 'object') throw new Error('GoalSpec must be an object');
  if (!spec.key) throw new Error('GoalSpec.key is required');
  if (!spec.version) throw new Error('GoalSpec.version is required (goals are versioned — INV-14)');
  if (spec.evaluatorType && !EVALUATOR_TYPES.includes(spec.evaluatorType)) {
    throw new Error(`GoalSpec.evaluatorType invalid: ${spec.evaluatorType}`);
  }
  const criteria = Array.isArray(spec.criteria) ? spec.criteria.map(normalizeCriterion) : [];
  if (!criteria.length) throw new Error('GoalSpec must declare at least one criterion');
  return { ...spec, criteria };
};

// A criterion is "satisfied" for completion if it is met or explicitly waived.
const isSatisfied = (status) => status === 'met' || status === 'waived';

// ---- evaluateGoal: criteria -> GoalReport --------------------------------

// Roll a set of per-criterion results into a GoalReport. The lattice (highest
// precedence first):
//   - goal-level waiver           -> 'waived'   (a human waived the whole goal)
//   - any required 'impossible'   -> 'impossible'
//   - all required satisfied      -> 'met'
//   - any required 'unmet'        -> 'unmet'
//   - otherwise (some indeterminate, none unmet/impossible) -> 'indeterminate'
//
// A criterion result for a key NOT in the spec is REFUSED (hallucinated-key
// discipline — "we still refuse hallucinated keys"). A spec criterion with no
// result is treated as 'indeterminate' (not yet evaluated), never silently met.
export const evaluateGoal = (rawSpec, criterionResults = [], opts = {}) => {
  const spec = validateGoalSpec(rawSpec);
  const specKeys = new Set(spec.criteria.map((c) => c.key));

  const resultByKey = new Map();
  for (const r of criterionResults || []) {
    if (!r || !r.key) throw new Error('criterion result must have a key');
    if (!specKeys.has(r.key)) {
      throw new Error(`criterion result for unknown key "${r.key}" (not in GoalSpec ${spec.key}) — refused`);
    }
    const status = r.status || 'indeterminate';
    if (!CRITERION_STATUSES.includes(status)) {
      throw new Error(`criterion "${r.key}" has invalid status "${status}"`);
    }
    resultByKey.set(r.key, {
      key: r.key,
      status,
      evidenceRefs: Array.isArray(r.evidenceRefs) ? r.evidenceRefs : [],
      nextCondition: r.nextCondition || null
    });
  }

  const criteria = spec.criteria.map((c) => {
    const r = resultByKey.get(c.key);
    return r || { key: c.key, status: 'indeterminate', evidenceRefs: [], nextCondition: null };
  });

  const requiredKeys = new Set(spec.criteria.filter((c) => c.required).map((c) => c.key));
  const required = criteria.filter((c) => requiredKeys.has(c.key));

  let status;
  if (opts.waived === true) {
    status = 'waived';
  } else if (required.some((c) => c.status === 'impossible')) {
    status = 'impossible';
  } else if (required.every((c) => isSatisfied(c.status))) {
    status = 'met';
  } else if (required.some((c) => c.status === 'unmet')) {
    status = 'unmet';
  } else {
    status = 'indeterminate';
  }

  // nextUnmetConditions: a human-/operator-facing list of what is still missing,
  // for the "Done when" UI and the GoalReport receipt.
  const nextUnmetConditions = criteria
    .filter((c) => !isSatisfied(c.status))
    .map((c) => c.nextCondition || c.key);

  return {
    goalKey: spec.key,
    goalVersion: spec.version,
    status,
    criteria,
    evaluatorType: spec.evaluatorType || 'deterministic',
    evaluatorVersion: opts.evaluatorVersion || null, // the model id IS the receipt
    evaluatedFromSnapshotId: opts.snapshotId || null,
    nextUnmetConditions
  };
};

// ---- spec snapshot + idempotency keys (INV-17 / design §13.4-13.5) -------

// A content hash of the RESOLVED GoalSpec, persisted on the case at
// instantiation. Registry code may change under the same key/version; a
// historical run must replay against the spec CONTENT it actually used, not a
// label that may now resolve differently. The reproducible version vector
// therefore pins the spec hash, not just goalKey/version (design §13.5).
export const computeGoalSpecHash = (rawSpec) => {
  const spec = validateGoalSpec(rawSpec);
  const canonical = JSON.stringify({
    key: spec.key,
    version: spec.version,
    evaluatorType: spec.evaluatorType || 'deterministic',
    // criteria order is semantic (a list), so it is preserved, not sorted.
    criteria: spec.criteria.map((c) => ({ key: c.key, required: c.required }))
  });
  return crypto.createHash('sha256').update(canonical).digest('hex');
};

// Idempotency keys so a retried event never duplicates a receipt (design §13.4).
// A loop run is unique per (case, triggering event); a goal report is unique per
// run (or per the full vector when a run may emit several); a human correction
// is unique per (report, criterion, actor, correction event).
export const buildLoopRunKey = ({ caseId, triggerEventId }) => {
  if (!caseId || !triggerEventId) throw new Error('buildLoopRunKey needs caseId + triggerEventId');
  return `run:${caseId}:${triggerEventId}`;
};

export const buildGoalReportKey = ({
  loopRunId = null, caseId, snapshotId, goalKey, goalVersion,
  evaluatorVersion = null, progressFingerprint = null
}) => {
  if (loopRunId) return `report:${loopRunId}`;
  if (!caseId || !snapshotId || !goalKey || !goalVersion) {
    throw new Error('buildGoalReportKey needs loopRunId, or (caseId, snapshotId, goalKey, goalVersion)');
  }
  return [
    'report', caseId, snapshotId, goalKey, goalVersion,
    evaluatorVersion || '_', progressFingerprint || '_'
  ].join(':');
};

export const buildCriterionCorrectionKey = ({ goalReportId, criterionKey, actorId, correctionEventId }) => {
  if (!goalReportId || !criterionKey || !actorId || !correctionEventId) {
    throw new Error('buildCriterionCorrectionKey needs goalReportId, criterionKey, actorId, correctionEventId');
  }
  return `correction:${goalReportId}:${criterionKey}:${actorId}:${correctionEventId}`;
};

// ---- progress / no-progress contract (INV-15 support) --------------------

// A stable fingerprint of a case's progress state: criteria statuses + owner +
// open blockers + the live proposal id. Two materially identical wakes produce
// the same fingerprint, which is how we detect a loop spinning in place.
export const computeProgressFingerprint = ({
  goalStatus = null,
  criteria = [],
  ownerType = null,
  openBlockerTypes = [],
  proposalId = null
} = {}) => {
  const canonical = JSON.stringify({
    goalStatus,
    criteria: [...criteria]
      .map((c) => `${c.key}:${c.status}`)
      .sort(),
    ownerType,
    openBlockerTypes: [...openBlockerTypes].sort(),
    proposalId: proposalId || null
  });
  return crypto.createHash('sha1').update(canonical).digest('hex');
};

// True when two consecutive wakes produced the same fingerprint — i.e. an
// action was taken (or attempted) but the observable state did not move.
export const detectNoProgress = (before, after) =>
  Boolean(before) && Boolean(after) && before === after;

// INV-15: once a case has produced N consecutive no-progress runs it must STOP
// and escalate rather than wake itself again (repeated identical asks, unfixable
// parser retries, two-classification oscillation, endless connector retries).
export const shouldEscalateForNoProgress = (consecutiveNoProgressRuns, executionPolicy = {}) => {
  const max = Number.isFinite(executionPolicy.maxNoProgressRuns)
    ? executionPolicy.maxNoProgressRuns
    : DEFAULT_MAX_NO_PROGRESS_RUNS;
  return (consecutiveNoProgressRuns || 0) >= max;
};

// ---- stop reason + the three-axis closure --------------------------------

// Resolve the LoopRun's stop reason from the goal report + run signals.
// Precedence: a superseding/failed/explicit signal wins; then goal completion;
// then exhausted budgets; then no-progress; then a pending authority; else wait.
export const deriveStopReason = ({
  goalReport,
  budgetExhausted = false,
  noProgress = false,
  authorityRequired = false,
  failed = false,
  superseded = false
} = {}) => {
  if (superseded) return 'superseded';
  if (failed) return 'failed';
  const goalStatus = goalReport?.status;
  if (goalStatus === 'met' || goalStatus === 'waived') return 'goal_met';
  if (budgetExhausted) return 'budget_exhausted';
  if (noProgress) return 'no_progress';
  if (authorityRequired || goalStatus === 'unmet') return 'authority_required';
  return 'waiting';
};

const goalOutcomeFromStatus = (goalStatus) => {
  switch (goalStatus) {
    case 'met': return 'achieved';
    case 'waived': return 'waived';
    case 'impossible': return 'not_achieved';
    case 'unmet': return 'not_achieved';
    default: return 'pending'; // indeterminate / unknown
  }
};

// classifyClosure — the load-bearing "do not conflate stopping with success"
// projection (design §11). Returns THREE independent axes:
//   case_status    — where the workflow is now
//   goal_status    — whether the intended outcome was achieved
//   closure_reason — why it stopped (null while non-terminal)
// The canonical proof case: a no_progress stop is TERMINAL (case escalates to
// engineering) yet goal_status is 'not_achieved' — stopped, not succeeded.
export const classifyClosure = ({ goalReport, stopReason } = {}) => {
  const goalStatus = goalOutcomeFromStatus(goalReport?.status);
  let caseStatus;
  let closureReason = null;
  let terminal = false;

  switch (stopReason) {
    case 'goal_met':
      caseStatus = 'resolved';
      closureReason = goalReport?.status === 'waived' ? 'goal_waived' : 'goal_met';
      terminal = true;
      break;
    case 'superseded':
      caseStatus = 'superseded';
      closureReason = 'superseded';
      terminal = true;
      break;
    case 'budget_exhausted':
      caseStatus = 'engineering_escalated';
      closureReason = 'budget_exhausted';
      terminal = true;
      break;
    case 'no_progress':
      caseStatus = 'engineering_escalated';
      closureReason = 'engineering_escalation';
      terminal = true;
      break;
    case 'failed':
      caseStatus = 'engineering_escalated';
      closureReason = 'engineering_escalation';
      terminal = true;
      break;
    case 'authority_required':
      // A human must act; the case waits, it does not close. The specific owner
      // (firm vs accountant) comes from the LoopDefinition's escalationPolicy;
      // 'waiting_firm' is the neutral default for the proof.
      caseStatus = 'waiting_firm';
      break;
    case 'waiting':
    default:
      caseStatus = 'waiting_system';
      break;
  }

  return { case_status: caseStatus, goal_status: goalStatus, closure_reason: closureReason, terminal };
};
