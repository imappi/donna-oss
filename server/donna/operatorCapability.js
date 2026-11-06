// Donna — per-action operator capability layer (pod-safety #3: reviewer ≠ founder).
//
// The admin chat is Claude-Code-for-books: free-text correct/override/unlink/fix-anything,
// soon driven by a leveraged POD, not just the founder (CLAUDE.md §"the leverage mechanism").
// That makes it the most dangerous surface in the system. Today the ONLY authz discriminator
// is the binary member/collaborator split via `assertFirmAccess({requireMember})` — every
// collaborator who can reach a client's book can invoke EVERY mutating verb on it, from a
// coding recategorize (safe, reversible) all the way to `sync_to_accounting` (an irreversible
// external ledger push) or a `remember_*` rule edit (mints firm-wide memory). CLAUDE.md's
// pod-safety build order #3 is a capability check on the COMPILED action_type, built ON the
// existing assignment substrate: `client_assignments.role` (migration 001) already exists
// (default 'viewer') but is written-only — never read for authz. This module is the pure
// decision function that reads it.
//
// It is NOT a second authz backend. `assertFirmAccess` still runs FIRST and owns
// firm-scope + client-scope (which books you may touch at all). This layer answers only the
// finer question `assertFirmAccess` cannot: given you MAY touch this book, may your ROLE
// invoke THIS action_type on it? It is fail-closed (an unknown mutating verb, an unknown
// role, or any doubt → founder-only) and config-STAGED so it lands dormant: the wiring
// caller records a would-block on the shadow receipt at stage off/shadow and only throws a
// 403 once `OPERATOR_CAPABILITY_ENFORCE` is at canary/auto for the client (Honeybee-first,
// the AUTHORITY_ENVELOPE_CLASSIFIER pattern). An unrestricted firm member is always `founder`
// class, so turning enforcement on can NEVER lock the founder out of their own book.
//
// Pure leaf: imports ONLY the mutation registry (itself operatorContract-only) plus the two
// pure surface declarations the S1 convergence added (roles/roleActionSurface.js and the
// outbound gate's enums — both DB-free) — no DB, no LLM — so it loads in-sandbox under
// `node --test`, same discipline as authorityEnvelope.js. EVERY input is pre-computed and
// passed in (the principal shape + the per-client assignment role); the wiring caller does
// the one `client_assignments` read.

import { findMutationEntry, ACCOUNTING_MUTATION_REGISTRY } from './accountingMutationRegistry.js';
import { SURFACE_OPERATION_CAPABILITY } from './roles/roleActionSurface.js';
import { requiredClassForVerb } from './seatActionClasses.js';
import { SEAT_ROLE_CAPABILITY_CLASS } from './seatModel.js';

// The capability flag that stages enforcement off → … → auto (per-client, via the config
// plane). Pinned here so the wiring caller and the config plane agree on the key.
export const OPERATOR_CAPABILITY_FLAG_KEY = 'OPERATOR_CAPABILITY_ENFORCE';

// Ordered capability classes, LEAST → MOST privileged. The index is the privilege rank; a
// principal may invoke an action_type iff their class rank ≥ the action's required rank.
//
// Extended for human seats (build spec §2.2): the day-one lattice was
// viewer < reviewer < founder; the seat ladder inserts junior below reviewer
// and senior/partner above it. 'reviewer' stays a REAL rank (roleRegistry
// ranks bench roles through this array, and legacy collaborators resolve to
// it) sitting directly below 'senior' — so "reviewer-required" and "senior
// can, junior cannot" are the same law, and every verb a legacy reviewer
// could invoke still requires ≤ reviewer rank (the invariance test pins the
// set). No seat ever maps to 'reviewer'; no legacy principal ever maps to
// junior/senior/partner — the two ladders interleave without either changing
// the other's behavior.
export const CAPABILITY_CLASSES = Object.freeze(['viewer', 'junior', 'reviewer', 'senior', 'partner', 'founder']);

const classRank = (cls) => {
  const idx = CAPABILITY_CLASSES.indexOf(cls);
  return idx < 0 ? -1 : idx;
};

// A pseudo-verb for the reverse executor (pod-safety #2 finish). A reverse is not a chat
// action_type — it is its own privileged operation — but it flows through the SAME capability
// gate so "who may reverse" is answered in one place. Founder-only to start (Kari's call).
export const REVERSE_ACTION_TYPE = 'reverse_apply';

// SEAT BUILD NOTE: verb→class resolution moved to seatActionClasses.js (see
// requiredCapabilityForAction below). The two sets that follow are KEPT as the
// legacy record and the last-resort fallbacks: REVIEWER_ALLOWED_ACTIONS is the
// day-one reviewer verb set (the invariance the seat lattice must not narrow —
// pinned in seatAuthority.test.js), and FOUNDER_ONLY_ACTIONS documents which
// verbs were founder-only before the deliberate partner relaxations.
//
// The founder-only set — the verbs a reviewer may NOT invoke (CLAUDE.md pod-safety #3 verbatim:
// "blocked: sync_to_accounting / remember_* rule edits / recode_decided / period reopen"), plus
// the reverse executor. Rationale per verb:
//   sync_to_accounting — irreversible external ledger push (reversibility: irreversible_external)
//   remember_merchant / remember_fact — mint firm-wide MEMORY (a rule edit outlives the case)
//   recode_decided — re-opens an already-DECIDED (terminal) row (INV-4 in reverse)
//   reverse_apply — undoes a prior operator's apply; the most powerful correction verb
//   post_inventory_journal — the I4·posting executor: writes ledger journals (inventory/GRNI/
//     COGS/AP). Like reverse_apply it is a privileged non-chat operation that flows through the
//     SAME gate; founder-only to start (never reviewer-runnable by omission via the registry
//     derivation below). It is never dispatched from chat, so this is a defensive default.
//   forget_fact / retire_rule — EDIT firm-wide memory (G1c): dismissing a fact
//     or retiring a rule outlives the case exactly like minting one does, so the
//     memory-correction verbs ride the same founder-only posture as remember_*.
const FOUNDER_ONLY_ACTIONS = Object.freeze(new Set([
  'sync_to_accounting',
  'remember_merchant',
  'remember_fact',
  'forget_fact',
  'retire_rule',
  'recode_decided',
  'post_inventory_journal',
  // approve_role_grant / revoke_role_grant — the standing-authority verbs
  // (team-screen recede): minting or withdrawing a teammate's authority is
  // the most privileged mutation class; a scoped reviewer must never widen
  // (or silently narrow) what an AI teammate may do. The roleEmployment
  // writers additionally refuse any non-owner actor_type — double-gated.
  'approve_role_grant',
  'revoke_role_grant',
  REVERSE_ACTION_TYPE
]));

// The reviewer-allowed set: the coding / reconcile / evidence verbs a pod reviewer handles —
// all reversible-before-posting or reversible-via-adjustment, none minting firm memory or
// pushing externally. Derived from the registry (every 'accounting'/'owner_ask'/'workflow'/
// 'remedial' verb NOT in the founder-only set) so a NEW mutating verb inherits a home instead
// of silently defaulting to founder-only forever. (The default IS founder-only — see below —
// this set is what pulls the safe verbs down to reviewer.)
const REVIEWER_ALLOWED_ACTIONS = Object.freeze(new Set(
  ACCOUNTING_MUTATION_REGISTRY
    .map((e) => e.verb)
    .filter((verb) => !FOUNDER_ONLY_ACTIONS.has(verb))
));

// The minimum capability class required to invoke an action_type. Fail-closed: a verb that is
// neither explicitly reviewer-allowed nor a known read-only verb requires FOUNDER — a new
// mutating verb can never slip in reviewer-runnable by omission. Read-only verbs (diagnose /
// explain / search) are 'viewer' — anyone with book access may run them.
const READ_ONLY_ACTIONS = Object.freeze(new Set([
  'diagnose', 'explain_match_reasoning', 'search_transactions', 'future_action'
]));

// The S1 convergence (specialist-roles doc §5): the surface identities the S0
// registry did not carry — the four outbound send types plus the audited sweep
// operations — declare their required class in roles/roleActionSurface.js
// (SURFACE_OPERATION_CAPABILITY) and resolve through THIS one function, so
// "which class may invoke this" keeps exactly one owner across every seam.
// Precedence: an explicit founder-only membership above always wins (the
// reverse verb appears in both declarations, pinned equal by test).
const SURFACE_FOUNDER_ACTIONS = Object.freeze(new Set(
  Object.entries(SURFACE_OPERATION_CAPABILITY)
    .filter(([, cls]) => cls === 'founder').map(([verb]) => verb)
));
const SURFACE_REVIEWER_ACTIONS = Object.freeze(new Set(
  Object.entries(SURFACE_OPERATION_CAPABILITY)
    .filter(([, cls]) => cls === 'reviewer').map(([verb]) => verb)
));

export const requiredCapabilityForAction = (actionType) => {
  const verb = String(actionType || '');
  if (!verb) return 'founder';
  // Seat build: the one verb → class derivation now lives in
  // seatActionClasses.js (class map + pins). It covers every registry verb,
  // the read-only verbs, the reverse executor, and the seat-management
  // operations; precedence notes:
  //   - the explicit founder pins there (post_inventory_journal,
  //     reverse_apply) reproduce the day-one founder-only posture verbatim;
  //   - sync_to_accounting and the memory verbs deliberately relaxed from
  //     founder to partner (the spec gives PARTNER final approval of journal
  //     entries and policy changes; no legacy principal maps to partner, so
  //     nothing existing widens);
  //   - every verb a legacy reviewer could invoke still resolves ≤ reviewer
  //     rank — pinned by the invariance test in seatAuthority.test.js.
  const classed = requiredClassForVerb(verb);
  if (classed) return classed;
  if (SURFACE_FOUNDER_ACTIONS.has(verb)) return 'founder';
  if (SURFACE_REVIEWER_ACTIONS.has(verb)) return 'reviewer';
  if (REVIEWER_ALLOWED_ACTIONS.has(verb)) return 'reviewer';
  if (READ_ONLY_ACTIONS.has(verb)) return 'viewer';
  return 'founder'; // fail-closed default for an unknown/unregistered verb
};

// Map a resolved principal (+ the per-client assignment role, when the principal is a
// collaborator) to a capability class. An unrestricted firm member / access token is ALWAYS
// 'founder' — enforcement can never lock the founder out. A collaborator's class comes from
// their `client_assignments.role` for THIS client (the per-client capability substrate);
// fail-closed to 'viewer' on any unrecognized/absent role, so a mis-seeded assignment can
// only ever be LESS privileged than intended, never more.
const FOUNDER_ROLES = Object.freeze(new Set(['owner', 'firm_owner', 'admin', 'founder']));
const REVIEWER_ROLES = Object.freeze(new Set(['reviewer', 'bookkeeper', 'senior_bookkeeper', 'preparer', 'accountant']));

export const resolveCapabilityClass = ({ principal = null, assignmentRole = null } = {}) => {
  if (principal && (principal.unrestricted === true
    || principal.principalType === 'firm_member'
    || principal.principalType === 'access_token')) {
    return 'founder';
  }
  const role = String(assignmentRole || '').trim().toLowerCase();
  if (FOUNDER_ROLES.has(role)) return 'founder';
  if (REVIEWER_ROLES.has(role)) return 'reviewer';
  // Seat ladder (build spec §3.2): a seat's per-entity assignment row carries
  // its seat role ('partner'/'senior'/'junior') — resolved here so the
  // per-entity override extension point comes free (assignment row first,
  // seat row second). 'owner' is already founder via FOUNDER_ROLES above.
  if (role && role !== 'owner' && SEAT_ROLE_CAPABILITY_CLASS[role]) {
    return SEAT_ROLE_CAPABILITY_CLASS[role];
  }
  const seatRole = String(principal?.seatRole || '').trim().toLowerCase();
  if (seatRole && seatRole !== 'owner' && SEAT_ROLE_CAPABILITY_CLASS[seatRole]) {
    return SEAT_ROLE_CAPABILITY_CLASS[seatRole];
  }
  return 'viewer';
};

// The decision. Pure — no throw, no DB, no config read. Returns whether the class may invoke
// the action, plus the required class and a machine-readable reason for the receipt. The
// wiring caller decides what to DO with `allowed` (throw 403 when the flag ACTS, or record a
// would-block on the shadow receipt when it merely OBSERVES).
export const authorizeActionType = ({ actionType, capabilityClass } = {}) => {
  const requiredClass = requiredCapabilityForAction(actionType);
  const cls = CAPABILITY_CLASSES.includes(capabilityClass) ? capabilityClass : 'viewer';
  const allowed = classRank(cls) >= classRank(requiredClass);
  return {
    action_type: String(actionType || ''),
    capability_class: cls,
    required_class: requiredClass,
    allowed,
    reason: allowed
      ? 'capability_satisfied'
      : `requires_${requiredClass}_capability`
  };
};

// Convenience for the wiring caller: resolve the class from principal+assignmentRole and
// authorize in one call. Still pure — the caller owns the `client_assignments` read and the
// config-stage gate.
export const authorizeOperatorAction = ({ principal = null, assignmentRole = null, actionType } = {}) => {
  const capabilityClass = resolveCapabilityClass({ principal, assignmentRole });
  return authorizeActionType({ actionType, capabilityClass });
};

// Exposed for the registry-drift test: the two explicit sets must stay disjoint and cover
// every mutating registry verb, so no verb is both founder-only and reviewer-allowed, and none
// is silently uncovered (falling through to the fail-closed founder default unintentionally).
export const __capabilityPartition = () => ({
  founderOnly: [...FOUNDER_ONLY_ACTIONS],
  reviewerAllowed: [...REVIEWER_ALLOWED_ACTIONS],
  readOnly: [...READ_ONLY_ACTIONS],
  surfaceFounder: [...SURFACE_FOUNDER_ACTIONS],
  surfaceReviewer: [...SURFACE_REVIEWER_ACTIONS]
});
