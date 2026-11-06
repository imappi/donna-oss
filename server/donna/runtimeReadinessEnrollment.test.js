import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_READINESS_ENROLLMENT_ACTION,
  ENTITY_READINESS_NEW_CLIENT_REASON,
  classifyEntityReadinessEnrollment,
  seedNewClientReadinessEnrollmentWithClient
} from './runtimeReadinessEnrollment.js';

test('readiness enrollment accepts only the two exact client-canary postures', () => {
  assert.deepEqual(classifyEntityReadinessEnrollment({
    stage: 'canary', source: 'manual', reason: 'target legacy entity 17'
  }), { valid: true, enrollment_kind: 'manual_target' });
  assert.deepEqual(classifyEntityReadinessEnrollment({
    stage: 'canary', source: 'default', reason: ENTITY_READINESS_NEW_CLIENT_REASON
  }), { valid: true, enrollment_kind: 'new_client_default' });

  for (const row of [
    null,
    { stage: 'shadow', source: 'manual', reason: 'observe' },
    { stage: 'canary', source: 'manual', reason: '' },
    { stage: 'canary', source: 'default', reason: 'arbitrary default' },
    { stage: 'auto', source: 'default', reason: ENTITY_READINESS_NEW_CLIENT_REASON }
  ]) {
    assert.deepEqual(classifyEntityReadinessEnrollment(row), {
      valid: false,
      enrollment_kind: null
    });
  }
});

const recordingClient = ({ existing = null } = {}) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      const text = String(sql);
      calls.push({ sql: text, params });
      if (text.includes('select id, flag_key, stage, source, reason')) {
        return { rows: existing ? [existing] : [] };
      }
      if (text.includes("'entity_readiness_enrollment'")) {
        return { rows: [{ id: 91, created_at: '2026-08-30T00:00:00.000Z' }] };
      }
      return { rows: [], rowCount: 1 };
    }
  };
};

test('new-client enrollment writes through the guarded config writer and emits a dated receipt', async () => {
  const client = recordingClient();
  const result = await seedNewClientReadinessEnrollmentWithClient(client, {
    firmId: 'firm-1',
    clientId: 'client-1'
  });
  assert.equal(result.applied, true);
  assert.equal(result.receipt_id, 91);
  const configInsert = client.calls.find(({ sql }) => sql.includes('insert into client_capability_config'));
  assert.ok(configInsert);
  assert.deepEqual(configInsert.params.slice(1, 7), [
    'firm-1',
    'client-1',
    'ENTITY_READINESS_ADMISSION',
    'canary',
    'default',
    ENTITY_READINESS_NEW_CLIENT_REASON
  ]);
  const receipt = client.calls.find(({ params }) => params?.[2] === ENTITY_READINESS_ENROLLMENT_ACTION);
  assert.ok(receipt);
  const metadata = JSON.parse(receipt.params[3]);
  assert.equal(metadata.enrollment_kind, 'new_client_default');
  assert.equal(metadata.authority_basis.decision_date, '2026-08-30');
  assert.equal(metadata.authority_basis.scope, 'new_desktop_clients_only');
  assert.equal(metadata.cloud_upload_enforcement, false);
});

test('new-client enrollment never supersedes a live decision', async () => {
  const existing = {
    id: 'cfg-existing', flag_key: 'ENTITY_READINESS_ADMISSION',
    stage: 'off', source: 'manual', reason: 'operator stop'
  };
  const client = recordingClient({ existing });
  const result = await seedNewClientReadinessEnrollmentWithClient(client, {
    firmId: 'firm-1', clientId: 'client-1'
  });
  assert.deepEqual(result, { applied: false, config_row: existing, receipt_id: null });
  assert.equal(client.calls.some(({ sql }) => sql.includes('insert into client_capability_config')), false);
});
