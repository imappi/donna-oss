import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, resolveClientEvidenceRequestInDb } from './firmDb.js';
import { processOwnerReplyWithClient, recoverOwnerRepliesInDb, retryOwnerReplyProcessingInDb, DISCOVER_OWNER_REPLIES_SQL } from './ownerReplyRecovery.js';
import { runCodingConvergenceInDb } from './codingConvergence.js';
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('owner reply: durable provider failure, existing clock recovery, exact reply race, duplicate and posted fences', {skip: !pgUrl && 'DONNA_PG_TEST_URL not set'}, async (t) => {
 const admin = new pg.Client({connectionString:pgUrl}); await admin.connect();
 const name = `donna_reply_recovery_${process.pid}_${Date.now()}`;
 await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = `/${name}`;
 const pool = new pg.Pool({connectionString:url.toString()}); const closed=[];
 pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
 __setFirmDbPoolForTests(pool); const priorKey=process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY='test-reply';
 t.after(async()=>{__resetFirmDbPoolForTests(); if(priorKey===undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY=priorKey; await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();});
 await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const migrations=new URL('../../db/migrations/',import.meta.url);
 for(const file of (await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file,migrations),'utf8'));
 const firmId='reply-firm',clientId='reply-client';
 await pool.query("insert into firms(id,name,slug) values($1,'Reply firm','reply-firm')",[firmId]);
 await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Reply Ltd','gb','{"jurisdiction":"gb","accounting_system":"none"}')`,[clientId,firmId]);
 const seed = async(id)=>{
  await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state) values($1,$2,$3,'2026-06-01','WATER PAYMENT',100,'GBP','needs_review','asked')`,[`tx-${id}`,firmId,clientId]);
  await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question,request_payload,response_payload) values($1,$2,$3,$4,'replied','business_purpose','What was this payment for?','{}',$5::jsonb)`,[`ask-${id}`,firmId,clientId,`tx-${id}`,JSON.stringify({reply:'Monthly water delivery for the cafe.',document_ids:[],responded_at:'2026-09-08T10:00:00Z'})]);
 };
 let calls=0,fail=true,onCall=null;
 t.mock.method(globalThis,'fetch',async(endpoint,init)=>{
  assert.equal(endpoint,'https://api.openai.com/v1/responses'); calls++;
  if(onCall) await onCall();
  if(fail) throw new Error('simulated provider outage');
  return {ok:true,json:async()=>({id:`reply-${calls}`,output_text:JSON.stringify({proposed_account:'Office expenses',contact:'',tax_treatment:'VAT 20%',support_note:'Owner confirmed business water delivery.',ask_client_question:'',evidence_required:false,remember_candidate:false,merchant_pattern:'',missing_account_name:'',missing_account_type:'',missing_account_reason:'',auto_explain_limit:0,confidence:'high',materiality:'normal',reasoning:'Owner confirmed the purpose.',warnings:[],alternatives:[]})})};
 });
 await seed('recover');
 // Drive the REAL resolve writer: reply is committed before provider fails.
 await pool.query("update client_evidence_requests set status='open' where id='ask-recover'");
 const initial=await resolveClientEvidenceRequestInDb({firmId,evidenceRequestId:'ask-recover',reply:'Monthly water delivery for the cafe.',actorId:'owner@example.test',actorType:'client'});
 assert.equal(initial.evidence_request.status,'replied'); assert.equal(initial.recode.applied,false);
 let saved=(await pool.query("select * from client_evidence_requests where id='ask-recover'")).rows[0];
 assert.equal(saved.response_payload.reply_processing.state,'retry_pending'); assert.equal(saved.response_payload.reply_processing.reply_key,ownerReplyIdentity(saved));
 const sourceReceipt=(await pool.query("select actor_id, metadata from audit_events where action='evidence_request.reply' and resource_id='ask-recover' order by id desc limit 1")).rows[0];
 assert.equal(sourceReceipt.actor_id,'owner@example.test'); assert.equal(sourceReceipt.metadata.reply_key,ownerReplyIdentity(saved));
 assert.equal(sourceReceipt.metadata.reply,saved.response_payload.reply);

 fail=false;
 const tickArgs={firmId,discoverCoderClientsFn:async()=>[],discoverSweepClientsFn:async()=>[],discoverLedgerPostClientsFn:async()=>[],releaseWaitingFn:async()=>[],recoverAskDraftFn:async()=>[],runWorkerAdmissionFn:async({work})=>work()};
 // The production wrapper wires the real reply recovery; only host admission
 // is bypassed inside the recovery callback for this isolated source fixture.
 const tick=()=>runCodingConvergenceInDb({...tickArgs,recoverOwnerRepliesFn:args=>recoverOwnerRepliesInDb({...args,runWorkerAdmissionFn:async({work})=>work()})});
 const recovered=await tick(); assert.equal(recovered.owner_reply_recovery[0].applied,true);
 saved=(await pool.query("select * from client_evidence_requests where id='ask-recover'")).rows[0]; assert.equal(saved.status,'resolved'); assert.equal(saved.response_payload.reply_processing.state,'completed');
 const afterCalls=calls; await tick(); assert.equal(calls,afterCalls); assert.equal((await retryOwnerReplyProcessingInDb({firmId,clientId,transactionId:'tx-recover'})).eligible_replies,0);
 assert.equal((await pool.query("select count(*)::int as n from audit_events where action='evidence_request.reply_processed' and resource_id='ask-recover'")).rows[0].n,1);
 // A newer answer arrives while the provider thinks: the old decision cannot
 // apply or resolve the new answer. The next tick reads its exact new identity.
 await seed('race'); const before=(await pool.query("select account_code,payload,coding_state from transactions where id='tx-race'")).rows[0];
 onCall=async()=>{onCall=null; await pool.query(`update client_evidence_requests set response_payload=response_payload || '{"reply":"Actually this was personal water delivery.","responded_at":"2026-09-08T11:00:00Z"}'::jsonb where id='ask-race'`);};
 const race=await retryOwnerReplyProcessingInDb({firmId,clientId,transactionId:'tx-race'}); assert.equal(race.results[0].skipped,'reply_superseded');
 assert.deepEqual((await pool.query("select account_code,payload,coding_state from transactions where id='tx-race'")).rows[0],before);
 assert.equal((await pool.query("select status from client_evidence_requests where id='ask-race'")).rows[0].status,'replied');
 await pool.query("update client_evidence_requests set status='resolved' where id='ask-race'");
 // A posted peer is neither discovered nor altered by explicit reply retry.
 await seed('posted'); await pool.query("update transactions set coding_state='posted',status='posted' where id='tx-posted'");
 const postedBefore=(await pool.query("select * from transactions where id='tx-posted'")).rows[0]; const postedCalls=calls;
 assert.equal((await pool.query(DISCOVER_OWNER_REPLIES_SQL,[firmId,10,[]])).rows.length,0);
 const posted=await retryOwnerReplyProcessingInDb({firmId,clientId,transactionId:'tx-posted'}); assert.equal(posted.results[0].skipped,'terminal_or_missing_transaction'); assert.equal(calls,postedCalls);
 assert.deepEqual((await pool.query("select * from transactions where id='tx-posted'")).rows[0],postedBefore);
 // Ordinary provider failure receipts stop at the bound; an explicit retry
 // remains available. Policy failures probe configuration without extra model
 // calls, then the existing clock replays the saved answer after repair.
 await seed('exhausted'); fail=true;
 for(let i=0;i<4;i++) await recoverOwnerRepliesInDb({firmId});
 const exhausted=(await pool.query("select response_payload from client_evidence_requests where id='ask-exhausted'")).rows[0].response_payload.reply_processing;
 assert.equal(exhausted.state,'exhausted'); assert.equal(exhausted.attempts,3);
 assert.equal((await pool.query("select count(*)::int as n from audit_events where resource_id='ask-exhausted' and action='evidence_request.reply_processing_failed'")).rows[0].n,3);
 fail=false; assert.equal((await retryOwnerReplyProcessingInDb({firmId,clientId,transactionId:'tx-exhausted'})).results[0].applied,true);
 await seed('policy'); await pool.query("update clients set jurisdiction=null, profile=profile - 'jurisdiction' where id=$1",[clientId]);
 const policyCalls=calls;
 for(let i=0;i<4;i++) await recoverOwnerRepliesInDb({firmId});
 assert.equal(calls,policyCalls);
 assert.equal((await pool.query("select response_payload->'reply_processing'->>'state' as state from client_evidence_requests where id='ask-policy'")).rows[0].state,'exhausted');
 await pool.query("update clients set jurisdiction='gb', profile=profile || '{\"jurisdiction\":\"gb\"}'::jsonb where id=$1",[clientId]);
 assert.equal((await recoverOwnerRepliesInDb({firmId}))[0].applied,true);
 // Lost response / competing ticks cannot buy concurrent provider calls.
 await seed('lease'); let release,entered; const gate=new Promise(r=>release=r), started=new Promise(r=>entered=r);
 onCall=async()=>{onCall=null;entered();await gate;}; const first=retryOwnerReplyProcessingInDb({firmId,clientId,transactionId:'tx-lease'}); await started;
 const duplicate=await retryOwnerReplyProcessingInDb({firmId,clientId,transactionId:'tx-lease'}); assert.equal(duplicate.results[0].skipped,'reply_processing_in_progress'); release(); await first;
});
