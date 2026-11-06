import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb } from './firmDb.js';
import { currentCodingEvidence, codingEvidenceDigest } from './db/codingEvidence.js';
import { runBankLineDispositionForTransaction } from './bankLineDispositionLlm.js';
import { applyConvergenceState } from './reconcileConvergenceState.js';
import { enrollJevExperiment } from './jevExperimentPolicy.js';
import { batchSuggestTransactionCodingInDb } from './db/coding.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: Jev component selections reach the existing posting writer with exact source VAT', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_component_tax_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = []; pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const savedFetch=globalThis.fetch;
  const savedKeys={TYPESAFE_API_KEY:process.env.TYPESAFE_API_KEY,TYPESAFE_MODEL:process.env.TYPESAFE_MODEL,OPENAI_API_KEY:process.env.OPENAI_API_KEY};
  Object.assign(process.env,{TYPESAFE_API_KEY:'fixture-key',TYPESAFE_MODEL:'fixture-provider',OPENAI_API_KEY:'fixture-unused-key'});
  t.after(()=>{globalThis.fetch=savedFetch;for(const [key,value] of Object.entries(savedKeys)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
  const firmId = 'component-firm', clientId = 'component-client';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic component proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic company','fi',$3)", [clientId,firmId,{jurisdiction:'fi',accounting_system:'none',accounting_basis:'cash'}]);
  await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('fixture-member',$1,'member@example.invalid','Fixture','admin','active')",[firmId]);
  const enrollmentClient=await pool.connect();
  try {await enrollJevExperiment({client:enrollmentClient,firmId,clientId,actorId:'fixture-member',authorityBasis:'Synthetic integration proof',trialId:'component-proof',expiresAt:'2100-01-01',model:'fixture-provider'});}finally{enrollmentClient.release();}
  for (const flag of ['FINLAND_ALV_CODING','JURISDICTION_ACCOUNT_PALETTE','JEV_RECONCILIATION']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'auto','manual')", [flag,firmId,clientId]);
  const fixtures = [
    { id:'mixed', amounts:[2.49,4.99,3.79,2.95,7.99,8.95,1.99], rates:[.255,.255,.255,.255,.255,.14,.14], total:33.15, tax:5.85 },
    { id:'deposit', amounts:[7.95,1.19,2.99,5.99,.62], rates:[.14,.14,.14,.14,0], total:18.74, tax:2.23 },
    { id:'reminder', amounts:[903.6,20], rates:[.255,0], total:923.6, tax:null, expectedTax:183.60, incoming:true },
    { id:'eu-goods', amounts:[320], rates:[0], total:320, tax:0, single:true, taxTreatment:'EU-tavaraosto',taxCode:'ALV_EU_ACQUISITION' },
    { id:'eu-service', amounts:[150], rates:[0], total:150, tax:0, single:true, taxTreatment:'EU-palveluosto',taxCode:'ALV_EU_SERVICE_ACQUISITION' },
    { id:'eu-small-service', amounts:[13.6], rates:[0], total:13.6, tax:0, single:true, taxTreatment:'EU-palveluosto',taxCode:'ALV_EU_SERVICE_ACQUISITION' },
    { id:'eu-components', amounts:[135,89,96], rates:[0,0,0], total:320, tax:0, taxTreatment:'EU-tavaraosto',taxCode:'ALV_EU_ACQUISITION' }
  ];
  for (const f of fixtures) {
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values($1,$2,$3,'2025-02-21',$1,$4,$5,'EUR','needs_review',null,'{}')", [f.id,firmId,clientId,f.incoming?f.total:0,f.incoming?0:f.total]);
    if (f.id === 'mixed') {
      globalThis.fetch=async (endpoint,init)=>{
        assert.match(String(endpoint),/api\.typesafe\.ai/);
        const request=JSON.parse(init.body);
        const answers=Object.fromEntries(Object.entries(request.questions).map(([key,question])=>{
          const keys=Object.keys(question.criteria);
          const choice=keys.includes('resolve_immaterial')?'resolve_immaterial':keys.includes('immaterial')?'immaterial':keys[0];
          return [key,{type:'choice',choice,confidence:.8,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?.8:.2/(keys.length-1)]))}];
        }));
        return new Response(JSON.stringify({model:'fixture-provider',usage:{input_tokens:1,output_tokens:1},answers}),{status:200,headers:{'content-type':'application/json'}});
      };
      const disposition=await runBankLineDispositionForTransaction({client:pool,firmId,clientId,transactionId:f.id,jevEnabled:true});
      assert.equal(disposition.disposition,'auto_explain');
      await applyConvergenceState(pool,{firmId,transactionId:f.id});
      const pending=(await pool.query('select coding_state,convergence_state,convergence_reason,reconciliation_status from transactions where id=$1',[f.id])).rows[0];
      assert.equal(pending.reconciliation_status,'explained');
      assert.equal(pending.coding_state,null);
      assert.equal(pending.convergence_state,'hanging');
      assert.equal(pending.convergence_reason,'explained_but_uncoded');
    }
    await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,parse_summary,payload) values($1,$2,$3,$1,$4,'completed',$5,$6,'EUR','2025-02-21',$7,'{}')", ['doc-'+f.id,firmId,clientId,f.incoming?'sales_invoice':f.id==='deposit'?'receipt':'supplier_bill',f.total,f.tax,{line_amounts_include_tax:true,totals_validation:{matches:true}}]);
    for (let i=0;i<f.amounts.length;i++) await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,$4,$5,'Synthetic component',$6,$7)", [`line-${f.id}-${i}`,firmId,clientId,'doc-'+f.id,i+1,f.amounts[i],{raw_extraction:{amount:f.amounts[i],tax_rate:f.rates[i]}}]);
    await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.9,'auto_matched','fixture','{}')", ['match-'+f.id,firmId,clientId,f.id,f.incoming?'sales_invoice':f.id==='deposit'?'receipt':'supplier_bill','doc-'+f.id,f.total]);
    await pool.query("update transactions set reconciliation_status='reconciled',account_code='Revenue' where id=$1",[f.id]);
    await applyConvergenceState(pool,{firmId,transactionId:f.id});
    assert.deepEqual((await pool.query('select convergence_state,convergence_reason from transactions where id=$1',[f.id])).rows[0],{convergence_state:'hanging',convergence_reason:'matched_but_uncoded'});
    const document = await currentCodingEvidence({client:pool,firmId,clientId,transactionId:f.id});
    assert.equal(document.lines.length,f.amounts.length); assert.equal(document.lines[0].raw_extraction.tax_rate,f.rates[0]);
    if (f.id === 'deposit') {
      const wrong = {proposed_account:'Vähennettävä arvonlisävero',tax_treatment:'ALV 14 %',posting_requirement:'document_allocation',
        evidence_digest:codingEvidenceDigest(document),document_allocations:f.amounts.map((_,i)=>({line_handle:`line_${i+1}`,
          account:i<4?'Vähennettävä arvonlisävero':'Operating supplies',tax_treatment:i<4?'ALV 14 %':'Veroton toiminta (ALV-vapaa)'}))};
      await pool.query("update transactions set coding_state='applied',payload=$2 where id=$1",[f.id,{proposed_account:wrong.proposed_account,tax_treatment:wrong.tax_treatment,ai_suggestion:wrong,ai_suggestion_status:'auto_applied'}]);
      await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:f.id,dryRun:false}),{code:'TRANSACTION_DOCUMENT_ALLOCATION_ACCOUNT_CONFLICT'});
      assert.equal((await pool.query('select count(*)::int n from ledger_journals where source_id=$1',[f.id])).rows[0].n,0);
      const wrongSales={...wrong,proposed_account:'Sales',document_allocations:wrong.document_allocations.map(item=>({...item,account:'Sales'}))};
      await pool.query("update transactions set payload=$2 where id=$1",[f.id,{ai_suggestion:wrongSales,ai_suggestion_status:'auto_applied'}]);
      await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:f.id,dryRun:false}),{code:'TRANSACTION_DOCUMENT_ALLOCATION_ACCOUNT_CONFLICT'});
      assert.equal((await pool.query('select count(*)::int n from ledger_journals where source_id=$1',[f.id])).rows[0].n,0,'purchase receipts cannot post a Sales component');
      await pool.query("update transactions set coding_state=null,payload='{}' where id=$1",[f.id]);
    }
    const account = f.incoming ? 'Sales' : 'Operating supplies';
    const taxes = ['ALV 25,5 %','ALV 14 %','Veroton toiminta (ALV-vapaa)'];
    const calls=[];
    globalThis.fetch=async (endpoint,init)=>{
      calls.push(String(endpoint));assert.match(String(endpoint),/api\.typesafe\.ai/);
      const request=JSON.parse(init.body);
      const answers=Object.fromEntries(Object.entries(request.questions).map(([key,question])=>{
        const index=Number(/^line_(\d+)/.exec(key)?.[1])-1;
        const criteria=question.criteria,keys=Object.keys(criteria);
        if(key.endsWith('_account') && f.rates[index]>0) assert.ok(!Object.values(criteria).includes('Vähennettävä arvonlisävero'),'tax control is separate from the selected net account');
        const desiredTax=f.taxTreatment || taxes[f.rates[index]===.255?0:f.rates[index]===.14?1:2];
        const choice=key==='decision'?(f.single?'resolved':'document_allocation'):key==='materiality'?'normal':(key==='account'||key.endsWith('_account'))?keys.find(k=>criteria[k]===account):(key==='tax'||key.endsWith('_tax'))?keys.find(k=>criteria[k]===desiredTax):keys[0];
        assert.ok(choice,JSON.stringify({key,criteria,desiredTax}));
        const probability=.42;
        return [key,{type:'choice',choice,confidence:probability,probabilities:Object.fromEntries(keys.map(k=>[k,k===choice?probability:(1-probability)/(keys.length-1)]))}];
      }));
      return new Response(JSON.stringify({model:'fixture-provider',usage:{input_tokens:1,output_tokens:1},answers}),{status:200,headers:{'content-type':'application/json'}});
    };
    if (f.id==='eu-goods') {
      // Frozen replay 2026-09-21: the OP loan notice still asked for the February
      // statement after its journal. The journal answers the source's own
      // settlement asks; a business-purpose ask about the document stays open.
      for (const [id,type] of [['ask-statement','bank_statement'],['ask-purpose','business_purpose']]) await pool.query(
        "insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload,created_by) values($1,$2,$3,'draft',$4,'Synthetic document question',$5,'system')",
        [id,firmId,clientId,type,{document_id:'doc-'+f.id,lane:'needs_human_disposition'}]);
    }
    const batch=await batchSuggestTransactionCodingInDb({firmId,clientIds:[clientId],limit:1,autoApply:true});
    const coded=(await pool.query('select coding_state,payload from transactions where id=$1',[f.id])).rows[0];
    if (f.id==='eu-goods') {
      const asks=Object.fromEntries((await pool.query("select id,status,response_payload from client_evidence_requests where id in ('ask-statement','ask-purpose')")).rows.map(row=>[row.id,row]));
      assert.equal(asks['ask-statement'].status,'resolved');
      assert.equal(asks['ask-statement'].response_payload.superseded_by_transaction_id,f.id);
      assert.equal(asks['ask-purpose'].status,'draft','a business-purpose question is not answered by a settlement');
      const receipt=(await pool.query("select metadata from audit_events where action='evidence_request.superseded_by_coding' and resource_type='document' and resource_id=$1",['doc-'+f.id])).rows;
      assert.equal(receipt.length,1); assert.deepEqual(receipt[0].metadata.evidence_request_ids,['ask-statement']);
    }
    assert.equal(coded.coding_state,'posted',JSON.stringify({batch:batch.transaction_ai_batch,refusal:coded.payload.ledger_post_refusal}));
    assert.equal(coded.payload.ai_suggestion.jev_decision.probability,.42);
    assert.equal(coded.payload.ai_suggestion.confidence,'low');
    assert.equal(coded.payload.ai_suggestion_status,'auto_applied');
    await applyConvergenceState(pool,{firmId,transactionId:f.id});
    assert.equal((await pool.query('select convergence_state from transactions where id=$1',[f.id])).rows[0].convergence_state,'auto_reconciled');
    assert.ok(calls.length>=(f.single?1:2),'the actual coder uses the single or component source plan');
    const journal = (await pool.query("select j.id,l.account_name,l.tax_type,l.debit,l.credit from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.source_id=$1 and j.firm_id=$2 order by l.line_no",[f.id,firmId])).rows;
    assert.ok(journal.length>=(f.single?2:3));
    if(f.taxCode){
      const expenseLines=journal.filter(line=>Number(line.debit)>0);
      assert.ok(expenseLines.every(line=>line.tax_type===f.taxCode));
      assert.equal(Math.round(expenseLines.reduce((sum,line)=>sum+Number(line.debit),0)*100),Math.round(f.total*100),'self-assessed purchases post their entire net base, not a domestic VAT split');
    }
    const vat=journal.filter(l=>/arvonlisävero/.test(l.account_name)).reduce((sum,l)=>sum+Number(f.incoming?l.credit:l.debit),0);
    assert.equal(Math.round(vat*100),Math.round((f.expectedTax??f.tax)*100));
    assert.equal(Math.round(journal.reduce((sum,l)=>sum+Number(l.debit)-Number(l.credit),0)*100),0);
    assert.equal(new Set(journal.map(l=>l.id)).size,1);
  }
});
