// Seat approval-authority — the exhaustive matrix + the drift and invariance
// pins (build spec §9). Three jobs:
//   1. MATRIX: every (seat role × action class × materiality bucket) cell has
//      an expected allow/route outcome, asserted exhaustively — and every verb
//      of a class behaves identically to its class representative, so the
//      matrix covers every verb without duplicating the map.
//   2. DRIFT: every mutating registry verb is classified exactly once; pins
//      only deviate downward when named in LEGACY_FLOOR_PINS.
//   3. LEGACY INVARIANCE: the FROZEN day-one reviewer verb set (as of this
//      build) still resolves ≤ reviewer rank — a later reclassification that
//      would narrow a legacy collaborator's set fails here, by name.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decideSeatAuthority,
  seatRoleForRequiredClass,
  directActionAmount,
  actionTargetIds,
  resolveActionAmountMinor,
  SEAT_MATERIALITY_BOUNDS_MINOR
} from './seatAuthority.js';
import {
  ACTION_CLASSES,
  ACTION_CLASS_MIN_CAPABILITY,
  AMOUNT_GATED_ACTION_CLASSES,
  VERB_ACTION_CLASS,
  VERB_CLASS_PINS,
  LEGACY_FLOOR_PINS,
  actionClassForVerb,
  requiredClassForVerb
} from './seatActionClasses.js';
import { CAPABILITY_CLASSES, requiredCapabilityForAction } from './operatorCapability.js';
import { registryVerbs } from './accountingMutationRegistry.js';
import { decideSeatResolution, validateSeatInvite, projectSeat, SEAT_ROLE_CAPABILITY_CLASS } from './seatModel.js';

const rank = (cls) => CAPABILITY_CLASSES.indexOf(cls);

// ── 2. Drift ─────────────────────────────────────────────────────────────────

test('drift: every mutating registry verb is classified exactly once', () => {
  for (const verb of registryVerbs()) {
    assert.ok(VERB_ACTION_CLASS[verb], `registry verb '${verb}' has no action class — classify it in seatActionClasses.js`);
  }
  for (const [verb, cls] of Object.entries(VERB_ACTION_CLASS)) {
    assert.ok(ACTION_CLASSES.includes(cls), `${verb}: unknown action class '${cls}'`);
  }
  for (const cls of Object.values(ACTION_CLASS_MIN_CAPABILITY)) {
    assert.ok(CAPABILITY_CLASSES.includes(cls), `class minimum '${cls}' not on the lattice`);
  }
});

test('drift: pins deviate downward only when named in LEGACY_FLOOR_PINS', () => {
  for (const [verb, pinned] of Object.entries(VERB_CLASS_PINS)) {
    const cls = VERB_ACTION_CLASS[verb];
    assert.ok(cls, `pinned verb '${verb}' must also be classified`);
    const classDefault = ACTION_CLASS_MIN_CAPABILITY[cls];
    if (rank(pinned) < rank(classDefault)) {
      assert.ok(LEGACY_FLOOR_PINS.has(verb),
        `${verb}: pinned '${pinned}' below its class default '${classDefault}' without a named legacy-floor justification`);
    }
  }
});

test('drift: the one resolver and the class map agree for every classified verb', () => {
  for (const verb of Object.keys(VERB_ACTION_CLASS)) {
    assert.equal(requiredCapabilityForAction(verb), requiredClassForVerb(verb), verb);
  }
});

// ── 3. Legacy invariance (the frozen day-one reviewer set) ───────────────────

// The reviewer-allowed verb set AS OF the seat build (registry minus the
// day-one founder-only set). FROZEN here on purpose: future verbs may classify
// anywhere, but reclassifying one of THESE above reviewer narrows a legacy
// collaborator's live set and must be a deliberate, dated decision.
const LEGACY_REVIEWER_VERBS = Object.freeze([
  'apply_category', 'link_transaction', 'link_document', 'reject_match',
  'accept_match', 'correct_document_field', 'mark_personal',
  'mark_evidence_owed', 'ask_client', 'leave_review_note',
  'draft_evidence_request', 'mark_immaterial', 'cancel_ask', 'amend_ask',
  'resend_ask', 'retry_parse', 'answer_evidence_request', 'record_mileage'
]);

test('legacy invariance: every day-one reviewer verb still requires ≤ reviewer rank', () => {
  for (const verb of LEGACY_REVIEWER_VERBS) {
    const required = requiredCapabilityForAction(verb);
    assert.ok(rank(required) <= rank('reviewer'),
      `${verb}: required '${required}' outranks reviewer — this narrows the legacy collaborator set`);
  }
});

test('legacy invariance: day-one founder-only verbs never relaxed below partner', () => {
  for (const verb of ['sync_to_accounting', 'remember_merchant', 'remember_fact', 'forget_fact', 'retire_rule', 'recode_decided', 'post_inventory_journal', 'approve_role_grant', 'revoke_role_grant', 'reverse_apply']) {
    assert.ok(rank(requiredCapabilityForAction(verb)) >= rank('partner'), verb);
  }
});

// ── 1. The exhaustive matrix ─────────────────────────────────────────────────

const ROLES = ['junior', 'senior', 'partner', 'owner'];
// Amount buckets: null (unresolvable), under the junior bound, between the
// bounds, over the senior bound.
const AMOUNTS = [null, 10_000, 200_000, 900_000];

// One representative verb per class (the identical-behavior sweep below
// extends each row to every verb of the class).
const CLASS_REPRESENTATIVE = {
  read_only: 'diagnose',
  routine_categorization: 'apply_category',
  nonroutine_proposal: 'reject_match',
  journal_entry: 'sync_to_accounting',
  policy_change: 'remember_fact',
  statutory_filing: null, // no filing verbs registered yet — class defined ahead of them
  entity_assignment: 'seat_entity_assign',
  seat_admin: 'invite_seat'
};

// The expected outcome for a cell, written INDEPENDENTLY of the
// implementation: capability first (class minimum vs role class), then the
// materiality bound for amount-gated classes on bounded roles.
const expectCell = ({ role, actionClass, amount }) => {
  const roleRank = rank(SEAT_ROLE_CAPABILITY_CLASS[role]);
  const minRank = rank(ACTION_CLASS_MIN_CAPABILITY[actionClass]);
  if (roleRank < minRank) return 'route';
  const bound = SEAT_MATERIALITY_BOUNDS_MINOR[role];
  if (bound != null && AMOUNT_GATED_ACTION_CLASSES.has(actionClass)) {
    if (amount == null) return 'route';
    if (Math.abs(amount) > bound) return 'route';
  }
  return 'allow';
};

test('matrix: every (role × action class × amount bucket) cell matches its expected outcome', () => {
  let cells = 0;
  for (const role of ROLES) {
    for (const actionClass of ACTION_CLASSES) {
      const verb = CLASS_REPRESENTATIVE[actionClass];
      if (!verb) continue;
      // Skip classes whose representative carries a PIN away from the class
      // default only where the pin changes the capability half — the pinned
      // verbs get their own sweep below.
      for (const amount of AMOUNTS) {
        const expected = expectCell({ role, actionClass, amount });
        const decision = decideSeatAuthority({ seatRole: role, actionType: verb, amountMinor: amount });
        assert.equal(decision.outcome, expected,
          `(${role} × ${actionClass} × ${amount == null ? 'unresolved' : amount}) expected ${expected}, got ${decision.outcome}`);
        cells += 1;
      }
    }
  }
  assert.ok(cells >= ROLES.length * 6 * AMOUNTS.length, `matrix actually swept (${cells} cells)`);
});

test('matrix: every verb of a class behaves identically to its class representative (unpinned verbs)', () => {
  for (const [verb, cls] of Object.entries(VERB_ACTION_CLASS)) {
    if (VERB_CLASS_PINS[verb]) continue; // pinned verbs asserted separately
    for (const role of ROLES) {
      for (const amount of AMOUNTS) {
        const expected = expectCell({ role, actionClass: cls, amount });
        const decision = decideSeatAuthority({ seatRole: role, actionType: verb, amountMinor: amount });
        assert.equal(decision.outcome, expected, `${verb} (${cls}) diverged from its class at (${role}, ${amount})`);
      }
    }
  }
});

test('matrix: pinned verbs follow their pin, not their class', () => {
  // recode_decided: partner-pinned — senior routes, partner allows
  assert.equal(decideSeatAuthority({ seatRole: 'senior', actionType: 'recode_decided', amountMinor: 10_000 }).outcome, 'route');
  assert.equal(decideSeatAuthority({ seatRole: 'partner', actionType: 'recode_decided', amountMinor: 10_000 }).outcome, 'allow');
  // reverse_apply / post_inventory_journal: founder-pinned — even partner routes to owner
  for (const verb of ['reverse_apply', 'post_inventory_journal']) {
    const decision = decideSeatAuthority({ seatRole: 'partner', actionType: verb, amountMinor: null });
    assert.equal(decision.outcome, 'route', verb);
    assert.equal(decision.route_to_role, 'owner', verb);
  }
  // record_mileage: legacy floor 'reviewer' — junior routes (to senior), senior allows within bound
  const jr = decideSeatAuthority({ seatRole: 'junior', actionType: 'record_mileage', amountMinor: 10_000 });
  assert.equal(jr.outcome, 'route');
  assert.equal(jr.route_to_role, 'senior');
  assert.equal(decideSeatAuthority({ seatRole: 'senior', actionType: 'record_mileage', amountMinor: 10_000 }).outcome, 'allow');
});

test('routing carries full provenance and targets the smallest authorized role', () => {
  // capability routing: junior → senior for a reviewer-class verb
  const cap = decideSeatAuthority({ seatRole: 'junior', actionType: 'reject_match', amountMinor: 5_000 });
  assert.equal(cap.outcome, 'route');
  assert.equal(cap.route_to_role, 'senior');
  assert.equal(cap.reason, 'requires_reviewer_capability');
  assert.equal(cap.action_class, 'nonroutine_proposal');
  assert.equal(cap.seat_role, 'junior');
  // amount routing: junior over-bound but under the senior bound → senior
  const mid = decideSeatAuthority({ seatRole: 'junior', actionType: 'apply_category', amountMinor: 200_000 });
  assert.equal(mid.outcome, 'route');
  assert.equal(mid.route_to_role, 'senior');
  assert.equal(mid.reason, 'amount_exceeds_bound');
  assert.equal(mid.bound_minor, SEAT_MATERIALITY_BOUNDS_MINOR.junior);
  // amount routing: over the senior bound too → partner (unbounded)
  const big = decideSeatAuthority({ seatRole: 'junior', actionType: 'apply_category', amountMinor: 900_000 });
  assert.equal(big.route_to_role, 'partner');
  // unresolved amount fails closed one rung up, never through
  const unresolved = decideSeatAuthority({ seatRole: 'senior', actionType: 'apply_category', amountMinor: null });
  assert.equal(unresolved.outcome, 'route');
  assert.equal(unresolved.reason, 'amount_unresolved');
  assert.equal(unresolved.route_to_role, 'partner');
});

test('seatRoleForRequiredClass maps lattice classes onto the seat ladder', () => {
  assert.equal(seatRoleForRequiredClass('viewer'), 'junior');
  assert.equal(seatRoleForRequiredClass('junior'), 'junior');
  assert.equal(seatRoleForRequiredClass('reviewer'), 'senior');
  assert.equal(seatRoleForRequiredClass('senior'), 'senior');
  assert.equal(seatRoleForRequiredClass('partner'), 'partner');
  assert.equal(seatRoleForRequiredClass('founder'), 'owner');
  assert.equal(seatRoleForRequiredClass('nonsense'), 'owner'); // fail-closed to the top
});

// ── Amount resolution ────────────────────────────────────────────────────────

test('directActionAmount: direct keys resolve (minor passthrough, major × 100), else null', () => {
  assert.equal(directActionAmount({ amount_minor: 1234 }), 1234);
  assert.equal(directActionAmount({ amount: 12.34 }), 1234);
  assert.equal(directActionAmount({ total_amount: '745' }), 74500);
  assert.equal(directActionAmount({ params: { amount: 5 } }), 500);
  assert.equal(directActionAmount({ type: 'apply_category', transaction_ids: ['tx-1'] }), null);
  assert.equal(directActionAmount(null), null);
});

test('actionTargetIds collects singular and plural target keys', () => {
  assert.deepEqual(
    actionTargetIds({ transaction_id: 'tx-1', transaction_ids: ['tx-2'], document_id: 'doc-1' }),
    { transactionIds: ['tx-2', 'tx-1'], documentIds: ['doc-1'] }
  );
});

test('resolveActionAmountMinor: batch resolves to the LARGEST absolute row amount', async () => {
  const amount = await resolveActionAmountMinor({
    action: { transaction_ids: ['tx-1', 'tx-2'] },
    clientId: 'client-1',
    lookupTransactionAmounts: async () => [-12.5, 620.4]
  });
  assert.equal(amount, 62040);
  const none = await resolveActionAmountMinor({ action: { transaction_ids: ['tx-1'] }, lookupTransactionAmounts: async () => [] });
  assert.equal(none, null);
});

// ── seatModel pure decisions ─────────────────────────────────────────────────

test('decideSeatResolution: expiry beats activation; non-seats always proceed', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const seat = (over = {}) => ({ seat_role: 'junior', status: 'active', ends_at: null, ...over });
  assert.equal(decideSeatResolution({ row: seat(), now }).disposition, 'proceed');
  assert.equal(decideSeatResolution({ row: seat({ status: 'invited' }), now }).disposition, 'activate');
  assert.equal(decideSeatResolution({ row: seat({ ends_at: '2026-08-01T00:00:00Z' }), now }).disposition, 'suspend_expired');
  // an invited seat whose window already passed must NEVER activate
  assert.equal(decideSeatResolution({ row: seat({ status: 'invited', ends_at: '2026-08-01T00:00:00Z' }), now }).disposition, 'suspend_expired');
  // future end date → proceed
  assert.equal(decideSeatResolution({ row: seat({ ends_at: '2027-01-01T00:00:00Z' }), now }).disposition, 'proceed');
  // a non-seat collaborator row is untouched by the seat lifecycle
  assert.equal(decideSeatResolution({ row: { role: 'owner', status: 'active' }, now }).disposition, 'proceed');
});

test('validateSeatInvite: external seats REQUIRE entities and a future end date', () => {
  const now = new Date('2026-08-27T12:00:00Z');
  const base = { name: 'Maya K', email: 'maya@example.com', seatRole: 'junior', now };
  assert.equal(validateSeatInvite({ ...base }).ok, true); // internal: entities optional
  assert.equal(validateSeatInvite({ ...base, affiliation: 'external' }).code, 'external_requires_entities');
  assert.equal(validateSeatInvite({ ...base, affiliation: 'external', clientIds: ['c1'] }).code, 'external_requires_end_date');
  assert.equal(validateSeatInvite({ ...base, affiliation: 'external', clientIds: ['c1'], endsAt: '2026-01-01' }).code, 'ends_at_past');
  const ok = validateSeatInvite({ ...base, affiliation: 'external', clientIds: ['c1'], endsAt: '2027-01-01' });
  assert.equal(ok.ok, true);
  assert.equal(ok.normalized.email, 'maya@example.com');
  // owner is not invitable; neither is a made-up role
  assert.equal(validateSeatInvite({ ...base, seatRole: 'owner' }).code, 'seat_role_invalid');
  assert.equal(validateSeatInvite({ ...base, seatRole: 'intern' }).code, 'seat_role_invalid');
  assert.equal(validateSeatInvite({ ...base, email: 'not-an-email' }).code, 'email_invalid');
});

test('projectSeat: members project as OWNER seats; owner-collaborators too; plain collaborators do not', () => {
  const member = projectSeat({ source: 'member', row: { id: 'm1', name: 'Kari', email: 'kari@books.example', status: 'active' } });
  assert.equal(member.seat_role, 'owner');
  assert.equal(member.affiliation, 'internal');
  assert.equal(member.client_ids, null);
  const ownerCollab = projectSeat({ source: 'collaborator', row: { id: 'c1', name: 'Owner', email: 'o@x-com.example', role: 'owner', status: 'active' }, clientIds: ['cl-1'] });
  assert.equal(ownerCollab.seat_role, 'owner');
  const juniorSeat = projectSeat({ source: 'collaborator', row: { id: 'c2', name: 'J', email: 'j@x-com.example', seat_role: 'junior', affiliation: 'external', status: 'invited' }, clientIds: ['cl-1'] });
  assert.equal(juniorSeat.seat_role, 'junior');
  assert.equal(juniorSeat.affiliation, 'external');
  const plain = projectSeat({ source: 'collaborator', row: { id: 'c3', name: 'P', email: 'p@x-com.example', role: 'bookkeeper', status: 'active' } });
  assert.equal(plain, null);
});
