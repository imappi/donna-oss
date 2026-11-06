import test from 'node:test';
import assert from 'node:assert/strict';
import { HOSTED_PILOT_VERSION, INTERNAL_PILOT_ACCESS_FLAG, isInternalPilotRow,
  isInternalPilotRestrictionRow, readInternalPilotAccessWithClient } from './internalPilotAccess.js';

const grant = { client_id: 'a', flag_key: INTERNAL_PILOT_ACCESS_FLAG, stage: 'canary', source: 'manual', reason: HOSTED_PILOT_VERSION, valid_to: null };
test('only exact live manual client grants open pilot access; revocation retains send containment', () => {
  assert.equal(isInternalPilotRow(grant), true);
  for (const patch of [{ client_id: null }, { source: 'default' }, { reason: 'unrelated' }, { valid_to: '2026-01-01' }, { stage: 'off' }, { stage: 'auto' }]) {
    assert.equal(isInternalPilotRow({ ...grant, ...patch }), false);
  }
  assert.equal(isInternalPilotRestrictionRow({ ...grant, stage: 'off' }), true);
  assert.equal(isInternalPilotRestrictionRow({ ...grant, valid_to: '2026-01-01' }), true);
});
test('pilot loader binds both firm and client, and propagates unavailable authority', async () => {
  let values;
  assert.equal(await readInternalPilotAccessWithClient({ query: async (_sql, args) => { values = args; return { rows: [grant] }; } }, { firmId: 'f', clientId: 'a' }), true);
  assert.deepEqual(values, ['f', 'a', INTERNAL_PILOT_ACCESS_FLAG, false]);
  await assert.rejects(readInternalPilotAccessWithClient({ query: async () => { throw new Error('database unavailable'); } }, { firmId: 'f', clientId: 'a' }), /database unavailable/);
});
