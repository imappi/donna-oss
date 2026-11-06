import assert from 'node:assert/strict';
import test from 'node:test';

import { HOST_CERTIFICATE_A_VERSION, buildHostCertificateFreshness } from './hostCertificateA.js';
import {
  ENTITY_READINESS_ADMISSION_ERROR,
  acquireEntityReadinessAdmissionLeaseWithClient,
  checkEntityReadinessAdmissionWithClient,
  evaluateEntityReadinessAdmissionWithClient,
  evaluateRetainedProcessingScopeWithClient,
  EntityReadinessAdmissionError,
  runWithEntityReadinessWorkerAdmission
} from './runtimeReadinessAdmission.js';
import { ENTITY_READINESS_NEW_CLIENT_REASON } from './runtimeReadinessEnrollment.js';
import { nativeBirthReceipt, nativeBirthAccounts } from './nativeChartLineage.js';

const AS_OF = '2026-08-30T12:00:00.000Z';
const healthyHost = () => ({
  latest_attempt_id: 9,
  compatibility_digest: 'host-compatible',
  certificate: {
    version: HOST_CERTIFICATE_A_VERSION,
    status: 'PASS',
    runtime_host: 'desktop',
    freshness: buildHostCertificateFreshness({ mintedAt: AS_OF })
  }
});
const readySaga = (overrides = {}) => ({
  saga_id: 'entity-saga-1',
  state: 'ready',
  ready_dependency_digest: 'entity-generation-1',
  observed_dependency_digest: 'entity-generation-1',
  latest_attempt_id: 7,
  root_cause_receipt_id: null,
  ...overrides
});

const clientFor = ({ flag = null, saga = readySaga(), host = healthyHost() } = {}) => {
  const calls = [];
  return {
    calls,
    end: async () => {},
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      if (String(sql).includes('from client_capability_config')) return { rows: flag ? [flag] : [] };
      if (String(sql).includes('from entity_readiness_sagas')) return { rows: saga ? [saga] : [] };
      if (String(sql).includes('from runtime_host_readiness h')) return { rows: host ? [host] : [] };
      if (String(sql).includes('insert into audit_events')) return { rows: [{ id: 99 }] };
      if (String(sql).includes('pg_advisory_unlock_shared')) return { rows: [{ released: true }] };
      return { rows: [] };
    }
  };
};

const evaluate = (client, overrides = {}) => evaluateEntityReadinessAdmissionWithClient({
  client,
  firmId: 'firm-1',
  clientId: 'client-1',
  boundary: 'ledger_write',
  asOf: AS_OF,
  ...overrides
});

test('missing/off/shadow readiness rows do not enroll a legacy client', async () => {
  for (const stage of [null, 'off', 'shadow']) {
    const client = clientFor({
      flag: stage ? {
        flag_key: 'ENTITY_READINESS_ADMISSION', stage, source: 'manual', reason: 'test'
      } : null
    });
    const result = await evaluate(client);
    assert.equal(result.allowed, true);
    assert.equal(result.enforced, false);
    assert.equal(client.calls.some(({ sql }) => sql.includes('entity_readiness_sagas')), false);
  }
});

test('an explicit manual canary with reason reaches the ready entity + Host A check', async () => {
  const client = clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'manual', reason: 'isolated EAW canary'
    }
  });
  const result = await evaluate(client);
  assert.equal(result.allowed, true);
  assert.equal(result.enforced, true);
  assert.equal(result.enrollment_kind, 'manual_target');
  assert.equal(result.entity_dependency_digest, 'entity-generation-1');
  assert.ok(client.calls.some(({ sql }) => sql.includes('for share')));
});

test('the exact source-controlled new-client canary acts without admitting arbitrary defaults', async () => {
  const admitted = await evaluate(clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'default',
      reason: ENTITY_READINESS_NEW_CLIENT_REASON
    }
  }));
  assert.equal(admitted.allowed, true);
  assert.equal(admitted.enforced, true);
  assert.equal(admitted.enrollment_kind, 'new_client_default');

  const arbitrary = await evaluate(clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'default', reason: 'too broad'
    }
  }));
  assert.equal(arbitrary.allowed, false);
  assert.equal(arbitrary.reason_code, 'readiness_admission_flag_posture_invalid');
});

test('acting but invalid posture, stale generation and stale signed claim fail with stable reasons', async () => {
  const invalidPosture = await evaluate(clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'auto', source: 'default',
      reason: ENTITY_READINESS_NEW_CLIENT_REASON
    }
  }));
  assert.equal(invalidPosture.reason_code, 'readiness_admission_flag_posture_invalid');

  const flag = {
    flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'manual', reason: 'isolated EAW canary'
  };
  const stale = await evaluate(clientFor({
    flag,
    saga: readySaga({ observed_dependency_digest: 'entity-generation-2' })
  }));
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason_code, 'entity_dependency_digest_changed');

  const tokenStale = await evaluate(clientFor({ flag }), {
    expectedDependencyDigest: 'entity-generation-old'
  });
  assert.equal(tokenStale.reason_code, 'entity_generation_changed');
});

test('blocked admission appends a system-owned recovery receipt and throws a retryable 503', async () => {
  const client = clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'manual', reason: 'isolated EAW canary'
    },
    saga: readySaga({ state: 'failed', reason_code: 'entity_dependency_changed' })
  });
  const decision = await checkEntityReadinessAdmissionWithClient({
    client, firmId: 'firm-1', clientId: 'client-1', boundary: 'ask_send', asOf: AS_OF
  });
  assert.equal(decision.allowed, false);
  const audit = client.calls.find(({ sql }) => sql.includes('insert into audit_events'));
  assert.ok(audit);
  assert.deepEqual(audit.params.slice(6), ['system', 'entityReadinessAdmission']);
  assert.equal(JSON.parse(audit.params[5]).retryable, true);
  const error = new EntityReadinessAdmissionError(decision);
  assert.equal(error.code, ENTITY_READINESS_ADMISSION_ERROR);
  assert.equal(error.statusCode, 503);
  assert.equal(error.retryable, true);
});

test('enforced non-transactional reconciliation takes and releases the shared entity lease', async () => {
  const client = clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'manual', reason: 'isolated EAW canary'
    }
  });
  const lease = await acquireEntityReadinessAdmissionLeaseWithClient({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    boundary: 'reconciliation_authority',
    asOf: AS_OF
  });
  assert.equal(lease.decision.allowed, true);
  await lease.release();
  assert.ok(client.calls.some(({ sql }) => sql.includes('pg_advisory_lock_shared')));
  assert.ok(client.calls.some(({ sql }) => sql.includes('pg_advisory_unlock_shared')));
});

test('independently pooled worker coordinators fence discovery without holding a session lease', async () => {
  const liveHost = healthyHost();
  liveHost.certificate.freshness = buildHostCertificateFreshness({ mintedAt: new Date().toISOString() });
  const client = clientFor({
    flag: {
      flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'manual', reason: 'isolated EAW canary'
    },
    host: liveHost
  });
  let ran = false;
  await runWithEntityReadinessWorkerAdmission({
    client,
    firmId: 'firm-1',
    clientId: 'client-1',
    leaseAcrossWork: false,
    work: async () => { ran = true; }
  });
  assert.equal(ran, true);
  assert.ok(client.calls.some(({ sql }) => sql === 'begin'));
  assert.ok(client.calls.some(({ sql }) => sql === 'commit'));
  assert.equal(client.calls.some(({ sql }) => sql.includes('pg_advisory_lock_shared')), false);
});


test('a known Supabase transaction endpoint refuses a session lease before work without exposing its address', async () => {
  const client = clientFor({ flag: {
    flag_key: 'ENTITY_READINESS_ADMISSION', stage: 'canary', source: 'manual', reason: 'pool compatibility proof'
  } });
  client.connectionParameters = { host: 'aws-0-secret-location.pooler.supabase.com', port: 6543, user: 'secret-user', password: 'secret-password' };
  await assert.rejects(acquireEntityReadinessAdmissionLeaseWithClient({
    client, firmId: 'firm-1', clientId: 'client-1', boundary: 'reconciliation_authority', asOf: AS_OF
  }), error => {
    assert.equal(error.code, 'ADMISSION_SESSION_POOLING_UNSUPPORTED');
    assert.equal(error.responsible_system, 'donna_database_connection');
    assert.deepEqual(error.connection, { port: 6543, inferred_pool_mode: 'supabase_transaction' });
    assert.doesNotMatch(JSON.stringify(error), /secret/);
    return true;
  });
  assert.equal(client.calls.some(({ sql }) => sql.includes('pg_advisory_lock_shared')), false);
});

// 2026-09-16: the refusal copy names the real condition. Only a scheduled
// retry or a host re-check is a "recovery"; an exhausted saga says it could
// not finish and points at Retry, and a failed one says it is retrying.
test('admission refusals describe exhausted, failed and recovering states honestly', async () => {
  const { describeEntityReadinessAdmission, EntityReadinessAdmissionError } = await import('./runtimeReadinessAdmission.js');
  assert.match(describeEntityReadinessAdmission({ reason_code: 'ownership_actor', saga_state: 'failed', retry_state: 'exhausted' }), /could not finish preparing this company .*\(ownership_actor\).*Retry/);
  assert.match(describeEntityReadinessAdmission({ reason_code: 'ownership_actor', saga_state: 'failed', retry_state: 'scheduled' }), /failed \(ownership_actor\) and is being retried automatically/);
  assert.match(describeEntityReadinessAdmission({ reason_code: 'host_readiness_not_ready', saga_state: 'failed', retry_state: 'scheduled' }), /completing a runtime readiness recovery/);
  assert.match(describeEntityReadinessAdmission({ reason_code: 'entity_dependency_digest_changed', saga_state: 'ready' }), /completing a runtime readiness recovery/);
  assert.match(new EntityReadinessAdmissionError({ reason_code: 'legacy_uncertified' }).message, /completing a runtime readiness recovery/);
  assert.equal(new EntityReadinessAdmissionError({ reason_code: 'x', saga_state: 'failed', retry_state: 'exhausted' }).statusCode, 503);
});

test('retained native scope precedes flag-off and is shared by correction/close; marked corruption never becomes legacy', async () => {
  const firmId = 'firm-1', clientId = 'client-1';
  const company = { id: clientId, firm_id: firmId, jurisdiction: 'SG', entity_type: 'sg-pte',
    birth_created_at: '2026-01-01T00:00:00.000000Z',
    profile: { accounting_system: 'none', accounting_view: 'management_books', defaultCurrency: 'SGD' } };
  const authority = { source: 'authenticated_firm_create_route', principal_id: 'member-1' };
  const projected = nativeBirthAccounts({ contractId: 'sg_pte_native.v1', firmId, clientId });
  const accounts = projected.map(({ statutory_group, reserved_use, birth_contract, selection_digest, ...row }) =>
    ({ ...row, payload: { statutory_group, reserved_use, birth_contract, selection_digest } }));
  const metadata = nativeBirthReceipt({ observation: { firmId, clientId, client: company, accounts, receipts: [] },
    birthContract: { id: 'sg_pte_native.v1', bookkeeping_start_date: '2026-01-01',
      registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } },
    creationAudit: { actorId: 'member-1', actorType: 'firm_member', authorityBasis: authority } });
  const event = { firm_id: firmId, client_id: clientId, resource_type: 'client', resource_id: clientId,
    actor_type: 'firm_member', actor_id: 'member-1' };
  const receipts = [{ ...event, id: '1', action: 'ledger.chart.palette_seeded', metadata },
    { ...event, id: '2', action: 'client.create', metadata: { authority_basis: authority,
      native_chart_birth: { receipt_id: '1', receipt_digest: metadata.receipt_digest, contract_id: 'sg_pte_native.v1' } } }];
  let corrupt = false;
  const calls = [];
  const client = { query: async (sql) => {
    calls.push(sql);
    if (sql.includes('from clients')) return { rows: [{ ...company, ...(corrupt ? { jurisdiction: 'GB' } : {}) }] };
    if (sql.includes('from ledger_accounts')) return { rows: accounts };
    if (sql.includes('from audit_events')) return { rows: receipts };
    return { rows: [] };
  } };
  const decision = await evaluate(client);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason_code, 'processing_review_only');
  assert.equal(decision.retryable, false);
  assert.equal(decision.birth_receipt_digest, metadata.receipt_digest);
  assert.equal(calls.some(sql => sql.includes('from client_capability_config')), false);
  assert.ok(calls.some(sql => sql.includes('for share nowait')));
  for (const boundary of ['ledger_write', 'close_lock']) {
    const scope = await evaluateRetainedProcessingScopeWithClient({ client, firmId, clientId, boundary });
    assert.equal(scope.allowed, false);
    const error = new EntityReadinessAdmissionError(scope);
    assert.equal(error.statusCode, 409);
    assert.equal(error.retryable, false);
    assert.match(error.message, /review only/);
  }
  corrupt = true;
  assert.equal((await evaluate(client)).reason_code, 'native_chart_lineage_invalid');
  corrupt = false;
  assert.equal((await evaluate(client)).reason_code, 'processing_review_only');
  assert.equal((await evaluate(clientFor())).allowed, true, 'unmarked legacy neighbor remains admitted');
});
