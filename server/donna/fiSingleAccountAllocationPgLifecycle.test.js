import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, postLedgerTransactionInDb } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { ELIGIBLE_LINES_SQL, sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { currentCodingEvidence, codingEvidenceDigest, assertCurrentCodingEvidence } from './db/codingEvidence.js';

const pgUrl=process.env.DONNA_PG_TEST_URL;
for (const jurisdiction of ['fi', 'FI']) test(`real PG: ordinary one-line ${jurisdiction} allocations use normal VAT posting and recover through the existing clock`, {skip:!pgUrl&&'DONNA_PG_TEST_URL required'},async t=>{
 const admin=new pg.Client({connectionString:pgUrl});await admin.connect();
 const name=`donna_fi_single_allocation_${process.pid}_${Date.now().toString(36)}`;
 await admin.query(`create database "${name}"`);const url=new URL(pgUrl);url.pathname='/'+name;
 const pool=new pg.Pool({connectionString:url.toString()});const closed=[];
 pool.on('connect',c=>closed.push(new Promise(resolve=>c.once('end',resolve))));
 installConvergenceSettleOnPool(pool);__setFirmDbPoolForTests(pool);
 const priorKey=process.env.OPENAI_API_KEY;process.env.OPENAI_API_KEY='fixture-only';
 t.after(async()=>{if(priorKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=priorKey;__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const migrations=new URL('../../db/migrations/',import.meta.url);
 for(const file of(await readdir(migrations)).filter(n=>n.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
 const firmId='single-allocation-proof',clientId='fi-accrual';
 await pool.query("insert into firms(id,name,slug) values($1,'Synthetic allocation proof',$1)",[firmId]);
 await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic FI Oy',$4,'fi-oy',$3)",[clientId,firmId,{jurisdiction,accounting_system:'none',accounting_basis:'accrual',alv_registration:{status:'registered',registered_from:'2020-01-01'}},jurisdiction]);
 for(const flag of ['FINLAND_ALV_CODING','JURISDICTION_ACCOUNT_PALETTE','RECONCILIATION_CODE_MATCHED_NO_REVIEW','CODING_AUTO_POST','LEDGER_AUTO_POST'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'auto','manual')",[flag,firmId,clientId]);
 const fixtures=[{id:'sales',account:'Sales',net:3000,tax:765,incoming:true},{id:'rent',account:'Rent',net:600,tax:0},{id:'office',account:'Office expenses',net:150,tax:38.25},{id:'accounting',account:'Accounting fees',net:300,tax:76.5}];
 const seed=async(f,id=f.id)=>{
  const total=f.net+f.tax;
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2025-02-25',$1,$4,$5,'EUR','needs_review','{}')",[id,firmId,clientId,f.incoming?total:0,f.incoming?0:total]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$1,$4,'completed',$5,$6,'EUR','2025-02-25','{}')",['doc-'+id,firmId,clientId,f.incoming?'sales_invoice':'supplier_bill',total,f.tax]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,1,'Synthetic ordinary service',$5,'{}')",['line-'+id,firmId,clientId,'doc-'+id,f.net]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.98,'auto_matched','fixture','{}')",['match-'+id,firmId,clientId,id,f.incoming?'sales_invoice':'supplier_bill','doc-'+id,total]);
 };
 let calls=0;
 t.mock.method(globalThis,'fetch',async(endpoint,init)=>{
  assert.equal(String(endpoint),'https://api.openai.com/v1/responses');calls++;
  const body=JSON.parse(init.body);assert.match(body.instructions,/one-line assignment to the proposed account is single_account/);
  const input=JSON.parse(body.input);
  const suggestions=input.transactions.map(row=>{
   const f=fixtures.find(f=>f.id===row.id);assert.ok(f);assert.equal(row.matched_document.lines.length,f.id==='ordinary-multiple'?2:1);
   return{transaction_id:row.id,proposed_account:f.account,tax_treatment:f.tax?'ALV 25,5 %':'Veroton toiminta (ALV-vapaa)',confidence:'high',evidence_required:false,auto_explain_limit:5000,reasoning:'One ordinary invoice charge uses the proposed account and stated VAT.',posting_requirement:f.id==='ordinary-multiple'?'single_account':'document_allocation',document_allocations:f.id==='ordinary-multiple'?[]:[{line_handle:'line_1',account:f.account}],ask_client_question:''};
  });return{ok:true,status:200,json:async()=>({output_text:JSON.stringify({suggestions,group_summary:[]})})};
 });
 const journal=async id=>(await pool.query("select j.id,j.payload,l.account_name,l.debit,l.credit from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.client_id=$2 and j.source_type='transaction' and j.source_id=$3 order by l.line_no",[firmId,clientId,id])).rows;
 for(const f of fixtures)await seed(f);
 await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
 console.log('initial posting receipt',JSON.stringify((await pool.query("select id,coding_state,payload->'ledger_post_refusal'->>'code' as refusal,payload->'ai_suggestion'->>'posting_requirement' as requirement from transactions order by id")).rows));
 for(const f of fixtures){
  const rows=await journal(f.id);assert.equal(rows.length,f.tax?3:2,`${f.id} reaches the ordinary named writer`);
  const amount=f.net+f.tax;
  assert.deepEqual(rows.map(l=>[l.account_name,Number(l.debit),Number(l.credit)]),f.incoming?[['Pankkitili',amount,0],[f.account,0,f.net],['Suoritettava arvonlisävero',0,f.tax]]:f.tax?[[f.account,f.net,0],['Vähennettävä arvonlisävero',f.tax,0],['Pankkitili',0,amount]]:[[f.account,amount,0],['Pankkitili',0,amount]]);
  assert.equal(rows[0].payload.coding_representation?.to,'single_account');
  const retained=(await pool.query('select payload from transactions where id=$1',[f.id])).rows[0].payload.ai_suggestion;
  assert.equal(retained.posting_requirement,'document_allocation');
  assert.deepEqual(retained.document_allocations,[{line_handle:'line_1',account:f.account}]);
  assert.equal(rows[0].payload.coding_representation.evidence_digest,retained.evidence_digest);
 }
 // Retained pre-fix applied/refused rows must recover without another model verdict.
 for(const f of fixtures){
  const id='recovery-'+f.id;await seed(f,id);
  const source=(await pool.query('select payload from transactions where id=$1',[f.id])).rows[0].payload;
  const evidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:id});
  const payload={...source,ledger_journal_id:undefined,ledger_status:undefined,ai_suggestion:{...source.ai_suggestion,transaction_id:id,evidence_digest:codingEvidenceDigest(evidence)}};
  await pool.query("update transactions set coding_state='applied',status='needs_review',payload=$2 where id=$1",[id,payload]);
  await pool.query("update transactions set updated_at=now()-interval '10 minutes' where id=$1",[id]);
  await pool.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata,created_at) values($1,$2,'system','fixture','ledger.auto_post_refused','transaction',$3,$4,now()-interval '6 minutes')",[firmId,clientId,id,{code:'TRANSACTION_DOCUMENT_ALLOCATION_INVALID',error:'Former singleton allocation refusal'}]);
  // The short cooldown is Finnish-only and keeps both firm/client scope guards.
  await pool.query('update clients set jurisdiction=$3 where firm_id=$1 and id=$2',[firmId,clientId,'GB']);
  assert.equal((await pool.query(ELIGIBLE_LINES_SQL,[firmId,clientId,20,id])).rows.length,0);
  await pool.query('update clients set jurisdiction=$3 where firm_id=$1 and id=$2',[firmId,clientId,jurisdiction]);
  for(const scope of [['another-firm',clientId],[firmId,'another-client']])assert.equal((await pool.query(ELIGIBLE_LINES_SQL,[...scope,20,id])).rows.length,0);
  const before=calls;const result=await sweepLedgerAutoPost({firmId,clientId,transactionId:id,configSnapshot:{LEDGER_AUTO_POST:{stage:'auto'}}});
  assert.equal(result.posted,1,JSON.stringify(result));assert.equal(calls,before);assert.equal((await journal(id)).length,f.tax?3:2);
  assert.equal((await sweepLedgerAutoPost({firmId,clientId,transactionId:id,configSnapshot:{LEDGER_AUTO_POST:{stage:'auto'}}})).eligible,0);
 }
 // The same source fence used at the named journal boundary excludes document
 // corrections and FK-backed component inserts for autonomous singleton work.
 const lockedId='source-lock';await seed(fixtures[1],lockedId);
 const lockSource=(await pool.query("select payload from transactions where id='rent'")).rows[0].payload;
 const lockEvidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:lockedId});
 const lockPayload={...lockSource,ledger_journal_id:undefined,ledger_status:undefined,ai_suggestion:{...lockSource.ai_suggestion,transaction_id:lockedId,evidence_digest:codingEvidenceDigest(lockEvidence)}};
 await pool.query("update transactions set coding_state='applied',status='needs_review',payload=$2 where id=$1",[lockedId,lockPayload]);
 const holder=await pool.connect(),contender=await pool.connect();
 try{
  await holder.query('begin');await holder.query('select id from transactions where id=$1 for update',[lockedId]);
  await assertCurrentCodingEvidence({client:holder,firmId,clientId,transaction:{...lockPayload,id:lockedId},lock:true});
  for(const statement of [
   ["update documents set tax_amount=1 where id=$1",['doc-'+lockedId]],
   ["insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values('blocked-component',$1,$2,$3,2,'Late component',1,'{}')",[firmId,clientId,'doc-'+lockedId]]
  ]){
   await contender.query('begin');await contender.query("set local lock_timeout='40ms'");
   await assert.rejects(contender.query(...statement),{code:'55P03'});await contender.query('rollback');
  }
  assert.equal((await journal(lockedId)).length,0);
 }finally{await contender.query('rollback').catch(()=>{});await holder.query('rollback');contender.release();holder.release();}
 const lockedPosted=await sweepLedgerAutoPost({firmId,clientId,transactionId:lockedId,configSnapshot:{LEDGER_AUTO_POST:{stage:'auto'}}});
 assert.equal(lockedPosted.posted,1);
 // These resemble the representation but cannot establish equivalence. Rebind
 // their changed source before checking, so ordinary validation must refuse them.
 const negatives=[
  ['handle',async(id,p)=>{p.ai_suggestion.document_allocations[0].line_handle='line_2';}],
  ['account',async(id,p)=>{p.ai_suggestion.document_allocations[0].account='Office expenses';}],
  ['partial',async id=>{await pool.query('update transactions set money_out=500 where id=$1',[id]);}],
  ['currency',async id=>{await pool.query("update documents set currency='USD' where id=$1",['doc-'+id]);}],
  ['negative',async id=>{await pool.query('update document_lines set amount=-600 where id=$1',['line-'+id]);}],
  ['unfooted',async id=>{await pool.query('update document_lines set amount=599 where id=$1',['line-'+id]);}],
  ['missing-tax',async id=>{await pool.query('update documents set tax_amount=null where id=$1',['doc-'+id]);}],
  ['payroll',async(id,p)=>{p.ai_suggestion.proposed_account='Payroll';p.ai_suggestion.document_allocations[0].account='Payroll';}],
  ['loan',async(id,p)=>{p.ai_suggestion.proposed_account='Loan payable';p.ai_suggestion.document_allocations[0].account='Loan payable';}],
  ['family',async id=>{await pool.query("update documents set document_type='payment_confirmation' where id=$1",['doc-'+id]);}],
  ['components',async id=>{await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,2,'Second component',0,'{}')",['extra-'+id,firmId,clientId,'doc-'+id]);}],
  ['pending',async id=>{await pool.query("update documents set parse_status='processing' where id=$1",['doc-'+id]);}],
  ['multiple-sources',async id=>{await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'supplier_bill','doc-rent',600,.9,'suggested','fixture','{}')",['second-'+id,firmId,clientId,id]);}],
  ['stale',async()=>{}]
 ];
 for(const [label,mutate] of negatives){
  const id='negative-'+label;await seed(fixtures[1],id);
  const original=(await pool.query("select payload from transactions where id='rent'")).rows[0].payload;
  const payload={...original,ledger_journal_id:undefined,ledger_status:undefined,ai_suggestion:structuredClone(original.ai_suggestion)};
  payload.ai_suggestion.transaction_id=id;
  await mutate(id,payload);
  const evidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:id});
  payload.ai_suggestion.evidence_digest=label==='stale'?'obsolete':codingEvidenceDigest(evidence);
  await pool.query("update transactions set coding_state='applied',status='needs_review',payload=$2 where id=$1",[id,payload]);
  await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:id,dryRun:false,skipSnapshot:true}),error=>{
   assert.ok(['TRANSACTION_DOCUMENT_ALLOCATION_INVALID','TRANSACTION_CODING_EVIDENCE_STALE','TRANSACTION_DOCUMENT_AMOUNT_MISMATCH'].includes(error.code),label+':'+error.code);return true;
  });assert.equal((await journal(id)).length,0,label);
  if(label==='pending')await pool.query("update documents set parse_status='completed' where id=$1",['doc-'+id]);
 }
 // A near-miss singleton failure still has a bounded retry delay, never a hot loop.
 for(const negative of ['negative-handle','negative-partial']){
 await pool.query("update transactions set updated_at=now()-interval '10 minutes' where id=$1",[negative]);
 await pool.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'system','fixture','ledger.auto_post_refused','transaction',$3,$4)",[firmId,clientId,negative,{code:'TRANSACTION_DOCUMENT_ALLOCATION_INVALID'}]);
 assert.equal((await sweepLedgerAutoPost({firmId,clientId,transactionId:negative,configSnapshot:{LEDGER_AUTO_POST:{stage:'auto'}}})).eligible,0,negative);
 }
 const ordinary={id:'ordinary-multiple',account:'Office expenses',net:300,tax:76.5};fixtures.push(ordinary);await seed(ordinary);
 await pool.query('update document_lines set amount=150 where id=$1',['line-'+ordinary.id]);
 await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values('ordinary-second',$1,$2,$3,2,'Second same-account charge',150,'{}')",[firmId,clientId,'doc-'+ordinary.id]);
 await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
 const ordinaryRows=await journal(ordinary.id);assert.equal(ordinaryRows.length,3);
 assert.equal(ordinaryRows[0].payload.coding_representation,undefined,'valid ordinary model output is not rewritten');
 assert.equal((await pool.query('select payload from transactions where id=$1',[ordinary.id])).rows[0].payload.ai_suggestion.posting_requirement,'single_account');
 assert.equal((await pool.query('select count(*)::int n from client_evidence_requests where firm_id=$1 and client_id=$2',[firmId,clientId])).rows[0].n,0);
});
