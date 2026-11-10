import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {__draftClientAskBatchWithClient,__sendClientAskBatchWithClient} from './db/asks.js';
import {__writeLedgerJournalRows,postDocumentSettlementJournalWithClient} from './db/ledger.js';
import {buildLedgerJournalForTransaction} from './ledger.js';
import {seedDesktopClientPlaneRowsWithClient} from './desktop/hostPlaneSeed.js';
import {accountOptionsForClient} from './transactionLlm.js';
import {buildJevCodingRequest} from './jevCoding.js';
import {convergenceForUnmatchedDocument} from './reconcileConvergenceState.js';
import {buildAskDraftInput} from './askPipeline.js';

test('legal form and source family bound the actual coding menu',()=>{
  const chart=[{name:'Owner drawings'},{name:'Receivable from owner'},{name:'Bank fees'}];
  assert.ok(!accountOptionsForClient(chart,{jurisdiction:'fi',entityType:'fi-oy'}).includes('Owner drawings'));
  assert.ok(accountOptionsForClient(chart,{jurisdiction:'fi',entityType:'fi-toiminimi'}).includes('Owner drawings'));
  for(const source_family of ['receipt','bank_statement','payroll']) {
    const request=buildJevCodingRequest({input:{transaction:{matched_document:{source_family}}},
      accountOptions:['Bank fees'],taxOptions:['Ei ALV-käsittelyä'],instructions:'Use supplied facts.'}).request;
    assert.equal(Boolean(request.questions.decision.criteria.ask_payroll_package),source_family==='payroll');
  }
});

test('payment method alone cannot become completed accounting',()=>{
  const doc={payload:{no_line_disposition:{disposition:'auto_explain',settlement_channel:'cash'}}};
  assert.equal(convergenceForUnmatchedDocument(doc).state,'hanging');
  assert.equal(convergenceForUnmatchedDocument(doc,{hasOpenOwnerAsk:true}).state,'on_owner');
  doc.payload.settlement_entry={journal_id:'posted-receipt'};
  assert.equal(convergenceForUnmatchedDocument(doc).state,'auto_reconciled');
});

test('real PG: drafted posting claims read journals; confirmed owner settlement preserves source VAT',
  {skip:!process.env.DONNA_PG_TEST_URL},async t=>{
  const admin=new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL});await admin.connect();
  const name=`fi_material_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
  const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname=`/${name}`;
  const client=new pg.Client({connectionString:url.toString()});await client.connect();
  t.after(async()=>{await client.end();await admin.query(`drop database "${name}"`);await admin.end();});
  await client.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const root=new URL('../../db/migrations/',import.meta.url);
  for(const file of(await readdir(root)).filter(f=>f.endsWith('.sql')).sort()) await client.query(await readFile(new URL(file,root),'utf8'));
  await client.query(`insert into firms(id,name,slug) values('f','Synthetic firm','material-errors');
    insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values('c','f','Synthetic Oy','fi','fi-oy','{"jurisdiction":"fi","entity_type":"fi-oy","accounting_system":"none","alv_registration":{"status":"registered","registered_from":"2020-01-01"}}');
    insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('tax','f','c','FINLAND_ALV_CODING','auto','manual');`);
  for(const id of ['salary','posted']) {
    await client.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,coding_state,payload)
      values($1,'f','c','2025-02-28',$1,0,80,'EUR',$2,$3::jsonb)`,[id,id==='salary'?'asked':'posted',JSON.stringify({ai_suggestion:{proposed_account:'Suspense'},coding_auto_post:{owner_notified:false,proposed_account:'Wrong suggested account'}})]);
    await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,currency)
      values($1,'f','c',$1||'.pdf','supplier_bill','completed','2025-02-28',80,'EUR')`,[id+'-doc']);
    await client.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,status,payload)
      values($1,'f','c',$2,'supplier_bill',$3,80,'auto_matched','{"authorization":{"material_auto_fyi":{"owner_notified":false}}}')`,[id+'-match',id,id+'-doc']);
  }
  await client.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question,audience)
    values('salary-ask','f','c','salary','draft','payroll_package','Please provide the balanced payroll journal.','client')`);
  await client.query('begin');
  await __writeLedgerJournalRows({client,firmId:'f',clientId:'c',actorId:'fixture',payload:{},
    journal:buildLedgerJournalForTransaction({transaction:{id:'posted',date:'2025-02-28',money_out:80,currency:'EUR'},
      coding:{account_name:'Bank fees',account_code:'fee',account_type:'expense'},bankAccount:{code:'bank',name:'Bank'}})});
  await client.query('commit');
  let seen;
  const batch = await __draftClientAskBatchWithClient({client,firmId:'f',clientId:'c',draftFn:async input=>{
    seen=input;
    // Closing changes journal metadata, not the accounting claimed by this
    // draft. Exercise post-generation freshness against the actual writer.
    await client.query('begin');
    await __writeLedgerJournalRows({client,firmId:'f',clientId:'c',actorId:'fixture',payload:{},
      existingJournalId:input.appliedFyiLines.find(row=>row.transaction_id==='posted').journal_id,
      journal:{...buildLedgerJournalForTransaction({transaction:{id:'posted',date:'2025-02-28',money_out:80,currency:'EUR'},
        coding:{account_name:'Bank fees',account_code:'fee',account_type:'expense'},bankAccount:{code:'bank',name:'Bank'}}),status:'closed'}});
    await client.query('commit');
    return {model:'fixture',draft:{subject:'Update',message_markdown:'The bank service was posted. The salary still needs the payroll journal.',items:[],statement_requests:[],document_asks:[],counts:{ask:0,notify:0,skip:0,statement_requests:0}}};
  }});
  assert.ok(seen.appliedFyiLines.length);
  assert.ok(seen.appliedFyiLines.every(row=>row.transaction_id==='posted'));
  assert.match(seen.appliedFyiLines[0].coded_account,/Bank fees/);
  assert.doesNotMatch(seen.appliedFyiLines[0].coded_account,/Suspense|Wrong suggested/);
  assert.ok(seen.appliedFyiLines[0].journal_lines.some(line=>line.account==='Bank fees'));
  const salaryQuestion=seen.openEvidenceRequests.find(row=>row.id==='salary-ask');
  assert.equal(salaryQuestion.status,'draft');
  assert.equal(salaryQuestion.sent_at,null);
  assert.equal(Number(salaryQuestion.send_count),0);
  const draftInput=buildAskDraftInput(seen);
  assert.equal(draftInput.open_evidence_requests[0].status,'draft');
  assert.equal(draftInput.open_evidence_requests[0].sent_at,null);
  assert.equal(draftInput.open_evidence_requests[0].send_count,0);

  // Historical messages predate journal receipts and must be regenerated.
  const originalPayload=(await client.query('select payload from client_ask_batches where id=$1',[batch.batch.id])).rows[0].payload;
  await client.query("update client_ask_batches set payload=payload-'posted_journal_receipts' where id=$1",[batch.batch.id]);
  await assert.rejects(__sendClientAskBatchWithClient({client,firmId:'f',clientId:'c',batchId:batch.batch.id,actorId:'fixture'}),{code:'ASK_BATCH_STALE'});
  // Restore the independently generated valid receipt to exercise the later race.
  await client.query("update client_ask_batches set status='draft',payload=$2::jsonb where id=$1",[batch.batch.id,JSON.stringify(originalPayload)]);

  // The send lock must reject a journal changed after the message was drafted.
  const currentJournal=(await client.query("select id from ledger_journals where source_id='posted'")).rows[0];
  await client.query('begin');
  await __writeLedgerJournalRows({client,firmId:'f',clientId:'c',actorId:'fixture',payload:{},existingJournalId:currentJournal.id,
    journal:buildLedgerJournalForTransaction({transaction:{id:'posted',date:'2025-02-28',money_out:80,currency:'EUR'},
      coding:{account_name:'Office expenses',account_code:'office',account_type:'expense'},bankAccount:{code:'bank',name:'Bank'}})});
  await client.query('commit');
  await assert.rejects(__sendClientAskBatchWithClient({client,firmId:'f',clientId:'c',batchId:batch.batch.id,actorId:'fixture'}),{code:'ASK_BATCH_STALE'});
  assert.equal((await client.query('select status from client_ask_batches where id=$1',[batch.batch.id])).rows[0].status,'superseded');

  const document={id:'cash',document_type:'receipt',document_date:'2025-02-20',total_amount:22,tax_amount:4.47,currency:'EUR'};
  await client.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,total_amount,tax_amount,currency,payload)
    values('cash','f','c','cash.pdf','receipt','completed','2025-02-20',22,4.47,'EUR','{"no_line_disposition":{"disposition":"auto_explain","settlement_channel":"cash","funding_source":"unknown"}}')`);
  const post=()=>postDocumentSettlementJournalWithClient({client,firmId:'f',clientId:'c',document,
    expenseAccount:{name:'Office expenses',code:'office',type:'expense',tax_treatment:'ALV 25,5 %'},
    actorId:'fixture',authorityBasis:'owner_reply',settlement:{settlement_channel:'cash'}});
  await client.query('begin');
  await assert.rejects(post(),{code:'DOCUMENT_SETTLEMENT_FUNDING_REQUIRED'});
  await client.query('rollback');
  await client.query(`update documents set payload=jsonb_set(payload,'{no_line_disposition,funding_source}','"owner"') where id='cash'`);
  await client.query('begin');await post();await client.query('commit');
  const lines=(await client.query(`select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_type='document_settlement' and j.source_id='cash' order by l.line_no`)).rows;
  assert.equal(lines.length,3);
  assert.equal(Number(lines[0].debit),17.53);assert.equal(Number(lines[1].debit),4.47);assert.equal(Number(lines[2].credit),22);
  assert.equal(lines[0].tax_type,'ALV_25_5_INPUT');
  await seedDesktopClientPlaneRowsWithClient(client,{firmId:'f',clientId:'c'});
  assert.equal((await client.query("select stage from client_capability_config where client_id='c' and flag_key='DOCUMENT_SETTLEMENT_LEDGER_ENTRY' and valid_to is null")).rows[0].stage,'auto');
  await client.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type) values('neighbor','f','Unchanged neighbor','us','us-llc')");
  await seedDesktopClientPlaneRowsWithClient(client,{firmId:'f',clientId:'neighbor'});
  assert.equal((await client.query("select count(*)::int n from client_capability_config where client_id='neighbor' and flag_key='DOCUMENT_SETTLEMENT_LEDGER_ENTRY'")).rows[0].n,0);

});
