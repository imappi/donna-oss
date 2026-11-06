// Reconciliation PR 4 — shared blocker enum.
//
// Single source of truth for the categorical auto-explain blocker
// tokens written by `server/donna/receiptAutoExplain.js` (PR 3) onto
// `match.payload.auto_explain_blockers`. Lives on the FE side of the
// tree because PR 4's review UI renders these as human-readable hints;
// the BE re-exports from this module so neither side inlines the raw
// strings.
//
// Frozen to prevent accidental mutation. New blocker tokens must be
// added to BOTH the enum here and the BE evaluator in lockstep.

export const AUTO_EXPLAIN_BLOCKERS = Object.freeze({
  PR1_NOT_ELIGIBLE: 'blocked_pr1_not_eligible',
  CLASSIFIER_MISSING: 'blocked_classifier_missing',
  CLASSIFIER_STALE_VERSION: 'blocked_classifier_stale_version',
  CLASSIFIER_FALLBACK: 'blocked_classifier_fallback',
  EXPENSE_KIND_CAUTIOUS: 'blocked_expense_kind_cautious',
  EXPENSE_KIND_UNKNOWN: 'blocked_expense_kind_unknown',
  CONFIDENCE_BELOW_FLOOR: 'blocked_confidence_below_floor',
  EVIDENCE_INSUFFICIENT: 'blocked_evidence_insufficient',
  MATERIALITY_NOT_LOW: 'blocked_materiality_not_low',
  AMOUNT_ABOVE_LIMIT: 'blocked_amount_above_limit',
  PARSE_WARNING: 'blocked_parse_warning',
  CLASSIFIER_WARNING: 'blocked_classifier_warning',
  FIRM_DISABLED: 'blocked_firm_disabled',
  TRANSACTION_ALREADY_RESOLVED: 'blocked_transaction_already_resolved',
  MATCH_NOT_SUGGESTED: 'blocked_match_not_suggested',
  // Cross-entity guard (2026-08-04, §4b-xvi): the matcher stamped the match
  // as belonging to a DIFFERENT entity's document — never settle it.
  CROSS_ENTITY_MISMATCH: 'blocked_cross_entity_mismatch'
});
