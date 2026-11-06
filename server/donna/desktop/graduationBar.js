// The local-model graduation bar (technical plan §7, v2.1) — the eval-lane
// layer that turns evalHarness metrics into per-capability qualification
// verdicts. This module ASSEMBLES onto the existing harness
// (server/donna/evalHarness.js: fixtures in, deterministic metrics blob
// out) — it is deliberately NOT a second eval runner.
//
// The bar is TWO-dimensional, both gates per capability, both gating:
//   Gate 1 — materially-wrong-commit rate at PARITY with the qualified
//     cloud baseline. A local model may graduate while weaker than
//     frontier, because two-terminal-states lets it degrade into questions
//     instead of errors — but it may not commit wrong MORE than the
//     baseline does.
//   Gate 2 — owner-question frequency within a STATED delta of the
//     baseline. Safety bought by interrogating the owner violates the
//     owner-interruption decider metric a different way.
//
// Fixture-world mapping (documented so nobody re-derives it): a FALSE
// POSITIVE is a proposal the human-verified fixture says is wrong — the
// would-commit-wrong proxy (gate 1). A FALSE NEGATIVE is an action the
// model failed to take where the fixture says one exists — under
// two-terminal-states that work degrades to an owner ask, so FN is the
// interruption proxy (gate 2). An ERRORED case commits nothing and falls
// to a retry/ask — it counts into gate 2, never gate 1.
//
// The numeric bar values are DATA, not law: the defaults below are the
// scaffold's placeholders, and the numbers that actually graduate a model
// are set by Kari's dated decision at graduation time (then carried by the
// signed model-policy feed). What IS law here: both gates, per capability,
// measured against a qualified cloud baseline on the same fixtures.

export const GRADUATION_CAPABILITIES = Object.freeze([
  'receipt_extraction',
  'document_classification',
  'reconciliation_matching',
  'transaction_coding',
  'owner_conversation',
  'tax_policy_interpretation',
  'report_narration'
]);

// Existing law, restated where the routing table can see it: ledger commit
// routes to the deterministic kernel. There is nothing to graduate — no
// model, local or frontier, ever owns it.
export const LEDGER_COMMIT_CAPABILITY = 'ledger_commit';

export const MODEL_STATES = Object.freeze(['bridge', 'hybrid', 'sovereign']);

export const DEFAULT_GRADUATION_BAR = Object.freeze({
  // Gate 1 parity epsilon (absolute rate): 0 = strictly at-or-below the
  // baseline's wrong-commit rate. Loosening this is a dated decision.
  gate1_parity_epsilon: 0,
  // Gate 2's STATED delta (absolute rate): how much more often than the
  // baseline the candidate may fall back to asking the owner.
  gate2_stated_delta: 0.1,
  // Below this many scored fixtures a verdict is evidence-starved, not a
  // pass or a fail.
  min_fixtures: 20
});

// evalHarness result blob → the two gate rates. Rates are per fixture
// (per processed item), not per proposal.
export const deriveGateMetrics = (evalResult) => {
  const totals = evalResult?.totals;
  if (!totals || !Number.isFinite(totals.fixtures)) {
    throw new Error('deriveGateMetrics needs an evalHarness result blob (missing totals.fixtures).');
  }
  const fixtures = totals.fixtures;
  if (fixtures === 0) {
    return { model: evalResult.model || null, suite: evalResult.suite || null, fixtures: 0, wrong_commit_rate: null, abstention_rate: null };
  }
  const errored = totals.errored || 0;
  return {
    model: evalResult.model || null,
    suite: evalResult.suite || null,
    ran_at: evalResult.ranAt || null,
    fixtures,
    wrong_commit_rate: (totals.false_positive || 0) / fixtures,
    abstention_rate: ((totals.false_negative || 0) + errored) / fixtures
  };
};

const round = (value) => (value == null ? null : Math.round(value * 10_000) / 10_000);

// The verdict: candidate vs baseline under the bar, for one capability.
// `candidate`/`baseline` are evalHarness result blobs from the SAME
// fixture suite (asserted via suite name — comparing across suites is a
// category error the caller should feel).
export const assessGraduation = ({ capability, candidate, baseline, bar = DEFAULT_GRADUATION_BAR } = {}) => {
  if (capability === LEDGER_COMMIT_CAPABILITY) {
    throw new Error('ledger_commit is deterministic-kernel-only; no model graduates into it.');
  }
  if (!GRADUATION_CAPABILITIES.includes(capability)) {
    throw new Error(`Unknown graduation capability: ${capability}`);
  }
  const cand = deriveGateMetrics(candidate);
  const base = deriveGateMetrics(baseline);
  if (cand.suite && base.suite && cand.suite !== base.suite) {
    throw new Error(`Candidate suite "${cand.suite}" and baseline suite "${base.suite}" differ — the bar compares runs on the SAME fixtures.`);
  }

  const scored = Math.min(cand.fixtures, base.fixtures);
  if (scored < bar.min_fixtures) {
    return {
      capability,
      candidate_model: cand.model,
      baseline_model: base.model,
      verdict: 'insufficient_evidence',
      reason: `${scored} fixtures < min_fixtures ${bar.min_fixtures}`,
      gate1: null,
      gate2: null
    };
  }

  const gate1Allowed = base.wrong_commit_rate + bar.gate1_parity_epsilon;
  const gate2Allowed = base.abstention_rate + bar.gate2_stated_delta;
  const gate1 = {
    pass: cand.wrong_commit_rate <= gate1Allowed,
    candidate_rate: round(cand.wrong_commit_rate),
    baseline_rate: round(base.wrong_commit_rate),
    allowed: round(gate1Allowed),
    // How far past the bar the candidate sits (0 when passing) — the
    // "distance-to-bar" number the parallel lane tracks per release.
    distance: round(Math.max(0, cand.wrong_commit_rate - gate1Allowed))
  };
  const gate2 = {
    pass: cand.abstention_rate <= gate2Allowed,
    candidate_rate: round(cand.abstention_rate),
    baseline_rate: round(base.abstention_rate),
    allowed: round(gate2Allowed),
    distance: round(Math.max(0, cand.abstention_rate - gate2Allowed))
  };

  return {
    capability,
    candidate_model: cand.model,
    baseline_model: base.model,
    suite: cand.suite || base.suite || null,
    fixtures: scored,
    gate1,
    gate2,
    verdict: gate1.pass && gate2.pass ? 'qualified' : 'not_qualified',
    bar: { ...bar }
  };
};
