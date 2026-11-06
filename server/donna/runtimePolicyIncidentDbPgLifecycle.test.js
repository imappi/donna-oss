import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests,
  batchSuggestTransactionCodingInDb, postLedgerTransactionInDb } from './firmDb.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { recordCodingPolicyFailure, recordCodingPolicyRecovery,
  CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION } from './codingPolicyRecovery.js';
import { listRuntimePolicyIncidents, claimRuntimePolicyIncident,
  requestRuntimePolicyIncidentRetry, completeRuntimePolicyIncidentRetry,
  RUNTIME_POLICY_RETRY_REQUESTED_ACTION } from './runtimePolicyIncidentDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: exhausted policy incident has attributable repair ownership and only exact writer recovery closes it', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — incident ownership lifecycle not exercised'
}, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  const name = `donna_policy_ownership_${Date.now().toString(36)}_${process.pid}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', connection => closed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const envKeys = ['OPENAI_API_KEY','DONNA_ACCESS_TOKEN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DONNA_AUTH_ALLOWED_EMAILS'];
  const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: 'fixture-key', DONNA_ACCESS_TOKEN: 'fixture-operator-token',
    SUPABASE_URL: 'https://fixture-auth.test', SUPABASE_PUBLISHABLE_KEY: 'fixture-auth-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
  t.after(async () => {
    __resetFirmDbPoolForTests();
    for (const key of envKeys) { if (originalEnv[key] === undefined) delete process.env[key]; else process.env[key] = originalEnv[key]; }
    await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  await pool.query("insert into firms (id,name,slug) values ('f','Fixture','f'),('other','Other','other')");
  await pool.query(`insert into firm_members (id,firm_id,email,name,status) values
    ('m1','f','one@example.test','Maintainer One','active'),('m2','f','two@example.test','Maintainer Two','active'),
    ('foreign','other','foreign@example.test','Foreign Member','active')`);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ('c','f','Fixture Ltd','gb','{"jurisdiction":"gb","accounting_system":"none"}')`);
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,currency,money_in,status,coding_state)
    values ('t','f','c','2026-06-01','Service payment','GBP',200,'needs_review',null),
           ('posted','f','c','2026-06-01','Already posted','GBP',200,'posted','posted')`);
  const seedClient = await pool.connect();
  try { await settleCommittedConvergenceMarks(seedClient); } finally { seedClient.release(); }
  const posted = (await pool.query("select * from transactions where id='posted'")).rows[0];
  await pool.query(`insert into firm_collaborators(id,firm_id,email,name,status) values ('collaborator','f','collaborator@example.test','Customer','active')`);
  let providerCalls = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    if (endpoint === 'https://fixture-auth.test/auth/v1/user') {
      const token = init.headers.Authorization.replace('Bearer ', '');
      const emails = { m1: 'one@example.test', m2: 'two@example.test', foreign: 'foreign@example.test', collaborator: 'collaborator@example.test' };
      return { ok: true, json: async () => ({ id: `user-${token}`, email: emails[token] }) };
    }
    assert.equal(endpoint, 'https://api.openai.com/v1/responses');
    providerCalls += 1;
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestion = tx => ({ transaction_id: tx.id, proposed_account: 'Sales', contact: 'Customer', tax_treatment: 'VAT 20%',
      support_note: 'Invoice details required.', ask_client_question: 'What does this payment cover?', evidence_required: true,
      remember_candidate: false, merchant_pattern: '', missing_account_name: '', missing_account_type: '', missing_account_reason: '',
      auto_explain_limit: 0, confidence: 'high', materiality: 'normal', reasoning: 'Service payment.', warnings: [], alternatives: [] });
    return { ok: true, json: async () => ({ id: 'fixture-response', output_text: JSON.stringify(input.transactions
      ? { suggestions: input.transactions.map(suggestion), group_summary: [] } : suggestion(input.transaction)) }) };
  });
  const connection = async fn => { const client = await pool.connect(); try { return await fn(client); } finally { client.release(); } };
  const principal = id => ({ principalType: 'firm_member', principalId: id });
  const call = (fn, args = {}) => connection(client => fn({ client, firmId: 'f', ...args }));
  const api = async (token, path = '', body) => {
    try { return await requestDonnaApi({ pool, method: body ? 'POST' : 'GET',
      url: `/api/donna/firms/runtime-policy-incidents${path}${body ? '' : '?firm_id=f'}`,
      headers: { authorization: `Bearer ${token}` }, ...(body ? { body: { firm_id: 'f', ...body } } : {}) }); }
    finally { __setFirmDbPoolForTests(pool); }
  };
  const events = action => pool.query('select * from audit_events where action=$1 order by id', [action]);

  await pool.query('alter table client_capability_config rename to fixture_missing_config');
  for (let i = 0; i < 4; i += 1) {
    const result = await batchSuggestTransactionCodingInDb({ firmId: 'f', clientIds: ['c'] });
    assert.equal(result.transaction_ai_batch.summaries[0].policy_error.code, 'coding_policy_unavailable');
  }
  assert.equal(providerCalls, 0);
  assert.equal((await events(CODING_POLICY_FAILED_ACTION)).rows.length, 3);
  let [incident] = await call(listRuntimePolicyIncidents);
  assert.equal(incident.status, 'unclaimed');
  assert.equal(incident.operation, 'coding');
  const failureId = incident.failure_id;
  assert.equal((await api('m1')).json.incidents[0].failure_id, failureId, 'mounted API lists real database incidents');
  assert.equal((await api('collaborator')).statusCode, 403);
  assert.equal((await api('foreign')).statusCode, 403);
  for (const bad of [{ principalType: 'access_token', principalId: 'access-token' },
    { principalType: 'firm_collaborator', principalId: 'm1' }, principal('foreign')]) {
    await assert.rejects(call(claimRuntimePolicyIncident, { failureId, principal: bad }), { code: 'RUNTIME_POLICY_MEMBER_REQUIRED' });
  }
  await assert.rejects(call(claimRuntimePolicyIncident, { firmId: 'other', failureId, principal: principal('foreign') }), { code: 'RUNTIME_POLICY_INCIDENT_NOT_FOUND' });
  const claims = await Promise.allSettled(['m1','m2'].map(id => call(claimRuntimePolicyIncident, { failureId, principal: principal(id) })));
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1, 'one concurrent claimant wins');
  assert.equal(claims.find(r => r.status === 'rejected').reason.code, 'RUNTIME_POLICY_ALREADY_CLAIMED');
  incident = claims.find(r => r.status === 'fulfilled').value;
  const initialOwner = incident.claimant.id;
  const successor = initialOwner === 'm1' ? 'm2' : 'm1';
  assert.equal(incident.status, 'acknowledged', 'claim is expressly not resolution');
  assert.equal((await events(CODING_POLICY_RECOVERED_ACTION)).rows.length, 0);
  const claimReceipt = incident.claimant.receipt_id;
  assert.equal((await call(claimRuntimePolicyIncident, { failureId, principal: principal(initialOwner) })).claimant.receipt_id, claimReceipt);
  await pool.query("update firm_members set status='inactive' where id=$1", [initialOwner]);
  [incident] = await call(listRuntimePolicyIncidents);
  assert.equal(incident.status, 'unclaimed');
  assert.equal(incident.claimant.active, false);
  await assert.rejects(call(claimRuntimePolicyIncident, { failureId, principal: principal(initialOwner) }), { code: 'RUNTIME_POLICY_MEMBER_REQUIRED' });
  incident = await call(claimRuntimePolicyIncident, { failureId, principal: principal(successor) });
  assert.equal(incident.claimant.id, successor, 'inactive member never traps an incident');
  const base = { failureId, principal: principal(successor), repairNote: 'Restored the unavailable configuration relation.' };
  const requests = await Promise.allSettled(['attempt-a','attempt-b'].map(idempotencyKey => call(requestRuntimePolicyIncidentRetry, { ...base, idempotencyKey })));
  const first = requests.find(r => r.status === 'fulfilled').value;
  assert.equal(first.execute, true);
  assert.equal(requests.find(r => r.status === 'rejected').reason.code, 'RUNTIME_POLICY_RETRY_IN_PROGRESS');
  assert.equal((await call(requestRuntimePolicyIncidentRetry, { ...base, idempotencyKey: first.request.metadata.idempotency_key })).execute, false);
  const stillOpen = await call(completeRuntimePolicyIncidentRetry, { ...base, requestId: first.request.id });
  assert.equal(stillOpen.outcome, 'still_open', 'an HTTP success label cannot close an unrepaired incident');
  // Append a fixture at its original historical time: audit events are immutable.
  await pool.query(`insert into audit_events (firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at)
    select firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,
      metadata || '{"idempotency_key":"crashed-attempt"}'::jsonb, now()-interval '6 minutes'
      from audit_events where id=$1`, [first.request.id]);
  const resumed = await call(requestRuntimePolicyIncidentRetry, { ...base, idempotencyKey: 'after-crash' });
  assert.equal(resumed.execute, true, 'an abandoned retry cannot remain pending forever');
  await pool.query('alter table fixture_missing_config rename to client_capability_config');
  await call(completeRuntimePolicyIncidentRetry, { ...base, requestId: resumed.request.id });
  const apiClaim = await api(successor, `/${failureId}/claim`, {});
  assert.equal(apiClaim.statusCode, 200);
  assert.equal(apiClaim.json.incident.claimant.id, successor);
  const apiRetry = await api(successor, `/${failureId}/retry`, { idempotency_key: 'mounted-api-retry', repair_note: base.repairNote });
  assert.equal(apiRetry.statusCode, 200, JSON.stringify(apiRetry.json));
  assert.equal(apiRetry.json.executed, true);
  assert.equal(apiRetry.json.recovered, true, JSON.stringify(apiRetry.json));
  const apiDuplicate = await api(successor, `/${failureId}/retry`, { idempotency_key: 'mounted-api-retry', repair_note: base.repairNote });
  assert.equal(apiDuplicate.statusCode, 200);
  assert.equal(apiDuplicate.json.executed, false);
  assert.equal(apiDuplicate.json.recovered, true);
  assert.deepEqual((await api(successor)).json.incidents, []);
  assert.equal(providerCalls, 1, 'real named single-transaction coder executes the repaired request');
  const completedRequestId = apiRetry.json.completion.retry_request_id;
  const complete = await call(completeRuntimePolicyIncidentRetry, { ...base, requestId: completedRequestId });
  assert.equal(complete.outcome, 'recovered');
  const [recovery] = (await events(CODING_POLICY_RECOVERED_ACTION)).rows;
  assert.equal(recovery.metadata.recovered_failure_id, failureId);
  assert.equal(complete.recovery_receipt_id, String(recovery.id));
  assert.deepEqual(await call(completeRuntimePolicyIncidentRetry, { ...base, requestId: completedRequestId }), complete);
  assert.deepEqual(await call(listRuntimePolicyIncidents), []);
  await assert.rejects(call(claimRuntimePolicyIncident, base), { code: 'RUNTIME_POLICY_INCIDENT_STALE' });
  assert.equal((await call(requestRuntimePolicyIncidentRetry, { ...base, idempotencyKey: 'after-crash' })).execute, false);
  await assert.rejects(call(requestRuntimePolicyIncidentRetry, { ...base, idempotencyKey: 'new-after-recovery' }), { code: 'RUNTIME_POLICY_INCIDENT_STALE' });
  assert.equal(providerCalls, 1);
  assert.deepEqual((await pool.query("select * from transactions where id='posted'")).rows[0], posted);

  const failure = { clientId: 'c', transactionIds: ['t'], error: Object.assign(new Error('configuration unavailable'), { code: 'coding_policy_unavailable' }) };
  await Promise.all(Array.from({ length: 5 }, () => call(recordCodingPolicyFailure, failure)));
  const failures = (await events(CODING_POLICY_FAILED_ACTION)).rows;
  assert.deepEqual(failures.slice(3).map(row => row.metadata.attempts), [1,2,3], 'concurrent writers respect the same bounded episode');
  const recurrence = failures.at(-1);
  const c1 = await pool.connect(), c2 = await pool.connect();
  try {
    await c1.query('begin');
    await recordCodingPolicyRecovery({ client: c1, firmId: 'f', clientId: 'c', transactionIds: ['t'], policy: { jurisdiction: 'gb' } });
    const delayed = recordCodingPolicyFailure({ client: c2, firmId: 'f', ...failure });
    // Await a real blocked advisory request, not a timing assumption.
    let waiting = false;
    for (let i = 0; i < 100; i += 1) {
      const locks = await pool.query("select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted", [c2.processID]);
      if (locks.rows.length) { waiting = true; break; }
    }
    assert.equal(waiting, true, 'failure waits until successful surrounding writer commits');
    await c1.query('commit');
    const [newFailure] = await delayed;
    assert.equal(newFailure.metadata.attempts, 1);
    assert.notEqual(String(newFailure.id), String(recurrence.id));
    const latestRecovery = (await events(CODING_POLICY_RECOVERED_ACTION)).rows.at(-1);
    assert.equal(latestRecovery.metadata.recovered_failure_id, String(recurrence.id));
  } finally { await c1.query('rollback'); c1.release(); c2.release(); }
  await call(recordCodingPolicyFailure, { ...failure, operation: 'posting',
    error: Object.assign(new Error('posting policy malformed'), { code: 'coding_policy_invalid' }) });
  // Independent operation receipts remain visible, and old stuck rows cannot
  // consume the bounded first page forever.
  const allOpen = await call(listRuntimePolicyIncidents);
  assert.equal(allOpen.length, 1, 'coding recurrence at attempt one is not yet exhausted');
  assert.equal(allOpen[0].operation, 'posting');
  await call(recordCodingPolicyFailure, failure);
  await call(recordCodingPolicyFailure, failure);
  const firstPage = await call(listRuntimePolicyIncidents, { limit: 1 });
  const nextPage = await call(listRuntimePolicyIncidents, { limit: 1, afterFailureId: firstPage[0].failure_id });
  assert.equal(firstPage.length, 1); assert.equal(nextPage.length, 1);
  assert.notEqual(firstPage[0].failure_id, nextPage[0].failure_id);
  assert.deepEqual(await call(listRuntimePolicyIncidents, { afterFailureId: nextPage[0].failure_id }), []);
  assert.deepEqual((await pool.query("select * from transactions where id='posted'")).rows[0], posted);
  assert.equal((await events(RUNTIME_POLICY_RETRY_REQUESTED_ACTION)).rows.length, 4);

  // The mounted posting consumer retains its flag, external-book and target
  // fences. Creating fixture authority below affects only this disposable DB.
  const postingPolicy = resolveCodingPolicy({ jurisdiction: 'gb', businessDate: '2026-09-05', accountingSystem: 'none' });
  const postingSuggestion = { proposed_account: 'Sales', tax_treatment: postingPolicy.outOfScopeTaxTreatment,
    confidence: 'high', coding_policy: codingPolicyReceipt(postingPolicy) };
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile)
    values ('posting-client','f','Posting fixture','gb','{"jurisdiction":"gb","accounting_system":"none"}')`);
  for (const id of ['posting-target', 'posting-peer']) {
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,currency,status,coding_state,payload)
      values($1,'f','posting-client','2026-09-05','Service sale',100,'GBP','needs_review','applied',$2)`,
      [id, { ai_suggestion: postingSuggestion }]);
  }
  await connection(client => settleCommittedConvergenceMarks(client));
  const peerBefore = (await pool.query("select * from transactions where id='posting-peer'")).rows[0];
  await pool.query('alter table client_capability_config rename to fixture_missing_posting_config');
  try {
    for (let i = 0; i < 4; i += 1) {
      await assert.rejects(postLedgerTransactionInDb({ firmId: 'f', clientId: 'posting-client', transactionId: 'posting-target', dryRun: true }),
        { code: 'coding_policy_unavailable' });
    }
  } finally { await pool.query('alter table fixture_missing_posting_config rename to client_capability_config'); }
  const postingIncident = (await call(listRuntimePolicyIncidents)).find(row => row.transaction_id === 'posting-target');
  assert.ok(postingIncident);
  const postingId = postingIncident.failure_id;
  assert.equal((await api(successor, `/${postingId}/claim`, {})).statusCode, 200);
  const postingRetry = key => api(successor, `/${postingId}/retry`, { idempotency_key: key, repair_note: 'Restored configuration; verify existing posting authority.' });
  const journalCount = async () => Number((await pool.query("select count(*) as n from ledger_journals where client_id='posting-client'")).rows[0].n);
  const flagOff = await postingRetry('posting-flag-off');
  assert.equal(flagOff.statusCode, 200, JSON.stringify(flagOff.json));
  assert.equal(flagOff.json.recovered, false);
  assert.equal(flagOff.json.completion.error_code, 'flag_off');
  assert.equal(await journalCount(), 0);
  await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage)
    values ('posting-fixture-authority','f','posting-client','LEDGER_AUTO_POST','auto')`);
  await pool.query(`update clients set profile=profile || '{"accounting_system":"xero"}'::jsonb where id='posting-client'`);
  const external = await postingRetry('posting-external');
  assert.equal(external.statusCode, 200, JSON.stringify(external.json));
  assert.equal(external.json.recovered, false);
  assert.equal(external.json.completion.error_code, 'external_accounting_system:xero');
  assert.equal(await journalCount(), 0);
  await pool.query(`update clients set profile=profile || '{"accounting_system":"none"}'::jsonb where id='posting-client'`);
  const postedResult = await postingRetry('posting-repaired');
  assert.equal(postedResult.statusCode, 200, JSON.stringify(postedResult.json));
  assert.equal(postedResult.json.recovered, true, JSON.stringify(postedResult.json));
  assert.equal(await journalCount(), 1);
  const postingRecovery = (await events(CODING_POLICY_RECOVERED_ACTION)).rows.find(row => row.resource_id === 'posting-target');
  assert.equal(postingRecovery.metadata.recovered_failure_id, postingId);
  assert.equal(postingRecovery.metadata.operation, 'posting');
  assert.equal((await postingRetry('posting-repaired')).json.executed, false);
  assert.equal(await journalCount(), 1);
  assert.deepEqual((await pool.query("select * from transactions where id='posting-peer'")).rows[0], peerBefore);
  assert.deepEqual((await pool.query("select * from transactions where id='posted'")).rows[0], posted);
  assert.equal(providerCalls, 1, 'posting repair never invokes another coding model');
});
