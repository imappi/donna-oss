import test from 'node:test';
import { runDocumentDispositionForClient } from './documentDispositionLlm.js';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { planReminderObligation, applyReminderSettlementWithClient, reverseReminderSettlementWithClient } from './creditNoteApplications.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb } from './firmDb.js';
import { currentCodingEvidence, codingEvidenceDigest, recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { recordRefusalViaDb } from './ledgerAutoPost.js';
import { buildJevCodingRequest } from './jevCoding.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';

const invoice={id:'original',firm_id:'firm',client_id:'company',document_type:'sales_invoice',parse_status:'completed',customer_name:'Synthetic customer Oy',reference_number:'INV-1002',document_date:'2025-02-12',currency:'EUR',total_amount:903.60,tax_amount:183.60,parse_summary:{line_amounts_include_tax:false},lines:[{id:'original-line',description:'Service',amount:720,raw_extraction:{tax_rate:.255}}]};
const reminder={...invoice,id:'reminder',reference_number:'REM-1002',document_date:'2025-02-20',total_amount:923.60,tax_amount:null,parse_summary:{line_amounts_include_tax:true,references:[{type:'invoice_number',value:'INV-1002'}]},lines:[{id:'principal-line',description:'Original invoice',amount:903.60,raw_extraction:{tax_rate:.255}},{id:'charge-line',description:'Exempt reminder charge',amount:20,raw_extraction:{tax_rate:0}}]};
test('reminder relationship binds original principal and tax to exact source references',()=>{
  const plan=planReminderObligation({invoice,reminder});
  assert.equal(plan.ok,true);assert.equal(plan.principal_amount,903.6);assert.equal(plan.principal_tax,183.6);assert.equal(plan.charges_amount,20);
  assert.equal(planReminderObligation({invoice,reminder:{...reminder,parse_summary:{...reminder.parse_summary,references:[]}}}).reason,'reminder_reference');
  assert.equal(planReminderObligation({invoice,reminder:{...reminder,customer_name:'Another company'}}).reason,'reminder_customer');
});

const pgUrl=process.env.DONNA_PG_TEST_URL;
test('real PG: reminder settles one original obligation, posts exact components once, preserves purpose ask and reverses payment contribution', {skip:!pgUrl&&'DONNA_PG_TEST_URL required'},async t=>{
  const admin=new pg.Client({connectionString:pgUrl});await admin.connect();
  const name=`donna_reminder_${process.pid}_${Date.now().toString(36)}`;await admin.query(`create database "${name}"`);
  const url=new URL(pgUrl);url.pathname='/'+name;const pool=new pg.Pool({connectionString:url.toString()});
  const closed=[];pool.on('connect',c=>closed.push(new Promise(resolve=>c.once('end',resolve))));__setFirmDbPoolForTests(pool);
  t.after(async()=>{__resetFirmDbPoolForTests();await pool.end();await Promise.all(closed);await admin.query(`drop database "${name}"`);await admin.end();});
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations=new URL('../../db/migrations/',import.meta.url);
  for(const file of(await readdir(migrations)).filter(f=>f.endsWith('.sql')).sort())await pool.query(await readFile(new URL(file,migrations),'utf8'));
  await pool.query("insert into firms(id,name,slug) values('firm','Synthetic firm','reminder-proof')");
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values('company','firm','Synthetic seller Oy','fi',$1)",[{jurisdiction:'fi',accounting_system:'none',accounting_basis:'cash',alv_registration:{status:'registered',registered_from:'2020-01-01'}}]);
  await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('tax','firm','company','FINLAND_ALV_CODING','auto','manual')");
  for(const d of[invoice,reminder]){
    await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,customer_name,reference_number,document_date,currency,total_amount,tax_amount,parse_summary,payload) values($1,'firm','company',$1,'sales_invoice','completed',$2,$3,$4,'EUR',$5,$6,$7,'{}')",[d.id,d.customer_name,d.reference_number,d.document_date,d.total_amount,d.tax_amount,d.parse_summary]);
    for(const[i,l]of d.lines.entries())await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,'firm','company',$2,$3,$4,$5,$6)",[l.id,d.id,i+1,l.description,l.amount,{raw_extraction:l.raw_extraction}]);
  }
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('payment','firm','company','2025-02-24','Invoice and reminder',923.60,0,'EUR','needs_review','applied','{}')");
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values('match','firm','company','payment','sales_invoice','reminder',923.60,.9,'auto_matched','fixture','{}')");
  const dispositionClient = await pool.connect();
  try {
    const result = await runDocumentDispositionForClient({ client: dispositionClient, firmId: 'firm', clientId: 'company',
      documentIds: ['original'], mode: 'act', jevEnabled: false, apiKeyOverride: 'fixture',
      fetchImpl: async () => new Response(JSON.stringify({content:[{type:'text',text:JSON.stringify({
        disposition:'needs_human', materiality:'material', expense_kind:'invoice', settlement_channel:'unknown', confidence:.9,
        reasoning:'Internal candidate_28 settlement uncertainty.', owner_question:'Was this invoice settled through the reminder?',
        owner_question_evidence_type:'payment_method'
      })}]})) });
    assert.equal(result.owner_asks_minted, 1, JSON.stringify(result));
  } finally { dispositionClient.release(); }
  const dispositionAsk = (await pool.query("select * from client_evidence_requests where request_payload->>'lane'='needs_human_disposition'")).rows[0];
  assert.ok(dispositionAsk);
  assert.equal(dispositionAsk.evidence_type, 'payment_method');
  assert.match(dispositionAsk.question, /settled through the reminder/);
  assert.doesNotMatch(dispositionAsk.question, /candidate_28|business expense/);
  for(const type of['business_purpose'])await pool.query("insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload) values($1,'firm','company','open',$1,$1,$2)",[type,{document_id:'original',audience:'client'}]);
  const connection=await pool.connect();
  try{
    await connection.query('begin');
    const receipt=await applyReminderSettlementWithClient({client:connection,firmId:'firm',clientId:'company',matchId:'match',reminderDocumentId:'reminder',invoiceDocumentId:'original',plan:planReminderObligation({invoice,reminder}),actorId:'fixture-decider',model:'fixture-provider'});
    assert.equal(receipt.status,'applied');await connection.query('commit');
  }catch(error){await connection.query('rollback');throw error;}finally{connection.release();}
  assert.equal((await pool.query("select payment_status from documents where id='original'")).rows[0].payment_status,'paid');
  assert.equal((await pool.query("select status from client_evidence_requests where id=$1",[dispositionAsk.id])).rows[0].status,'resolved');
  assert.equal((await pool.query("select status from client_evidence_requests where id='business_purpose'")).rows[0].status,'open');
  const settledSweep = await runDocumentDispositionForClient({client:pool,firmId:'firm',clientId:'company',
    documentIds:['original'],mode:'act',jevEnabled:false,apiKeyOverride:'fixture',
    fetchImpl:async()=>{throw new Error('A settled original must not be reconsidered as missing its payment');}});
  assert.equal(settledSweep.evaluated,0);
  const evidence=await currentCodingEvidence({client:pool,firmId:'firm',clientId:'company',transactionId:'payment'});
  const policy=resolveCodingPolicy({jurisdiction:'fi',businessDate:'2025-02-24',accountingSystem:'none'});
  const suggestion={proposed_account:'Sales',tax_treatment:'ALV 25,5 %',posting_requirement:'document_allocation',evidence_digest:codingEvidenceDigest(evidence),coding_policy:codingPolicyReceipt(policy),document_allocations:[{line_handle:'line_1',account:'Sales',tax_treatment:'ALV 25,5 %'},{line_handle:'line_2',account:'Interest expense',tax_treatment:'Veroton toiminta (ALV-vapaa)'}]};
  const menu=buildJevCodingRequest({input:{transaction:{money_in:923.6,money_out:0,matched_document:evidence}},accountOptions:['Sales','Interest income','Interest expense'],taxOptions:['ALV 25,5 %','Veroton toiminta (ALV-vapaa)'],instructions:'Use the source.'});
  assert.match(menu.request.state.accounting_policy,/receiving interest is Interest income, not Interest expense/);
  assert.deepEqual(menu.accounts,['Sales','Interest income','Interest expense'],'chart choices remain available for source-based judgment');
  await pool.query("update transactions set payload=$1 where id='payment'",[{ai_suggestion_status:'auto_applied',ai_suggestion:suggestion}]);
  let refusal;
  try {await postLedgerTransactionInDb({firmId:'firm',clientId:'company',transactionId:'payment',dryRun:false,skipSnapshot:true,actorId:'fixture-owner'});} catch(error) {refusal=error;}
  assert.equal(refusal?.code,'TRANSACTION_DOCUMENT_ALLOCATION_ACCOUNT_CONFLICT');
  assert.equal((await pool.query("select count(*)::int n from ledger_journals")).rows[0].n,0);
  await recordRefusalViaDb({firmId:'firm',clientId:'company',transactionId:'payment',error:refusal,actorId:'coding_auto_post'});
  assert.ok((await recoverChangedCodingEvidenceInDb({firmId:'firm'})).some(row=>row.transaction_id==='payment'));
  assert.equal((await pool.query("select coding_state from transactions where id='payment'")).rows[0].coding_state,'proposed');
  suggestion.document_allocations[1].account='Interest income';
  await pool.query("update transactions set coding_state='applied',payload=$1 where id='payment'",[{ai_suggestion_status:'auto_applied',ai_suggestion:suggestion}]);
  await postLedgerTransactionInDb({firmId:'firm',clientId:'company',transactionId:'payment',dryRun:false,skipSnapshot:true,actorId:'fixture-owner'});
  const ledger=(await pool.query("select l.account_name,l.debit,l.credit from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.source_id='payment' order by l.line_no")).rows;
  assert.deepEqual(ledger.map(l=>[Number(l.debit),Number(l.credit)]),[[923.6,0],[0,720],[0,183.6],[0,20]]);
  assert.equal(ledger[3].account_name,'Interest income');
  assert.equal((await pool.query("select count(*)::int n from ledger_journals")).rows[0].n,1);
  const reject=await pool.connect();try{await reject.query('begin');await reject.query("update reconciliation_matches set status='rejected' where id='match'");await reverseReminderSettlementWithClient({client:reject,firmId:'firm',matchId:'match',actorId:'fixture-owner'});await reject.query('commit');}catch(error){await reject.query('rollback');throw error;}finally{reject.release();}
  assert.equal((await pool.query("select payment_status from documents where id='original'")).rows[0].payment_status,'unpaid');
  assert.equal((await pool.query("select count(*)::int n from ledger_journals")).rows[0].n,1,'journal history is retained for the existing correction flow');
  // Replay an older source classified as a receipt through the named writer,
  // then its corrected issued-invoice family reveals the historical conflict.
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,parse_summary,payload) values('legacy-source','firm','company','legacy.pdf','receipt','completed',20,0,'EUR',$1,'{}')",[{line_amounts_include_tax:true}]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values('legacy-line','firm','company','legacy-source',1,'Interest collected',20,$1)",[{raw_extraction:{tax_rate:0}}]);
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('legacy','firm','company','2025-02-24','Legacy source family',20,0,'EUR','needs_review','applied','{}')");
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values('legacy-match','firm','company','legacy','receipt','legacy-source',20,.9,'auto_matched','fixture','{}')");
  const legacyEvidence=await currentCodingEvidence({client:pool,firmId:'firm',clientId:'company',transactionId:'legacy'});
  await pool.query("update transactions set payload=$1 where id='legacy'",[{ai_suggestion_status:'auto_applied',ai_suggestion:{...suggestion,proposed_account:'Interest expense',tax_treatment:'Veroton toiminta (ALV-vapaa)',evidence_digest:codingEvidenceDigest(legacyEvidence),document_allocations:[{line_handle:'line_1',account:'Interest expense',tax_treatment:'Veroton toiminta (ALV-vapaa)'}]}}]);
  await postLedgerTransactionInDb({firmId:'firm',clientId:'company',transactionId:'legacy',dryRun:false,skipSnapshot:true,actorId:'fixture-owner'});
  const originalRows=(await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='legacy' order by l.line_no")).rows;
  await pool.query("update documents set document_type='sales_invoice' where id='legacy-source'");
  await pool.query("update reconciliation_matches set matched_object_type='sales_invoice' where id='legacy-match'");
  await recoverChangedCodingEvidenceInDb({firmId:'firm'});
  const correction=(await pool.query("select payload->'coding_correction_required' r from transactions where id='legacy'")).rows[0].r;
  assert.equal(correction.reason,'posted_allocation_account_conflict');assert.equal(correction.status,'pending');
  assert.equal(correction.allocation_account_conflicts[0].account,'Interest expense');
  assert.equal(correction.next_action,'recode_decided');
  assert.equal((await pool.query("select status from transaction_review_queue where item_id='legacy' and reason='posted_evidence_changed'")).rows[0].status,'open');
  assert.deepEqual((await pool.query("select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id='legacy' order by l.line_no")).rows,originalRows,'correction requirement never rewrites journal history');
  assert.equal((await recoverChangedCodingEvidenceInDb({firmId:'firm'})).filter(row=>row.transaction_id==='legacy').length,0,'unchanged correction is idempotent');

});
