// Per-action operator capability layer — unit tests (pod-safety #3: reviewer ≠ founder;
// seat build: the extended lattice viewer < junior < reviewer < senior < partner < founder).
//
// Load-bearing properties (CLAUDE.md §"the pod-safety gap" + build spec §2.2):
//   - fail-closed: an unknown/unregistered mutating verb, an unknown role, or a missing
//     capability all require FOUNDER — a verb can never slip in low-runnable by omission;
//   - an unrestricted firm member / access token is ALWAYS 'founder' → enforcement can never
//     lock the founder out of their own book;
//   - a collaborator's class comes from the per-client client_assignments.role, fail-closed to
//     viewer on any unrecognized role (only ever LESS privileged than intended, never more);
//   - LEGACY INVARIANCE: every verb the day-one reviewer could invoke still requires ≤ reviewer
//     rank (the deeper set-level pin lives in seatAuthority.test.js);
//   - the founder pins that survived the deliberate partner relaxations (reverse_apply,
//     post_inventory_journal, the role-grant verbs) still require founder.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeActionType,
  authorizeOperatorAction,
  resolveCapabilityClass,
  requiredCapabilityForAction,
  __capabilityPartition,
  CAPABILITY_CLASSES,
  REVERSE_ACTION_TYPE,
  OPERATOR_CAPABILITY_FLAG_KEY
} from './operatorCapability.js';
import { registryVerbs, accountingMutationVerbs } from './accountingMutationRegistry.js';

const rank = (cls) => CAPABILITY_CLASSES.indexOf(cls);

test('capability classes are ordered least → most privileged (seat lattice)', () => {
  assert.deepEqual(CAPABILITY_CLASSES, ['viewer', 'junior', 'reviewer', 'senior', 'partner', 'founder']);
  assert.equal(OPERATOR_CAPABILITY_FLAG_KEY, 'OPERATOR_CAPABILITY_ENFORCE');
  // reviewer sits directly below senior: "reviewer-required" and "senior can,
  // junior cannot" are the same law (the seatActionClasses header's premise).
  assert.equal(rank('reviewer'), rank('senior') - 1);
  assert.ok(rank('junior') < rank('reviewer'));
});

test('an unrestricted firm member is always founder class', () => {
  assert.equal(resolveCapabilityClass({ principal: { principalType: 'firm_member', unrestricted: true } }), 'founder');
  assert.equal(resolveCapabilityClass({ principal: { principalType: 'access_token', unrestricted: true } }), 'founder');
  // a firm member never loses founder even with a stray low assignment role
  assert.equal(resolveCapabilityClass({ principal: { principalType: 'firm_member', unrestricted: true }, assignmentRole: 'viewer' }), 'founder');
  // ...or a stray seat role: unrestricted wins first, always
  assert.equal(resolveCapabilityClass({ principal: { principalType: 'firm_member', unrestricted: true, seatRole: 'junior' } }), 'founder');
});

test('a collaborator class derives from the per-client assignment role, fail-closed to viewer', () => {
  const collab = { principalType: 'firm_collaborator', unrestricted: false };
  assert.equal(resolveCapabilityClass({ principal: collab, assignmentRole: 'reviewer' }), 'reviewer');
  assert.equal(resolveCapabilityClass({ principal: collab, assignmentRole: 'Bookkeeper' }), 'reviewer'); // case-insensitive
  assert.equal(resolveCapabilityClass({ principal: collab, assignmentRole: 'owner' }), 'founder');
  assert.equal(resolveCapabilityClass({ principal: collab, assignmentRole: 'viewer' }), 'viewer');
  assert.equal(resolveCapabilityClass({ principal: collab, assignmentRole: null }), 'viewer'); // absent → viewer
  assert.equal(resolveCapabilityClass({ principal: collab, assignmentRole: 'gremlin' }), 'viewer'); // unknown → viewer
});

test('a seat class derives from the seat ladder: assignment row first, seat row second', () => {
  const seat = (seatRole) => ({ principalType: 'firm_collaborator', unrestricted: false, seatRole });
  // assignment rows carry the seat role in v1 (written identically at invite)
  assert.equal(resolveCapabilityClass({ principal: seat('junior'), assignmentRole: 'junior' }), 'junior');
  assert.equal(resolveCapabilityClass({ principal: seat('senior'), assignmentRole: 'senior' }), 'senior');
  assert.equal(resolveCapabilityClass({ principal: seat('partner'), assignmentRole: 'partner' }), 'partner');
  // the per-entity override extension point: the assignment row WINS
  assert.equal(resolveCapabilityClass({ principal: seat('partner'), assignmentRole: 'junior' }), 'junior');
  // no assignment row on this entity → the seat row's role binds
  assert.equal(resolveCapabilityClass({ principal: seat('senior'), assignmentRole: null }), 'senior');
  // a seat with an unknown role fails closed like everything else
  assert.equal(resolveCapabilityClass({ principal: seat('intern'), assignmentRole: null }), 'viewer');
});

test('founder pins survive the seat build: the most privileged verbs still require founder', () => {
  for (const verb of ['post_inventory_journal', 'approve_role_grant', 'revoke_role_grant', REVERSE_ACTION_TYPE]) {
    assert.equal(requiredCapabilityForAction(verb), 'founder', verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'partner' }).allowed, false, verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'founder' }).allowed, true, verb);
  }
});

test('deliberate partner relaxations: journal/policy verbs moved founder → partner, never lower', () => {
  // The spec gives PARTNER final approval of journal entries and policy
  // changes. A legacy reviewer STILL cannot invoke them (behavior identical);
  // only the new partner rank gains them.
  for (const verb of ['sync_to_accounting', 'remember_merchant', 'remember_fact', 'forget_fact', 'retire_rule', 'recode_decided']) {
    assert.equal(requiredCapabilityForAction(verb), 'partner', verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'reviewer' }).allowed, false, verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'senior' }).allowed, false, verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'partner' }).allowed, true, verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'founder' }).allowed, true, verb);
  }
});

test('legacy invariance: day-one reviewer verbs stay invocable by a reviewer', () => {
  for (const verb of ['apply_category', 'mark_personal', 'link_document', 'reject_match', 'correct_document_field', 'ask_client', 'leave_review_note', 'mark_evidence_owed', 'record_mileage']) {
    assert.ok(rank(requiredCapabilityForAction(verb)) <= rank('reviewer'), `${verb} requires ≤ reviewer`);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'reviewer' }).allowed, true, verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'viewer' }).allowed, false, verb);
  }
});

test('the junior lane: routine queue verbs are junior-runnable; non-routine routes above junior', () => {
  for (const verb of ['apply_category', 'link_transaction', 'accept_match', 'mark_personal', 'leave_review_note', 'retry_parse']) {
    assert.equal(requiredCapabilityForAction(verb), 'junior', verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'junior' }).allowed, true, verb);
  }
  for (const verb of ['reject_match', 'mark_immaterial', 'ask_client', 'cancel_ask', 'amend_ask', 'resend_ask']) {
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'junior' }).allowed, false, verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'senior' }).allowed, true, verb);
  }
});

test('read-only verbs are allowed for any class incl. viewer', () => {
  for (const verb of ['diagnose', 'explain_match_reasoning', 'search_transactions']) {
    assert.equal(requiredCapabilityForAction(verb), 'viewer', verb);
    assert.equal(authorizeActionType({ actionType: verb, capabilityClass: 'viewer' }).allowed, true, verb);
  }
});

test('fail-closed: an unknown/unregistered mutating verb requires founder', () => {
  assert.equal(requiredCapabilityForAction('drop_all_tables'), 'founder');
  assert.equal(requiredCapabilityForAction(''), 'founder');
  assert.equal(requiredCapabilityForAction(undefined), 'founder');
  assert.equal(authorizeActionType({ actionType: 'drop_all_tables', capabilityClass: 'partner' }).allowed, false);
});

test('authorizeActionType returns a machine-readable reason + the required class', () => {
  const denied = authorizeActionType({ actionType: 'sync_to_accounting', capabilityClass: 'reviewer' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.required_class, 'partner');
  assert.equal(denied.capability_class, 'reviewer');
  assert.equal(denied.reason, 'requires_partner_capability');
  const ok = authorizeActionType({ actionType: 'apply_category', capabilityClass: 'founder' });
  assert.equal(ok.allowed, true);
  assert.equal(ok.reason, 'capability_satisfied');
});

test('authorizeOperatorAction resolves class + authorizes in one call', () => {
  const collab = { principalType: 'firm_collaborator', unrestricted: false };
  assert.equal(authorizeOperatorAction({ principal: collab, assignmentRole: 'reviewer', actionType: 'apply_category' }).allowed, true);
  assert.equal(authorizeOperatorAction({ principal: collab, assignmentRole: 'reviewer', actionType: 'sync_to_accounting' }).allowed, false);
  assert.equal(authorizeOperatorAction({ principal: { unrestricted: true }, assignmentRole: null, actionType: 'sync_to_accounting' }).allowed, true);
  // seat principals resolve through the same one call
  const seat = { principalType: 'firm_collaborator', unrestricted: false, seatRole: 'junior' };
  assert.equal(authorizeOperatorAction({ principal: seat, assignmentRole: 'junior', actionType: 'apply_category' }).allowed, true);
  assert.equal(authorizeOperatorAction({ principal: seat, assignmentRole: 'junior', actionType: 'sync_to_accounting' }).allowed, false);
});

test('an unknown capability class is treated as viewer (fail-closed)', () => {
  assert.equal(authorizeActionType({ actionType: 'apply_category', capabilityClass: 'superuser' }).allowed, false);
  assert.equal(authorizeActionType({ actionType: 'diagnose', capabilityClass: 'superuser' }).allowed, true);
});

test('partition covers every mutating registry verb with no founder/reviewer overlap', () => {
  const { founderOnly, reviewerAllowed, surfaceFounder, surfaceReviewer } = __capabilityPartition();
  const overlap = founderOnly.filter((v) => reviewerAllowed.includes(v));
  assert.deepEqual(overlap, [], 'no verb is both founder-only and reviewer-allowed');
  // The S1 surface identities (roleActionSurface) never demote a founder-only
  // verb: surface-reviewer is disjoint from both founder sets.
  const surfaceDemotion = surfaceReviewer.filter(
    (v) => founderOnly.includes(v) || surfaceFounder.includes(v)
  );
  assert.deepEqual(surfaceDemotion, [], 'no surface identity demotes a founder verb');
  // The four outbound send types resolve reviewer through the ONE function.
  for (const verb of ['issue_invoice', 'send_quote', 'send_receivable_reminder', 'send_payable_notice']) {
    assert.equal(requiredCapabilityForAction(verb), 'reviewer', verb);
  }
  // every registered verb resolves to a real mutating class on the lattice
  for (const verb of registryVerbs()) {
    const req = requiredCapabilityForAction(verb);
    assert.ok(['junior', 'reviewer', 'senior', 'partner', 'founder'].includes(req), `${verb} resolves to a real class (${req})`);
  }
  // every strict 'accounting'-autonomy verb is at least junior-gated (never viewer)
  for (const verb of accountingMutationVerbs()) {
    assert.notEqual(requiredCapabilityForAction(verb), 'viewer', `${verb} must not be viewer-runnable`);
  }
});
