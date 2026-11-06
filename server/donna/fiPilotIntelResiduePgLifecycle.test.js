// Full-schema proof of the existing intel writer's bounded pilot recovery.
// Provider bytes are synthetic. No live model, production write or owner send.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,readdir } from 'node:fs/promises';
import pg from 'pg';
import { refreshTransactionIntelForClient } from './db/transactions.js';
import { setLaneDecidingPolicy } from './modelLanePolicy.js';
import { DEFAULT_MODEL } from './reconciliationLlmCore.js';
import { postLedgerAdjustmentInDb,__setFirmDbPoolForTests,__resetFirmDbPoolForTests } from './firmDb.js';
import { runBankLineDispositionForClient } from './bankLineDispositionLlm.js';

const pgUrl=process.env.DONNA_PG_TEST_URL;
test('real PG: scoped intel retirement preserves posted/human evidence and restores the normal disposition worker', {skip:!pgUrl&&'INCOMPLETE: DONNA_PG_TEST_URL required'},async()=>{
  const admin=new pg.Client({connectionString:pgUrl});await admin.connect();
  const name=`donna_fi_intel_${process.pid}_${Date.now()}`;await admin.query(`create database "${name}"`);
  const url=new URL(pgUrl);url.pathname='/'+name;const db=new pg.Client({connectionString:url.toString()});await db.connect();
  const pool=new pg.Pool({connectionString:url.toString()});__setFirmDbPoolForTests(pool);
  try {
    await db.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
      create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
    const dir=new URL('../../db/migrations/',import.meta.url);
    for(const f of(await readdir(dir)).filter(f=>f.endsWith('.sql')).sort())await db.query(await readFile(new URL(f,dir),'utf8'));
    await db.query("insert into firms(id,name,slug) values('f','Fixture','fi-intel-fixture');insert into clients(id,firm_id,company_name,jurisdiction,entity_type) values('c','f','Fixture Oy','FI','fi-oy')");
    await db.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,vendor_name,total_amount,currency,document_date)
      values('doc','f','c','fictional-travel.pdf','receipt','completed','ZX',27.80,'EUR','2025-02-11')`);
    await db.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,payload)
      values('pending','f','c','2025-02-12','CZX statutory levy',36.20,'EUR','{}'),
      ('posted','f','c','2025-02-12','Completed control',51,'EUR','{"category":"Preserve","tax_treatment":"Preserve"}')`);
    // The production writer, not a preseeded false match: substring vendor
    // overlap fabricates an unrelated 0.68 suggestion in an unseated book.
    await refreshTransactionIntelForClient({client:db,firmId:'f',clientId:'c'});
    const bad=(await db.query("select id,match_confidence,payload->'authorization' as authorization from reconciliation_matches where bank_transaction_id='pending'")).rows;
    assert.equal(bad.length,1);assert.equal(Number(bad[0].match_confidence),0.68);assert.equal(bad[0].authorization,null);
    await db.query("update transactions set coding_state='posted',category='Preserve',account_code='Preserve',payload=$1 where id='posted'",[{category:'Preserve',tax_treatment:'Preserve',ai_suggestion:{proposed_account:'Preserve'}}]);
    const mk=async(id,tx,status,source,authorization=null)=>db.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,created_by,payload)
      values($1,'f','c',$2,'receipt',$1,$3,'system',$4)`,[id,tx,status,{...(source===null?{}:{source}),...(authorization?{authorization}:{})}]);
    await mk('old-posted','posted','suggested','transaction_intel');
    await mk('human-confirmed','posted','confirmed','transaction_intel');
    await mk('human-rejected','posted','rejected','transaction_intel');
    await mk('automatic','posted','auto_matched','transaction_intel');
    await mk('governed','posted','suggested','receipt_reconciliation_llm');
    await mk('unknown-source','posted','suggested',null);
    await mk('authorized','posted','suggested','transaction_intel',{reasons:['above_materiality_ceiling']});
    await mk('authorization-child','posted','suggested','transaction_intel');
    await mk('credit-child','posted','suggested','transaction_intel');
    await db.query(`insert into reconciliation_authorization_requests(id,firm_id,client_id,bank_transaction_id,match_id,matched_object_type,matched_object_id,match_amount,currency)
      values('protected-authorization','f','c','posted','authorization-child','receipt','doc',51,'EUR');
      insert into documents(id,firm_id,client_id,filename,document_type) values('credit','f','c','credit.pdf','receipt');
      insert into document_credit_applications(id,firm_id,client_id,credit_document_id,invoice_document_id,amount,currency,settlement_match_id)
      values('protected-credit','f','c','credit','doc',1,'EUR','credit-child')`);
    await db.query(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,status,payload)
      values('protected-ask-case','f','c','transaction','posted','fixture','open','{"source":"transaction_intel","transaction_id":"posted"}');
      insert into client_evidence_requests(id,firm_id,client_id,transaction_id,review_item_id,status,question)
      values('protected-ask','f','c','posted','protected-ask-case','open','Existing owner fact question')`);
    const snapshot=async()=>({posted:(await db.query("select row_to_json(t)::text as value from transactions t where id='posted'")).rows,
      protected:(await db.query("select row_to_json(m)::text as value from reconciliation_matches m where id in ('human-confirmed','human-rejected','automatic','governed','unknown-source','authorized','authorization-child','credit-child') order by id")).rows,
      review:(await db.query("select row_to_json(q)::text as value from transaction_review_queue q where id='protected-ask-case'")).rows,
      authorization:(await db.query('select row_to_json(a)::text as value from reconciliation_authorization_requests a order by id')).rows,
      credits:(await db.query('select row_to_json(a)::text as value from document_credit_applications a order by id')).rows,
      journals:(await db.query('select row_to_json(j)::text as value from ledger_journals j order by id')).rows,
      asks:(await db.query('select row_to_json(a)::text as value from client_evidence_requests a order by id')).rows});
    await postLedgerAdjustmentInDb({firmId:'f',clientId:'c',actorId:'fixture-operator',journalDate:'2025-02-12',reason:'Synthetic preservation control',reverseOriginal:false,
      lines:[{account_name:'Fixture bank',account_type:'asset',canonical_role:'asset.bank',debit:51,credit:0,currency:'EUR'},
        {account_name:'Fixture revenue',account_type:'revenue',canonical_role:'revenue.sales',debit:0,credit:51,currency:'EUR',tax_type:'NONE'}]});
    const before=await snapshot();
    assert.equal(before.journals.length,1);assert.equal(before.asks.length,1);
    await assert.rejects(refreshTransactionIntelForClient({client:db,firmId:'f',clientId:'c',retireSuggestedResidueOnly:true}),{code:'INTEL_GOVERNED_LANE_REQUIRED'});
    let calls=0;const fetchImpl=async()=>{calls++;return {ok:true,status:200,json:async()=>({model:DEFAULT_MODEL,content:[{type:'text',text:JSON.stringify({disposition:'statutory_payment',line_identified:true,materiality:'normal',expense_kind:'tax',confidence:0.98,reasoning:'A statutory liability remittance identified by the bank source.'})}]})};};
    const tick=()=>runBankLineDispositionForClient({client:db,firmId:'f',clientId:'c',enabledOverride:true,apiKeyOverride:'fixture',fetchImpl});
    assert.equal((await tick()).evaluated,0,'the unrelated legacy link suppresses normal disposition admission');
    // Joining an existing transaction must never commit its caller's writes.
    await db.query('begin');
    await setLaneDecidingPolicy({client:db,firmId:'f',clientId:'c',laneId:'reconciliation_reasoning',decidingModel:DEFAULT_MODEL,actorType:'firm_member',actorId:'operator',manageTransaction:false});
    await db.query('rollback');assert.equal((await db.query('select count(*)::int n from model_lane_policy')).rows[0].n,0);
    await setLaneDecidingPolicy({client:db,firmId:'f',clientId:'c',laneId:'reconciliation_reasoning',decidingModel:DEFAULT_MODEL,actorType:'firm_member',actorId:'operator'});
    await assert.rejects(refreshTransactionIntelForClient({client:db,firmId:'f',clientId:'c',retireSuggestedResidueOnly:true}),{code:'INTEL_RETIREMENT_AUTHORITY_REQUIRED'});
    const staging=(await db.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values('f','c','firm_member','operator','pilot.processing.staged','client','c','{"review_digest":"fixture-review","authority_basis":"active_member_confirmed_exact_client_configuration"}') returning id`)).rows[0];
    const retirementAuthority={actorId:'operator',receiptId:Number(staging.id),reviewDigest:'fixture-review'};
    await assert.rejects(refreshTransactionIntelForClient({client:db,firmId:'f',clientId:'c',retireSuggestedResidueOnly:true,retirementAuthority:{...retirementAuthority,actorId:'other'}}),{code:'INTEL_RETIREMENT_AUTHORITY_REQUIRED'});
    // Independent connection inserts new parents after each locking SELECT.
    // The later DELETE may only touch the IDs actually locked, even without
    // a child yet; another writer can own those newly arrived rows.
    const raceClient={query:async(sql,args)=>{
      if(sql.startsWith('delete from reconciliation_matches m')) await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,created_by,payload)
        values('late-match','f','c','posted','receipt','doc','suggested','system','{"source":"transaction_intel"}')`);
      if(sql.startsWith('delete from transaction_review_queue q')) await pool.query(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,status,payload)
        values('late-review','f','c','transaction','late-anchor','fixture','open','{"source":"transaction_intel","transaction_id":"posted"}')`);
      return db.query(sql,args);
    }};
    await db.query('begin');const recovered=await refreshTransactionIntelForClient({client:raceClient,firmId:'f',clientId:'c',retireSuggestedResidueOnly:true,retirementAuthority});await db.query('commit');
    assert.equal((await db.query("select count(*)::int n from reconciliation_matches where id='late-match'")).rows[0].n,1);
    assert.equal((await db.query("select count(*)::int n from transaction_review_queue where id='late-review'")).rows[0].n,1);
    // Remove only this race fixture before the separate idempotence assertion.
    await db.query("delete from reconciliation_matches where id='late-match';delete from transaction_review_queue where id='late-review'");
    assert.equal(recovered.retired_matches,2);assert.deepEqual(await snapshot(),before,'no enrichment/coding, protected match, ask or journal mutation');
    const receipt=(await db.query("select actor_type,actor_id,metadata from audit_events where action='transaction_intel.stepped_aside'")).rows[0];
    assert.equal(receipt.actor_type,'firm_member');assert.equal(receipt.actor_id,'operator');
    assert.equal(receipt.metadata.processing_receipt_id,retirementAuthority.receiptId);assert.equal(receipt.metadata.review_digest,'fixture-review');
    assert.equal(receipt.metadata.authority_basis,'active_member_confirmed_exact_client_configuration');
    const result=await tick();assert.equal(result.evaluated,1);assert.equal(result.statutory_payment,1);assert.equal(calls,1);
    assert.equal((await db.query("select payload->>'bank_line_disposition' as d from transactions where id='pending'")).rows[0].d,'statutory_payment');
    assert.equal((await tick()).evaluated,0);assert.equal(calls,1);
    await db.query('begin');assert.equal((await refreshTransactionIntelForClient({client:db,firmId:'f',clientId:'c',retireSuggestedResidueOnly:true,retirementAuthority})).retired_matches,0);await db.query('commit');
    assert.deepEqual(await snapshot(),before);
  } finally {__resetFirmDbPoolForTests();await pool.end();await db.end();await admin.query(`drop database "${name}" with(force)`);await admin.end();}
});
