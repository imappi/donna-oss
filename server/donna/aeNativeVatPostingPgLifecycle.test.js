import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, lockClosePeriodInDb } from './firmDb.js';
import { __prepareLedgerTransactionPosting, __commitPreparedLedgerPosting, postLedgerJournalForTransaction } from './db/ledger.js';
import { rowToTransactionPayload } from './db/transactions.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { writebackXeroTransactionInDb } from './db/xero.js';
import { sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { updateTransactionReviewItemInDb, upsertLedgerAccountForJournal } from './firmDb.js';
import { listRuntimePolicyIncidents, claimRuntimePolicyIncident, requestRuntimePolicyIncidentRetry, completeRuntimePolicyIncidentRetry } from './runtimePolicyIncidentDb.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { recordAeVatPeriod } from './ae/vatPeriods.js';
import { prepareAeVatReturnFromDb } from './ae/vatReturnRoute.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('U08-S2 real PG: native standard VAT intake, posting, statutory receipt and recovery', async (t) => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL; AE safety proof cannot skip.');
  const name = `donna_ae_native_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  // pg-pool can finish end() after removing its clients but before their
  // sockets close. Await each protocol shutdown before dropping the database;
  // DROP ... FORCE can otherwise kill an idle socket still emitting errors.
  const connectionsClosed = [];
  pool.on('connect', (connection) => {
    connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve)));
  });
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
  for (const file of (await readdir(migrationRoot)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }

  const firmId='native-firm', clientId='native-client', actorId='native-member';
  await pool.query("insert into firms(id,name,slug) values($1,'Native fixture','native-fixture')",[firmId]);
  await pool.query("insert into firm_members(id,firm_id,name,email,status) values($1,$2,'Fixture owner','native@example.test','active')",[actorId,firmId]);
  const profile={jurisdiction:'ae',accounting_system:'none',accountingBasis:'cash',
    vat_registration:{status:'registered',registered_from:'2026-01-01',vat_registration_number:'100123456789012'},
    ae_establishment:{emirate:'DXB',qualifying_ecommerce_registrant:false}};
  await pool.query('insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,$3,$4,$5)',[clientId,firmId,'Native fixture','ae',profile]);
  for (const flag of ['JURISDICTION_TAX_CODING','LEDGER_AUTO_POST']) await pool.query(
    "insert into client_capability_config(id,firm_id,client_id,flag_key,stage) values($1,$2,$3,$1,'auto')",[flag,firmId,clientId]);
  for (const account of [
    {code:'bank',name:'Bank',type:'bank',normal_balance:'debit'},
    {code:'sales',name:'Sales',type:'revenue',normal_balance:'credit'},
    {code:'cost',name:'Operating expenses',type:'expense',normal_balance:'debit'},
    {code:'vat',name:'VAT control',type:'liability',normal_balance:'credit',canonical_role:'liability.sales_tax_payable'}
  ]) await upsertLedgerAccountForJournal({client:pool,firmId,clientId,account,currency:'AED'});
  // Role is a chart fact installed through the existing chart writer, not a journal.
  assert.equal((await pool.query("select canonical_role from ledger_accounts where code='vat'")).rows[0].canonical_role,'liability.sales_tax_payable');
  const policy=codingPolicyReceipt(resolveCodingPolicy({jurisdiction:'ae',businessDate:'2026-09-09',accountingSystem:'none'}));
  const facts=(id,out=false)=>({document_id:`doc-${id}`,explanation:'Synthetic retained tax invoice and explicit business-use confirmation.',
    supply_class:'ordinary_domestic',payment_method:'bank_transfer',fully_paid:true,invoice_validity:'confirmed',
    direction:out?'in':'out',date_of_supply:'2026-09-09',reporting_date:'2026-09-09',taxable_amount:'100.00',vat_amount:'5.00',
    ...(out?{input_recovery:{basis:'direct_taxable',recovery_bps:10000,blocked:false,personal_use:false,
      supply_integrity:'verified',verification_evidence:'Synthetic supplier identity, registration and supply verification evidence.'}}:{})});
  const seed=async(id,{out=false,accept=true,factPatch={}}={})=>{
    await pool.query(`insert into documents(id,firm_id,client_id,document_type,document_date,currency,total_amount,tax_amount,parse_status,filename)
      values($1,$2,$3,$4,'2026-09-09','AED',105,5,'completed','native-fixture.pdf')`,[`doc-${id}`,firmId,clientId,out?'supplier_bill':'sales_invoice']);
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values($1,$2,$3,'2026-09-09','Native fixture',$4,$5,'AED','needs_review','applied',$6)`,[id,firmId,clientId,out?0:105,out?105:0,
      {ai_suggestion:{proposed_account:out?'Operating expenses':'Sales',account_code:out?'cost':'sales',
        tax_treatment:'VAT 5% (standard rated)',confidence:'high',coding_policy:policy}}]);
    await pool.query(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values($1,$2,$3,'transaction',$4,'fixture','normal','open',$5)`,[`review-${id}`,firmId,clientId,id,{transaction_id:id}]);
    if(accept) await acceptFacts(id,{...facts(id,out),...factPatch});
  };
  const acceptFacts=(id,value,businessDate='2026-09-09')=>updateTransactionReviewItemInDb({firmId,reviewItemId:`review-${id}`,actorId,returnSnapshot:false,distillFactsFn:async()=>[],
    patch:{status:'resolved',review_state:'accepted',tax_posting_facts:value, coding_policy:codingPolicyReceipt(resolveCodingPolicy({jurisdiction:'ae',businessDate,accountingSystem:'none'}))}});
  const post=(id,dryRun=false,force=false)=>postLedgerTransactionInDb({firmId,clientId,transactionId:id,actorId,dryRun,force,skipSnapshot:true});
  const row=async id=>(await pool.query('select * from transactions where id=$1',[id])).rows[0];
  const lines=async id=>(await pool.query(`select l.account_code,l.tax_type,l.debit,l.credit,l.payload->>'role' role
    from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id=$1 order by l.line_no`,[id])).rows;
  const noJournal=async id=>assert.equal((await lines(id)).length,0);
  const call=async(fn,args={})=>{const c=await pool.connect();try{return await fn({client:c,firmId,...args});}finally{c.release();}};
  await t.test('real attributed correction → preview → commit → exact source-to-VAT201 once',async()=>{
    for(const [id,out] of [['sale',false],['purchase',true]]){
      await seed(id,{out});
      const bound=(await row(id)).payload.tax_posting_facts;
      assert.equal(bound.actor_id,actorId);assert.equal(bound.authority_basis,'transaction_review_correction');
      assert.ok(bound.evidence_digest);
      const preview=await post(id,true);await noJournal(id);
      assert.equal(preview.ledger_posting.ledger_journal.lines.length,3);
      await post(id);
      const expected=out?[['cost','AE_VAT_SR_5_INPUT',100,0],['vat','NONE',5,0],['bank','NONE',0,105]]
        :[['bank','NONE',105,0],['sales','AE_VAT_SR_5_OUTPUT',0,100],['vat','NONE',0,5]];
      assert.deepEqual((await lines(id)).map(l=>[l.account_code,l.tax_type,Number(l.debit),Number(l.credit)]),expected);
      await assert.rejects(post(id),{code:'LEDGER_ALREADY_POSTED'});
      const journal=(await pool.query('select * from ledger_journals where source_id=$1',[id])).rows[0];
      assert.equal(journal.payload.tax_point.date_of_supply,'2026-09-09');
      assert.equal(journal.payload.tax_point.actor_id,actorId);
      await post(id,false,true);
      assert.equal((await pool.query('select count(*)::int n from ledger_journals where source_id=$1',[id])).rows[0].n,1);
      assert.equal((await lines(id)).length,3);
    }
    await call(recordAeVatPeriod,{clientId,registration:profile.vat_registration,periodKey:'2026-Q3',
      startDate:'2026-07-01',endDate:'2026-09-30',dueDate:'2026-10-28',recordedBy:actorId,source:'Synthetic assigned period'});
    const result=await prepareAeVatReturnFromDb({firmId,clientId,periodKey:'2026-Q3'});
    assert.deepEqual(result.vatReturn.fields.standard_rated_supplies.total,{amount:100,vat:5});
    assert.deepEqual(result.vatReturn.fields.standard_rated_expenses,{amount:100,recoverable_vat:5});
    assert.equal(result.vatReturn.netVat,0);
  });
  await t.test('unsupported and incomplete factual contracts refuse without journal effects',async()=>{
    for(const [id,patch,code,out] of [
      ['cash',{payment_method:'cash'},'SCOPE_UNSUPPORTED',true],
      ['dates',{date_of_supply:'2026-09-08'},'TAX_POINT_UNSUPPORTED',false],
      ['overflow-supply',{date_of_supply:'2026-02-30'},'TAX_POINT_UNSUPPORTED',false],
      ['overflow-report',{reporting_date:'2026-04-31'},'TAX_POINT_UNSUPPORTED',true],
      ['report-date',{reporting_date:'2026-10-01'},'TAX_POINT_UNSUPPORTED',true],
      ['partial',{input_recovery:{basis:'direct_taxable',recovery_bps:5000}},'RECOVERY_UNSUPPORTED',true],
      ['no-recovery',{input_recovery:null},'RECOVERY_UNSUPPORTED',true],
      ['pre-reg',{date_of_supply:'2025-12-31'},'TAX_POINT_UNSUPPORTED',false],
      ['blocked',{input_recovery:{basis:'direct_taxable',recovery_bps:10000,blocked:true,personal_use:false,supply_integrity:'verified',verification_evidence:'fixture'}},'RECOVERY_UNSUPPORTED',true],
      ['arithmetic',{vat_amount:'6.00'},'AMOUNT_MISMATCH',false],
      ['scope',{supply_class:'capital_asset'},'SCOPE_UNSUPPORTED',true],
      ['direction',{direction:'in'},'DIRECTION_MISMATCH',false]
    ]){
      await seed(id,{out,factPatch:patch});
      for(const dryRun of [true,false])await assert.rejects(post(id,dryRun),{code:`TRANSACTION_AE_VAT_${code}`});
      await noJournal(id);
    }
    for(const [id,type] of [['wrong-family','supplier_bill'],['generic-receipt','receipt']]){
      await seed(id,{accept:false});
      await pool.query('update documents set document_type=$2 where id=$1',[`doc-${id}`,type]);
      await acceptFacts(id,facts(id));
      await assert.rejects(post(id),{code:'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED'});await noJournal(id);
    }
    await seed('forged',{accept:false});
    await pool.query("update transactions set payload=payload || $2 where id=$1",['forged',{tax_posting_facts:{...facts('forged'),actor_id:actorId,version:1,authority_basis:'transaction_review_correction'}}]);
    await assert.rejects(post('forged'),{code:'TRANSACTION_AE_VAT_FACTS_STALE'});await noJournal('forged');
  });
  await t.test('missing facts create an owned incident; real fact intake and retry recover unchanged treatment',async()=>{
    await seed('retry',{accept:false});await assert.rejects(post('retry'),{code:'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'});
    const incident=(await call(listRuntimePolicyIncidents)).find(i=>i.transaction_id==='retry');assert.ok(incident);
    const principal={principalType:'firm_member',principalId:actorId};
    await call(claimRuntimePolicyIncident,{failureId:incident.failure_id,principal});
    await acceptFacts('retry',facts('retry'));
    const request=await call(requestRuntimePolicyIncidentRetry,{failureId:incident.failure_id,principal,idempotencyKey:'native-facts',repairNote:'Exact retained facts recorded through review correction.'});
    const configSnapshot=await readClientConfigSnapshot(pool,{firmId,clientId});
    const result=await sweepLedgerAutoPost({firmId,clientId,transactionId:'retry',configSnapshot});
    assert.equal(result.posted,1,JSON.stringify(result));
    assert.equal((await row('retry')).payload.ledger_post_refusal,undefined);
    const completion=await call(completeRuntimePolicyIncidentRetry,{failureId:incident.failure_id,principal,requestId:request.request.id});
    assert.equal(completion.outcome,'recovered');
    assert.equal((await call(listRuntimePolicyIncidents)).some(i=>i.transaction_id==='retry'),false);
  });
  await t.test('existing PATCH review endpoint binds the authenticated member and ignores forged receipt identity',async()=>{
    await seed('api',{accept:false});
    const oldToken=process.env.DONNA_ACCESS_TOKEN,oldBlob=process.env.DONNA_DESKTOP_BLOB_DIR;
    process.env.DONNA_ACCESS_TOKEN='native-api-fixture-token';
    process.env.DONNA_DESKTOP_BLOB_DIR='/tmp/u08-s2-api-evidence';
    try{
      await pool.query("update firm_members set role='viewer' where id=$1",[actorId]);
      const denied=await requestDonnaApi({pool,method:'PATCH',url:'/api/donna/firms/transaction-review/review-api',
        headers:{authorization:'Bearer native-api-fixture-token'},body:{firm_id:firmId,patch:{status:'resolved',review_state:'accepted',tax_posting_facts:facts('api')}}});
      assert.equal(denied.statusCode,403,JSON.stringify(denied.json));
      __setFirmDbPoolForTests(pool);assert.equal((await row('api')).payload.tax_posting_facts,undefined);
      await pool.query("update firm_members set role='owner' where id=$1",[actorId]);
      const result=await requestDonnaApi({pool,method:'PATCH',url:'/api/donna/firms/transaction-review/review-api',
        headers:{authorization:'Bearer native-api-fixture-token'},
        body:{firm_id:firmId,patch:{status:'resolved',review_state:'accepted',tax_posting_facts:{...facts('api'),actor_id:'forged',authority_basis:'forged',source:{id:'forged'}}}}});
      assert.equal(result.statusCode,200,JSON.stringify(result.json));
      __setFirmDbPoolForTests(pool);
      assert.equal((await row('api')).payload.tax_posting_facts.actor_id,actorId);
      await post('api');assert.equal((await lines('api')).length,3);
    }finally{
      await pool.query("update firm_members set role='owner' where id=$1",[actorId]);
      __setFirmDbPoolForTests(pool);
      if(oldToken===undefined)delete process.env.DONNA_ACCESS_TOKEN;else process.env.DONNA_ACCESS_TOKEN=oldToken;
      if(oldBlob===undefined)delete process.env.DONNA_DESKTOP_BLOB_DIR;else process.env.DONNA_DESKTOP_BLOB_DIR=oldBlob;
    }
  });
  await t.test('native-postable facts never authorize actual Xero preview, token refresh or writeback',async()=>{
    await seed('native-xero');assert.equal((await post('native-xero',true)).ledger_posting.ledger_journal.lines.length,3);
    await pool.query(`insert into xero_connections(id,firm_id,client_id,tenant_id,status,scopes,access_token,refresh_token,expires_at)
      values('native-xero-conn',$1,$2,'fixture-tenant','connected',array['accounting.banktransactions'],'fixture-access','fixture-refresh','2000-01-01')`,[firmId,clientId]);
    for(const [code,name,type] of [['bank','Bank','BANK'],['sales','Sales','REVENUE']])await pool.query(`insert into xero_accounts(id,connection_id,firm_id,client_id,xero_account_id,code,name,type,status,tax_type,payload)
      values($1,'native-xero-conn',$2,$3,$1,$4,$5,$6,'ACTIVE','NONE','{"currency":"AED"}')`,[`xero-${code}`,firmId,clientId,code,name,type]);
    const xeroKeys=['XERO_CLIENT_ID','XERO_CLIENT_SECRET','XERO_REDIRECT_URI'];
    const xeroEnv=Object.fromEntries(xeroKeys.map(k=>[k,process.env[k]]));
    Object.assign(process.env,{XERO_CLIENT_ID:'fixture',XERO_CLIENT_SECRET:'fixture',XERO_REDIRECT_URI:'https://fixture.invalid/callback'});
    const priorFetch=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw new Error('Provider call forbidden');};
    try{
      for(const stage of ['auto','off']){
        await pool.query("update client_capability_config set stage=$1 where flag_key='JURISDICTION_TAX_CODING'",[stage]);
        for(const dryRun of [true,false])await assert.rejects(writebackXeroTransactionInDb({firmId,clientId,
          transactionId:'native-xero',connectionId:'native-xero-conn',actorId,dryRun,skipSnapshot:true}),{code:'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'});
      }
      assert.equal(calls,0);await noJournal('native-xero');
    }finally{globalThis.fetch=priorFetch;for(const k of xeroKeys){if(xeroEnv[k]===undefined)delete process.env[k];else process.env[k]=xeroEnv[k];}await pool.query("update client_capability_config set stage='auto' where flag_key='JURISDICTION_TAX_CODING'");}
  });
  await t.test('source, retained evidence, profile, config and chart changes invalidate a prepared split',async()=>{
    await seed('race');const c=await pool.connect();
    const prepare=()=>__prepareLedgerTransactionPosting({client:c,firmId,clientId,transactionId:'race',dryRun:true});
    const rejectCommit=async prepared=>{await c.query('begin');try{
      await assert.rejects(__commitPreparedLedgerPosting({client:c,firmId,clientId,transactionId:'race',prepared,actorId}));
    }finally{await c.query('rollback');}await noJournal('race');};
    try{
      for(const [change,restore] of [
        ["update transactions set money_in=106 where id='race'","update transactions set money_in=105 where id='race'"],
        ["update documents set checksum_sha256='changed' where id='doc-race'","update documents set checksum_sha256=null where id='doc-race'"],
        ["update documents set storage_object_key='changed' where id='doc-race'","update documents set storage_object_key=null where id='doc-race'"],
        ["update documents set tax_amount=6 where id='doc-race'","update documents set tax_amount=5 where id='doc-race'"],
        ["update ledger_accounts set name='Changed control' where code='vat'","update ledger_accounts set name='VAT control' where code='vat'"],
        ["update client_capability_config set stage='off' where flag_key='JURISDICTION_TAX_CODING'","update client_capability_config set stage='auto' where flag_key='JURISDICTION_TAX_CODING'"],
        ["update clients set profile=jsonb_set(profile,'{accountingBasis}','\"accrual\"') where id='native-client'","update clients set profile=jsonb_set(profile,'{accountingBasis}','\"cash\"') where id='native-client'"]
      ]){const prepared=await prepare();await pool.query(change);await rejectCommit(prepared);await pool.query(restore);}
      const prepared=await prepare();prepared.preview.coding.ae_vat_split.vat=4;
      await rejectCommit(prepared);
      await c.query('begin');try{await assert.rejects(postLedgerJournalForTransaction({client:c,firmId,clientId,
        transaction:prepared.transaction,coding:prepared.preview.coding,bankAccount:prepared.preview.bank_account,actorId}),{code:'TRANSACTION_AE_VAT_FACTS_STALE'});
      }finally{await c.query('rollback');}
      await noJournal('race');
    }finally{c.release();}
    await post('race');
  });
  await t.test('flag off, missing/ambiguous control, unknown account, currency and reused invoice all refuse without effects',async()=>{
    await seed('boundary');
    for(const [change,restore,code] of [
      ["update client_capability_config set stage='off' where flag_key='JURISDICTION_TAX_CODING'","update client_capability_config set stage='auto' where flag_key='JURISDICTION_TAX_CODING'",'POSTING_UNSUPPORTED'],
      ["update ledger_accounts set canonical_role=null where code='vat'","update ledger_accounts set canonical_role='liability.sales_tax_payable' where code='vat'",'CONTROL_UNRESOLVED'],
      ["update ledger_accounts set canonical_role='liability.sales_tax_payable' where code='cost'","update ledger_accounts set canonical_role=null where code='cost'",'CONTROL_UNRESOLVED'],
      ["update ledger_accounts set currency='USD' where code='vat'","update ledger_accounts set currency='AED' where code='vat'",'CONTROL_UNRESOLVED'],
      ["update ledger_accounts set status='archived' where code='sales'","update ledger_accounts set status='active' where code='sales'",'ACCOUNT_UNRESOLVED']
    ]){await pool.query(change);await assert.rejects(post('boundary'),{code:`TRANSACTION_AE_VAT_${code}`});await noJournal('boundary');await pool.query(restore);}
    await pool.query("update transactions set currency='USD' where id='boundary'");
    await acceptFacts('boundary',facts('boundary'));
    await assert.rejects(post('boundary'),{code:'TRANSACTION_AE_VAT_CURRENCY_UNSUPPORTED'});await noJournal('boundary');
    await pool.query("update transactions set currency='AED' where id='boundary'");await acceptFacts('boundary',facts('boundary'));
    await seed('reuse');await acceptFacts('reuse',{...facts('reuse'),document_id:'doc-sale'});
    await assert.rejects(post('reuse'),{code:'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED'});await noJournal('reuse');
    await post('boundary');
  });
  await t.test('legacy unenrolled native sources obey the shared accounting view and method contract',async()=>{
    await seed('accounting-scope');
    for(const bad of [{accounting_view:'statutory_books'},{accounting_view:null},{accountingBasis:null,accounting_basis:'cash'},{accounting_basis:'accrual'}]){
      await pool.query('update clients set profile=$2 where id=$1',[clientId,{...profile,...bad}]);
      await assert.rejects(post('accounting-scope'),{code:'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED'});await noJournal('accounting-scope');
    }
    await pool.query('update clients set profile=$2 where id=$1',[clientId,profile]);
    await post('accounting-scope');
  });
  await t.test('two different invoices post concurrently without chart lock upgrades',async()=>{
    await seed('parallel-a');await seed('parallel-b');
    await Promise.all([post('parallel-a'),post('parallel-b')]);
    assert.equal((await lines('parallel-a')).length,3);assert.equal((await lines('parallel-b')).length,3);
  });
  await t.test('two independent transactions cannot consume the same retained invoice concurrently',async()=>{
    await seed('compete-a');await seed('compete-b');
    await acceptFacts('compete-b',{...facts('compete-b'),document_id:'doc-compete-a'});
    const results=await Promise.allSettled([post('compete-a'),post('compete-b')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED');
    assert.equal((await lines('compete-a')).length+(await lines('compete-b')).length,3);
  });
  await t.test('barrier: native VAT and ordinary exempt NO-FACTS posts use one chart lock order',async()=>{
    await seed('lock-native',{out:true});await seed('lock-ordinary',{out:true,accept:false});
    await updateTransactionReviewItemInDb({firmId,reviewItemId:'review-lock-ordinary',actorId,returnSnapshot:false,distillFactsFn:async()=>[],
      patch:{status:'resolved',review_state:'accepted',tax_treatment:'Exempt supply',xero_tax_type:'AE_VAT_EXEMPT_INPUT'}});
    assert.equal((await row('lock-ordinary')).payload.tax_posting_facts,undefined);
    const ordinary=await pool.connect(),native=await pool.connect();
    let releaseOrdinary,signalExpense;
    const expenseHeld=new Promise(resolve=>{signalExpense=resolve;});
    const continueOrdinary=new Promise(resolve=>{releaseOrdinary=resolve;});
    const wrapped={query:async(...args)=>{
      const result=await ordinary.query(...args);
      if(String(args[0]).includes('insert into ledger_accounts')&&args[1]?.[3]==='cost'){
        signalExpense();await continueOrdinary;
      }
      return result;
    }};
    const prepare=async(c,id)=>__prepareLedgerTransactionPosting({client:c,firmId,clientId,transactionId:id,dryRun:true});
    const pOrdinary=await prepare(ordinary,'lock-ordinary'),pNative=await prepare(native,'lock-native');
    const execute=async(c,p)=>{await c.query('begin');try{
      await c.query("set local deadlock_timeout='50ms'");await c.query("set local lock_timeout='5s'");
      const result=await postLedgerJournalForTransaction({client:c,firmId,clientId,transaction:p.transaction,coding:p.preview.coding,bankAccount:p.preview.bank_account,actorId});
      await c.query('commit');return result;
    }catch(error){await c.query('rollback');throw error;}};
    let outcomes;
    try{
      const first=execute(wrapped,pOrdinary);
      // Observe rejection immediately without swallowing its final outcome.
      first.catch(()=>signalExpense());await expenseHeld;
      const second=execute(native,pNative);outcomes=Promise.allSettled([first,second]);
      let blocked=false;
      for(let attempt=0;attempt<200;attempt++){
        const blockers=(await pool.query('select pg_blocking_pids($1::int) blockers',[native.processID])).rows[0].blockers;
        if(blockers.includes(ordinary.processID)){blocked=true;break;}
        await new Promise(resolve=>setTimeout(resolve,10));
      }
      assert.equal(blocked,true,'native must actually wait for the ordinary transaction before the barrier releases');
      releaseOrdinary();
      const results=await outcomes;
      assert.deepEqual(results.map(r=>r.status==='fulfilled'?'posted':r.reason.code),['posted','posted']);
      assert.equal((await lines('lock-native')).length,3);assert.equal((await lines('lock-ordinary')).length,2);
    }finally{releaseOrdinary();if(outcomes)await outcomes;ordinary.release();native.release();}
  });
  await t.test('direct named writer and normal posting share document-before-chart lock order',async()=>{
    await seed('mixed-a');await seed('mixed-b');await acceptFacts('mixed-b',{...facts('mixed-b'),document_id:'doc-mixed-a'});
    const c=await pool.connect();
    const prepared=await __prepareLedgerTransactionPosting({client:c,firmId,clientId,transactionId:'mixed-a',dryRun:true});
    const direct=async()=>{await c.query('begin');try{
      const result=await postLedgerJournalForTransaction({client:c,firmId,clientId,transaction:prepared.transaction,coding:prepared.preview.coding,bankAccount:prepared.preview.bank_account,actorId});
      await c.query('commit');return result;
    }catch(error){await c.query('rollback');throw error;}finally{c.release();}};
    const results=await Promise.allSettled([direct(),post('mixed-b')]);
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1,JSON.stringify(results));
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED');
    assert.equal((await lines('mixed-a')).length+(await lines('mixed-b')).length,3);
  });
  await t.test('named correction replaces the split and a locked period refuses all further accounting edits',async()=>{
    await seed('correction');const correctionPreview=await post('correction',true);await post('correction');
    await updateTransactionReviewItemInDb({firmId,reviewItemId:'review-correction',actorId,returnSnapshot:false,distillFactsFn:async()=>[],
      patch:{status:'resolved',coding_state:'posted',tax_treatment:'Exempt supply',xero_tax_type:'AE_VAT_EXEMPT_OUTPUT',tax_type:'AE_VAT_EXEMPT_OUTPUT'}});
    const correctionClient=await pool.connect();await correctionClient.query('begin');
    try{await assert.rejects(postLedgerJournalForTransaction({client:correctionClient,firmId,clientId,
      transaction:rowToTransactionPayload(await row('correction')),
      coding:{...correctionPreview.ledger_posting.coding,tax_treatment:'Exempt supply',tax_type:'AE_VAT_EXEMPT_OUTPUT',xero_tax_type:'AE_VAT_EXEMPT_OUTPUT'},
      bankAccount:correctionPreview.ledger_posting.bank_account,actorId}),{code:'TRANSACTION_AE_VAT_FACTS_STALE'});
    }finally{await correctionClient.query('rollback');correctionClient.release();}
    await post('correction',false,true);
    assert.equal((await lines('correction')).length,2);
    assert.equal((await lines('correction')).find(l=>l.account_code==='sales').tax_type,'AE_VAT_EXEMPT_OUTPUT');
    await seed('locked-new');
    await lockClosePeriodInDb({firmId,clientId,periodStart:'2026-09-01',periodEnd:'2026-09-30',actorId,force:true});
    assert.equal((await pool.query("select status from ledger_journals where source_id='sale'")).rows[0].status,'closed');
    const closedReturn=await prepareAeVatReturnFromDb({firmId,clientId,periodKey:'2026-Q3'});
    assert.ok(closedReturn.vatReturn.fields.standard_rated_supplies.total.vat>=5);
    await seed('reuse-closed',{accept:false});
    await pool.query("update transactions set transaction_date='2026-10-01' where id='reuse-closed'");
    await acceptFacts('reuse-closed',{...facts('reuse-closed'),document_id:'doc-sale',date_of_supply:'2026-10-01',reporting_date:'2026-10-01'},'2026-10-01');
    await assert.rejects(post('reuse-closed'),{code:'TRANSACTION_AE_VAT_SCOPE_UNSUPPORTED'});await noJournal('reuse-closed');
    await assert.rejects(acceptFacts('correction',facts('correction')),{code:'LEDGER_LOCKED_TRANSACTION_IMMUTABLE'});
    await assert.rejects(post('sale',false,true),{code:'LEDGER_LOCKED_PERIOD_IMMUTABLE'});
    await assert.rejects(post('locked-new'),{code:'LEDGER_LOCKED_PERIOD_IMMUTABLE'});await noJournal('locked-new');
  });

});
