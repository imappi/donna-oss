import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';
import {recoverChangedCodingEvidenceInDb,hasPendingCodingReconsiderationWithClient} from './db/codingEvidence.js';
import {CODING_RECONSIDERATION_CONTRACT} from './codingPolicyRecovery.js';
import {__attachReplyContextToBatchPool} from './db/coding.js';
import {readJevCase,codingCaseRevision,jevCasePrompt} from './jevPreview.js';
import {evaluateCodingAutoPost} from './codingAutoPost.js';
import {recoverJevMaterialExceptionsInDb} from './jevMaterialException.js';
import {decideJevReconciliation} from './jevRuntimeDecision.js';
import {callJevTyped} from './jevProvider.js';

// The first-line lane decides only on a host with its provider configured
// (firstLineLane.js, 2026-11-10); these cases are about the lane deciding.
process.env.TYPESAFE_API_KEY ||= 'fixture-first-line-key';
process.env.TYPESAFE_MODEL ||= 'fixture-first-line';

test('US evidence wakes a pre-coding ask once, preserves the question, and exposes complete source context', {skip:!process.env.DONNA_PG_TEST_URL}, async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`jev_recovery_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()});const closed=[];
 pool.on('connect',c=>closed.push(new Promise(resolve=>c.once('end',resolve))));__setFirmDbPoolForTests(pool);
 t.after(async()=>{__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);
 for(const f of (await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Test firm','jev-recovery');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','US','{}');
 insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,coding_state,payload)
 values('debit','f','c','2025-02-14','Purchase',19.90,0,'USD','needs_review','asked','{}'),
 ('refund','f','c','2025-02-17','Purchase refund',0,19.90,'USD','needs_review','proposed','{}');
 insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,question,evidence_type)
 values('ask','f','c','debit','open','Was this wholly for business?','business_purpose');
 insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency,parse_summary)
 values('receipt','f','c','receipt.pdf','receipt','completed','2025-02-14',19.90,'USD','{"annotation":"Private use noted on source","tax_groups":[{"rate":0.14}]}');
 insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
 values('source-line','f','c','receipt',1,'Source component',19.90,0.14,'{}');
 insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence)
 values('match','f','c','debit','receipt','receipt','auto_matched',19.90,1);`);
 const before=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'debit',evidenceOnly:true});
 assert.equal(before.caseEvidence.transactions.find(t=>t.id==='refund').money_in,'19.90');
 assert.match(JSON.stringify(jevCasePrompt(before.caseEvidence)),/Private use noted on source/);
 assert.equal(before.matchedDocument.lines[0].tax_rate,0.14);
 assert.equal(before.caseEvidence.owner_replies[0].provenance,'unanswered_question');
 const originalRevision=codingCaseRevision(before.caseEvidence);
 await pool.query(`update client_evidence_requests set response_payload='{"resolution_note":"Earlier machine premise retracted","retracted":true}' where id='ask'`);
 const retracted=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'debit',evidenceOnly:true});
 assert.equal(retracted.caseEvidence.owner_replies[0].provenance,'unanswered_question');
 assert.equal(codingCaseRevision(retracted.caseEvidence),originalRevision,'machine resolution is not fresh owner evidence');
 const recovered=await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.deepEqual(recovered.map(r=>r.transaction_id),['debit']);
 const row=(await pool.query("select payload from transactions where id='debit'")).rows[0];
 assert.equal(row.payload.coding_evidence_reconsideration.digest,codingCaseRevision(before.caseEvidence));
 assert.equal((await pool.query("select status from client_evidence_requests where id='ask'")).rows[0].status,'open','arrival alone never resolves a use fact');
 const attached=await __attachReplyContextToBatchPool({client:pool,firmId:'f',clientId:'c',transactions:[{id:'debit',...row.payload}]});
 assert.equal(attached.pool.length,1,'the same coder can reconsider the case while its older ask exists');
 assert.deepEqual(await recoverChangedCodingEvidenceInDb({firmId:'f'}),[],'recovery housekeeping cannot change its own evidence revision');
 await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage) values('jev','f','c','JEV_RECONCILIATION','auto');
 insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,document_date,total_amount,tax_amount,currency,parse_summary)
 values('totals','f','c','service.pdf','receipt','completed','00000000-0000-4000-8000-000000000001','2025-02-14',39.06,5,'USD',
 '{"subtotal_amount":30,"total_amount":39.06,"tax_amount":5,"line_amounts_include_tax":false,"warnings":["amount_mismatch"],"jev_exception":{"selected":"needs_reasoning","execution":"reasoning_pending"}}');
 insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload)
 values('totals-main','f','c','totals',1,'Service',30,'{}'),('totals-fee','f','c','totals',2,'Fee',4.06,'{}');`);
 const material=await recoverJevMaterialExceptionsInDb({firmId:'f',decideFn:()=>{throw new Error('Arithmetic must not spend a model call');}});
 assert.equal(material[0].outcome,'resolved_totals');
 const repaired=(await pool.query("select parse_summary from documents where id='totals'")).rows[0].parse_summary;
 assert.equal(repaired.totals_validation.matches,true);
 assert.equal(repaired.jev_exception.execution,'resolved');
 await pool.query(`update client_evidence_requests set status='replied',response_payload='{"reply":"Half of this purchase was personal.","reply_processing":{"actor_id":"owner-7","actor_type":"client"}}' where id='ask'`);
 const answered=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'debit',evidenceOnly:true});
 assert.equal(answered.caseEvidence.owner_replies[0].provenance,'attributable_owner_reply');
 assert.notEqual(codingCaseRevision(answered.caseEvidence),originalRevision);
 assert.match(JSON.stringify(jevCasePrompt(answered.caseEvidence)),/Half of this purchase was personal/);
 assert.deepEqual(await recoverJevMaterialExceptionsInDb({firmId:'f'}),[],'the clock leaves settled material alone');
 // Exercise the persisted reader -> automatic matching request, not only a
 // preassembled packet. Every bank candidate must survive the wire encoding.
 await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
 select 'extra-'||n,'f','c','2025-02-14','Complete source bank row '||n||repeat(' Exact retained source description.',100),19.90,0,'USD','needs_review','{}'::jsonb from generate_series(1,20) n;
 insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
 values('matching-source','f','c','unmatched.pdf','receipt','completed','2025-02-14',19.90,'USD');`);
 const decision=await decideJevReconciliation({client:pool,firmId:'f',clientId:'c',documentId:'matching-source',model:'fixture-model',provider:async request=>{
  return callJevTyped(request,{apiKey:'fixture-key',fetchImpl:async (_url,init)=>{
   const wire=JSON.parse(init.body);
   assert.equal(typeof wire.state,'string','the production database reader reaches compact JSON text at the transport');
   const state=JSON.parse(wire.state);
   assert.deepEqual(state,JSON.parse(JSON.stringify(request.state)));
   assert.equal(state.case_evidence.transactions.length,22);
   assert.match(wire.state,/Half of this purchase was personal/);
   return new Response(JSON.stringify({model:'fixture-model',usage:{input_tokens:1,output_tokens:1},answers:{plan:{type:'choice',choice:'needs_more_work',confidence:1,probabilities:Object.fromEntries(Object.keys(wire.questions.plan.criteria).map(key=>[key,key==='needs_more_work'?1:0]))}}}));
  }});
 }});
 assert.equal(decision.candidates.length,22);
 assert.equal(decision.consumed_evidence.owner_replies[0].response_payload.reply,'Half of this purchase was personal.');
});

test('a statutory descriptor is not a filing and a company conflict precedes every posting branch',()=>{
 const suggestion={proposed_account:'Income tax payable',confidence:'high',evidence_required:false};
 assert.notEqual(evaluateCodingAutoPost({suggestion,bankLineDisposition:'statutory_payment',reconciliationStatus:'explained'}).action,'auto_post');
 assert.equal(evaluateCodingAutoPost({suggestion,hasDocMatch:true,statutorySettlement:true,crossEntity:{own_side:'Another company'}}).reason,'cross_entity_relation');
});

// Kampaamo statement-only rows (2026-09-21): nine applied codings rested on
// TRANSACTION_ALV_TREATMENT_UNRESOLVED with no source to re-read. The existing
// coding clock owns them; a row with a settled source stays with the
// source-recheck recovery, and the attempt bound still holds.
test('FI statement-only ledger refusal re-enters the coding clock, bounded; a sourced refusal keeps its recheck owner', {skip:!process.env.DONNA_PG_TEST_URL}, async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`jev_fi_refusal_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()});const closed=[];
 pool.on('connect',c=>closed.push(new Promise(resolve=>c.once('end',resolve))));__setFirmDbPoolForTests(pool);
 t.after(async()=>{__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);
 for(const f of (await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 const stranded={ai_suggestion_status:'auto_applied',ai_suggestion:{source:'jev',decision_engine:'jev',model:'m',proposed_account:'Utilities',tax_treatment:'ALV-tarkistus',
   posting_requirement:'single_account',evidence_required:false,confidence:'low',jev_decision:{terminal:'resolved',selected:'resolved',model:'m',probability:0.48}},
   ledger_post_refusal:{code:'TRANSACTION_ALV_TREATMENT_UNRESOLVED',message:'The coding says ALV-tarkistus, which maps to no ALV code.',refused_at:'2025-02-07T00:00:00Z'}};
 await pool.query(`insert into firms(id,name,slug) values('f','Test firm','fi-refusal');
 insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values('c','f','Kampaamo Oy','FI','fi-oy','{"jurisdiction":"fi","accounting_system":"none"}');
 insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency)
 values('receipt','f','c','hesburger.pdf','receipt','completed','2025-02-06',12.90,1.59,'EUR');`);
 await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,coding_state,account_code,payload)
 values('stranded','f','c','2025-02-05','TAMPERE ENERGIA OY SÄHKÖ 1/2025',359.42,0,'EUR','needs_review','applied','Utilities',$1),
 ('sourced','f','c','2025-02-06','HESBURGER TAMPERE',12.90,0,'EUR','needs_review','applied','Bank fees',$1)`,[JSON.stringify(stranded)]);
 await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence)
 values('match','f','c','sourced','receipt','receipt','auto_matched',12.90,1)`);
 const first=await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.deepEqual(first.map(r=>r.transaction_id),['stranded']);
 const reopened=(await pool.query("select coding_state,payload from transactions where id='stranded'")).rows[0];
 assert.equal(reopened.coding_state,'proposed');
 assert.equal(reopened.payload.ai_suggestion,undefined);
 assert.equal(reopened.payload.ledger_post_refusal,undefined);
 assert.equal(reopened.payload.coding_evidence_reconsideration.attempts,1);
 assert.equal(reopened.payload.coding_evidence_reconsideration.contract,CODING_RECONSIDERATION_CONTRACT,'the receipt names the contract its attempts count under');
 const sourced=(await pool.query("select coding_state,payload from transactions where id='sourced'")).rows[0];
 assert.equal(sourced.coding_state,'applied');
 assert.equal(sourced.payload.ledger_post_refusal.code,'TRANSACTION_ALV_TREATMENT_UNRESOLVED','a settled source keeps the source-recheck owner');
 // The same refused result again: the bound holds, the last refusal stays visible.
 for(let attempt=2;attempt<=3;attempt++){
  await pool.query("update transactions set coding_state='applied',payload=payload||$1::jsonb where id='stranded'",[JSON.stringify(stranded)]);
  assert.deepEqual((await recoverChangedCodingEvidenceInDb({firmId:'f'})).map(r=>r.transaction_id),['stranded']);
  assert.equal((await pool.query("select payload->'coding_evidence_reconsideration'->>'attempts' as n from transactions where id='stranded'")).rows[0].n,String(attempt));
 }
 await pool.query("update transactions set coding_state='applied',payload=payload||$1::jsonb where id='stranded'",[JSON.stringify(stranded)]);
 assert.deepEqual(await recoverChangedCodingEvidenceInDb({firmId:'f'}),[],'exhausted reconsideration leaves the refusal visible instead of looping');
 const exhausted=(await pool.query("select coding_state,payload from transactions where id='stranded'")).rows[0];
 assert.equal(exhausted.coding_state,'applied');
 assert.equal(exhausted.payload.ledger_post_refusal.code,'TRANSACTION_ALV_TREATMENT_UNRESOLVED');
 assert.equal(await hasPendingCodingReconsiderationWithClient(pool,'f','c','stranded'),false,'the display agrees the bound is spent');
 // Kampaamo (2026-09-21, production): ten rows spent this bound under the
 // coder contract that still applied the unsure marker. A receipt written
 // under an earlier contract counts no attempts, so the same clock re-admits
 // the row once — no rebuild, no re-upload — and the bound holds again.
 const legacy={...exhausted.payload.coding_evidence_reconsideration}; delete legacy.contract;
 await pool.query("update transactions set payload=payload||jsonb_build_object('coding_evidence_reconsideration',$1::jsonb) where id='stranded'",[JSON.stringify(legacy)]);
 assert.equal(await hasPendingCodingReconsiderationWithClient(pool,'f','c','stranded'),true,'a pre-contract receipt is clock-owned again');
 assert.deepEqual((await recoverChangedCodingEvidenceInDb({firmId:'f'})).map(r=>r.transaction_id),['stranded'],'the existing clock heals the exhausted row');
 const healed=(await pool.query("select coding_state,payload from transactions where id='stranded'")).rows[0];
 assert.equal(healed.coding_state,'proposed');
 assert.equal(healed.payload.ai_suggestion,undefined);
 assert.equal(healed.payload.coding_evidence_reconsideration.attempts,1);
 assert.equal(healed.payload.coding_evidence_reconsideration.contract,CODING_RECONSIDERATION_CONTRACT);
 assert.equal(healed.payload.coding_evidence_reconsideration.digest,legacy.digest,'the case revision itself is unchanged');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals")).rows[0].n,0);
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests")).rows[0].n,0,'the clock re-drives the coder; it mints no question itself');
});
