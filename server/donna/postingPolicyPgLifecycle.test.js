import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, updateClientProfileInDb } from './firmDb.js';
import { __prepareLedgerTransactionPosting, __commitPreparedLedgerPosting, postLedgerJournalForTransaction, ledgerRecordId } from './db/ledger.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
import { buildCaseHealth } from './caseHealth.js';
import { sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { readClientConfigSnapshot } from './clientConfig.js';
import { settleCommittedConvergenceMarks } from './reconcileConvergenceState.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: posting selects persisted country, refuses stale context/source and recovers through named writer', {
 skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable-PG posting lifecycle not exercised'
}, async (t) => {
  const name = `donna_jn_posting_${Date.now().toString(36)}_${process.pid}`;
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

  const firmId = 'posting-fixture-firm';
  await pool.query("insert into firms (id, name, slug) values ($1, 'Posting test', 'posting-test')", [firmId]);
  const countries = { fi: 'EUR', gb: 'GBP', ae: 'AED', sg: 'SGD', us: 'USD', au: 'AUD' };
  for (const [country, currency] of Object.entries(countries)) {
    const profile = { jurisdiction: country, accounting_system: 'none' };
    const policy = resolveCodingPolicy({ jurisdiction: country, businessDate: '2026-09-05', accountingSystem: 'none' });
    const suggestion = { proposed_account: 'Sales', tax_treatment: policy.outOfScopeTaxTreatment,
      confidence: 'high', coding_policy: codingPolicyReceipt(policy) };
    await pool.query(`insert into clients (id, firm_id, company_name, jurisdiction, profile) values ($1,$2,'Posting client',$1,$3)`, [country, firmId, profile]);
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values ($1,$2,$3,'2026-09-05','Service sale',100,0,$4,'needs_review','applied',$5)`,
      [`tx-${country}`, firmId, country, currency, { ai_suggestion: suggestion }]);
  }
  const post = (country) => postLedgerTransactionInDb({ firmId, clientId: country, transactionId: `tx-${country}`, dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' });
  for (const country of Object.keys(countries)) {
    const preview = await postLedgerTransactionInDb({ firmId, clientId: country, transactionId: `tx-${country}`, dryRun: true });
    assert.equal(preview.ledger_posting.posting_policy.coding_policy.jurisdiction, country);
    await post(country);
    const journal = (await pool.query("select payload from ledger_journals where client_id=$1", [country])).rows[0];
    assert.equal(journal.payload.posting_policy.coding_policy.jurisdiction, country);
    assert.equal((await pool.query("select coding_state from transactions where id=$1", [`tx-${country}`])).rows[0].coding_state, 'posted');
  }
  // Exercise the actual chart -> matcher -> named posting writer wiring. The
  // same supplied chart default must never silently select Singapore translation.
  for (const [country, currency] of Object.entries(countries)) {
    await pool.query(`insert into ledger_accounts (id,firm_id,client_id,code,name,account_type,normal_balance,currency,tax_type,status)
      values ($1,$2,$3,'fixture-connector','Connector translation fixture','revenue','credit',$4,'BASEXCLUDED','active')`,
      [ledgerRecordId('account', firmId, country, 'fixture-connector'), firmId, country, currency]);
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values ($1,$2,$3,'2026-09-05','Connector fixture',100,0,$4,'needs_review','applied',$5)`,
      [`connector-tx-${country}`, firmId, country, currency, { category: 'Connector translation fixture', account_code: 'fixture-connector', tax_treatment: country === 'ae' ? 'Out of scope of UAE VAT' : 'Out of scope' }]);
    const preview = await postLedgerTransactionInDb({ firmId, clientId: country, transactionId: `connector-tx-${country}`, dryRun: true });
    assert.equal(preview.ledger_posting.coding.xero_tax_type, country === 'sg' ? 'OPOUTPUT' : country === 'ae' ? 'AE_VAT_OUTSIDE_SCOPE_OUTPUT' : 'BASEXCLUDED');
    await postLedgerTransactionInDb({ firmId, clientId: country, transactionId: `connector-tx-${country}`, dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' });
    assert.equal((await pool.query('select coding_state from transactions where id=$1', [`connector-tx-${country}`])).rows[0].coding_state, 'posted');
  }
  const settleConnection = await pool.connect();
  try { await settleCommittedConvergenceMarks(settleConnection); } finally { settleConnection.release(); }
  const postedBefore = (await pool.query("select * from transactions where id='tx-fi'")).rows[0];
  // A new source line permits prepare/commit races without touching posted books.
  await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
    values ('race',$1,'gb','2026-09-05','Race fixture',100,0,'GBP','needs_review','applied', '{"category":"Sales"}')`, [firmId]);
  const connection = await pool.connect();
  const prepare = () => __prepareLedgerTransactionPosting({ client: connection, firmId, clientId: 'gb', transactionId: 'race', dryRun: true });
  const commit = (prepared) => __commitPreparedLedgerPosting({ client: connection, firmId, clientId: 'gb', transactionId: 'race', prepared, actorId: 'fixture-owner' });
  try {
    const prepared = await prepare();
    await updateClientProfileInDb({ firmId, clientId: 'gb', profilePatch: { vat_registration: { status: 'not_registered' } }, actorId: 'fixture-owner' });
    await connection.query('begin');
    await assert.rejects(commit(prepared), e => e.details?.reason === 'posting_policy_receipt_conflict');
    await connection.query('rollback');
    const preparedAgain = await prepare();
    await pool.query("update transactions set transaction_date='2026-09-06' where id='race'");
    await connection.query('begin');
    await assert.rejects(commit(preparedAgain), e => e.details?.reason === 'posting_source_changed');
    await connection.query('rollback');
    await connection.query('begin');
    await assert.rejects(postLedgerJournalForTransaction({ client: connection, firmId, clientId:'gb', transaction: preparedAgain.transaction,
      coding: preparedAgain.preview.coding, bankAccount: preparedAgain.preview.bank_account }), e => e.details?.reason === 'posting_source_changed');
    await connection.query('rollback');
  } finally { connection.release(); }
  assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='race'")).rows[0].n, 0);
  // An unknown country produces a durable, visible setup obligation after rollback.
  await updateClientProfileInDb({ firmId, clientId:'gb', profilePatch:{jurisdiction:null}, actorId:'fixture-owner' });
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId:'gb', transactionId:'race', dryRun:false, skipSnapshot:true }), {code:'jurisdiction_unresolved'});
  const failed = (await pool.query("select * from audit_events where resource_id='race' order by id")).rows;
  const tx = (await pool.query("select * from transactions where id='race'")).rows[0];
  const health = buildCaseHealth({ transaction:tx, auditEvents:failed });
  assert.ok(health.integration_failures.some(f => f.operation==='posting' && f.failure==='jurisdiction_unresolved'));
  assert.equal(health.phase,'needs_owner',JSON.stringify(health));
  await updateClientProfileInDb({ firmId, clientId:'gb', profilePatch:{jurisdiction:'gb'}, actorId:'fixture-owner' });
  await pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage) values ('posting-flag',$1,'gb','LEDGER_AUTO_POST','auto')`,[firmId]);
  const configSnapshot = await readClientConfigSnapshot(pool, { firmId, clientId:'gb' });
  const recoveredSweep = await sweepLedgerAutoPost({ firmId, clientId:'gb', configSnapshot });
  assert.equal(recoveredSweep.posted,1,JSON.stringify(recoveredSweep));
  assert.equal((await sweepLedgerAutoPost({ firmId, clientId:'gb', configSnapshot })).eligible,0);
  const recovered = (await pool.query("select * from audit_events where resource_id='race' and action='transaction.coding.policy_recovered'")).rows;
  assert.equal(recovered.length,1); assert.equal(recovered[0].metadata.operation,'posting');
  assert.deepEqual((await pool.query("select * from transactions where id='tx-fi'")).rows[0],postedBefore);
});
