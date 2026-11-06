import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  expectedTargetIds,
  expectedPinnedStatus,
  isNegativeFixture,
  tallyRun,
  emptyAcc,
  splitMetrics,
  fixtureStability
} from './eval_reconciliation_stability.js';

test('expectedTargetIds / expectedPinnedStatus / isNegativeFixture', () => {
  const exp = { proposals: [{ bank_transaction_id: 'a', status: 'auto_matched' }, { bank_transaction_id: 'b' }] };
  assert.deepEqual([...expectedTargetIds(exp)].sort(), ['a', 'b']);
  assert.deepEqual([...expectedPinnedStatus(exp).entries()], [['a', 'auto_matched']]); // only 'a' pins a status
  assert.equal(isNegativeFixture(exp), false);
  assert.equal(isNegativeFixture({ proposals: [] }), true);
  assert.equal(isNegativeFixture({}), true);
});

test('tallyRun + splitMetrics — id precision/recall, suggestion recall', () => {
  const exp = { proposals: [{ bank_transaction_id: 'a' }, { bank_transaction_id: 'b' }] };
  const acc = emptyAcc();
  // proposes a (correct) + c (wrong); misses b
  tallyRun(exp, { proposals: [
    { bank_transaction_id: 'a', confidence: 0.9, status: 'auto_matched' },
    { bank_transaction_id: 'c', confidence: 0.9, status: 'auto_matched' }
  ] }, acc);
  const m = splitMetrics(acc);
  assert.equal(m.id_precision, 0.5);   // 1 of 2 proposed ids correct
  assert.equal(m.id_recall, 0.5);      // 1 of 2 expected ids found
  assert.equal(m.suggestion_recall, 0.5);
});

test('splitMetrics — auto-match target precision + false-auto-match rate', () => {
  const exp = { proposals: [{ bank_transaction_id: 'a' }] };
  const acc = emptyAcc();
  // one correct auto-match (a), one CONFIDENT WRONG auto-match (c)
  tallyRun(exp, { proposals: [
    { bank_transaction_id: 'a', confidence: 0.95, status: 'auto_matched' },
    { bank_transaction_id: 'c', confidence: 0.9, status: 'auto_matched' }
  ] }, acc);
  const m = splitMetrics(acc);
  assert.equal(m.auto_match_target_precision, 0.5);
  assert.equal(m.false_auto_match_rate, 0.5); // half the confident matches are wrong targets
  assert.equal(m.auto_match_count, 2);
});

test('splitMetrics — no-match accuracy on negative fixtures', () => {
  const neg = { proposals: [], unmatchable_reason: '*' };
  const acc = emptyAcc();
  tallyRun(neg, { proposals: [] }, acc);                                   // correct abstention
  tallyRun(neg, { proposals: [{ bank_transaction_id: 'x', confidence: 0.9, status: 'auto_matched' }] }, acc); // false positive
  const m = splitMetrics(acc);
  assert.equal(m.no_match_accuracy, 0.5);
});

test('splitMetrics — authority-band accuracy only where gold pins a status', () => {
  const exp = { proposals: [{ bank_transaction_id: 'a', status: 'suggested' }, { bank_transaction_id: 'b' }] };
  const acc = emptyAcc();
  // 'a' pinned suggested; run returns it auto_matched (aggressive) -> band miss.
  // 'b' is status-agnostic -> not counted toward authority band.
  tallyRun(exp, { proposals: [
    { bank_transaction_id: 'a', confidence: 0.95, status: 'auto_matched' },
    { bank_transaction_id: 'b', confidence: 0.95, status: 'auto_matched' }
  ] }, acc);
  const m = splitMetrics(acc);
  assert.equal(m.authority_pinned_count, 1);     // only 'a'
  assert.equal(m.authority_band_accuracy, 0);    // aggressive miss
});

test('splitMetrics — null metrics when denominators are zero', () => {
  const m = splitMetrics(emptyAcc());
  assert.equal(m.id_precision, null);
  assert.equal(m.auto_match_target_precision, null);
  assert.equal(m.false_auto_match_rate, null);
  assert.equal(m.no_match_accuracy, null);
  assert.equal(m.authority_band_accuracy, null);
});

test('fixtureStability — agreement, variants, ranges, errors', () => {
  const stable = fixtureStability([
    { ok: true, ms: 100, proposals: [{ bank_transaction_id: 'a', confidence: 0.9, status: 'auto_matched' }] },
    { ok: true, ms: 200, proposals: [{ bank_transaction_id: 'a', confidence: 0.92, status: 'auto_matched' }] }
  ]);
  assert.equal(stable.target_variants, 1);
  assert.equal(stable.status_variants, 1);
  assert.equal(stable.confidence_min, 0.9);
  assert.equal(stable.confidence_max, 0.92);
  assert.equal(stable.errors, 0);

  const unstable = fixtureStability([
    { ok: true, ms: 100, proposals: [{ bank_transaction_id: 'a', confidence: 0.9, status: 'auto_matched' }] },
    { ok: true, ms: 200, proposals: [{ bank_transaction_id: 'b', confidence: 0.6, status: 'suggested' }] },
    { ok: false, ms: 50, error: 'boom', proposals: [] }
  ]);
  assert.equal(unstable.target_variants, 2);  // a vs b — the "picks different targets" pathology
  assert.equal(unstable.errors, 1);
});
