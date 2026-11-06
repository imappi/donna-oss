import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  AUTO_SUSPEND_ACTION, bindProductionOperations, createFakeAuthorityStore,
  driveClientReset, driveCorrectionLifecycle, productionOperations,
} from './eval_world_authority_lifecycle.js';

const correction = async () => JSON.parse(await readFile('data/worlds/slice2-correction-reopen.json', 'utf8')).events.find(({ type }) => type === 'owner_correction');

test('binds every real production primitive and fails closed on an incomplete boundary', () => {
  assert.equal(typeof productionOperations.suspendGrantAfterCorrection, 'function');
  assert.throws(() => bindProductionOperations({}), { code: 'EAW_AUTHORITY_BOUNDARY_INCOMPLETE' });
});

for (const status of ['proposed', 'suspended', 'revoked']) test(`${status} grants fail both production auto-accept guards`, async () => {
  const store = createFakeAuthorityStore(); const grant = store.addGrant({ status });
  assert.equal(productionOperations.grantRowAllowsAutoAccept(grant, { matchAmount: 500, currency: 'GBP', asOf: new Date('2026-08-19') }), false);
  const result = await productionOperations.findActiveAuthorityGrant({ client: store.client, firmId: store.state.firmId, clientId: store.state.clientId, authorization: { band: 'suggested', reasons: ['above_materiality_ceiling'], gates: { A: true, B: true, C: true, D: true, E: false } }, matchAmount: 500, currency: 'GBP', archetype: grant.archetype, scopeKey: grant.scope_key, asOf: new Date('2026-08-19'), configSnapshot: { RECONCILIATION_DELEGATED_AUTHORITY: { stage: 'auto' } }, env: {} });
  assert.equal(result, null);
});

test('an active covering grant is the pass fixture for both production guards', async () => {
  const store = createFakeAuthorityStore(); const grant = store.addGrant();
  assert.equal(productionOperations.grantRowAllowsAutoAccept(grant, { matchAmount: 500, currency: 'GBP', asOf: new Date('2026-08-19') }), true);
  const found = await productionOperations.findActiveAuthorityGrant({ client: store.client, firmId: store.state.firmId, clientId: store.state.clientId, authorization: { band: 'suggested', reasons: ['above_materiality_ceiling'], gates: { A: true, B: true, C: true, D: true, E: false } }, matchAmount: 500, currency: 'GBP', archetype: grant.archetype, scopeKey: grant.scope_key, asOf: new Date('2026-08-19'), configSnapshot: { RECONCILIATION_DELEGATED_AUTHORITY: { stage: 'auto' } }, env: {} });
  assert.equal(found.id, grant.id);
});

test('real correction producer persists suspension, counter and audit before refusing the next match', async () => {
  const store = createFakeAuthorityStore(); const grant = store.addGrant();
  const result = await driveCorrectionLifecycle({ store, ownerCorrection: await correction(), grantId: grant.id });
  assert.equal(result.persisted.status, 'suspended'); assert.equal(result.persisted.correction_count, 1);
  assert.equal(result.auditEvent.action, AUTO_SUSPEND_ACTION); assert.equal(result.auditEvent.metadata.correction_count, 1);
  assert.equal(result.nextMatch, null); assert.equal(result.rowAllowsAutoAccept, false);
});

test('the correction fixture fails closed when no real owner_correction drives the producer', async () => {
  const store = createFakeAuthorityStore(); const grant = store.addGrant();
  await assert.rejects(driveCorrectionLifecycle({ store, ownerCorrection: { type: 'answer' }, grantId: grant.id }), { code: 'EAW_OWNER_CORRECTION_REQUIRED' });
  assert.deepEqual(store.readGrant(grant.id), grant); assert.equal(store.state.auditEvents.length, 0);
});

test('the real producer bumps a revoked grant while preserving the stronger revoked state', async () => {
  const store = createFakeAuthorityStore(); const grant = store.addGrant({ status: 'revoked', correction_count: 2 });
  const result = await driveCorrectionLifecycle({ store, ownerCorrection: await correction(), grantId: grant.id });
  assert.equal(result.persisted.status, 'revoked'); assert.equal(result.persisted.correction_count, 3); assert.equal(result.nextMatch, null);
});

test('client reset receipts exact snapshots, purges them, and never silently re-arms', async () => {
  const store = createFakeAuthorityStore(); const grant = store.addGrant();
  store.state.flags.push({ flag_key: 'RECONCILIATION_DELEGATED_AUTHORITY', stage: 'auto', source: 'operator', reason: 'fixture', set_by_actor_type: 'operator', set_by_actor_id: 'owner/1', valid_from: '2026-08-19' });
  const result = await driveClientReset({ store });
  assert.deepEqual(result.before.grants.map(({ id }) => id), [grant.id]); assert.equal(result.before.flags.length, 1);
  assert.deepEqual(result.auditEvent.metadata.grants, result.before.grants); assert.deepEqual(result.auditEvent.metadata.flags, result.before.flags);
  assert.equal(result.receipt.recorded, true); assert.deepEqual(result.after, { flags: [], grants: [], action_grants: [], role_assignments: [] });
  assert.equal(store.state.grants.length, 0); assert.equal(store.state.flags.length, 0);
});

test('empty reset is the fail fixture: no fabricated purge receipt is recorded', async () => {
  const store = createFakeAuthorityStore();
  const result = await driveClientReset({ store });
  assert.equal(result.receipt.recorded, false); assert.equal(result.auditEvent, null);
});
