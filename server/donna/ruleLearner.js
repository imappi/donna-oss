// Reconciliation PR 5 — the rule learner's POLICY layer: the pure evaluator
// that decides whether an aggregated observation set may become a proposed
// `client_rules` row, and the per-firm config it evaluates against.
//
// RT-14 (2026-09-02, audit F-15 / plan §5 item 3) DELETED the cron path
// that used to live here — `learnClientRulesForFirm`, the audit-row
// aggregation over `reconciliation_match.update` /
// `reconciliation.auto_explained`, the proposed-row writer, the
// `RECEIPT_RULE_LEARNING_ENABLED` global kill switch and the nightly
// `learn-reconciliation-rules` Inngest function. The chain was env-dark on
// every host (never in the desktop env map, never plane-seeded, never set in
// the cloud) and under the trust-the-strong-LLM principle it was
// intelligence-substituting scaffolding: a hand-written aggregator minting
// rules from a retired classifier's `expense_kind`. What remains is the
// deterministic policy — `evaluateLearnedRuleCandidate` and
// `resolveRuleLearningConfig` — and the blocker vocabulary the FE proposal
// surface (src/lib/ruleLearnerBlockers.js) still renders for the rows that
// were proposed while the learner ran.
//
// Two anchor invariants, still true of the evaluator:
//   1. "The learner proposes; the firm decides." A verdict here is a
//      proposal shape, never an active rule; active transitions come from
//      the firm-facing endpoint (updateClientRuleStatusInDb).
//   2. "Learn from FIRM-CONFIRMED outcomes only." Auto-explained matches
//      count only after they age past the undo window.
//
// PII policy mirrors PR 3: the canonical_pattern (normalized form) is the
// only merchant text a proposal carries; raw vendor names, descriptions and
// references never appear in a proposal payload or its notes.

import { LEARNER_BLOCKERS } from '../../src/lib/ruleLearnerBlockers.js';
export { LEARNER_BLOCKERS };


// Policy version — stamped onto every audit row. A future PR 5.x bump
// invalidates prior learning decisions for noise-analysis purposes.
export const RULE_LEARNER_POLICY_VERSION = 'rule_learner_v1';

// Defaults. Override per-firm via `firms.metadata.rule_learning`.
export const LEARNER_DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  min_observations: 3,
  window_days: 90,
  confidence_floor: 0.8
});

// Q3 — auto-explained matches contribute to the count only after this
// many days without an undo / reject. Aligned with the brief: short
// enough that learning isn't crippled, long enough that human
// attention catches mis-codes.
export const AUTO_EXPLAINED_UNDO_AGING_DAYS = 7;

// Q5 cautious-list — never propose rules for tax-treatment-sensitive
// kinds. Mirrors PR 3's CAUTIOUS_EXPENSE_KINDS inline; kept here so a
// future PR 3 bump can't silently widen the PR 5 set.
const CAUTIOUS_EXPENSE_KINDS = new Set([
  'restaurant_cafe',
  'hotel_travel',
  'fuel',
  'bank_fee',
  'groceries'
]);

// Pure firm-config resolver. Reads `firm.metadata.rule_learning` and
// merges over defaults. Defaults `enabled` to false so new firms start
// disabled even when the global kill switch is on.
export const resolveRuleLearningConfig = (firm = {}) => {
  const meta = (firm && typeof firm === 'object' && firm.metadata && typeof firm.metadata === 'object')
    ? firm.metadata
    : {};
  const raw = (meta.rule_learning && typeof meta.rule_learning === 'object')
    ? meta.rule_learning
    : {};
  const minObs = Number(raw.min_observations);
  const windowDays = Number(raw.window_days);
  const floor = Number(raw.confidence_floor);
  return {
    enabled: raw.enabled === true,
    min_observations: Number.isFinite(minObs) && minObs > 0
      ? Math.floor(minObs)
      : LEARNER_DEFAULT_CONFIG.min_observations,
    window_days: Number.isFinite(windowDays) && windowDays > 0
      ? Math.floor(windowDays)
      : LEARNER_DEFAULT_CONFIG.window_days,
    confidence_floor: Number.isFinite(floor) && floor >= 0 && floor <= 1
      ? floor
      : LEARNER_DEFAULT_CONFIG.confidence_floor
  };
};

// Pure evaluator. NEVER reads from the DB. Receives the aggregated
// candidate + config. Returns the verdict + a categorical blocker
// list. Evaluates EVERY blocker — no short-circuit — so the audit log
// carries the full diagnostic list. Mirrors PR 3's gate shape.
export const evaluateLearnedRuleCandidate = ({
  candidate,
  config = LEARNER_DEFAULT_CONFIG
} = {}) => {
  const blockers = [];

  const c = candidate || {};
  const totalObservations = Number(c.confirmed_observations || 0) + Number(c.aged_auto_explained || 0);

  if (config.enabled !== true) {
    blockers.push(LEARNER_BLOCKERS.FIRM_DISABLED);
  }

  if (!c.canonical_pattern) {
    blockers.push(LEARNER_BLOCKERS.PATTERN_EMPTY);
  }

  if (!c.account_code) {
    blockers.push(LEARNER_BLOCKERS.ACCOUNT_CODE_MISSING);
  }

  // EXPENSE_KIND_UNSAFE covers three cases:
  //   1. The dominant kind is on the cautious list (Q5).
  //   2. The pattern has competing (kind, account) tuples across
  //      observations — i.e. the firm has coded the same vendor to
  //      multiple categories, so the signal is ambiguous (Test 4).
  //   3. The kind is the literal token 'unknown'.
  if (!c.expense_kind || c.expense_kind === 'unknown') {
    blockers.push(LEARNER_BLOCKERS.EXPENSE_KIND_UNSAFE);
  } else if (CAUTIOUS_EXPENSE_KINDS.has(c.expense_kind)) {
    blockers.push(LEARNER_BLOCKERS.EXPENSE_KIND_UNSAFE);
  } else if (c.pattern_has_competing_signal === true) {
    blockers.push(LEARNER_BLOCKERS.EXPENSE_KIND_UNSAFE);
  }

  const minObs = Number(config.min_observations) || LEARNER_DEFAULT_CONFIG.min_observations;
  if (totalObservations < minObs) {
    blockers.push(LEARNER_BLOCKERS.INSUFFICIENT_OBSERVATIONS);
  }

  // OBSERVATIONS_TOO_OLD — all observations are pre-window. Test 24.
  // Encoded as: aggregator could not find ANY in-window observation
  // (signaled by `in_window_observations === 0`). Distinct from
  // INSUFFICIENT_OBSERVATIONS so the audit log can tell the firm
  // "we considered this pattern but every signal predates your
  // configured window."
  if (Number(c.in_window_observations || 0) === 0) {
    blockers.push(LEARNER_BLOCKERS.OBSERVATIONS_TOO_OLD);
  }

  const floor = Number(config.confidence_floor);
  const avgConfidence = Number(c.confidence_avg);
  if (
    Number.isFinite(floor) &&
    (
      !Number.isFinite(avgConfidence) ||
      avgConfidence < floor
    )
  ) {
    blockers.push(LEARNER_BLOCKERS.CONFIDENCE_BELOW_FLOOR);
  }

  if (c.existing_active_rule && typeof c.existing_active_rule === 'object') {
    if (String(c.existing_active_rule.account_code || '') === String(c.account_code || '')) {
      blockers.push(LEARNER_BLOCKERS.EXISTING_ACTIVE_RULE_SAME_ACCOUNT);
    } else {
      blockers.push(LEARNER_BLOCKERS.EXISTING_ACTIVE_RULE_DIFFERENT_ACCOUNT);
    }
  }

  const verdict = blockers.length === 0 ? 'propose' : 'skip';
  const proposedRule = verdict === 'propose'
    ? buildProposedRulePayload({ candidate: c, config })
    : null;

  return { verdict, blockers, proposed_rule: proposedRule };
};

const buildProposedRulePayload = ({ candidate, config }) => ({
  firm_id: candidate.firm_id,
  client_id: candidate.client_id,
  canonical_pattern: candidate.canonical_pattern,
  expense_kind: candidate.expense_kind,
  account_code: candidate.account_code,
  observation_count:
    Number(candidate.confirmed_observations || 0) +
    Number(candidate.aged_auto_explained || 0),
  observation_window_days: Number(config.window_days) || LEARNER_DEFAULT_CONFIG.window_days,
  last_observed_at: candidate.last_observed_at || null,
  confidence_avg: Number(candidate.confidence_avg) || null,
  source_match_ids: Array.isArray(candidate.source_match_ids)
    ? candidate.source_match_ids.slice(0, 20)
    : []
});

// === Aggregator ====================================================
//
// Walks the (firm, client) audit window and builds a list of
// candidates. Each candidate is (pattern, kind, account)-keyed; a
// pattern with competing (kind, account) tuples emits one candidate
// per tuple, all flagged with `pattern_has_competing_signal: true`
// so the evaluator surfaces EXPENSE_KIND_UNSAFE.
