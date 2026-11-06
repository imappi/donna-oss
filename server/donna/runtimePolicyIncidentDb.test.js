import assert from 'node:assert/strict';
import test from 'node:test';
import { withCodingPolicyIncidentLock } from './codingPolicyRecovery.js';
import { claimRuntimePolicyIncident, listRuntimePolicyIncidents } from './runtimePolicyIncidentDb.js';

const scope = { firmId: 'f', clientId: 'c', transactionId: 't', operation: 'coding' };
test('autocommit policy failure owns a short transaction and rolls back before rethrowing', async () => {
  const queries = [];
  const client = { query: async (sql) => {
    queries.push(sql);
    if (sql.startsWith('savepoint')) throw Object.assign(new Error('no transaction'), { code: '25P01' });
    return { rows: [] };
  } };
  const cause = new Error('audit write failed');
  await assert.rejects(withCodingPolicyIncidentLock({ ...scope, client }, async () => { throw cause; }), error => error === cause);
  assert.deepEqual(queries, ['savepoint runtime_policy_incident', 'begin',
    'select pg_advisory_xact_lock(hashtextextended($1, 0))', 'rollback']);
});
test('named writer keeps ownership of its transaction and incident lock through commit', async () => {
  const queries = [];
  const client = { query: async sql => { queries.push(sql); return { rows: [] }; } };
  assert.equal(await withCodingPolicyIncidentLock({ ...scope, client }, async () => 'result'), 'result');
  assert.deepEqual(queries, ['savepoint runtime_policy_incident',
    'select pg_advisory_xact_lock(hashtextextended($1, 0))', 'release savepoint runtime_policy_incident']);
  assert.ok(!queries.includes('commit'), 'savepoint release does not release the surrounding transaction lock');
});
test('aborted transaction and pool inputs cannot silently lose incident serialization', async () => {
  await assert.rejects(withCodingPolicyIncidentLock({ ...scope, client: { totalCount: 1 } }, () => {}), /checked-out/);
  const cause = Object.assign(new Error('aborted'), { code: '25P02' });
  await assert.rejects(withCodingPolicyIncidentLock({ ...scope, client: { query: async () => { throw cause; } } }, () => {}), error => error === cause);
});
test('malformed incident identity and list cursor refuse before database queries', async () => {
  const client = { query: async () => assert.fail('malformed input reached SQL') };
  await assert.rejects(claimRuntimePolicyIncident({ client, firmId: 'f', failureId: '1 OR 1=1' }), { code: 'RUNTIME_POLICY_INCIDENT_NOT_FOUND' });
  await assert.rejects(listRuntimePolicyIncidents({ client, firmId: 'f', afterFailureId: 'invalid' }), { code: 'RUNTIME_POLICY_CURSOR_INVALID' });
});
