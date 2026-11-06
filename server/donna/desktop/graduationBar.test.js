// graduationBar + modelPolicy — the v2.1 §7 graduation layer over the
// existing evalHarness. What must hold: both gates gate independently;
// gate 1 is parity on wrong-commits, gate 2 is a stated delta on
// owner-question frequency; errored cases count as interruptions, never as
// commits; thin evidence is 'insufficient_evidence', not a verdict;
// cross-suite comparison refuses; and ledger_commit can never be routed to
// a model or graduated, in any policy, whoever authored it.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_GRADUATION_BAR, GRADUATION_CAPABILITIES, LEDGER_COMMIT_CAPABILITY,
  assessGraduation, deriveGateMetrics
} from './graduationBar.js';
import {
  CURRENT_MODEL_POLICY, MODEL_POLICY_FORMAT, resolveQualifiedBackends, validateModelPolicy
} from './modelPolicy.js';

const blob = ({ model, fixtures = 100, fp = 0, fn = 0, errored = 0, suite = 'reconciliation' }) => ({
  suite,
  model,
  ranAt: '2026-08-03T12:00:00Z',
  totals: { fixtures, errored, false_positive: fp, false_negative: fn },
  metrics: {}
});

test('deriveGateMetrics: FP → wrong-commit rate; FN + errored → abstention rate', () => {
  const m = deriveGateMetrics(blob({ model: 'candidate-x', fixtures: 100, fp: 3, fn: 10, errored: 2 }));
  assert.equal(m.wrong_commit_rate, 0.03);
  assert.equal(m.abstention_rate, 0.12, 'an errored case commits nothing — it is an interruption');
  assert.equal(m.model, 'candidate-x');
});

test('qualified: at parity on gate 1 and inside the stated delta on gate 2', () => {
  const verdict = assessGraduation({
    capability: 'reconciliation_matching',
    baseline: blob({ model: 'opus-baseline', fp: 4, fn: 10 }),
    candidate: blob({ model: 'open-weights-9000', fp: 4, fn: 18 })
  });
  assert.equal(verdict.verdict, 'qualified');
  assert.equal(verdict.gate1.pass, true);
  assert.equal(verdict.gate2.pass, true);
  assert.equal(verdict.gate1.distance, 0);
});

test('gate 1 fails alone: a model that commits wrong MORE than baseline never graduates, however quiet it is', () => {
  const verdict = assessGraduation({
    capability: 'reconciliation_matching',
    baseline: blob({ model: 'baseline', fp: 4, fn: 10 }),
    candidate: blob({ model: 'confident-but-wrong', fp: 9, fn: 5 })
  });
  assert.equal(verdict.verdict, 'not_qualified');
  assert.equal(verdict.gate1.pass, false);
  assert.equal(verdict.gate2.pass, true);
  assert.equal(verdict.gate1.distance, 0.05, 'distance-to-bar is the number the lane tracks');
});

test('gate 2 fails alone: safety bought by interrogating the owner does not graduate either', () => {
  const verdict = assessGraduation({
    capability: 'reconciliation_matching',
    baseline: blob({ model: 'baseline', fp: 4, fn: 10 }),
    candidate: blob({ model: 'asks-everything', fp: 0, fn: 35 })
  });
  assert.equal(verdict.verdict, 'not_qualified');
  assert.equal(verdict.gate1.pass, true);
  assert.equal(verdict.gate2.pass, false);
  assert.equal(verdict.gate2.allowed, 0.2, 'baseline 0.10 + stated delta 0.10');
});

test('thin evidence is insufficient_evidence, not a verdict', () => {
  const verdict = assessGraduation({
    capability: 'reconciliation_matching',
    baseline: blob({ model: 'b', fixtures: 5 }),
    candidate: blob({ model: 'c', fixtures: 5 })
  });
  assert.equal(verdict.verdict, 'insufficient_evidence');
  assert.equal(verdict.gate1, null);
});

test('cross-suite comparison refuses — the bar compares runs on the same fixtures', () => {
  assert.throws(
    () => assessGraduation({
      capability: 'reconciliation_matching',
      baseline: blob({ model: 'b', suite: 'reconciliation' }),
      candidate: blob({ model: 'c', suite: 'extraction' })
    }),
    /SAME fixtures/
  );
});

test('ledger_commit can never graduate, and unknown capabilities refuse', () => {
  assert.throws(
    () => assessGraduation({ capability: LEDGER_COMMIT_CAPABILITY, baseline: blob({ model: 'b' }), candidate: blob({ model: 'c' }) }),
    /deterministic-kernel-only/
  );
  assert.throws(
    () => assessGraduation({ capability: 'vibes', baseline: blob({ model: 'b' }), candidate: blob({ model: 'c' }) }),
    /Unknown graduation capability/
  );
});

test('the current static policy validates, covers every capability, and is bridge-legal', () => {
  assert.equal(validateModelPolicy(CURRENT_MODEL_POLICY), true);
  assert.equal(CURRENT_MODEL_POLICY.state, 'bridge');
  for (const capability of GRADUATION_CAPABILITIES) {
    const qualified = resolveQualifiedBackends(CURRENT_MODEL_POLICY, capability);
    assert.ok(qualified.some((b) => b.provider === 'anthropic' || b.provider === 'openai'),
      `${capability}: bridge requires a qualified cloud backend`);
    assert.ok(!qualified.some((b) => b.provider === 'local_openai_compatible'),
      `${capability}: the local slot is experimental until the bar says otherwise`);
  }
});

test('a policy routing ledger_commit to a model is invalid, whoever signed it', () => {
  const rogue = {
    format: MODEL_POLICY_FORMAT,
    state: 'bridge',
    as_of: '2026-08-03',
    capabilities: {
      ...CURRENT_MODEL_POLICY.capabilities,
      [LEDGER_COMMIT_CAPABILITY]: { qualified: [{ provider: 'anthropic' }] }
    }
  };
  assert.throws(() => validateModelPolicy(rogue), /deterministic kernel/);
  assert.throws(
    () => resolveQualifiedBackends(CURRENT_MODEL_POLICY, LEDGER_COMMIT_CAPABILITY),
    /deterministic-kernel-only/
  );
});

test('bridge state refuses a capability with no qualified cloud backend', () => {
  const localOnly = {
    format: MODEL_POLICY_FORMAT,
    state: 'bridge',
    as_of: '2026-08-03',
    capabilities: {
      ...CURRENT_MODEL_POLICY.capabilities,
      receipt_extraction: { qualified: [{ provider: 'local_openai_compatible' }], experimental: [] }
    }
  };
  assert.throws(() => validateModelPolicy(localOnly), /qualified cloud backend/);
});

test('the default bar values are the documented scaffold placeholders', () => {
  assert.deepEqual(DEFAULT_GRADUATION_BAR, { gate1_parity_epsilon: 0, gate2_stated_delta: 0.1, min_fixtures: 20 });
});
