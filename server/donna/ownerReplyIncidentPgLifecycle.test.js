import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, resolveClientEvidenceRequestInDb } from './firmDb.js';
import { recoverOwnerRepliesInDb, retryOwnerReplyProcessingInDb } from './ownerReplyRecovery.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { claimRuntimePolicyIncident, listRuntimePolicyIncidents, requestRuntimePolicyIncidentRetry,
  completeRuntimePolicyIncidentRetry } from './runtimePolicyIncidentDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG/HTTP: exhausted owner answer is claimed, repaired exactly once, and fenced from stale or posted sources', {
  skip: !pgUrl && 'DONNA_PG_TEST_URL not set — accountable owner reply recovery not exercised'
}, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_reply_incident_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const keys = ['OPENAI_API_KEY', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'];
  const savedEnv = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { OPENAI_API_KEY: 'fixture-key', DONNA_ACCESS_TOKEN: 'fixture-token',
    SUPABASE_URL: 'https://fixture-auth.test', SUPABASE_PUBLISHABLE_KEY: 'fixture-auth-key', DONNA_AUTH_ALLOWED_EMAILS: '' });
  t.after(async () => {
    __resetFirmDbPoolForTests();
    for (const k of keys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
    await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values('f','Reply firm','f'),('other','Other','other')");
  await pool.query(`insert into firm_members(id,firm_id,email,name,status) values
    ('m1','f','one@example.test','One','active'),('m2','f','two@example.test','Two','active'),
    ('foreign','other','foreign@example.test','Foreign','active')`);
  await pool.query(`insert into firm_collaborators(id,firm_id,email,name,status) values('collaborator','f','customer@example.test','Customer','active')`);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Reply Ltd','gb','{"jurisdiction":"gb","accounting_system":"none"}')`);
  let providerCalls = 0, providerFails = true;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    if (endpoint === 'https://fixture-auth.test/auth/v1/user') {
      const token = init.headers.Authorization.replace('Bearer ', '');
      return { ok: true, json: async () => ({ id: `user-${token}`, email: { m1: 'one@example.test', m2: 'two@example.test',
        foreign: 'foreign@example.test', collaborator: 'customer@example.test' }[token] }) };
    }
    assert.equal(endpoint, 'https://api.openai.com/v1/responses'); providerCalls++;
    if (providerFails) throw new Error('fixture provider unavailable');
    return { ok: true, json: async () => ({ id: `fixture-${providerCalls}`, output_text: JSON.stringify({
      proposed_account: 'Office expenses', contact: '', tax_treatment: 'VAT 20%', support_note: 'Owner confirmed business water delivery.',
      ask_client_question: '', evidence_required: false, remember_candidate: false, merchant_pattern: '', missing_account_name: '',
      missing_account_type: '', missing_account_reason: '', auto_explain_limit: 0, confidence: 'high', materiality: 'normal',
      reasoning: 'Owner confirmed the purpose.', warnings: [], alternatives: [] }) }) };
  });
  const call = async (fn, args = {}) => {
    const client = await pool.connect();
    try { return await fn({ client, firmId: 'f', ...args }); } finally { client.release(); }
  };
  const principal = id => ({ principalType: 'firm_member', principalId: id });
  const api = async (token, path = '', body) => {
    try { return await requestDonnaApi({ pool, method: body ? 'POST' : 'GET',
      url: `/api/donna/firms/runtime-policy-incidents${path}${body ? '' : '?firm_id=f'}`,
      headers: { authorization: `Bearer ${token}` }, ...(body ? { body: { firm_id: 'f', ...body } } : {}) }); }
    finally { __setFirmDbPoolForTests(pool); }
  };
  const source = async id => (await pool.query('select * from client_evidence_requests where id=$1', [`ask-${id}`])).rows[0];
  const seed = async id => {
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state)
      values($1,'f','c','2026-06-01','WATER PAYMENT',100,'GBP','needs_review','asked')`, [`tx-${id}`]);
    await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question)
      values($1,'f','c',$2,'open','business_purpose','What was this payment for?')`, [`ask-${id}`, `tx-${id}`]);
    const answer = await resolveClientEvidenceRequestInDb({ firmId: 'f', evidenceRequestId: `ask-${id}`,
      reply: 'Monthly water delivery for the cafe.', actorId: 'owner@example.test', actorType: 'client' });
    assert.equal(answer.recode.applied, false);
    for (let i = 0; i < 3; i++) await recoverOwnerRepliesInDb({ firmId: 'f' });
    const processing = (await source(id)).response_payload.reply_processing;
    assert.equal(processing.state, 'exhausted'); assert.equal(processing.attempts, 3);
    return { failureId: processing.failure_id, expectedFailureId: processing.failure_id, expectedReplyKey: processing.reply_key,
      evidenceRequestId: `ask-${id}`, transactionId: `tx-${id}`, clientId: 'c', firmId: 'f' };
  };
  const first = await seed('recover');
  const afterExhaustion = providerCalls;
  await recoverOwnerRepliesInDb({ firmId: 'f' }); assert.equal(providerCalls, afterExhaustion);
  let list = await api('m1'); assert.equal(list.statusCode, 200);
  assert.equal(list.json.incidents[0].failure_id, first.failureId);
  assert.equal(list.json.incidents[0].operation, 'owner_reply');
  assert.equal(list.json.incidents[0].evidence_request_id, 'ask-recover');
  assert.equal(list.json.incidents[0].reply_key, first.expectedReplyKey);
  assert.equal((await api('foreign')).statusCode, 403);
  assert.equal((await api('collaborator')).statusCode, 403);
  const claims = await Promise.allSettled(['m1', 'm2'].map(id => call(claimRuntimePolicyIncident, { ...first, principal: principal(id) })));
  assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(claims.find(r => r.status === 'rejected').reason.code, 'RUNTIME_POLICY_ALREADY_CLAIMED');
  const winner = claims.find(r => r.status === 'fulfilled').value.claimant.id;
  assert.equal((await api(winner, `/${first.failureId}/claim`, {})).json.incident.status, 'acknowledged');
  const claimRow = (await pool.query("select actor_id,actor_type,metadata from audit_events where action='runtime.policy_incident.claimed' order by id desc limit 1")).rows[0];
  assert.equal(claimRow.actor_id, winner); assert.equal(claimRow.actor_type, 'firm_member');
  assert.equal(claimRow.metadata.reply_key, first.expectedReplyKey);
  providerFails = false;
  const retryBody = { idempotency_key: 'repaired-provider', repair_note: 'Restored runtime inference availability.' };
  const repaired = await api(winner, `/${first.failureId}/retry`, retryBody);
  assert.equal(repaired.statusCode, 200, JSON.stringify(repaired.json));
  assert.equal(repaired.json.recovered, true, JSON.stringify(repaired.json));
  assert.equal((await source('recover')).status, 'resolved');
  const receipt = (await pool.query("select metadata from audit_events where action='evidence_request.reply_processed' and resource_id='ask-recover'")).rows[0];
  assert.equal(receipt.metadata.recovered_failure_id, first.failureId);
  assert.equal(receipt.metadata.reply_key, first.expectedReplyKey);
  const afterRepair = providerCalls;
  assert.equal((await api(winner, `/${first.failureId}/retry`, retryBody)).json.executed, false);
  assert.equal(providerCalls, afterRepair); assert.deepEqual((await api(winner)).json.incidents, []);

  // The episode may change after admission. Neither a stale failure nor a new
  // answer may buy a provider call under the old repair request.
  providerFails = true;
  const stale = await seed('stale');
  await call(claimRuntimePolicyIncident, { ...stale, principal: principal(winner) });
  const pending = await call(requestRuntimePolicyIncidentRetry, { ...stale, principal: principal(winner), idempotencyKey: 'old-episode', repairNote: 'Provider repaired.' });
  await pool.query(`update client_evidence_requests set response_payload=response_payload || '{"reply":"Actually personal.","responded_at":"2026-09-08T12:00:00Z"}'::jsonb where id='ask-stale'`);
  const beforeStale = providerCalls;
  assert.equal((await retryOwnerReplyProcessingInDb(stale)).results[0].skipped, 'reply_superseded');
  assert.equal(providerCalls, beforeStale);
  assert.equal((await call(completeRuntimePolicyIncidentRetry, { ...stale, principal: principal(winner), requestId: pending.request.id })).outcome, 'superseded');
  await assert.rejects(call(claimRuntimePolicyIncident, { ...stale, principal: principal(winner) }), { code: 'RUNTIME_POLICY_INCIDENT_STALE' });
  await pool.query("update client_evidence_requests set status='resolved' where id='ask-stale'");

  const posted = await seed('posted');
  await pool.query("update transactions set coding_state='posted',status='posted' where id='tx-posted'");
  const postedSnapshot = (await pool.query("select * from transactions where id='tx-posted'")).rows[0];
  const beforePosted = providerCalls;
  assert.equal((await retryOwnerReplyProcessingInDb(posted)).results[0].skipped, 'terminal_or_missing_transaction');
  await assert.rejects(call(claimRuntimePolicyIncident, { ...posted, principal: principal(winner) }), { code: 'RUNTIME_POLICY_SOURCE_TERMINAL' });
  assert.equal(providerCalls, beforePosted);
  assert.deepEqual((await pool.query("select * from transactions where id='tx-posted'")).rows[0], postedSnapshot);

  const episode = await seed('episode');
  await retryOwnerReplyProcessingInDb({ firmId: 'f', clientId: 'c', evidenceRequestId: 'ask-episode' });
  assert.notEqual((await source('episode')).response_payload.reply_processing.failure_id, episode.failureId);
  assert.equal((await retryOwnerReplyProcessingInDb(episode)).results[0].skipped, 'reply_failure_superseded');
  await assert.rejects(call(claimRuntimePolicyIncident, { ...episode, principal: principal(winner) }), { code: 'RUNTIME_POLICY_INCIDENT_STALE' });

  // Audit refusal cannot leave a phantom failed state with no source receipt.
  const beforeFailure = (await source('episode')).response_payload;
  await pool.query(`create function fixture_refuse_reply_audit() returns trigger language plpgsql as $$
    begin if new.action='evidence_request.reply_processing_failed' then raise exception 'fixture audit unavailable'; end if; return new; end $$;
    create trigger fixture_refuse_reply_audit before insert on audit_events for each row execute function fixture_refuse_reply_audit();`);
  await assert.rejects(retryOwnerReplyProcessingInDb({ firmId: 'f', clientId: 'c', evidenceRequestId: 'ask-episode' }), /fixture audit unavailable/);
  assert.deepEqual((await source('episode')).response_payload, beforeFailure);
  await pool.query('drop trigger fixture_refuse_reply_audit on audit_events');

  // The source writer rolls back coding and resolution if its completion audit
  // fails. The worker may record a new failure, never a false recovered receipt.
  providerFails = false;
  const beforeSuccess = (await pool.query("select account_code,payload,coding_state from transactions where id='tx-episode'")).rows[0];
  await pool.query(`create function fixture_refuse_reply_success() returns trigger language plpgsql as $$
    begin if new.action='evidence_request.reply_processed' then raise exception 'fixture success audit unavailable'; end if; return new; end $$;
    create trigger fixture_refuse_reply_success before insert on audit_events for each row execute function fixture_refuse_reply_success();`);
  const failedCompletion = await retryOwnerReplyProcessingInDb({ firmId: 'f', clientId: 'c', evidenceRequestId: 'ask-episode' });
  assert.equal(failedCompletion.results[0].applied, false);
  assert.deepEqual((await pool.query("select account_code,payload,coding_state from transactions where id='tx-episode'")).rows[0], beforeSuccess);
  assert.equal((await source('episode')).status, 'replied');
  assert.equal((await pool.query("select count(*)::int as n from audit_events where resource_id='ask-episode' and action='evidence_request.reply_processed'")).rows[0].n, 0);
  await pool.query('drop trigger fixture_refuse_reply_success on audit_events');

  // Historical wave-8 failures have no persisted failure_id/operation. They are
  // still visible by exact audit identity, and pagination crosses stale sources.
  const historical = await source('episode');
  await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state)
    values('tx-obsolete','f','c','2026-06-01','Older source',100,'GBP','needs_review','asked');
    insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question,response_payload)
    values('ask-obsolete','f','c','tx-obsolete','replied','business_purpose','What for?','{"reply":"A newer answer exists."}');`);
  await pool.query(`insert into audit_events(firm_id,client_id,actor_type,action,resource_type,resource_id,metadata)
    values('f','c','system','evidence_request.reply_processing_failed','client_evidence_request','ask-obsolete',$1::jsonb)`,
  [JSON.stringify({ ...historical.response_payload.reply_processing, operation: 'owner_reply' })]);
  await pool.query(`insert into audit_events(firm_id,client_id,actor_type,action,resource_type,resource_id,metadata)
    values('f','c','system','evidence_request.reply_processing_failed','client_evidence_request','ask-episode',$1::jsonb)`,
  [JSON.stringify({ ...historical.response_payload.reply_processing, operation: undefined, failure_id: undefined, transaction_id: 'tx-episode' })]);
  const last = (await pool.query("select id from audit_events where resource_id='ask-episode' and action='evidence_request.reply_processing_failed' order by id desc limit 1")).rows[0].id;
  const historicalList = await call(listRuntimePolicyIncidents, { limit: 1 });
  assert.equal(historicalList[0].failure_id, String(last));
  // Reattaching the unchanged answer is still a different source target. An
  // old claim may neither buy inference nor be closed by that target's success.
  await pool.query("update client_evidence_requests set transaction_id='tx-obsolete' where id='ask-episode'");
  const anchorCalls = providerCalls;
  const anchorRetry = await retryOwnerReplyProcessingInDb({ firmId: 'f', clientId: 'c', evidenceRequestId: 'ask-episode',
    expectedReplyKey: historical.response_payload.reply_processing.reply_key, expectedFailureId: String(last) });
  assert.equal(anchorRetry.results[0].skipped, 'reply_failure_superseded');
  assert.equal(providerCalls, anchorCalls);
  await assert.rejects(call(claimRuntimePolicyIncident, { failureId: String(last), principal: principal(winner) }), { code: 'RUNTIME_POLICY_INCIDENT_STALE' });
  await retryOwnerReplyProcessingInDb({ firmId: 'f', clientId: 'c', evidenceRequestId: 'ask-episode' });
  assert.equal((await pool.query("select count(*)::int as n from audit_events where action='evidence_request.reply_processed' and metadata->>'recovered_failure_id'=$1", [String(last)])).rows[0].n, 0);
});
