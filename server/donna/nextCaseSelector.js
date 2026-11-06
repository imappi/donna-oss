// Donna Loops — the NextCaseSelector (goal-first uplift, design §6.3 / §13.9).
//
// See docs/loops-architecture-uplift-design.md. The goal runtime (loopGoal.js)
// specifies what happens INSIDE a case; this leaf specifies how Donna chooses
// work ACROSS cases. It is a deterministic ranker so the ordering is auditable
// and REPLAYABLE — not an LLM picking its own work queue (design §6.3, open
// question #3: "never an LLM choosing its own work queue"; CLAUDE.md's
// trust-the-strong-LLM principle puts the strong model on the load-bearing
// EXTRACTION/JUDGMENT calls, not on deciding which case to wake next — that
// stays a transparent, replayable function of persisted signals).
//
// Two hard contracts (design §13.9):
//   1. NON-MUTATING. selectNextCases reads candidate signals and returns a
//      ranked list + an explanation receipt. It acquires NO leases and mutates
//      NO cases. Claiming / single-flight (INV-16) is a SEPARATE step, so
//      *selecting* work and *claiming* it never tangle.
//   2. REPLAYABLE. The selection is a pure function of (candidates, asOf,
//      weights, horizons). `asOf` is REQUIRED and injected — there is no hidden
//      Date.now(), no randomness — so re-running the selector over the same
//      inputs yields byte-identical output. The version + weights + horizons
//      ride along in the receipt so a stored ranking can be reproduced.
//
// Dependency-free on purpose (no imports at all): like loopGoal.js this stays a
// pure leaf so any reader (a scheduler, a queue panel, the LoopRun engine) can
// import it without widening an import cycle. The dependency-graph inputs
// (blockingImpact / dependencyDepth / blocksClose) are CALLER-SUPPLIED numbers
// derived upstream from the typed case-dependency graph (caseDependency.js /
// bookkeeping_case_dependencies) — the selector never reaches into the graph
// itself, which keeps it decoupled and trivially testable in-sandbox.
//
// The case-status / owner vocabulary below mirrors caseManager.js's exported
// constants; nextCaseSelector.test.js asserts that mirror stays in lock-step
// (the same schema↔runtime anti-drift discipline migrations.test.js uses).

// ---- version (the ranker's receipt) --------------------------------------

// A deterministic ranker still has a "model id": its weight/horizon contract.
// Bumping the ranking logic bumps this, and it is stamped into every receipt so
// a stored ranking is attributable to the exact selector that produced it (the
// "model id is the receipt" rail applied to a deterministic evaluator).
export const NEXT_CASE_SELECTOR_VERSION = 'next-case-selector-v1';

// ---- eligibility vocabulary (mirrors caseManager.js) ---------------------

// A case at a terminal status is done/stopped — never "next work". Mirror of
// caseManager.LOOP_TERMINAL_STATUSES (drift-guarded by the test).
export const SELECTOR_TERMINAL_STATUSES = ['resolved', 'superseded', 'unsupported', 'abandoned'];

// A goal already met or waived is achieved — not work to wake for. (A regression
// event re-opens the case with a fresh unmet report; design §13.10 — at which
// point goalStatus flips back and the case becomes eligible again.)
export const SELECTOR_GOAL_SATISFIED_STATUSES = ['met', 'waived'];

// Owners OUTSIDE the firm: a case waiting on one of these genuinely cannot be
// advanced by Donna or the firm until that party acts. Under actionableOnly
// (default) such a case is excluded UNLESS it is newlyActionable (the reply /
// document just landed → a dependency.resolved-class event). Internal owners
// (firm / accountant / engineer / system) stay rankable — a human can pick them.
export const WAITING_ON_OTHERS_OWNERS = ['client', 'external_connector'];

// ---- signal → [0,1] normalization tables ---------------------------------

// Risk maps to an actionability/urgency contribution. Numeric risk in [0,1] is
// accepted as-is (clamped); a null/unknown risk contributes nothing.
const RISK_SCORES = { low: 0.2, medium: 0.5, high: 0.85, critical: 1 };

// How autonomously actionable a case is by the authority its next action needs.
// A system-actionable case (Donna can act) outranks one parked on a human's
// authority. Reuses the contract's authority vocabulary (design §13.6). A
// missing requiredAuthority defaults to system-actionable (the common case for
// an open Donna case), documented so the default is never a silent surprise.
const AUTHORITY_ACTIONABILITY = {
  system: 1,
  firm_operator: 0.6,
  firm: 0.6,
  accountant: 0.3,
  admin: 0.15,
  engineer: 0.1
};

// The ten ranking factors named in design §6.3, each a weight on a normalized
// [0,1] component. Weights sum to 1 so a score is itself in [0,1] and directly
// interpretable. close-blocking impact leads (it is what makes the loop an
// operating system, not an inbox); estimatedCost is the lightest tie-breaker.
export const DEFAULT_SELECTOR_WEIGHTS = Object.freeze({
  closeBlocking: 0.22,
  dueUrgency: 0.18,
  materiality: 0.14,
  risk: 0.12,
  newlyActionable: 0.10,
  requiredAuthority: 0.08,
  clientSla: 0.06,
  dependencyDepth: 0.04,
  caseAge: 0.04,
  estimatedCost: 0.02
});

// Saturation / horizon constants. Kept explicit + overridable so a firm or a
// replay can pin a different horizon and still be reproducible.
export const DEFAULT_SELECTOR_HORIZONS = Object.freeze({
  dueDateDays: 30,          // a due date this many days out → no urgency; overdue → max
  slaDays: 7,               // client-SLA horizon
  ageSaturationDays: 30,    // case age at which the anti-starvation bump is ~half
  materialityCapMinor: 5_000_00, // $5,000 (in minor units) saturates materiality
  costCapMinor: 100,        // estimated-cost ceiling for the cheap-wins-first bump
  blockingImpactK: 3        // downstream-blocked count at which closeBlocking is ~half
});

const DAY_MS = 24 * 60 * 60 * 1000;

// ---- pure helpers --------------------------------------------------------

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

// x / (x + k): a saturating 0→1 curve (0 at 0, 0.5 at x=k, →1 as x grows).
const saturating = (x, k) => {
  const v = Number(x);
  if (!Number.isFinite(v) || v <= 0) return 0;
  return v / (v + k);
};

// Parse an epoch-ms number or an ISO/date string to epoch ms; null on absent or
// unparseable (a bad timestamp must not silently read as "now" — replayability).
const parseTime = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

// Urgency from a deadline relative to asOf, over a horizon: 0 at/after `horizon`
// days away, 1 at the deadline, clamped to 1 once overdue. No deadline → 0.
const deadlineUrgency = (deadlineMs, asOfMs, horizonDays) => {
  if (deadlineMs === null) return 0;
  const daysUntil = (deadlineMs - asOfMs) / DAY_MS;
  return clamp01((horizonDays - daysUntil) / horizonDays);
};

const riskScore = (risk) => {
  if (risk === null || risk === undefined) return 0;
  if (typeof risk === 'number') return clamp01(risk);
  return RISK_SCORES[String(risk).toLowerCase()] ?? 0;
};

const authorityScore = (authority) => {
  if (authority === null || authority === undefined) return 1; // assume system-actionable
  return AUTHORITY_ACTIONABILITY[String(authority).toLowerCase()] ?? 0.5;
};

const isTrue = (v) => v === true;

// ---- per-case scoring ----------------------------------------------------

// Compute the normalized [0,1] component scores for one candidate. Pure; reads
// only the candidate + the resolved asOf/horizons. Exported for unit tests so
// each factor can be asserted in isolation.
export const scoreCaseComponents = (candidate, { asOfMs, horizons }) => {
  const blockingImpact = Number(candidate.blockingImpact) || 0;
  const closeBase = saturating(blockingImpact, horizons.blockingImpactK);
  // Blocking the monthly close is the highest-leverage work — floor its
  // contribution high even when the raw downstream count is small.
  const closeBlocking = isTrue(candidate.blocksClose) ? Math.max(closeBase, 0.85) : closeBase;

  const dueUrgency = deadlineUrgency(parseTime(candidate.dueDate), asOfMs, horizons.dueDateDays);
  const clientSla = deadlineUrgency(parseTime(candidate.clientSlaDueAt), asOfMs, horizons.slaDays);

  const materialityMinor = Number(candidate.materialityMinor) || 0;
  const materiality = materialityMinor > 0
    ? clamp01(Math.log1p(materialityMinor) / Math.log1p(horizons.materialityCapMinor))
    : 0;

  const risk = riskScore(candidate.risk);
  const newlyActionable = isTrue(candidate.newlyActionable) ? 1 : 0;
  const requiredAuthority = authorityScore(candidate.requiredAuthority);

  // Depth 0 (a root case, nothing upstream still blocking it) is fully
  // actionable; deeper cases are gated behind unresolved blockers. Missing
  // depth defaults to root (the common case), documented.
  const depth = Number(candidate.dependencyDepth) || 0;
  const dependencyDepth = 1 / (1 + (depth > 0 ? depth : 0));

  // Anti-starvation: an old open case bubbles up so nothing waits forever.
  const openedMs = parseTime(candidate.openedAt);
  const caseAge = openedMs === null ? 0
    : saturating((asOfMs - openedMs) / DAY_MS, horizons.ageSaturationDays);

  // Cheap wins first: a low estimated cost gets a small bump. Unknown cost → 0
  // (no preference), so it never penalizes an un-estimated case.
  const costMinor = candidate.estimatedCostMinor;
  const estimatedCost = (costMinor === null || costMinor === undefined || !Number.isFinite(Number(costMinor)))
    ? 0
    : clamp01(1 - Number(costMinor) / horizons.costCapMinor);

  return {
    closeBlocking,
    dueUrgency,
    materiality,
    risk,
    newlyActionable,
    requiredAuthority,
    clientSla,
    dependencyDepth,
    caseAge,
    estimatedCost
  };
};

// Weighted sum of components → the final [0,1] score.
const weightedScore = (components, weights) => {
  let score = 0;
  for (const key of Object.keys(weights)) {
    score += (components[key] || 0) * weights[key];
  }
  return score;
};

// A short, deterministic, human-readable receipt for WHY a case ranks where it
// does: the top weighted contributors plus the load-bearing facts. This is what
// makes the ordering auditable (design §6.3 "an explanation receipt").
const explainCase = (candidate, components, weights, score) => {
  const reasons = [];
  if (isTrue(candidate.blocksClose)) reasons.push('blocks monthly close');
  const blockingImpact = Number(candidate.blockingImpact) || 0;
  if (blockingImpact > 0) reasons.push(`unblocks ${blockingImpact} downstream`);
  if (isTrue(candidate.newlyActionable)) reasons.push('newly actionable');

  // The two highest weighted contributions, named, for transparency.
  const contributions = Object.keys(weights)
    .map((key) => ({ key, value: (components[key] || 0) * weights[key] }))
    .filter((c) => c.value > 0)
    .sort((a, b) => (b.value - a.value) || (a.key < b.key ? -1 : 1))
    .slice(0, 2)
    .map((c) => c.key);
  if (contributions.length) reasons.push(`top: ${contributions.join(', ')}`);

  return `score ${score.toFixed(3)}${reasons.length ? ` — ${reasons.join('; ')}` : ''}`;
};

// ---- eligibility ---------------------------------------------------------

// Why a candidate is NOT selectable right now (null = eligible). Order matters:
// terminal/achieved are hard, the external-wait filter is opt-out.
const exclusionReason = (candidate, { actionableOnly }) => {
  if (SELECTOR_TERMINAL_STATUSES.includes(candidate.status)) return 'terminal';
  if (SELECTOR_GOAL_SATISFIED_STATUSES.includes(candidate.goalStatus)) return 'goal_satisfied';
  if (
    actionableOnly &&
    WAITING_ON_OTHERS_OWNERS.includes(candidate.ownerType) &&
    !isTrue(candidate.newlyActionable)
  ) {
    return 'waiting_external';
  }
  return null;
};

// ---- the selector --------------------------------------------------------

// Rank candidate cases. Pure + replayable: same inputs → same output.
//
//   cases           array of candidate signal objects (each needs a unique id)
//   asOf            REQUIRED epoch-ms or ISO string — the replay clock
//   weights         optional override merged over DEFAULT_SELECTOR_WEIGHTS
//   horizons        optional override merged over DEFAULT_SELECTOR_HORIZONS
//   actionableOnly  default true — drop cases waiting on an external party
//                   (still surfaced in `excluded` with a reason, for audit)
//
// Returns { version, asOf, weights, horizons, actionableOnly, candidateCount,
// eligibleCount, ranked, excluded }. `ranked` is sorted by score desc with a
// total, stable tiebreak on caseId asc (so a tie never depends on input order).
export const selectNextCases = ({
  cases = [],
  asOf,
  weights = {},
  horizons = {},
  actionableOnly = true
} = {}) => {
  if (!Array.isArray(cases)) throw new Error('selectNextCases: cases must be an array');
  const asOfMs = parseTime(asOf);
  if (asOfMs === null) {
    throw new Error('selectNextCases: asOf is required (epoch ms or ISO) — the selector is replayable, never Date.now()');
  }

  const mergedWeights = { ...DEFAULT_SELECTOR_WEIGHTS, ...weights };
  const mergedHorizons = { ...DEFAULT_SELECTOR_HORIZONS, ...horizons };

  const ranked = [];
  const excluded = [];
  const seen = new Set();

  for (const candidate of cases) {
    if (!candidate || candidate.id === null || candidate.id === undefined || candidate.id === '') {
      throw new Error('selectNextCases: every case needs a non-empty id');
    }
    const caseId = String(candidate.id);
    if (seen.has(caseId)) throw new Error(`selectNextCases: duplicate case id "${caseId}"`);
    seen.add(caseId);

    const reason = exclusionReason(candidate, { actionableOnly });
    if (reason) {
      excluded.push({ caseId, reason });
      continue;
    }

    const components = scoreCaseComponents(candidate, { asOfMs, horizons: mergedHorizons });
    const score = weightedScore(components, mergedWeights);
    ranked.push({
      caseId,
      score,
      components,
      explanation: explainCase(candidate, components, mergedWeights, score)
    });
  }

  // Score desc; total + stable tiebreak on caseId asc so the ordering never
  // depends on input order (replayability).
  ranked.sort((a, b) => (b.score - a.score) || (a.caseId < b.caseId ? -1 : a.caseId > b.caseId ? 1 : 0));
  ranked.forEach((entry, i) => { entry.rank = i + 1; });

  return {
    version: NEXT_CASE_SELECTOR_VERSION,
    asOf: asOfMs,
    weights: mergedWeights,
    horizons: mergedHorizons,
    actionableOnly,
    candidateCount: cases.length,
    eligibleCount: ranked.length,
    ranked,
    excluded
  };
};
