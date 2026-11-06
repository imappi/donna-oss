// Reconciliation PR 5 — shared blocker enum for the rule learner.
//
// Single source of truth for the categorical learner-blocker tokens
// written by `server/donna/ruleLearner.js` into
// `audit_events.metadata.blockers` and surfaced to the FE through the
// proposal-row helpers. Lives on the FE side so the React bundle never
// imports server-side modules; the BE re-exports from this module so
// neither side inlines the raw strings.
//
// Frozen to prevent accidental mutation. New blocker tokens must be
// added to BOTH the enum here and the BE evaluator in lockstep.

export const LEARNER_BLOCKERS = Object.freeze({
  INSUFFICIENT_OBSERVATIONS: 'blocked_insufficient_observations',
  EXISTING_ACTIVE_RULE_DIFFERENT_ACCOUNT: 'blocked_active_rule_conflict',
  EXISTING_ACTIVE_RULE_SAME_ACCOUNT: 'blocked_active_rule_idempotent',
  CONFIDENCE_BELOW_FLOOR: 'blocked_confidence_below_floor',
  PATTERN_EMPTY: 'blocked_pattern_empty',
  EXPENSE_KIND_UNSAFE: 'blocked_expense_kind_unsafe',
  FIRM_DISABLED: 'blocked_firm_disabled',
  OBSERVATIONS_TOO_OLD: 'blocked_observations_too_old',
  ACCOUNT_CODE_MISSING: 'blocked_account_code_missing'
});
