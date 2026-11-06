import test from 'node:test';
import assert from 'node:assert/strict';
import { freezeJevShadowBudget } from './jevExperimentPolicy.js';
import { getLane } from './modelLanes.js';
import { setLaneDecidingPolicy } from './modelLanePolicy.js';

export const shadowBudget = () => ({ model: 'fixture-review-model', max_calls: 2,
  max_input_tokens: 1000, max_output_tokens: 100, approved_usd: 0.1,
  input_usd_per_million: 5, output_usd_per_million: 25,
  approval_basis: 'recorded local trial approval', price_source: 'fixture-price-record',
  coverage: ['matching', 'coding'], versions: { packet: 'fixture-packet-v1', action: 'fixture-action-v1' } });

test('desktop qualification does not qualify arbitrary configured trial models or unscoped seats', async () => {
  assert.deepEqual(getLane('jev_reconciliation').qualified, ['jev-1.13.0']);
  assert.equal(getLane('jev_reconciliation').experimental.clientOnly, true);
  const options = { client: { query: async () => ({ rows: [] }) }, firmId: 'f', laneId: 'jev_reconciliation',
    decidingModel: 'fixture-model', env: { TYPESAFE_MODEL: 'fixture-model' } };
  await assert.rejects(() => setLaneDecidingPolicy({ ...options, basis: 'promotion' }), { code: 'MODEL_NOT_QUALIFIED' });
  await assert.rejects(() => setLaneDecidingPolicy(options), { code: 'EXPERIMENT_AUTHORITY_REQUIRED' });
  await assert.rejects(() => setLaneDecidingPolicy({ ...options, clientId: 'c', actorType: 'firm_member', actorId: 'a', reason: 'approved' }), { code: 'EXPERIMENT_AUTHORITY_REQUIRED' });
});

test('a frozen shadow budget verifies cash against every reserved call and retains explicit coverage', () => {
  const budget = freezeJevShadowBudget(shadowBudget());
  assert.equal(budget.maximum_usd, 0.015);
  assert.deepEqual(budget.coverage, ['matching', 'coding']);
  assert.match(budget.sha256, /^[a-f0-9]{64}$/);
  assert.throws(() => freezeJevShadowBudget({ ...shadowBudget(), approved_usd: 0.001 }), { code: 'jev_shadow_budget_exceeds_approval' });
  assert.throws(() => freezeJevShadowBudget({ ...shadowBudget(), coverage: [] }), { code: 'jev_shadow_invalid_budget' });
  assert.equal(freezeJevShadowBudget(null), null, 'no shadow budget means no paid shadow');
});
