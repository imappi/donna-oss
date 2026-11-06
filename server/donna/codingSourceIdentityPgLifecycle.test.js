import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__setFirmDbPoolForTests,__resetFirmDbPoolForTests,postLedgerTransactionInDb,postLedgerAdjustmentInDb} from './firmDb.js';
import {batchSuggestTransactionCodingInDb,ensureTransactionReviewItemInDb,updateTransactionReviewItemInDb} from './db/coding.js';
import {recoverChangedCodingEvidenceInDb,currentCodingEvidence,codingEvidenceDigest,captureFiChatCodingEvidence} from './db/codingEvidence.js';
import {recordRefusalViaDb} from './ledgerAutoPost.js';
import {enrollJevExperiment} from './jevExperimentPolicy.js';
import {runCodingAutoPostForTransaction} from './codingAutoPost.js';
import {convergenceForTransaction} from './reconcileConvergenceState.js';

test('real PG: batch and final writer fence foreign source identity; existing posted journals receive visible correction work', {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
 const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
 const name=`coding_identity_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
 const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
 const pool=new pg.Pool({connectionString:url.toString()}),closed=[];pool.on('connect',c=>closed.push(new Promise(r=>c.once('end',r))));__setFirmDbPoolForTests(pool);
 const savedFetch=globalThis.fetch,keys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
 t.after(async()=>{globalThis.fetch=savedFetch;for(const[k,v]of Object.entries(keys)){if(v===undefined)delete process.env[k];else process.env[k]=v;}__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
 Object.assign(process.env,{TYPESAFE_API_KEY:'fixture',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture'});
 await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
 const root=new URL('../../db/migrations/',import.meta.url);for(const f of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(f,root),'utf8'));
 await pool.query(`insert into firms(id,name,slug) values('f','Synthetic firm','coding-identity');
 insert into clients(id,firm_id,company_name,jurisdiction,profile) values('c','f','Current company','us','{"jurisdiction":"us","accounting_system":"none","accounting_basis":"cash"}');
 insert into firm_members(id,firm_id,email,name,role,status) values('member','f','fixture@example.invalid','Fixture','admin','active');`);
 const enrollment=await pool.connect();try{await enrollJevExperiment({client:enrollment,firmId:'f',clientId:'c',actorId:'member',authorityBasis:'Synthetic lifecycle proof',trialId:'source-identity',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollment.release();}
 for(const flag of ['JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION','CODING_AUTO_POST'])await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,'f','c',$1,'auto','manual')",[flag]);
 for(const id of ['blocked','late','human']){
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,'f','c','2025-06-02','Utility service',0,26.37,'USD','needs_review','{}')",[id]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary) values($1,'f','c',$1,'supplier_bill','completed','2025-06-02','USD',26.37,0,'{\"line_amounts_include_tax\":true}')",['doc-'+id]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload) values($1,'f','c',$2,1,'Service',26.37,0,'{}')",['line-'+id,'doc-'+id]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload) values($1,'f','c',$2,'supplier_bill',$3,'suggested',26.37,.9,$4)",['match-'+id,id,'doc-'+id,id==='blocked'?{cross_entity:{detected:true,own_side:'Another company'}}:{}]);
 }
 let calls=0;globalThis.fetch=async(endpoint,init)=>{
  calls++;assert.match(String(endpoint),/api\.typesafe\.ai/);const request=JSON.parse(init.body);
  const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
   const entries=Object.entries(q.criteria),choice=key==='materiality'?'low':entries.find(([,label])=>label.includes('Utilities')&&label.includes('No sales tax'))?.[0]||entries.find(([,label])=>label==='Utilities'||label==='No sales tax')?.[0]||entries.find(([k])=>k==='single_account')?.[0]||entries[0][0];
   return [key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.9:.1/(entries.length-1)]))}];
  }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}),{status:200,headers:{'content-type':'application/json'}});
 };
 const batch=await batchSuggestTransactionCodingInDb({firmId:'f',clientIds:['c'],limit:3,autoApply:true});assert.ok(calls>=3);
 const tx=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
 assert.equal((await tx('blocked')).coding_state,'proposed',JSON.stringify(batch.transaction_ai_batch));
 assert.equal((await tx('late')).coding_state,'posted');assert.equal((await tx('human')).coding_state,'posted');
 assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='blocked'")).rows[0].n,0);
 // A caller that already accepted the coding cannot bypass the final writer.
 await pool.query("update transactions set coding_state='applied',payload=payload || '{\"ai_suggestion_status\":\"auto_applied\"}'::jsonb where id='blocked'");
 let refusal;try{await postLedgerTransactionInDb({firmId:'f',clientId:'c',transactionId:'blocked',dryRun:false,skipSnapshot:true,actorId:'coding_auto_post'});}catch(error){refusal=error;}
 assert.equal(refusal?.code,'TRANSACTION_SOURCE_IDENTITY_UNRESOLVED');
 await recordRefusalViaDb({firmId:'f',clientId:'c',transactionId:'blocked',error:refusal,actorId:'coding_auto_post',source:'ai_batch_direct'});
 const callsBeforeRecovery=calls;
 assert.ok((await recoverChangedCodingEvidenceInDb({firmId:'f'})).some(r=>r.transaction_id==='blocked'&&r.ownership_question_required));
 const sweep=await runCodingAutoPostForTransaction({firmId:'f',clientId:'c',transactionId:'blocked'});
 assert.equal(sweep.owner_asked,1,JSON.stringify(sweep));
 assert.equal(calls,callsBeforeRecovery,'the existing sweep asks the factual relationship without repeating coding');
 const asks=(await pool.query("select * from client_evidence_requests where transaction_id='blocked' and status in ('draft','open')")).rows;
 assert.equal(asks.length,1);assert.equal(asks[0].evidence_type,'business_purpose');assert.match(asks[0].question,/Another company/);
 const journals=(await pool.query('select * from ledger_journals order by id')).rows,lines=(await pool.query('select * from ledger_lines order by id')).rows;
 await pool.query("update transactions set payload=payload || '{\"reviewed_by\":\"named-human\"}'::jsonb where id='human'");
 const humanBefore=await tx('human');
 assert.equal(await captureFiChatCodingEvidence({client:pool,firmId:'f',clientId:'c',transactionId:'late'}),null,'ordinary US chat keeps its prior contract');
 const sourceBefore=codingEvidenceDigest(await currentCodingEvidence({client:pool,firmId:'f',clientId:'c',transactionId:'late'}));
 await pool.query("update reconciliation_matches set payload=$1 where bank_transaction_id in ('late','human')",[{cross_entity:{detected:true,own_side:'Another company'}}]);
 assert.equal(codingEvidenceDigest(await currentCodingEvidence({client:pool,firmId:'f',clientId:'c',transactionId:'late'})),sourceBefore,'the source receipt itself did not change');
 const recovered=await recoverChangedCodingEvidenceInDb({firmId:'f'});
 assert.ok(recovered.some(r=>r.transaction_id==='late'&&r.correction_required),JSON.stringify(recovered));
 const late=await tx('late'),requirement=late.payload.coding_correction_required;
 assert.equal(requirement.reason,'posted_source_identity_unresolved');assert.equal(requirement.next_action,'recode_decided');
 assert.equal(requirement.source_relationships[0].document_id,'doc-late');assert.equal(requirement.source_relationships[0].own_side,'Another company');
 assert.equal(requirement.actor_id,'coding_convergence');assert.equal(requirement.model,'fixture-provider');
 assert.equal(convergenceForTransaction(late).reason,'posted_evidence_reconsideration_required');
 assert.equal((await pool.query("select status from transaction_review_queue where item_id='late' and reason='posted_evidence_changed'")).rows[0].status,'open');
 assert.deepEqual(await tx('human'),humanBefore);assert.deepEqual((await pool.query('select * from ledger_journals order by id')).rows,journals);assert.deepEqual((await pool.query('select * from ledger_lines order by id')).rows,lines);
 assert.equal((await recoverChangedCodingEvidenceInDb({firmId:'f'})).filter(r=>r.transaction_id==='late').length,0,'one persisted requirement heals without endless recoding');
 // The same server-captured chat receipt and named adjustment writer can
 // complete a non-Finnish correction; a requirement is not a dead-end badge.
 const captured=await captureFiChatCodingEvidence({client:pool,firmId:'f',clientId:'c',transactionId:'late'});
 assert.ok(captured);const receipt={...captured.receipt,message_id:'correction',action_index:0};
 await pool.query("insert into transaction_chat_messages(id,firm_id,client_id,transaction_id,role,content,payload,model,actor_type) values('correction','f','c','late','assistant','Review ownership and classify payment on behalf of the named company',$1,'fixture-provider','llm')",[{actions:[{type:'recode_decided',coding_evidence:receipt}]}]);
 await pool.query("insert into ledger_accounts(id,firm_id,client_id,name,account_type,normal_balance) values('receivable','f','c','Other receivables','asset','debit')");
 const reviewId=await ensureTransactionReviewItemInDb({firmId:'f',clientId:'c',transactionId:'late',preserveTransactionReviewState:true});
 await updateTransactionReviewItemInDb({firmId:'f',reviewItemId:reviewId,actorId:'named-owner',returnSnapshot:false,distillFactsFn:async()=>null,
  codingEvidenceAuthority:{receipt,messageId:'correction',actionIndex:0},patch:{status:'resolved',coding_state:'posted',proposed_account:'Other receivables',account_name:'Other receivables',tax_treatment:'No sales tax'}});
 await postLedgerAdjustmentInDb({firmId:'f',clientId:'c',transactionId:'late',originalJournalId:requirement.original_journal_id,journalDate:'2025-06-03',reason:'Owner confirmed payment for another company',reverseOriginal:false,actorId:'named-owner',lines:[
  {account_name:'Other receivables',debit:26.37,currency:'USD'},{account_name:'Utilities',credit:26.37,currency:'USD'}]});
 const corrected=await tx('late');assert.equal(corrected.payload.coding_correction_required.status,'corrected');assert.equal(corrected.payload.coding_correction_required.actor_id,'named-owner');
 assert.equal(convergenceForTransaction(corrected).state,'auto_reconciled');
 assert.deepEqual((await pool.query('select * from ledger_journals where id=any($1::text[]) order by id',[journals.map(j=>j.id)])).rows,journals);
});
