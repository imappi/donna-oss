// FE convergence-metrics view aggregator — unit tests (Slice J consumer).
//
// Properties: tallies the PERSISTED per-row convergence_state (never re-derives);
// dedupes one-per-tx with the review item winning over the bare tx; matches the
// backend convergenceMetrics shape; reason labels are humane and fall back tidily.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildConvergenceMetricsView, labelForHangingReason } from './convergenceMetricsView.js';

test('tallies attached verdicts; review item wins over the bare tx (no double-count)', () => {
  const transactions = [
    { id: 't1', convergence_state: 'auto_reconciled', convergence_reason: 'reconciliation_status:reconciled' },
    { id: 't2', convergence_state: 'auto_reconciled', convergence_reason: 'x' }, // overridden below
    { id: 't3', convergence_state: 'hanging', convergence_reason: 'matched_but_uncoded' },
  ];
  const reviewItems = [
    { item_id: 't2', payload: { transaction_id: 't2' }, convergence_state: 'on_owner', convergence_reason: 'open_owner_ask' },
    { item_id: 't4q', payload: { transaction_id: 't4' }, convergence_state: 'hanging', convergence_reason: 'review_state:suggested' },
  ];
  const m = buildConvergenceMetricsView({ transactions, reviewItems });
  assert.equal(m.total, 4);                 // t1,t2,t3,t4 — t2 counted once (item wins)
  assert.equal(m.auto_reconciled, 1);
  assert.equal(m.on_owner, 1);
  assert.equal(m.hanging, 2);
  assert.deepEqual(m.hanging_by_reason, { matched_but_uncoded: 1, 'review_state:suggested': 1 });
  assert.equal(m.prompts_per_100, 25);
  assert.equal(m.hanging_per_100, 50);
  assert.equal(m.converged, false);
});

test('authority_misses extracts the #5 reason; rows without a verdict are ignored; empty is zero-safe', () => {
  const m = buildConvergenceMetricsView({
    transactions: [
      { id: 'a', convergence_state: 'hanging', convergence_reason: 'matched_pending_authority_no_grant' },
      { id: 'b' }, // no verdict → ignored
    ],
  });
  assert.equal(m.authority_misses, 1);
  assert.equal(m.total, 1);

  const empty = buildConvergenceMetricsView({});
  assert.equal(empty.total, 0);
  assert.equal(empty.converged, true);
  assert.equal(empty.prompts_per_100, 0);
  assert.deepEqual(empty.hanging_by_reason, {});
});

test('labelForHangingReason: known keys, prefix:value, snake_case fallback', () => {
  assert.equal(labelForHangingReason('matched_pending_authority_no_grant'), 'Awaiting authority');
  assert.equal(labelForHangingReason('coding_state:proposed'), 'Proposed, not decided');
  assert.equal(labelForHangingReason('disposition:some_new_state'), 'Some new state'); // unmapped prefix:value
  assert.equal(labelForHangingReason('brand_new_reason'), 'Brand new reason');         // unmapped bare
  assert.equal(labelForHangingReason(''), 'Other');
});
