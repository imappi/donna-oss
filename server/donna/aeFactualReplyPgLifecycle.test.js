import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, resolveClientEvidenceRequestInDb, updateClientProfileInDb } from './firmDb.js';
import { drainAeCtRegistrationEscalations, drainAeVatReturnDeadlineEscalations } from './ae/statutoryDb.js';
import { processStructuredOwnerReplyWithClient } from './structuredOwnerReply.js';
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
import { recoverOwnerRepliesInDb } from './ownerReplyRecovery.js';
import { buildDesktopHandlerManifest } from './desktop/handlerManifest.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('U18-S2 generated UAE asks: ordinary replies, factual writers, source fences and existing statutory continuation', async t => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL is required for the real UAE factual reply lifecycle');
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_ae_factual_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 3 });
  // pg-pool.end() can resolve after removing idle clients but before their
  // protocol shutdown finishes. FORCE-dropping here would kill those sockets.
  const openConnections = new Set(), connectionsClosed = [];
  pool.on('connect', connection => {
    openConnections.add(connection);
    connectionsClosed.push(new Promise(resolve => connection.once('end', () => {
      openConnections.delete(connection); resolve();
    })));
  });
  __setFirmDbPoolForTests(pool);
  const envKeys = ['DONNA_DESKTOP_BLOB_DIR','ANTHROPIC_API_KEY','DATABASE_URL','DONNA_ACCESS_TOKEN','SUPABASE_URL','SUPABASE_PUBLISHABLE_KEY','DONNA_AUTH_ALLOWED_EMAILS'];
  const priorEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]])), priorFetch = globalThis.fetch;
  Object.assign(process.env, { ANTHROPIC_API_KEY: 'fixture-only', DATABASE_URL: url.toString(), DONNA_ACCESS_TOKEN: 'fixture-token',
    SUPABASE_URL: 'https://ae-factual-auth.test', SUPABASE_PUBLISHABLE_KEY: 'fixture', DONNA_AUTH_ALLOWED_EMAILS: '' });
  t.after(async () => {
    try {
      __resetFirmDbPoolForTests();
      await pool.end();
      await Promise.all(connectionsClosed);
      assert.equal(openConnections.size, 0, 'every test connection must finish protocol shutdown before DROP');
      const remaining = await admin.query(`select count(*)::int n,
        coalesce(json_agg(json_build_object(
          'pid', pid, 'backend_type', backend_type, 'state', state, 'query', query,
          'xact_start', xact_start, 'application_name', application_name,
          'backend_start', backend_start, 'state_change', state_change
        ) order by pid), '[]'::json) sessions
        from pg_stat_activity where datname=$1`, [name]);
      assert.equal(remaining.rows[0].n, 0, `the scratch database must have no remaining sessions before DROP: ${JSON.stringify({ database: name, ...remaining.rows[0] })}`);
      await admin.query(`drop database "${name}"`);
    } finally {
      await admin.end();
      globalThis.fetch = priorFetch;
      for (const key of envKeys) { if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]; }
    }
  });
  await pool.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'ae-factual-firm', memberId = 'ae-factual-member';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic factual reply firm','ae-factual-firm')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,email,name,status) values($1,$2,'ae-owner@example.test','Synthetic owner','active')", [memberId, firmId]);
  const trn = '100123456789012', ct = { registered: true, trn, registered_from: '2026-01-01' };
  const period = { period_key: '2026-01-01/2026-03-31', start_date: '2026-01-01', end_date: '2026-03-31', due_date: '2026-04-28' };
  let calls = 0;
  const outage = async () => new Response(JSON.stringify({ error: { message: 'synthetic provider outage' } }), { status: 503 });
  const provider = (answer, before = null, clarification = null) => async (_endpoint, options) => {
    calls++; const body = JSON.parse(options.body); assert.equal(body.tool_choice.name, 'interpret_owner_reply');
    if (before) await before(body);
    return new Response(JSON.stringify({ model: 'synthetic-owner-reply-recording', stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'interpret_owner_reply',
      input: { answer, confidence: answer ? 0.99 : 0.2, clarification } }] }), { status: 200 });
  };
  const readAsk = async id => (await pool.query('select * from client_evidence_requests where id=$1', [id])).rows[0];
  const readProfile = async id => (await pool.query('select profile from clients where id=$1', [id])).rows[0].profile;
  const generate = async (id, kind = 'ct_registration_status') => {
    await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic UAE Ltd','ae','{\"jurisdiction\":\"ae\"}')", [id,firmId]);
    if (kind === 'vat_return_period_intake') await updateClientProfileInDb({ firmId, clientId: id, profilePatch: { vat_registration: {
      status: 'registered', registered_from: '2026-01-01', vat_registration_number: trn, verified_from: 'synthetic owner setup' } }, actorId: memberId, dbClient: pool });
    if (kind === 'ct_registration_deadline') await updateClientProfileInDb({ firmId, clientId: id,
      profilePatch: { ct_registration: { status: 'not_registered' } }, actorId: memberId, dbClient: pool });
    const client = await pool.connect();
    try { const drain = kind === 'vat_return_period_intake' ? drainAeVatReturnDeadlineEscalations : drainAeCtRegistrationEscalations;
      assert.equal((await drain({ client, firmId, asOf: '2026-01-01', deliverAsksImpl: async () => {} })).errors, 0); }
    finally { client.release(); }
    const ask = (await pool.query('select * from client_evidence_requests where client_id=$1 and evidence_type=$2', [id,kind])).rows[0];
    assert.ok(ask, 'actual statutory drain generated the ask'); return ask;
  };
  const reply = async (ask, fetchImpl = outage, text = 'We registered for corporate tax effective 1 January 2026, CT TRN 100123456789012.', actorId = 'ae-owner@example.test', documentIds = []) => {
    globalThis.fetch = fetchImpl;
    await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: ask.id, reply: text, actorId, actorType: 'client', documentIds });
    return readAsk(ask.id);
  };
  const run = async (request, fetchImpl = provider(ct)) => {
    const client = await pool.connect();
    try { return await processStructuredOwnerReplyWithClient({ client, firmId, request, expectedReplyKey: ownerReplyIdentity(request), env: { ANTHROPIC_API_KEY: 'fixture-only' }, fetchImpl }); }
    finally { client.release(); }
  };
  const clear = await reply(await generate('clear'), provider(ct));
  assert.equal(clear.status, 'resolved'); assert.equal(clear.resolved_by, memberId);
  const registered = (await readProfile('clear')).ct_registration;
  assert.equal(registered.status, 'registered'); assert.equal(registered.ct_registration_number, trn); assert.equal(registered.registered_from, '2026-01-01');
  assert.equal(registered.verified_at, null); assert.match(registered.verified_from, /owner attestation/);
  assert.equal(clear.response_payload.reply_processing.driven_action, 'record_ct_registration_reply');
  assert.equal(clear.response_payload.reply_processing.model, 'synthetic-owner-reply-recording');
  const jobs = (await pool.query("select * from local_jobs where payload->>'client_id'='clear'")).rows;
  assert.equal(jobs.length, 1); assert.equal(jobs[0].function_id, 'parse-cron:statutory_watches'); assert.equal(jobs[0].handler_version, '2');
  const beforeDuplicate = calls; await assert.rejects(run(clear), { code: 'OWNER_REPLY_SUPERSEDED' }); assert.equal(calls, beforeDuplicate);
  const negative = await reply(await generate('negative'), provider({ registered: false }), 'We have not registered for corporate tax.');
  assert.equal(negative.status, 'resolved'); assert.equal((await readProfile('negative')).ct_registration.status, 'not_registered');
  // Execute the existing clock handler against its real statutory drain, with
  // only channel delivery suppressed for this synthetic engineering fixture.
  const handler = buildDesktopHandlerManifest({ deps: { runParseCronTask: async ({ task }) => {
    assert.equal(task, 'statutory_watches'); const client = await pool.connect();
    try { return drainAeCtRegistrationEscalations({ client, firmId, asOf: '2026-01-01', deliverAsksImpl: async () => {} }); } finally { client.release(); }
  } } }).find(item => item.functionId === jobs[0].function_id);
  assert.ok(handler); await handler.run({ step: { run: (_name, work) => work() } });
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where client_id='clear' and status <> 'resolved'")).rows[0].n, 0);
  let deadline = (await pool.query("select * from client_evidence_requests where client_id='negative' and evidence_type='ct_registration_deadline'")).rows[0];
  assert.equal(deadline.status, 'open');
  deadline = await reply(deadline, provider(ct)); assert.equal(deadline.status, 'resolved');
  // An older pending status reply cannot overwrite a newer registration
  // completed through the actual sibling deadline consumer.
  const older = await reply(await generate('older'), outage, 'We are not registered.');
  await updateClientProfileInDb({ firmId, clientId: 'older', profilePatch: { ct_registration: { status: 'not_registered' } }, actorId: memberId, dbClient: pool });
  await handler.run({ step: { run: (_name, work) => work() } });
  const newerAsk = (await pool.query("select * from client_evidence_requests where client_id='older' and evidence_type='ct_registration_deadline'")).rows[0];
  assert.equal((await reply(newerAsk, provider(ct))).status, 'resolved');
  const newerRecord = (await readProfile('older')).ct_registration;
  const oldResult = await run(older, provider({ registered: false }));
  assert.equal(oldResult.superseded, true); assert.equal((await readAsk(older.id)).status, 'cancelled');
  assert.equal((await readAsk(older.id)).response_payload.reply_processing.driven_action, 'owner_reply_superseded');
  assert.deepEqual((await readProfile('older')).ct_registration, newerRecord);
  // A current positive record changed before inference is equally protected;
  // an identical answer closes idempotently without downgrading provenance.
  const alreadyRegistered = await reply(await generate('already-registered'));
  await updateClientProfileInDb({ firmId, clientId: 'already-registered', profilePatch: { ct_registration: {
    status: 'registered', ct_registration_number: trn, registered_from: '2026-01-01', verified_from: 'synthetic primary review fixture', verified_at: '2026-01-02'
  } }, actorId: memberId, dbClient: pool });
  const established = (await readProfile('already-registered')).ct_registration;
  assert.equal((await run(alreadyRegistered)).applied, true);
  assert.deepEqual((await readProfile('already-registered')).ct_registration, established);
  const changedBeforeRead = await reply(await generate('changed-before-read'));
  await updateClientProfileInDb({ firmId, clientId: 'changed-before-read', profilePatch: { ct_registration: established }, actorId: memberId, dbClient: pool });
  assert.equal((await run(changedBeforeRead, provider({ ...ct, registered_from: '2026-02-01' }))).superseded, true);
  assert.deepEqual((await readProfile('changed-before-read')).ct_registration, established);
  const periodAsk = await generate('period', 'vat_return_period_intake');
  const supplied = await reply(periodAsk, provider({ periods: [period] }), 'EmaraTax assigned 1 January to 31 March 2026, due 28 April 2026.');
  assert.equal(supplied.status, 'resolved');
  const storedPeriod = (await pool.query("select *, start_date::text start, end_date::text finish, due_date::text due from ae_vat_periods where client_id='period'")).rows[0];
  assert.equal(storedPeriod.start, period.start_date); assert.equal(storedPeriod.finish, period.end_date); assert.equal(storedPeriod.due, period.due_date);
  assert.equal(storedPeriod.trn, trn); assert.equal(storedPeriod.source.recorded_by, memberId); assert.match(storedPeriod.source.recorded_from, /owner attestation/);
  // Duplicate transport delivery cannot mint a second period, and the
  // shortcut still requires today's persisted registration identity.
  assert.equal((await reply(periodAsk, provider({ periods: [period] }), 'EmaraTax assigned 1 January to 31 March 2026, due 28 April 2026.')).status, 'resolved');
  assert.equal((await pool.query("select count(*)::int n from ae_vat_periods where client_id='period'")).rows[0].n, 1);
  await updateClientProfileInDb({ firmId, clientId: 'period', profilePatch: { vat_registration: { status: 'not_registered' } }, actorId: memberId, dbClient: pool });
  const invalidDuplicate = await reply(periodAsk);
  await assert.rejects(run(invalidDuplicate, provider({ periods: [period] })), { code: 'AE_VAT_REGISTRATION_NOT_ESTABLISHED' });
  assert.equal((await readAsk(periodAsk.id)).status, 'replied');
  // Supplied parsed evidence reaches the same interpretation input and its
  // content is rechecked after generation, before any factual write.
  const evidenceAsk = await generate('evidence');
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type) values('ct-evidence',$1,'evidence','synthetic-emaratax.pdf','statutory_record')", [firmId]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description) values('ct-evidence-line',$1,'evidence','ct-evidence',1,'CT TRN 100123456789012, effective 1 January 2026')", [firmId]);
  const evidenceReply = await reply(evidenceAsk, outage, 'The registration details are in the attached account record.', 'ae-owner@example.test', ['ct-evidence']);
  await assert.rejects(run(evidenceReply, provider(ct, async body => {
    assert.match(body.messages[0].content, /CT TRN 100123456789012, effective 1 January 2026/);
    await pool.query("update document_lines set description='Changed account record: registration uncertain' where id='ct-evidence-line'");
  })), { code: 'OWNER_REPLY_SUPERSEDED' });
  assert.equal((await readProfile('evidence')).ct_registration, undefined);
  const unclear = await reply(await generate('unclear'), provider(null, null, 'Please give the effective CT registration date and separate CT TRN.'), 'I think so.');
  assert.equal(unclear.status, 'open'); assert.equal(unclear.request_payload.evidence_topic.turns.length, 1);
  await assert.rejects(run(unclear), { code: 'OWNER_REPLY_SUPERSEDED' });
  const stale = await reply(await generate('stale'));
  await assert.rejects(run(stale, provider(ct, async () => { await reply(stale, outage, 'Actually we are not registered.'); })), { code: 'OWNER_REPLY_SUPERSEDED' });
  assert.equal((await readProfile('stale')).ct_registration, undefined);
  const changed = await reply(await generate('changed'));
  await assert.rejects(run(changed, provider(ct, async () => { await pool.query("update clients set profile=profile || '{\"new_fact\":true}'::jsonb where id='changed'"); })), { code: 'OWNER_REPLY_SUPERSEDED' });
  assert.equal((await readProfile('changed')).ct_registration, undefined);
  const revoked = await reply(await generate('revoked'));
  await assert.rejects(run(revoked, provider(ct, async () => { await pool.query("update firm_members set status='inactive' where id=$1", [memberId]); })), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  assert.equal((await readProfile('revoked')).ct_registration, undefined); await pool.query("update firm_members set status='active' where id=$1", [memberId]);
  const foreign = await reply(await generate('foreign'), outage, 'Registered from 1 January 2026, CT TRN 100123456789012.', 'foreign@example.test');
  await assert.rejects(run(foreign), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  // Both clarification branches carry the same live-actor requirement.
  const clarifyRevoked = await reply(await generate('clarify-revoked'));
  await pool.query("update firm_members set status='inactive' where id=$1", [memberId]);
  const beforeRevokedRead = calls;
  await assert.rejects(run(clarifyRevoked, provider(null, null, 'Please supply the CT TRN.')), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  assert.equal(calls, beforeRevokedRead); assert.equal((await readAsk(clarifyRevoked.id)).status, 'replied');
  await pool.query("update firm_members set status='active' where id=$1", [memberId]);
  await assert.rejects(run(clarifyRevoked, provider(null, async () => {
    await pool.query("update firm_members set status='inactive' where id=$1", [memberId]);
  }, 'Please supply the CT TRN.')), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  assert.equal((await readAsk(clarifyRevoked.id)).request_payload.evidence_topic, undefined);
  await pool.query("update firm_members set status='active' where id=$1", [memberId]);
  await assert.rejects(run(foreign, provider(null, null, 'Please confirm the CT status.')), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  await pool.query("update firm_members set access_level='viewer' where id=$1", [memberId]);
  await assert.rejects(run(clarifyRevoked), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  await pool.query("update firm_members set access_level='staff' where id=$1", [memberId]);
  const collaboratorAsk = await generate('collaborator');
  await pool.query("insert into firm_collaborators(id,firm_id,email,name,role) values('reply-collaborator',$1,'client-human@example.test','Synthetic client human','owner')", [firmId]);
  await pool.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values('reply-assignment',$1,'collaborator','firm_collaborator','reply-collaborator','owner')", [firmId]);
  const collaboratorReply = await reply(collaboratorAsk, outage, 'CT registered from 1 January 2026, TRN 100123456789012.', 'client-human@example.test');
  await assert.rejects(run(collaboratorReply, provider(ct, async () => {
    await pool.query("update client_assignments set status='ended' where id='reply-assignment'");
  })), { code: 'AE_FACTUAL_REPLY_ACTOR_REQUIRED' });
  await pool.query("update client_assignments set status='active' where id='reply-assignment'");
  assert.equal((await run(collaboratorReply)).applied, true);
  assert.equal((await readAsk(collaboratorAsk.id)).resolved_by, 'reply-collaborator');
  const clockFailure = await reply(await generate('clock-failure'));
  await pool.query(`create function fail_factual_clock() returns trigger language plpgsql as $$ begin if new.payload->>'client_id'='clock-failure' then raise exception 'synthetic clock failure'; end if; return new; end $$;
    create trigger fail_factual_clock before insert on local_jobs for each row execute function fail_factual_clock()`);
  await assert.rejects(run(clockFailure), /synthetic clock failure/);
  assert.equal((await readProfile('clock-failure')).ct_registration, undefined);
  assert.equal((await readAsk(clockFailure.id)).status, 'replied');
  // The existing profile writer's caller-owned mode never commits or poisons
  // the surrounding transaction, including a database-level write failure.
  const profileClient = await pool.connect();
  try {
    await assert.rejects(updateClientProfileInDb({ firmId, clientId: 'clock-failure', profilePatch: { ct_registration: { status: 'not_registered' } }, actorId: memberId, dbClient: profileClient, manageTransaction: false }), /SAVEPOINT can only be used in transaction blocks/);
    await profileClient.query('begin');
    await updateClientProfileInDb({ firmId, clientId: 'clock-failure', profilePatch: { ct_registration: { status: 'not_registered' } }, actorId: memberId, dbClient: profileClient, manageTransaction: false });
    assert.equal((await readProfile('clock-failure')).ct_registration, undefined, 'caller has not committed');
    await profileClient.query('rollback');
    assert.equal((await readProfile('clock-failure')).ct_registration, undefined);
    await pool.query(`create function fail_profile_audit() returns trigger language plpgsql as $$ begin if new.action='client.profile.update' and new.client_id='clock-failure' then raise exception 'synthetic profile audit failure'; end if; return new; end $$;
      create trigger fail_profile_audit before insert on audit_events for each row execute function fail_profile_audit()`);
    await profileClient.query('begin');
    await assert.rejects(updateClientProfileInDb({ firmId, clientId: 'clock-failure', profilePatch: { ct_registration: { status: 'not_registered' } }, actorId: memberId, dbClient: profileClient, manageTransaction: false }), /synthetic profile audit failure/);
    assert.equal((await profileClient.query('select 1 as usable')).rows[0].usable, 1, 'savepoint failure preserves usable outer transaction');
    await profileClient.query('commit');
    assert.equal((await readProfile('clock-failure')).ct_registration, undefined);
  } finally { await profileClient.query('rollback'); profileClient.release(); }
  const atomic = await reply(await generate('atomic'));
  await pool.query(`create function fail_factual_receipt() returns trigger language plpgsql as $$ begin if new.action='evidence_request.reply_processed' and new.client_id='atomic' then raise exception 'synthetic receipt failure'; end if; return new; end $$;
    create trigger fail_factual_receipt before insert on audit_events for each row execute function fail_factual_receipt()`);
  await assert.rejects(run(atomic), /synthetic receipt failure/);
  assert.equal((await readProfile('atomic')).ct_registration, undefined); assert.equal((await readAsk(atomic.id)).status, 'replied');
  assert.equal((await pool.query("select count(*)::int n from local_jobs where payload->>'client_id'='atomic'")).rows[0].n, 0);
  // Retry only the selected outage source; other failure cases remain separate.
  await pool.query("update client_evidence_requests set status='open' where status='replied'");
  const retry = await reply(await generate('retry'));
  assert.equal(retry.response_payload.reply_processing.state, 'retry_pending'); globalThis.fetch = provider(ct);
  await recoverOwnerRepliesInDb({ firmId }); assert.equal((await readAsk(retry.id)).status, 'resolved');
  const afterRetry = calls; await recoverOwnerRepliesInDb({ firmId }); assert.equal(calls, afterRetry);
  // Mounted authenticated ordinary-text route carries the real source actor.
  const portalAsk = await generate('portal');
  globalThis.fetch = async (endpoint, options) => endpoint === 'https://ae-factual-auth.test/auth/v1/user'
    ? new Response(JSON.stringify({ id: 'ae-user', email: 'ae-owner@example.test' }), { status: 200 }) : provider(ct)(endpoint, options);
  const portal = await requestDonnaApi({ pool, method: 'POST', url: `/api/donna/firms/evidence/requests/${portalAsk.id}/resolve`,
    headers: { authorization: 'Bearer owner-session' }, body: { firm_id: firmId, reply: 'CT registration effective 1 January 2026, corporate tax TRN 100123456789012.' } });
  __setFirmDbPoolForTests(pool); assert.equal(portal.statusCode, 200, JSON.stringify(portal.json));
  assert.equal((await readAsk(portalAsk.id)).status, 'resolved');
  // Actual appliance bearer authentication must resolve a real persisted
  // member, not a fixture-injected auth object or the transport token string.
  process.env.DONNA_DESKTOP_BLOB_DIR = '/tmp/ae-factual-synthetic-host';
  const applianceAsk = await generate('appliance');
  globalThis.fetch = provider(ct);
  const applianceReply = async ask => {
    const response = await requestDonnaApi({ pool, method: 'POST', url: `/api/donna/firms/evidence/requests/${ask.id}/resolve`,
      headers: { authorization: 'Bearer fixture-token' }, body: { firm_id: firmId, reply: 'CT registration effective 1 January 2026, corporate tax TRN 100123456789012.' } });
    __setFirmDbPoolForTests(pool); return response;
  };
  const appliance = await applianceReply(applianceAsk);
  assert.equal(appliance.statusCode, 200, JSON.stringify(appliance.json));
  const applianceSaved = await readAsk(applianceAsk.id);
  assert.equal(applianceSaved.status, 'resolved'); assert.equal(applianceSaved.response_payload.reply_processing.actor_id, memberId);
  const sourceActor = (await pool.query("select actor_id from audit_events where resource_id=$1 and action='evidence_request.reply'", [applianceAsk.id])).rows[0];
  assert.equal(sourceActor.actor_id, memberId);
  const applianceViewerAsk = await generate('appliance-viewer');
  await pool.query("update firm_members set access_level='viewer' where id=$1", [memberId]);
  assert.equal((await applianceReply(applianceViewerAsk)).statusCode, 403);
  assert.equal((await readAsk(applianceViewerAsk.id)).status, 'open');
  await pool.query("update firm_members set access_level='staff',status='inactive' where id=$1", [memberId]);
  assert.equal((await applianceReply(applianceViewerAsk)).statusCode, 409);
  assert.equal((await readAsk(applianceViewerAsk.id)).status, 'open');
  await pool.query("update firm_members set status='active' where id=$1", [memberId]);
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  for (const table of ['ledger_journals','firm_facts','memory_candidates','memories','memory_relations','client_rules','accounting_rules']) {
    assert.equal((await pool.query(`select count(*)::int n from ${table}`)).rows[0].n, 0, table);
  }
});
