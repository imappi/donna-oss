import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, retryXeroMirrorInDb } from './firmDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: Xero mirror retry preserves retained bytes and refuses unproven country reinterpretation', {
  skip: pgUrl ? false : 'DONNA_PG_TEST_URL not set — disposable-PG mirror policy replay not exercised'
}, async (t) => {
  const name = `donna_jn_mirror_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', connection => connectionsClosed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorEnv = Object.fromEntries(['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { XERO_CLIENT_ID: 'fixture-client', XERO_CLIENT_SECRET: 'fixture-secret', XERO_REDIRECT_URI: 'https://fixture.invalid/callback' });
  const priorFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls += 1; throw new Error('Provider access is forbidden in mirror dry-run proof.'); };
  t.after(async () => {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(connectionsClosed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter(name => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }
  const firmId = 'mirror-policy-firm';
  await pool.query("insert into firms (id,name,slug) values ($1,'Mirror fixture','mirror-fixture')", [firmId]);
  for (const id of ['retained', 'conflict', 'missing', 'explicit']) {
    await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
      values ($1,$2,'Mirror client','gb','{"jurisdiction":"gb","accounting_system":"none"}')`, [id, firmId]);
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
      values ($1,$2,$1,'2026-09-05','Service sale',100,0,'GBP','needs_review','applied',$3)`,
    [id, firmId, { category: 'Sales', tax_treatment: 'Out of scope' }]);
    await pool.query(`insert into xero_connections (id,firm_id,client_id,tenant_id,status,scopes,access_token,refresh_token,expires_at)
      values ($1,$2,$3,$1,'connected',array['accounting.banktransactions'],'fixture-access','fixture-refresh','2099-01-01T00:00:00Z')`,
    [`connection-${id}`, firmId, id]);
    for (const [code, accountName, type, taxType] of [['090', 'GBP bank', 'BANK', 'NONE'], ['200', 'Sales', 'REVENUE', 'OUTPUT2']]) {
      await pool.query(`insert into xero_accounts (id,connection_id,firm_id,client_id,xero_account_id,code,name,type,status,tax_type,payload)
        values ($1,$2,$3,$4,$1,$5,$6,$7,'ACTIVE',$8,'{"currency":"GBP"}')`,
      [`account-${id}-${code}`, `connection-${id}`, firmId, id, code, accountName, type, taxType]);
    }
  }
  // Current journals come only from the existing named posting writer.
  for (const clientId of ['retained', 'conflict']) {
    await postLedgerTransactionInDb({ firmId, clientId, transactionId: clientId, dryRun: false, skipSnapshot: true, actorId: 'fixture-owner' });
    const journal = (await pool.query("select payload from ledger_journals where firm_id=$1 and client_id=$2 and source_type='transaction' and source_id=$2", [firmId, clientId])).rows[0];
    assert.equal(journal.payload.posting_policy.coding_policy.jurisdiction, 'gb');
  }
  const retained = { Type: 'RECEIVE', Contact: { Name: 'Original customer' }, Date: '2026-09-05', BankAccount: { Code: '090' },
    LineAmountTypes: 'NoTax', Reference: 'original-retained-reference',
    LineItems: [{ Description: 'Original immutable line', Quantity: 1, UnitAmount: 100, AccountCode: '200', TaxType: 'NONE' }] };
  await pool.query("update transactions set payload=payload || $1::jsonb where id='retained'", [{ xero_writeback_payload: retained, tax_treatment: 'GST 9%' }]);
  // Simulate a persisted country correction after posting without rewriting the
  // actual original journal, its receipt or the retained connector request.
  for (const clientId of ['retained', 'conflict']) {
    await pool.query("update clients set jurisdiction='sg', profile=$2::jsonb where id=$1", [clientId, { jurisdiction: 'sg', accounting_system: 'none' }]);
  }
  // Historical imported transaction markers have no original journal receipt.
  // Do not erase a current journal's receipt to manufacture legacy test rows.
  await pool.query("update transactions set payload=payload || '{\"ledger_status\":\"posted\"}'::jsonb where id in ('missing','explicit')");
  await pool.query("update transactions set payload=payload || '{\"xero_tax_type\":\"NONE\"}'::jsonb where id='explicit'");
  const retry = async (clientId) => {
    const result = await retryXeroMirrorInDb({ firmId, clientId, transactionIds: [clientId], periodStart: '2026-09-01', periodEnd: '2026-09-30', dryRun: true });
    assert.equal(result.xero_mirror_retry.results.length, 1);
    return result.xero_mirror_retry.results[0];
  };
  const journalsBefore = (await pool.query('select * from ledger_journals order by id')).rows;
  const transactionsBefore = (await pool.query('select * from transactions order by id')).rows;
  await t.test('retained connector request is byte-equal despite changed country and prose', async () => {
    const result = await retry('retained');
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.deepEqual(result.bank_transaction, retained);
    const stored = (await pool.query("select payload->'xero_writeback_payload' as retained from transactions where id='retained'")).rows[0].retained;
    assert.equal(JSON.stringify(result.bank_transaction), JSON.stringify(stored));
  });
  await t.test('posted journal policy from another country refuses rebuild', async () => {
    const result = await retry('conflict');
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.error_code, 'jurisdiction_context_conflict');
  });
  await t.test('legacy prose without a receipt or exact connector code refuses rebuild', async () => {
    const result = await retry('missing');
    assert.equal(result.status, 'error', JSON.stringify(result));
    assert.equal(result.error_code, 'XERO_MIRROR_RETRY_LINEAGE_MISSING');
  });
  await t.test('legacy exact connector code remains usable without translating prose', async () => {
    const result = await retry('explicit');
    assert.equal(result.status, 'ready', JSON.stringify(result));
    assert.equal(result.bank_transaction.LineItems[0].TaxType, 'NONE');
    assert.equal(result.bank_transaction.LineAmountTypes, 'NoTax');
    assert.equal(result.bank_transaction.LineItems[0].UnitAmount, 100);
    assert.equal(result.bank_transaction.LineItems[0].AccountCode, '200');
  });
  assert.equal(providerCalls, 0);
  assert.deepEqual((await pool.query('select * from ledger_journals order by id')).rows, journalsBefore);
  assert.deepEqual((await pool.query('select * from transactions order by id')).rows, transactionsBefore);
});
