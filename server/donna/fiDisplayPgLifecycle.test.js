import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { rowToDocumentPayload } from './db/documents.js';
import { rowToTransactionPayload } from './db/transactions.js';
import { readJevDecisionPolicy, makeJevTrialProvider } from './jevTrialProvider.js';
import { setClientFlagStage } from './clientConfig.js';
import { CLOUD_PILOT_PROCESSING_VERSION } from './cloudPilotConfig.js';
import { readReconcileActivityWithClient } from './db/reconcileActivity.js';
import { enqueueLocalJob, claimNextLocalJob, completeLocalJob } from './desktop/localJobQueue.js';
import { streamEntryState } from '../../src/lib/periodOverview.js';
import { matchHeroFields } from '../../src/lib/transactionMatchHero.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, getFirmSnapshotFromDb } from './firmDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PostgreSQL: source dates survive JSON, and actual queue lifecycle changes only the display', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const name = `donna_fi_display_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await client.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await client.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter(f => f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(file, root), 'utf8'));
  await client.query("insert into firms(id,name,slug) values('fi-display','FI Display','fi-display')");
  await client.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type) values('salon','fi-display','Salong Oy','fi','fi-oy')");
  await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,document_date,due_date,parse_status,parse_run_id)
    values('receipt','fi-display','salon','Taxi.pdf','receipt','2025-02-26','2025-03-01','completed','11111111-1111-4111-8111-111111111111')`);
  const documents = (await client.query('select * from documents')).rows;
  const dto = JSON.parse(JSON.stringify(rowToDocumentPayload(documents[0])));
  assert.equal(dto.document_date, '2025-02-26');
  assert.equal(dto.due_date, '2025-03-01');
  const dateField = matchHeroFields(dto).find(field => field.kind === 'date');
  assert.match(dateField.value, /26/);
  let job = await enqueueLocalJob({ client, functionId: 'parse-document', payload: {
    firm_id: 'fi-display', client_id: 'salon', document_id: 'receipt', parse_run_id: documents[0].parse_run_id
  }, maxAttempts: 4 });
  await client.query(`insert into transactions(id,firm_id,client_id,document_id,transaction_date,money_out,currency,status,coding_state,convergence_state,convergence_reason)
    values('line','fi-display','salon','receipt','2025-02-26',17.5,'EUR','needs_review','proposed','hanging','coding_state:proposed')`);
  const transactions = (await client.query('select * from transactions')).rows;
  const read = async (observedAt = new Date().toISOString(), overrides={}) => {
    const activity = await readReconcileActivityWithClient(client, { firmId: 'fi-display', transactions, documents, observedAt, ...overrides });
    return { ...rowToTransactionPayload(transactions[0]), processing_activity: activity.get('line') || null };
  };
  assert.equal((await read()).processing_activity.state, 'queued');
  // The same production reader must preserve source ownership without the
  // desktop scheduler sidecars (the Vercel/Inngest deployment shape).
  await client.query('delete from local_jobs');
  const cloudAt = new Date(Date.now() + 12 * 60_000).toISOString();
  assert.equal(streamEntryState('open', await read(cloudAt)), 'processing', 'bank-only coding waits through the cap without a local clock');
  assert.equal(streamEntryState('open', await read(new Date(Date.now()+31*60_000).toISOString())), 'stalled');
  job = await enqueueLocalJob({client,functionId:job.function_id,payload:job.payload,maxAttempts:4});
  // Read the real configuration projection: it intentionally omits provenance
  // columns, so hosted authorization must verify the authoritative scoped row.
  const hostedEnv = { VERCEL:'1',VERCEL_ENV:'production',VERCEL_PROJECT_ID:'fixture-project',
    VERCEL_DEPLOYMENT_ID:'fixture-deploy',VERCEL_GIT_COMMIT_SHA:'fixture-source',
    DATABASE_URL:url.toString(),SUPABASE_URL:'https://fixture.invalid',TYPESAFE_MODEL:'fixture-first-line' };
  await setClientFlagStage(client,{firmId:'fi-display',clientId:'salon',flagKey:'JEV_RECONCILIATION',
    stage:'canary',source:'manual',reason:CLOUD_PILOT_PROCESSING_VERSION,actorType:'firm_member',actorId:'fixture-operator'});
  const policyArgs = {client,firmId:'fi-display',clientId:'salon',env:hostedEnv};
  assert.equal((await readJevDecisionPolicy(policyArgs)).policy.basis,'hosted_fi_default');
  await assert.rejects(()=>makeJevTrialProvider({...policyArgs,decisionKind:'coding',env:{...hostedEnv,TYPESAFE_MODEL:''}}),
    {code:'coding_policy_unavailable',details:{reason:'jev_model_not_configured'}});
  await assert.rejects(()=>readJevDecisionPolicy({...policyArgs,env:{...hostedEnv,CLIENT_CONFIG_FORCE_DISABLE:'JEV_RECONCILIATION'}}),{code:'jev_experiment_not_authorized'});
  await client.query("update client_capability_config set reason='unrelated' where flag_key='JEV_RECONCILIATION'");
  await assert.rejects(()=>readJevDecisionPolicy(policyArgs),{code:'jev_experiment_not_authorized'});
  await client.query("update client_capability_config set reason=$1 where flag_key='JEV_RECONCILIATION'",[CLOUD_PILOT_PROCESSING_VERSION]);
  await client.query("update clients set jurisdiction='SE' where id='salon'");
  await assert.rejects(()=>readJevDecisionPolicy(policyArgs),{code:'jev_experiment_not_authorized'});
  await client.query("update clients set jurisdiction='fi' where id='salon'");
  await client.query("update client_capability_config set stage='off' where flag_key='JEV_RECONCILIATION'");
  await assert.rejects(()=>readJevDecisionPolicy(policyArgs),{code:'jev_experiment_not_authorized'});

  await claimNextLocalJob({ client, workerId: 'display-proof', eligibleFunctionIds: ['parse-document'] });
  assert.equal((await read()).processing_activity.state, 'running');
  assert.equal(streamEntryState('open', await read()), 'processing');
  await client.query(`with attempt as (
    insert into runtime_host_readiness_attempts(host_id,attempt_sequence,event_type,status,certificate_version,receipt_digest,responsible_system,certificate,observed_at)
    values('desktop-local',1,'boot','PASS','display-fixture','display-fixture','fixture','{}',now()) returning id
  ) insert into runtime_host_readiness(host_id,status,certificate_version,runtime_host,receipt_digest,latest_attempt_id,attempt_count,responsible_system,minted_at,checked_at,renew_after,valid_until)
    select 'desktop-local','PASS','display-fixture','desktop','display-fixture',id,1,'fixture',now(),now(),now()+interval '5 minutes',now()+interval '10 minutes' from attempt`);
  const snapshot = await getFirmSnapshotFromDb({ firmId: 'fi-display' });
  assert.equal(snapshot.documents.find(d => d.id === 'receipt').document_date, '2025-02-26');
  assert.equal(snapshot.transactions.find(t => t.id === 'line').processing_activity.state, 'running');
  assert.equal(streamEntryState('open', await read(new Date(Date.now() + 11 * 60_000).toISOString())), 'processing','lease expiry retains the durable retry owner until the source ceiling');
  await completeLocalJob({ client, jobId: job.id, result: { completed: true } });
  await client.query("insert into local_job_cron_state(function_id,last_enqueued_tick) values('parse-cron:coding_convergence',now())");
  assert.equal(streamEntryState('open', await read()), 'processing', 'the real registered clock owns the handoff after parse completion');
  const codingJob=await enqueueLocalJob({client,functionId:'parse-cron:coding_convergence',payload:{},maxAttempts:4});
  await claimNextLocalJob({client,workerId:'display-proof',eligibleFunctionIds:['parse-cron:coding_convergence']});
  assert.equal(streamEntryState('open', await read()), 'processing');
  await completeLocalJob({client,jobId:codingJob.id,result:{coding_convergence:{errors:0}}});
  assert.equal(streamEntryState('open', await read()), 'processing', 'one successful worker is not completion of owed accounting');
  for (const minutes of [12,17]) assert.equal(streamEntryState('open', await read(new Date(Date.now()+minutes*60_000).toISOString())), 'processing','uncapped worker discovery retains a client queued over two ticks');
  await client.query(`insert into client_capability_config(id,firm_id,flag_key,stage,source)
    values('readiness-default','fi-display','ENTITY_READINESS_ADMISSION','auto','default')`);
  const refused=await read(undefined,{readinessByClient:new Map([['salon',{mutation_ready:false,reason_code:'fixture_readiness_refusal'}]])});
  assert.equal(refused.processing_activity.reason_code,'fixture_readiness_refusal');
  assert.equal(streamEntryState('open',refused),'stalled','firm-inherited admission refusal is immediate');
  assert.equal(streamEntryState('open',await read(undefined,{readinessByClient:new Map([['salon',{mutation_ready:false,reason_code:'host_readiness_missing'}]])})),'processing','host boot is a bounded wait');
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values('fi-display','salon','system','fixture','transaction.coding.policy_failed','transaction','line','{"operation":"coding"}')`);
  assert.equal((await read()).processing_activity.reason_code,'coding_policy_failed');
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values('fi-display','salon','system','fixture','transaction.coding.policy_recovered','transaction','line','{"operation":"coding"}')`);
  assert.equal(streamEntryState('open', await read(new Date(Date.now()+31*60_000).toISOString())), 'stalled');
  assert.equal((await client.query("select convergence_state from transactions where id='line'")).rows[0].convergence_state, 'hanging');
  assert.equal((await client.query('select count(*)::int n from ledger_journals')).rows[0].n, 0);
  await client.query("insert into client_capability_config(id,firm_id,flag_key,stage,source) values('coding-default','fi-display','CODING_AUTO_POST','auto','default')");
  await client.query(`update transactions set payload='{"ai_suggestion":{"evidence_required":false}}' where id='line'`);
  transactions[0]=(await client.query("select * from transactions where id='line'")).rows[0];
  assert.equal(streamEntryState('open',await read()),'processing','the actual suggested row waits for the auto-post sweep');
  await client.query(`update documents set created_at=now()-interval '1 day' where id='receipt'`);
  await client.query(`update transactions set coding_state='asked',created_at=now()-interval '1 day',payload='{}' where id='line'`);
  await client.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question,responded_at,response_payload)
    values('answer','fi-display','salon','line','replied','business_purpose','What was the trip for?',now(),'{"reply":"This was a trip to a supplier."}')`);
  transactions[0]=(await client.query("select * from transactions where id='line'")).rows[0];
  documents[0]=(await client.query("select * from documents where id='receipt'")).rows[0];
  assert.equal(streamEntryState('open',await read()),'processing','the real reply-recovery query owns the new answer on yesterday’s line');
  await client.query(`update client_evidence_requests set response_payload=response_payload || '{"reply_processing":{"state":"exhausted","attempts":3}}'::jsonb where id='answer'`);
  assert.equal(streamEntryState('open',await read()),'stalled','exhausted reply leaves no false processing owner');
  // A settled projection fixture with a genuinely new, similarly priced source.
  // No match means no relationship; inserting the exact persisted match does.
  await client.query("update transactions set coding_state='posted',status='posted',convergence_state='auto_reconciled',created_at=now()-interval '1 day' where id='line'");
  await client.query("update documents set created_at=now()-interval '1 day' where id='receipt'");
  await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,document_date,total_amount,currency,parse_status)
    values('unrelated','fi-display','salon','Other taxi.pdf','receipt','2025-02-26',17.5,'EUR','pending')`);
  transactions[0]=(await client.query("select * from transactions where id='line'")).rows[0];
  const newDocuments=(await client.query('select * from documents')).rows;
  assert.equal(streamEntryState('reconciled',await read(undefined,{documents:newDocuments})),'reconciled');
  await client.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status)
    values('exact','fi-display','salon','line','receipt','unrelated','auto_matched')`);
  const matches=(await client.query('select * from reconciliation_matches')).rows;
  // 2026-09-23: the posted line keeps its persisted verdict while the newly
  // matched source is read; the source carries its own Reading activity.
  assert.equal(streamEntryState('reconciled',await read(undefined,{documents:newDocuments,matches})),'reconciled');
  const sourceActivity=(await readReconcileActivityWithClient(client,{firmId:'fi-display',transactions,documents:newDocuments,matches,observedAt:new Date().toISOString()})).get('document:unrelated');
  assert.equal(sourceActivity.phase,'reading');
});
