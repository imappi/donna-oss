import assert from 'node:assert/strict';
import test from 'node:test';

import { shrinkFailingWorld, SHRINKER_VERSION } from './shrinker.js';
import { createProof0WorldSpec } from './worldSchema.js';

const FAILURE = Object.freeze({
  failureClass: 'fee_as_revenue',
  earliestObservableDivergence: { stage: 'tool_calls_and_arithmetic', expectedState: 'fee_expense', observedState: 'sales_revenue', confidence: 'high' },
  consequence: { accounting: 'sales_overstated' },
});

function world() {
  return createProof0WorldSpec({
    worldId: 'proof0/shrink', seed: 'fixed-seed', effectiveDate: '2026-08-05',
    entities: [{ id: 'entity/client', activeFrom: '2026-01-01' }],
    events: [
      { id: 'event/noise', type: 'supplier_charge', legalEntityId: 'entity/client', occurredAt: '2026-08-01', causalParents: [] },
      { id: 'event/settlement', type: 'processor_settlement', legalEntityId: 'entity/client', occurredAt: '2026-08-05', causalParents: [], monetaryEffects: { grossReceipts: 102, fees: 2, settled: 100 } },
    ],
    observations: [
      { id: 'observation/noise', eventId: 'event/noise', observedAt: '2026-08-01' },
      { id: 'observation/settlement', eventId: 'event/settlement', observedAt: '2026-08-05' },
    ], hiddenFacts: [], artifacts: [],
  });
}

test('reproducibly removes irrelevant records but preserves failure, divergence, and consequence', async () => {
  const predicate = (candidate) => candidate.events.some(({ id }) => id === 'event/settlement') ? FAILURE : null;
  const first = await shrinkFailingWorld({ worldSpec: world(), failureReceipt: FAILURE, evaluateFailure: predicate });
  const second = await shrinkFailingWorld({ worldSpec: world(), failureReceipt: FAILURE, evaluateFailure: predicate });

  assert.equal(first.ok, true);
  assert.equal(first.version, SHRINKER_VERSION);
  assert.deepEqual(first.world.events.map(({ id }) => id), ['event/settlement']);
  assert.deepEqual(first.world.observations.map(({ id }) => id), []);
  assert.equal(first.digest, second.digest);
  assert.deepEqual(first.removed, second.removed);
});

test('refuses a reduction when consequence changes even if the failure class still matches', async () => {
  const changed = { ...FAILURE, consequence: { accounting: 'different_harm' } };
  const output = await shrinkFailingWorld({ worldSpec: world(), failureReceipt: FAILURE, evaluateFailure: (candidate) => candidate.events.length === 1 ? changed : FAILURE });
  assert.equal(output.world.events.length, 2);
});

test('quarantines nondeterministic and throwing predicates without accepting their minima', async () => {
  let calls = 0;
  const output = await shrinkFailingWorld({
    worldSpec: world(), failureReceipt: FAILURE,
    evaluateFailure: () => (++calls === 1 ? FAILURE : { ...FAILURE, consequence: { accounting: 'flipped' } }),
  });
  assert.equal(output.world.events.length, 2);
  assert.equal(output.quarantine[0].reason, 'predicate_nondeterministic');

  const thrown = await shrinkFailingWorld({ worldSpec: world(), failureReceipt: FAILURE, evaluateFailure: () => { throw new Error('offline runner unavailable'); } });
  assert.equal(thrown.ok, true);
  assert.equal(thrown.quarantine[0].reason, 'predicate_error');
});

test('rejects malformed inputs and boundary evaluation budgets without invoking callbacks', async () => {
  let invoked = false;
  const malformed = await shrinkFailingWorld({ worldSpec: null, failureReceipt: {}, evaluateFailure: () => { invoked = true; } , maxEvaluations: 1 });
  assert.equal(malformed.ok, false);
  assert.deepEqual(malformed.errors, [
    'worldSpec must be an object',
    'maxEvaluations must be a safe integer of at least 2',
    'failureReceipt must name failureClass, earliestObservableDivergence, and consequence',
  ]);
  assert.equal(invoked, false);

  const exhausted = await shrinkFailingWorld({ worldSpec: world(), failureReceipt: FAILURE, evaluateFailure: () => FAILURE, maxEvaluations: 2 });
  assert.equal(exhausted.ok, true);
  assert.equal(exhausted.exhausted, true);
  assert.equal(exhausted.evaluations, 2);
});
