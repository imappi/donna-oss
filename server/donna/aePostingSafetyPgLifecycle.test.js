import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, updateClientProfileInDb } from './firmDb.js';
import { __prepareLedgerTransactionPosting, __commitPreparedLedgerPosting, postLedgerJournalForTransaction } from './db/ledger.js';
import { rowToTransactionPayload } from './db/transactions.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { buildCaseHealth } from './caseHealth.js';
import { sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { updateTransactionReviewItemInDb, upsertLedgerAccountForJournal } from './firmDb.js';
import { listRuntimePolicyIncidents, claimRuntimePolicyIncident, requestRuntimePolicyIncidentRetry, completeRuntimePolicyIncidentRetry } from './runtimePolicyIncidentDb.js';
import { settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('U08-S1 real PG: AE preparation, locked commit, visible owned refusal and named-writer recovery', async (t) => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL; AE safety proof cannot skip.');
  const name = `donna_ae_safety_${Date.now().toString(36)}_${process.pid}`;
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

  const firmId = 'ae-safety-firm', clientId = 'ae-safety-client', actorId = 'ae-safety-owner';
  await pool.query("insert into firms (id,name,slug) values ($1,'Safety fixture','ae-safety-fixture')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,name,email,status) values($1,$2,'Fixture maintainer','fixture@example.test','active')", [actorId, firmId]);
  await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile)
    values($1,$2,'Safety fixture','ae','{"jurisdiction":"ae","accounting_system":"none"}')`, [clientId, firmId]);
  for (const flag of ['JURISDICTION_TAX_CODING', 'LEDGER_AUTO_POST']) {
    await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage) values($1,$2,$3,$1,'auto')", [flag,firmId,clientId]);
  }
  for (const account of [
    { code: 'bank', name: 'Bank', type: 'bank', normal_balance: 'debit' },
    { code: 'sales', name: 'Sales', type: 'revenue', normal_balance: 'credit', tax_type: 'AE_VAT_SR_5_OUTPUT' },
    { code: 'loan', name: 'Loan payable', type: 'liability', normal_balance: 'credit' },
    { code: 'cost', name: 'Operating expenses', type: 'expense', normal_balance: 'debit' }
  ]) await upsertLedgerAccountForJournal({ client: pool, firmId, clientId, account, currency: 'AED', taxType: account.tax_type });
  const accountsBeforeRefusal = (await pool.query('select * from ledger_accounts order by id')).rows;
  assert.equal(accountsBeforeRefusal.find(a => a.code === 'sales').tax_type, 'AE_VAT_SR_5_OUTPUT', 'stale chart default is present in the real wiring');
  const policy = codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'ae', businessDate: '2026-09-09', accountingSystem: 'none' }));
  const seed = async (id, treatment, { account = 'Sales', code = 'sales', out = false, taxType = null } = {}) => {
    const suggestion = { proposed_account: account, account_code: code, tax_treatment: treatment, confidence: 'high', coding_policy: policy,
      ...(taxType ? { xero_tax_type: taxType } : {}) };
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values($1,$2,$3,'2026-09-09','Safety fixture', $4,$5,'AED','needs_review','applied',$6)`,
      [id,firmId,clientId,out ? 0 : 105,out ? 105 : 0,{ ai_suggestion: suggestion }]);
    await pool.query(`insert into transaction_review_queue(id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values($1,$2,$3,'transaction',$4,'fixture','normal','open',$5)`,
      [`review-${id}`,firmId,clientId,id,{ transaction_id: id, tax_treatment: 'Out of scope of UAE VAT', xero_tax_type: 'AE_VAT_OUTSIDE_SCOPE_OUTPUT' }]);
  };
  const post = (id, dryRun = false) => postLedgerTransactionInDb({ firmId, clientId, transactionId:id, dryRun, actorId, skipSnapshot:true });
  const row = async id => (await pool.query('select * from transactions where id=$1',[id])).rows[0];
  const events = async id => (await pool.query('select * from audit_events where resource_id=$1 order by id',[id])).rows;
  const call = async (fn,args={}) => { const c=await pool.connect(); try { return await fn({client:c,firmId,...args}); } finally {c.release();} };
  const count = async (table,id) => Number((await pool.query(`select count(*)::int n from ${table} where ${table === 'ledger_lines' ? 'journal_id in (select id from ledger_journals where source_id=$1)' : 'source_id=$1'}`,[id])).rows[0].n);
  const noJournal = async id => { assert.equal(await count('ledger_journals',id),0); assert.equal(await count('ledger_lines',id),0); };
  for (const [id,treatment,options,expected] of [
    ['unsure','UAE VAT check',{},'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
    ['missing','',{},'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
    ['unknown','invented treatment',{},'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
    ['taxable','VAT 5% (standard rated)',{},'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'],
    ['input','VAT 5% (standard rated)',{out:true,account:'Operating expenses',code:'cost'},'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'],
    ['rcm','Reverse charge (RCM)',{out:true,account:'Operating expenses',code:'cost'},'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'],
    ['foreign','',{taxType:'VAT_SR_20_OUTPUT'},'posting_tax_code_foreign'],
    ['invalid','',{taxType:'AE_VAT_INVENTED'},'posting_tax_code_invalid']
  ]) {
    await seed(id,treatment,options);
    await assert.rejects(post(id,true),{code:expected});
    await assert.rejects(post(id),{code:expected});
    await noJournal(id);
  }
  assert.deepEqual((await pool.query('select * from ledger_accounts order by id')).rows, accountsBeforeRefusal, 'refusal has no chart/account effects');
  await call(({client}) => settleCommittedConvergenceMarks(client));
  const refused = await row('unsure');
  assert.equal(refused.convergence_state,'hanging');
  assert.equal(refused.convergence_reason,'ledger_post_refused:TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED');
  const health = buildCaseHealth({transaction:refused,auditEvents:await events('unsure')});
  assert.ok(health.integration_failures.some(item=>item.failure==='TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'));
  let incidents = await call(listRuntimePolicyIncidents);
  const taxable = incidents.find(item=>item.transaction_id==='taxable');
  assert.ok(taxable.unlock_condition.includes('posting'));
  assert.ok(incidents.find(item=>item.transaction_id==='unsure'));
  assert.equal(Number((await pool.query('select count(*)::int n from client_evidence_requests')).rows[0].n),0,'software/coding refusal fabricates no missing-evidence ask');
  const principal = {principalType:'firm_member',principalId:actorId};
  const claim = await call(claimRuntimePolicyIncident,{failureId:taxable.failure_id,principal});
  assert.equal(claim.claimant.id,actorId);
  const request = await call(requestRuntimePolicyIncidentRetry,{failureId:taxable.failure_id,principal,idempotencyKey:'still-unsupported',repairNote:'Verify that capability is still refused; no coding change.'});
  const snapshot = await readClientConfigSnapshot(pool,{firmId,clientId});
  const retry = await sweepLedgerAutoPost({firmId,clientId,transactionId:'taxable',configSnapshot:snapshot});
  assert.equal(retry.refused,1); await noJournal('taxable');
  const completion = await call(completeRuntimePolicyIncidentRetry,{failureId:taxable.failure_id,principal,requestId:request.request.id});
  assert.notEqual(completion.outcome,'recovered','acknowledgement/retry never repairs missing tax legs');

  // Real source correction supplies exact non-tax semantics; a stale case file
  // and the old AI receipt cannot replace this named writer's authority.
  await updateTransactionReviewItemInDb({firmId,reviewItemId:'review-unsure',actorId,returnSnapshot:false,distillFactsFn:async()=>[],
    patch:{status:'resolved',review_state:'accepted',proposed_account:'Sales',account_name:'Sales',account_code:'sales',tax_treatment:'Exempt supply',reviewer_note:'Fixture correction: the held evidence states an exempt supply.'}});
  const recovered = await sweepLedgerAutoPost({firmId,clientId,transactionId:'unsure',configSnapshot:snapshot});
  assert.equal(recovered.posted,1,JSON.stringify(recovered));
  assert.equal((await row('unsure')).coding_state,'posted');
  assert.equal((await row('unsure')).payload.ledger_post_refusal,undefined);
  assert.ok((await events('unsure')).some(e=>e.action==='transaction.coding.policy_recovered' && e.metadata.operation==='posting'));
  assert.equal((await call(listRuntimePolicyIncidents)).some(item=>item.transaction_id==='unsure'),false);
  const lines = (await pool.query("select account_code,tax_type,debit,credit from ledger_lines where journal_id in (select id from ledger_journals where source_id='unsure') order by account_code")).rows;
  assert.deepEqual(lines.map(l=>[l.account_code,l.tax_type,Number(l.debit),Number(l.credit)]),[['bank','NONE',105,0],['sales','AE_VAT_EXEMPT_OUTPUT',0,105]]);

  for (const [id,treatment,options] of [
    ['zero','Zero-rated supply',{}], ['outside','Out of scope of UAE VAT',{}],
    ['loan','',{out:true,account:'Loan payable',code:'loan'}],
    ['blocked','',{out:true,account:'Operating expenses',code:'cost',taxType:'AE_VAT_BLOCKED_INPUT'}]
  ]) { await seed(id,treatment,options); await post(id,true); await post(id); assert.equal((await row(id)).coding_state,'posted'); }
  // An absent chart match leaves the account class unknown. Mint-by-name is
  // valid only after the same tax guard resolves safe authoritative semantics;
  // an empty chart type is not evidence of a balance-sheet exemption.
  for (const stage of ['auto', 'off']) {
    await pool.query("update client_capability_config set stage=$1 where flag_key='JURISDICTION_TAX_CODING'", [stage]);
    for (const [label,treatment] of [['absent',undefined],['unsure','UAE VAT check'],['unknown','invented treatment']]) {
      for (const out of [false, true]) {
        const id = `name-${stage}-${label}-${out ? 'out' : 'in'}`;
        const account = `Uncharted ${id}`;
        const accountsBefore = (await pool.query('select * from ledger_accounts order by id')).rows;
        await seed(id,treatment,{account,code:'',out});
        await assert.rejects(post(id,true),{code:'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'});
        await assert.rejects(post(id),{code:'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'});
        await call(async ({client}) => {
          await client.query('begin');
          try {
            await assert.rejects(postLedgerJournalForTransaction({client,firmId,clientId,actorId,
              transaction:rowToTransactionPayload(await row(id)),
              coding:{account_name:account,account_code:'',tax_treatment:treatment},
              bankAccount:{code:'bank',name:'Bank',type:'bank',currency:'AED'}}),
            {code:'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'},'lower named journal writer refuses an unknown class without preparation');
          } finally {await client.query('rollback');}
        });
        await noJournal(id);
        assert.deepEqual((await pool.query('select * from ledger_accounts order by id')).rows,accountsBefore,
          'refused name-only coding must not mint an account');
        assert.equal((await row(id)).payload.ledger_post_refusal.code,'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED');
        assert.ok((await events(id)).some(event => event.action === 'transaction.coding.policy_failed'
          && event.metadata.recovery_route === 'runtime_policy_incident'));
      }
    }
    for (const [label,treatment,suffix] of [['exempt','Exempt supply','EXEMPT'],['outside','Out of scope of UAE VAT','OUTSIDE_SCOPE']]) {
      for (const out of [false, true]) {
        const id = `name-${stage}-${label}-${out ? 'out' : 'in'}`;
        const account = `Uncharted ${id}`;
        const expectedCode = `AE_VAT_${suffix}_${out ? 'INPUT' : 'OUTPUT'}`;
        assert.equal((await pool.query('select id from ledger_accounts where client_id=$1 and name=$2',[clientId,account])).rows.length,0);
        await seed(id,treatment,{account,code:'',out});
        const preview = await post(id,true);
        assert.equal(preview.ledger_posting.coding.tax_type,expectedCode);
        await noJournal(id);
        await post(id);
        assert.equal((await row(id)).coding_state,'posted');
        const minted = (await pool.query('select * from ledger_accounts where client_id=$1 and name=$2',[clientId,account])).rows;
        assert.equal(minted.length,1,'the named posting writer mints exactly one name-only account');
        assert.equal(minted[0].code || '', '');
        assert.equal(minted[0].tax_type,expectedCode);
        const postedLines = (await pool.query(`select l.* from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id=$1`,[id])).rows;
        assert.equal(postedLines.length,2);
        assert.equal(postedLines.find(line => line.account_id === minted[0].id).tax_type,expectedCode);
        assert.equal(postedLines.reduce((sum,line) => sum + Number(line.debit),0),105);
        assert.equal(postedLines.reduce((sum,line) => sum + Number(line.credit),0),105);
      }
    }
  }
  // The flag controls vocabulary rollout, never permission to post unknown
  // UAE P&L treatment. Exact supported no-split semantics still work off-flag.
  await pool.query("update client_capability_config set stage='off' where flag_key='JURISDICTION_TAX_CODING'");
  for (const [id,treatment] of [['off-absent',''],['off-unknown','invented treatment'],['off-unsure','UAE VAT check']]) {
    await seed(id,treatment);
    await assert.rejects(post(id,true),{code:'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'});
    await assert.rejects(post(id),{code:'TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'});
    await noJournal(id);
  }
  for (const [id,treatment,options] of [['off-exempt','Exempt supply',{}],['off-outside','Out of scope of UAE VAT',{}],
    ['off-loan','',{out:true,account:'Loan payable',code:'loan'}]]) {
    await seed(id,treatment,options); await post(id,true); await post(id);
    assert.equal((await row(id)).coding_state,'posted');
  }
  await pool.query("update client_capability_config set stage='auto' where flag_key='JURISDICTION_TAX_CODING'");
  await seed('race','Exempt supply');
  const c=await pool.connect();
  const prepare=()=>__prepareLedgerTransactionPosting({client:c,firmId,clientId,transactionId:'race',dryRun:true});
  const commit=prepared=>__commitPreparedLedgerPosting({client:c,firmId,clientId,transactionId:'race',prepared,actorId});
  const rejectCommit = async (prepared, check) => { await c.query('begin'); try {await assert.rejects(commit(prepared),check);} finally {await c.query('rollback');} await noJournal('race'); };
  try {
    const prepared=await prepare();
    await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,tax_treatment}','\"VAT 5% (standard rated)\"') where id='race'");
    await rejectCommit(prepared,e=>e.details?.reason==='posting_source_changed');
    await assert.rejects(post('race'),{code:'TRANSACTION_AE_VAT_POSTING_UNSUPPORTED'});
    await pool.query("update transactions set payload=jsonb_set(payload,'{ai_suggestion,tax_treatment}','\"Exempt supply\"') where id='race'");
    const beforeConfig=await prepare();
    await pool.query("update client_capability_config set stage='off' where flag_key='JURISDICTION_TAX_CODING'");
    await rejectCommit(beforeConfig,e=>e.details?.reason==='posting_policy_receipt_conflict');
    await pool.query("update client_capability_config set stage='auto' where flag_key='JURISDICTION_TAX_CODING'");
    const beforeProfile=await prepare();
    await updateClientProfileInDb({firmId,clientId,actorId,profilePatch:{vat_registration:{status:'not_registered'}}});
    await rejectCommit(beforeProfile,e=>e.details?.reason==='posting_policy_receipt_conflict');
    const forged=await prepare();
    forged.preview.coding={...forged.preview.coding,tax_type:'AE_VAT_SR_5_OUTPUT',xero_tax_type:'AE_VAT_SR_5_OUTPUT'};
    await rejectCommit(forged,{code:'TRANSACTION_AE_VAT_CODING_CONFLICT'});
    // Named lower journal boundary independently checks the current source,
    // even if callers bypass the preparation helper entirely.
    const source=await prepare();
    await c.query('begin');
    await assert.rejects(postLedgerJournalForTransaction({client:c,firmId,clientId,transaction:source.transaction,
      coding:forged.preview.coding,bankAccount:source.preview.bank_account}),{code:'TRANSACTION_AE_VAT_CODING_CONFLICT'});
    await c.query('rollback');
    await noJournal('race');
  } finally {await c.query('rollback');c.release();}
  await post('race');
  assert.equal((await row('race')).coding_state,'posted');
  // External-system preview uses the same policy boundary; no provider call.
  await updateClientProfileInDb({firmId,clientId,actorId,profilePatch:{accounting_system:'xero'}});
  await pool.query("insert into xero_connections(id,firm_id,client_id,tenant_id) values('xc',$1,$2,'fixture-tenant')",[firmId,clientId]);
  for (const [code,name,type] of [['xb','Bank','BANK'],['xs','Sales','REVENUE']]) {
    await pool.query(`insert into xero_accounts(id,connection_id,firm_id,client_id,xero_account_id,code,name,type,status,payload)
      values($1,'xc',$2,$3,$1,$1,$4,$5,'ACTIVE','{"CurrencyCode":"AED"}')`,[code,firmId,clientId,name,type]);
  }
  for (const [id,treatment,expected] of [['external-unsure','UAE VAT check','TRANSACTION_AE_VAT_TREATMENT_UNRESOLVED'],
    ['external-standard','VAT 5% (standard rated)','TRANSACTION_AE_VAT_POSTING_UNSUPPORTED']]) {
    await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,currency,status,coding_state,payload)
      values($1,$2,$3,'2026-09-09','External preview',105,'AED','needs_review','applied',$4)`,
      [id,firmId,clientId,{category:'Sales',account_code:'xs',tax_treatment:treatment}]);
    await assert.rejects(post(id,true),{code:expected});
    await assert.rejects(post(id),{code:expected});
    await noJournal(id);
  }

});
