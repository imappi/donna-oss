// Donna Loops — the LoopRun engine's PURE pieces (goal-first uplift, design §5/§6.3).
//
// See docs/loops-architecture-uplift-design.md §5 (the progress/no-progress
// contract), §6.3 (the two runtime controls), and INV-15/16. A LoopRun is one
// bounded, budgeted, event-triggered wake of a case: read snapshot → take/propose
// ONE bounded action → re-evaluate the goal → persist → stop. loopGoal.js already
// owns the goal-side primitives (computeProgressFingerprint / detectNoProgress /
// shouldEscalateForNoProgress / deriveStopReason / the idempotency key builders).
// This leaf adds the RUN-side controls that were still missing, as pure functions
// so they can be proven in-sandbox before the engine wiring (Step 5) lands:
//
//   1. Single-flight lease (INV-16) — only one run may reason over a given CASE
//      VERSION at a time; a second event coalesces instead of racing.
//   2. Event coalescing / dirty-marking — an upload batch of 30 parse_completed
//      events evaluates ONCE, not 30×; events arriving mid-run mark the case
//      dirty and trigger exactly one re-evaluation after the run settles.
//   3. Budget accounting (INV-15) — every wake is bounded by the LoopDefinition's
//      executionPolicy; this computes what's left and whether a budget is spent.
//
// These are CLAUDE.md "Keep"-layer scaffolding: budgets, single-flight, and
// idempotency are system-correctness invariants, NOT intelligence-substituting
// rules. They do not second-guess a model judgment — they bound and de-duplicate
// the wake around it. Nothing here calls an LLM or touches a DB; the engine
// (Step 5) reads these decisions and does the I/O.
//
// Imports ONLY loopGoal.js (a dependency-free leaf), so it stays cycle-free for
// the worker to import without widening an import cycle.

import {
  STOP_REASONS,
  detectNoProgress,
  shouldEscalateForNoProgress,
  deriveStopReason
} from './loopGoal.js';

export { STOP_REASONS };

// ---- executionPolicy (§5/§6.1) -------------------------------------------

// The per-wake budget from the LoopDefinition. These defaults mirror the design's
// canonical evidence-resolution policy (§6.1); a LoopDefinition overrides any field.
export const DEFAULT_EXECUTION_POLICY = Object.freeze({
  maxModelCallsPerWake: 1,
  maxToolCallsPerWake: 3,
  maxElapsedMs: 30_000,
  maxRetries: 2,
  maxNoProgressRuns: 2
});

const nonNegInt = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
};

// Merge an arbitrary policy over the defaults, coercing every cap to a
// non-negative integer. A missing/garbage field falls back to its default rather
// than disabling the budget (an absent cap must never read as "unbounded").
export const normalizeExecutionPolicy = (policy = {}) => {
  const p = policy || {};
  return Object.freeze({
    maxModelCallsPerWake: nonNegInt(p.maxModelCallsPerWake, DEFAULT_EXECUTION_POLICY.maxModelCallsPerWake),
    maxToolCallsPerWake: nonNegInt(p.maxToolCallsPerWake, DEFAULT_EXECUTION_POLICY.maxToolCallsPerWake),
    maxElapsedMs: nonNegInt(p.maxElapsedMs, DEFAULT_EXECUTION_POLICY.maxElapsedMs),
    maxRetries: nonNegInt(p.maxRetries, DEFAULT_EXECUTION_POLICY.maxRetries),
    maxNoProgressRuns: nonNegInt(p.maxNoProgressRuns, DEFAULT_EXECUTION_POLICY.maxNoProgressRuns)
  });
};

// ---- single-flight lease (INV-16) ----------------------------------------

// A case version must be a positive integer (bookkeeping_cases.case_version starts
// at 1, migration 037). Reject anything else loudly — a bad version silently
// passing the CAS check is exactly how single-flight breaks.
const assertCaseVersion = (v, label) => {
  if (!Number.isInteger(v) || v < 1) {
    throw new Error(`${label} must be a positive integer (got ${v})`);
  }
  return v;
};

// A lease is "held" unless it is explicitly released/expired, or its TTL has
// passed relative to asOf (a crashed run must not block a case forever). asOf and
// expiresAt are epoch ms; both optional — without them a non-released lease holds.
const leaseIsHeld = (lease, asOfMs) => {
  if (!lease) return false;
  if (lease.status === 'released' || lease.status === 'expired') return false;
  if (
    lease.expiresAt !== null && lease.expiresAt !== undefined &&
    asOfMs !== null && asOfMs !== undefined &&
    Number(asOfMs) > Number(lease.expiresAt)
  ) return false;
  return true;
};

// Decide whether an incoming event may ACQUIRE a run lease or must COALESCE.
// INV-16: only one run may reason over a given case version at a time. If a lease
// is held → coalesce (the caller marks the case dirty; see noteTriggerEvent). If
// no lease is held (or the prior one expired) → acquire at the current case
// version. A non-mutating decision — the caller performs the actual lease write.
export const decideLease = ({ activeLease = null, caseVersion, asOf = null } = {}) => {
  assertCaseVersion(caseVersion, 'decideLease: caseVersion');
  const asOfMs = asOf === null || asOf === undefined ? null
    : (typeof asOf === 'number' ? asOf : Date.parse(asOf));

  if (leaseIsHeld(activeLease, asOfMs)) {
    return { decision: 'coalesce', reason: 'single_flight_active' };
  }
  const stolenFrom = activeLease && (activeLease.status !== 'released')
    ? (activeLease.runId || null) : null;
  return {
    decision: 'acquire',
    reason: stolenFrom ? 'lease_expired' : 'no_active_lease',
    leaseCaseVersion: caseVersion,
    ...(stolenFrom ? { stolenFrom } : {})
  };
};

// Optimistic-concurrency commit gate. A run may persist its verdict only if the
// case version has NOT advanced since it leased — otherwise the case mutated
// under the run and the run is stale (its output describes an old state). A
// stale run must not commit a competing verdict; it stops 'superseded' and the
// dirty flag triggers a fresh re-evaluation.
export const canCommitRun = ({ leaseCaseVersion, currentCaseVersion } = {}) => {
  assertCaseVersion(leaseCaseVersion, 'canCommitRun: leaseCaseVersion');
  assertCaseVersion(currentCaseVersion, 'canCommitRun: currentCaseVersion');
  return currentCaseVersion === leaseCaseVersion;
};

// The case version a committing mutation advances to (the CAS new-value).
export const nextCaseVersion = (currentCaseVersion) =>
  assertCaseVersion(currentCaseVersion, 'nextCaseVersion: currentCaseVersion') + 1;

// ---- event coalescing / dirty-marking (§6.3) ------------------------------

const eventTuple = (e) => (typeof e === 'object' && e !== null)
  ? { id: String(e.id), sequence: Number.isFinite(Number(e.sequence)) ? Number(e.sequence) : null,
      createdAt: e.createdAt ?? null }
  : { id: String(e), sequence: null, createdAt: null };

// Collapse a batch of trigger events for ONE case into a single representative.
// An upload of 30 document.parse_completed events must evaluate once, not 30×.
// Dedups by id and picks a DETERMINISTIC representative (earliest by sequence,
// then createdAt, then id) so a re-delivered batch keys the SAME loop run via
// buildLoopRunKey(caseId, representativeEventId) — idempotency (§13.4). The
// ordering is independent of input array order (replayability).
export const coalesceTriggerEvents = (events = []) => {
  if (!Array.isArray(events)) throw new Error('coalesceTriggerEvents: events must be an array');
  const byId = new Map();
  for (const raw of events) {
    const t = eventTuple(raw);
    if (!t.id || t.id === 'undefined' || t.id === 'null') {
      throw new Error('coalesceTriggerEvents: every event needs an id');
    }
    if (!byId.has(t.id)) byId.set(t.id, t);
  }
  const tuples = [...byId.values()].sort((a, b) => {
    if (a.sequence !== null && b.sequence !== null && a.sequence !== b.sequence) return a.sequence - b.sequence;
    if (a.sequence !== null && b.sequence === null) return -1;
    if (a.sequence === null && b.sequence !== null) return 1;
    const ca = a.createdAt ? Date.parse(a.createdAt) : NaN;
    const cb = b.createdAt ? Date.parse(b.createdAt) : NaN;
    if (Number.isFinite(ca) && Number.isFinite(cb) && ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  const eventIds = tuples.map((t) => t.id);
  return {
    count: eventIds.length,
    eventIds,
    representativeEventId: eventIds[0] ?? null,
    coalesced: eventIds.length > 1
  };
};

// The dirty-marking state machine for a case's run lifecycle. Pure transitions
// returning NEW state (never mutating the input):
//   noteTriggerEvent — an event arrived. If a run is active → mark the case dirty
//     and remember the event (decision 'coalesce'). If idle → the caller should
//     start a run (decision 'acquire'); the state flips to active.
//   settleRun — the active run finished. If the case was marked dirty mid-run,
//     signal exactly ONE re-evaluation and hand back the coalesced event ids;
//     otherwise the case goes idle.
export const emptyCaseRunState = () => ({ active: false, dirty: false, pendingEventIds: [] });

export const noteTriggerEvent = (state = emptyCaseRunState(), eventId) => {
  if (!eventId) throw new Error('noteTriggerEvent: eventId is required');
  const id = String(eventId);
  if (state.active) {
    return {
      next: { ...state, dirty: true, pendingEventIds: [...state.pendingEventIds, id] },
      decision: 'coalesce'
    };
  }
  return {
    next: { active: true, dirty: false, pendingEventIds: [] },
    decision: 'acquire'
  };
};

export const settleRun = (state = emptyCaseRunState()) => {
  const reEvaluate = Boolean(state.dirty);
  return {
    next: emptyCaseRunState(),
    reEvaluate,
    coalescedEventIds: reEvaluate ? [...state.pendingEventIds] : []
  };
};

// ---- budget accounting (INV-15) ------------------------------------------

const BUDGET_DIMENSIONS = [
  ['modelCalls', 'maxModelCallsPerWake'],
  ['toolCalls', 'maxToolCallsPerWake'],
  ['elapsedMs', 'maxElapsedMs'],
  ['retries', 'maxRetries']
];

// Account a run's usage against its executionPolicy. A dimension is EXHAUSTED
// when usage has reached (>=) its cap. Returns the exhausted flag, the list of
// exceeded dimensions, and how much of each budget remains (clamped at 0). This
// is the INV-15 "every bounded run has an execution budget" check, made pure.
export const accountBudget = ({ policy, usage = {} } = {}) => {
  const p = normalizeExecutionPolicy(policy);
  const used = usage || {};
  const exceeded = [];
  const remaining = {};
  for (const [usageKey, capKey] of BUDGET_DIMENSIONS) {
    const u = Math.max(0, Number(used[usageKey]) || 0);
    const cap = p[capKey];
    remaining[usageKey] = Math.max(0, cap - u);
    // Exhausted means the run CONSUMED its allowance — usage reached a positive
    // cap, or overspent a zero cap. A zero-cap dimension with zero usage (a
    // workflow-only loop with maxModelCallsPerWake:0 that makes no model calls)
    // is NOT exhausted: it never needed the budget, and canSpend already blocks
    // the disallowed action up front. Without the `u > 0` guard, every
    // workflow-only wake would false-stop 'budget_exhausted' (0 >= 0).
    if (u >= cap && u > 0) exceeded.push(usageKey);
  }
  return { exhausted: exceeded.length > 0, exceeded, remaining };
};

// Pre-action gate: is there room to spend one more unit of `kind` before acting?
// kind ∈ { model_call, tool_call, retry } → usage + 1 must fit the cap; kind
// 'elapsed' → there is time left if elapsedMs is strictly under the cap. Returning
// false means the run must stop with stop_reason 'budget_exhausted' instead of
// taking the action — the autonomy circuit-breaker the inspiration warns about.
export const canSpend = ({ policy, usage = {}, kind } = {}) => {
  const p = normalizeExecutionPolicy(policy);
  const used = usage || {};
  switch (kind) {
    case 'model_call': return (Math.max(0, Number(used.modelCalls) || 0) + 1) <= p.maxModelCallsPerWake;
    case 'tool_call': return (Math.max(0, Number(used.toolCalls) || 0) + 1) <= p.maxToolCallsPerWake;
    case 'retry': return (Math.max(0, Number(used.retries) || 0) + 1) <= p.maxRetries;
    case 'elapsed': return (Math.max(0, Number(used.elapsedMs) || 0)) < p.maxElapsedMs;
    default: throw new Error(`canSpend: unknown kind "${kind}"`);
  }
};

// ---- compose: the run-level verdict --------------------------------------

// Assemble a LoopRun's terminal signals into the persisted stop reason, reusing
// loopGoal.js's primitives. This is the bridge the engine calls once a wake has
// produced its (already-decided) GoalReport: it folds budget exhaustion (INV-15),
// no-progress escalation (INV-15), and the optimistic-commit gate (INV-16, a
// stale run → 'superseded') into deriveStopReason. Pure — no I/O, no model call.
export const summarizeRun = ({
  goalReport = null,
  policy,
  usage = {},
  progressBefore = null,
  progressAfter = null,
  consecutiveNoProgressRuns = 0,
  authorityRequired = false,
  failed = false,
  canCommit = true
} = {}) => {
  const budget = accountBudget({ policy, usage });
  const noProgress = detectNoProgress(progressBefore, progressAfter);
  // A no-progress run increments the streak; escalate (and STOP) only once the
  // streak reaches the policy threshold — a single stalled wake just waits.
  const effectiveNoProgressRuns = noProgress ? (Number(consecutiveNoProgressRuns) || 0) + 1 : 0;
  const escalateNoProgress = noProgress &&
    shouldEscalateForNoProgress(effectiveNoProgressRuns, normalizeExecutionPolicy(policy));
  const superseded = canCommit === false;

  const stopReason = deriveStopReason({
    goalReport,
    budgetExhausted: budget.exhausted,
    noProgress: escalateNoProgress,
    authorityRequired,
    failed,
    superseded
  });

  return {
    stopReason,
    budget,
    noProgress,
    effectiveNoProgressRuns,
    escalateNoProgress,
    superseded
  };
};
