import test from 'node:test';
import assert from 'node:assert/strict';
import { sweepCodingAutoPost } from './codingAutoPost.js';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {createHash} from 'node:crypto';
import {canonicalFactSubject} from './firmFacts.js';
import {buildJevCodingRequest,decideJevCoding} from './jevCoding.js';
import {documentSourceComponents} from './documentAllocationComponents.js';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests} from './firmDb.js';
import {batchSuggestTransactionCodingInDb,suggestTransactionCodingInDb} from './db/coding.js';
import {runCodingAutoPostForTransaction} from './codingAutoPost.js';
import {hasPendingCodingReconsiderationWithClient,recoverChangedCodingEvidenceInDb} from './db/codingEvidence.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {readJevCase,codingCaseRevision} from './jevPreview.js';
import {CODING_RECONSIDERATION_CONTRACT} from './codingPolicyRecovery.js';

const doc={document_id:'source',document_type:'supplier_bill',match_status:'auto_matched',total_amount:17.5,tax_amount:1.59,
 parse_summary:{line_amounts_include_tax:true},lines:[{id:'source-line',description:'Transport service',amount:17.5,tax_rate:10}]};
const refused=document=>({code:'TRANSACTION_ALV_CODING_SOURCE_CONFLICT',details:{source_validation:documentSourceComponents(document),selected_tax_treatment:'ALV_14_INPUT',recovery:'recode_current_evidence'}});
const inputFor=document=>({client:{jurisdiction:'fi'},transaction:{money_out:document.total_amount,matched_document:document,posting_recovery:{previous_refusal:refused(document)}}});
const taxes=['ALV 14 %','ALV 10 %','Ei ALV-käsittelyä'];
const build=(input,accounts=['Travel'])=>buildJevCodingRequest({input,accountOptions:accounts,taxOptions:taxes,instructions:'Use the source and existing policy.'});

test('a settled source accepted by the statutory writer cannot be requested again',()=>{
 for(const match_status of ['auto_matched','confirmed'])assert.equal(build({transaction:{matched_document:{...doc,match_status}}}).request.questions.decision.criteria.ask_statutory_source,undefined);
 for(const matched_document of [null,{...doc,match_status:'suggested'},{...doc,document_type:'bank_statement'}]){
  assert.ok(build({transaction:{matched_document}}).request.questions.decision.criteria.ask_statutory_source);
 }
});

test('a quoted use fact removes only already answered owner questions',()=>{
 for(const [classification,business_use_percent] of [['personal',0],['business',100],['mixed',40]]){
  const input={transaction:{matched_document:{parse_summary:{source_business_use:{classification,business_use_percent,source_quote:'Explicit source use'}}}}};
  const criteria=build(input).request.questions.decision.criteria;
  assert.equal(criteria.ask_business_use,undefined);
  assert.equal(Boolean(criteria.ask_business_purpose),classification!=='personal');
  assert.ok(criteria.ask_recipient);assert.ok(criteria.reasoning_judgment);
 }
 for(const fact of [{classification:'personal'}, {classification:'mixed',source_quote:'Mixed use',business_use_percent:null}]){
  assert.ok(build({transaction:{matched_document:{parse_summary:{source_business_use:fact}}}}).request.questions.decision.criteria.ask_business_use);
 }
});

test('a missing-source VAT refusal excludes deduction until a settled source exists',()=>{
 const input={client:{jurisdiction:'fi'},transaction:{money_out:6,posting_recovery:{previous_refusal:{code:'TRANSACTION_ALV_EVIDENCE_REQUIRED'}}}};
 const constrained=build(input,['Bank fees']);
 assert.deepEqual(constrained.componentTaxes,['Ei ALV-käsittelyä']);
 assert.equal(constrained.executionConstraints[0].scope,'missing_input_tax_evidence');
 assert.ok(constrained.request.questions.decision.criteria.reasoning_judgment);
 for(const changed of [{...input,transaction:{money_out:6}}, {...input,transaction:{...input.transaction,matched_document:doc}}]){
  assert.deepEqual(build(changed,['Bank fees']).componentTaxes,taxes);
 }
});

test('writer refusal excludes only identical-source whole-document tax actions and preserves every other decision',()=>{
 const input=inputFor(doc),built=build(input);
 assert.deepEqual(built.executionConstraint.excluded_tax_treatments,['ALV 14 %']);
 assert.ok(!Object.values(built.plans).some(p=>p.tax_treatment==='ALV 14 %'));
 assert.ok(Object.values(built.plans).some(p=>p.tax_treatment==='ALV 10 %'));
 assert.deepEqual(built.taxOptions,taxes);
 for(const action of ['ask_business_use','reasoning_judgment','reasoning_vocabulary'])assert.ok(built.request.questions.decision.criteria[action]);
 assert.equal(built.request.questions.decision.criteria.ask_statutory_source,undefined,'the named writer already accepts this held statutory source');
 assert.deepEqual(built.request.state.execution_constraints,[built.executionConstraint]);
 for(const changed of [
  {...input,transaction:{...input.transaction,matched_document:{...doc,tax_amount:2.15,lines:[{...doc.lines[0],tax_rate:14}]}}},
  {...input,transaction:{...input.transaction,posting_recovery:{previous_refusal:{...refused(doc),code:'TRANSACTION_ALV_EVIDENCE_REQUIRED'}}}},
  {...input,transaction:{...input.transaction,posting_recovery:{previous_refusal:{...refused(doc),details:{...refused(doc).details,line_handle:'line_1'}}}}},
  {...input,transaction:{...input.transaction,money_out:10}},
  {...input,client:{jurisdiction:'us'}}]){
  const unpruned=build(changed);assert.equal(unpruned.executionConstraint,null);assert.ok(Object.values(unpruned.plans).some(p=>p.tax_treatment==='ALV 14 %'));
 }
 const split=build(input,Array.from({length:130},(_,i)=>`Account${i}`));
 assert.equal(split.choiceMode,'account_tax_components');
 assert.deepEqual(Object.values(split.request.questions.tax.criteria),['ALV 10 %','Ei ALV-käsittelyä']);
 assert.equal(split.request.questions.tax.criteria.tax_1,'ALV 10 %','stable indices still decode against original tax vocabulary');
});

test('whole-document refusal leaves component-allocation tax choices intact and receipts the constraint',async()=>{
 const source={...doc,total_amount:22,tax_amount:2,lines:[{id:'a',description:'First',amount:11,tax_rate:10},{id:'b',description:'Second',amount:11,tax_rate:10}]};
 const input=inputFor(source);let calls=0;
 const result=await decideJevCoding({input,transaction:input.transaction,accountOptions:['Travel','Suspense'],taxOptions:taxes,instructions:'Use source facts.',suspenseAccountName:'Suspense',defaultTaxTreatment:'Ei ALV-käsittelyä',provider:async request=>{
  calls++;if(calls===2)for(const[k,q]of Object.entries(request.questions))if(k.endsWith('_tax'))assert.deepEqual(Object.values(q.criteria),taxes);
  return {model:'fixture-provider',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const choice=key==='decision'?'document_allocation':key==='materiality'?'low':key.endsWith('_tax')?'tax_1':Object.keys(q.criteria)[0];
   return[key,{choice,probability:.9,probabilities:{[choice]:.9}}];
  }))};
 }});
 assert.equal(calls,2);assert.equal(result.suggestion.document_allocations.length,2);
 assert.equal(result.receipt.execution_constraints[0].scope,'whole_document_single_account');
});

test('real PG: named writer refusal constrains next Jev menu, retains the failure and posts source amounts; apply still rejects changed evidence', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`jev_executability_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 globalThis.fetch=async()=>{throw new Error('Unexpected provider call');};
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','jev-executability');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash","alv_registration":{"status":"registered","registered_from":"2020-01-01"}}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);
 const seed=async id=>{
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'f','c','2025-02-26','Transport service',0,17.5,'EUR','needs_review','{}')",[id]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary) values($1,'f','c',$1||'.pdf','supplier_bill','completed','2025-02-26','EUR',17.5,1.59,'{\"line_amounts_include_tax\":true}')",[id+'-source']);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload) values($1,'f','c',$2,1,'Transport service',17.5,10,'{}')",[id+'-line',id+'-source']);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values($1,'f','c',$2,'supplier_bill',$3,'auto_matched',17.5,.99,'{}')",[id+'-match',id,id+'-source']);
 };
 await seed('ride');
 // A configured flag without provider authority must persist a repair receipt,
 // not disappear into a cron error or invoke an unapproved fallback provider.
 const refusedPolicy=await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal(refusedPolicy.transaction_ai_batch.summaries[0].policy_error.code,'coding_policy_unavailable');
 const failure=(await pool.query("select metadata from audit_events where resource_id='ride' and action='transaction.coding.policy_failed' order by id desc limit 1")).rows[0];
 assert.equal(failure.metadata.reason_detail,'jev_experiment_not_authorized');
 assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:'executability',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 let phase='initial',seenConstraint=false;
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);const request=JSON.parse(init.body);
  const constrained=Boolean(request.state.execution_constraints?.length);
  if(phase==='reconsider'){assert.equal(constrained,true);seenConstraint=true;assert.ok(!Object.values(request.questions.tax?.criteria||request.questions.decision.criteria).some(value=>value==='ALV 14 %'||value.includes('tax treatment ALV 14 %;')));}
  const treatment=phase==='initial'?'ALV 14 %':'ALV 10 %';
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria),choice=key==='materiality'?'low':key==='decision'&&q.criteria.resolved?'resolved':entries.find(([,label])=>label.includes(`to Travel, tax treatment ${treatment};`))?.[0]||entries.find(([,label])=>label==='Travel'||label===treatment)?.[0]||entries[0][0];
   return[key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.95:.05/(entries.length-1)]))}];
  }));
  if(phase==='race')await pool.query("update document_lines set description='Changed source during model solve' where id='race-line'");
  return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 const initial=(await tx('ride')).payload.ledger_post_refusal;
 assert.equal(initial.code,'TRANSACTION_ALV_CODING_SOURCE_CONFLICT');assert.equal(initial.details.selected_tax_treatment,'ALV_14_INPUT');
 assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0);
 const auditBefore=(await pool.query("select * from audit_events where action='ledger.auto_post_refused' and resource_id='ride' order by id")).rows;
 assert.ok(auditBefore.length>0);
 assert.equal(await hasPendingCodingReconsiderationWithClient(pool,'f','c','ride'),true);
 const beforeCap = (await tx('ride')).payload;
 const cappedCase = await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'ride',evidenceOnly:true});
 await pool.query("update transactions set payload=payload || $1::jsonb where id='ride'",[JSON.stringify({coding_evidence_reconsideration:{digest:codingCaseRevision(cappedCase.caseEvidence),contract:CODING_RECONSIDERATION_CONTRACT,attempts:3}})]);
 assert.equal(await hasPendingCodingReconsiderationWithClient(pool,'f','c','ride'),false,'exhausted retries cannot claim processing');
 assert.deepEqual(await recoverChangedCodingEvidenceInDb({firmId:'f'}),[],'worker shares the same cap');
 await pool.query("update transactions set payload=$1 where id='ride'",[beforeCap]);
 await recoverChangedCodingEvidenceInDb({firmId:'f'});phase='reconsider';
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 // Frozen replay 2026-09-21 (VR, row 25): the reconsidered decision took the
 // printed 10 % because the refused 14 % was excluded. On a 2025 line 10 % is a
 // historical rate; with no timing basis it is the document_discrepancy
 // question against the held ticket, never the posting this proof once pinned.
 assert.equal(seenConstraint,true);const heldRide=await tx('ride');assert.equal(heldRide.coding_state,'proposed');
 assert.equal(heldRide.payload.ai_suggestion.jev_decision.execution_constraints[0].refused_tax_code,'ALV_14_INPUT');
 assert.equal(heldRide.payload.ai_suggestion.tax_treatment,'ALV 10 %');
 assert.equal(heldRide.payload.ai_suggestion.posting_requirement,'document_discrepancy');
 assert.deepEqual(heldRide.payload.ai_suggestion.historical_rate_guard.treatments,['ALV 10 %']);
 assert.equal(heldRide.payload.ai_suggestion.evidence_required,true);
 assert.deepEqual((await pool.query("select * from audit_events where action='ledger.auto_post_refused' and resource_id='ride' order by id")).rows,auditBefore);
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='ride'")).rows[0].n,0);
 await sweepCodingAutoPost({firmId:'f',clientId:'c'});
 const rideAsks=(await pool.query("select evidence_type,status,question,send_count from client_evidence_requests where transaction_id='ride'")).rows;
 assert.equal(rideAsks.length,1);assert.equal(rideAsks[0].evidence_type,'document_discrepancy');assert.equal(rideAsks[0].status,'draft');assert.equal(rideAsks[0].send_count,0);
 assert.match(rideAsks[0].question,/ride-source\.pdf/);
 assert.equal((await tx('ride')).coding_state,'asked');
 // The drafted question joins the ride line's case evidence, so the recovery
 // clock keeps it re-codable; the later single-line sections need the pool.
 await pool.query("delete from client_evidence_requests where transaction_id='ride'");await pool.query("delete from transactions where id='ride'");
 await seed('race');phase='race';await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='race'")).rows[0].n,0);
 assert.equal((await tx('race')).payload.ai_suggestion,undefined,'changed source prevents stale decision persistence');
 // An unchanged bank-only VAT refusal must be discovered too, rather than
 // waiting forever for a new file. Drive the actual batch and ledger writer.
 await pool.query("delete from transactions where id='race'");
 await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('bank-fee','f','c','2025-02-28','Bank service charge',0,6,'EUR','needs_review','{}')");
 let missingSourceRetry=false;
 globalThis.fetch=async(_endpoint,init)=>{
  const request=JSON.parse(init.body),state=typeof request.state==='string'?JSON.parse(request.state):request.state;
  const treatment=missingSourceRetry?'Ei ALV-käsittelyä':'ALV 25,5 %';
  if(missingSourceRetry)assert.ok(state.execution_constraints.some(c=>c.scope==='missing_input_tax_evidence'));
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria);
   const choice=key==='materiality'?'low':key==='decision'&&q.criteria.resolved?'resolved':entries.find(([,v])=>v.includes(`to Bank fees, tax treatment ${treatment};`))?.[0]
     ||entries.find(([,v])=>v==='Bank fees'||v===treatment)?.[0]||entries[0][0];
   return[key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.95:.05/(entries.length-1)]))}];
  }));
  return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}));
 };
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await tx('bank-fee')).payload.ledger_post_refusal.code,'TRANSACTION_ALV_EVIDENCE_REQUIRED');
 assert.equal((await tx('bank-fee')).coding_state,'applied');
 assert.ok((await recoverChangedCodingEvidenceInDb({firmId:'f'})).some(r=>r.transaction_id==='bank-fee'));
 missingSourceRetry=true;
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 assert.equal((await tx('bank-fee')).coding_state,'posted');
 const feeLines=(await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='bank-fee'")).rows;
 assert.equal(feeLines.find(l=>l.account_name==='Bank fees').debit,'6.00');
 assert.equal(feeLines.length,2,'no unsupported tax leg or extra journal component');
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='bank-fee' and status in ('draft','open')")).rows[0].n,0);
 await seed('held-statutory');
 const held=await readJevCase({client:pool,firmId:'f',clientId:'c',transactionId:'held-statutory',evidenceOnly:true});
 await pool.query("update transactions set coding_state='proposed',payload=jsonb_build_object('ai_suggestion',$1::jsonb) where id='held-statutory'",[JSON.stringify({source:'jev',case_evidence_digest:codingCaseRevision(held.caseEvidence),posting_requirement:'owner_fact',jev_decision:{terminal:'ask_owner',selected:'ask_statutory_source'}})]);
 assert.ok((await recoverChangedCodingEvidenceInDb({firmId:'f'})).some(r=>r.transaction_id==='held-statutory'),'unchanged held source wakes a redundant source question');
 assert.equal((await tx('held-statutory')).payload.ai_suggestion,undefined);
 assert.deepEqual(await recoverChangedCodingEvidenceInDb({firmId:'f'}),[],'housekeeping does not spend another decision');
 await pool.query("delete from transactions where id='held-statutory'");
 await seed('salary');
 await pool.query("update transactions set description='Net salary',money_out=1926.24 where id='salary'");
 await pool.query("update documents set total_amount=1926.24,tax_amount=null,parse_summary=jsonb_build_object('classification',jsonb_build_object('family','payroll')) where id='salary-source'");
 await pool.query("delete from document_lines where document_id='salary-source'");
 for (const [i,description,amount] of [[1,'Gross salary',2400],[2,'Withholding',-288],[3,'Employee pension',-171.60],[4,'Unemployment insurance',-14.16]])
   await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount) values($1,'f','c','salary-source',$2,$3,$4)",['salary-line-'+i,i,description,amount]);
 globalThis.fetch=async(endpoint,init)=>{
   assert.match(String(endpoint),/typesafe/);
   const request=JSON.parse(init.body);
   assert.ok(request.questions.decision.criteria.ask_payroll_package,'the held payslip must not remove the payroll-package choice');
   const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
     const keys=Object.keys(q.criteria), choice=key==='decision'?'ask_payroll_package':key==='materiality'?'normal':keys[0];
     return [key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?.95:.05/(keys.length-1)]))}];
   }));
   return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}));
 };
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'salary'});
 assert.equal((await tx('salary')).payload.ai_suggestion.posting_requirement,'payroll_package');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='salary'")).rows[0].n,0);
 const salaryAsks=(await pool.query("select * from client_evidence_requests where transaction_id='salary' and status in ('draft','open')")).rows;
 assert.equal(salaryAsks.length,1);assert.equal(salaryAsks[0].evidence_type,'payroll_package');
 assert.match(salaryAsks[0].question,/balanced external payroll journal/);

});

test('unchanged quoted private-use refusal constrains both account and tax; changed facts or an owner reply restore choice',()=>{
 const source={...doc,parse_summary:{source_business_use:{classification:'personal',source_quote:'Private driving'}}};
 const input={client:{jurisdiction:'fi'},transaction:{money_out:17.5,matched_document:source,posting_recovery:{previous_refusal:{
  code:'CODING_CORRECTION_SOURCE_USE_CONFLICT',details:{classification:'personal',business_use_percent:0,source_quote:'Private driving'}
 }}}};
 const constrained=build(input,['Motor expenses','Owner drawings']);
 assert.equal(constrained.executionConstraints[0].scope,'source_business_use');
 assert.deepEqual(constrained.accounts,['Owner drawings']);
 assert.deepEqual(constrained.componentTaxes,['Ei ALV-käsittelyä']);
 assert.ok(Object.values(constrained.plans).every(p=>p.proposed_account==='Owner drawings'&&p.tax_treatment==='Ei ALV-käsittelyä'));
 assert.ok(constrained.request.questions.decision.criteria.reasoning_judgment);
 const largeChart=build(input,['Motor expenses','Owner drawings',...Array.from({length:90},(_,i)=>`Other account ${i}`)]);
 assert.equal(largeChart.choiceMode,'account_tax_components','pruning must not expand a large-chart request back into joint prose');
 assert.deepEqual(Object.values(largeChart.request.questions.tax.criteria),['Ei ALV-käsittelyä']);

 for(const transaction of [
  {...input.transaction,posting_recovery:null},
  {...input.transaction,client_reply_context:{client_reply:'I marked the wrong receipt. It was business driving.'}},
  {...input.transaction,matched_document:{...source,parse_summary:{source_business_use:{classification:'personal',source_quote:'Different source annotation'}}}}
 ]){
  const restored=build({...input,transaction},['Motor expenses','Owner drawings']);
  assert.equal(restored.executionConstraints.length,0);assert.equal(restored.accounts.length,2);assert.deepEqual(restored.componentTaxes,taxes);
 }
});

test('identity refusal offers the precise relationship question and reasoning only until its source or answer changes',()=>{
 const relationships=[{own_side:'Another synthetic company',status:'suggested'}];
 const input={transaction:{correction_context:{unresolved_source_relationships:relationships},posting_recovery:{previous_refusal:{
  code:'CODING_CORRECTION_EXECUTION_REFUSED',details:{reason:'cross_entity_relation',source_relationships:relationships}
 }}}};
 const constrained=build(input);
 assert.equal(Object.keys(constrained.plans).length,0);
 assert.deepEqual(Object.keys(constrained.request.questions.decision.criteria).sort(),['ask_source_relationship','reasoning_allocation','reasoning_judgment','reasoning_vocabulary']);
 for(const transaction of [
  {...input.transaction,client_reply_context:{client_reply:'The named company bought the supplies for us.'}},
  {...input.transaction,correction_context:{unresolved_source_relationships:[{own_side:'Changed source company',status:'suggested'}]}}
 ]){
  const restored=build({...input,transaction});assert.equal(restored.executionConstraints.length,0);assert.ok(Object.keys(restored.plans).length>0);
 }
});

// FIK-0a (plan-2026-09-22-fi-jev-decision-knowledge.md §3): a Jev coding
// decision's receipt proves the bytes sent, the firm facts delivered, the
// fact-read outcome and the resolved Jev basis. Receipt-only: a forced fact
// read failure sends the same bytes and reaches the same decision as a
// genuinely empty read, and is receipted as a failure.
test('real PG: FIK-0a receipts request digests, delivered facts, read status and basis without changing the decision; FIK-0b admission and read-failure hold', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`jev_fik0a_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','jev-fik0a');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','fi','{"jurisdiction":"fi","accounting_system":"none","accounting_basis":"cash","alv_registration":{"status":"registered","registered_from":"2020-01-01"}}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST','FINLAND_ALV_CODING'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic FIK-0a proof',trialId:'fik0a',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 const merchant=canonicalFactSubject({scope:'merchant',value:'Bank service charge'});
 const facts=[['fact-legacy','merchant',merchant,'Bank service charges are the bank\'s own account fees.',{client_id:'c'}],
  ['fact-entity','merchant',merchant,'This company pays one monthly bank fee.',{client_id:'c',entity_client_id:'c'}],
  ['fact-jurisdiction','jurisdiction','fi','Synthetic jurisdiction-scope memory row.',{client_id:'c'}]];
 for(const[id,scope,subject,fact,provenance]of facts)await pool.query("insert into firm_facts(id,firm_id,scope,subject,fact,provenance,confidence,status) values($1,'f',$2,$3,$4,$5,'high','active')",[id,scope,subject,fact,JSON.stringify(provenance)]);
 const bodies=[];
 globalThis.fetch=async(endpoint,init)=>{
  assert.match(String(endpoint),/api\.typesafe\.ai/);bodies.push(init.body);
  const request=JSON.parse(init.body);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria);
   const choice=key==='materiality'?'low':key==='decision'&&q.criteria.resolved?'resolved':entries.find(([,v])=>v.includes('to Bank fees, tax treatment Ei ALV-käsittelyä;'))?.[0]
     ||entries.find(([,v])=>v==='Bank fees'||v==='Ei ALV-käsittelyä')?.[0]||entries[0][0];
   return[key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.95:.05/(entries.length-1)]))}];
  }));
  return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}));
 };
 const sha=body=>createHash('sha256').update(body).digest('hex');
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 const line=id=>pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'f','c','2025-02-28','Bank service charge',0,6,'EUR','needs_review','{}')",[id]);

 // 1. Facts read ok: the posted decision's receipt names the exact request
 // bytes, the delivered fact ids/scope/legacy label and the resolved basis.
 await line('fee');
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 const posted=await tx('fee'),decision=posted.payload.ai_suggestion.jev_decision;
 assert.equal(posted.coding_state,'posted');
 assert.equal(bodies.length,1);
 assert.deepEqual(decision.request_sha256s,[sha(bodies[0])]);
 assert.equal(decision.jev_basis,'experiment');
 assert.equal(decision.fact_read_status,'ok');assert.equal(decision.fact_read_error,undefined);
 assert.deepEqual([...decision.delivered_facts].sort((a,b)=>a.id.localeCompare(b.id)),[
  {id:'fact-entity',scope:'merchant',legacy_firm_scope:false},
  {id:'fact-jurisdiction',scope:'jurisdiction',legacy_firm_scope:false},
  {id:'fact-legacy',scope:'merchant',legacy_firm_scope:true}]);
 const sentFacts=JSON.parse(bodies[0]).state.known_facts;
 assert.equal(sentFacts.length,3);
 assert.ok(sentFacts.every(f=>!('id' in f)&&!('legacy_firm_scope' in f)),'the prompt projection is unchanged: ids and labels are receipt-only');
 const feeLines=(await pool.query("select l.account_name,l.debit,l.credit from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='fee' order by l.account_name")).rows;
 assert.equal(feeLines.find(l=>l.account_name==='Bank fees').debit,'6.00');

 // 2. A forced read failure versus a genuinely empty read on the same line:
 // identical bytes sent, identical decision, different receipt.
 await line('probe');
 const initial=await tx('probe');
 await pool.query(`alter table firm_facts rename to firm_facts_held;
  create function fik0a_forced_fact_read_failure() returns boolean language plpgsql as $$begin raise exception 'forced fact read failure' using errcode='XX001'; end$$;
  create view firm_facts as select * from firm_facts_held where fik0a_forced_fact_read_failure();`);
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:false});
 const failedRow=await tx('probe'),failedBody=bodies.at(-1);
 assert.equal(failedRow.payload.ai_suggestion.jev_decision.fact_read_status,'read_failed');
 assert.deepEqual(failedRow.payload.ai_suggestion.jev_decision.fact_read_error,{code:'XX001'});
 assert.deepEqual(failedRow.payload.ai_suggestion.jev_decision.delivered_facts,[]);
 assert.deepEqual(JSON.parse(failedBody).state.known_facts,[]);
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='probe'")).rows[0].n,0,'a failed read is not an owner ask');
 // Restore memory, make it genuinely empty, and reset the line.
 await pool.query(`drop view firm_facts;drop function fik0a_forced_fact_read_failure();alter table firm_facts_held rename to firm_facts;delete from firm_facts;`);
 await pool.query('delete from transaction_review_queue where transaction_id=$1',['probe']).catch(()=>{});
 await pool.query('update transactions set payload=$2,coding_state=$3,status=$4 where id=$1',['probe',initial.payload,initial.coding_state,initial.status]);
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:false});
 const emptyRow=await tx('probe'),emptyBody=bodies.at(-1);
 assert.equal(bodies.length,3,'each run made its own provider request; the comparison is not vacuous');
 assert.equal(failedRow.coding_state,'proposed');
 assert.equal(emptyRow.payload.ai_suggestion.jev_decision.fact_read_status,'empty');
 assert.equal(emptyRow.payload.ai_suggestion.jev_decision.fact_read_error,undefined);
 assert.equal(emptyBody,failedBody,'the fact read outcome never reaches the request bytes');
 assert.deepEqual(emptyRow.payload.ai_suggestion.jev_decision.request_sha256s,failedRow.payload.ai_suggestion.jev_decision.request_sha256s);
 const decisionOnly=s=>{const {fact_read_status,fact_read_error,...jev}=s.jev_decision;return {...s,jev_decision:jev};};
 const volatile=s=>JSON.parse(JSON.stringify(s,(k,v)=>['generated_at','suggested_at','created_at','updated_at'].includes(k)?undefined:v));
 assert.deepEqual(volatile(decisionOnly(emptyRow.payload.ai_suggestion)),volatile(decisionOnly(failedRow.payload.ai_suggestion)));
 assert.equal(emptyRow.coding_state,failedRow.coding_state);
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='probe'")).rows[0].n,0);

 // 3. FIK-0b coding admission (CODING_FACT_ADMISSION acts): the coder and
 // its receipt see the entity's own facts and the legacy row it asserted,
 // never a legacy row another entity asserted, never a jurisdiction row.
 await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction) values('d','f','Sibling company','fi');
  insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('CODING_FACT_ADMISSION','f','c','CODING_FACT_ADMISSION','auto','manual');`);
 const admitted=[['fact-own-legacy','merchant',merchant,'Own legacy: the fee is the bank account fee.',{client_id:'c',asserted_by_clients:['c']}],
  ['fact-sibling-legacy','merchant',merchant,'Sibling legacy: this fee is recharged.',{client_id:'d',asserted_by_clients:['d']}],
  ['fact-entity-2','merchant',merchant,'This company pays one monthly bank fee.',{client_id:'c',entity_client_id:'c'}],
  ['fact-jurisdiction-2','jurisdiction','fi','Synthetic jurisdiction-scope memory row.',{client_id:'c'}]];
 for(const[id,scope,subject,fact,provenance]of admitted)await pool.query("insert into firm_facts(id,firm_id,scope,subject,fact,provenance,confidence,status) values($1,'f',$2,$3,$4,$5,'high','active')",[id,scope,subject,fact,JSON.stringify(provenance)]);
 await line('admitted');
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:false});
 const admittedRow=await tx('admitted'),admittedDecision=admittedRow.payload.ai_suggestion.jev_decision;
 assert.equal(admittedDecision.fact_read_status,'ok');
 assert.deepEqual([...admittedDecision.delivered_facts].sort((a,b)=>a.id.localeCompare(b.id)),[
  {id:'fact-entity-2',scope:'merchant',legacy_firm_scope:false},
  {id:'fact-own-legacy',scope:'merchant',legacy_firm_scope:true}]);
 const admittedSent=JSON.parse(bodies.at(-1)).state.known_facts.map(f=>f.fact).sort();
 assert.deepEqual(admittedSent,['Own legacy: the fee is the bank account fee.','This company pays one monthly bank fee.'],
  'the sibling\'s legacy fact and the jurisdiction row never reach the request');
 assert.equal((await pool.query("select count(*)::int n from firm_facts where id in ('fact-sibling-legacy','fact-jurisdiction-2') and status='active'")).rows[0].n,2,
  'admission filters the read; it never rewrites or dismisses the rows');

 // 4. Under the admission a failed read holds the line on the existing
 // coding-failure receipt: no provider request, no verdict, no ask, no
 // journal. The next healthy run codes it and clears the receipt.
 await line('held');
 await pool.query(`alter table firm_facts rename to firm_facts_held;
  create function fik0b_forced_fact_read_failure() returns boolean language plpgsql as $$begin raise exception 'forced fact read failure' using errcode='XX001'; end$$;
  create view firm_facts as select * from firm_facts_held where fik0b_forced_fact_read_failure();`);
 const sentBefore=bodies.length;
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:true});
 const heldRow=await tx('held');
 assert.equal(bodies.length,sentBefore,'no provider request is made against missing memory');
 assert.equal(heldRow.payload.ai_suggestion,undefined,'nothing is decided');
 assert.equal(heldRow.payload.coding_provider_failure.code,'CODING_CONTEXT_READ_FAILED');
 assert.equal(heldRow.payload.coding_provider_failure.owner,'queue');
 assert.equal(heldRow.payload.coding_provider_failure.retryable,true);
 assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='held'")).rows[0].n,0,'a failed read is never an owner ask');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='held'")).rows[0].n,0);
 await pool.query(`drop view firm_facts;drop function fik0b_forced_fact_read_failure();alter table firm_facts_held rename to firm_facts;`);
 await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:1,autoApply:false});
 const recovered=await tx('held');
 assert.equal(bodies.length,sentBefore+1,'the retry reaches the provider once memory reads again');
 assert.equal(recovered.payload.ai_suggestion.jev_decision.fact_read_status,'ok');
 assert.equal(recovered.payload.coding_provider_failure,undefined,'a persisted verdict clears the hold');

 // 5. The single-line path holds the same way and says why.
 await line('single-held');
 await pool.query(`alter table firm_facts rename to firm_facts_held;
  create function fik0b_forced_fact_read_failure() returns boolean language plpgsql as $$begin raise exception 'forced fact read failure' using errcode='XX001'; end$$;
  create view firm_facts as select * from firm_facts_held where fik0b_forced_fact_read_failure();`);
 const singleBefore=bodies.length;
 await assert.rejects(suggestTransactionCodingInDb({firmId:'f',transactionId:'single-held'}),
  error=>error.code==='CODING_CONTEXT_READ_FAILED'&&error.statusCode===503);
 const singleHeld=await tx('single-held');
 assert.equal(bodies.length,singleBefore);
 assert.equal(singleHeld.payload.ai_suggestion,undefined);
 assert.equal(singleHeld.payload.coding_provider_failure.code,'CODING_CONTEXT_READ_FAILED');
 await pool.query(`drop view firm_facts;drop function fik0b_forced_fact_read_failure();alter table firm_facts_held rename to firm_facts;`);
});
