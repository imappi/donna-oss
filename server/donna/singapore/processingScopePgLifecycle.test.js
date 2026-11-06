import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import donnaRouter from '../../../api/donna-router.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { createClientInDb, updateClientProfileInDb } from '../db/clients.js';
import { updateTransactionInDb } from '../db/transactions.js';
import { updateTransactionReviewItemInDb, resolveClientCodingPolicyWithClient, ensureTransactionReviewItemInDb } from '../db/coding.js';
import { postLedgerAdjustmentInDb } from '../db/ledger.js';
import { setClientFlagStage, readClientConfigSnapshot } from '../clientConfig.js';
import { sweepLedgerAutoPost, DISCOVER_LEDGER_POST_CLIENTS_SQL, ELIGIBLE_LINES_SQL } from '../ledgerAutoPost.js';
import { readNativeChartLineage } from '../nativeChartLineage.js';
import { listRuntimePolicyIncidents, claimRuntimePolicyIncident, requestRuntimePolicyIncidentRetry } from '../runtimePolicyIncidentDb.js';
import { retryRuntimePolicyIncidentInDb } from '../runtimePolicyRepairs.js';
import { proveNativeAndReservedReports } from './testSupport/reportProof.js';
import { attachCurrentNativeReviewProjection, getFirmSnapshotFromDb } from '../db/snapshot.js';
import { nativeCodingSourceReceipt, readNativeReviewContexts } from '../db/codingEvidence.js';
import { decodeNativeCodingChoice } from '../codingAccountChoices.js';
import { codingPolicyReceipt } from '../codingPolicy.js';
import { applyConvergenceState, settleConvergenceMarks, settleConvergenceForRead, computeConvergenceForTransactions, hookPooledClient } from '../reconcileConvergenceState.js';
import { readJevCase, readJevTransactionCases, codingCaseRevision } from '../jevPreview.js';
import { bindConvergenceConnection, unbindConvergenceConnection, withConvergenceTransaction } from '../convergenceConnection.js';
import { runReconciliationForBankStatementInDb } from '../parseDocumentsDb.js';
import { createExecutionBudget, runWithExecutionBudget, assertExecutionBudgetActive, assertVerdictTransactionBudgetActive } from '../executionBudget.js';

test('real PG/HTTP: retained processing scope refuses accounting commands with flag off and immutable native chart', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `sg_scope_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 2000 });
  __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: 'scope-firm',
    VERCEL: '1', VERCEL_PROJECT_ID: 'scope-fixture', VERCEL_ENV: 'preview',
    VERCEL_DEPLOYMENT_ID: 'scope-fixture', VERCEL_GIT_COMMIT_SHA: 'scope-fixture',
    SUPABASE_URL: 'https://scope.invalid', SUPABASE_ANON_KEY: 'fixture',
    DONNA_ACCESS_TOKEN: 'unused-fixture-token', ANTHROPIC_API_KEY: 'fixture-no-network',
    RECONCILIATION_MATCHER_LLM_MODEL: '', UNIFIED_EXTRACTOR_MODEL: '',
    DONNA_AUTH_ALLOWED_EMAILS: 'member@scope.invalid,foreign@scope.invalid,collaborator@scope.invalid', DONNA_DESKTOP_BLOB_DIR: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (address, init) => {
    assert.equal(address, 'https://scope.invalid/auth/v1/user', 'no model, provider or external send');
    const token = init.headers.Authorization.replace('Bearer ', '');
    return new Response(JSON.stringify({ id: `user-${token}`, email: `${token}@scope.invalid` }));
  };
  const rewrites = JSON.parse(await readFile(new URL('../../../vercel.json', import.meta.url), 'utf8')).rewrites;
  const server = http.createServer((req, res) => {
    const source = new URL(req.url, 'http://fixture');
    const rule = rewrites.find(row => row.source === source.pathname)
      || rewrites.find(row => ['/api/donna/firms/transactions/:id','/api/donna/firms/transaction-review/:id'].includes(row.source)
        && source.pathname.startsWith(row.source.slice(0,-3)));
    if (!rule) { res.statusCode = 404; res.end('{}'); return; }
    const destination = new URL(rule.destination.replace(':id',source.pathname.split('/').at(-1)), 'http://fixture');
    for (const [key,value] of source.searchParams) destination.searchParams.append(key,value);
    req.url = destination.pathname + destination.search;
    donnaRouter(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const request = (route, body, token = 'member', method = body === undefined ? 'GET' : 'POST') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.address().port,
      path: `/api/donna/firms/${route}`, method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` } }, res => {
      let text = ''; res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.setTimeout(20000, () => req.destroy(new Error('HTTP fixture timed out')));
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    __resetFirmDbPoolForTests(); await pool.end(); await seed.end();
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await seed.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  for (const file of (await readdir(new URL('../../../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  const firmId = 'scope-firm', clientId = 'scope-native';
  for (const [firm, member] of [[firmId, 'member'], ['foreign-firm', 'foreign']]) {
    await seed.query('insert into firms(id,name,slug) values($1,$1,$1)', [firm]);
    await seed.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
      values($1,$2,$3,$4,'Synthetic member','admin','active','owner')`, [member, firm, `user-${member}`, `${member}@scope.invalid`]);
  }
  const create = (id, native = false, jurisdiction = 'SG', scopedFirm = firmId) => createClientInDb({ firmId:scopedFirm, dbClient: seed,
    profile: { id, companyName: `Synthetic ${id}`, uen: '202300001A', jurisdiction,
      entityType: jurisdiction === 'SG' ? 'sg-pte' : 'fi-oy', accounting_system: 'none',
      accounting_view: 'management_books', defaultCurrency: jurisdiction === 'SG' ? 'SGD' : 'EUR' },
    creationPrincipal: { principalType: 'firm_member', principalId: scopedFirm===firmId?'member':'foreign', authoritySource: 'authenticated_firm_create_route' },
    ...(native ? { birthContract: { id: 'sg_pte_native.v1', bookkeeping_start_date: '2026-01-01',
      registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } } } : {}) });
  await proveConvergenceOwnership({ t, seed, url: url.toString() });
  await create(clientId, true);
  await setClientFlagStage(seed, { firmId, clientId, flagKey: 'ENTITY_READINESS_ADMISSION', stage: 'off',
    source: 'manual', reason: 'Synthetic scope proof: a flag cannot authorize accounting', actorType: 'firm_member', actorId: 'member' });
  await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
    values('scope-target',$1,$2,'2026-02-15','Synthetic source',12,'SGD','applied')`, [firmId, clientId]);
  // An old applied row deliberately has no review receipt. It is not acceptance evidence.
  const snapshot = async () => {
    const result = {};
    for (const table of ['ledger_accounts', 'ledger_journals', 'ledger_lines', 'close_periods', 'close_checks']) {
      result[table] = (await seed.query(`select * from ${table} where firm_id=$1 and client_id=$2 order by id`, [firmId, clientId])).rows;
    }
    return result;
  };
  // Exercise mounted route writes before adding the unrelated 20,000-line cost fixture.
  await proveReviewAcceptance({ t, seed, pool, firmId, create, request, url:url.toString() });
  await proveReviewInvalidation({ t, seed, firmId, clientId, create, url:url.toString() });
  const before = await snapshot(); assert.equal(before.ledger_accounts.length, 58);
  const body = { firm_id: firmId, client_id: clientId, transaction_id: 'scope-target',
    period_start: '2026-02-01', period_end: '2026-02-28', dry_run: false, execute: true,
    reason: 'Synthetic forbidden accounting command', journal_date: '2026-02-15' };
  await t.test('actual authenticated commands refuse; force and repeats do not create journals or close rows', async () => {
    for (const route of ['ledger/post-transaction', 'ledger/post-period', 'ledger/adjustment', 'close/lock']) {
      for (const force of [false, true]) {
        const result = await request(route, { ...body, force });
        assert.equal(result.status, 409, JSON.stringify({ route, result }));
        assert.equal(result.body.code, 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE', JSON.stringify(result));
        assert.deepEqual(await snapshot(), before);
      }
    }
    const failed = (await seed.query(`select * from audit_events where client_id=$1
      and action='transaction.coding.policy_failed' and resource_id='scope-target'`, [clientId])).rows;
    assert.equal(failed.length, 1, 'actual anchored attempts coalesce from the first permanent refusal');
    assert.equal(failed[0].metadata.retry_safe, false);
    assert.equal(failed[0].metadata.attempted_by, 'member');
    const foreign = await request('ledger/post-transaction', body, 'foreign');
    assert.equal(foreign.status, 403); assert.deepEqual(await snapshot(), before);
  });
  await t.test('retained posting incident cannot retry; a historical leased request closes refused without a successor or provider call',async()=>{
    const principal={principalType:'firm_member',principalId:'member'};
    const incident=(await listRuntimePolicyIncidents({client:seed,firmId})).find(row=>row.transaction_id==='scope-target');
    assert.ok(incident);assert.equal(incident.can_retry,false);
    const failureId=incident.failure_id;
    const captureInbox=async name=>{
      const result=await request(`runtime-policy-incidents?firm_id=${firmId}`);
      assert.equal(result.status,200,JSON.stringify(result.body));
      const directory=process.env.DONNA_TEST_ARTIFACTS_DIR;
      if(directory){await mkdir(directory,{recursive:true});await writeFile(path.join(directory,name),JSON.stringify(result.body,null,2));}
    };
    await captureInbox('repairs-unclaimed.json');
    await claimRuntimePolicyIncident({client:seed,firmId,failureId,principal});
    await captureInbox('repairs-claimed.json');
    await assert.rejects(()=>requestRuntimePolicyIncidentRetry({client:seed,firmId,failureId,principal,
      idempotencyKey:'new-blocked-request',repairNote:'Synthetic unchanged processing scope'}),{code:'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE'});
    const metadata={failure_id:failureId,operation:'posting',authority_basis:'authenticated_workspace_maintainer',
      idempotency_key:'historical-leased-request',repair_note:'Synthetic request persisted before scope enforcement',lease_seconds:300};
    const queued=(await seed.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'firm_member','member','runtime.policy_incident.retry_requested','transaction','scope-target',$3::jsonb) returning id`,
      [firmId,clientId,JSON.stringify(metadata)])).rows[0].id;
    const replay=()=>retryRuntimePolicyIncidentInDb({firmId,failureId,principal,idempotencyKey:metadata.idempotency_key,repairNote:metadata.repair_note});
    const refused=await replay();
    assert.equal(refused.executed,false);assert.equal(refused.recovered,false);
    assert.equal(refused.completion.outcome,'still_open');
    assert.equal(refused.completion.error_code,'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE');
    assert.equal(refused.incident.latest_retry.lease_active,false);assert.equal(refused.incident.can_retry,false);
    assert.deepEqual(await replay(),refused,'same request/completion, no new lease');
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='runtime.policy_incident.retry_completed' and metadata->>'retry_request_id'=$1",[String(queued)])).rows[0].n,1);
    assert.equal((await seed.query("select count(*)::int n from audit_events where action='runtime.policy_incident.retry_requested' and metadata->>'failure_id'=$1",[failureId])).rows[0].n,1);
    assert.equal((await seed.query('select count(*)::int n from ledger_journals where client_id=$1',[clientId])).rows[0].n,0);
  });
  await t.test('both generic writers reject set, replace and null review stamps before any write', async () => {
    for (const patch of ['review_scope','processing_scope','projection_freshness'].flatMap(key => [{[key]:{}},{[key]:null},{payload:{[key]:{}}},{payload:{[key]:null}}])) {
      for (const apply of [() => updateTransactionInDb({ firmId, transactionId: 'scope-target', patch }),
        () => updateTransactionReviewItemInDb({ firmId, reviewItemId: 'scope-target', patch })]) {
        await assert.rejects(apply, error => error.code === 'REVIEW_SCOPE_SERVER_OWNED');
      }
    }
    assert.equal((await seed.query("select payload->'review_scope' as stamp from transactions where id='scope-target'")).rows[0].stamp, null);
  });
  await t.test('real discovery and repeated selected-row sweeps remain inert after configuration changes',async()=>{
    const auditCount=async()=> (await seed.query("select count(*)::int n from audit_events where client_id=$1 and action in ('transaction.coding.policy_failed','ledger.auto_post_refused','runtime.policy_incident.retry_requested')",[clientId])).rows[0].n;
    const prior=await auditCount();
    for(const stage of ['auto','off','canary']){
      await setClientFlagStage(seed,{firmId,clientId,flagKey:'LEDGER_AUTO_POST',stage,source:'manual',reason:'Synthetic configuration-race proof',actorType:'firm_member',actorId:'member'});
      const configSnapshot=await readClientConfigSnapshot(seed,{firmId,clientId,strict:true});
      assert.ok(!(await seed.query(DISCOVER_LEDGER_POST_CLIENTS_SQL,[firmId,100])).rows.some(row=>row.client_id===clientId));
      assert.equal((await seed.query(ELIGIBLE_LINES_SQL,[firmId,clientId,20,'scope-target'])).rows.length,0);
      const outcome=await sweepLedgerAutoPost({firmId,clientId,transactionId:'scope-target',configSnapshot});
      assert.equal(outcome.gated,true);assert.equal(outcome.reason,stage==='off'?'flag_off':'processing_review_only');
      assert.equal(await auditCount(),prior,'routine selected work does not create refusal incidents or retry requests');
      assert.deepEqual(await snapshot(),before);
    }
  });
  await proveNativeAndReservedReports({ t, seed, firmId, nativeClientId: clientId, // Ordinary unmarked book: a hosted legacy26 book is review-only and refuses these
    // ledger writes (F-2), so the shared-arithmetic proof runs on a non-hosted client.
    createLegacy: id => createClientInDb({ firmId, dbClient: seed, profile: { id, companyName: `Synthetic ${id}`, uen: '202300001A',
      jurisdiction: 'SG', entityType: 'sg-pte', accounting_system: 'none', accounting_view: 'management_books', defaultCurrency: 'SGD' } }) });
  await t.test('independent FI correction still uses the existing correction journal writer', async () => {
    const neighbor = 'scope-fi-neighbor'; await create(neighbor, false, 'FI');
    assert.equal(await readNativeChartLineage({ query: seed.query.bind(seed), firmId, clientId: neighbor }), null);
    const result = await postLedgerAdjustmentInDb({ firmId, clientId: neighbor, journalDate: '2026-02-15',
      reason: 'Synthetic independent FI correction', actorId: 'member', reverseOriginal: false,
      lines: [{ account_code: '1910', account_name: 'Bank', account_type: 'bank', debit: 12, credit: 0, currency: 'EUR' },
        { account_code: '2000', account_name: 'Capital', account_type: 'equity', debit: 0, credit: 12, currency: 'EUR' }] });
    assert.equal(result.ledger_adjustment.journals.length, 1);
    assert.equal((await seed.query('select count(*)::int n from ledger_journals where client_id=$1', [neighbor])).rows[0].n, 1);
    assert.deepEqual(await snapshot(), before);
  });
});

async function proveReviewAcceptance({ t, seed, pool:originalPool, firmId, create, request, url }) {
  const exportProof = async (name,value) => {
    const directory=process.env.DONNA_TEST_ARTIFACTS_DIR;
    if (!directory) return;
    await mkdir(directory,{recursive:true});
    await writeFile(path.join(directory,name),JSON.stringify(value,null,2));
  };
  const stageAndAccept = async (clientId,transactionId,accept=true) => {
    const policy = await resolveClientCodingPolicyWithClient({ client: seed, firmId, clientId, businessDate: '2026-02-15' });
    const chosen = policy.nativeMenu.choices.find(row => row.code === '7000');
    assert.ok(chosen);
    const source = nativeCodingSourceReceipt((await readJevCase({ client: seed, firmId, clientId, transactionId, evidenceOnly: true })).caseEvidence);
    // Deliberately synthetic persisted proposal; this test proves the REAL
    // guarded acceptance writer, not provider generation (covered separately).
    const proposal = { ...decodeNativeCodingChoice(policy.nativeMenu, { proposed_account: chosen.handle,
      posting_requirement: 'single_account', tax_treatment: 'No GST', confidence: 'high', evidence_required: false }),
      coding_policy: codingPolicyReceipt(policy), native_source: source, source: 'synthetic_acceptance_fixture' };
    await seed.query("update transactions set payload=jsonb_build_object('ai_suggestion',$2::jsonb) where id=$1", [transactionId, JSON.stringify(proposal)]);
    const reviewItemId = await ensureTransactionReviewItemInDb({ firmId, clientId, transactionId });
    if(accept)await updateTransactionReviewItemInDb({ firmId, reviewItemId, actorId: 'member', returnSnapshot: false,
      reviewAuthority: { clientId, principal: { principalType:'firm_member', principalId:'member', userId:'user-member' } },
      distillFactsFn: async () => ({ candidates: [] }), patch: { status: 'resolved', review_state: 'accepted', account_code:chosen.code } });
    return (await seed.query('select * from transactions where id=$1', [transactionId])).rows[0];
  };
  await proveReviewWriteAuthority({ t, seed, firmId, create, request, stageAndAccept, originalPool, url });
  await t.test('ordinary authenticated review PATCH carries real actor without tax facts and refuses foreign scope',async()=>{
    const clientId='scope-normal-review',transactionId='scope-normal-review-target';await create(clientId,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic ordinary review',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    await stageAndAccept(clientId,transactionId,false);
    const reviewItemId=await ensureTransactionReviewItemInDb({firmId,clientId,transactionId});
    const body={firm_id:firmId,actor_id:'forged-body-actor',patch:{status:'resolved',review_state:'accepted'}};
    assert.equal((await request(`transaction-review/${reviewItemId}`,body,'foreign','PATCH')).status,403);
    assert.equal((await request(`transaction-review/${reviewItemId}`,{...body,firm_id:'foreign-firm'},'foreign','PATCH')).status,404);
    const response=await request(`transaction-review/${reviewItemId}`,body,'member','PATCH');
    assert.equal(response.status,200,JSON.stringify(response.body));
    const row=(await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
    assert.equal(row.payload.review_scope.accepted_by,'member');
    assert.equal((await readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]})).contexts.get(transactionId).review_current,true);
  });
  await t.test('current acceptance rejects changed decision, receipt and audit authority; intact neighbor stays valid', async () => {
    const clientId='scope-authority-matrix',transactionId='scope-authority-target';
    await create(clientId,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic authority matrix',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    const accepted=await stageAndAccept(clientId,transactionId),stamp=accepted.payload.review_scope;
    const current=async()=> (await readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]})).contexts.get(transactionId).review_current;
    assert.equal(await current(),true);
    const changedBodies=[
      {...stamp,firm_id:'foreign-firm'}, {...stamp,client_id:'another-client'},
      {...stamp,transaction_id:'another-transaction'}, {...stamp,accepted_by:'system'},
      {...stamp,authority_basis:null}, {...stamp,decision_digest:'forged'},
      {...stamp,account_code:'6000'}, {...stamp,client_life:{...stamp.client_life,after_delete_id:'999999'}},
      {...stamp,acceptance_audit:{store:'audit_events',id:'999999'}},
      {...stamp,policy:{...stamp.policy,policyVersion:0}}
    ];
    for (const changed of changedBodies) {
      await seed.query('begin');
      try {
        await seed.query("update transactions set payload=jsonb_set(payload,'{review_scope}',$2::jsonb) where id=$1",[transactionId,JSON.stringify(changed)]);
        assert.equal(await current(),false,JSON.stringify(changed));
      } finally {await seed.query('rollback');}
      assert.equal(await current(),true,'unchanged authority still validates after rejected mutation');
    }
    for (const mutation of [
      "update transactions set account_code='6000' where id=$1",
      "update transactions set coding_state='held' where id=$1"
    ]) {
      await seed.query('begin');
      try {
        await seed.query(mutation,[transactionId]);
        assert.equal(await current(),false,mutation);
      } finally {await seed.query('rollback');}
    }
    const audit=(await seed.query('select * from audit_events where id=$1',[stamp.acceptance_audit.id])).rows[0];
    await assert.rejects(()=>seed.query("update audit_events set actor_id='another-member' where id=$1",[audit.id]),{code:'23001'},'authority history is append-only');
    for(const changed of [{...audit,actor_id:'another-member'},{...audit,action:'transaction_review.update'},
      {...audit,firm_id:'foreign-firm',client_id:null},{...audit,metadata:{...audit.metadata,review_scope:null}}]){
      await seed.query('begin');
      try{
        const replacement=(await seed.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
          values($1,$2,$3,$4,$5,$6,$7,$8) returning id`,[changed.firm_id,changed.client_id,changed.actor_type,changed.actor_id,
          changed.action,changed.resource_type,changed.resource_id,JSON.stringify(changed.metadata)])).rows[0].id;
        await seed.query("update transactions set payload=jsonb_set(payload,'{review_scope,acceptance_audit,id}',to_jsonb($2::text)) where id=$1",[transactionId,replacement]);
        assert.equal(await current(),false,'a substituted audit cannot authorize the stored decision');
      }finally{await seed.query('rollback');}
    }
    assert.equal(await current(),true);
  });
  await t.test('generic focal state aliases and contact edits cannot revive an acceptance after values are restored',async()=>{
    const clientId='scope-retirement-aliases',transactionId='scope-retirement-target';await create(clientId,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic retirement source',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    const source={date:'2026-02-15',description:'Synthetic retirement source',money_in:0,money_out:12,currency:'SGD'};
    const read=async()=> (await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
    for(const [edit,restore] of [[{codingState:'held'},{codingState:'applied'}],[{status:'needs_client'},{status:'ready',codingState:'applied'}],
      [{evidence_request:{status:'open'}},{evidence_request:{status:'resolved'},codingState:'applied'}],[{contact:'Edited contact'},{contact:''}]]){
      await stageAndAccept(clientId,transactionId);
      const stamp=(await read()).payload.review_scope;
      const unrelated=await request(`transactions/${transactionId}`,{firm_id:firmId,patch:{...source,display_note:'presentation only'}},'member','PATCH');
      assert.equal(unrelated.status,200,JSON.stringify(unrelated.body));
      assert.deepEqual((await read()).payload.review_scope,stamp,'resubmitted identical source values are not focal edits');
      const mutate=patch=>request(`transactions/${transactionId}`,{firm_id:firmId,patch:{...source,...patch}},'member','PATCH');
      const changed=await mutate(edit);assert.equal(changed.status,200,JSON.stringify(changed.body));
      assert.ok(!(await read()).payload.review_scope,JSON.stringify(edit));
      const restored=await mutate(restore);assert.equal(restored.status,200,JSON.stringify(restored.body));
      assert.ok(!(await read()).payload.review_scope,'restoring a focal value cannot revive '+JSON.stringify(edit));
      await stageAndAccept(clientId,transactionId);
      assert.notEqual((await read()).payload.review_scope.acceptance_audit.id,stamp.acceptance_audit.id);
    }
  });
  await t.test('review writer category edit and restore retires old authority; presentation and fresh acceptance remain valid',async()=>{
    const clientId='scope-review-retirement',transactionId='scope-review-retirement-target';await create(clientId,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic review retirement',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    const accepted=await stageAndAccept(clientId,transactionId),stamp=accepted.payload.review_scope;
    const reviewItemId=await ensureTransactionReviewItemInDb({firmId,clientId,transactionId});
    const mutate=patch=>request(`transaction-review/${reviewItemId}`,{firm_id:firmId,patch:{status:'resolved',...patch}},'member','PATCH');
    const read=async()=> (await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
    assert.equal((await mutate({reviewer_note:'presentation only'})).status,200);
    assert.deepEqual((await read()).payload.review_scope,stamp);
    assert.equal((await mutate({category:'Edited category'})).status,200);
    assert.ok(!(await read()).payload.review_scope);
    assert.equal((await mutate({category:accepted.category})).status,200);
    assert.ok(!(await read()).payload.review_scope,'restoration cannot revive the prior acceptance');
    await stageAndAccept(clientId,transactionId);
    assert.notEqual((await read()).payload.review_scope.acceptance_audit.id,stamp.acceptance_audit.id);
    assert.equal((await readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]})).contexts.get(transactionId).review_current,true);
  });
  await t.test('real named acceptance co-commits a decision-bound audit; new unlinked source logically invalidates retained receipt', async () => {
    const clientId = 'scope-acceptance', transactionId = 'scope-accepted-source';
    await create(clientId, true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic review source',12,'SGD','proposed')`, [transactionId, firmId, clientId]);
    const row = await stageAndAccept(clientId,transactionId);
    assert.equal(row.coding_state, 'applied'); assert.equal(row.account_code, '7000');
    const stamp = row.payload.review_scope;
    assert.equal(stamp.accepted_by, 'member'); assert.equal(stamp.posting, 'unavailable');
    assert.equal(stamp.accounting_ready, false); assert.ok(stamp.acceptance_audit.id);
    const read = () => readNativeReviewContexts({ client: seed, firmId, clientId, transactionIds: [transactionId] });
    assert.equal((await read()).contexts.get(transactionId).review_current, true);
    const refresh = () => request(`case-snapshot?firm_id=${firmId}&client_id=${clientId}&focus_id=${transactionId}&include=transactions,convergence,case_health,timeline`);
    const currentHttp = await refresh();
    assert.equal(currentHttp.status,200,JSON.stringify(currentHttp.body));
    assert.equal(currentHttp.body.case_health.phase,'review_only');
    assert.equal(currentHttp.body.case_health.recovery.class,null);
    assert.equal(currentHttp.body.convergence.terminal,false);
    const canonicalEvent=currentHttp.body.timeline.events.find(event=>event.receipt_ref?.id===String(stamp.acceptance_audit.id));
    assert.equal(canonicalEvent.actor_id,'member');assert.equal(canonicalEvent.actor_name,'Synthetic member');
    const forged=await request(`transactions/${transactionId}`,{firm_id:firmId,patch:{review_scope:stamp}},'member','PATCH');
    assert.equal(forged.status,409,JSON.stringify(forged.body));
    await exportProof('current.json',currentHttp.body);
    const acceptanceAudit=(await seed.query('select * from audit_events where id=$1',[stamp.acceptance_audit.id])).rows[0];

    await applyConvergenceState(seed,{firmId,transactionId});
    const persisted=(await seed.query('select convergence_state,convergence_reason from transactions where id=$1',[transactionId])).rows[0];
    assert.deepEqual(persisted,{convergence_state:'hanging',convergence_reason:'processing_review_only'});
    await seed.query("update transactions set payload=payload || '{\"display_note\":\"unrelated\"}'::jsonb where id=$1", [transactionId]);
    assert.equal((await read()).contexts.get(transactionId).review_current, true, 'unrelated presentation metadata preserves authority');
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
      values('scope-later-local',$1,$2,'later.pdf','receipt','completed','2026-02-15',12,'SGD')`, [firmId, clientId]);
    assert.deepEqual((await seed.query("select payload->'review_scope' stamp from transactions where id=$1", [transactionId])).rows[0].stamp, stamp);
    const stale = (await read()).contexts.get(transactionId);
    assert.equal(stale.review_current, false); assert.equal(stale.review_reason, 'stale_review_receipt');
    assert.equal(stale.accounting_ready, false);
    const staleHttp = await refresh();
    assert.equal(staleHttp.status,200,JSON.stringify(staleHttp.body));
    assert.equal(staleHttp.body.focus_state.transaction.processing_scope.review_current,false);
    assert.equal(staleHttp.body.case_health.phase,'stuck');
    assert.equal(staleHttp.body.convergence.terminal,false);
    await exportProof('stale.json',staleHttp.body);

    const beforeSettle=await computeConvergenceForTransactions(seed,{firmId,transactionIds:[transactionId]});
    assert.equal(beforeSettle[0].processing_scope.review_current,false);
    assert.equal(beforeSettle[0].projection_freshness.status,'incomplete');
    await settleConvergenceMarks(seed,{firmId,clientId});
    const afterSettle=await computeConvergenceForTransactions(seed,{firmId,transactionIds:[transactionId]});
    assert.deepEqual(afterSettle[0].derived,{state:'hanging',reason:'processing_review_only'});
    assert.equal(afterSettle[0].processing_scope.review_current,false);
    assert.equal(afterSettle[0].projection_freshness.status,'current');
    await seed.query("delete from documents where id='scope-later-local'");
    assert.equal((await read()).contexts.get(transactionId).review_current,true,
      'existing content revisions restore the same acceptance when source bytes are restored');
    const restoredHttp=await refresh();
    const restoredRow=(await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
    const restoredAudit=(await seed.query('select * from audit_events where id=$1',[stamp.acceptance_audit.id])).rows[0];
    assert.deepEqual(restoredRow.payload.review_scope,stamp);assert.deepEqual(restoredAudit,acceptanceAudit);
    assert.equal(restoredHttp.body.case_health.phase,'review_only');
    assert.deepEqual(restoredHttp.body.timeline.events.find(event=>event.receipt_ref?.id===String(stamp.acceptance_audit.id)),canonicalEvent);
    assert.notEqual(restoredHttp.body.generated_at,currentHttp.body.generated_at);
    const restoration={proof:'restored-source-content-revision',review_status:'APPROVED_CONTENT_EQUIVALENCE_CLARIFICATION',
      changed:'Inserted unlinked scope-later-local document',restored:'Deleted that new document; original full bounded source content restored',
      same_acceptance_resurrects:true,before:{receipt:stamp,audit:acceptanceAudit},after:{receipt:restoredRow.payload.review_scope,audit:restoredAudit},
      refreshed_phase:restoredHttp.body.case_health.phase,refresh_generated_at:restoredHttp.body.generated_at,
      explanation:'Content-addressed source plus unchanged independent registration, policy, decision and current-life bindings reuse the same historical acceptance. Refresh minted no acceptance or acceptance timestamp.'};
    console.log(JSON.stringify(restoration));
    await exportProof('restored.json',restoredHttp.body);await exportProof('restoration-evidence.json',restoration);
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
      values('scope-later-local',$1,$2,'later.pdf','receipt','completed','2026-02-15',12,'SGD')`,[firmId,clientId]);
    const fresh=await stageAndAccept(clientId,transactionId);
    assert.notEqual(fresh.payload.review_scope.acceptance_audit.id,stamp.acceptance_audit.id);
    assert.equal((await read()).contexts.get(transactionId).review_current,true,'fresh named acceptance binds the changed evidence');
    assert.equal((await refresh()).body.case_health.phase,'review_only');
    assert.equal((await seed.query('select count(*)::int n from ledger_journals where client_id=$1', [clientId])).rows[0].n, 0);
  });
  await t.test('native NOWAIT restores actual claimed marks and two bounded readers on a pool of two report incomplete', async () => {
    const clientId='scope-acceptance',transactionId='scope-accepted-source';
    const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:2000});
    const blocker=new pg.Client({connectionString:url}); await blocker.connect();
    const marks=()=>seed.query('select id from convergence_marks where firm_id=$1 and client_id=$2 order by id',[firmId,clientId]);
    await seed.query("update transactions set description='Synthetic changed source' where id=$1",[transactionId]);
    const original=(await marks()).rows;
    assert.ok(original.length>0);
    let checkouts=0;const connect=pool.connect.bind(pool);
    pool.connect=(...args)=>{checkouts++;return connect(...args);};
    try {
      await blocker.query('begin');
      await blocker.query('select id from transactions where id=$1 for update',[transactionId]);
      await assert.rejects(()=>settleConvergenceMarks(pool,{firmId,clientId}),error=>error.code==='55P03' && error.nativeProjectionContention);
      assert.deepEqual((await marks()).rows,original,'failed autocommit settlement restores every claimed mark');
      checkouts=0;
      const refresh=async()=>{
        const client=await pool.connect();
        try {
          const settled=await settleConvergenceForRead(client,{firmId,clientId});
          const rows=(await client.query('select * from transactions where id=$1',[transactionId])).rows;
          const qualification=await attachCurrentNativeReviewProjection({client,firmId,rows});
          assert.equal(qualification.status,'incomplete');
          assert.equal(rows[0].processing_scope.review_current,false);
          assert.equal(rows[0].convergence_state,'hanging');
          assert.equal(rows[0].accounting_ready,false);
          return settled;
        } finally {client.release();}
      };
      await Promise.all([refresh(),refresh()]);
      assert.equal(checkouts,2,'bounded refresh needs no second connection');
      assert.deepEqual((await marks()).rows,original);
      await blocker.query('rollback');
      await settleConvergenceMarks(pool,{firmId,clientId});
      assert.equal((await marks()).rows.length,0);
      checkouts=0;
      await applyConvergenceState(pool,{firmId,transactionId});
      assert.equal(checkouts,1,'direct native apply discovers and writes on one physical checkout');
      const dirty=await pool.connect();await dirty.query('begin');dirty.release();
      await assert.rejects(()=>applyConvergenceState(pool,{firmId,transactionId}),error=>error.code==='CONVERGENCE_POOL_OWNERSHIP_VIOLATION'&&error.convergenceConnectionDiscarded);
      // A full default page is deliberately retained: no implicit unbounded
      // drain, even when all marks happen to name the same target.
      await seed.query(`insert into convergence_marks(firm_id,client_id,target_type,target_id,source)
        select $1,$2,'transaction',$3,'synthetic_pending_page' from generate_series(1,501)`,[firmId,clientId,transactionId]);
      const page=await settleConvergenceForRead(pool,{firmId,clientId});
      t.diagnostic('C4 bounded-page proof '+JSON.stringify({page,remaining:(await marks()).rows.length}));
      assert.equal(page.claimed,500);assert.equal((await marks()).rows.length,1);
      const rows=(await seed.query('select * from transactions where id=$1',[transactionId])).rows;
      assert.equal((await attachCurrentNativeReviewProjection({client:seed,firmId,rows})).status,'incomplete');
      await settleConvergenceMarks(pool,{firmId,clientId});
      assert.equal((await attachCurrentNativeReviewProjection({client:seed,firmId,rows})).status,'current');
      assert.equal(rows[0].processing_scope.review_current,false);
    } finally {await blocker.query('rollback');await blocker.end();await pool.end();}
  });

  await t.test('independent registration source outside the 64-document window invalidates acceptance without changing its focal digest', async () => {
    const clientId='scope-registration-window',transactionId='scope-registration-target';
    await create(clientId,true);
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,payload)
      values('scope-registration-original',$1,$2,'registration.pdf','unknown','completed','2000-01-01','{"storage_path":"original"}')`,[firmId,clientId]);
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date)
      select 'scope-registration-window-'||n,$1,$2,'local-'||n||'.pdf','unknown','completed','2026-02-15'
      from generate_series(1,65) n`,[firmId,clientId]);
    await updateClientProfileInDb({firmId,clientId,dbClient:seed,actorId:'member',
      principal:{principalType:'firm_member',principalId:'member',userId:'user-member'},
      profilePatch:{gst_registration:{status:'registered',registered_from:'2026-01-01',registered_until:'2026-12-31',
        verified_from:'Synthetic source outside focal window',verified_at:'2026-02-15',source_document_id:'scope-registration-original'}}});
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic registration source',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    const accepted=await stageAndAccept(clientId,transactionId),stamp=accepted.payload.review_scope;
    const read=()=>readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]});
    const initial=await read();assert.equal(initial.contexts.get(transactionId).review_current,true);
    assert.ok(!initial.snapshot.cases.get(transactionId).caseEvidence.documents.some(row=>row.id==='scope-registration-original'));
    await settleConvergenceMarks(seed,{firmId,clientId});
    await seed.query("update documents set payload=jsonb_set(payload,'{storage_path}','\"changed\"') where id='scope-registration-original'");
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date)
      values('scope-registration-000-changed',$1,$2,'new-local.pdf','unknown','completed','2026-02-15')`,[firmId,clientId]);
    assert.notDeepEqual(nativeCodingSourceReceipt((await read()).snapshot.cases.get(transactionId).caseEvidence),stamp.source);
    await seed.query("delete from documents where id='scope-registration-000-changed'");
    const changed=await read();
    assert.deepEqual(nativeCodingSourceReceipt(changed.snapshot.cases.get(transactionId).caseEvidence),stamp.source);
    // Restoring the focal digest alone cannot restore independent registration authority.

    assert.equal(changed.contexts.get(transactionId).review_current,false,'independent registration source binding still rejects old acceptance');
    assert.ok(changed.snapshot.pendingFocals.includes(transactionId));
    assert.deepEqual((await seed.query("select payload->'review_scope' stamp from transactions where id=$1",[transactionId])).rows[0].stamp,stamp);
    const refreshed=await request(`case-snapshot?firm_id=${firmId}&client_id=${clientId}&focus_id=${transactionId}&include=transactions,convergence,case_health,timeline`);
    assert.equal(refreshed.status,200,JSON.stringify(refreshed.body));assert.equal(refreshed.body.case_health.phase,'stuck');
    assert.equal(refreshed.body.case_health.accounting_ready,false);
    // Restore and then edit the focal source through its existing named writer.
    await seed.query("update documents set payload=jsonb_set(payload,'{storage_path}','\"original\"') where id='scope-registration-original'");
    assert.equal((await read()).contexts.get(transactionId).review_current,true);
    await updateTransactionInDb({firmId,transactionId,patch:{date:'2026-02-15',description:'Named focal edit',money_out:12,money_in:0,currency:'SGD'}});
    assert.equal((await seed.query("select payload ? 'review_scope' present from transactions where id=$1",[transactionId])).rows[0].present,false);
    assert.equal((await read()).contexts.get(transactionId).review_current,false);
    await updateTransactionInDb({firmId,transactionId,patch:{date:'2026-02-15',description:'Synthetic registration source',money_out:12,money_in:0,currency:'SGD'}});
    assert.equal((await read()).contexts.get(transactionId).review_current,false,'restoring focal source values cannot revive a retired active stamp');
    assert.equal((await seed.query("select payload ? 'review_scope' present from transactions where id=$1",[transactionId])).rows[0].present,false);
    await stageAndAccept(clientId,transactionId);
    assert.equal((await read()).contexts.get(transactionId).review_current,true,'healthy fresh acceptance after focal edit');
  });

  await t.test('target lock precedes gather; old projection cannot overwrite a later held verdict, in both isolation levels',async()=>{
    const clientId='scope-settler-order',transactionId='scope-settler-target';await create(clientId,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic settler order',1,'SGD','applied')`,[transactionId,firmId,clientId]);
    for(const isolation of ['read committed','repeatable read']){
      await seed.query("update transactions set coding_state='applied' where id=$1",[transactionId]);
      await settleConvergenceMarks(seed,{firmId,clientId});
      const older=new pg.Client({connectionString:url}),later=new pg.Client({connectionString:url});
      await older.connect();await later.connect();
      let gathered,proceed;
      const atGather=new Promise(resolve=>{gathered=resolve;});
      const continueOld=new Promise(resolve=>{proceed=resolve;});
      const query=older.query.bind(older);let pause=true;
      const record=bindConvergenceConnection(older,{rawQuery:async(...args)=>{
        const result=await query(...args);
        if(pause&&String(args[0]).includes('focal_windows')){pause=false;gathered();await continueOld;}
        return result;
      }});
      let applying;
      try{
        await older.query(`begin isolation level ${isolation}`);
        applying=applyConvergenceState(record.raw,{firmId,transactionId});
        await atGather;
        await later.query('begin');
        await later.query("set local lock_timeout='100ms'");
        await assert.rejects(()=>later.query("update transactions set coding_state='held' where id=$1",[transactionId]),{code:'55P03'},'later source writer cannot pass the pre-gather target fence');
        await later.query('rollback');
        // Source-only writers do not need the target row. Their committed mark
        // survives older gather/commit and is visible to the next bounded read.
        await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status)
          values($1,$2,$3,'settler-source.pdf','unknown','completed')`,['scope-settler-doc-'+isolation,firmId,clientId]);
        // Migration 158: the real document insert now leaves one client-scoped
        // pending mark (derives nothing); the row-level mark contention this test
        // pins is carried by a transaction mark a source writer committed.
        await seed.query("insert into convergence_marks(firm_id,client_id,target_type,target_id,source) values($1,$2,'transaction',$3,'synthetic_source_mark')",[firmId,clientId,transactionId]);
        const before=(await seed.query('select id from convergence_marks where client_id=$1 order by id',[clientId])).rows;
        await assert.rejects(()=>settleConvergenceMarks(later,{firmId,clientId}),error=>error.code==='55P03'&&error.nativeProjectionContention);
        assert.deepEqual((await seed.query('select id from convergence_marks where client_id=$1 order by id',[clientId])).rows,before);
        proceed();await applying;await older.query('commit');
        assert.ok((await seed.query('select count(*)::int n from convergence_marks where client_id=$1',[clientId])).rows[0].n>0);
        await later.query("update transactions set coding_state='held' where id=$1",[transactionId]);
        await settleConvergenceMarks(later,{firmId,clientId});
        assert.deepEqual((await seed.query('select coding_state,convergence_state,convergence_reason from transactions where id=$1',[transactionId])).rows[0],
          {coding_state:'held',convergence_state:'hanging',convergence_reason:'coding_state:held'});
        assert.equal((await seed.query('select count(*)::int n from convergence_marks where client_id=$1',[clientId])).rows[0].n,0);
      }finally{proceed();if(applying)await applying.catch(()=>{});await older.query('rollback');await later.query('rollback');unbindConvergenceConnection(record);await older.end();await later.end();}
    }
  });

  await t.test('SKIP LOCKED marks remain explicit pending work, including another transaction uncommitted claim',async()=>{
    const clientId='scope-settler-order',transactionId='scope-settler-target';
    await seed.query("insert into convergence_marks(firm_id,client_id,target_type,target_id,source) values($1,$2,'transaction',$3,'synthetic_locked_mark')",[firmId,clientId,transactionId]);
    const holder=new pg.Client({connectionString:url});await holder.connect();
    try{
      for(const claim of ['lock','delete']){
        await holder.query('begin');
        await holder.query(claim==='lock'?'select id from convergence_marks where client_id=$1 for update':'delete from convergence_marks where client_id=$1',[clientId]);
        const settled=await settleConvergenceForRead(seed,{firmId,clientId});assert.equal(settled.claimed,0);
        const projection=await computeConvergenceForTransactions(seed,{firmId,transactionIds:[transactionId]});
        assert.equal(projection[0].projection_freshness.status,'incomplete');
        assert.equal(projection[0].processing_scope.accounting_ready,false);
        await holder.query('rollback');
      }
      await settleConvergenceMarks(seed,{firmId,clientId});
      assert.equal((await computeConvergenceForTransactions(seed,{firmId,transactionIds:[transactionId]}))[0].projection_freshness.status,'current');
    }finally{await holder.query('rollback');await holder.end();}
  });
  await t.test('actual reconciliation orchestrator qualifies native pending counts after one bounded drain',async()=>{
    const clientId='scope-settler-order',transactionId='scope-settler-target';
    await seed.query(`insert into convergence_marks(firm_id,client_id,target_type,target_id,source)
      select $1,$2,'transaction',$3,'synthetic_parse_pending' from generate_series(1,501)`,[firmId,clientId,transactionId]);
    const previous=process.env.BANK_STATEMENT_MATCHER_ENABLED;process.env.BANK_STATEMENT_MATCHER_ENABLED='true';
    try{
      const stats=await runReconciliationForBankStatementInDb({firmId,clientId,dbClient:seed});
      assert.equal(stats.accounting_ready,false);assert.equal(stats.converged,false);
      assert.equal(stats.projection_freshness.status,'incomplete');assert.equal(stats.projection_freshness.pending_targets,1);
      assert.equal((await seed.query('select count(*)::int n from convergence_marks where client_id=$1',[clientId])).rows[0].n,1);
    }finally{if(previous===undefined)delete process.env.BANK_STATEMENT_MATCHER_ENABLED;else process.env.BANK_STATEMENT_MATCHER_ENABLED=previous;}
  });
  await t.test('two full firm snapshots finish on pool max two and expose incomplete counts during native contention',async()=>{
    await create('scope-snapshot-foreign',true,'SG','foreign-firm');
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      values('scope-snapshot-foreign-target','foreign-firm','scope-snapshot-foreign','2026-02-15','Synthetic snapshot source',1,'SGD')`);
    const pool=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:2000});
    const blocker=new pg.Client({connectionString:url});await blocker.connect();
    __setFirmDbPoolForTests(pool);
    try{
      await seed.query("update transactions set description='Synthetic pending snapshot' where id='scope-snapshot-foreign-target'");
      await blocker.query('begin');await blocker.query("select id from transactions where id='scope-snapshot-foreign-target' for update");
      const snapshots=await Promise.all([getFirmSnapshotFromDb({firmId:'foreign-firm'}),getFirmSnapshotFromDb({firmId:'foreign-firm'})]);
      for(const snapshot of snapshots){
        assert.equal(snapshot.projection_freshness.status,'incomplete');
        assert.equal(snapshot.accounting_ready,false);assert.equal(snapshot.converged,false);
        assert.equal(snapshot.transactions.find(row=>row.id==='scope-snapshot-foreign-target').processing_scope.review_current,false);
      }
      await blocker.query('rollback');
      assert.equal((await getFirmSnapshotFromDb({firmId:'foreign-firm'})).projection_freshness.status,'current');
    }finally{await blocker.query('rollback');await blocker.end();__setFirmDbPoolForTests(originalPool);await pool.end();}
  });

}

async function proveReviewInvalidation({ t, seed, firmId, clientId, create, url }) {
  // Migration 158: native dependency marks are CLIENT-scoped (one per client and
  // strength, de-duplicated across unsettled rows), not one per transaction.
  const marks = async (client = clientId) => (await seed.query(`select distinct client_id from convergence_marks
    where firm_id=$1 and client_id=$2 and target_type='client' and source like 'native_review_%'`, [firmId, client])).rows.map(r => r.client_id);
  const clear = () => seed.query("delete from convergence_marks where source like 'native_review_%'");
  await t.test('current native source edits invalidate sibling targets; projection/stamp/touch edits do not', async () => {
    await clear();
    await updateClientProfileInDb({ firmId, clientId, dbClient: seed, actorId: 'member',
      principal: { principalType: 'firm_member', principalId: 'member', userId: 'user-member' },
      profilePatch: { gst_registration: { status: 'not_registered', covered_from: '2026-01-01',
        covered_until: '2026-12-31', verified_from: 'Synthetic member confirmation', verified_at: '2026-09-01' } } });
    assert.deepEqual(await marks(), [clientId]);
    await clear();
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
      values('scope-new-local',$1,$2,'synthetic.pdf','receipt','completed','2026-02-15',12,'SGD')`, [firmId, clientId]);
    assert.deepEqual(await marks(), [clientId], 'unlinked evidence invalidates a focal receipt too');
    await clear();
    await seed.query("update documents set updated_at=now(),convergence_state='hanging',convergence_reason='fixture' where id='scope-new-local'");
    await seed.query("update transactions set updated_at=now(),payload=payload || '{\"review_scope\":null}'::jsonb where id='scope-target'");
    assert.deepEqual(await marks(), [], 'derived/touch-only writes cannot recursively mark native targets');
    await seed.query("update documents set payload=payload || '{\"storage_path\":\"changed-source\"}'::jsonb where id='scope-new-local'");
    assert.deepEqual(await marks(), [clientId]);
    await clear();
    await seed.query("delete from documents where id='scope-new-local'");
    assert.deepEqual(await marks(), [clientId]);
  });
  await t.test('old/new tenant scope, last partial marker, unknown source columns and new life invalidate only their eligible targets',async()=>{
    const foreignClient='scope-foreign-native',legacy='scope-marker-neighbor';
    await create(foreignClient,true,'SG','foreign-firm');await create(legacy,false);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      values('scope-foreign-target','foreign-firm',$1,'2026-02-15','Synthetic foreign target',1,'SGD'),
        ('scope-marker-target',$2,$3,'2026-02-15','Synthetic marker target',1,'SGD')`,[foreignClient,firmId,legacy]);
    const nativeMarks=async()=> (await seed.query("select firm_id,client_id,client_id target_id from convergence_marks where target_type='client' and source like 'native_review_%' order by client_id")).rows;
    await clear();
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status)
      values('scope-moving-document',$1,$2,'move.pdf','unknown','completed')`,[firmId,clientId]);
    await clear();
    await seed.query("update documents set firm_id='foreign-firm',client_id=$1 where id='scope-moving-document'",[foreignClient]);
    assert.deepEqual((await nativeMarks()).map(row=>row.target_id),[foreignClient,clientId].sort());
    await clear();await seed.query("delete from documents where id='scope-moving-document'");
    assert.deepEqual((await nativeMarks()).map(row=>row.target_id),[foreignClient]);
    // An otherwise legacy book with one corrupted partial marker is not proof
    // of native authority. Its removal must still request a verified reread.
    const account=(await seed.query('select id from ledger_accounts where client_id=$1 order by id limit 1',[legacy])).rows[0].id;
    await seed.query("update ledger_accounts set payload=payload || '{\"birth_contract\":\"synthetic_partial\"}'::jsonb where id=$1",[account]);
    await clear();await seed.query("update ledger_accounts set payload=payload-'birth_contract' where id=$1",[account]);
    assert.deepEqual((await nativeMarks()).map(row=>row.target_id),[legacy]);
    await clear();
    const oldMarks=(await seed.query('select * from convergence_marks where client_id=$1 order by id',[legacy])).rows;
    await seed.query("update clients set profile=profile || '{\"synthetic_display\":true}'::jsonb where id=$1",[legacy]);
    assert.deepEqual((await seed.query('select * from convergence_marks where client_id=$1 order by id',[legacy])).rows,oldMarks,'unmarked neighbor keeps exact existing marks');
    await seed.query('begin');
    try {
      await seed.query('alter table documents add column synthetic_future_source text');
      await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status)
        values('scope-future-source',$1,$2,'future.pdf','unknown','completed')`,[firmId,clientId]);
      await clear();await seed.query("update documents set synthetic_future_source='changed' where id='scope-future-source'");
      assert.deepEqual(await marks(),[clientId],'unknown full-row source fields invalidate conservatively');
    } finally {await seed.query('rollback');}
    await clear();
    // Bootstrap runs through the exact owner used by migration156.
    await seed.query("select mark_native_review_sources(jsonb_build_array(jsonb_build_object('firm_id',$1::text,'client_id',$2::text,'old_marker',false)))",[firmId,clientId]);
    assert.deepEqual(await marks(),[clientId]);
    await seed.query('begin');
    try {
      await seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'system','donna','ledger.chart.palette_seeded','client',$2,'{\"birth_contract\":\"synthetic_old_life\"}')",[firmId,legacy]);
      await seed.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'firm_member','member','client.delete','client',$2,'{}')",[firmId,legacy]);
      await clear();
      await seed.query("update clients set profile=profile || '{\"synthetic_new_life\":true}'::jsonb where id=$1",[legacy]);
      assert.deepEqual(await nativeMarks(),[],'old-life/removed partial evidence cannot enroll an unmarked life');
    } finally {await seed.query('rollback');}
  });
  await t.test('schema-valid scalar transaction payloads preserve legacy updates and native invalidation',async()=>{
    for(const [scope,target] of [[clientId,'scope-target'],['scope-marker-neighbor','scope-marker-target']]){
      for(const value of [null,7,true,'scalar',[],{display_note:'object'}]){
        await seed.query('begin');
        try{
          await seed.query('update transactions set payload=$2::jsonb where id=$1',[target,JSON.stringify(value)]);
          await clear();
          const legacyBefore=(await seed.query('select * from convergence_marks where client_id=$1 order by id',[scope])).rows;
          await seed.query("update transactions set description=description||' changed' where id=$1",[target]);
          assert.deepEqual(await marks(scope),scope===clientId?[clientId]:[]);
          if(scope!==clientId)assert.deepEqual((await seed.query('select * from convergence_marks where client_id=$1 order by id',[scope])).rows,legacyBefore);
          await clear();await seed.query("update transactions set payload='{\"payment_method\":\"changed\"}'::jsonb where id=$1",[target]);
          assert.deepEqual(await marks(scope),scope===clientId?[clientId]:[]);
        }finally{await seed.query('rollback');}
      }
    }
  });
  await t.test('statement invalidation scans targets once for a bulk source change and discovers later same-xid targets', async () => {
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      select 'scope-bulk-'||n,$1,$2,'2026-02-15','Synthetic bulk source',1,'SGD' from generate_series(1,1000) n`, [firmId, clientId]);
    await clear();
    const insert = `insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
      select 'scope-bulk-document-'||n,$1,$2,'synthetic-'||n||'.pdf','receipt','completed','2026-02-15',1,'SGD' from generate_series(1,1000) n`;
    const plan = (await seed.query(`explain (analyze,buffers,format json) ${insert}`, [firmId, clientId])).rows[0]['QUERY PLAN'][0];
    assert.equal(plan.Triggers.find(r => r['Trigger Name'] === 'native_review_insert').Calls, 1);
    assert.equal((await marks()).length, 1, 'a 1,000-row bulk source change mints ONE client mark, not 1,001 transaction marks');
    await clear();
    // EXPLAIN the actual SQL owner's stored body, rather than a lookalike test
    // query. This exposes executed target scans hidden inside trigger timing.
    const source = (await seed.query("select prosrc from pg_proc where oid='mark_native_review_sources(jsonb)'::regprocedure")).rows[0].prosrc;
    const ownerPlan = (await seed.query(`explain (analyze,buffers,format json) ${source.replace(/\baffected\b/g, '$1::jsonb')}`,
      [JSON.stringify([{ firm_id: firmId, client_id: clientId, old_marker: false }])])).rows[0]['QUERY PLAN'][0];
    const nodes = node => [node, ...(node.Plans || []).flatMap(nodes)];
    // The owner no longer fans out over the client's transactions: it only probes
    // for their existence, once per client (never one scan per target).
    const targetScans = nodes(ownerPlan.Plan).filter(n => n['Relation Name'] === 'transactions');
    assert.ok(targetScans.every(n => n['Actual Loops'] <= 1 && n['Actual Rows'] <= 1), JSON.stringify(ownerPlan));
    await seed.query('begin');
    await clear();
    await seed.query("update documents set payload=payload || '{\"batch_source\":1}'::jsonb where client_id=$1", [clientId]);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      values('scope-late-target',$1,$2,'2026-02-15','Synthetic late target',1,'SGD')`, [firmId, clientId]);
    assert.equal((await marks()).length, 1);
    await seed.query("update documents set payload=payload || '{\"batch_source\":2}'::jsonb where client_id=$1", [clientId]);
    assert.equal((await marks()).length, 1, 'one client mark despite multiple statements and a later same-xid target');
    await seed.query('commit');
    await clear();
    const linePlan = (await seed.query(`explain (analyze,buffers,format json)
      insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      select 'scope-bulk-line-'||n,$1,$2,'scope-bulk-document-'||((n-1)/20+1),((n-1)%20+1),
        'Synthetic uncapped source line',1,'{}'::jsonb from generate_series(1,20000) n`, [firmId, clientId])).rows[0]['QUERY PLAN'][0];
    assert.equal(linePlan.Triggers.find(r => r['Trigger Name'] === 'native_review_insert').Calls, 1);
    assert.equal((await marks()).length, 1);
    await clear();
    const updatePlan=(await seed.query(`explain (analyze,buffers,format json) update documents set payload=payload || '{"cost_update":true}'::jsonb where client_id=$1`,[clientId])).rows[0]['QUERY PLAN'][0];
    assert.equal(updatePlan.Triggers.find(row=>row['Trigger Name']==='native_review_update').Calls,1);
    assert.equal((await marks()).length,1);
    await seed.query('begin');
    let deletePlan;
    try {
      await clear();
      deletePlan=(await seed.query('explain (analyze,buffers,format json) delete from documents where client_id=$1',[clientId])).rows[0]['QUERY PLAN'][0];
      assert.equal(deletePlan.Triggers.find(row=>row['Trigger Name']==='native_review_delete').Calls,1);
      assert.equal((await marks()).length,1);
    } finally {await seed.query('rollback');}
    console.log(JSON.stringify({ proof: 'native-source-statement-cost', document_insert: plan,
      document_update:updatePlan,document_delete:deletePlan,owner_target_scan: ownerPlan, document_lines_insert: linePlan }));
  });
  await t.test('F-23: a source change on a 2,000-line native book mints ONE client mark and settles verdict-only in bounded time; a legacy neighbour keeps its exact row marks', async () => {
    const big = 'scope-fanout', small = 'scope-fanout-legacy';
    await create(big, true); await create(small, false);
    for (const scoped of [big, small]) await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      select $2||'-'||n,$1,$2,date '2026-01-01'+(n%200),'Synthetic fan-out '||n,1+n%9,'SGD' from generate_series(1,2000) n`, [firmId, scoped]);
    const drain = async scoped => { for (let i = 0; i < 20; i++) if (!(await settleConvergenceMarks(seed, { firmId, clientId: scoped })).claimed) return; };
    await drain(big); await drain(small);
    const count = async (scoped, where = 'true') => (await seed.query(`select count(*)::int n from convergence_marks where firm_id=$1 and client_id=$2 and ${where}`, [firmId, scoped])).rows[0].n;
    const insertDocument = (scoped, id) => seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
      values($3,$1,$2,'fanout.pdf','receipt','completed','2026-02-15',5,'SGD')`, [firmId, scoped, id]);
    const verdicts = async scoped => (await seed.query('select id,convergence_state,convergence_reason from transactions where client_id=$1 order by id', [scoped])).rows;
    const settledBefore = await verdicts(big);
    assert.ok(settledBefore.every(row => row.convergence_state === 'hanging' && row.convergence_reason), 'native rows are settled hanging before the change');

    await insertDocument(big, 'scope-fanout-doc-1');
    assert.equal(await count(big, "target_type='client'"), 1, 'one client mark for a 2,000-transaction book (was 2,000 transaction marks)');
    assert.equal(await count(big, "target_type='transaction'"), 0);
    await insertDocument(big, 'scope-fanout-doc-2');
    assert.equal(await count(big, "target_type='client'"), 1, 'a second change while the first is unsettled adds none');

    await insertDocument(small, 'scope-fanout-legacy-doc');
    assert.equal(await count(small), 1, 'a legacy client still gets exactly its one document mark');
    assert.equal(await count(small, "target_type='client'"), 0);

    const started = performance.now();
    const settled = await settleConvergenceMarks(seed, { firmId, clientId: big });
    assert.ok(settled.claimed >= 1);
    assert.ok(performance.now() - started < 5000, 'a 500-mark page is no longer a 20-second window read');
    assert.equal(await count(big), 0);
    assert.deepEqual(await verdicts(big), settledBefore, 'the settled verdict is unchanged');
    assert.equal((await settleConvergenceMarks(seed, { firmId, clientId: small })).claimed, 1);
    assert.equal(await count(small), 0);

    // A scope event (profile / chart / registration) re-derives the client's rows verdict-only.
    await seed.query("update clients set profile=profile || '{\"synthetic_scope_edit\":1}'::jsonb where id=$1", [big]);
    assert.equal(await count(big, "source='native_review_scope'"), 1);
    const scopeStarted = performance.now();
    const scoped = await settleConvergenceMarks(seed, { firmId, clientId: big });
    assert.equal(scoped.targets, 2000, 'the scope mark expands to every row of the client');
    assert.ok(performance.now() - scopeStarted < 30000);
    assert.equal(await count(big), 0);
    assert.deepEqual((await verdicts(big)).filter(row => row.id.startsWith(big + '-')), settledBefore.filter(row => row.id.startsWith(big + '-')));

    // F-30: the commit-time settle (scope 'transaction') never expands a scope mark
    // inside the writer's transaction; it survives the commit for the budgeted sweep.
    await seed.query('begin');
    try {
      await seed.query("update clients set profile=profile || '{\"synthetic_scope_edit\":2}'::jsonb where id=$1", [big]);
      assert.equal((await settleConvergenceMarks(seed, { firmId, clientId: big, scope: 'transaction' })).claimed, 0);
      await seed.query('commit');
    } catch (error) { await seed.query('rollback'); throw error; }
    assert.equal(await count(big, "source='native_review_scope'"), 1, 'the committed scope mark waits for the release sweep');
    assert.equal((await settleConvergenceMarks(seed, { firmId, clientId: big })).targets, 2000);
    assert.equal(await count(big), 0);

    // The verdict-only derivation IS the full-window derivation, minus the read-only review windows.
    const ids = settledBefore.slice(0, 40).map(row => row.id);
    const full = await computeConvergenceForTransactions(seed, { firmId, transactionIds: ids });
    const lite = await computeConvergenceForTransactions(seed, { firmId, transactionIds: ids, verdictOnly: true });
    assert.deepEqual(lite.map(row => [row.target_id, row.derived]), full.map(row => [row.target_id, row.derived]));
  });
  await t.test('F-25: the native statement triggers cost a non-native client almost nothing and mint nothing for it', async () => {
    const legacy = 'scope-fanout-legacy';
    await seed.query('begin');
    try {
      await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
        select 'f25-'||n,$1,$2,date '2026-01-01'+(n%200),'Synthetic f25 '||n,1,'SGD' from generate_series(1,10000) n`, [firmId, legacy]);
      await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status)
        select 'f25-doc-'||n,$1,$2,'f25.pdf','unknown','completed' from generate_series(1,6000) n`, [firmId, legacy]);
      await seed.query("delete from convergence_marks where source like 'native_review_%'");
      const measure = async sql => {
        const plan = (await seed.query(`explain (analyze,format json) ${sql}`, [legacy])).rows[0]['QUERY PLAN'][0];
        const trigger = plan.Triggers.filter(row => row['Trigger Name'].startsWith('native_review_')).reduce((sum, row) => sum + row.Time, 0);
        return { trigger, base: plan['Execution Time'] - trigger };
      };
      for (const sql of ["update transactions set updated_at=now() where client_id=$1",
        "update transactions set payload=payload || '{\"f25\":1}'::jsonb where client_id=$1",
        "update documents set payload=payload || '{\"f25\":1}'::jsonb where client_id=$1"]) {
        const { trigger, base } = await measure(sql);
        // Before: the trigger cost 1.4-1.7x the statement itself (full transition-table join,
        // two to_jsonb and the projection per row). After: scope discovery only.
        assert.ok(trigger < 0.5 * base, `${sql}: native trigger ${trigger.toFixed(1)}ms vs statement ${base.toFixed(1)}ms`);
      }
      assert.equal((await seed.query("select count(*)::int n from convergence_marks where client_id=$1 and target_type='client'", [legacy])).rows[0].n, 0);
    } finally { await seed.query('rollback'); }
  });
  await t.test('one-snapshot transaction batch preserves existing source windows, scalar types and uncapped line evidence', async () => {
    const ids = ['scope-target','scope-bulk-1','scope-late-target'];
    const legalNames = ['Synthetic, Pte Ltd', 'Synthetic "alternate"', 'Unicode 名称'];
    await seed.query('update clients set legal_names=$2::text[] where id=$1',[clientId,legalNames]);
    let queries = 0;
    const snapshot = await readJevTransactionCases({ client: { query: (...args) => { queries++; return seed.query(...args); } },
      firmId, clientId, transactionIds: ids, asOf: '2026-02-15' });
    assert.equal(queries, 1);
    assert.deepEqual(snapshot.company.legal_names,legalNames,'SQL text arrays survive the shared snapshot transport');
    for (const transactionId of ids) {
      const single = await readJevCase({ client: seed, firmId, clientId, transactionId, evidenceOnly: true, asOf: '2026-02-15' });
      assert.deepEqual(snapshot.cases.get(transactionId), single);
      assert.equal(codingCaseRevision(snapshot.cases.get(transactionId).caseEvidence,{completeSources:true}),
        codingCaseRevision(single.caseEvidence,{completeSources:true}));
      assert.equal(single.caseEvidence.documents.reduce((n,row)=>n+row.lines.length,0),1280);
    }
    const started = performance.now();
    const memoryBefore=process.memoryUsage();
    const fullBatch = await readJevTransactionCases({ client: seed, firmId, clientId,
      transactionIds: Array.from({length:200},(_,n)=>'scope-bulk-'+(n+1)),asOf:'2026-02-15' });
    assert.equal(fullBatch.cases.size,200);
    assert.equal(fullBatch.lines.length,1280,'shared lines are fetched once, without a line cap');
    console.log(JSON.stringify({proof:'native-review-batch-200',elapsed_ms:performance.now()-started,shared_lines:fullBatch.lines.length,cases:fullBatch.cases.size,
      memory_before:memoryBefore,memory_after:process.memoryUsage(),memory_measurement:'process samples around the batch, not peak allocation'}));
    assert.ok(snapshot.pendingTargets>=1);
    assert.ok(snapshot.pendingFocals.includes('scope-target'));
  });

  await t.test('batch sees one committed source version across concurrent mutation and keeps null-date/asOf/uncapped-line parity',async()=>{
    const isolated='scope-snapshot-coherence';await create(isolated,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,description,money_out,currency)
      values('scope-coherent-target',$1,$2,'Synthetic coherent source',1,'SGD')`,[firmId,isolated]);
    await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,payload)
      values('scope-coherent-document',$1,$2,'coherent.pdf','unknown','completed',1,'SGD','{"version":"before"}')`,[firmId,isolated]);
    await seed.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
      select 'scope-coherent-line-'||n,$1,$2,'scope-coherent-document',n,'Uncapped line',1,'{}' from generate_series(1,1025)n`,[firmId,isolated]);
    const options={firmId,clientId:isolated,transactionIds:['scope-coherent-target'],asOf:'2026-02-15'};
    const before=await readJevTransactionCases({client:seed,...options});
    assert.equal(before.lines.length,1025);
    assert.deepEqual(before.cases.get('scope-coherent-target'),await readJevCase({client:seed,firmId,clientId:isolated,transactionId:'scope-coherent-target',asOf:options.asOf,evidenceOnly:true}));
    await assert.rejects(()=>readJevTransactionCases({client:seed,...options,transactionIds:Array.from({length:201},(_,n)=>String(n))}),RangeError);
    const reader=new pg.Client({connectionString:url});await reader.connect();
    const pid=(await reader.query('select pg_backend_pid() pid')).rows[0].pid;
    let pending;
    try {
      await seed.query('select pg_advisory_lock(9317156)');
      // A test-only last SELECT gate keeps the real batch statement in flight
      // after its MVCC snapshot is fixed. No production seam or query is added.
      pending=readJevTransactionCases({client:{query:(sql,values)=>reader.query(sql+' from (select pg_advisory_xact_lock(9317156)) fixture_gate',values)},...options});
      let blocked=false;
      for(let n=0;n<200&&!blocked;n++){
        blocked=(await seed.query("select wait_event='advisory' blocked from pg_stat_activity where pid=$1",[pid])).rows[0]?.blocked;
        if(!blocked)await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'batch reached the deterministic in-flight gate');
      await seed.query('begin');
      await seed.query("update clients set company_name='Synthetic version after' where id=$1",[isolated]);
      await seed.query("update documents set filename='after.pdf',payload=payload || '{\"version\":\"after\"}' where id='scope-coherent-document'");
      await seed.query('commit');
      await seed.query('select pg_advisory_unlock(9317156)');
      const inFlight=await pending;
      assert.deepEqual(inFlight.cases.get('scope-coherent-target'),before.cases.get('scope-coherent-target'),'one pre-commit snapshot, never a hybrid');
      const after=await readJevTransactionCases({client:seed,...options});
      assert.equal(after.company.company_name,'Synthetic version after');
      assert.equal(after.cases.get('scope-coherent-target').caseEvidence.documents[0].filename,'after.pdf');
    } finally {await seed.query('rollback');await seed.query('select pg_advisory_unlock(9317156)');if(pending)await pending.catch(()=>{});await reader.end();}
  });
  await t.test('populated relationship, reply and obligation overflow preserves exact 257-row windows and single-reader options',async()=>{
    const transactionId='scope-target';
    const single=await readJevCase({client:seed,firmId,clientId,transactionId,evidenceOnly:true,asOf:'2026-02-15'});
    const txIds=single.candidates.map(row=>row.id),docIds=single.caseEvidence.documents.map(row=>row.id);
    await seed.query('begin');
    try{
      await seed.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,status)
        select 'scope-overflow-match-'||n,$1,$2,($3::text[])[((n-1)%64)+1],'receipt',($4::text[])[((n-1)/64)+1],1,'suggested'
        from generate_series(1,257)n`,[firmId,clientId,txIds,docIds]);
      await seed.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,question,created_by,resolved_by,response_payload)
        select 'scope-overflow-reply-'||n,$1,$2,$3,'resolved','Synthetic answered question','member','member','{"reply":"Synthetic owner fact"}'
        from generate_series(1,257)n`,[firmId,clientId,transactionId]);
      await seed.query(`insert into document_obligations(id,firm_id,client_id,document_id,obligation_type,amount,currency)
        select 'scope-overflow-obligation-'||n,$1,$2,$3,'payment',1,'SGD' from generate_series(1,257)n`,[firmId,clientId,docIds[0]]);
      const batch=await readJevTransactionCases({client:seed,firmId,clientId,transactionIds:[transactionId],asOf:'2026-02-15'});
      const window=batch.windows[0];
      assert.equal(window.matches.length,257);assert.equal(window.replies.length,257);assert.equal(window.obligations.length,257);
      const projected=batch.cases.get(transactionId);
      assert.equal(projected.caseEvidence.matches.length,256);assert.equal(projected.caseEvidence.owner_replies.length,256);
      assert.equal(projected.caseEvidence.obligations.length,256);assert.equal(projected.limits.status,'truncated');
      for(const options of [{evidenceOnly:true},{evidenceOnly:true,lockEvidence:true},{allowUnsupported:true,includePostingLines:true}]){
        assert.deepEqual(await readJevCase({client:seed,firmId,clientId,transactionId,asOf:'2026-02-15',...options}),projected);
      }
    }finally{await seed.query('rollback');}
  });

}

async function proveConvergenceOwnership({ t, seed, url }) {
  await proveConvergenceClaim({t,seed,url});
  await seed.query('create table convergence_ownership_fixture(id text primary key, value int)');
  const count = async id => (await seed.query('select count(*)::int n from convergence_ownership_fixture where id=$1', [id])).rows[0].n;
  const failure = Object.assign(new Error('Synthetic projection failure'), { code: 'FIXTURE_PROJECTION_FAILURE' });
  await t.test('convergence preserves caller work and nested savepoints on failure/NOWAIT; caller owns rollback', async () => {
    const client = new pg.Client({ connectionString: url }); await client.connect();
    try {
      await client.query('begin');
      await client.query("insert into convergence_ownership_fixture values('outer',1)");
      await client.query('savepoint caller_savepoint');
      await assert.rejects(() => withConvergenceTransaction(client, async raw => {
        await raw.query("insert into convergence_ownership_fixture values('nested-failed',2)"); throw failure;
      }), error => error === failure);
      assert.equal((await client.query('select count(*)::int n from convergence_ownership_fixture')).rows[0].n, 1);
      await client.query('rollback to savepoint caller_savepoint');
      assert.equal(await count('outer'), 0, 'outer work has not committed');
      await client.query('rollback');
      assert.equal(await count('outer'), 0);
      await seed.query("insert into convergence_ownership_fixture values('locked',1)");
      await seed.query('begin'); await seed.query("select * from convergence_ownership_fixture where id='locked' for update");
      await client.query('begin');
      await client.query("insert into convergence_ownership_fixture values('before-contention',1)");
      await assert.rejects(() => withConvergenceTransaction(client, async raw => {
        await raw.query("insert into convergence_ownership_fixture values('inside-contention',1)");
        await raw.query("select * from convergence_ownership_fixture where id='locked' for update nowait");
      }), error => error.code === '55P03');
      assert.equal((await client.query("select count(*)::int n from convergence_ownership_fixture where id='before-contention'")).rows[0].n, 1);
      assert.equal((await client.query("select count(*)::int n from convergence_ownership_fixture where id='inside-contention'")).rows[0].n, 0);
      await client.query('rollback'); await seed.query('rollback');
      await client.query('begin');
      await assert.rejects(() => client.query('select nonexistent_fixture_column'), error => error.code === '42703');
      let entered = false;
      await assert.rejects(() => withConvergenceTransaction(client, async () => { entered = true; }), error => error.code === '25P02');
      assert.equal(entered, false); await client.query('rollback');
      await withConvergenceTransaction(client, raw => raw.query("insert into convergence_ownership_fixture values('autocommit',1)"));
      assert.equal(await count('autocommit'), 1);
    } finally { await client.query('rollback'); await client.end(); }
  });
  await t.test('pool root borrows one connection, raw facade borrows none, dirty pool checkout is discarded', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    let checkouts = 0; const connect = pool.connect.bind(pool);
    pool.connect = (...args) => { checkouts++; return connect(...args); };
    try {
      await withConvergenceTransaction(pool, raw => raw.query("insert into convergence_ownership_fixture values('pool-root',1)"));
      assert.equal(checkouts, 1); assert.equal(await count('pool-root'), 1);
      const client = await pool.connect(); const record = bindConvergenceConnection(client);
      await client.query('begin');
      await withConvergenceTransaction(record.raw, raw => raw.query("insert into convergence_ownership_fixture values('raw-nested',1)"));
      assert.equal(checkouts, 2); assert.equal(await count('raw-nested'), 0);
      await client.query('rollback'); unbindConvergenceConnection(record); client.release();
      const dirty = await pool.connect();
      await dirty.query('begin'); await dirty.query("insert into convergence_ownership_fixture values('orphan',1)"); dirty.release();
      let entered = false;
      await assert.rejects(() => withConvergenceTransaction(pool, async () => { entered = true; }),
        error => error.code === 'CONVERGENCE_POOL_OWNERSHIP_VIOLATION' && error.convergenceConnectionDiscarded);
      assert.equal(entered, false); assert.equal(checkouts, 4);
      assert.equal(await count('orphan'), 0);
      await withConvergenceTransaction(pool, raw => raw.query("insert into convergence_ownership_fixture values('after-discard',1)"));
      assert.equal(await count('after-discard'), 1);
    } finally { await pool.end(); }
  });
  await t.test('cleanup failure preserves primary cause and discards exactly once; hook does not recurse', async () => {
    const pool = new pg.Pool({ connectionString: url, max: 1 });
    try {
      const client = await pool.connect();
      const query = client.query.bind(client), release = client.release.bind(client); let releases = 0;
      const record = bindConvergenceConnection(client, { rawQuery: async (...args) => {
        if (/^rollback to savepoint donna_convergence_/i.test(args[0])) throw new Error('Synthetic cleanup failure');
        return query(...args);
      }, release: error => { releases++; release(error); } });
      await client.query('begin'); await client.query("insert into convergence_ownership_fixture values('cleanup-outer',1)");
      await assert.rejects(() => withConvergenceTransaction(record.raw, async raw => {
        await raw.query("insert into convergence_ownership_fixture values('cleanup-inner',1)");
        throw Object.assign(new Error('Primary projection cause'), { code: 'PRIMARY_FIXTURE' });
      }), error => error.code === 'PRIMARY_FIXTURE' && error.convergenceCleanupError.message === 'Synthetic cleanup failure' && error.convergenceConnectionDiscarded);
      client.release(); assert.equal(releases, 1);
      assert.equal(await count('cleanup-outer'), 0);
      const hooked = hookPooledClient(await pool.connect());
      let claims = 0;
      await withConvergenceTransaction(hooked, async raw => {
        claims++; await raw.query("insert into convergence_ownership_fixture values('hook-owned',1)");
      });
      assert.equal(claims, 1); assert.equal(await count('hook-owned'), 1);
      await hooked.query('begin');
      await withConvergenceTransaction(hooked, raw => raw.query("insert into convergence_ownership_fixture values('hook-nested',1)"));
      await hooked.query('rollback'); assert.equal(await count('hook-nested'), 0);
      await hooked.release();
    } finally { await pool.end(); }
  });
  await t.test('raw and hooked nested convergence share the physical verdict budget and preserve earlier outer work', async () => {
    for (const hooked of [false,true]) {
      const pool=new pg.Pool({connectionString:url,max:1});
      const physical=await pool.connect();
      const client=hooked ? hookPooledClient(physical) : physical;
      const budget=createExecutionBudget({timeoutMs:10000});
      const id=`budget-${hooked}`;
      try {
        await client.query('begin');
        await client.query('insert into convergence_ownership_fixture values($1,1)',[id]);
        await client.query('savepoint existing_caller_budget');
        await runWithExecutionBudget(budget,async()=>{
          assertExecutionBudgetActive({client:physical});
          await assert.rejects(()=>withConvergenceTransaction(client,async raw=>{
            await raw.query('insert into convergence_ownership_fixture values($1,2)',[id+'-late']);
            budget.abort('synthetic_expiry_during_projection');
          }),{code:'EXECUTION_BUDGET_EXHAUSTED'});
          assert.throws(()=>assertVerdictTransactionBudgetActive(physical),{code:'EXECUTION_BUDGET_EXHAUSTED'},'nested cleanup does not clear the outer budget');
        });
        assert.equal((await client.query('select count(*)::int n from convergence_ownership_fixture where id=$1',[id])).rows[0].n,1);
        assert.equal((await client.query('select count(*)::int n from convergence_ownership_fixture where id=$1',[id+'-late'])).rows[0].n,0);
        await client.query('rollback to savepoint existing_caller_budget');
        await client.query('rollback');assert.equal(await count(id),0);
      } finally {await client.query('rollback');await client.release();await pool.end();}
    }
  });

}

async function proveConvergenceClaim({t,seed,url}) {
  const evidence=[];
  for(const adversarial of [false,true]) await t.test(`actual bounded claim owner: planner ${adversarial?'nested-loop pressure':'default'}`,async()=>{
    const client=new pg.Client({connectionString:url});await client.connect();
    const query=client.query.bind(client);let claim;
    const record=bindConvergenceConnection(client,{rawQuery:async(sql,params)=>{
      if(/for update skip locked/i.test(sql)) {
        claim={sql,params};
        await query('savepoint claim_plan');
        const plan=await query('explain (analyze, buffers, format json) '+sql,params);
        await query('rollback to savepoint claim_plan');await query('release savepoint claim_plan');
        evidence.push({adversarial,version:(await query('select version()')).rows[0].version,sql,params,plan:plan.rows});
      }
      return query(sql,params);
    }});
    const firmId='scope-firm',clientId='claim-proof-'+adversarial;
    try {
      await seed.query(`insert into convergence_marks(firm_id,client_id,target_type,target_id,source)
        select $1,$2,'transaction','missing-claim-target','bounded-claim-proof' from generate_series(1,501)`,[firmId,clientId]);
      await client.query('begin');
      await client.query('analyze convergence_marks');
      if(adversarial)for(const setting of ['enable_hashjoin','enable_mergejoin','enable_material','enable_hashagg','enable_sort'])await client.query(`set local ${setting}=off`);
      const settled=await settleConvergenceMarks(record.raw,{firmId,clientId});
      const remaining=(await client.query('select count(*)::int n from convergence_marks where client_id=$1',[clientId])).rows[0].n;
      Object.assign(evidence.at(-1),{claimed:settled.claimed,remaining});
      assert.ok(claim);assert.equal(settled.claimed,500);assert.equal(remaining,1);
    } finally {
      await client.query('rollback');unbindConvergenceConnection(record);await client.end();
      await seed.query('delete from convergence_marks where client_id=$1',[clientId]);
      if(process.env.DONNA_TEST_ARTIFACTS_DIR){await mkdir(process.env.DONNA_TEST_ARTIFACTS_DIR,{recursive:true});await writeFile(path.join(process.env.DONNA_TEST_ARTIFACTS_DIR,'claim-plans.json'),JSON.stringify(evidence,null,2));}
    }
  });
  for(const adversarial of [false,true]) await t.test(`claim scope, tenant, skipped locks and failure rollback retain one bounded page (${adversarial?'adversarial':'default'})`,async()=>{
    const client=new pg.Client({connectionString:url}),holder=new pg.Client({connectionString:url});
    await client.connect();await holder.connect();
    const firmId='scope-firm',clientId='claim-scope-'+adversarial;
    const insert=(receiver,firm,entity,prefix,count)=>receiver.query(`insert into convergence_marks(firm_id,client_id,target_type,target_id,source)
      select $1,$2,'transaction',$3||n,'bounded-scope-proof' from generate_series(1,$4) n`,[firm,entity,prefix,count]);
    const count=async()=> (await client.query('select count(*)::int n from convergence_marks where firm_id=$1 and client_id=$2',[firmId,clientId])).rows[0].n;
    const settings=async()=>{if(adversarial)for(const setting of ['enable_hashjoin','enable_mergejoin','enable_material','enable_hashagg','enable_sort'])await client.query(`set local ${setting}=off`);};
    try {
      await insert(seed,firmId,clientId,'committed-',507);
      await insert(seed,'foreign-firm',clientId,'other-firm-',1);
      await insert(seed,firmId,clientId+'-other','other-client-',1);
      await holder.query('begin');
      await holder.query('select id from convergence_marks where firm_id=$1 and client_id=$2 order by id limit 2 for update',[firmId,clientId]);
      await holder.query('delete from convergence_marks where id in (select id from convergence_marks where firm_id=$1 and client_id=$2 order by id offset 2 limit 2)',[firmId,clientId]);
      await insert(holder,firmId,clientId,'uncommitted-insert-',3);
      await client.query('begin');await settings();
      await insert(client,firmId,clientId,'current-xid-',2);
      assert.equal((await settleConvergenceMarks(client,{firmId,clientId,scope:'transaction'})).claimed,2);
      assert.equal(await count(),507);
      assert.equal((await settleConvergenceMarks(client,{firmId,clientId,scope:'committed'})).claimed,500);
      assert.equal(await count(),7);
      assert.equal((await client.query('select count(*)::int n from convergence_marks where (firm_id=$1 and client_id=$2) or (firm_id=$3 and client_id=$4)',
        ['foreign-firm',clientId,firmId,clientId+'-other'])).rows[0].n,2);
      await client.query('rollback');await holder.query('rollback');
      assert.equal(await count(),507);
      // Fail AFTER the real DELETE, through PostgreSQL, and prove the owner's
      // savepoint restores every claimed id before a later bounded attempt.
      await client.query('begin');await settings();
      const before=(await client.query('select id from convergence_marks where firm_id=$1 and client_id=$2 order by id',[firmId,clientId])).rows;
      const query=client.query.bind(client);let failed=false;
      const record=bindConvergenceConnection(client,{rawQuery:async(sql,params)=>{
        const result=await query(sql,params);
        if(!failed && /for update skip locked/i.test(sql)){failed=true;await query('select 1/0');}
        return result;
      }});
      try {
        await assert.rejects(()=>settleConvergenceMarks(record.raw,{firmId,clientId}),{code:'22012'});
        assert.ok(failed);
        assert.deepEqual((await client.query('select id from convergence_marks where firm_id=$1 and client_id=$2 order by id',[firmId,clientId])).rows,before);
        assert.equal((await settleConvergenceMarks(record.raw,{firmId,clientId})).claimed,500);
        assert.equal(await count(),7);
      } finally {unbindConvergenceConnection(record);}
    } finally {
      await client.query('rollback');await holder.query('rollback');await client.end();await holder.end();
      await seed.query('delete from convergence_marks where client_id=any($1::text[])',[[clientId,clientId+'-other']]);
    }
  });
}

async function proveReviewWriteAuthority({ t, seed, firmId, create, request, stageAndAccept, originalPool, url }) {
  // The shared authenticated collaborator is created by the first proof below.
  const make = async (clientId, transactionId) => {
    await create(clientId,true);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic authority source',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    await stageAndAccept(clientId,transactionId,false);
    return ensureTransactionReviewItemInDb({firmId,clientId,transactionId});
  };
  await t.test('authenticated collaborator can accept own open/resolved case but cannot reaccept another client resolved case',async()=>{
    const a='scope-collaborator-a',b='scope-collaborator-b';
    const aCase=await make(a,a+'-tx'),bCase=await make(b,b+'-tx');
    await seed.query(`insert into firm_collaborators(id,firm_id,user_id,email,name,status)
      values('collaborator',$1,'user-collaborator','collaborator@scope.invalid','Synthetic scoped collaborator','active')`,[firmId]);
    await seed.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id)
      values('scope-collaborator-assignment',$1,$2,'firm_collaborator','collaborator')`,[firmId,a]);
    const body={firm_id:firmId,actor_id:'member',patch:{status:'resolved',review_state:'accepted',account_code:'7000'}};
    for(const reviewItemId of [aCase,aCase]) {
      const result=await request(`transaction-review/${reviewItemId}`,body,'collaborator','PATCH');
      assert.equal(result.status,200,JSON.stringify(result.body));
      assert.equal((await seed.query("select payload->'review_scope'->>'accepted_by' actor from transactions where id=$1",[a+'-tx'])).rows[0].actor,'collaborator');
    }
    await stageAndAccept(b,b+'-tx');
    const before=(await seed.query('select * from transactions where id=$1',[b+'-tx'])).rows;
    const audits=(await seed.query('select id from audit_events where client_id=$1 order by id',[b])).rows;
    const denied=await request(`transaction-review/${bCase}`,body,'collaborator','PATCH');
    assert.equal(denied.status,403,JSON.stringify(denied.body));
    assert.deepEqual((await seed.query('select * from transactions where id=$1',[b+'-tx'])).rows,before);
    assert.deepEqual((await seed.query('select id from audit_events where client_id=$1 order by id',[b])).rows,audits);
  });
  await proveReviewLockOrder({t,seed,firmId,create,request,stageAndAccept,originalPool,url});
  await t.test('authenticated effective native source edit then restore retires the stamp; identical source preserves it',async()=>{
    const clientId='scope-effective-source',transactionId=clientId+'-tx';
    await make(clientId,transactionId);
    const accepted=await stageAndAccept(clientId,transactionId),stamp=accepted.payload.review_scope;
    const source=accepted.payload.native_source || accepted.payload.ai_suggestion.native_source;
    const read=async()=> (await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
    const mutate=patch=>request(`transactions/${transactionId}`,{firm_id:firmId,patch:{date:'2026-02-15',
      description:'Synthetic authority source',money_out:12,money_in:0,currency:'SGD',...patch}},'member','PATCH');
    assert.equal((await mutate({native_source:source,display_note:'unrelated'})).status,200);
    assert.deepEqual((await read()).payload.review_scope,stamp);
    assert.equal((await mutate({native_source:{...source,revision:'changed-effective-source'}})).status,200);
    assert.ok(!(await read()).payload.review_scope,'the effective source coordinate retires authority');
    assert.equal((await mutate({native_source:source})).status,200);
    assert.ok(!(await read()).payload.review_scope,'restoring source cannot resurrect authority');
    await stageAndAccept(clientId,transactionId);
    assert.notEqual((await read()).payload.review_scope.acceptance_audit.id,stamp.acceptance_audit.id);
  });
  await t.test('new native acceptance rechecks member and assignment after source fence, on the same checkout',async()=>{
    const clientId='scope-authority-races',transactionId=clientId+'-tx';
    const reviewItemId=await make(clientId,transactionId);
    await seed.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id)
      values('scope-race-assignment',$1,$2,'firm_collaborator','collaborator')`,[firmId,clientId]);
    const body={firm_id:firmId,patch:{status:'resolved',review_state:'accepted',account_code:'7000'}};
    await assert.rejects(()=>updateTransactionReviewItemInDb({firmId,reviewItemId,actorId:'member',patch:body.patch,returnSnapshot:false}),{code:'FIRM_ACCESS_DENIED'});
    for(const kind of ['member','collaborator','assignment']) {
      await stageAndAccept(clientId,transactionId,false);
      const before=(await seed.query('select * from transactions where id=$1',[transactionId])).rows;
      const audits=(await seed.query('select id from audit_events where client_id=$1 order by id',[clientId])).rows;
      let crossed=false;
      const limited=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:1000});
      limited.on('connect',physical=>{
        const query=physical.query.bind(physical);
        physical.query=(sql,...args)=>{
          if(!crossed && /^select id from clients where firm_id=\$1 and id=\$2 for update nowait/.test(sql)) {
            crossed=true;
            return (async()=>{
              if(kind==='assignment')await seed.query("update client_assignments set ends_at=now()-interval '1 minute' where id='scope-race-assignment'");
              else await seed.query(`update ${kind==='member'?'firm_members':'firm_collaborators'} set status='inactive' where id=$1`,[kind]);
              return query(sql,...args);
            })();
          }
          return query(sql,...args);
        };
      });
      __setFirmDbPoolForTests(limited);
      try {
        const denied=await request(`transaction-review/${reviewItemId}`,body,kind==='member'?'member':'collaborator','PATCH');
        assert.ok(crossed);assert.equal(denied.status,403,JSON.stringify({kind,body:denied.body}));
        assert.deepEqual((await seed.query('select * from transactions where id=$1',[transactionId])).rows,before);
        assert.deepEqual((await seed.query('select id from audit_events where client_id=$1 order by id',[clientId])).rows,audits);
      } finally {
        __setFirmDbPoolForTests(originalPool);await limited.end();
        await seed.query("update firm_members set status='active' where id='member'");
        await seed.query("update firm_collaborators set status='active' where id='collaborator'");
        await seed.query("update client_assignments set ends_at=null where id='scope-race-assignment'");
      }
    }
    for(const kind of ['member','collaborator','assignment']) {
      await stageAndAccept(clientId,transactionId,false);
      let checked=false;
      const limited=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:1000});
      limited.on('connect',physical=>{
        const query=physical.query.bind(physical);
        physical.query=(sql,...args)=>{
          if(!checked && /^\s*update transaction_review_queue/.test(sql)) {
            checked=true;
            return (async()=>{
              await seed.query('begin');await seed.query("set local lock_timeout='100ms'");
              try {
                await assert.rejects(()=>kind==='assignment'
                  ?seed.query("delete from client_assignments where id='scope-race-assignment'")
                  :seed.query(`update ${kind==='member'?'firm_members':'firm_collaborators'} set status='inactive' where id=$1`,[kind]),{code:'55P03'});
              } finally {await seed.query('rollback');}
              return query(sql,...args);
            })();
          }
          return query(sql,...args);
        };
      });
      __setFirmDbPoolForTests(limited);
      try {
        const accepted=await request(`transaction-review/${reviewItemId}`,body,kind==='member'?'member':'collaborator','PATCH');
        assert.ok(checked);assert.equal(accepted.status,200,JSON.stringify(accepted.body));
      } finally {__setFirmDbPoolForTests(originalPool);await limited.end();}
    }
    await stageAndAccept(clientId,transactionId);
    const stamp=(await seed.query("select payload->'review_scope' stamp from transactions where id=$1",[transactionId])).rows[0].stamp;
    await seed.query("update firm_members set status='inactive' where id='member'");
    try {
      assert.equal((await readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]})).contexts.get(transactionId).review_current,true,'later departure does not erase historical acceptance');
      assert.deepEqual((await seed.query("select payload->'review_scope' stamp from transactions where id=$1",[transactionId])).rows[0].stamp,stamp);
    } finally {await seed.query("update firm_members set status='active' where id='member'");}
  });
  await t.test('exact persisted review target cannot relocate between route authorization and writer',async()=>{
    const clientId='scope-relocation',transactionId=clientId+'-tx';
    const reviewItemId=await make(clientId,transactionId);
    const limited=new pg.Pool({connectionString:url,max:1,connectionTimeoutMillis:1000});let relocated=false;
    limited.on('connect',physical=>{
      const query=physical.query.bind(physical);
      physical.query=(sql,...args)=>{
        if(!relocated && sql==='select client_id from transaction_review_queue where firm_id=$1 and id=$2') {
          relocated=true;
          return (async()=>{const result=await query(sql,...args);
            await seed.query("update transaction_review_queue set client_id='scope-collaborator-b' where id=$1",[reviewItemId]);
            return result;})();
        }
        return query(sql,...args);
      };
    });
    __setFirmDbPoolForTests(limited);
    try {
      const result=await request(`transaction-review/${reviewItemId}`,{firm_id:firmId,patch:{status:'resolved',review_state:'accepted'}},'member','PATCH');
      assert.ok(relocated);assert.equal(result.status,403,JSON.stringify(result.body));
      assert.equal((await seed.query('select coding_state from transactions where id=$1',[transactionId])).rows[0].coding_state,'proposed');
      assert.equal((await seed.query("select count(*)::int n from audit_events where client_id=$1 and action like 'review.%'",[clientId])).rows[0].n,0);
    } finally {__setFirmDbPoolForTests(originalPool);await limited.end();}
  });
}

const transactionLock = 'select * from transactions where firm_id = $1 and id = $2 for update';
const deferred = () => { let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve}; };
const blockedBy = async (seed,pid,holder) => {
  for(let attempt=0;attempt<100;attempt++) {
    if((await seed.query('select $2::int=any(pg_blocking_pids($1)) blocked',[pid,holder])).rows[0].blocked)return;
    await seed.query('select pg_sleep(0.01)');
  }
  assert.fail('the real writer did not enter the controlled row-lock wait');
};

async function proveReviewLockOrder({t,seed,firmId,create,request,stageAndAccept,originalPool,url}) {
  const make=async(clientId,transactionId,native=true)=>{
    await create(clientId,native);
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
      values($1,$2,$3,'2026-02-15','Synthetic lock source',12,'SGD','proposed')`,[transactionId,firmId,clientId]);
    if(native)await stageAndAccept(clientId,transactionId,false);
    return ensureTransactionReviewItemInDb({firmId,clientId,transactionId});
  };
  await t.test('C4 assignment expiry during actual review writer lock wait refuses; unexpired neighbor accepts',async()=>{
    for(const expired of [true,false]) {
      const clientId='scope-window-'+expired,transactionId=clientId+'-tx',assignmentId=clientId+'-assignment';
      const reviewItemId=await make(clientId,transactionId);
      await seed.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id)
        values($1,$2,$3,'firm_collaborator','collaborator')`,[assignmentId,firmId,clientId]);
      const before=(await seed.query('select * from transactions where id=$1',[transactionId])).rows;
      const caseBefore=(await seed.query('select * from transaction_review_queue where id=$1',[reviewItemId])).rows;
      const audits=(await seed.query('select id from audit_events where client_id=$1 order by id',[clientId])).rows;
      const holder=new pg.Client({connectionString:url});await holder.connect();
      const limited=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:1000});
      const entered=deferred();let captured=false,writing;
      limited.on('connect',physical=>{
        const query=physical.query.bind(physical);
        physical.query=(sql,...args)=>{
          if(!captured && sql===transactionLock) {
            captured=true;
            return (async()=>{
              const began=(await query('select transaction_timestamp() began')).rows[0].began;
              await seed.query(`update client_assignments set starts_at=$2::timestamptz-interval '1 minute',
                ends_at=$2::timestamptz + $3::interval where id=$1`,[assignmentId,began,expired?'0.3 seconds':'10 minutes']);
              const result=query(sql,...args);entered.resolve(physical.processID);return result;
            })();
          }
          return query(sql,...args);
        };
      });
      try {
        await holder.query('begin');await holder.query(transactionLock,[firmId,transactionId]);
        __setFirmDbPoolForTests(limited);
        writing=request(`transaction-review/${reviewItemId}`,{firm_id:firmId,
          patch:{status:'resolved',review_state:'accepted',account_code:'7000'}},'collaborator','PATCH');
        await blockedBy(seed,await entered.promise,holder.processID);
        if(expired)await seed.query(`select pg_sleep(greatest(0,extract(epoch from ends_at-clock_timestamp()))+0.05)
          from client_assignments where id=$1`,[assignmentId]);
        const window=(await seed.query('select starts_at,ends_at,statement_timestamp() releasing_at from client_assignments where id=$1',[assignmentId])).rows[0];
        assert.equal(window.ends_at <= window.releasing_at,expired);
        await holder.query('commit');
        const result=await writing;assert.equal(result.status,expired?403:200,JSON.stringify(result.body));
        t.diagnostic('C4 controlled assignment window '+JSON.stringify({expired,...window,status:result.status}));
        if(expired) {
          assert.deepEqual((await seed.query('select * from transactions where id=$1',[transactionId])).rows,before);
          assert.deepEqual((await seed.query('select * from transaction_review_queue where id=$1',[reviewItemId])).rows,caseBefore);
          assert.deepEqual((await seed.query('select id from audit_events where client_id=$1 order by id',[clientId])).rows,audits);
        } else assert.equal((await seed.query("select payload->'review_scope'->>'accepted_by' actor from transactions where id=$1",[transactionId])).rows[0].actor,'collaborator');
      } finally {
        await holder.query('rollback');if(writing)await writing.catch(()=>{});
        __setFirmDbPoolForTests(originalPool);await holder.end();await limited.end();
      }
    }
  });
  await t.test('C4 competing real transaction and review writers preserve transaction-first order in native and legacy books',async()=>{
    for(const native of [true,false]) {
      const clientId='scope-writer-order-'+native,transactionId=clientId+'-tx';
      const reviewItemId=await make(clientId,transactionId,native);
      const limited=new pg.Pool({connectionString:url,max:4,connectionTimeoutMillis:2000});
      const locked=deferred(),releaseGeneric=deferred(),reviewWaiting=deferred();let connections=0,queueWrites=0;
      limited.on('connect',physical=>{
        const generic=connections++===0,query=physical.query.bind(physical);let lockSeen=false;
        physical.query=(sql,...args)=>{
          if(sql==='begin')return query(sql,...args).then(async result=>{await query("set local deadlock_timeout='100ms'");return result;});
          if(!lockSeen && sql===transactionLock) {
            lockSeen=true;
            if(generic)return query(sql,...args).then(async result=>{locked.resolve(physical.processID);await releaseGeneric.promise;return result;});
            const result=query(sql,...args);reviewWaiting.resolve(physical.processID);return result;
          }
          if(generic && /^\s*update transaction_review_queue/.test(sql))queueWrites++;
          return query(sql,...args);
        };
      });
      __setFirmDbPoolForTests(limited);let generic,review;
      try {
        generic=updateTransactionInDb({firmId,transactionId,patch:{date:'2026-02-15',description:'Synthetic lock source',
          money_in:0,money_out:12,currency:'SGD',support_note:'Concurrent real writer support'}});
        const genericPid=await locked.promise;
        review=updateTransactionReviewItemInDb({firmId,reviewItemId,actorId:'member',returnSnapshot:false,
          reviewAuthority:{clientId,principal:{principalType:'firm_member',principalId:'member'}},
          distillFactsFn:async()=>({candidates:[]}),patch:{status:'resolved',review_state:'accepted',reviewer_note:'Later review',
            ...(native?{account_code:'7000'}:{})}});
        // Attach handlers before allowing a PostgreSQL deadlock detector to run.
        const results=Promise.allSettled([generic,review]);
        await blockedBy(seed,await reviewWaiting.promise,genericPid);releaseGeneric.resolve();
        const outcomes=await results;
        assert.deepEqual(outcomes.map(row=>row.status),['fulfilled','fulfilled'],JSON.stringify(outcomes.map(row=>row.reason?.code || row.status)));
        assert.equal(queueWrites,1,'the competing production writer really reached its queue update');
        const row=(await seed.query('select * from transactions where id=$1',[transactionId])).rows[0];
        const item=(await seed.query('select * from transaction_review_queue where id=$1',[reviewItemId])).rows[0];
        assert.equal(row.payload.support_note,'Concurrent real writer support');
        assert.equal(item.payload.closed_by,'support_note');assert.equal(item.payload.reviewer_note,'Later review');
        assert.equal(item.status,'resolved');
        assert.equal(Boolean(row.payload.review_scope),native);
        if(native)assert.equal((await readNativeReviewContexts({client:seed,firmId,clientId,transactionIds:[transactionId]})).contexts.get(transactionId).review_current,true);
        t.diagnostic('C4 competing writers '+JSON.stringify({native,outcomes:outcomes.map(row=>row.status),queueWrites,case_status:item.status}));
      } finally {
        releaseGeneric.resolve();await Promise.allSettled([generic,review].filter(Boolean));
        __setFirmDbPoolForTests(originalPool);await limited.end();
      }
    }
  });
  await t.test('C4 locked case reread refuses disappearance and client or transaction relocation without stale mutation',async()=>{
    for(const change of ['delete','client','transaction']) {
      const clientId='scope-reread-'+change,transactionId=clientId+'-tx';
      const reviewItemId=await make(clientId,transactionId);
      await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
        values($1,$2,$3,'2026-02-15','Sibling target',13,'SGD','proposed')`,[transactionId+'-sibling',firmId,clientId]);
      const before=(await seed.query('select * from transactions where client_id=$1 order by id',[clientId])).rows;
      const audits=(await seed.query('select id from audit_events where client_id=$1 order by id',[clientId])).rows;
      const holder=new pg.Client({connectionString:url});await holder.connect();
      const limited=new pg.Pool({connectionString:url,max:2,connectionTimeoutMillis:1000});const entered=deferred();let writing;
      limited.on('connect',physical=>{
        const query=physical.query.bind(physical);
        physical.query=(sql,...args)=>{
          const result=query(sql,...args);if(sql===transactionLock)entered.resolve(physical.processID);return result;
        };
      });
      try {
        await holder.query('begin');await holder.query(transactionLock,[firmId,transactionId]);
        __setFirmDbPoolForTests(limited);
        writing=request(`transaction-review/${reviewItemId}`,{firm_id:firmId,
          patch:{status:'resolved',review_state:'accepted',account_code:'7000'}},'member','PATCH');
        await blockedBy(seed,await entered.promise,holder.processID);
        await seed.query("set lock_timeout='500ms'");
        if(change==='delete')await seed.query('delete from transaction_review_queue where id=$1',[reviewItemId]);
        else if(change==='client')await seed.query("update transaction_review_queue set client_id='scope-collaborator-b' where id=$1",[reviewItemId]);
        else await seed.query("update transaction_review_queue set payload=payload || jsonb_build_object('transaction_id',$2::text) where id=$1",[reviewItemId,transactionId+'-sibling']);
        const caseAfterFixture=(await seed.query('select * from transaction_review_queue where id=$1',[reviewItemId])).rows;
        await holder.query('commit');
        const result=await writing;assert.equal(result.status,change==='delete'?404:change==='client'?403:409,JSON.stringify(result.body));
        assert.deepEqual((await seed.query('select * from transactions where client_id=$1 order by id',[clientId])).rows,before);
        assert.deepEqual((await seed.query('select * from transaction_review_queue where id=$1',[reviewItemId])).rows,caseAfterFixture);
        assert.deepEqual((await seed.query('select id from audit_events where client_id=$1 order by id',[clientId])).rows,audits);
      } finally {
        await holder.query('rollback');if(writing)await writing.catch(()=>{});await seed.query('reset lock_timeout');
        __setFirmDbPoolForTests(originalPool);await holder.end();await limited.end();
      }
    }
  });
}
