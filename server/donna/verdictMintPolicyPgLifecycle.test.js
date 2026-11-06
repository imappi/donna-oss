// Matched-document categorization consumes current persisted policy and source.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import { updateTransactionReviewItemInDb } from './db/coding.js';
import { autoCategorizeMatchedTransactionsInDb } from './parseDocumentsDb.js';
import { resolveCodingPolicy, codingPolicyReceipt } from './codingPolicy.js';
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: matched verdict mint and existing-chart apply require current country lineage and preserve historical evidence', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — matched verdict policy lifecycle not exercised'
}, async (t) => {
  const name = `donna_jn_mint_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', (connection) => connectionsClosed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'mint-policy-firm';
  await pool.query("insert into firms (id,name,slug) values ($1,'Mint fixture','mint-fixture')", [firmId]);
  const seed = async (id, country, { receipt, proposed = 'Office expenses', chart = false, state = 'proposed', date = '2026-06-01' } = {}) => {
    const policy = resolveCodingPolicy({ jurisdiction: country, businessDate: date });
    const suggestion = { proposed_account: proposed, confidence: 'high', coding_policy: receipt === undefined ? codingPolicyReceipt(policy) : receipt };
    await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
      values ($1,$2,'Mint fixture',$3,$4::jsonb)`, [id, firmId, country, JSON.stringify({ jurisdiction: country })]);
    await pool.query(`insert into client_capability_config (id,firm_id,client_id,flag_key,stage)
      values ($1,$2,$1,'RECONCILIATION_MINT_VERDICT_ACCOUNT','canary')`, [id, firmId]);
    await pool.query(`insert into ledger_accounts (id,firm_id,client_id,name,account_type,status)
      values ($1,$2,$1,$3,'expense','active')`, [id, firmId, chart ? proposed : 'Fixture placeholder']);
    await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type,vendor_name)
      values ($1,$2,$1,'fixture.pdf','receipt','Qxz')`, [id, firmId]);
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state,payload)
      values ($1,$2,$1,$3,'Fixture purchase',10,'CAD',$4,$5,$6::jsonb)`,
    [id, firmId, date, state === 'posted' ? 'posted' : 'needs_review', state, JSON.stringify({ ai_suggestion: suggestion, currency: 'CAD' })]);
    await pool.query(`insert into transaction_review_queue (id,firm_id,client_id,item_type,item_id,reason,priority,status,payload)
      values ($1,$2,$1,'transaction',$1,'fixture','normal','open',$3::jsonb)`,
    [id, firmId, JSON.stringify({ ai_suggestion: { proposed_account: 'CPF payable', confidence: 'high' } })]);
    await pool.query(`insert into reconciliation_matches (id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status)
      values ($1,$2,$1,$1,'receipt',$1,'auto_matched')`, [id, firmId]);
    return suggestion;
  };
  const read = async (id) => (await pool.query('select * from transactions where id=$1', [id])).rows[0];
  const chartCount = async (id) => (await pool.query('select count(*)::int n from ledger_accounts where client_id=$1', [id])).rows[0].n;
  const run = (id, opts = {}) => autoCategorizeMatchedTransactionsInDb({ firmId, clientId: id, ...opts });
  const latestFailure = async (id) => (await pool.query("select * from audit_events where resource_id=$1 and action='transaction.coding.policy_failed' order by id desc limit 1", [id])).rows[0];
  for (const country of ['sg', 'fi', 'gb', 'ae', 'us', 'au']) {
    const policy = resolveCodingPolicy({ jurisdiction: country, businessDate: '2026-06-01' });
    const proposed = policy.accountOptions.find((name) => /office|supplies|professional/i.test(name)) || policy.accountOptions.find((name) => name !== policy.suspenseAccountName);
    const good = `${country}-good`;
    const historical = await seed(good, country, { proposed });
    assert.deepEqual(await run(good), { categorized: country === 'fi' ? 0 : 1, errors: 0 }, country);
    assert.equal(await chartCount(good), country === 'fi' ? 1 : 2);
    if (country === 'fi') {
      assert.equal((await read(good)).category, null);
      assert.equal((await read(good)).coding_state, 'proposed', 'Finnish strong codings wait for the evidence-aware coding writer');
    } else assert.equal((await read(good)).category, proposed);
    assert.deepEqual((await read(good)).payload.ai_suggestion, historical, 'original policy receipt stays unchanged');
    const applied = await read(good);
    assert.deepEqual(await run(good), { categorized: 0, errors: 0 });
    assert.deepEqual(await read(good), applied, 'replay cannot rewrite an applied decision');
    for (const chart of [false, true]) {
      const id = `${country}-stale-${chart}`;
      await seed(id, country, { proposed, chart, receipt: codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: country, businessDate: '2026-05-31' })) });
      const before = await read(id);
      assert.deepEqual(await run(id), { categorized: 0, errors: 1 });
      assert.deepEqual(await read(id), before);
      assert.equal(await chartCount(id), 1);
      assert.equal((await latestFailure(id)).metadata.recovery_path, 'transaction_coding_retry');
    }
    for (const shape of ['unreceipted', 'missing', 'conflict', 'foreign', 'posted']) {
      const id = `${country}-${shape}`;
      await seed(id, country, { proposed, receipt: shape === 'unreceipted' ? null : shape === 'foreign'
        ? codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: country === 'gb' ? 'sg' : 'gb', businessDate: '2026-06-01' })) : undefined,
      state: shape === 'posted' ? 'posted' : 'proposed' });
      if (shape === 'missing') await pool.query('update clients set jurisdiction=null where id=$1', [id]);
      if (shape === 'conflict') await pool.query(`update clients set profile=jsonb_build_object('jurisdiction',$2::text) where id=$1`, [id, country === 'gb' ? 'sg' : 'gb']);
      const before = await read(id);
      assert.deepEqual(await run(id), { categorized: 0, errors: shape === 'posted' ? 0 : 1 });
      assert.deepEqual(await read(id), before);
      assert.equal(await chartCount(id), 1);
      if (shape !== 'posted') assert.ok(await latestFailure(id), 'refusal leaves a durable recovery obligation');
    }
  }
  await seed('human-correction', 'gb', { receipt: codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'sg', businessDate: '2026-06-01' })) });
  const historicalHumanAi = (await read('human-correction')).payload.ai_suggestion;
  assert.deepEqual(await run('human-correction'), { categorized: 0, errors: 1 });
  await updateTransactionReviewItemInDb({ firmId, reviewItemId: 'human-correction', actorId: 'fixture-owner',
    patch: { status: 'resolved', review_state: 'accepted', proposed_account: 'Fixture placeholder',
      account_name: 'Fixture placeholder', account_code: 'Fixture placeholder',
      tax_treatment: resolveCodingPolicy({ jurisdiction: 'gb', businessDate: '2026-06-01' }).outOfScopeTaxTreatment,
      reviewer_note: 'Owner confirmed the current account.' }, returnSnapshot: false, distillFactsFn: async () => [] });
  const accepted = await read('human-correction');
  assert.equal(accepted.payload.accepted_coding_policy.jurisdiction, 'gb');
  assert.deepEqual(accepted.payload.ai_suggestion, historicalHumanAi);
  // Reopen the derived case to prove its stale AI cannot rewrite a named human
  // correction even when a later reconciliation rediscovers that case.
  await pool.query("update transaction_review_queue set status='open' where id='human-correction'");
  assert.deepEqual(await run('human-correction'), { categorized: 0, errors: 0 });
  assert.deepEqual(await read('human-correction'), accepted);

  for (const id of ['human-correction', 'gb-posted']) {
    await pool.query("update documents set vendor_name='Fixture placeholder' where id=$1", [id]);
    const decided = await read(id);
    const caseBefore = (await pool.query('select * from transaction_review_queue where id=$1', [id])).rows[0];
    assert.deepEqual(await run(id), { categorized: 0, errors: 0 }, 'matching vendor cannot rewrite a decided row');
    assert.deepEqual(await read(id), decided);
    assert.deepEqual((await pool.query('select * from transaction_review_queue where id=$1', [id])).rows[0], caseBefore);
    await pool.query(`insert into client_rules (id,firm_id,client_id,rule_type,pattern_text,category_override,account_code,status)
      values ($1,$2,$1,'pattern','Fixture purchase','Office expenses','Office expenses','active')`, [id, firmId]);
    assert.deepEqual(await run(id), { categorized: 0, errors: 0 }, 'matching rule cannot rewrite a decided row');
    assert.deepEqual(await read(id), decided);
    assert.deepEqual((await pool.query('select * from transaction_review_queue where id=$1', [id])).rows[0], caseBefore);
  }

  // The source can change after the work-list read. Its under-lock date must
  // select policy, so a previous same-country receipt cannot authorize the effect.
  await seed('date-race', 'gb');
  const dbClient = await pool.connect();
  let changed = false;
  const proxy = { query: async (sql, params) => {
    if (!changed && sql.includes('select * from transactions')) {
      changed = true;
      await pool.query("update transactions set transaction_date='2026-06-02' where id='date-race'");
    }
    return dbClient.query(sql, params);
  } };
  try {
    assert.deepEqual(await run('date-race', { dbClient: proxy }), { categorized: 0, errors: 1 });
    assert.equal(await chartCount('date-race'), 1);
    // The in-writer entry uses a savepoint and leaves its caller's work usable.
    await seed('savepoint', 'gb', { receipt: null });
    await dbClient.query('begin');
    assert.deepEqual(await run('savepoint', { dbClient, inTransaction: true }), { categorized: 0, errors: 1 });
    assert.equal((await dbClient.query('select 1 as n')).rows[0].n, 1);
    await dbClient.query('commit');
    assert.ok(await latestFailure('savepoint'));
  } finally { dbClient.release(); }
  assert.equal((await pool.query('select count(*)::int n from ledger_journals')).rows[0].n, 0, 'chart/coding updates never fabricate a journal');
});
