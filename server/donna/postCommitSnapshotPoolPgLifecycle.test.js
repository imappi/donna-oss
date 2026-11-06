import test from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { createManualReconciliationMatchInDb, updateReconciliationMatchInDb } from './db/reconcile.js';
import { postLedgerTransactionInDb } from './db/ledger.js';
import { ensureTransactionReviewItemInDb, updateTransactionReviewItemInDb } from './db/coding.js';

test('real PG max-two pool: concurrent committed writers release before canonical snapshots, with no duplicate writes', {
  skip: !process.env.DONNA_PG_TEST_URL && 'INCOMPLETE: DONNA_PG_TEST_URL required', timeout:30000
}, async t => {
  const admin = new pg.Client({connectionString:process.env.DONNA_PG_TEST_URL}); await admin.connect();
  const name=`donna_postcommit_pool_${process.pid}_${Date.now()}`; await admin.query(`create database "${name}"`);
  const url=new URL(process.env.DONNA_PG_TEST_URL);url.pathname='/'+name;
  const seed=new pg.Client({connectionString:url.toString()});await seed.connect();
  const pool=new pg.Pool({connectionString:url.toString(),max:2,connectionTimeoutMillis:1000});
  const closed=[];let barrier=null;let failAfterNextCommit=null,snapshotAcquireError=null;let barrierPosting=false;
  pool.on('connect',client=>{
    closed.push(new Promise(resolve=>client.once('end',resolve)));
    const query=client.query;let wroteJournal=false;
    client.query=function(...args){
      if(/insert\s+into\s+ledger_journals/i.test(String(args[0])))wroteJournal=true;
      const result=query.apply(this,args);
      if(String(args[0]).trim().toLowerCase()!=='commit')return result;
      const journalCommit=wroteJournal;wroteJournal=false;
      if(failAfterNextCommit&&journalCommit){const error=failAfterNextCommit;failAfterNextCommit=null;return Promise.resolve(result).then(value=>{snapshotAcquireError=error;return value;});}
      if(!barrier||(barrierPosting&&!journalCommit))return result;
      const current=barrier;
      return Promise.resolve(result).then(async value=>{await current.arrive();return value;});
    };
  });
  __setFirmDbPoolForTests(pool);
  const previousDatabase=process.env.DATABASE_URL;process.env.DATABASE_URL=url.toString();
  t.after(async()=>{
    barrier=null;__resetFirmDbPoolForTests();
    if(previousDatabase===undefined)delete process.env.DATABASE_URL;else process.env.DATABASE_URL=previousDatabase;
    await pool.end();await Promise.all(closed);await seed.end();await admin.query(`drop database "${name}"`);await admin.end();
  });
  await seed.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const root=new URL('../../db/migrations/',import.meta.url);
  for(const file of (await readdir(root)).filter(file=>file.endsWith('.sql')).sort())await seed.query(await readFile(new URL(file,root),'utf8'));
  installConvergenceSettleOnPool(pool);
  const connect=pool.connect.bind(pool);
  pool.connect=(...args)=>{if(snapshotAcquireError){const error=snapshotAcquireError;snapshotAcquireError=null;return Promise.reject(error);}return connect(...args);};
  const firmId='pool-proof',clientId='pool-proof-client';
  await seed.query("insert into firms(id,name,slug) values($1,'Pool proof',$1)",[firmId]);
  await seed.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Pool proof Oy','FI','fi-oy',$3)",[clientId,firmId,{jurisdiction:"FI",accounting_system:"none",accounting_basis:"accrual"}]);
  const add=async id=>{
    await seed.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,status,payload) values($1,$2,$3,'2025-01-10','Rent',600,'EUR','needs_review','{}')",[id,firmId,clientId]);
    await seed.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,payload) values($1,$2,$3,$1,'supplier_bill','completed',600,'EUR','2025-01-03','{}')",['doc-'+id,firmId,clientId]);
    await seed.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'supplier_bill',$5,600,.95,'suggested','fixture','{}')",['match-'+id,firmId,clientId,id,'doc-'+id]);
  };
  const synchronizeCommits=()=>{
    let count=0,release;const gate=new Promise(resolve=>{release=resolve;});
    const timeout=setTimeout(()=>release(),5000);
    barrier={arrive:async()=>{if(++count===2){barrier=null;clearTimeout(timeout);release();}await gate;}};
  };
  const outcomes=[];
  for(const kind of ['confirm','manual','group','review']){
    const ids=[`${kind}-a`,`${kind}-b`];
    for(const id of ids){await add(id);if(kind==='group')await add(id+'-second');}
    const reviewIds=kind==='review'?await Promise.all(ids.map(transactionId=>ensureTransactionReviewItemInDb({firmId,clientId,transactionId}))):[];
    synchronizeCommits();
    const results=await Promise.allSettled(ids.map((id,index)=>{
      const common={firmId,clientId,actorId:'real-fixture-operator',captureBeforeState:true};
      if(kind==='confirm')return updateReconciliationMatchInDb({...common,matchId:'match-'+id,patch:{status:'confirmed'}});
      if(kind==='manual')return createManualReconciliationMatchInDb({...common,bankTransactionId:id,documentId:'doc-'+id});
      if(kind==='group')return createManualReconciliationMatchInDb({...common,pairings:[{transaction_id:id,document_id:'doc-'+id},{transaction_id:id+'-second',document_id:'doc-'+id+'-second'}]});
      return updateTransactionReviewItemInDb({...common,reviewItemId:reviewIds[index],patch:{status:'resolved',reviewer_note:'Observed current evidence.'}});
    }));
    barrier=null;
    const failures=results.flatMap(result=>result.status==='rejected'?[result.reason.message]:[]);
    outcomes.push({kind,failures});
    for(const result of results)if(result.status==='fulfilled')assert.ok(result.value.snapshot?.clients.some(client=>client.id===clientId),'response remains the canonical firm snapshot');
    if(kind!=='review'){
      const matched=(await seed.query("select id,status from reconciliation_matches where id like $1",['match-'+kind+'-%'])).rows;
      assert.equal(matched.length,kind==='group'?4:2);assert.ok(matched.every(row=>row.status==='confirmed'));
      const receipts=(await seed.query("select resource_id,count(*)::int n from audit_events where action='reconciliation_match.update' and resource_id like $1 group by resource_id",['match-'+kind+'-%'])).rows;
      assert.equal(receipts.length,matched.length);assert.ok(receipts.every(row=>row.n===1),'exactly one mutation audit despite response concurrency');
    }
  }
  assert.equal((await seed.query('select count(*)::int n from ledger_journals')).rows[0].n,0,'reconciliation never manufactures a journal');
  const postingIds=['posting-a','posting-b'];
  await seed.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values('pool-fi-tax',$1,$2,'FINLAND_ALV_CODING','auto','manual')",[firmId,clientId]);
  for(const id of postingIds){
    await add(id);
    await seed.query("update reconciliation_matches set status='confirmed' where id=$1",['match-'+id]);
    await seed.query("update transactions set coding_state='applied',category='Rent',payload=$2 where id=$1",[id,{category:'Rent',account_name:'Rent',proposed_account:'Rent',tax_treatment:'Veroton toiminta (ALV-vapaa)',review_state:'accepted'}]);
  }
  barrierPosting=true;synchronizeCommits();
  const posted=await Promise.allSettled(postingIds.map(transactionId=>postLedgerTransactionInDb({firmId,clientId,transactionId,dryRun:false,actorId:'real-fixture-operator'})));
  barrier=null;barrierPosting=false;
  outcomes.push({kind:'posting',failures:posted.flatMap(result=>result.status==='rejected'?[result.reason.message]:[])});
  for(const result of posted)if(result.status==='fulfilled')assert.ok(result.value.snapshot?.clients.some(client=>client.id===clientId));
  const journals=(await seed.query("select j.id,j.source_id,j.status,sum(l.debit)::numeric total_debit,sum(l.credit)::numeric total_credit from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.client_id=$2 group by j.id order by j.source_id",[firmId,clientId])).rows;
  assert.equal(journals.length,2,JSON.stringify(outcomes));assert.ok(journals.every(j=>j.status==='posted'&&Number(j.total_debit)===600&&Number(j.total_credit)===600));
  const beforeReplay=JSON.stringify((await seed.query('select * from ledger_lines order by id')).rows);
  for(const transactionId of postingIds)await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId,dryRun:false,actorId:'real-fixture-operator',skipSnapshot:true}),{code:'LEDGER_ALREADY_POSTED'});
  assert.equal(JSON.stringify((await seed.query('select * from ledger_lines order by id')).rows),beforeReplay,'replay never changes or duplicates posted journal lines');
  assert.deepEqual(outcomes,[{kind:'confirm',failures:[]},{kind:'manual',failures:[]},{kind:'group',failures:[]},{kind:'review',failures:[]},{kind:'posting',failures:[]}]);
  // A response read may still fail independently after a successful commit. It
  // must not invent a posting refusal, roll back history, or duplicate on replay.
  await add('snapshot-read-failure');
  await seed.query("update reconciliation_matches set status='confirmed' where id='match-snapshot-read-failure'");
  await seed.query("update transactions set coding_state='applied',category='Rent',payload=$1 where id='snapshot-read-failure'",[{category:'Rent',account_name:'Rent',proposed_account:'Rent',tax_treatment:'Veroton toiminta (ALV-vapaa)',review_state:'accepted'}]);
  const readFailure=Object.assign(new Error('Response snapshot unavailable'),{code:'PROOF_SNAPSHOT_READ_FAILED'});
  failAfterNextCommit=readFailure;
  await assert.rejects(postLedgerTransactionInDb({firmId,clientId,transactionId:'snapshot-read-failure',dryRun:false,actorId:'real-fixture-operator'}),error=>error===readFailure);
  assert.equal((await seed.query("select count(*)::int n from ledger_journals where source_id='snapshot-read-failure' and status='posted'")).rows[0].n,1);
  assert.equal((await seed.query("select count(*)::int n from audit_events where action='ledger.auto_post_refused' and resource_id='snapshot-read-failure'")).rows[0].n,0);
  assert.equal((await seed.query("select payload ? 'ledger_post_refusal' refused from transactions where id='snapshot-read-failure'")).rows[0].refused,false);
  // A real writer rejection still rolls back and returns its original cause.
  await assert.rejects(updateReconciliationMatchInDb({firmId,matchId:'missing',patch:{status:'confirmed'}}),/not found/i);
  await assert.rejects(createManualReconciliationMatchInDb({firmId,clientId,pairings:[{transaction_id:'group-a',document_id:'doc-group-a'},{transaction_id:'group-a-second',document_id:'doc-group-a-second'}],actorId:'real-fixture-operator'}),/changed after proposal/i);
  assert.equal(pool.totalCount,2);assert.equal(pool.waitingCount,0);
});
