import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { writebackXeroTransactionInDb } from './db/xero.js';
import { postLedgerTransactionInDb } from './db/ledger.js';
import { currentCodingEvidence, codingEvidenceDigest } from './db/codingEvidence.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

// The optional Xero write-back runs the same two checks as Donna's own posting
// path (current coding evidence; the country's postable-tax policy with the
// matched document), at the dry run and again at execute, before any provider
// write. Synthetic Finnish fixture; every provider call is a local fake.
test('real PG: Xero write-back refuses what native posting refuses, admits what it posts, and refuses before any provider write', async (t) => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL.');
  const name = `donna_xero_evidence_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl);
  url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const connectionsClosed = [];
  pool.on('connect', connection => connectionsClosed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorEnv = Object.fromEntries(['XERO_CLIENT_ID', 'XERO_CLIENT_SECRET', 'XERO_REDIRECT_URI'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { XERO_CLIENT_ID: 'fixture-client', XERO_CLIENT_SECRET: 'fixture-secret', XERO_REDIRECT_URI: 'https://fixture.invalid/callback' });
  const priorFetch = globalThis.fetch;
  const providerCalls = [];
  let mutateOnRead = null;
  let providerSequence = 0;
  globalThis.fetch = async (address, options = {}) => {
    const parsed = new URL(String(address));
    const method = options.method || 'GET';
    assert.equal(parsed.hostname, 'api.xero.com', 'test may never call an unexpected provider host');
    const body = options.body ? JSON.parse(options.body) : null;
    providerCalls.push({ pathname: parsed.pathname, method, body });
    if (method === 'GET' && parsed.pathname.endsWith('/BankTransactions')) {
      if (mutateOnRead) {
        const mutation = mutateOnRead;
        mutateOnRead = null;
        await mutation();
      }
      return new Response(JSON.stringify({ BankTransactions: [] }), { status: 200 });
    }
    if (method === 'POST' && parsed.pathname.endsWith('/BankTransactions')) {
      providerSequence += 1;
      return new Response(JSON.stringify({ Status: 'OK', BankTransactions: [{
        ...body.BankTransactions[0], BankTransactionID: `fixture-xero-${providerSequence}`, Status: 'AUTHORISED'
      }] }), { status: 200 });
    }
    if (method === 'PUT' && /\/BankTransactions\/[^/]+\/History$/.test(parsed.pathname)) {
      return new Response(JSON.stringify({ HistoryRecords: [] }), { status: 200 });
    }
    assert.fail(`Unexpected provider call: ${method} ${parsed.pathname}`);
  };
  t.after(async () => {
    globalThis.fetch = priorFetch;
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
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
  for (const file of (await readdir(migrationRoot)).filter(file => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrationRoot), 'utf8'));
  }

  const firmId = 'xero-evidence-firm';
  const actorId = 'xero-evidence-owner';
  await pool.query("insert into firms (id,name,slug) values ($1,'Synthetic firm','xero-evidence-fixture')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,name,email,status) values($1,$2,'Fixture owner','fixture@example.invalid','active')", [actorId, firmId]);
  const outcome = promise => promise.then(() => 'admitted', error => error.code || error.message);
  const created = () => providerCalls.filter(call => call.method === 'POST' && call.pathname.endsWith('/BankTransactions'));
  // One Xero-connected client with its jurisdiction's tax coding on.
  const xeroClient = async ({ jurisdiction, currency, taxFlag, rate }) => {
    const clientId = `${jurisdiction}-xero-evidence-client`;
    const connectionId = `${jurisdiction}-xero-evidence-connection`;
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic company',$3,$4)`,
      // A UK VAT code posts only for a VAT-registered business (gb/postingPolicy.js).
      [clientId, firmId, jurisdiction, { jurisdiction, accounting_system: 'xero', accounting_basis: 'cash',
        ...(jurisdiction === 'gb' ? { vat_registration: { status: 'registered', registered_from: '2020-01-01' } } : {}) }]);
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
      values($1,$2,$3,$4,'auto','manual')`, [`${jurisdiction}-xero-tax`, firmId, clientId, taxFlag]);
    await pool.query(`insert into xero_connections(id,firm_id,client_id,tenant_id,status,scopes,access_token,refresh_token,expires_at)
      values($1,$2,$3,$4,'connected',array['accounting.banktransactions'],'fixture-access','fixture-refresh','2099-01-01T00:00:00Z')`,
    [connectionId, firmId, clientId, `${jurisdiction}-fixture-tenant`]);
    for (const [code, label, type, taxType] of [['090', `${currency} bank`, 'BANK', 'NONE'], ['200', 'Sales', 'REVENUE', 'OUTPUT2'], ['400', 'Purchases', 'EXPENSE', 'INPUT2']]) {
      await pool.query(`insert into xero_accounts(id,connection_id,firm_id,client_id,xero_account_id,code,name,type,status,tax_type,payload)
        values($1,$2,$3,$4,$1,$5,$6,$7,'ACTIVE',$8,$9)`,
      [`${jurisdiction}-xero-account-${code}`, connectionId, firmId, clientId, code, label, type, taxType, { currency }]);
    }
    // An autonomous coding: applied by the coder, no person's acceptance.
    const seed = async (id, { account, code, treatment, moneyIn = 0, moneyOut = 0 }) => {
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
        values($1,$2,$3,'2026-09-09',$4,$5,$6,$7,'needs_review','applied',$8)`,
      [id, firmId, clientId, `Synthetic ${id}`, moneyIn, moneyOut, currency, {
        ai_suggestion_status: 'auto_applied',
        ai_suggestion: { proposed_account: account, account_code: code, tax_treatment: treatment, confidence: 'high' }
      }]);
    };
    const source = async (id, type, total, tax, transactionId) => {
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary)
        values($1,$2,$3,$1,$4,'completed','2026-09-08',$5,$6,$7,'{"line_amounts_include_tax":true,"totals_validation":{"matches":true}}')`,
      [id, firmId, clientId, type, currency, total, tax]);
      await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
        values($1,$2,$3,$4,1,'Synthetic goods',$5,$6,$7)`, [`${id}-line`, firmId, clientId, id, total, rate, { raw_extraction: { amount: total, tax_rate: rate } }]);
      await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload)
        values($1,$2,$3,$4,$5,$6,'auto_matched',$7,0.9,'{}')`, [`${id}-match`, firmId, clientId, transactionId, type, id, total]);
      // The coder binds its proposal to the evidence it read, as coding does.
      const connection = await pool.connect();
      try {
        const document = await currentCodingEvidence({ client: connection, firmId, clientId, transactionId });
        await connection.query(`update transactions set payload = jsonb_set(payload, '{ai_suggestion,evidence_digest}', to_jsonb($2::text))
          where id = $1`, [transactionId, codingEvidenceDigest(document)]);
      } finally { connection.release(); }
    };
    const xero = (transactionId, dryRun) => writebackXeroTransactionInDb({
      firmId, clientId, connectionId, transactionId, actorId, dryRun, skipSnapshot: true
    });
    const nativeDryRun = transactionId => postLedgerTransactionInDb({ firmId, clientId, transactionId, dryRun: true, skipSnapshot: true });
    const nothingWritten = async id => {
      const journals = await pool.query('select id from ledger_journals where firm_id=$1 and client_id=$2 and source_id=$3', [firmId, clientId, id]);
      assert.deepEqual(journals.rows, [], `${id}: no Donna journal`);
      const row = (await pool.query('select coding_state,payload from transactions where id=$1', [id])).rows[0];
      assert.equal(row.coding_state, 'applied', `${id}: coding state unchanged`);
      assert.ok(!row.payload.xero_bank_transaction_id, `${id}: no Xero id recorded`);
      assert.notEqual(row.payload.xero_sync_status, 'synced', `${id}: not marked synced`);
      return row;
    };
    const posted = async id => {
      const before = created().length;
      const result = await xero(id, false);
      assert.equal(created().length, before + 1, `${id}: one Xero create`);
      const row = (await pool.query('select payload from transactions where id=$1', [id])).rows[0];
      assert.equal(row.payload.xero_sync_status, 'synced', JSON.stringify(row.payload.ledger_post_refusal || result));
      assert.ok(row.payload.ledger_journal_id, `${id}: Donna journal posted`);
    };
    return { seed, source, xero, nativeDryRun, nothingWritten, posted };
  };
  const { seed, source, xero, nativeDryRun, nothingWritten, posted } = await xeroClient({ jurisdiction: 'fi', currency: 'EUR', taxFlag: 'FINLAND_ALV_CODING', rate: 0.255 });

  // Fault 2 — rated purchase and rated sale, each with its settled source.
  await seed('purchase', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 124 });
  await source('purchase-receipt', 'receipt', 124, 25.2, 'purchase');
  await seed('sale', { account: 'Sales', code: '200', treatment: 'ALV 25,5 %', moneyIn: 124 });
  await source('sale-invoice', 'sales_invoice', 124, 25.2, 'sale');
  // Parity — a rated purchase with no source at all; both paths refuse it.
  await seed('purchase-unsourced', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 62 });
  // Fault 1 — operating revenue with no sales source; untaxed, so only the
  // evidence check (not the tax policy) can refuse it.
  await seed('sale-unsourced', { account: 'Sales', code: '200', treatment: 'Ei ALV-käsittelyä', moneyIn: 80 });

  await t.test('the dry run gives the same verdict, with the same code, as native posting', async () => {
    const verdicts = {};
    for (const id of ['purchase', 'sale', 'purchase-unsourced', 'sale-unsourced']) {
      verdicts[id] = { native: await outcome(nativeDryRun(id)), xero: await outcome(xero(id, true)) };
    }
    assert.deepEqual(verdicts, {
      purchase: { native: 'admitted', xero: 'admitted' },
      sale: { native: 'admitted', xero: 'admitted' },
      'purchase-unsourced': { native: 'TRANSACTION_ALV_EVIDENCE_REQUIRED', xero: 'TRANSACTION_ALV_EVIDENCE_REQUIRED' },
      'sale-unsourced': { native: 'TRANSACTION_REVENUE_SOURCE_REQUIRED', xero: 'TRANSACTION_REVENUE_SOURCE_REQUIRED' }
    });
    assert.deepEqual(providerCalls.filter(call => call.method !== 'GET'), [], 'a dry run writes nothing to Xero');
  });

  await t.test('execute refuses without a provider write and leaves nothing half-written', async () => {
    for (const [id, code] of [['purchase-unsourced', 'TRANSACTION_ALV_EVIDENCE_REQUIRED'], ['sale-unsourced', 'TRANSACTION_REVENUE_SOURCE_REQUIRED']]) {
      const before = created().length;
      await assert.rejects(xero(id, false), error => error.code === code);
      assert.equal(created().length, before, `${id}: nothing was sent to Xero`);
      await nothingWritten(id);
    }
    // The tax-policy refusal keeps its existing receipt on the line.
    assert.equal((await nothingWritten('purchase-unsourced')).payload.ledger_post_refusal?.code, 'TRANSACTION_ALV_EVIDENCE_REQUIRED');
  });

  await t.test('evidence withdrawn between dry run and execute is refused at execute, before the provider write', async () => {
    await seed('sale-withdrawn', { account: 'Sales', code: '200', treatment: 'Ei ALV-käsittelyä', moneyIn: 90 });
    await source('sale-withdrawn-invoice', 'sales_invoice', 90, 0, 'sale-withdrawn');
    await seed('purchase-withdrawn', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 248 });
    await source('purchase-withdrawn-receipt', 'receipt', 248, 50.39, 'purchase-withdrawn');
    for (const id of ['sale-withdrawn', 'purchase-withdrawn']) {
      assert.equal(await outcome(nativeDryRun(id)), 'admitted', `${id}: native admits while its source is settled`);
      assert.equal(await outcome(xero(id, true)), 'admitted', `${id}: Xero admits while its source is settled`);
      const before = created().length;
      // The provider's duplicate lookup runs after the execute call's own
      // preparation and before its locked execute step: the match is rejected there.
      mutateOnRead = () => pool.query("update reconciliation_matches set status='rejected' where bank_transaction_id=$1", [id]);
      const xeroCode = await outcome(xero(id, false));
      const nativeCode = await outcome(nativeDryRun(id));
      assert.notEqual(nativeCode, 'admitted', `${id}: native refuses once the evidence is withdrawn`);
      assert.equal(xeroCode, nativeCode, `${id}: Xero execute refuses with the native code`);
      assert.equal(mutateOnRead, null, `${id}: the withdrawal ran`);
      assert.equal(created().length, before, `${id}: nothing was sent to Xero`);
      const row = await nothingWritten(id);
      // What the operator sees for an execute-step refusal: the line's write-back
      // error, and a failed write-back run carrying the refusal message.
      assert.equal(row.payload.xero_writeback_status, 'error', `${id}: the write-back failure is on the line`);
      const runs = (await pool.query("select status,error from xero_sync_runs where payload->>'transaction_id'=$1", [id])).rows;
      assert.deepEqual(runs.map(run => run.status), ['failed']);
      assert.equal(runs[0].error, row.payload.xero_writeback_error);
    }
  });

  await t.test('an entry native posting would post, with its matched document, is written to Xero and the ledger', async () => {
    for (const id of ['purchase', 'sale']) await posted(id);
  });

  await t.test('UK with VAT coding on: a rated purchase with its receipt is admitted; without one, refused as native refuses', async () => {
    const gb = await xeroClient({ jurisdiction: 'gb', currency: 'GBP', taxFlag: 'JURISDICTION_TAX_CODING', rate: 0.2 });
    await gb.seed('gb-purchase', { account: 'Purchases', code: '400', treatment: 'VAT 20%', moneyOut: 120 });
    await gb.source('gb-purchase-receipt', 'receipt', 120, 20, 'gb-purchase');
    await gb.seed('gb-purchase-unsourced', { account: 'Purchases', code: '400', treatment: 'VAT 20%', moneyOut: 60 });
    const verdicts = {};
    for (const id of ['gb-purchase', 'gb-purchase-unsourced']) {
      verdicts[id] = { native: await outcome(gb.nativeDryRun(id)), xero: await outcome(gb.xero(id, true)) };
    }
    assert.deepEqual(verdicts, {
      'gb-purchase': { native: 'admitted', xero: 'admitted' },
      'gb-purchase-unsourced': { native: 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED', xero: 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED' }
    });
    const before = created().length;
    await assert.rejects(gb.xero('gb-purchase-unsourced', false), error => error.code === 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED');
    assert.equal(created().length, before, 'nothing was sent to Xero');
    await gb.nothingWritten('gb-purchase-unsourced');
    await gb.posted('gb-purchase');
  });
});
