import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { admitMutationReceipts } from './eval_world_mutation_receipt_admission.js';
import { buildExpectedClose, readProof0PolicyPack } from '../server/donna/world/oracleSuite.js';
import { validateWorldSpec } from '../server/donna/world/worldSchema.js';
import { evaluateTerminalAdmission } from './eval_world_terminal_admission.js';

const asOf = new Date('2026-08-19T00:00:00Z');
const grant = { action: 'accept_match', status: 'active', correction_count: 0, amount_ceiling: '1000', currency: 'GBP', valid_from: '2026-01-01T00:00:00Z', expires_at: null, review_after: null };
const context = { matchAmount: 100, currency: 'GBP', action: 'accept_match', asOf };
const receipt = (id, overrides = {}) => ({
  mutation_id: id,
  world_id: 'world/one',
  action: 'accept_match',
  actor: { id: 'principal/donna-runtime', type: 'service_principal' },
  authority_basis: {
    kind: 'delegated_reconciliation_grant', principal_id: 'principal/donna-runtime',
    action: 'accept_match', grant, context,
  },
  ...overrides,
});

test('admits only a per-mutation real actor and covering delegated grant receipt', () => {
  const verdict = admitMutationReceipts({ worldId: 'world/one', mutations: [receipt('mutation/1'), receipt('mutation/2')] });
  assert.equal(verdict.admitted, true);
  assert.deepEqual(verdict.admitted_mutation_ids, ['mutation/1', 'mutation/2']);
  assert.deepEqual(verdict.production_proof, { status: 'pending', dependency: 'Unit 40' });
});

test('run-level attribution cannot fill an unattributed mutation', () => {
  const mutation = receipt('mutation/unattributed');
  delete mutation.actor;
  const verdict = admitMutationReceipts({ worldId: 'world/one', actor: { id: 'principal/run' }, mutations: [mutation] });
  assert.equal(verdict.admitted, false);
  assert.ok(verdict.blockers.some(({ reason }) => reason === 'actor_missing'));
});

test('duplicate mutation receipt identities fail admission', () => {
  const verdict = admitMutationReceipts({ worldId: 'world/one', mutations: [receipt('mutation/same'), receipt('mutation/same')] });
  assert.equal(verdict.admitted, false);
  assert.ok(verdict.blockers.some(({ reason }) => reason === 'mutation_id_duplicate'));
});

for (const [name, mutate, reason] of [
  ['system actor id', (value) => { value.actor.id = 'system'; }, 'system_actor_forbidden'],
  ['missing authority', (value) => { delete value.authority_basis; }, 'authority_basis_missing'],
  ['wrong authority action', (value) => { value.authority_basis.action = 'post_journal'; }, 'authority_action_contradiction'],
  ['wrong authority principal', (value) => { value.authority_basis.principal_id = 'principal/other'; }, 'authority_principal_contradiction'],
  ['non-covering grant', (value) => { value.authority_basis.grant = { ...grant, status: 'suspended' }; }, 'delegated_authority_not_covering'],
]) test(`fails closed on ${name}`, () => {
  const value = receipt('mutation/refused');
  mutate(value);
  const verdict = admitMutationReceipts({ worldId: 'world/one', mutations: [value] });
  assert.equal(verdict.admitted, false);
  assert.ok(verdict.blockers.some((entry) => entry.reason === reason));
});

test('a family world can pass Unit 45 for every mutation yet fail receipt admission independently', async () => {
  const world = JSON.parse(await readFile('data/worlds/slice1-gross-to-net-single.json', 'utf8'));
  assert.equal(validateWorldSpec(world).ok, true);
  const expected = buildExpectedClose(world, await readProof0PolicyPack());
  assert.equal(expected.ok, true);
  const mutationIds = [...new Set(expected.expectedEntries.map(({ eventId }) => eventId))];

  const terminalVerdicts = await Promise.all(mutationIds.map((itemId) => evaluateTerminalAdmission({
    itemId, confidence: 0.95, targetState: {}, authorityGrant: grant, authorityContext: context,
    period: { locked: false, label: '2026-08', journal_date: '2026-08-19' },
    persisted: { reconciliationStatus: 'explained' },
  })));
  assert.ok(terminalVerdicts.every(({ admitted, verdict }) => admitted && verdict === 'auto_post'));

  const mutations = mutationIds.map((eventId, index) => receipt(`mutation/${eventId}`, {
    world_id: world.worldId,
    ...(index === mutationIds.length - 1 ? { actor: undefined } : {}),
  }));
  const attributionVerdict = admitMutationReceipts({
    worldId: world.worldId,
    actor: { id: 'principal/run-level-is-not-evidence', type: 'service_principal' },
    mutations,
  });
  assert.equal(attributionVerdict.admitted, false);
  assert.deepEqual(attributionVerdict.blockers.filter(({ reason }) => reason === 'actor_missing'), [
    { mutation_id: mutations.at(-1).mutation_id, reason: 'actor_missing' },
  ]);
});
