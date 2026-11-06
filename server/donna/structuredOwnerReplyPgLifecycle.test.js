import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, resolveClientEvidenceRequestInDb } from './firmDb.js';
import { processStructuredOwnerReplyWithClient } from './structuredOwnerReply.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { recoverOwnerRepliesInDb } from './ownerReplyRecovery.js';
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
import { recordAeVatRegistrationReply } from './ae/vatRegistrationReply.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('registered structured owner reply: named factual writer, exact reply receipts, ambiguity, rollback and tenant fences', { skip: !pgUrl && 'DONNA_PG_TEST_URL not set' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_structured_reply_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorFetch = globalThis.fetch, priorKey = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'fixture-only';
  globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'recorded temporary outage' } }), { status: 503 });
  t.after(() => { globalThis.fetch = priorFetch; if (priorKey === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorKey; });
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const unchangedTables = ['ledger_journals', 'firm_facts', 'memory_candidates', 'memories', 'memory_relations', 'client_rules', 'accounting_rules'];
  const baseline = {};
  for (const table of unchangedTables) baseline[table] = (await pool.query(`select count(*)::int n from ${table}`)).rows[0].n;
  const authKeys = ['DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'];
  const savedAuth = Object.fromEntries(authKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'fixture-token', SUPABASE_URL: 'https://structured-auth.test', SUPABASE_PUBLISHABLE_KEY: 'fixture', DONNA_AUTH_ALLOWED_EMAILS: '' });
  t.after(() => { for (const key of authKeys) { if (savedAuth[key] === undefined) delete process.env[key]; else process.env[key] = savedAuth[key]; } });
  const firmId = 'structured-firm';
  await pool.query("insert into firms(id,name,slug) values($1,'Structured firm','structured-firm')", [firmId]);
  await pool.query(`insert into firm_members(id,firm_id,email,name,status) values('member',$1,'owner@example.test','Owner','active')`, [firmId]);
  const seed = async (id, reply = 'We are registered from 1 January 2026, TRN 100 1234 5678 9012. Our first period is 1 January to 31 March 2026, due 28 April 2026.') => {
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Structured Ltd','ae','{"jurisdiction":"ae"}')`, [id, firmId]);
    await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,status,audience,evidence_type,question,request_payload)
      values($1,$2,$3,'open','client','vat_registration_status','Are you VAT registered? Please give your TRN, effective date and assigned period.', '{"kind":"vat_registration_status","year":2026}')`, [`ask-${id}`, firmId, id]);
    if (reply !== null) await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: `ask-${id}`, reply, actorId: 'owner@example.test', actorType: 'client' });
    return (await pool.query('select * from client_evidence_requests where id = $1', [`ask-${id}`])).rows[0];
  };
  const answer = { registered: true, trn: '100123456789012', registered_from: '2026-01-01',
    periods: [{ period_key: '2026-01-01/2026-03-31', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-04-28' }] };
  let calls = 0;
  const provider = (input = { answer, confidence: 0.99, clarification: null }, before = null) => async (_url, options) => {
    calls++; const body = JSON.parse(options.body); assert.equal(body.tool_choice.name, 'interpret_owner_reply');
    assert.match(body.messages[0].content, /reply_key/); if (before) await before();
    return new Response(JSON.stringify({ model: 'recorded-strong-owner-response', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'interpret_owner_reply', input }] }), { status: 200 });
  };
  const run = async (request, fetchImpl = provider()) => {
    const client = await pool.connect();
    try { return await processStructuredOwnerReplyWithClient({ client, firmId, request,
      expectedReplyKey: ownerReplyIdentity(request), env: { ANTHROPIC_API_KEY: 'fixture-only' }, fetchImpl }); }
    finally { client.release(); }
  };
  const request = await seed('clear');
  assert.equal(request.status, 'replied'); // Base defect: committed text had no registered consumer.
  const result = await run(request); assert.equal(result.applied, true);
  const stored = (await pool.query('select * from client_evidence_requests where id = $1', [request.id])).rows[0];
  assert.equal(stored.status, 'resolved'); assert.equal(ownerReplyIdentity(stored), ownerReplyIdentity(request));
  assert.equal(stored.response_payload.reply_processing.model, 'recorded-strong-owner-response');
  assert.equal((await pool.query('select count(*)::int n from ae_vat_periods where client_id = $1', ['clear'])).rows[0].n, 1);
  const receipts = (await pool.query("select * from audit_events where resource_id = $1 and action = 'evidence_request.reply_processed'", [request.id])).rows;
  assert.equal(receipts.length, 1); assert.equal(receipts[0].actor_id, 'owner@example.test');
  assert.deepEqual(receipts[0].metadata.structured_answer, answer);
  const callCount = calls; await assert.rejects(run(request), { code: 'OWNER_REPLY_SUPERSEDED' });
  assert.equal(calls, callCount); // No second read of an already settled answer.
  assert.equal((await pool.query('select count(*)::int n from ae_vat_periods where client_id = $1', ['clear'])).rows[0].n, 1);
  const unclear = await seed('unclear', 'Dunno, ask Ali');
  const clarification = 'Please confirm whether you are VAT registered; if so, share your TRN, effective date and assigned period dates.';
  assert.equal((await run(unclear, provider({ answer: null, confidence: 0.2, clarification }))).needsClarification, true);
  const reopened = (await pool.query('select * from client_evidence_requests where id = $1', [unclear.id])).rows[0];
  assert.equal(reopened.status, 'open'); assert.equal(reopened.question, clarification);
  assert.equal(reopened.request_payload.evidence_topic.turns.length, 1);
  assert.equal(ownerReplyIdentity(reopened), ownerReplyIdentity(unclear));
  const stale = await seed('stale');
  await assert.rejects(run(stale, provider(undefined, async () => {
    await pool.query(`update client_evidence_requests set response_payload = response_payload || '{"reply":"Actually not registered"}'::jsonb where id = $1`, [stale.id]);
  })), { code: 'OWNER_REPLY_SUPERSEDED' });
  assert.equal((await pool.query('select count(*)::int n from ae_vat_periods where client_id = $1', ['stale'])).rows[0].n, 0);
  const changedSource = await seed('changed-source');
  await pool.query("update client_evidence_requests set audience='seat',addressee_principal_type='firm_member',addressee_principal_id='member' where id=$1", [changedSource.id]);
  const beforeSourceChange = calls; await assert.rejects(run(changedSource), { code: 'OWNER_REPLY_SUPERSEDED' }); assert.equal(calls, beforeSourceChange);
  const deleting = await seed('deleting');
  const deletingClient = await pool.connect(), readingClient = await pool.connect();
  try {
    await deletingClient.query("set statement_timeout='3s'"); await readingClient.query("set statement_timeout='3s'");
    await deletingClient.query('begin');
    await deletingClient.query('select id from clients where id=$1 for update', [deleting.client_id]);
    const pid = (await readingClient.query('select pg_backend_pid() pid')).rows[0].pid;
    const pending = processStructuredOwnerReplyWithClient({ client: readingClient, firmId, request: deleting,
      expectedReplyKey: ownerReplyIdentity(deleting), env: { ANTHROPIC_API_KEY: 'fixture-only' },
      fetchImpl: provider({ answer: { registered: false }, confidence: 0.99, clarification: null }) }).then(value => value, error => error);
    let blocked = false;
    for (let i = 0; i < 100 && !blocked; i++) blocked = (await pool.query('select cardinality(pg_blocking_pids($1)) > 0 blocked', [pid])).rows[0].blocked;
    assert.equal(blocked, true, 'structured writer waits at the client lock before holding the ask');
    await deletingClient.query('delete from clients where id=$1', [deleting.client_id]);
    await deletingClient.query('commit');
    assert.equal((await pending).code, 'OWNER_REPLY_SUPERSEDED');
  } finally {
    await deletingClient.query('rollback'); await deletingClient.query('reset statement_timeout'); await readingClient.query('reset statement_timeout');
    deletingClient.release(); readingClient.release();
  }
  const atomic = await seed('atomic');
  await pool.query(`create function reject_structured_receipt() returns trigger language plpgsql as $$ begin if new.action = 'evidence_request.reply_processed' and new.client_id = 'atomic' then raise exception 'receipt unavailable'; end if; return new; end $$;
    create trigger reject_structured_receipt before insert on audit_events for each row execute function reject_structured_receipt();`);
  await assert.rejects(run(atomic), /receipt unavailable/);
  assert.equal((await pool.query("select profile->'vat_registration' registration from clients where id = 'atomic'")).rows[0].registration, null);
  assert.equal((await pool.query("select count(*)::int n from ae_vat_periods where client_id = 'atomic'")).rows[0].n, 0);
  assert.equal((await pool.query('select status from client_evidence_requests where id = $1', [atomic.id])).rows[0].status, 'replied');
  const foreign = await seed('foreign');
  await pool.query("update clients set jurisdiction = 'gb' where id = 'foreign'");
  const beforeForeign = calls; await assert.rejects(run(foreign), { code: 'OWNER_REPLY_JURISDICTION_UNRESOLVED' }); assert.equal(calls, beforeForeign);
  await assert.rejects(run({ ...foreign, firm_id: 'other-firm' }), { code: 'OWNER_REPLY_SOURCE_INVALID' });
  const inlineFetch = globalThis.fetch; globalThis.fetch = provider({ answer: { registered: false }, confidence: 0.99, clarification: null });
  const inline = await seed('inline'); globalThis.fetch = inlineFetch;
  assert.equal(inline.status, 'resolved', 'real generic ingress invokes the registered resolver inline');
  assert.equal(inline.response_payload.reply_processing.driven_action, 'record_vat_registration_reply');
  const direct = await seed('direct');
  await recordAeVatRegistrationReply({ firmId, clientId: 'direct', evidenceRequestId: direct.id, actorId: 'owner@example.test', actorType: 'client', answer: { registered: false } });
  assert.equal((await pool.query('select status from client_evidence_requests where id = $1', [direct.id])).rows[0].status, 'resolved');
  // Exercise the mounted authenticated portal route; legacy regex would have
  // intercepted this uncertain text before the strong registered interpretation.
  await seed('portal', null);
  const apiProvider = provider({ answer: null, confidence: 0.2, clarification });
  const offlineProvider = globalThis.fetch;
  globalThis.fetch = async (endpoint, options) => endpoint === 'https://structured-auth.test/auth/v1/user'
    ? new Response(JSON.stringify({ id: 'user-owner', email: 'owner@example.test' }), { status: 200 })
    : apiProvider(endpoint, options);
  const portal = await requestDonnaApi({ pool, method: 'POST', url: '/api/donna/firms/evidence/requests/ask-portal/resolve',
    headers: { authorization: 'Bearer owner-session' }, body: { firm_id: firmId, reply: 'Dunno, ask Ali' } });
  __setFirmDbPoolForTests(pool); globalThis.fetch = offlineProvider;
  assert.equal(portal.statusCode, 200, JSON.stringify(portal.json));
  assert.equal(portal.json.evidence_request.status, 'open');
  assert.equal(portal.json.evidence_request.response_payload.reply_processing.clarification, clarification);
  const portalReceipts = (await pool.query("select actor_id,actor_type from audit_events where resource_id='ask-portal' and action in ('evidence_request.reply','evidence_request.reply_processed')")).rows;
  assert.equal(portalReceipts.length, 2);
  for (const receipt of portalReceipts) { assert.equal(receipt.actor_type, 'client'); assert.equal(receipt.actor_id, 'owner@example.test'); }
  // A provider failure at real ingress is discovered by the existing clock.
  const restart = await seed('restart');
  await pool.query("update client_evidence_requests set status='open' where status='replied' and id<>$1", [restart.id]);
  const restartFailureId = restart.response_payload.reply_processing.failure_id;
  globalThis.fetch = provider({ answer: { registered: false }, confidence: 0.99, clarification: null });
  await recoverOwnerRepliesInDb({ firmId });
  const resumed = (await pool.query('select * from client_evidence_requests where id=$1', [restart.id])).rows[0];
  assert.equal(resumed.status, 'resolved');
  const recovered = (await pool.query("select metadata from audit_events where action='evidence_request.reply_processed' and resource_id=$1", [restart.id])).rows[0];
  assert.equal(recovered.metadata.recovered_failure_id, restartFailureId);
  const afterResume = calls; await recoverOwnerRepliesInDb({ firmId }); assert.equal(calls, afterResume);
  globalThis.fetch = offlineProvider;
  const exhausted = await seed('exhausted');
  await recoverOwnerRepliesInDb({ firmId }); await recoverOwnerRepliesInDb({ firmId });
  const exhaustedSource = (await pool.query('select * from client_evidence_requests where id=$1', [exhausted.id])).rows[0];
  assert.equal(exhaustedSource.response_payload.reply_processing.state, 'exhausted');
  const failureId = exhaustedSource.response_payload.reply_processing.failure_id;
  const repairProvider = provider({ answer: { registered: false }, confidence: 0.99, clarification: null });
  globalThis.fetch = async (endpoint, options) => endpoint === 'https://structured-auth.test/auth/v1/user'
    ? new Response(JSON.stringify({ id: 'user-owner', email: 'owner@example.test' }), { status: 200 })
    : repairProvider(endpoint, options);
  const repairApi = async (path = '', body) => {
    const result = await requestDonnaApi({ pool, method: body ? 'POST' : 'GET',
      url: `/api/donna/firms/runtime-policy-incidents${path}${body ? '' : '?firm_id=' + firmId}`,
      headers: { authorization: 'Bearer owner-session' }, ...(body ? { body: { firm_id: firmId, ...body } } : {}) });
    __setFirmDbPoolForTests(pool); return result;
  };
  const inbox = await repairApi(); assert.equal(inbox.statusCode, 200, JSON.stringify(inbox.json));
  assert.equal(inbox.json.incidents.find(item => item.failure_id === failureId).transaction_id, null);
  assert.equal((await repairApi(`/${failureId}/claim`, {})).statusCode, 200);
  const retryBody = { idempotency_key: 'restore-structured-provider', repair_note: 'Restored runtime interpretation provider.' };
  const repaired = await repairApi(`/${failureId}/retry`, retryBody);
  assert.equal(repaired.statusCode, 200, JSON.stringify(repaired.json)); assert.equal(repaired.json.recovered, true, JSON.stringify(repaired.json));
  assert.equal((await pool.query('select status from client_evidence_requests where id=$1', [exhausted.id])).rows[0].status, 'resolved');
  const afterRepair = calls;
  assert.equal((await repairApi(`/${failureId}/retry`, retryBody)).json.executed, false); assert.equal(calls, afterRepair);
  globalThis.fetch = offlineProvider;
  // A known question remains accountable when its country context is broken.
  // Inbox visibility must not turn that visibility into permission to apply.
  const brokenCountry = await seed('broken-country', null);
  await pool.query('update clients set jurisdiction=null where id=$1', [brokenCountry.client_id]);
  const beforeBrokenCountry = calls;
  await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: brokenCountry.id,
    reply: 'We are not VAT registered.', actorId: 'owner@example.test', actorType: 'client' });
  await recoverOwnerRepliesInDb({ firmId }); await recoverOwnerRepliesInDb({ firmId });
  const brokenSource = (await pool.query('select * from client_evidence_requests where id=$1', [brokenCountry.id])).rows[0];
  assert.equal(brokenSource.response_payload.reply_processing.state, 'exhausted');
  assert.equal(brokenSource.response_payload.reply_processing.attempts, 3);
  assert.equal(brokenSource.response_payload.reply_processing.code, 'OWNER_REPLY_JURISDICTION_UNRESOLVED');
  assert.equal(calls, beforeBrokenCountry, 'unresolved jurisdiction cannot buy an interpretation');
  assert.equal((await pool.query("select profile->'vat_registration' registration from clients where id=$1", [brokenCountry.client_id])).rows[0].registration, null);
  const brokenFailureId = brokenSource.response_payload.reply_processing.failure_id;
  globalThis.fetch = async (endpoint, options) => endpoint === 'https://structured-auth.test/auth/v1/user'
    ? new Response(JSON.stringify({ id: 'user-owner', email: 'owner@example.test' }), { status: 200 })
    : repairProvider(endpoint, options);
  assert.ok((await repairApi()).json.incidents.some(item => item.failure_id === brokenFailureId), 'known owed reply stays visible with unresolved country');
  await pool.query("update client_evidence_requests set audience='seat',addressee_principal_type='firm_member',addressee_principal_id='member' where id=$1", [brokenCountry.id]);
  assert.equal((await repairApi()).json.incidents.some(item => item.failure_id === brokenFailureId), false, 'visibility retains the client audience boundary');
  await pool.query("update client_evidence_requests set audience='client',addressee_principal_type=null,addressee_principal_id=null where id=$1", [brokenCountry.id]);
  assert.equal((await repairApi(`/${brokenFailureId}/claim`, {})).statusCode, 200);
  await pool.query("update clients set jurisdiction='ae' where id=$1", [brokenCountry.client_id]);
  const countryRepair = await repairApi(`/${brokenFailureId}/retry`, { idempotency_key: 'restore-country-source', repair_note: 'Restored the original canonical client jurisdiction.' });
  assert.equal(countryRepair.statusCode, 200, JSON.stringify(countryRepair.json));
  assert.equal(countryRepair.json.recovered, true, JSON.stringify(countryRepair.json));
  assert.equal((await pool.query('select status from client_evidence_requests where id=$1', [brokenCountry.id])).rows[0].status, 'resolved');
  assert.equal((await pool.query("select metadata->>'recovered_failure_id' id from audit_events where action='evidence_request.reply_processed' and resource_id=$1", [brokenCountry.id])).rows[0].id, brokenFailureId);
  globalThis.fetch = offlineProvider;
  for (const table of unchangedTables) {
    assert.equal((await pool.query(`select count(*)::int n from ${table}`)).rows[0].n, baseline[table], table);
  }
});
