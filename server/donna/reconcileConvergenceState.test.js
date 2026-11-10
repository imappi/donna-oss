// The convergence invariant, machine-checked: the held-for-authority axis.
//
// A material match the materiality ceiling holds (`matched_pending_authority`)
// is a transition, never a resting state. Pinned here:
//   - the projection: held with no covering grant is hanging under
//     matched_pending_authority_no_grant, whatever the coding / settlement
//     axes say; held WITH a covering grant reads exactly as the same row
//     with no held match (its existing outcome); the earlier-checked axes
//     (a cascade that never landed, an open agent ask) keep precedence;
//   - the reader: only a LIVE 'suggested' row whose receipt is held by
//     materiality alone is held — and the inlined receipt reader is lock-step
//     with reconciliationLlmCore.isMatchedPendingAuthority;
//   - the adapters and the persisted-column gather (projectGatheredTransaction)
//     carry the input, so the column a writer persists and the nightly
//     recompute derive the same verdict.
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERGENCE_STATES,
  __isHeldPendingAuthorityReceipt,
  collectHeldPendingAuthorityMatches,
  convergenceForReviewItem,
  convergenceForTransaction,
  deriveConvergenceState,
  projectGatheredTransaction
} from './reconcileConvergenceState.js';
import { isMatchedPendingAuthority } from './reconciliationLlmCore.js';

const HELD_RECEIPT = Object.freeze({
  band: 'suggested',
  reasons: ['above_materiality_ceiling'],
  gates: { A: true, B: true, C: true, D: true, E: false }
});

// Rows a coding / settlement axis alone would read finished or otherwise.
const BASES = [
  { label: 'coding applied', input: { codingState: 'applied' } },
  { label: 'coding posted', input: { codingState: 'posted' } },
  { label: 'settled match, coded', input: { reconciliationStatus: 'reconciled', codedAccount: '7100' } },
  { label: 'explained', input: { reconciliationStatus: 'explained' } },
  { label: 'auto-explain disposition', input: { disposition: 'auto_explain' } },
  { label: 'pending, uncoded', input: { reconciliationStatus: 'pending' } },
  { label: 'coding proposed', input: { codingState: 'proposed' } },
  { label: 'open owner ask', input: { codingState: 'applied', hasOpenOwnerAsk: true } }
];

test('held with no covering grant hangs under matched_pending_authority_no_grant on every base', () => {
  for (const { label, input } of BASES) {
    assert.deepEqual(
      deriveConvergenceState({ ...input, matchHeldPendingAuthority: true }),
      { state: 'hanging', reason: 'matched_pending_authority_no_grant' },
      label
    );
  }
});

test('held with a covering grant keeps the outcome the row has with no held match', () => {
  for (const { label, input } of BASES) {
    assert.deepEqual(
      deriveConvergenceState({ ...input, matchHeldPendingAuthority: true, hasCoveringAuthorityGrant: true }),
      deriveConvergenceState(input),
      label
    );
  }
  // A grant flag with nothing held changes nothing either.
  for (const { label, input } of BASES) {
    assert.deepEqual(deriveConvergenceState({ ...input, hasCoveringAuthorityGrant: true }), deriveConvergenceState(input), label);
  }
});

test('the axes checked ahead of the held match keep precedence', () => {
  assert.deepEqual(deriveConvergenceState({ codingState: 'applied', matchHeldPendingAuthority: true, cascadeState: 'failed' }),
    { state: 'hanging', reason: 'cascade_failed' });
  assert.deepEqual(deriveConvergenceState({ codingState: 'applied', matchHeldPendingAuthority: true, hasOpenAgentAsk: true }),
    { state: 'hanging', reason: 'agent_ask_unanswered' });
  // A verified review-only scope never reads terminal; held keeps its own key.
  assert.deepEqual(deriveConvergenceState({ codingState: 'applied', matchHeldPendingAuthority: true, processingScope: { enforced: true, reason_code: 'processing_review_only' } }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
});

test('every projected state is one of the three, and held is never terminal', () => {
  for (const { input } of BASES) {
    for (const held of [false, true]) {
      for (const covered of [false, true]) {
        const p = deriveConvergenceState({ ...input, matchHeldPendingAuthority: held, hasCoveringAuthorityGrant: covered });
        assert.ok(CONVERGENCE_STATES.includes(p.state), JSON.stringify(p));
        if (held && !covered) assert.equal(p.state, 'hanging');
      }
    }
  }
});

test('LOCK-STEP: the inlined held receipt reader equals reconciliationLlmCore.isMatchedPendingAuthority', () => {
  const fixtures = [
    null, undefined, 'suggested', {}, HELD_RECEIPT,
    { band: 'suggested', reasons: ['above_materiality_ceiling'] },
    { band: 'suggested', reasons: ['above_materiality_ceiling', 'ambiguous_second_best'] },
    { band: 'suggested', reasons: [] },
    { band: 'suggested', reasons: 'above_materiality_ceiling' },
    { band: 'auto_matched', reasons: ['above_materiality_ceiling'] },
    { band: 'auto_matched', reasons: ['delegated_authority'] },
    { band: 'suggested', reasons: ['below_confidence_floor'] }
  ];
  for (const f of fixtures) {
    assert.equal(__isHeldPendingAuthorityReceipt(f), isMatchedPendingAuthority(f), JSON.stringify(f));
  }
});

test('collectHeldPendingAuthorityMatches reads only live suggested rows held by materiality alone', () => {
  const rows = [
    { id: 'm1', status: 'suggested', bank_transaction_id: 'tx-1', payload: { authorization: HELD_RECEIPT } },
    { id: 'm2', status: 'suggested', bank_transaction_id: 'tx-1', payload: { authorization: HELD_RECEIPT } },
    { id: 'm3', status: 'confirmed', bank_transaction_id: 'tx-2', payload: { authorization: HELD_RECEIPT } },
    { id: 'm4', status: 'auto_matched', bank_transaction_id: 'tx-3', payload: { authorization: { ...HELD_RECEIPT, band: 'auto_matched', reasons: ['delegated_authority'] } } },
    { id: 'm5', status: 'rejected', bank_transaction_id: 'tx-4', payload: { authorization: HELD_RECEIPT } },
    { id: 'm6', status: 'suggested', bank_transaction_id: 'tx-5', payload: { authorization: { band: 'suggested', reasons: ['ambiguous_second_best'] } } },
    { id: 'm7', status: 'suggested', bank_transaction_id: 'tx-6', payload: {} },
    { id: 'm8', status: 'suggested', bank_transaction_id: null, payload: { authorization: HELD_RECEIPT } }
  ];
  assert.deepEqual([...collectHeldPendingAuthorityMatches(rows)], [['tx-1', ['m1', 'm2']]]);
  assert.deepEqual([...collectHeldPendingAuthorityMatches(null)], []);
});

test('the adapters carry the held and covering-grant inputs', () => {
  const tx = { id: 'tx-1', coding_state: 'applied', account_code: '7100' };
  assert.deepEqual(convergenceForTransaction(tx), { state: 'auto_reconciled', reason: 'coding_state:applied' });
  assert.deepEqual(convergenceForTransaction(tx, { matchHeldPendingAuthority: true }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  assert.deepEqual(convergenceForTransaction(tx, { matchHeldPendingAuthority: true, hasCoveringAuthorityGrant: true }),
    { state: 'auto_reconciled', reason: 'coding_state:applied' });
  const item = { payload: { transaction_id: 'tx-1' } };
  assert.deepEqual(convergenceForReviewItem(item, tx, { matchHeldPendingAuthority: true }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  assert.deepEqual(convergenceForReviewItem(item, tx, { matchHeldPendingAuthority: true, hasCoveringAuthorityGrant: true }),
    convergenceForReviewItem(item, tx));
});

test('the persisted-column gather feeds the held input from the gathered matches', () => {
  const gathered = (matches, extra = {}) => ({
    id: 'tx-1', client_id: 'client-1', status: 'categorized', reconciliation_status: 'pending',
    account_code: '7100', coding_state: 'applied', payload: {}, review_items: [], evaluations: [], asks: [],
    goal_report: null, matches, ...extra
  });
  const held = (id) => ({ id, status: 'suggested', bank_transaction_id: 'tx-1', matched_object_type: 'supplier_bill', matched_object_id: `doc-${id}`, payload: { authorization: HELD_RECEIPT } });

  assert.deepEqual(projectGatheredTransaction(gathered([])), { state: 'auto_reconciled', reason: 'coding_state:applied' });
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1')])),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1')]), { coveredHeldMatchIds: new Set(['m1']) }),
    { state: 'auto_reconciled', reason: 'coding_state:applied' });
  // Every held match on the line must be covered.
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1'), held('m2')]), { coveredHeldMatchIds: new Set(['m1']) }),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
  // A decided match is not held.
  assert.deepEqual(projectGatheredTransaction(gathered([{ ...held('m1'), status: 'confirmed' }])),
    { state: 'auto_reconciled', reason: 'coding_state:applied' });
  // Through the review-item adapter too.
  assert.deepEqual(projectGatheredTransaction(gathered([held('m1')], { review_items: [{ id: 'q1', payload: { transaction_id: 'tx-1' } }] })),
    { state: 'hanging', reason: 'matched_pending_authority_no_grant' });
});
