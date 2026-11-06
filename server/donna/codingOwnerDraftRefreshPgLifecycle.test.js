import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests,createClientEvidenceRequestInDb,__createClientEvidenceRequestWithClient} from './firmDb.js';
import {batchSuggestTransactionCodingInDb} from './db/coding.js';
import {recoverChangedCodingEvidenceInDb} from './db/codingEvidence.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {readJevCase,codingCaseRevision} from './jevPreview.js';
import {runCodingAutoPostForTransaction} from './codingAutoPost.js';

test('real PG: current coding refreshes only its own never-sent draft with the same identity and audited original question', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`coding_draft_refresh_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 globalThis.fetch=async()=>{throw new Error('No provider call expected outside the explicit stub');};
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','coding-draft-refresh');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash"}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:'draft-refresh',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);
 await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
 values('cash','f','c','2025-06-02','Cash deposit',640,0,'EUR','needs_review','proposed','{"ai_suggestion":{"source":"jev","model":"fixture-provider","case_evidence_digest":"previous-source","posting_requirement":"owner_fact","evidence_required":true,"ask_client_question":"Please provide the sales invoice."}}')`);
 const oldQuestion='Please provide the sales invoice.';
 const old=await createClientEvidenceRequestInDb({firmId:'f',clientId:'c',transactionId:'cash',question:oldQuestion,evidenceType:'supporting_document',actorId:'coding_auto_post',returnSnapshot:false});
 await pool.query(`update transactions set payload=payload || '{"payment_method":"CASH DEPOSIT"}'::jsonb where id='cash'`);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 let providerCalls=0;
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);providerCalls++;
  const request=JSON.parse(init.body);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria),choice=key==='materiality'?'low':entries.some(([k])=>k==='ask_sales_source')?'ask_sales_source':entries[0][0];
   return [key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.95:.05/(entries.length-1)]))}];
  }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.ok(providerCalls>0);
 const current=(await pool.query("select * from transactions where id='cash'")).rows[0];
 assert.equal(current.payload.ai_suggestion.posting_requirement,'owner_fact');
 assert.match(current.payload.ai_suggestion.ask_client_question,/till\/cashbook/);
 const sweep=await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'cash'});
 assert.equal(sweep.skip_reasons.owner_draft_refreshed,1,JSON.stringify(sweep));
 const refreshed=(await pool.query("select * from client_evidence_requests where transaction_id='cash'")).rows;
 assert.equal(refreshed.length,1);assert.equal(refreshed[0].id,old.evidence_request.id);assert.equal(refreshed[0].status,'draft');
 assert.equal(refreshed[0].question,current.payload.ai_suggestion.ask_client_question);
 assert.equal(refreshed[0].send_count,0);assert.equal(refreshed[0].first_sent_at,null);assert.equal(refreshed[0].last_sent_at,null);
 assert.equal(refreshed[0].request_payload.coding_draft_refresh.previous_question,oldQuestion);
 assert.equal(refreshed[0].request_payload.coding_draft_refresh.source_digest,current.payload.ai_suggestion.case_evidence_digest);
 assert.equal((await pool.query("select count(*)::int n from audit_events where action='coding.owner_draft_refreshed'")).rows[0].n,1);
 assert.equal((await pool.query('select count(*)::int n from message_delivery_ledger')).rows[0].n,0);
 assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
 // Exercise the actual sweep guards with fresh source receipts on each target.
 for(const variant of ['human','sent','replied','amended','stale','held','other-system']){
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values($1,'f','c','2025-06-02','Cash deposit',640,0,'EUR','needs_review','proposed','{}')",[variant]);
  const request=await createClientEvidenceRequestInDb({firmId:'f',clientId:'c',transactionId:variant,question:oldQuestion,evidenceType:'supporting_document',actorId:variant==='human'?'member':variant==='other-system'?'system':'coding_auto_post',returnSnapshot:false,
   requestContext:variant==='held'?{authority_basis:'persisted_match_requires_owner_confirmation',channel:'portal'}:{}});
  if(variant==='held')await pool.query("update client_evidence_requests set request_payload=request_payload || '{\"authority_basis\":\"persisted_match_requires_owner_confirmation\",\"channel\":\"portal\"}'::jsonb where id=$1",[request.evidence_request.id]);
  if(variant==='sent')await pool.query("update client_evidence_requests set status='open',send_count=1,first_sent_at=now(),last_sent_at=now() where id=$1",[request.evidence_request.id]);
  if(variant==='replied')await pool.query("update client_evidence_requests set status='replied',responded_at=now(),response_payload='{\"reply\":\"Owner answer\"}' where id=$1",[request.evidence_request.id]);
  if(variant==='amended')await pool.query("update client_evidence_requests set request_payload=request_payload || '{\"amendments\":[{\"actor_id\":\"member\"}]}'::jsonb where id=$1",[request.evidence_request.id]);
  const {caseEvidence}=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:variant,evidenceOnly:true});
  const suggestion={...current.payload.ai_suggestion,case_evidence_digest:variant==='stale'?'stale-receipt':codingCaseRevision(caseEvidence)};
  await pool.query("update transactions set coding_state='proposed',payload=jsonb_build_object('ai_suggestion',$2::jsonb,'ai_suggestion_status','suggested') where id=$1",[variant,JSON.stringify(suggestion)]);
  const before=(await pool.query('select * from client_evidence_requests where id=$1',[request.evidence_request.id])).rows[0];
  await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:variant});
  assert.deepEqual((await pool.query('select * from client_evidence_requests where id=$1',[request.evidence_request.id])).rows[0],before,variant);
 }
 assert.equal((await pool.query("select count(*)::int n from audit_events where action='coding.owner_draft_refreshed'")).rows[0].n,1);
 // A disposition ask predates the coder, but its persisted producer receipt
 // allows current coding to refine the same never-sent ask after source arrival.
 await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('legacy','f','c','2025-06-02','Travel purchase',0,28.6,'EUR','needs_review','asked','{}')");
 const mintClient=await pool.connect();let legacy;
 try{await mintClient.query('begin');legacy=await __createClientEvidenceRequestWithClient({client:mintClient,firmId:'f',clientId:'c',transactionId:'legacy',question:'Is there a receipt?',evidenceType:'business_purpose',actorId:'system',
  requestContext:{lane:'needs_human_disposition',disposition:'needs_human',direction:'money_out'}});await mintClient.query('commit');}finally{mintClient.release();}
 const legacyId=legacy.id;
 const legacyCase=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'legacy',evidenceOnly:true});
 const suggestion={...current.payload.ai_suggestion,jev_decision:{selected:'ask_business_purpose',terminal:'ask_owner'},ask_client_question:'What was the business purpose of this trip?',case_evidence_digest:codingCaseRevision(legacyCase.caseEvidence)};
 await pool.query("update transactions set coding_state='asked',payload=jsonb_build_object('ai_suggestion',$1::jsonb) where id='legacy'",[JSON.stringify(suggestion)]);
 const legacySweep=await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'legacy'});
 assert.equal(legacySweep.skip_reasons.owner_draft_refreshed,1,JSON.stringify(legacySweep));
 const revised=(await pool.query('select * from client_evidence_requests where id=$1',[legacyId])).rows[0];
 assert.equal(revised.question,suggestion.ask_client_question);assert.equal(revised.status,'draft');assert.equal(revised.send_count,0);
 assert.equal(revised.request_payload.coding_draft_refresh.previous_question,'Is there a receipt?');
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='legacy'")).rows[0].n,1);
 assert.equal((await pool.query('select count(*)::int n from message_delivery_ledger')).rows[0].n,0);
});
