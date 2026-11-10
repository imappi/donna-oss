// Real PostgreSQL, current schema, existing workers and ask writer. The model
// transport is synthetic; no production account or external send is exercised.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir, readFile} from 'node:fs/promises';
import pg from 'pg';
import {setClientFlagStage} from './clientConfig.js';
import {BANK_LINE_DISPOSITION_FLAG, CLOUD_PILOT_PROCESSING_FLAGS, CLOUD_PILOT_PROCESSING_VERSION, FI_HOSTED_PILOT_STAGES} from './cloudPilotConfig.js';
import {HOSTED_PILOT_VERSION, readInternalPilotSendRestrictionWithClient} from './internalPilotAccess.js';
import {healHostedPilotDispositionEnrollmentWithClient, runHostedPilotTerminalConvergenceInDb} from './hostedPilotTerminalConvergence.js';
import {__createClientEvidenceRequestWithClient as createClientEvidenceRequestWithClient, __createHeldMatchPortalAsksWithClient, __sendClientAskBatchWithClient, resolveClientEvidenceRequestInDb} from './db/asks.js';
import {runCodingConvergenceInDb} from './codingConvergence.js';
import { ANTHROPIC_MESSAGES_TEST_URL, claudeMessageResponse } from './testSupport/claudeMessage.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
// One fresh database per test: every migration, the hosted runtime identity,
// and a pool the firm DB layer uses. Restored on teardown.
const bootHostedPilotDatabase = async (t, prefix) => {
  const admin = new pg.Client({connectionString:pgUrl}); await admin.connect();
  const name = `${prefix}_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({connectionString:url.toString()});
  const closed = []; pool.on('connect', client => closed.push(new Promise(resolve => client.once('end',resolve))));
  const env = {DATABASE_URL:url.toString(), VERCEL:'1', VERCEL_PROJECT_ID:'fixture', VERCEL_ENV:'preview',
    DONNA_DESKTOP_BLOB_DIR:'', ANTHROPIC_API_KEY:'fixture-only', OPENAI_API_KEY:'fixture-only', CLIENT_CONFIG_FORCE_DISABLE:'',
    BANK_LINE_DISPOSITION_MODE:'', LOOPS_TIER:'off', LOOPS_SHADOW:'false'};
  const saved = Object.fromEntries(Object.keys(env).map(key => [key,process.env[key]])); Object.assign(process.env,env);
  const priorFetch = globalThis.fetch;
  const {__setFirmDbPoolForTests, __resetFirmDbPoolForTests} = await import('./db/pool.js');
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    globalThis.fetch = priorFetch; __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
    for (const [key,value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  });
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file,dir),'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing',[file.slice(0,-4)]);
  }
  return pool;
};

test('real PG: hosted processing heals disposition enrollment and mints grounded portal questions without enabling sends', {
  skip: !pgUrl && 'INCOMPLETE: PostgreSQL required', timeout:60000
}, async t => {
  const pool = await bootHostedPilotDatabase(t,'donna_pilot_terminal');
  const firmId = 'terminal-fixture';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,$1,$1,$2)", [firmId,{loops:{auto_send_client_asks:false}}]);
  const clients = ['pilot','explicit-off','historical-off','revoked','incomplete','ordinary'];
  const flag = (clientId,flagKey,stage='canary',reason=CLOUD_PILOT_PROCESSING_VERSION) => setClientFlagStage(pool,
    {firmId,clientId,flagKey,stage,reason,source:'manual',actorType:'firm_member',actorId:'fixture-operator'});
  for (const clientId of clients) {
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
      values($1,$2,$1,'fi','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}')`,[clientId,firmId]);
    for (const key of CLOUD_PILOT_PROCESSING_FLAGS.filter(key => ![BANK_LINE_DISPOSITION_FLAG,'JEV_RECONCILIATION'].includes(key))) {
      if (clientId === 'incomplete' && key === 'LEDGER_AUTO_POST') continue;
      await flag(clientId,key);
    }
    if (clientId !== 'ordinary') await flag(clientId,'INTERNAL_PILOT_ACCESS','canary',HOSTED_PILOT_VERSION);
  }
  await flag('explicit-off',BANK_LINE_DISPOSITION_FLAG,'off');
  await flag('historical-off',BANK_LINE_DISPOSITION_FLAG,'off');
  await pool.query('update client_capability_config set valid_to=now() where client_id=$1 and flag_key=$2',['historical-off',BANK_LINE_DISPOSITION_FLAG]);
  await flag('revoked','INTERNAL_PILOT_ACCESS','off',HOSTED_PILOT_VERSION);
  const line = (id,amount,description) => pool.query(`insert into transactions
    (id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
    values($1,$2,'pilot','2025-02-15',$3,$4,0,'EUR','needs_review','{}')`,[id,firmId,description,amount]);
  await line('statutory',35.04,'Synthetic employment contribution');
  const held = async (id,total=596.4,type='supplier_bill',extra=[]) => {
    await line(id,total,`Synthetic ${id}`);
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,
      document_date,vendor_name,customer_name,payment_status,reference_number,parse_summary,payload)
      values($1,$2,'pilot',$3,$4,'completed',$5,'EUR','2025-02-10','Synthetic supplier','Synthetic customer','unpaid',$6,'{}','{}')`,
    [`doc-${id}`,firmId,`${id}.pdf`,type,total,`invoice-${id}`]);
    await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,
      matched_object_id,match_amount,match_confidence,status,payload) values($1,$2,'pilot',$3,$4,$5,$6,.95,'suggested',$7)`,
    [`match-${id}`,firmId,id,type,`doc-${id}`,total,{authorization:{reasons:['above_materiality_ceiling',...extra]},match_reason:{reasoning:'Synthetic model-selected document'}}]);
  };
  await held('pension');
  await held('net-sale',2008,'sales_invoice',['below_floor','amount_or_currency_unreconciled']);
  await pool.query("update transactions set money_out=0,money_in=1631.5 where id='net-sale'");
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,
    customer_name,payment_status,reference_number,parse_summary,payload)
    values('credit',$1,'pilot','credit.pdf','sales_invoice','completed',-376.5,'EUR','2025-02-11','Synthetic customer','credit_note','credit-1',
      '{"references":[{"type":"invoice_number","value":"invoice-net-sale"}]}','{}')`,[firmId]);
  // Same client and dates are not enough: only this AR customer's credit
  // can accompany its held invoice. An AP credit is not an AR reduction.
  for (const [id,type,customer] of [['other-customer-credit','sales_invoice','Rantala Autokorjaamo'],['supplier-credit','supplier_bill','Synthetic customer']]) {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,
      customer_name,vendor_name,payment_status,reference_number,parse_summary,payload)
      values($1,$2,'pilot',$3,$4,'completed',-376.5,'EUR','2025-02-11',$5,'Synthetic supplier','credit_note',$1,'{}','{}')`,
    [id,firmId,`${id}.pdf`,type,customer]);
  }
  const calls = [];
  globalThis.fetch = async (target,init) => {
    assert.match(String(target),/api\.anthropic\.com/,'no other external transport allowed');
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({model:'fixture-model',content:[{type:'text',text:JSON.stringify({
      disposition:'statutory_payment',line_identified:true,materiality:'material',expense_kind:'statutory_payment',
      confidence:.98,reasoning:'Synthetic identified statutory payment.'})}],usage:{input_tokens:1,output_tokens:1}}));
  };
  const withClient = async fn => { const client = await pool.connect(); try { return await fn(client); } finally {client.release();} };
  for (const clientId of clients.filter(id => id !== 'pilot')) {
    await withClient(async client => {
      await client.query('begin');
      try {
        assert.equal(await healHostedPilotDispositionEnrollmentWithClient(client,{firmId,clientId}),false,clientId);
        await client.query('commit');
      } catch (error) { await client.query('rollback'); throw error; }
    });
  }
  // Actual readiness denies this unprovisioned fixture before any model call.
  const denied = await runCodingConvergenceInDb({firmId,
    recoverOwnerRepliesFn:null,recoverReconciliationProviderFailuresFn:null,recoverChangedEvidenceFn:null,
    recoverRefusedEvidenceFn:null,recoverAeVatLegacyCodingFn:null,recoverAskDraftFn:async()=>[],releaseWaitingFn:async()=>[],
    discoverCoderClientsFn:async()=>[],discoverSweepClientsFn:async()=>[],discoverLedgerPostClientsFn:async()=>[]});
  assert.ok(denied.hosted_pilot_terminal_convergence.some(item => item.outcome === 'error'),JSON.stringify(denied));
  assert.equal(calls.length,0,'readiness cannot be bypassed by client enrollment');
  // Admission is the only injected control in this fixture; all work below is
  // the real producer, gather, config history and per-line ask lifecycle.
  const first = await runHostedPilotTerminalConvergenceInDb({firmId,withClient});
  assert.ok(first.every(item => !item.error),JSON.stringify(first));
  assert.equal(calls.length,1,JSON.stringify(first));
  assert.equal((await pool.query("select reconciliation_status from transactions where id='statutory'")).rows[0].reconciliation_status,'explained');
  const questions = (await pool.query('select * from client_evidence_requests order by transaction_id')).rows;
  assert.equal(questions.length,2,JSON.stringify(questions));
  const net = questions.find(row => row.transaction_id === 'net-sale');
  assert.match(net.question,/credit\.pdf/); assert.match(net.question,/net-sale\.pdf/);
  assert.match(net.question,/1631,50 EUR/); assert.match(net.question,/15\.2\.2025/);
  assert.equal(net.question.split('credit.pdf').length-1,1,'the same credit has one document identity');
  assert.deepEqual(net.request_payload.citable_local_evidence.map(row=>row.document_id).sort(),['credit','doc-net-sale']);
  const ap = questions.find(row => row.transaction_id === 'pension');
  assert.deepEqual(ap.request_payload.citable_local_evidence.map(row=>row.document_id),['doc-pension'],
    'an outgoing supplier payment cannot cite an unrelated customer credit');
  // H-3a: one held document is a confirmation; an invoice with its eligible
  // credit is still a choice between documents.
  assert.match(net.question,/Kerro, mitä näistä tositteista tämä maksu koskee/);
  assert.match(ap.question,/Vahvistathan, että tämä maksu koskee tätä tositetta/);
  assert.doesNotMatch(ap.question,/mitä näistä tositteista/);

  for (const ask of questions) {
    assert.equal(ask.status,'draft'); assert.equal(ask.send_count,0); assert.equal(ask.first_sent_at,null);
    assert.equal(ask.evidence_type,'business_purpose'); assert.equal(ask.audience,'client');
    assert.ok(ask.request_payload.held_match_groups.length);
  }
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient});
  assert.equal(calls.length,1,'current disposition verdict is incremental');
  assert.deepEqual((await pool.query('select * from client_evidence_requests order by transaction_id')).rows,questions,'no duplicate or rewritten question');
  const healed = (await pool.query("select client_id from audit_events where action='pilot.processing.extension_healed'")).rows;
  assert.deepEqual(healed,[{client_id:'pilot'}]);
  assert.equal((await pool.query('select metadata from firms where id=$1',[firmId])).rows[0].metadata.loops.auto_send_client_asks,false);
  await withClient(async client => assert.equal(await readInternalPilotSendRestrictionWithClient(client,{firmId,clientId:'pilot'}),true));
  await pool.query(`insert into client_ask_batches(id,firm_id,client_id,status,subject,message_markdown,payload)
    values('held-batch',$1,'pilot','draft','Synthetic','Synthetic','{}')`,[firmId]);
  await assert.rejects(withClient(client => __sendClientAskBatchWithClient({client,firmId,clientId:'pilot',batchId:'held-batch'})),
    {code:'INTERNAL_PILOT_SEND_DISABLED'});
  assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0,'held matches do not acquire posting authority');
  // A denied, explicitly paused, or held-only client must not consume the
  // firm's model budget or prevent another company from reaching its worker.
  const fairnessClients = ['a-denied','b-paused','c-held-only','d-healthy','e-healthy','f-next-tick'];
  const seedFairnessClient = async clientId => {
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
      values($1,$2,$1,'fi','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}')`,[clientId,firmId]);
    // This lifecycle pins the existing reasoning transport, before Jev enrollment.
    for (const key of CLOUD_PILOT_PROCESSING_FLAGS.filter(key => key !== 'JEV_RECONCILIATION')) await flag(clientId,key);
    await flag(clientId,'INTERNAL_PILOT_ACCESS','canary',HOSTED_PILOT_VERSION);
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
      values($1,$2,$3,'2025-02-15','Synthetic employment contribution',35.04,0,'EUR','needs_review','{}')`,
    [`line-${clientId}`,firmId,clientId]);
  };
  for (const clientId of fairnessClients) await seedFairnessClient(clientId);
  await flag('b-paused',BANK_LINE_DISPOSITION_FLAG,'off');
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,payload)
    values('fair-held-doc',$1,'c-held-only','held.pdf','supplier_bill','completed',35.04,'EUR','{}')`,[firmId]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,
    matched_object_id,match_amount,match_confidence,status,payload)
    values('fair-held-match',$1,'c-held-only','line-c-held-only','supplier_bill','fair-held-doc',35.04,.95,'suggested',
      '{"authorization":{"reasons":["above_materiality_ceiling"]}}')`,[firmId]);
  const admitted = [];
  const runWorkerAdmissionFn = async ({clientId,work}) => {
    admitted.push(clientId);
    if (clientId === 'a-denied' || clientId.startsWith('scan-denied-')) throw Object.assign(new Error('Synthetic client readiness failure'),{code:'ENTITY_READINESS_BLOCKED'});
    return work();
  };
  const callsBeforeFairness = calls.length;
  const fair = await runHostedPilotTerminalConvergenceInDb({firmId,withClient,runWorkerAdmissionFn});
  assert.equal(fair.find(row => row.client_id === 'a-denied')?.code,'ENTITY_READINESS_BLOCKED');
  assert.ok(admitted.includes('d-healthy'),'a denied first client cannot starve another company');
  assert.equal(calls.length-callsBeforeFairness,2,'one firm-wide budget across all clients/directions');
  assert.deepEqual((await pool.query(`select id from transactions where client_id=any($1::text[])
    and reconciliation_status='explained' order by id`,[fairnessClients])).rows,
  [{id:'line-d-healthy'},{id:'line-e-healthy'}]);
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where client_id='c-held-only'")).rows[0].n,1,
    'held-only work progresses without spending a model slot');
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient,runWorkerAdmissionFn});
  assert.equal(calls.length-callsBeforeFairness,3,'the next tick drains the remaining company despite persistent denied/paused rows');
  assert.equal((await pool.query("select reconciliation_status from transactions where id='line-f-next-tick'")).rows[0].reconciliation_status,'explained');
  // The bounded page must also rotate without a model verdict. More denied
  // companies than fit in one page cannot hide a later healthy company forever.
  for (let index=0; index<26; index+=1) await seedFairnessClient(`scan-denied-${String(index).padStart(2,'0')}`);
  await seedFairnessClient('zz-healthy');
  const beforePage = admitted.length;
  const beforePageCalls = calls.length;
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient,runWorkerAdmissionFn});
  assert.equal(admitted.length-beforePage,25,'one tick scans at most 25 companies');
  assert.equal(calls.length,beforePageCalls,'refusals cost no model calls');
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient,runWorkerAdmissionFn});
  assert.equal((await pool.query("select reconciliation_status from transactions where id='line-zz-healthy'")).rows[0].reconciliation_status,'explained',
    'a fresh invocation rotates past the denied page using persisted scan receipts');
  assert.equal(calls.length-beforePageCalls,1);
  for (const id of ['budget-failure-1','budget-failure-2','budget-failure-3']) await seedFairnessClient(id);
  const failedWorkerCalls = [];
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient,runWorkerAdmissionFn,
    runDispositionFn:async ({clientId,maxTransactions}) => {
      assert.equal(maxTransactions,1); failedWorkerCalls.push(clientId);
      throw new Error('Synthetic failure after a possible provider call');
    }});
  assert.deepEqual(failedWorkerCalls,['budget-failure-1','budget-failure-2'],
    'unexpected worker failure cannot refund a potentially spent model slot');
  const afterFailureCalls = calls.length;
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient,runWorkerAdmissionFn});
  assert.ok(calls.length-afterFailureCalls <= 2,'retry tick retains the firm-wide cap');
  assert.equal((await pool.query("select reconciliation_status from transactions where id='line-budget-failure-3'")).rows[0].reconciliation_status,'explained',
    'unattempted work stays ahead of retrying failures after budget exhaustion');
  // Reproduce historical producer output through the named ask writer,
  // then let the real hosted clock refresh its current evidence in place.
  for (const original of questions) {
    await withClient(async client => {
      await client.query('begin');
      try {
        await createClientEvidenceRequestWithClient({client,firmId,clientId:'pilot',transactionId:original.transaction_id,
          actorId:'coding_auto_post',evidenceType:'business_purpose',
          question:'Old settlement question citing credit.pdf twice and other-customer-credit.pdf.',
          requestContext:{...original.request_payload,citable_local_evidence:[
            {id:'credit',filename:'credit.pdf'},{document_id:'credit',filename:'credit.pdf'},
            {document_id:'other-customer-credit',filename:'other-customer-credit.pdf'}]}});
        await client.query('commit');
      } catch(error) {await client.query('rollback');throw error;}
    });
  }
  // Remove the synthetic backlog from this clock's discovery; its fairness
  // behavior was independently asserted above and does not own these asks.
  await pool.query("update transactions set reconciliation_status='explained' where client_id <> 'pilot'");
  const beforeRefreshCalls = calls.length;
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient});
  assert.equal(calls.length,beforeRefreshCalls,'evidence refresh does not call a model');
  const refreshed = (await pool.query("select * from client_evidence_requests where client_id='pilot' order by transaction_id")).rows;
  for (const original of questions) {
    const current = refreshed.find(row=>row.id===original.id);
    assert.equal(current.question,original.question,'replace the whole question from its current evidence, retaining ask identity');
    assert.deepEqual(current.request_payload.citable_local_evidence,original.request_payload.citable_local_evidence);
    assert.equal(current.status,original.status); assert.equal(current.send_count,0); assert.equal(current.first_sent_at,null);
  }
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient});
  assert.deepEqual((await pool.query("select * from client_evidence_requests where client_id='pilot' order by transaction_id")).rows,refreshed,
    'unchanged evidence produces no repeat rewrite');
  await pool.query("update documents set currency='USD' where id='credit'");
  await runHostedPilotTerminalConvergenceInDb({firmId,withClient});
  const changedCreditAsk = (await pool.query('select * from client_evidence_requests where id=$1',[net.id])).rows[0];
  assert.deepEqual(changedCreditAsk.request_payload.citable_local_evidence.map(row=>row.document_id),['doc-net-sale'],
    'current invoice-specific eligibility removes a formerly eligible credit from the same unanswered ask');
  assert.ok(!changedCreditAsk.question.includes('credit.pdf'));
  assert.match(changedCreditAsk.question,/Vahvistathan, että tämä maksu koskee tätä tositetta/,
    'a group narrowed to one document refreshes the unsent draft to the confirmation wording');
  assert.doesNotMatch(changedCreditAsk.question,/mitä näistä tositteista/);
  assert.equal(changedCreditAsk.id,net.id);
  // Exercise the portal's actual reply consumer on the exact minted question.
  for (const [key,stage] of Object.entries(FI_HOSTED_PILOT_STAGES)) await flag('pilot',key,stage,HOSTED_PILOT_VERSION);
  const {seedPackPaletteChartWithClient} = await import('./db/ledger.js');
  await withClient(client => seedPackPaletteChartWithClient(client,{firmId,clientId:'pilot'}));
  const pensionAsk = questions.find(row => row.transaction_id === 'pension');
  // The reply recode runs on the default coder path: Claude since 2026-11-10.
  globalThis.fetch = async (target,init) => {
    assert.equal(String(target),ANTHROPIC_MESSAGES_TEST_URL);
    return claudeMessageResponse({
      proposed_account:'TyEL and payroll contributions payable',contact:'Synthetic supplier',tax_treatment:'Ei ALV-käsittelyä',
      support_note:'The customer confirms this payment settles the named pension bill.',ask_client_question:'',
      evidence_required:false,remember_candidate:false,merchant_pattern:'',missing_account_name:'',missing_account_type:'',
      missing_account_reason:'',auto_explain_limit:0,confidence:'high',materiality:'material',
      reasoning:'The customer confirms payment of the pension liability shown on the held bill.',warnings:[],alternatives:[]},
      {request:JSON.parse(init.body),id:'fixture-reply'});
  };
  const reply = await resolveClientEvidenceRequestInDb({firmId,evidenceRequestId:pensionAsk.id,
    reply:'Yes, this payment settles pension.pdf in full.',actorId:'fixture-customer',actorType:'client'});
  assert.equal(reply.recode?.applied,true,JSON.stringify(reply.recode));
  assert.equal(reply.evidence_request.status,'resolved');
  assert.equal(reply.recode?.posted,false,'unprovisioned fixture must not bypass posting readiness');
  assert.match(reply.recode.post_error,/readiness/);
  // A match settling after discovery must not mint a stale ask. Hold the
  // client lock in one connection while another starts the real gather.
  await held('race');
  const blocker = await pool.connect(); await blocker.query('begin');
  await blocker.query("select id from clients where id='pilot' for update");
  let gathered;
  const sawDiscovery = new Promise(resolve => {gathered=resolve;});
  const pending = withClient(client => __createHeldMatchPortalAsksWithClient({client:{query:async (...args) => {
    const result = await client.query(...args);
    if (String(args[0]).includes('select m.id as match_id')) gathered();
    return result;
  }},firmId,clientId:'pilot'}));
  await sawDiscovery;
  await blocker.query("update reconciliation_matches set status='confirmed' where id='match-race'");
  await blocker.query('commit'); blocker.release();
  assert.deepEqual(await pending,[]);
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='race'")).rows[0].n,0);
  for (const [status,createdBy] of [['replied','coding_auto_post'],['open','coding_auto_post'],['open','fixture-operator']]) {
    await pool.query('update client_evidence_requests set status=$2,created_by=$3 where id=$1',[net.id,status,createdBy]);
    const protectedAsk = (await pool.query('select * from client_evidence_requests where id=$1',[net.id])).rows[0];
    await pool.query("update documents set filename=filename || '-changed' where id='doc-net-sale'");
    await withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'}));
    assert.deepEqual((await pool.query('select * from client_evidence_requests where id=$1',[net.id])).rows[0],protectedAsk,
      'a reply or human-authored question must never be rewritten by evidence refresh');
  }
  await pool.query("update client_evidence_requests set status='draft',created_by='coding_auto_post' where id=$1",[net.id]);
  await withClient(async client => {
    await client.query('begin');
    try {
      await createClientEvidenceRequestWithClient({client,firmId,clientId:'pilot',transactionId:'net-sale',
        actorId:'fixture-operator',evidenceType:'business_purpose',question:'A human-authored settlement question.'});
      await client.query('commit');
    } catch(error) {await client.query('rollback');throw error;}
  });
  const humanRemint = (await pool.query('select * from client_evidence_requests where id=$1',[net.id])).rows[0];
  assert.equal(humanRemint.created_by,'coding_auto_post','birth actor alone cannot prove current wording ownership');
  await withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'}));
  assert.deepEqual((await pool.query('select * from client_evidence_requests where id=$1',[net.id])).rows[0],humanRemint);
  // More existing drafts than fit in the page must not hide a later new
  // question or a later stale draft on this same company.
  for(let index=0;index<51;index+=1) await held(`page-${index}`,40+index);
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,payload)
    values('page-zero-sibling',$1,'pilot','page-zero-sibling.pdf','supplier_bill','completed',40,'EUR','{}')`,[firmId]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,
    matched_object_id,match_amount,match_confidence,status,payload)
    values('page-zero-sibling-match',$1,'pilot','page-0','supplier_bill','page-zero-sibling',40,.95,'suggested',
      '{"authorization":{"reasons":["above_materiality_ceiling"]}}')`,[firmId]);
  const firstPage = await withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'}));
  assert.equal(firstPage.length,10,'rotation cannot displace selected targets from the locked recheck');
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id like 'page-%'")).rows[0].n,10);
  for(let tick=0;tick<6;tick+=1) await withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'}));
  const pageAsks = (await pool.query("select * from client_evidence_requests where transaction_id like 'page-%'")).rows;
  assert.equal(pageAsks.length,51);
  const completeGroup = pageAsks.find(ask=>ask.transaction_id==='page-0');
  assert.equal(completeGroup.request_payload.held_match_groups[0].match_ids.length,2,
    'the scoped recheck retains a sibling candidate outside the original discovery page');
  assert.deepEqual(completeGroup.request_payload.citable_local_evidence.map(doc=>doc.document_id),['doc-page-0','page-zero-sibling']);
  for(const ask of pageAsks) {
    await withClient(async client=>{
      await client.query('begin');
      try {
        await createClientEvidenceRequestWithClient({client,firmId,clientId:'pilot',transactionId:ask.transaction_id,
          actorId:'coding_auto_post',evidenceType:'business_purpose',question:'Synthetic stale page question.',requestContext:ask.request_payload});
        await client.query('commit');
      } catch(error) {await client.query('rollback');throw error;}
    });
  }
  for(let tick=0;tick<7;tick+=1) await withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'}));
  for(const ask of pageAsks) assert.equal((await pool.query('select question from client_evidence_requests where id=$1',[ask.id])).rows[0].question,ask.question);
  await held('oversized-group');
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,payload)
    select 'oversized-doc-' || n,$1,'pilot','oversized-' || n || '.pdf','supplier_bill','completed',596.4,'EUR','{}'::jsonb
    from generate_series(1,200) n`,[firmId]);
  await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,
    matched_object_id,match_amount,match_confidence,status,payload)
    select 'oversized-match-' || n,$1,'pilot','oversized-group','supplier_bill','oversized-doc-' || n,596.4,.95,'suggested',
      '{"authorization":{"reasons":["above_materiality_ceiling"]}}'::jsonb from generate_series(1,200) n`,[firmId]);
  await assert.rejects(withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'})),
    {code:'HELD_MATCH_EVIDENCE_LIMIT'});
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='oversized-group'")).rows[0].n,0,
    'an oversized complete group must refuse instead of minting a partial question');
  await held('after-oversized');
  await withClient(client=>__createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'}));
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='after-oversized'")).rows[0].n,1,
    'the refusal scan receipt rotates the oversized group behind later healthy work');
  await held('unready');
  await pool.query(`update documents set payload='{"reconciliation_provider_failure":{"code":"PROVIDER_UNAUTHORIZED"}}'
    where id='doc-unready'`);
  await assert.rejects(withClient(client => __createHeldMatchPortalAsksWithClient({client,firmId,clientId:'pilot'})),
    {code:'HELD_MATCH_EVIDENCE_NOT_READY'});
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='unready'")).rows[0].n,0,
    'provider failure remains operator work, never a business question');
});

// Stability finding 2026-09-23 §6.4: an exhausted readiness saga (old
// Kampaamo, cross_firm_identity_collision) was re-selected by the coding tick's
// discoveries and refused at worker_discovery every five minutes, forever.
// Production wiring end to end: the real tick, both real discoveries, the real
// admission wrapper, the real Reopen writer.
test('real PG: an exhausted readiness saga rests off both discoveries, writes nothing per tick, and Reopen resumes discovery', {
  skip: !pgUrl && 'INCOMPLETE: PostgreSQL required', timeout:60000
}, async t => {
  const pool = await bootHostedPilotDatabase(t,'donna_exhausted_rest');
  const {ENTITY_READINESS_ADMISSION_FLAG} = await import('./clientConfig.js');
  const {provisionEntityReadiness} = await import('./runtimeReadiness.js');
  const {withFirmDbClient} = await import('./firmDb.js');
  const {getFirmSnapshotFromDb} = await import('./firmDb.js');
  const {getOperatorCaseSnapshot} = await import('./operatorCaseSnapshot.js');
  globalThis.fetch = async target => { throw new Error(`no external transport in this proof: ${target}`); };
  const firmId = 'exhausted-fixture';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,$1,$1,$2)", [firmId,{loops:{auto_send_client_asks:false}}]);
  const flag = (clientId,flagKey,stage='canary',reason=CLOUD_PILOT_PROCESSING_VERSION) => setClientFlagStage(pool,
    {firmId,clientId,flagKey,stage,reason,source:'manual',actorType:'firm_member',actorId:'fixture-operator'});
  // Both companies are enrolled hosted pilots with an uncoded line, so BOTH
  // the hosted terminal scan and the coder discovery would select them.
  const seed = async (clientId,saga) => {
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
      values($1,$2,$1,'fi','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}')`,[clientId,firmId]);
    for (const key of CLOUD_PILOT_PROCESSING_FLAGS.filter(key => key !== 'JEV_RECONCILIATION')) await flag(clientId,key);
    await flag(clientId,'INTERNAL_PILOT_ACCESS','canary',HOSTED_PILOT_VERSION);
    await flag(clientId,ENTITY_READINESS_ADMISSION_FLAG,saga.enrollment || 'canary','stability proof: enrolled pilot');
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
      values($1,$2,$3,'2025-02-15','Synthetic supplier payment',35.04,0,'EUR','needs_review','{}')`,[`line-${clientId}`,firmId,clientId]);
    const receipt = (await pool.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,$2,'system','fixture','entity.readiness.attempt','entity_readiness',$2,'{}') returning id`,[firmId,clientId])).rows[0].id;
    await pool.query(`insert into entity_readiness_sagas(firm_id,client_id,saga_id,idempotency_key,state,admitted_profile_id,
      certificate_version,manifest_version,latest_attempt_id,attempt_count,max_attempts,retry_state,reason_code,responsible_system,
      next_retry_at,failed_at) values($1,$2,$3,$3,'failed','fixture-profile','fixture','fixture',$4,$5,3,$6,$7,'donna_readiness',$8,now())`,
    [firmId,clientId,`saga-${clientId}`,receipt,saga.attempts,saga.retry_state,saga.reason,saga.next_retry_at]);
  };
  await seed('exhausted',{attempts:3,retry_state:'exhausted',reason:'cross_firm_identity_collision',next_retry_at:null});
  // The neighbour waits on the host (budget-free, scheduled): it must keep
  // being discovered — and refused normally — on every tick.
  await seed('scheduled',{attempts:1,retry_state:'scheduled',reason:'host_certificate_not_pass',next_retry_at:new Date(Date.now()+3600_000)});
  // The predicate never widens and never narrows admission's own scope: an
  // exhausted saga whose enrollment no longer acts is not enforced, so it is
  // discovered exactly as before.
  await seed('unenrolled',{attempts:3,retry_state:'exhausted',reason:'cross_firm_identity_collision',next_retry_at:null,enrollment:'off'});

  const auditCount = async clientId => (await pool.query('select count(*)::int n from audit_events where client_id=$1',[clientId])).rows[0].n;
  const actions = async (clientId,after) => (await pool.query(`select action,metadata->>'boundary' boundary from audit_events
    where client_id=$1 and id>$2 order by id`,[clientId,after])).rows;
  const lastId = async () => Number((await pool.query('select coalesce(max(id),0) id from audit_events')).rows[0].id);
  const tick = () => runCodingConvergenceInDb({firmId});
  const named = (summary,clientId) => JSON.stringify([summary.coder,summary.hosted_pilot_terminal_convergence])
    .includes(`"client_id":"${clientId}"`);

  const exhaustedBefore = await auditCount('exhausted');
  const mark = await lastId();
  const ticks = [await tick(), await tick()];
  assert.equal(await auditCount('exhausted'),exhaustedBefore,
    JSON.stringify(await actions('exhausted',mark)));
  for (const summary of ticks) {
    assert.equal(named(summary,'exhausted'),false,'neither discovery selects the exhausted company');
    assert.equal(named(summary,'scheduled'),true,JSON.stringify(summary));
  }
  assert.equal(named(ticks[0],'unenrolled'),true,JSON.stringify(ticks[0]));
  const neighbour = await actions('scheduled',mark);
  assert.equal(neighbour.filter(row => row.action === 'pilot.processing.terminal_scan').length,2,'scanned on both ticks');
  assert.equal(neighbour.filter(row => row.action === 'runtime.readiness_admission_blocked' && row.boundary === 'worker_discovery').length,4,
    'both discoveries still reach the unchanged admission check for the neighbour, each tick');

  // Resting, but visible: the owner chip is "Setup needs attention" with
  // Reopen, and the line's case health names the exhausted setup hold even
  // though no fresh refusal receipt exists.
  const readiness = (await getFirmSnapshotFromDb({firmId})).clients.find(client => client.id === 'exhausted').runtime_readiness;
  assert.equal(readiness.label,'Setup needs attention');
  assert.equal(readiness.can_reopen,true);
  assert.equal(readiness.can_retry_now,false);
  const caseSnapshot = await getOperatorCaseSnapshot({firmId,clientId:'exhausted',focus:{type:'transaction',id:'line-exhausted'},include:['case_health']});
  assert.equal(caseSnapshot.case_health?.blocker?.kind,'held_by_setup_recovery',JSON.stringify(caseSnapshot.case_health));
  assert.equal(caseSnapshot.case_health.recovery.basis,'readiness_recovery_exhausted');

  // Reopen is the owner's exit: a fresh bounded episode (here it re-fails on
  // the hosted fixture's missing host certificate — a scheduled host wait),
  // and the very next tick discovers the company again.
  await provisionEntityReadiness({withFirmDbClientFn:withFirmDbClient,firmId,clientId:'exhausted',retry:true,reopenExhausted:true,
    lifecycle:'retry',compatibilityScope:'current_generation_compatibility',
    initiatingPrincipal:{actor_type:'firm_member',actor_id:'fixture-owner'},
    authorityBasis:{source:'authenticated_readiness_reopen',principal_id:'fixture-owner'}});
  const reopened = (await pool.query("select state,retry_state from entity_readiness_sagas where client_id='exhausted'")).rows[0];
  assert.deepEqual(reopened,{state:'failed',retry_state:'scheduled'},'Reopen starts a fresh bounded episode');
  const afterReopen = await lastId();
  const resumed = await tick();
  assert.equal(named(resumed,'exhausted'),true,JSON.stringify(resumed));
  assert.ok((await actions('exhausted',afterReopen)).some(row => row.action === 'pilot.processing.terminal_scan'));
});

// Kampaamo Kultalanka, 2026-09-23: the TyEL notice was on file and held-matched
// to its payment above the materiality ceiling, but the coder's earlier
// "provide the contribution notice" draft (the statutory source rule counts
// only a settled match) kept the held-match writer from asking the owner to
// confirm the match. The line rested asking for a document already on file.
test('real PG: a held match supersedes the coder\'s unsent source-document draft with the owner confirmation', {
  skip: !pgUrl && 'INCOMPLETE: PostgreSQL required', timeout:60000
}, async t => {
  const pool = await bootHostedPilotDatabase(t,'donna_held_supersedes_source');
  globalThis.fetch = async target => { throw new Error(`no external transport in this proof: ${target}`); };
  const firmId = 'held-source-fixture', clientId = 'pilot';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,$1,$1,$2)", [firmId,{loops:{auto_send_client_asks:false}}]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile)
    values($1,$2,$1,'fi','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}')`,[clientId,firmId]);
  const flag = (flagKey,stage='canary',reason=CLOUD_PILOT_PROCESSING_VERSION) => setClientFlagStage(pool,
    {firmId,clientId,flagKey,stage,reason,source:'manual',actorType:'firm_member',actorId:'fixture-operator'});
  for (const key of CLOUD_PILOT_PROCESSING_FLAGS) await flag(key);
  await flag('INTERNAL_PILOT_ACCESS','canary',HOSTED_PILOT_VERSION);
  const withClient = async fn => { const client = await pool.connect(); try { return await fn(client); } finally {client.release();} };
  const heldWithSourceDraft = async (id, actorId = 'coding_auto_post') => {
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,coding_state,payload)
      values($1,$2,$3,'2025-02-12',$4,596.4,0,'EUR','needs_review','proposed','{}')`,[id,firmId,clientId,`ILMARINEN TYEL 1/2025 ${id}`]);
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,
      document_date,vendor_name,payment_status,payload) values($1,$2,$3,$4,'supplier_bill','completed',596.4,'EUR','2025-02-02',
      'Ilmarinen','unpaid','{}')`,[`doc-${id}`,firmId,clientId,`25 TyEL-lasku 01-2025 ${id}.pdf`]);
    await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,
      matched_object_id,match_amount,match_confidence,status,payload) values($1,$2,$3,$4,'supplier_bill',$5,596.4,.85,'suggested',$6)`,
    [`match-${id}`,firmId,clientId,id,`doc-${id}`,{authorization:{reasons:['above_materiality_ceiling']},match_reason:{reasoning:'Jev selected this complete settlement plan.'}}]);
    return withClient(async client => {
      await client.query('begin');
      try {
        const ask = await createClientEvidenceRequestWithClient({client,firmId,clientId,transactionId:id,actorId,
          evidenceType:'supporting_document',
          question:`ILMARINEN TYEL 1/2025: Please provide the filing, assessment or contribution notice that establishes the liability and period settled by this payment.`});
        await client.query('commit');
        return ask;
      } catch (error) { await client.query('rollback'); throw error; }
    });
  };
  const asksFor = id => pool.query('select * from client_evidence_requests where transaction_id=$1 order by created_at,id',[id]).then(r => r.rows);

  const source = await heldWithSourceDraft('ilmarinen');
  // A sent question is already with the owner, and a human-authored one is
  // theirs: neither is rewritten by the held-match writer.
  const sent = await heldWithSourceDraft('sent-source');
  await pool.query("update client_evidence_requests set status='open',send_count=1,first_sent_at=now(),last_sent_at=now() where id=$1",[sent.id]);
  const sentBefore = await asksFor('sent-source');
  const human = await heldWithSourceDraft('human-source','fixture-operator');
  const humanBefore = await asksFor('human-source');

  const minted = await withClient(client => __createHeldMatchPortalAsksWithClient({client,firmId,clientId}));
  const asks = await asksFor('ilmarinen');
  const superseded = asks.find(ask => ask.id === source.id);
  assert.equal(superseded.status,'resolved','the on-file document answers the document request');
  assert.equal(superseded.resolved_by,'coding_auto_post');
  assert.deepEqual(superseded.response_payload.document_ids,['doc-ilmarinen']);
  const active = asks.filter(ask => ['draft','open','replied'].includes(ask.status));
  assert.equal(active.length,1,JSON.stringify(asks));
  assert.deepEqual(minted,[active[0].id]);
  assert.equal(active[0].evidence_type,'business_purpose');
  assert.equal(active[0].request_payload.authority_basis,'persisted_match_requires_owner_confirmation');
  assert.match(active[0].question,/25 TyEL-lasku 01-2025 ilmarinen\.pdf/);
  assert.match(active[0].question,/Vahvistathan, että tämä maksu koskee tätä tositetta/);
  assert.doesNotMatch(active[0].question,/mitä näistä tositteista/);
  assert.match(active[0].question,/Tiedostoa ei tarvitse lähettää uudelleen/);
  const receipt = (await pool.query(`select metadata from audit_events where action='evidence_request.superseded_by_held_match'
    and resource_id='ilmarinen'`)).rows;
  assert.equal(receipt.length,1);
  assert.deepEqual(receipt[0].metadata.evidence_request_ids,[source.id]);

  assert.deepEqual(await asksFor('sent-source'),sentBefore,'a sent question stays with the owner');
  assert.deepEqual(await asksFor('human-source'),humanBefore,'a human-authored question keeps its owner');
  assert.equal(human.status,'draft');

  // Idempotent on the next tick: the confirmation is current, nothing moves.
  const settled = await asksFor('ilmarinen');
  assert.deepEqual(await withClient(client => __createHeldMatchPortalAsksWithClient({client,firmId,clientId})),[]);
  assert.deepEqual(await asksFor('ilmarinen'),settled);
});
