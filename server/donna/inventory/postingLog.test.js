// I4·posting P3 — persistence taxonomy + the pure heads projection (design §11). Pins the
// closed vocabularies' shape and the projectPostingHeads mirror of the SQL view.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  INVENTORY_POSTING_KINDS,
  INVENTORY_POSTING_OUTCOMES,
  SUCCESSFUL_POSTING_OUTCOMES,
  INVENTORY_POSTING_WAITER_TYPES,
  INVENTORY_JOURNAL_RELATIONSHIPS,
  INVENTORY_ALLOWANCE_STATUSES,
  isSuccessfulPostingOutcome,
  isInventoryPostingKind,
  projectPostingHeads
} from './postingLog.js';

test('the taxonomy vocabularies are frozen and internally consistent', () => {
  for (const v of [
    INVENTORY_POSTING_KINDS,
    INVENTORY_POSTING_OUTCOMES,
    SUCCESSFUL_POSTING_OUTCOMES,
    INVENTORY_POSTING_WAITER_TYPES,
    INVENTORY_JOURNAL_RELATIONSHIPS,
    INVENTORY_ALLOWANCE_STATUSES
  ]) {
    assert.ok(Object.isFrozen(v), 'vocabulary is frozen');
    assert.equal(new Set(v).size, v.length, 'no duplicate values');
  }
  // the successful outcomes are a subset of all outcomes
  for (const o of SUCCESSFUL_POSTING_OUTCOMES) assert.ok(INVENTORY_POSTING_OUTCOMES.includes(o));
  // the two design-named successful terminals, exactly
  assert.deepEqual([...SUCCESSFUL_POSTING_OUTCOMES], ['posted', 'no_journal_required']);
});

test('the guards recognise membership', () => {
  assert.equal(isSuccessfulPostingOutcome('posted'), true);
  assert.equal(isSuccessfulPostingOutcome('no_journal_required'), true);
  assert.equal(isSuccessfulPostingOutcome('refused'), false);
  assert.equal(isSuccessfulPostingOutcome('superseded'), false);
  assert.equal(isInventoryPostingKind('receipt'), true);
  assert.equal(isInventoryPostingKind('value_neutral'), true);
  assert.equal(isInventoryPostingKind('not_a_kind'), false);
});

test('value-neutral and private-use are first-class posting kinds (D-POST-14 / §5-E)', () => {
  assert.ok(INVENTORY_POSTING_KINDS.includes('value_neutral'));
  assert.ok(INVENTORY_POSTING_KINDS.includes('private_use'));
  // no_journal_required is a recorded successful terminal, not a gap
  assert.ok(SUCCESSFUL_POSTING_OUTCOMES.includes('no_journal_required'));
});

test('projectPostingHeads picks the latest attempt per operation+kind', () => {
  const attempts = [
    { id: 1, firm_id: 'f', client_id: 'c', operation_id: 'op1', posting_kind: 'receipt', posting_basis_version: 1, outcome: 'posted', created_at: '2026-07-01T00:00:00Z' },
    // a later delta at basis version 2 supersedes op1/receipt
    { id: 2, firm_id: 'f', client_id: 'c', operation_id: 'op1', posting_kind: 'receipt', posting_basis_version: 2, outcome: 'posted', created_at: '2026-07-05T00:00:00Z' },
    // a different kind on the same op is its own head
    { id: 3, firm_id: 'f', client_id: 'c', operation_id: 'op1', posting_kind: 'shipment_cogs', posting_basis_version: 1, outcome: 'posted', created_at: '2026-07-02T00:00:00Z' },
    // a different op
    { id: 4, firm_id: 'f', client_id: 'c', operation_id: 'op2', posting_kind: 'receipt', posting_basis_version: 1, outcome: 'refused', created_at: '2026-07-03T00:00:00Z' }
  ];
  const heads = projectPostingHeads(attempts);
  assert.equal(heads.length, 3);
  const byKey = new Map(heads.map((h) => [`${h.operation_id}/${h.posting_kind}`, h]));
  assert.equal(byKey.get('op1/receipt').id, 2); // the basis-2 delta is the head
  assert.equal(byKey.get('op1/receipt').posting_basis_version, 2);
  assert.equal(byKey.get('op1/shipment_cogs').id, 3);
  assert.equal(byKey.get('op2/receipt').id, 4); // a refused attempt can still be the head
});

test('projectPostingHeads breaks a created_at tie by id (newest id wins)', () => {
  const attempts = [
    { id: 10, firm_id: 'f', client_id: 'c', operation_id: 'op1', posting_kind: 'receipt', outcome: 'posted', created_at: '2026-07-01T00:00:00Z' },
    { id: 11, firm_id: 'f', client_id: 'c', operation_id: 'op1', posting_kind: 'receipt', outcome: 'superseded', created_at: '2026-07-01T00:00:00Z' }
  ];
  const heads = projectPostingHeads(attempts);
  assert.equal(heads.length, 1);
  assert.equal(heads[0].id, 11);
});

test('projectPostingHeads is deterministic and scopes by firm+client', () => {
  const attempts = [
    { id: 1, firm_id: 'f2', client_id: 'c', operation_id: 'op1', posting_kind: 'receipt', outcome: 'posted', created_at: '2026-07-01T00:00:00Z' },
    { id: 2, firm_id: 'f1', client_id: 'c', operation_id: 'op1', posting_kind: 'receipt', outcome: 'posted', created_at: '2026-07-01T00:00:00Z' }
  ];
  const a = projectPostingHeads(attempts);
  const b = projectPostingHeads(attempts);
  assert.deepEqual(a, b);
  // two firms with the same operation_id keep separate heads, ordered f1 before f2
  assert.equal(a.length, 2);
  assert.equal(a[0].firm_id, 'f1');
});

test('projectPostingHeads tolerates empty / non-array input', () => {
  assert.deepEqual(projectPostingHeads([]), []);
  assert.deepEqual(projectPostingHeads(undefined), []);
  assert.deepEqual(projectPostingHeads(null), []);
});
