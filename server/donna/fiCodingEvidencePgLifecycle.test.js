import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, batchSuggestTransactionCodingInDb } from './firmDb.js';
import { autoCategorizeMatchedTransactionsInDb } from './parseDocumentsDb.js';
import { recoverRefusedCodingEvidenceInDb, hasPendingPostingRecoveryWithClient } from './db/codingRefusalRecovery.js';
import { recordRefusalViaDb, sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { currentCodingEvidence, codingEvidenceDigest, recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: the real coder consumes late evidence, posts principal/interest separately and retains purpose/payroll asks', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const name = `donna_fi_evidence_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  // RT-23: the production settle seam (loadPgPool installs it) — the persisted
  // convergence verdict is part of this proof.
  installConvergenceSettleOnPool(pool);
  const connectionsClosed = [];
  pool.on('connect', (connection) => { connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))); });
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end();
    await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((n) => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }


  const firmId='fi-proof', clientId='salon';
  await pool.query("insert into firms(id,name,slug) values($1,'FI Proof','fi-proof')",[firmId]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Salong Test Oy','fi','fi-oy',$3)`,[clientId,firmId,{jurisdiction:'fi',accounting_system:'none',accounting_basis:'cash'}]);
  for (const flag of ['FINLAND_ALV_CODING','JURISDICTION_ACCOUNT_PALETTE','RECONCILIATION_CODE_MATCHED_NO_REVIEW','CODING_AUTO_POST','LEDGER_AUTO_POST']) await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')`,[flag,firmId,clientId,flag]);
  const tx = async (id, amount) => pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload) values($1,$2,$3,'2025-02-28',$1,$4,0,'EUR','needs_review','{}')`,[id,firmId,clientId,amount]);
  const doc = async (id, filename, total, tax, components) => {
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$4,'supplier_bill','completed',$5,$6,'EUR','2025-02-28','{}')`,[id,firmId,clientId,filename,total,tax]);
    for (const [i,line] of components.entries()) await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,$6,$7,'{}')`,[`${id}-${i}`,firmId,clientId,id,i+1,line[0],line[1]]);
  };
  const match = async (id, documentId, amount) => pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'supplier_bill',$5,$6,1,'auto_matched','fixture','{}')`,[`match-${id}`,firmId,clientId,id,documentId,amount]);
  await tx('loan',412.35); await tx('rent',1450); await tx('fuel',52.10); await tx('salary',1926.24); await tx('withholding',332.88);
  // The first coding asked which obligation was paid before its loan notice
  // arrived. Keep that ask open until the fresh source-backed verdict applies.
  await pool.query("update transactions set coding_state='asked',payload=$1 where id='loan'",[{ai_suggestion_status:'auto_applied',ai_suggestion:{proposed_account:'Loan payable',evidence_digest:codingEvidenceDigest(null),posting_requirement:'owner_fact',evidence_required:true}}]);
  await pool.query("insert into client_evidence_requests(id,firm_id,client_id,transaction_id,status,evidence_type,question,request_payload) values('loan-old-ask',$1,$2,'loan','draft','business_purpose','Which obligation did this payment settle?','{}')",[firmId,clientId]);

  await doc('loan-notice','Lainalaskelma.pdf',412.35,null,[['Korko',67.98],['Lyhennys',344.37]]);
  await doc('payslip','Palkkalaskelma.pdf',1926.24,null,[['Bruttopalkka',2400],['Ennakonpidätys',-288],['TyEL',-171.60],['Työttömyysvakuutus',-14.16]]);
  await doc('payroll-tax-notice','Ennakonpidatys ja SAVA.pdf',332.88,null,[['Payroll withholding and health-insurance remittance',332.88]]);
  await match('withholding','payroll-tax-notice',332.88);
  await match('loan','loan-notice',412.35); await match('salary','payslip',1926.24);
  assert.ok((await recoverChangedCodingEvidenceInDb({firmId})).some(row=>row.transaction_id==='loan'));
  assert.equal((await pool.query("select status from client_evidence_requests where id='loan-old-ask'")).rows[0].status,'draft','source arrival does not pretend the owner answered');

  const priorKey=process.env.OPENAI_API_KEY, priorFetch=globalThis.fetch;
  process.env.OPENAI_API_KEY='fixture-only';
  let rentSawBill=false, loanSawComponents=false;
  globalThis.fetch=async (url, init) => {
    if (String(url)!=='https://api.openai.com/v1/responses') throw new Error('Network disabled in proof');
    const request=JSON.parse(init.body), input=JSON.parse(request.input);
    const suggestions=(input.transactions || [input.transaction]).map(row=>{
      const base={transaction_id:row.id,proposed_account:'Rent',tax_treatment:'ALV-tarkistus',confidence:'high',evidence_required:true,auto_explain_limit:0,reasoning:'fixture verdict grounded in supplied evidence',posting_requirement:'single_account',document_allocations:[],ask_client_question:''};
      if(row.id==='wrong-tax') {
        assert.equal(row.matched_document.tax_amount,2.60,'the valid original source reaches reconsideration');
        assert.equal(row.posting_recovery?.recovery,'recode_current_evidence','the concrete writer conflict reaches the real coder');
        return {...base,proposed_account:'Travel',tax_treatment:'ALV 10 %',evidence_required:false};
      }
      if(row.id==='tax-extraction-error') {
        assert.equal(row.posting_recovery.source_verified,true,'the independent extraction review reaches the real coder');
        return {...base,proposed_account:'Travel',tax_treatment:'ALV 14 %',evidence_required:false};
      }
      if(row.id==='loan') {
        assert.equal(row.matched_document.lines.length,2);
        assert.equal(row.matched_document.lines[0].handle,'line_1');
        assert.equal(row.matched_document.lines[0].amount,67.98);
        assert.ok(request.text.format.schema.properties.suggestions.items.properties.document_allocations.items.properties.account.enum.includes('Interest expense'));
        loanSawComponents=true;
        return {...base,proposed_account:'Loan payable',tax_treatment:'Ei ALV-käsittelyä',evidence_required:false,posting_requirement:'document_allocation',document_allocations:[{line_handle:'line_1',account:'Interest expense'},{line_handle:'line_2',account:'Loan payable'}]};
      }
      if(row.id==='withholding') {
        assert.ok(request.text.format.schema.properties.suggestions.items.properties.proposed_account.enum.includes('Payroll withholding and employer health-insurance payable'));
        return {...base,proposed_account:'Payroll withholding and employer health-insurance payable',tax_treatment:'Ei ALV-käsittelyä',evidence_required:false};
      }
      if(row.id==='rent' && row.matched_document) {
        assert.equal(row.matched_document.tax_amount,0); assert.equal(row.matched_document.filename,'Vuokralasku.pdf');
        rentSawBill=true; return {...base,tax_treatment:'Veroton toiminta (ALV-vapaa)',evidence_required:false};
      }
      if(row.id==='late-fee') return {...base,proposed_account:'Bank fees',tax_treatment:'Ei ALV-käsittelyä',evidence_required:false,auto_explain_limit:50};
      if(row.id==='eu-goods') return {...base,proposed_account:'Operating supplies',tax_treatment:'EU-tavaraosto',evidence_required:false};
      if(row.id==='train') return {...base,proposed_account:'Travel',tax_treatment:'ALV 14 %',evidence_required:false};
      if(row.id==='fuel') return {...base,proposed_account:'Motor expenses',tax_treatment:'ALV 25,5 %',evidence_required:false,posting_requirement:'owner_fact',ask_client_question:'Was this fuel used for business driving or personal driving?'};
      if(row.id==='salary') return {...base,proposed_account:'Payroll',tax_treatment:'Ei ALV-käsittelyä',evidence_required:false,posting_requirement:'payroll_package',ask_client_question:'We have the payslip. Please provide the balanced external payroll journal, including employer contributions and liability accounts.'};
      return base;
    });
    return {ok:true,status:200,json:async()=>({id:'fixture-response',output_text:JSON.stringify(input.transactions ? {suggestions,group_summary:[]} : suggestions[0])})};
  };
  t.after(()=>{globalThis.fetch=priorFetch;if(priorKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=priorKey;});
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  assert.equal(loanSawComponents,true);
  const loanJournals=(await pool.query("select id from ledger_journals where source_id='loan'")).rows;
  assert.equal(loanJournals.length,1,'the real batch coder reaches the named journal writer');
  assert.equal((await pool.query("select status from client_evidence_requests where id='loan-old-ask'")).rows[0].status,'resolved','the newly applied coding closes its obsolete question through the existing writer');
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='loan' and status in ('draft','open','replied')")).rows[0].n,0);

  const lines=(await pool.query('select a.name,l.debit,l.credit,l.tax_type from ledger_lines l join ledger_accounts a on a.id=l.account_id where l.journal_id=$1 order by l.line_no',[loanJournals[0].id])).rows;
  assert.deepEqual(lines.map(l=>[l.name,Number(l.debit),Number(l.credit)]),[['Interest expense',67.98,0],['Loan payable',344.37,0],['Business Checking · EUR',0,412.35]]);
  assert.ok(lines.every(l=>l.tax_type==='NONE'));
  const withholdingLines=(await pool.query(`select a.name,l.debit,l.credit from ledger_lines l join ledger_accounts a on a.id=l.account_id join ledger_journals j on j.id=l.journal_id where j.source_id='withholding' order by l.line_no`)).rows;
  assert.deepEqual(withholdingLines.map(l=>[l.name,Number(l.debit),Number(l.credit)]),[['Payroll withholding and employer health-insurance payable',332.88,0],['Business Checking · EUR',0,332.88]]);
  // Rent coded before its bill; the new match must invalidate the old verdict.
  await doc('rent-bill','Vuokralasku.pdf',1450,0,[['Vuokra helmikuu',1450]]); await match('rent','rent-bill',1450);
  await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:'rent',dryRun:true}),{code:'TRANSACTION_CODING_EVIDENCE_STALE'});
  const recovered=await recoverChangedCodingEvidenceInDb({firmId});
  assert.deepEqual(recovered.map(row=>row.transaction_id),['rent']);
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  assert.equal(rentSawBill,true);
  assert.equal((await pool.query("select coding_state from transactions where id='rent'")).rows[0].coding_state,'posted');
  assert.equal((await recoverChangedCodingEvidenceInDb({firmId})).length,0,'stable evidence spends no further coding calls');
  // The chart's last-used standard tax rate must not overwrite the current
  // coder's EU acquisition or reduced-rate verdict in the posting preview.
  await pool.query(`insert into ledger_accounts(id,firm_id,client_id,name,account_type,tax_type,status,currency)
    values('supplies',$1,$2,'Operating supplies','expense','ALV_25_5_INPUT','active','EUR'),
          ('travel',$1,$2,'Travel','expense','ALV_25_5_INPUT','active','EUR')`,[firmId,clientId]);
  await tx('eu-goods',320); await tx('train',28.60);
  await doc('eu-invoice','EU tavaraosto.pdf',320,0,[['Products',320]]);
  await doc('train-ticket','Matkalippu.pdf',28.60,3.51,[['Journey',28.60]]);
  await match('eu-goods','eu-invoice',320); await match('train','train-ticket',28.60);
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  const taxLines = async id => (await pool.query(`select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id=$1 order by l.line_no`,[id])).rows;
  const euLines=await taxLines('eu-goods'), trainLines=await taxLines('train');
  // FI v1 self-assesses EU acquisition tax on the return; the journal
  // retains the full net base, without inventing domestic input VAT.
  assert.equal(euLines.length,2);
  assert.equal(euLines[0].tax_type,'ALV_EU_ACQUISITION');
  assert.deepEqual(euLines.map(l=>[Number(l.debit),Number(l.credit)]),[[320,0],[0,320]]);
  assert.equal(trainLines[0].tax_type,'ALV_14_INPUT');
  assert.deepEqual(trainLines.map(l=>[Number(l.debit),Number(l.credit)]),[[25.09,0],[3.51,0],[0,28.60]]);
  // A loaded-but-unread batch is still evidence in flight. The existing
  // ledger sweep receipts the wait and the coding clock heals it after parse.
  await doc('pending-source','Unread receipt.pdf',8,0,[['Fee',8]]);
  await pool.query("update documents set parse_status='pending' where id='pending-source'");
  await tx('late-fee',8);
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  assert.equal((await taxLines('late-fee')).length,0);
  await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:'late-fee',dryRun:true}),{code:'TRANSACTION_CODING_EVIDENCE_PENDING'});
  const waited = await sweepLedgerAutoPost({firmId,clientId,transactionId:'late-fee',configSnapshot:{LEDGER_AUTO_POST:{stage:'auto'}}});
  assert.equal(waited.eligible,0,'the inline refusal already damps the sweep');
  assert.equal((await pool.query("select payload->'ledger_post_refusal'->>'code' code from transactions where id='late-fee'")).rows[0].code,'TRANSACTION_CODING_EVIDENCE_PENDING');
  await pool.query("update documents set parse_status='completed' where id='pending-source'");
  assert.ok((await recoverChangedCodingEvidenceInDb({firmId})).some(row=>row.transaction_id==='late-fee'));
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  assert.equal((await taxLines('late-fee')).length,2);

  // A stated tax amount inconsistent with the proposed rate is a refusal,
  // including at the actual named writer, never a manufactured deduction.
  const trainRow=(await pool.query("select payload from transactions where id='train'")).rows[0].payload;
  await tx('wrong-tax',28.60);
  await doc('wrong-tax-ticket','Tax discrepancy.pdf',28.60,2.60,[['Journey',28.60]]);
  await match('wrong-tax','wrong-tax-ticket',28.60);
  const mismatchEvidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:'wrong-tax'});
  await pool.query("update transactions set coding_state='applied',payload=$1 where id='wrong-tax'",[{...trainRow,ledger_journal_id:null,ledger_status:null,
    ai_suggestion:{...trainRow.ai_suggestion,evidence_digest:codingEvidenceDigest(mismatchEvidence)}}]);
  await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:'wrong-tax',dryRun:false}),{code:'TRANSACTION_ALV_CODING_SOURCE_CONFLICT'});
  assert.equal((await taxLines('wrong-tax')).length,0);
  // A valid source and a wrong selected rate require recoding, not a replacement receipt.
  assert.ok((await recoverChangedCodingEvidenceInDb({firmId})).some(row=>row.transaction_id==='wrong-tax'));
  let rereads=0;
  const rereadFn=async ({context})=>{rereads+=1;return {kind:'completed',model:'fixture-source-reader',
    header:{total_amount:Number(context.source.total_amount),currency:'EUR',document_date:'2025-02-28'},
    summary:{tax_amount:context.tx.id==='tax-extraction-error'?3.51:2.60,subtotal_amount:context.tx.id==='tax-extraction-error'?25.09:26,warnings:[]},
    lines:[{description:'Journey',amount:28.60,tax_rate:context.tx.id==='tax-extraction-error'?0.14:0.10}]};};
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  // Frozen replay 2026-09-21 (VR, row 25): the recode took the printed 10 %.
  // On a 2025 line 10 % is a historical rate; with no stated basis the coder's
  // choice is the document_discrepancy question against the held ticket,
  // never the 26 + 2.60 posting this proof once pinned. No re-read, no journal.
  assert.equal((await taxLines('wrong-tax')).length,0);
  const wrongTax=(await pool.query("select coding_state,payload from transactions where id='wrong-tax'")).rows[0];
  assert.equal(wrongTax.coding_state,'proposed');
  assert.equal(wrongTax.payload.ai_suggestion.posting_requirement,'document_discrepancy');
  assert.deepEqual(wrongTax.payload.ai_suggestion.historical_rate_guard.treatments,['ALV 10 %']);
  assert.equal(wrongTax.payload.ai_suggestion.evidence_required,true);
  assert.match(wrongTax.payload.ai_suggestion.ask_client_question,/Tax discrepancy\.pdf/);
  assert.equal(rereads,0,'current validated source is not reread');
  // An extraction error is repaired through the parse writer, with no owner question.
  await tx('tax-extraction-error',28.60);
  await doc('ocr-ticket','Receipt.pdf',28.60,2.60,[['Journey',28.60]]);
  await pool.query("update documents set parse_run_id=gen_random_uuid() where id='ocr-ticket'");
  await match('tax-extraction-error','ocr-ticket',28.60);
  const ocrEvidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:'tax-extraction-error'});
  await pool.query("update transactions set coding_state='applied',payload=$1 where id='tax-extraction-error'",[{...trainRow,ledger_journal_id:null,ledger_status:null,ai_suggestion:{...trainRow.ai_suggestion,evidence_digest:codingEvidenceDigest(ocrEvidence)}}]);
  await recordRefusalViaDb({firmId,clientId,transactionId:'tax-extraction-error',error:{code:'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH',message:'Printed VAT disagrees'}});
  const repaired=await recoverRefusedCodingEvidenceInDb({firmId,rereadFn});
  assert.equal(repaired[0].state,'reconsidered',JSON.stringify(repaired));
  assert.equal(Number((await pool.query("select tax_amount from documents where id='ocr-ticket'")).rows[0].tax_amount),3.51);
  await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId]});
  assert.equal((await taxLines('tax-extraction-error')).length,3);
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='tax-extraction-error'")).rows[0].n,0);
  const refusedFixture=async id=>{
    await tx(id,28.60);await doc(`${id}-doc`,`${id}.pdf`,28.60,2.60,[['Journey',28.60]]);await match(id,`${id}-doc`,28.60);
    const evidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:id});
    await pool.query(`update transactions set coding_state='applied',payload=$2 where id=$1`,[id,{...trainRow,ledger_journal_id:null,ledger_status:null,ai_suggestion:{...trainRow.ai_suggestion,evidence_digest:codingEvidenceDigest(evidence)}}]);
    await recordRefusalViaDb({firmId,clientId,transactionId:id,error:{code:'TRANSACTION_ALV_DOCUMENT_AMOUNT_MISMATCH',message:'VAT disagreement'}});
  };
  await refusedFixture('outage');
  let outages=0;
  const outage=async()=>{outages++;throw Object.assign(new Error('Provider unavailable'),{code:'PROVIDER_UNAVAILABLE'});};
  for(let i=0;i<4;i++) await recoverRefusedCodingEvidenceInDb({firmId,rereadFn:outage});
  assert.equal(outages,3,'source retries stop after three failures');
  assert.equal(await hasPendingPostingRecoveryWithClient(pool, firmId, 'outage'), false, 'exhausted recovery is never shown as processing');
  assert.equal((await pool.query("select count(*)::int n from client_evidence_requests where transaction_id='outage'")).rows[0].n,0,'a provider outage never becomes client evidence work');
  await refusedFixture('source-race');
  const raced=await recoverRefusedCodingEvidenceInDb({firmId,rereadFn:async args=>{
    const read=await rereadFn(args);
    await pool.query("update documents set tax_amount=3.51 where id='source-race-doc'");
    return read;
  }});
  assert.equal(raced[0].skipped,'source_changed','a document changing during reasoning refuses the old result');
  assert.equal((await pool.query("select coding_state from transactions where id='source-race'")).rows[0].coding_state,'applied');
  await pool.query(`update transactions set payload=payload || '{"reviewed_by":"real-member"}'::jsonb where id='source-race'`);
  assert.equal((await recoverRefusedCodingEvidenceInDb({firmId,rereadFn})).length,0,'a human correction cannot be reopened by automatic recovery');
  await refusedFixture('flag-off');
  await pool.query("update client_capability_config set stage='off' where flag_key='CODING_AUTO_POST'");
  assert.equal(await hasPendingPostingRecoveryWithClient(pool, firmId, 'flag-off'), false, 'disabled recovery is not queued work');
  assert.equal((await recoverRefusedCodingEvidenceInDb({firmId,rereadFn})).length,0,'the existing coding grant gates source recovery');
  await pool.query("update client_capability_config set stage='auto' where flag_key='CODING_AUTO_POST'");
  await pool.query(`update transactions set payload=payload || '{"reviewed_by":"real-member"}'::jsonb where id='flag-off'`);
  await refusedFixture('shared-source');
  await pool.query("update documents set parse_run_id=gen_random_uuid() where id='shared-source-doc'");
  await tx('shared-sibling',28.60);await match('shared-sibling','shared-source-doc',28.60);
  let repairAttempts=0;
  for(let i=0;i<4;i++) await recoverRefusedCodingEvidenceInDb({firmId,rereadFn:async args=>{
    repairAttempts++;
    return {...await rereadFn(args),summary:{tax_amount:3.51,subtotal_amount:25.09}};
  }});
  assert.equal(repairAttempts,3,'a refused source repair is bounded too');
  const shared=(await pool.query("select payload->'posting_recovery' receipt from transactions where id='shared-source'")).rows[0].receipt;
  assert.equal(shared.state,'exhausted');assert.equal(shared.code,'POSTING_SOURCE_REPAIR_SHARED');
  assert.equal(shared.review,undefined,'a failed repair cannot authorize a factual client question');
  assert.equal(Number((await pool.query("select tax_amount from documents where id='shared-source-doc'")).rows[0].tax_amount),2.60);
  assert.equal((await taxLines('shared-source')).length,0);
  const loanPayload=(await pool.query("select payload from transactions where id='loan'")).rows[0].payload;
  await tx('invalid-allocation',412.35); await match('invalid-allocation','loan-notice',412.35);
  const allocationEvidence=await currentCodingEvidence({client:pool,firmId,clientId,transactionId:'invalid-allocation'});
  for (const allocations of [
    [{line_handle:'line_1',account:'Interest expense'},{line_handle:'line_1',account:'Loan payable'}],
    [{line_handle:'line_1',account:'Invented account'},{line_handle:'line_2',account:'Loan payable'}],
    [{line_handle:'line_1',account:'Interest expense'}]
  ]) {
    await pool.query("update transactions set coding_state='applied',payload=$1 where id='invalid-allocation'",[{...loanPayload,ledger_journal_id:null,ledger_status:null,
      ai_suggestion:{...loanPayload.ai_suggestion,evidence_digest:codingEvidenceDigest(allocationEvidence),document_allocations:allocations}}]);
    await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:'invalid-allocation',dryRun:false}),{code:'TRANSACTION_DOCUMENT_ALLOCATION_INVALID'});
    assert.equal((await taxLines('invalid-allocation')).length,0);
  }
  await pool.query(`update transactions set payload=payload || '{"ai_suggestion_status":"accepted"}'::jsonb where id='invalid-allocation'`);
  const humanPreview=await postLedgerTransactionInDb({firmId,clientId,transactionId:'invalid-allocation',dryRun:true});
  assert.equal(humanPreview.document_allocation,undefined,'a prior machine allocation cannot override a later human accept');
  // A document match never overrides a required owner fact or payroll package.
  await doc('fuel-receipt','Kuitti YKSITYISAJO.pdf',52.10,10.59,[['Bensiini',52.10]]); await match('fuel','fuel-receipt',52.10);
  await autoCategorizeMatchedTransactionsInDb({firmId,clientId});
  for (const id of ['fuel','salary']) {
    assert.equal((await pool.query('select coding_state from transactions where id=$1',[id])).rows[0].coding_state,'proposed','legacy match projection must not accept an unresolved strong coding');
    const result=await runCodingAutoPostForTransaction({firmId,clientId,transactionId:id,env:{},configSnapshot:{CODING_AUTO_POST:{stage:'auto'}}});
    assert.equal(result.owner_asked,1,JSON.stringify(result));
    const asks=(await pool.query(`select evidence_type,question from client_evidence_requests where transaction_id=$1 and status in ('draft','open')`,[id])).rows;
    assert.equal(asks.length,1);assert.equal(asks[0].evidence_type,id==='fuel'?'business_purpose':'payroll_package');
    assert.equal((await pool.query('select count(*)::int n from ledger_journals where source_id=$1',[id])).rows[0].n,0);
    await autoCategorizeMatchedTransactionsInDb({firmId,clientId});
    assert.equal((await pool.query('select coding_state from transactions where id=$1',[id])).rows[0].coding_state,'asked','the retained ask remains eligible for ordinary owner reply processing');
  }
});
