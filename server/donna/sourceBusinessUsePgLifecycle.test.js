import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {extractUnified} from './unifiedExtractor.js';
import {normalizeSourceBusinessUse,codingSourceBusinessUseConflict} from './sourceBusinessUse.js';
import {__writeParsedDocumentExtractionWithClient} from './parseDocumentsDb.js';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests,postLedgerTransactionInDb,resolveClientEvidenceRequestInDb} from './firmDb.js';
import {batchSuggestTransactionCodingInDb} from './db/coding.js';
import {currentCodingEvidence,codingEvidenceDigest,recoverChangedCodingEvidenceInDb} from './db/codingEvidence.js';
import {recordRefusalViaDb} from './ledgerAutoPost.js';
import {runCodingAutoPostForTransaction} from './codingAutoPost.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {readJevCase,jevCasePrompt} from './jevPreview.js';
import {resolveCodingPolicy,codingPolicyReceipt} from './codingPolicy.js';

test('source use requires an explicit quote and never infers use from a merchant',()=>{
 assert.equal(normalizeSourceBusinessUse({classification:'personal'}).classification,'not_stated');
 assert.equal(codingSourceBusinessUseConflict({transaction:{money_out:52.1},suggestion:{proposed_account:'Motor expenses'},matchedDocument:{parse_summary:{warnings:['private_drive']}}}),null);
 assert.equal(normalizeSourceBusinessUse({classification:'mixed',source_quote:'Half personal',business_use_percent:50}).business_use_percent,50);
 const input={transaction:{money_out:52.1},suggestion:{proposed_account:'Owner drawings',tax_treatment:'ALV 25,5 %',coding_policy:{jurisdiction:'fi'}},matchedDocument:{parse_summary:{source_business_use:{classification:'personal',source_quote:'Private driving'}}}};
 assert.equal(codingSourceBusinessUseConflict(input).constraint,'personal_source_cannot_claim_input_tax');
 assert.equal(codingSourceBusinessUseConflict({...input,suggestion:{...input.suggestion,tax_treatment:'Ei ALV-käsittelyä'}}),null);
 assert.equal(codingSourceBusinessUseConflict({...input,suggestion:{proposed_account:'VAT control',coding_policy:{jurisdiction:'fi'}},taxRole:'alv_input_deductible'}).constraint,'personal_source_cannot_claim_input_tax');

});

test('real PG: explicit source-use fact survives extraction; actual coder and writer hold, owner correction is attributable, posted contradictions remain visible', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();const name=`source_use_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 globalThis.fetch=async()=>{throw new Error('Unexpected provider call in source-use fixture');};
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','source-use');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Synthetic company Oy','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash","alv_registration":{"status":"registered","registered_from":"2020-01-01"}}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic proof',trialId:'source-use',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);
 const quote='Private driving, 14 February — owner annotation';
 const recording=JSON.parse(await readFile(new URL('./fixtures/recordings/unified_extraction/screwfix-receipt.json',import.meta.url),'utf8'));
 const raw=JSON.parse(recording.body.content.find(x=>x.type==='text').text);
 Object.assign(raw,{source_business_use:{classification:'personal',source_quote:quote,business_use_percent:0},warnings:[],document_type:'receipt',lines:[{description:'Fuel',quantity:1,unit_price:52.1,amount:52.1,tax_rate:.255}]});
 Object.assign(raw.header,{counterparty_name:'Synthetic service station',own_name:null,currency:'EUR',document_date:'2025-02-14',total_amount:52.1,subtotal_amount:41.51,tax_amount:10.59,line_amounts_include_tax:true,shipping_amount:0,discount_amount:0,rounding_amount:0});
 const extracted=await extractUnified({base64:Buffer.from('%PDF fixture').toString('base64'),filename:'receipt.pdf',documentId:'receipt',documentType:'receipt',env:{ANTHROPIC_API_KEY:'fixture'},fetchImpl:async(_,init)=>{
  assert.match(JSON.parse(init.body).system,/SOURCE BUSINESS USE/);
  // The unified schema rides the structured-result tool (past the structured-output limits, 2026-11-10); the reply is its call.
  return {ok:true,status:200,json:async()=>({model:'fixture-extractor',stop_reason:'tool_use',content:[{type:'tool_use',id:'toolu_fixture',name:JSON.parse(init.body).tools[0].name,input:raw}],usage:{input_tokens:1,output_tokens:1}})};
 }});assert.equal(extracted.kind,'completed_header',JSON.stringify(extracted));
 const runId='00000000-0000-4000-8000-000000000001';
 for(const id of ['blocked','legacy']){
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'f','c','2025-02-14','Fuel purchase',0,52.1,'EUR','needs_review','{}')",[id]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,payload) values($1,'f','c',$1,'receipt','processing',$2,'{}')",['doc-'+id,runId]);
  const summary=id==='legacy'?{...extracted.summary,source_business_use:normalizeSourceBusinessUse(null)}:extracted.summary;
  await __writeParsedDocumentExtractionWithClient({client:pool,firmId:'f',documentId:'doc-'+id,parseRunId:runId,header:extracted.header,summary,lines:extracted.lines,documentType:'receipt'});
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values($1,'f','c',$2,'receipt',$3,'auto_matched',52.1,.9,'{}')",['match-'+id,id,'doc-'+id]);
 }
 const source=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'blocked',evidenceOnly:true});
 assert.equal(source.matchedDocument.parse_summary.source_business_use.source_quote,quote);assert.ok(JSON.stringify(jevCasePrompt(source.caseEvidence)).includes(quote));
 let ownerCorrection=false;
 globalThis.fetch=async(endpoint,init)=>{
  const request=JSON.parse(init.body);
  if(String(endpoint).includes('openai.com'))return {ok:true,status:200,json:async()=>({output_text:JSON.stringify({proposed_account:'Motor expenses',tax_treatment:'ALV 25,5 %',confidence:'high',evidence_required:false,posting_requirement:'single_account',source_business_use_resolution:ownerCorrection?'owner_corrected_annotation':'source_annotation_applies'})})};
  assert.match(String(endpoint),/api\.typesafe\.ai/);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria),choice=key==='decision'?'resolved':key==='materiality'?'low':key==='source_business_use_resolution'?(ownerCorrection?'owner_corrected_annotation':'source_annotation_applies'):entries.find(([,v])=>v==='Motor expenses'||v==='ALV 25,5 %')?.[0]||entries[0][0];
   return [key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.95:.05/(entries.length-1)]))}];
  }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:2,autoApply:true});
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 assert.equal((await tx('blocked')).coding_state,'applied');
 assert.equal((await tx('blocked')).payload.ai_suggestion.posting_requirement,'single_account');
 assert.equal((await tx('blocked')).payload.ledger_post_refusal.code,'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT');
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='blocked'")).rows[0].n,0,
  'a contradictory resolved Jev decision is refused, not converted into a redundant owner question');
 assert.equal((await tx('legacy')).coding_state,'posted');
 // Bypass the sanitizer with a prior unsafe accepted verdict: final writer still refuses.
 const unsafe={...(await tx('blocked')).payload.ai_suggestion,posting_requirement:'single_account',evidence_required:false};
 await pool.query("update transactions set coding_state='applied',payload=payload || $1::jsonb where id='blocked'",[{ai_suggestion_status:'auto_applied',ai_suggestion:unsafe}]);
 let refusal;try{await postLedgerTransactionInDb({firmId:'f',clientId:'c',transactionId:'blocked',dryRun:false,skipSnapshot:true});}catch(error){refusal=error;}
 assert.equal(refusal?.code,'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT');
 // A changed summary account cannot conceal a retained private input deduction.
 await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion}', $1::jsonb) where id='blocked'",[{...unsafe,proposed_account:'Owner drawings'}]);
 await assert.rejects(postLedgerTransactionInDb({firmId:'f',clientId:'c',transactionId:'blocked',dryRun:false,skipSnapshot:true}),{code:'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT'});
 await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion}', $1::jsonb) where id='blocked'",[unsafe]);

 await recordRefusalViaDb({firmId:'f',clientId:'c',transactionId:'blocked',error:refusal});
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('blocked')).payload.ai_suggestion,undefined,'the current coder must reconsider its refused decision');
 assert.equal((await tx('blocked')).payload.posting_recovery.review.previous_refusal.code,'TRANSACTION_SOURCE_BUSINESS_USE_CONFLICT');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='blocked'")).rows[0].n,0);
 // Historical strong-model verdicts retain the established source-use owner
 // correction path. This is a distinct seeded legacy receipt, not authority
 // fabricated from the refused Jev decision above.
 const {jev_decision,jev_handoff,decision_engine,...legacySuggestion}=unsafe;
 await pool.query("update transactions set coding_state='applied',payload=payload || $1::jsonb where id='blocked'",[{ai_suggestion_status:'auto_applied',ai_suggestion:{...legacySuggestion,source:'openai',model:'fixture-strong'}}]);
 await recordRefusalViaDb({firmId:'f',clientId:'c',transactionId:'blocked',error:refusal});
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 const sweep=await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'blocked'});assert.equal(sweep.owner_asked,1,JSON.stringify(sweep));
 const ask=(await pool.query("select * from client_evidence_requests where transaction_id='blocked' and status='draft'")).rows[0];assert.ok(ask.question.includes(quote));assert.doesNotMatch(ask.question,/upload|send.*receipt/i);
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='blocked'")).rows[0].n,0);
 ownerCorrection=true;
 const reply=await resolveClientEvidenceRequestInDb({firmId:'f',evidenceRequestId:ask.id,reply:'I wrote the annotation on the wrong receipt. This entire fuel purchase was for the company delivery van and wholly business use.',actorId:'named-owner',actorType:'client'});
 assert.equal((await tx('blocked')).coding_state,'posted',JSON.stringify(reply));
 assert.equal((await pool.query('select status from client_evidence_requests where id=$1',[ask.id])).rows[0].status,'resolved');
 const original=(await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='legacy' order by l.line_no")).rows;
 await pool.query("update documents set parse_summary=jsonb_set(parse_summary,'{source_business_use}',$1) where id='doc-legacy'",[extracted.summary.source_business_use]);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('legacy')).payload.coding_correction_required.reason,'posted_source_business_use_conflict');
 assert.equal((await tx('blocked')).payload.coding_correction_required,undefined,'current attributable correction answers the annotation');
 assert.deepEqual((await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='legacy' order by l.line_no")).rows,original);
 assert.equal((await pool.query("select status from transaction_review_queue where item_id='legacy' and reason='posted_evidence_changed'")).rows[0].status,'open');
 const changedFact={...extracted.summary.source_business_use,source_quote:'A different explicit private-use annotation'};
 await pool.query("update documents set parse_summary=jsonb_set(parse_summary,'{source_business_use}',$1) where id='doc-blocked'",[changedFact]);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('blocked')).payload.coding_correction_required.reason,'posted_source_business_use_conflict','an earlier reply cannot override a different source annotation');
 // The final writer independently fences an unsupported cash-sale verdict.
 const policy=resolveCodingPolicy({jurisdiction:'fi',businessDate:'2025-02-14',accountingSystem:'none'});
 await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('cash','f','c','2025-02-14','Cash deposit',455,0,'EUR','needs_review','applied',$1)",[{ai_suggestion_status:'auto_applied',ai_suggestion:{proposed_account:'Sales',tax_treatment:'ALV 25,5 %',posting_requirement:'single_account',evidence_digest:codingEvidenceDigest(null),coding_policy:codingPolicyReceipt(policy)}}]);
 await assert.rejects(postLedgerTransactionInDb({firmId:'f',clientId:'c',transactionId:'cash',dryRun:false,skipSnapshot:true}),{code:'TRANSACTION_REVENUE_SOURCE_REQUIRED'});
 await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,currency,total_amount,tax_amount,document_date,parse_summary,payload) values('sale','f','c','sales-invoice.pdf','sales_invoice','completed','EUR',455,92.45,'2025-02-14','{}','{}')");
 await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values('cash-sale','f','c','cash','sales_invoice','sale','auto_matched',455,.95,'{}')");
 const salesSource=await currentCodingEvidence({client:pool,firmId:'f',clientId:'c',transactionId:'cash'});
 await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,evidence_digest}',to_jsonb($1::text)) where id='cash'",[codingEvidenceDigest(salesSource)]);
 await postLedgerTransactionInDb({firmId:'f',clientId:'c',transactionId:'cash',dryRun:false,skipSnapshot:true});
 const cashJournal=(await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='cash' order by l.line_no")).rows;
 assert.ok(cashJournal.length>0);
 // A subsequently rejected sales relationship is reconsidered through the
 // existing clock; journal rows never become a repair script's write target.
 await pool.query("update reconciliation_matches set status='rejected' where id='cash-sale'");
 await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.equal((await tx('cash')).payload.coding_correction_required.reason,'posted_revenue_source_required');
 assert.equal((await tx('cash')).payload.coding_correction_required.status,'pending');
 assert.deepEqual((await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='cash' order by l.line_no")).rows,cashJournal);
 assert.equal((await pool.query("select status from transaction_review_queue where item_id='cash' and reason='posted_evidence_changed'")).rows[0].status,'open');
});
