import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { planRefundGroup } from './jevRefundGroup.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, postLedgerAdjustmentInDb } from './firmDb.js';
import { currentCodingEvidence, codingEvidenceDigest, recoverChangedCodingEvidenceInDb, captureFiChatCodingEvidence } from './db/codingEvidence.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import {ensureTransactionReviewItemInDb,updateTransactionReviewItemInDb,batchSuggestTransactionCodingInDb} from './db/coding.js';
import {convergenceForTransaction,projectGatheredTransaction} from './reconcileConvergenceState.js';
import {buildTransactionChatContext} from './transactionChat.js';
import { buildJevCodingRequest } from './jevCoding.js';

const document={id:'receipt',firm_id:'refund-firm',client_id:'refund-client',document_type:'supplier_bill',parse_status:'completed',document_date:'2025-02-14',currency:'EUR',total_amount:19.90,tax_amount:4.04,parse_summary:{line_amounts_include_tax:true},lines:[{id:'source-line',description:'Business supplies',amount:19.90,raw_extraction:{tax_rate:.255}}]};
const transactions=[
  {id:'debit-a',transaction_date:'2025-02-14',money_out:19.90,money_in:0},
  {id:'debit-b',transaction_date:'2025-02-14',money_out:19.90,money_in:0},
  {id:'refund',transaction_date:'2025-02-17',money_out:0,money_in:19.90}
].map(row=>({...row,firm_id:'refund-firm',client_id:'refund-client',description:'Source-supported purchase/refund',currency:'EUR'}));
test('refund group is a semantic selectable plan, never an invented instrument reversal',()=>{
  const plan=planRefundGroup({document,transactions});assert.equal(plan.ok,true);assert.equal(plan.purchase_transaction_id,'debit-a');assert.equal(plan.refund_transaction_id,'refund');
  assert.equal(plan.allocation_basis,'chronological_convention_without_instrument_identity');
  assert.equal(planRefundGroup({document,transactions:transactions.slice(0,2)}).ok,false);
  assert.equal(planRefundGroup({document,transactions:transactions.map(t=>t.id==='refund'?{...t,money_in:19}:t)}).ok,false);
  const request=buildJevCodingRequest({input:{transaction:{...transactions[2],jev_refund_group:plan,matched_document:document}},accountOptions:['Operating supplies','Other income'],taxOptions:['ALV 25,5 %'],instructions:'Grounded source treatment.'});
  assert.match(request.request.state.accounting_policy,/SAME source-supported purchase expense account and INPUT tax/);
});

const pgUrl=process.env.DONNA_PG_TEST_URL;
test('real PG: full duplicate/refund group posts atomically through existing writers, leaving exactly one expense and source settlement', {skip:!pgUrl&&'DONNA_PG_TEST_URL required'},async t=>{
  const admin=new pg.Client({connectionString:pgUrl});await admin.connect();const name=`donna_refund_group_${process.pid}_${Date.now().toString(36)}`;await admin.query(`create database "${name}"`);
  const url=new URL(pgUrl);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.toString()});const closed=[];pool.on('connect',c=>closed.push(new Promise(resolve=>c.once('end',resolve))));__setFirmDbPoolForTests(pool);
  t.after(async()=>{__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations=new URL('../../db/migrations/',import.meta.url);for(const file of(await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
  await pool.query("insert into firms(id,name,slug) values('refund-firm','Synthetic refund proof','refund-proof')");
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values('refund-client','refund-firm','Synthetic company','fi',$1)",[{jurisdiction:'fi',accounting_system:'none',accounting_basis:'cash',alv_registration:{status:'registered',registered_from:'2020-01-01'}}]);
  await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('tax','refund-firm','refund-client','FINLAND_ALV_CODING','auto','manual')");
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary,payload) values('receipt','refund-firm','refund-client','Synthetic receipt','supplier_bill','completed','2025-02-14','EUR',19.90,4.04,$1,'{}')",[document.parse_summary]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values('source-line','refund-firm','refund-client','receipt',1,'Business supplies',19.90,$1)",[{raw_extraction:{tax_rate:.255}}]);
  await pool.query("insert into ledger_accounts(id,firm_id,client_id,name,account_type,normal_balance) values('supplies','refund-firm','refund-client','Operating supplies','expense','debit'),('office','refund-firm','refund-client','Office expenses','expense','debit')");
  const plan={...planRefundGroup({document,transactions}),status:'selected',model:'fixture-provider',actor_id:'fixture-decider'};
  for(const row of transactions){
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values($1,'refund-firm','refund-client',$2,$3,$4,$5,'EUR','needs_review','applied',$6)",[row.id,row.transaction_date,row.description,row.money_in,row.money_out,{jev_refund_group:plan}]);
    await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,'refund-firm','refund-client',$2,'supplier_bill','receipt',$3,.42,'auto_matched','fixture','{}')",['match-'+row.id,row.id,row.id===plan.purchase_transaction_id?plan.amount:0]);
    const evidence=await currentCodingEvidence({client:pool,firmId:'refund-firm',clientId:'refund-client',transactionId:row.id});
    const rowPolicy=resolveCodingPolicy({jurisdiction:'fi',businessDate:row.transaction_date,accountingSystem:'none'});
    await pool.query("update transactions set payload=payload || $2::jsonb where id=$1",[row.id,{ai_suggestion_status:'auto_applied',ai_suggestion:{proposed_account:row.id==='debit-b'?'Office expenses':'Operating supplies',tax_treatment:'ALV 25,5 %',posting_requirement:'single_account',evidence_digest:codingEvidenceDigest(evidence),coding_policy:codingPolicyReceipt(rowPolicy)}}]);
  }
  const post=()=>postLedgerTransactionInDb({firmId:'refund-firm',clientId:'refund-client',transactionId:'debit-a',dryRun:false,skipSnapshot:true,actorId:'fixture-owner'});
  await assert.rejects(post(),{code:'REFUND_GROUP_CODING_CONFLICT'});
  assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0,'different member coding cannot partially post');
  const originalSuggestions=(await pool.query("select id,payload->'ai_suggestion' as suggestion from transactions order by id")).rows;
  for(let attempt=1;attempt<=3;attempt++){
    const recovered=await recoverChangedCodingEvidenceInDb({firmId:'refund-firm'});
    assert.deepEqual(recovered.map(row=>row.transaction_id),['debit-a','debit-b','refund'],'the existing recovery clock reconsiders the complete refused group');
    assert.deepEqual((await pool.query("select coding_state,payload->'coding_evidence_reconsideration'->>'attempts' attempts from transactions order by id")).rows,
      transactions.map(()=>({coding_state:'proposed',attempts:String(attempt)})));
    for(const row of originalSuggestions)await pool.query("update transactions set coding_state='applied',payload=payload || $2::jsonb where id=$1",[row.id,{ai_suggestion:row.suggestion,ai_suggestion_status:'auto_applied'}]);
    await assert.rejects(post(),{code:'REFUND_GROUP_CODING_CONFLICT'});
  }
  assert.deepEqual(await recoverChangedCodingEvidenceInDb({firmId:'refund-firm'}),[],'unchanged rejected coding has a bounded retry budget');
  await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,proposed_account}','\"Operating supplies\"') where id='debit-b'");
  await pool.query("insert into close_periods(id,firm_id,client_id,period_start,period_end,status) values('refund-date-lock','refund-firm','refund-client','2025-02-17','2025-02-17','locked')");
  await assert.rejects(post(),{code:'LEDGER_LOCKED_PERIOD_IMMUTABLE'});
  assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,0,'last-member writer failure rolls back earlier member journals');
  await pool.query("delete from close_periods where id='refund-date-lock'");
  // Drive the actual group coding entry and atomic writer, rather than
  // assuming independent synthetic member suggestions will agree.
  const savedFetch=globalThis.fetch,savedKey=process.env.TYPESAFE_API_KEY,savedModel=process.env.TYPESAFE_MODEL;
  let codingCalls=0;
  try {
    process.env.TYPESAFE_API_KEY='fixture-key';process.env.TYPESAFE_MODEL='fixture-provider';
    await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('fixture-owner','refund-firm','fixture@example.invalid','Fixture','admin','active')");
    await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('jev','refund-firm','refund-client','JEV_RECONCILIATION','auto','manual')");
    const {enrollJevExperiment}=await import('./jevExperimentPolicy.js');
    const enrollment=await pool.connect();try {await enrollJevExperiment({client:enrollment,firmId:'refund-firm',clientId:'refund-client',actorId:'fixture-owner',authorityBasis:'Synthetic group proof',trialId:'group-proof',expiresAt:'2100-01-01',model:'fixture-provider'});} finally {enrollment.release();}
    await pool.query("update transactions set coding_state='proposed',payload=payload-'ai_suggestion'-'ai_suggestion_status'-'coding_evidence_reconsideration'-'ledger_post_refusal'");
    globalThis.fetch=async(_url,init)=>{
      codingCalls++;const request=JSON.parse(init.body);
      const answers=Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
        const entries=Object.entries(q.criteria),choice=key==='materiality'?'low':key==='decision'&&q.criteria.resolved?'resolved':entries.find(([,v])=>v.includes('to Operating supplies, tax treatment ALV 25,5 %;'))?.[0]||entries.find(([,v])=>v==='Operating supplies'||v==='ALV 25,5 %')?.[0]||entries[0][0];
        return [key,{type:'choice',choice,confidence:.95,probabilities:Object.fromEntries(entries.map(([k])=>[k,k===choice?.95:.05/(entries.length-1)]))}];
      }));return new Response(JSON.stringify({model:'fixture-provider',answers,usage:{input_tokens:1,output_tokens:1}}));
    };
    const resolvedFetch=globalThis.fetch;
    // One malformed case must not roll back an unrelated Finnish coding.
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status) values('independent-fee','refund-firm','refund-client','2025-02-28','Bank service charge',6,'EUR','needs_review')");
    await pool.query("update transactions set transaction_date='0001-01-01' where id='refund'");
    globalThis.fetch=async(_url,init)=>{
      const request=JSON.parse(init.body);
      return new Response(JSON.stringify({model:'fixture-provider',usage:{input_tokens:1,output_tokens:1},answers:Object.fromEntries(Object.entries(request.questions).map(([key,q])=>{
        const keys=Object.keys(q.criteria),choice=key==='decision'?'ask_business_use':key==='materiality'?'normal':keys[0];
        return[key,{type:'choice',choice,confidence:.9,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?.9:.1/(keys.length-1)]))}];
      }))}));
    };
    const isolated=await batchSuggestTransactionCodingInDb({firmId:'refund-firm',clientIds:['refund-client'],limit:10,autoApply:false});
    assert.equal(isolated.transaction_ai_batch.summaries[0].suggested,1,JSON.stringify(isolated.transaction_ai_batch));
    const units=isolated.transaction_ai_batch.summaries[0].units;
    assert.equal(isolated.transaction_ai_batch.summaries[0].scanned,4);
    assert.equal(units.find(unit=>unit.status==='refused').scanned,3);
    assert.equal(units.find(unit=>unit.status==='refused').suggested,0);
    assert.equal(units.find(unit=>unit.transaction_ids.includes('independent-fee')).scanned,1);
    assert.equal(units.find(unit=>unit.transaction_ids.includes('independent-fee')).suggested,1);
    assert.equal((await pool.query("select payload->'ai_suggestion' as suggestion from transactions where id='independent-fee'")).rows[0].suggestion.evidence_required,true);
    assert.equal((await pool.query("select count(*)::int n from transactions where id<>'independent-fee' and payload?'ai_suggestion'")).rows[0].n,0,'a failed group persists no partial decisions');
    const failures=(await pool.query("select resource_id from audit_events where action='transaction.coding.policy_failed'")).rows.map(row=>row.resource_id);
    assert.ok(failures.includes('refund'));assert.ok(!failures.includes('independent-fee'));
    await pool.query("delete from transactions where id='independent-fee'");
    await pool.query("update transactions set transaction_date='2025-02-17' where id='refund'");
    // Unresolved group decisions also pass each member's exact-date boundary.
    await batchSuggestTransactionCodingInDb({firmId:'refund-firm',clientIds:['refund-client'],limit:10,autoApply:false});
    const asked=(await pool.query("select transaction_date,payload->'ai_suggestion' as suggestion from transactions order by id")).rows;
    assert.ok(asked.every(row=>row.suggestion?.evidence_required===true));
    assert.equal(asked.find(row=>row.suggestion.transaction_id==='refund').suggestion.coding_policy.businessDate,'2025-02-17');
    await pool.query("update transactions set coding_state='proposed',payload=payload-'ai_suggestion'-'ai_suggestion_status'");
    globalThis.fetch=resolvedFetch;
    const batchResult=await batchSuggestTransactionCodingInDb({firmId:'refund-firm',clientIds:['refund-client'],limit:10,autoApply:true});
    assert.equal(codingCalls,1,'one grounded decision covers the complete selected group');
    const coded=(await pool.query("select payload->'ai_suggestion' as suggestion from transactions order by id")).rows;
    assert.ok(coded.every(r=>r.suggestion?.coding_group?.transaction_ids.length===3),JSON.stringify({batch:batchResult.transaction_ai_batch,coded}));
  } finally {
    globalThis.fetch=savedFetch;
    if(savedKey===undefined)delete process.env.TYPESAFE_API_KEY;else process.env.TYPESAFE_API_KEY=savedKey;
    if(savedModel===undefined)delete process.env.TYPESAFE_MODEL;else process.env.TYPESAFE_MODEL=savedModel;
  }
  await assert.rejects(post(),{code:'LEDGER_ALREADY_POSTED'},'the batch already posted all three journals');
  const totals=(await pool.query("select l.account_name,sum(l.debit-l.credit)::numeric as net from ledger_lines l group by l.account_name order by l.account_name")).rows;
  assert.equal(Number(totals.find(row=>row.account_name==='Operating supplies').net),15.86);
  assert.equal(Number(totals.find(row=>row.account_name==='Vähennettävä arvonlisävero').net),4.04);
  assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n,3);
  assert.equal(Number((await pool.query("select sum(match_amount) total from reconciliation_matches where matched_object_id='receipt'")).rows[0].total),19.9);
  assert.deepEqual((await pool.query("select coding_state,payload->'jev_refund_group'->>'status' group_state from transactions order by id")).rows,[{coding_state:'posted',group_state:'posted'},{coding_state:'posted',group_state:'posted'},{coding_state:'posted',group_state:'posted'}]);
  // Later evidence creates explicit correction work without rewriting history.
  const originalJournals=(await pool.query('select * from ledger_journals order by id')).rows;
  const originalLines=(await pool.query('select * from ledger_lines order by id')).rows;
  await pool.query("update transactions set payload=payload || '{\"reviewed_by\":\"fixture-human\"}'::jsonb where id='debit-b'");
  const humanBefore=(await pool.query("select * from transactions where id='debit-b'")).rows[0];
  await pool.query("update document_lines set description='Source now clarifies the use' where id='source-line'");
  const reconsidered=await recoverChangedCodingEvidenceInDb({firmId:'refund-firm'});
  assert.deepEqual(reconsidered.map(row=>row.transaction_id),['debit-a','refund']);
  assert.ok(reconsidered.every(row=>row.correction_required));
  const posted=(await pool.query("select * from transactions where id='debit-a'")).rows[0];
  assert.equal(posted.coding_state,'posted');
  assert.equal(convergenceForTransaction(posted).reason,'posted_evidence_reconsideration_required');
  assert.equal(projectGatheredTransaction(posted).state,'hanging');
  const context=buildTransactionChatContext({transaction:{...posted,...posted.payload},clientProfile:{jurisdiction:'fi',accounting_system:'none'}});
  assert.equal(context.transaction.coding_correction_required.next_action,'recode_decided');
  assert.equal((await pool.query("select status from transaction_review_queue where item_id='debit-a' and reason='posted_evidence_changed'")).rows[0].status,'open');
  assert.deepEqual((await pool.query("select * from transactions where id='debit-b'")).rows[0],humanBefore,'a human-attributable posting stays untouched');
  assert.deepEqual((await pool.query('select * from ledger_journals order by id')).rows,originalJournals);
  assert.deepEqual((await pool.query('select * from ledger_lines order by id')).rows,originalLines);
  await pool.query("delete from transaction_review_queue where item_id='debit-a' and reason='posted_evidence_changed'");
  assert.deepEqual(await recoverChangedCodingEvidenceInDb({firmId:'refund-firm'}),[],'one changed source produces one correction requirement');
  assert.equal((await pool.query("select status from transaction_review_queue where item_id='debit-a' and reason='posted_evidence_changed'")).rows[0].status,'open','a crash before sidecar creation heals without a duplicate decision');
  await pool.query("update document_lines set description='Business supplies' where id='source-line'");
  const restored=await recoverChangedCodingEvidenceInDb({firmId:'refund-firm'});
  assert.equal(restored.length,2);assert.ok(restored.every(row=>!row.correction_required));
  assert.equal(projectGatheredTransaction((await pool.query("select * from transactions where id='debit-a'")).rows[0]).state,'auto_reconciled');
  await pool.query("update document_lines set description='Current evidence for operator correction' where id='source-line'");
  await recoverChangedCodingEvidenceInDb({firmId:'refund-firm'});
  // The existing chat evidence guard and correction writer complete the work.
  const captured=await captureFiChatCodingEvidence({client:pool,firmId:'refund-firm',clientId:'refund-client',transactionId:'debit-a'});
  const receipt={...captured.receipt,message_id:'correction-message',action_index:0};
  await pool.query("insert into transaction_chat_messages(id,firm_id,client_id,transaction_id,role,content,payload,model,actor_type) values('correction-message','refund-firm','refund-client','debit-a','assistant','Reconsider current source',$1,'fixture-provider','llm')",[{actions:[{type:'recode_decided',coding_evidence:receipt}]}]);
  const reviewId=await ensureTransactionReviewItemInDb({firmId:'refund-firm',clientId:'refund-client',transactionId:'debit-a',preserveTransactionReviewState:true});
  await updateTransactionReviewItemInDb({firmId:'refund-firm',reviewItemId:reviewId,actorId:'fixture-owner',returnSnapshot:false,distillFactsFn:async()=>null,
    codingEvidenceAuthority:{receipt,messageId:'correction-message',actionIndex:0},patch:{status:'resolved',coding_state:'posted',proposed_account:'Office expenses',account_name:'Office expenses',tax_treatment:'ALV 25,5 %'}});
  assert.equal(projectGatheredTransaction((await pool.query("select * from transactions where id='debit-a'")).rows[0]).state,'hanging','a new label alone cannot settle a tax journal correction');
  await postLedgerAdjustmentInDb({firmId:'refund-firm',clientId:'refund-client',transactionId:'debit-a',originalJournalId:posted.payload.ledger_journal_id,
    journalDate:'2025-02-20',reason:'Operator reclassified current source',reverseOriginal:false,actorId:'fixture-owner',lines:[
      {account_name:'Office expenses',debit:15.86,currency:'EUR'},
      {account_name:'Operating supplies',credit:15.86,currency:'EUR'}]});
  const corrected=(await pool.query("select * from transactions where id='debit-a'")).rows[0];
  assert.equal(corrected.payload.coding_correction_required.status,'corrected');
  assert.equal(corrected.payload.coding_correction_required.actor_id,'fixture-owner');
  assert.equal(projectGatheredTransaction(corrected).state,'auto_reconciled');
  assert.deepEqual((await pool.query('select * from ledger_journals where id=any($1::text[]) order by id',[originalJournals.map(row=>row.id)])).rows,originalJournals,'correction preserves original journals');

});
