// Donna — action classes for the seat-authority ladder (build spec §3.4).
//
// Pure leaf: zero imports. ONE classification per mutating verb, driving the
// ONE capability resolver (operatorCapability.requiredCapabilityForAction) —
// this file is how the build stays "4 roles × affiliation, one matrix" instead
// of growing a second enforcement path. Drift-tested both ways:
// seatAuthority.test.js asserts every accountingMutationRegistry verb appears
// here exactly once, and that every pin below is stricter-or-justified.
//
// The class ladder (the spec's "routine categorization < non-routine proposal
// < journal entry < policy change < statutory filing", plus the management
// classes and read_only). Each class names the MINIMUM capability class on the
// extended lattice (viewer < junior < reviewer < senior < partner < founder).
//
// Why nonroutine_proposal maps to 'reviewer' and not 'senior': 'reviewer' is
// the legacy collaborator rank and it sits directly BELOW senior on the
// lattice, so "reviewer-required" and "senior can, junior cannot" are the same
// law for seats — while legacy reviewer principals keep exactly the verb set
// they had before this build (the invariance test pins that set forever).
// Routing still surfaces it as "route to senior": the routing target is the
// smallest SEAT role satisfying the class, and no seat maps to 'reviewer'.

export const ACTION_CLASSES = Object.freeze([
  'read_only',
  'routine_categorization',
  'nonroutine_proposal',
  'journal_entry',
  'policy_change',
  'statutory_filing',
  'entity_assignment',
  'seat_admin'
]);

export const ACTION_CLASS_MIN_CAPABILITY = Object.freeze({
  read_only: 'viewer',
  routine_categorization: 'junior',
  nonroutine_proposal: 'reviewer',
  journal_entry: 'partner',
  policy_change: 'partner',
  statutory_filing: 'partner',
  entity_assignment: 'partner',
  seat_admin: 'founder'
});

// Materiality bounds bind only where an amount is the substance of the action
// and the acting role is bounded (junior/senior). partner+ classes are
// unbounded by role, so gating them would be dead code.
export const AMOUNT_GATED_ACTION_CLASSES = Object.freeze(new Set([
  'routine_categorization',
  'nonroutine_proposal'
]));

// Every mutating verb in accountingMutationRegistry.js, classified once, plus
// the read-only chat verbs, the reverse executor, and the route-level seat
// management operations (which resolve through the same one resolver — the
// approve/revoke_role_grant precedent).
export const VERB_ACTION_CLASS = Object.freeze({
  // read-only (anyone with book access)
  diagnose: 'read_only',
  explain_match_reasoning: 'read_only',
  search_transactions: 'read_only',
  future_action: 'read_only',

  // routine queue work — the JUNIOR lane, materiality-bounded
  apply_category: 'routine_categorization',
  link_transaction: 'routine_categorization',
  link_document: 'routine_categorization',
  accept_match: 'routine_categorization',
  mark_personal: 'routine_categorization',
  mark_evidence_owed: 'routine_categorization',
  leave_review_note: 'routine_categorization',
  retry_parse: 'routine_categorization',
  answer_evidence_request: 'routine_categorization',
  observe_physical_reconciliation: 'routine_categorization',
  register_physical_evidence: 'routine_categorization',
  acknowledge_physical_request: 'routine_categorization',

  // non-routine judgment — SENIOR and up (reviewer rank; see header)
  reject_match: 'nonroutine_proposal',
  open_physical_reconciliation: 'nonroutine_proposal',
  assign_physical_capture_task: 'nonroutine_proposal',
  resolve_physical_reconciliation: 'nonroutine_proposal',
  resolve_match_group: 'nonroutine_proposal',
  correct_document_field: 'nonroutine_proposal',
  mark_immaterial: 'nonroutine_proposal',
  recode_decided: 'nonroutine_proposal',      // pinned partner below (reopens a DECIDED row — INV-4 in reverse)
  ask_client: 'nonroutine_proposal',          // chases are SENIOR's to approve (spec §3.2)
  draft_evidence_request: 'nonroutine_proposal',
  resend_ask: 'nonroutine_proposal',
  cancel_ask: 'nonroutine_proposal',
  amend_ask: 'nonroutine_proposal',
  reverse_apply: 'nonroutine_proposal',       // pinned founder below (Kari's dated call: founder-only to start)

  // journal entries / external ledger pushes — PARTNER's final approval
  sync_to_accounting: 'journal_entry',        // deliberate relax from founder-only: the spec gives PARTNER
                                              // final approval of journal entries; no legacy principal maps
                                              // to partner, so nothing existing widens
  record_mileage: 'journal_entry',            // pinned reviewer below (legacy invariance + the one journal
                                              // writer with LIVE deterministic preflight + receipt from birth)
  post_inventory_journal: 'journal_entry',    // pinned founder below (executor path, defensive posture kept)

  // policy: rules and firm memory outlive the case
  remember_merchant: 'policy_change',
  remember_fact: 'policy_change',
  forget_fact: 'policy_change',
  retire_rule: 'policy_change',
  // route-level (reconciliationAuthorityRoutes.js): standing delegated authority
  // for material reconciliation matches. Widening (grant / approve /
  // re-activate) AND narrowing (suspend / revoke) are governance, so both sit
  // at PARTNER: one rung decides a client's autonomy in either direction. A
  // senior who sees a bad auto-accept corrects the match itself, which
  // auto-suspends the grant without needing this verb.
  grant_reconciliation_authority: 'policy_change',
  approve_reconciliation_authority: 'policy_change',
  suspend_reconciliation_authority: 'policy_change',
  revoke_reconciliation_authority: 'policy_change',
  release_pilot_send_containment: 'policy_change', // route-level: a standing per-client decision that
                                                   // lets owner questions leave draft; external seats
                                                   // are fenced (CLIENT_FACING_CHASE_VERBS) and every
                                                   // send still passes the send route's own gates

  // standing authority + seat management — OWNER only
  approve_role_grant: 'seat_admin',
  revoke_role_grant: 'seat_admin',
  invite_seat: 'seat_admin',
  seat_role_change: 'seat_admin',
  seat_suspend: 'seat_admin',
  seat_reactivate: 'seat_admin',
  seat_extend: 'seat_admin',

  // entity assignment — PARTNER manages who works which entity
  seat_entity_assign: 'entity_assignment',
  seat_entity_unassign: 'entity_assignment'
});

// Per-verb pins that deviate from the class default. Each entry carries its
// rationale here and is drift-tested: a pin must move a verb STRICTER than its
// class default unless it appears in LEGACY_FLOOR_PINS (the named, justified
// exceptions that keep the legacy reviewer verb set byte-identical).
export const VERB_CLASS_PINS = Object.freeze({
  recode_decided: 'partner',        // stricter: reopening a DECIDED terminal is not senior queue work
  post_inventory_journal: 'founder',// stricter: executor-only verb, never seat-dispatched
  reverse_apply: 'founder',         // stricter: the most powerful correction verb (Kari's call)
  record_mileage: 'reviewer'        // LEGACY FLOOR: previously reviewer-allowed; live preflight gates it
});

// The pins allowed to sit BELOW their class default, by name. Anything else
// pinned downward fails the drift test.
export const LEGACY_FLOOR_PINS = Object.freeze(new Set(['record_mileage']));

export const actionClassForVerb = (verb) => VERB_ACTION_CLASS[String(verb || '')] || null;

// The one verb → minimum-capability-class derivation. Null for an unknown verb
// (the caller fail-closes to founder — operatorCapability keeps that law).
export const requiredClassForVerb = (verb) => {
  const v = String(verb || '');
  if (VERB_CLASS_PINS[v]) return VERB_CLASS_PINS[v];
  const cls = VERB_ACTION_CLASS[v];
  return cls ? ACTION_CLASS_MIN_CAPABILITY[cls] : null;
};
