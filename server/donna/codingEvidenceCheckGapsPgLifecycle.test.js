import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { writebackXeroTransactionInDb, retryXeroMirrorInDb } from './db/xero.js';
import { postLedgerTransactionInDb } from './db/ledger.js';
import { assertCurrentCodingEvidence, currentCodingEvidence, codingEvidenceDigest } from './db/codingEvidence.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

// Three gaps around the two posting checks (current coding evidence; the
// country's postable-tax policy judged with the matched document):
// 1. a coding with no evidence digest reached the policy without its matched document;
// 2. an evidence-check refusal left no receipt on the line;
// 3. the Xero mirror retry ran neither check.
// Synthetic Finnish and UK fixtures; every provider call is a local fake.
test('real PG: coding-evidence check gaps on the native, Xero write-back and Xero mirror retry paths', async (t) => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL.');
  const name = `donna_evidence_gaps_${Date.now().toString(36)}_${process.pid}`;
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
  let providerSequence = 0;
  globalThis.fetch = async (address, options = {}) => {
    const parsed = new URL(String(address));
    const method = options.method || 'GET';
    assert.equal(parsed.hostname, 'api.xero.com', 'test may never call an unexpected provider host');
    const body = options.body ? JSON.parse(options.body) : null;
    providerCalls.push({ pathname: parsed.pathname, method, body });
    if (method === 'GET' && parsed.pathname.endsWith('/BankTransactions')) {
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

  const firmId = 'evidence-gaps-firm';
  const actorId = 'evidence-gaps-owner';
  await pool.query("insert into firms (id,name,slug) values ($1,'Synthetic firm','evidence-gaps-fixture')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,name,email,status) values($1,$2,'Fixture owner','fixture@example.invalid','active')", [actorId, firmId]);
  const outcome = promise => promise.then(() => 'admitted', error => error.code || error.message);
  const created = () => providerCalls.filter(call => call.method === 'POST' && call.pathname.endsWith('/BankTransactions'));
  const payloadOf = async id => (await pool.query('select payload from transactions where id=$1', [id])).rows[0].payload;

  // One Xero-connected client with its jurisdiction's tax coding on.
  const xeroClient = async ({ jurisdiction, currency, taxFlag }) => {
    const clientId = `${jurisdiction}-evidence-gaps-client`;
    const connectionId = `${jurisdiction}-evidence-gaps-connection`;
    await pool.query(`insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic company',$3,$4)`,
      [clientId, firmId, jurisdiction, { jurisdiction, accounting_system: 'xero', accounting_basis: 'cash',
        ...(jurisdiction === 'gb' ? { vat_registration: { status: 'registered', registered_from: '2020-01-01' } } : {}),
        // An ALV code posts only for an ALV-registered business (finland/postingPolicy.js).
        ...(jurisdiction === 'fi' ? { alv_registration: { status: 'registered', registered_from: '2020-01-01' } } : {}) }]);
    await pool.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source)
      values($1,$2,$3,$4,'auto','manual')`, [`${jurisdiction}-evidence-gaps-tax`, firmId, clientId, taxFlag]);
    await pool.query(`insert into xero_connections(id,firm_id,client_id,tenant_id,status,scopes,access_token,refresh_token,expires_at)
      values($1,$2,$3,$4,'connected',array['accounting.banktransactions'],'fixture-access','fixture-refresh','2099-01-01T00:00:00Z')`,
    [connectionId, firmId, clientId, `${jurisdiction}-fixture-tenant`]);
    for (const [code, label, type, taxType] of [['090', `${currency} bank`, 'BANK', 'NONE'], ['200', 'Sales', 'REVENUE', 'OUTPUT2'], ['400', 'Purchases', 'EXPENSE', 'INPUT2']]) {
      await pool.query(`insert into xero_accounts(id,connection_id,firm_id,client_id,xero_account_id,code,name,type,status,tax_type,payload)
        values($1,$2,$3,$4,$1,$5,$6,$7,'ACTIVE',$8,$9)`,
      [`${jurisdiction}-xero-account-${code}`, connectionId, firmId, clientId, code, label, type, taxType, { currency }]);
    }
    // An applied coding with no person's acceptance. `extra` sets how it was
    // made (an autonomous coder, a client rule); no evidence digest is written
    // unless bindDigest is called, as for a coding made before evidence was tracked.
    const seed = async (id, { account, code, treatment, moneyIn = 0, moneyOut = 0, extra = {} }) => {
      await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
        values($1,$2,$3,'2026-09-09',$4,$5,$6,$7,'needs_review','applied',$8)`,
      [id, firmId, clientId, `Synthetic ${id}`, moneyIn, moneyOut, currency, {
        ai_suggestion_status: 'auto_applied',
        ai_suggestion: { proposed_account: account, account_code: code, tax_treatment: treatment, confidence: 'high' },
        ...extra
      }]);
    };
    const source = async (id, type, total, tax, transactionId, rate) => {
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,document_date,currency,total_amount,tax_amount,parse_summary)
        values($1,$2,$3,$1,$4,'completed','2026-09-08',$5,$6,$7,'{"line_amounts_include_tax":true,"totals_validation":{"matches":true}}')`,
      [id, firmId, clientId, type, currency, total, tax]);
      await pool.query(`insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,tax_rate,payload)
        values($1,$2,$3,$4,1,'Synthetic goods',$5,$6,$7)`, [`${id}-line`, firmId, clientId, id, total, rate, { raw_extraction: { amount: total, tax_rate: rate } }]);
      await pool.query(`insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,status,match_amount,match_confidence,payload)
        values($1,$2,$3,$4,$5,$6,'auto_matched',$7,0.9,'{}')`, [`${id}-match`, firmId, clientId, transactionId, type, id, total]);
    };
    // The coder binds its proposal to the evidence it read, as coding does.
    const bindDigest = async transactionId => {
      const connection = await pool.connect();
      try {
        const document = await currentCodingEvidence({ client: connection, firmId, clientId, transactionId });
        await connection.query(`update transactions set payload = jsonb_set(payload, '{ai_suggestion,evidence_digest}', to_jsonb($2::text))
          where id = $1`, [transactionId, codingEvidenceDigest(document)]);
      } finally { connection.release(); }
    };
    const evidence = async transactionId => {
      const connection = await pool.connect();
      try {
        const row = (await connection.query('select * from transactions where id=$1', [transactionId])).rows[0];
        const { rowToTransactionPayload } = await import('./db/transactions.js');
        return await assertCurrentCodingEvidence({ client: connection, firmId, clientId, transaction: rowToTransactionPayload(row) });
      } finally { connection.release(); }
    };
    const xero = (transactionId, dryRun) => writebackXeroTransactionInDb({
      firmId, clientId, connectionId, transactionId, actorId, dryRun, skipSnapshot: true
    });
    const native = (transactionId, dryRun = true) => postLedgerTransactionInDb({ firmId, clientId, transactionId, dryRun, skipSnapshot: true, actorId });
    const retry = async (transactionId, dryRun) => (await retryXeroMirrorInDb({ firmId, clientId, connectionId, transactionIds: [transactionId],
      periodStart: '2026-09-01', periodEnd: '2026-09-30', dryRun, actorId })).xero_mirror_retry.results[0];
    return { clientId, seed, source, bindDigest, evidence, xero, native, retry };
  };
  const verdicts = async (fixture, ids) => {
    const result = {};
    for (const id of ids) result[id] = { native: await outcome(fixture.native(id)), xero: await outcome(fixture.xero(id, true)) };
    return result;
  };

  const fi = await xeroClient({ jurisdiction: 'fi', currency: 'EUR', taxFlag: 'FINLAND_ALV_CODING' });
  const gb = await xeroClient({ jurisdiction: 'gb', currency: 'GBP', taxFlag: 'JURISDICTION_TAX_CODING' });

  await t.test('fault 1: a coding with no evidence digest reaches the policy with its matched document, and only with one', async () => {
    // An autonomous rated purchase coded before evidence was tracked, with its
    // settled receipt: on main refused as if it had no receipt.
    await fi.seed('fi-nodigest-purchase', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 124 });
    await fi.source('fi-nodigest-purchase-receipt', 'receipt', 124, 25.2, 'fi-nodigest-purchase', 0.255);
    // The same coding with no document at all stays without evidence.
    await fi.seed('fi-nodigest-unsourced', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 62 });
    // A client-rule sale at 25.5 % whose matched invoice is at 14 %: on main the
    // policy never saw the invoice and posted it; with its document it refuses.
    await fi.seed('fi-nodigest-rule-sale', { account: 'Sales', code: '200', treatment: 'ALV 25,5 %', moneyIn: 114,
      extra: { auto_categorize_source: 'client_rule' } });
    await fi.source('fi-nodigest-rule-sale-invoice', 'sales_invoice', 114, 14, 'fi-nodigest-rule-sale', 0.14);
    // The same client-rule sale with no document still posts (no document to contradict it).
    await fi.seed('fi-nodigest-rule-sale-unsourced', { account: 'Sales', code: '200', treatment: 'ALV 25,5 %', moneyIn: 57,
      extra: { auto_categorize_source: 'client_rule' } });
    // UK: an autonomous rated purchase with its receipt and no digest.
    await gb.seed('gb-nodigest-purchase', { account: 'Purchases', code: '400', treatment: 'VAT 20%', moneyOut: 120 });
    await gb.source('gb-nodigest-purchase-receipt', 'receipt', 120, 20, 'gb-nodigest-purchase', 0.2);
    await gb.seed('gb-nodigest-unsourced', { account: 'Purchases', code: '400', treatment: 'VAT 20%', moneyOut: 60 });

    assert.equal((await fi.evidence('fi-nodigest-purchase'))?.document_id, 'fi-nodigest-purchase-receipt', 'the matched document is returned');
    assert.equal(await fi.evidence('fi-nodigest-unsourced'), null, 'no document is invented');
    assert.equal((await gb.evidence('gb-nodigest-purchase'))?.document_id, 'gb-nodigest-purchase-receipt');

    assert.deepEqual(await verdicts(fi, ['fi-nodigest-purchase', 'fi-nodigest-unsourced', 'fi-nodigest-rule-sale', 'fi-nodigest-rule-sale-unsourced']), {
      // Now posts (was TRANSACTION_ALV_EVIDENCE_REQUIRED).
      'fi-nodigest-purchase': { native: 'admitted', xero: 'admitted' },
      'fi-nodigest-unsourced': { native: 'TRANSACTION_ALV_EVIDENCE_REQUIRED', xero: 'TRANSACTION_ALV_EVIDENCE_REQUIRED' },
      // Now refused (was admitted).
      'fi-nodigest-rule-sale': { native: 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT', xero: 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT' },
      'fi-nodigest-rule-sale-unsourced': { native: 'admitted', xero: 'admitted' }
    });
    assert.deepEqual(await verdicts(gb, ['gb-nodigest-purchase', 'gb-nodigest-unsourced']), {
      // Now posts (was TRANSACTION_GB_VAT_EVIDENCE_REQUIRED).
      'gb-nodigest-purchase': { native: 'admitted', xero: 'admitted' },
      'gb-nodigest-unsourced': { native: 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED', xero: 'TRANSACTION_GB_VAT_EVIDENCE_REQUIRED' }
    });
    assert.deepEqual(providerCalls.filter(call => call.method !== 'GET'), [], 'dry runs write nothing to Xero');
  });

  await t.test('fault 2: an evidence-check refusal leaves its receipt on the line, on both paths', async () => {
    // Operating revenue with no sales source; untaxed, so only the evidence check refuses it.
    for (const id of ['fi-revenue-native-dry', 'fi-revenue-native', 'fi-revenue-xero-dry', 'fi-revenue-xero']) {
      await fi.seed(id, { account: 'Sales', code: '200', treatment: 'Ei ALV-käsittelyä', moneyIn: 80 });
      await fi.bindDigest(id);
    }
    const attempts = {
      'fi-revenue-native-dry': () => fi.native('fi-revenue-native-dry', true),
      'fi-revenue-native': () => fi.native('fi-revenue-native', false),
      'fi-revenue-xero-dry': () => fi.xero('fi-revenue-xero-dry', true),
      'fi-revenue-xero': () => fi.xero('fi-revenue-xero', false)
    };
    const before = created().length;
    for (const [id, attempt] of Object.entries(attempts)) {
      await assert.rejects(attempt(), error => error.code === 'TRANSACTION_REVENUE_SOURCE_REQUIRED', id);
      const payload = await payloadOf(id);
      assert.equal(payload.ledger_post_refusal?.code, 'TRANSACTION_REVENUE_SOURCE_REQUIRED', `${id}: the line shows why it did not post`);
      assert.ok(payload.ledger_post_refusal.error, `${id}: with the refusal message`);
      assert.ok(!payload.ledger_journal_id, `${id}: no journal`);
      assert.ok(!payload.xero_bank_transaction_id, `${id}: no Xero id`);
      const row = (await pool.query('select coding_state from transactions where id=$1', [id])).rows[0];
      assert.equal(row.coding_state, 'applied', `${id}: coding state unchanged`);
    }
    assert.equal(created().length, before, 'nothing was sent to Xero');
  });

  await t.test('fault 3: the Xero mirror retry runs both checks and refuses before any provider write', async () => {
    // Posted to Donna's ledger with its settled receipt; the Xero mirror is missing.
    await fi.seed('fi-retry-withdrawn', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 248 });
    await fi.source('fi-retry-withdrawn-receipt', 'receipt', 248, 50.39, 'fi-retry-withdrawn', 0.255);
    await fi.bindDigest('fi-retry-withdrawn');
    // A client-rule sale posted with no document.
    await fi.seed('fi-retry-conflict', { account: 'Sales', code: '200', treatment: 'ALV 25,5 %', moneyIn: 228,
      extra: { auto_categorize_source: 'client_rule' } });
    // Posted with its receipt, evidence unchanged. Native posting stamps
    // Donna's own ALV code on the line; the rebuilt Xero request would carry it
    // as the provider TaxType, which the first write-back's connector check refuses.
    await fi.seed('fi-retry-native-code', { account: 'Purchases', code: '400', treatment: 'ALV 25,5 %', moneyOut: 372 });
    await fi.source('fi-retry-native-code-receipt', 'receipt', 372, 75.59, 'fi-retry-native-code', 0.255);
    await fi.bindDigest('fi-retry-native-code');
    // A control: a UK rated purchase with its receipt, posted, evidence
    // unchanged; its rebuilt request carries the provider's own TaxType.
    await gb.seed('gb-retry-clean', { account: 'Purchases', code: '400', treatment: 'VAT 20%', moneyOut: 36 });
    await gb.source('gb-retry-clean-receipt', 'receipt', 36, 6, 'gb-retry-clean', 0.2);
    await gb.bindDigest('gb-retry-clean');
    for (const [fixture, id] of [[fi, 'fi-retry-withdrawn'], [fi, 'fi-retry-conflict'], [fi, 'fi-retry-native-code'], [gb, 'gb-retry-clean']]) {
      await fixture.native(id, false);
      assert.ok((await payloadOf(id)).ledger_journal_id, `${id}: posted to Donna's ledger`);
    }
    // Evidence changes after posting: the receipt's match is rejected; an
    // invoice at another rate is matched to the sale.
    await pool.query("update reconciliation_matches set status='rejected' where bank_transaction_id='fi-retry-withdrawn'");
    await fi.source('fi-retry-conflict-invoice', 'sales_invoice', 228, 28, 'fi-retry-conflict', 0.14);

    const nativeNow = { 'fi-retry-withdrawn': 'TRANSACTION_CODING_EVIDENCE_STALE', 'fi-retry-conflict': 'TRANSACTION_ALV_CODING_SOURCE_CONFLICT',
      'fi-retry-native-code': 'posting_connector_tax_code_unmapped' };
    for (const [id, code] of Object.entries(nativeNow)) {
      const before = created().length;
      const journals = (await pool.query('select * from ledger_journals where source_id=$1 order by id', [id])).rows;
      const payloadBefore = await payloadOf(id);
      const dry = await fi.retry(id, true);
      assert.deepEqual({ status: dry.status, code: dry.error_code }, { status: 'error', code }, `${id}: dry run refused with the check's code`);
      const live = await fi.retry(id, false);
      assert.deepEqual({ status: live.status, code: live.error_code }, { status: 'error', code }, `${id}: execute refused with the check's code`);
      assert.equal(created().length, before, `${id}: nothing was sent to Xero`);
      assert.deepEqual((await pool.query('select * from ledger_journals where source_id=$1 order by id', [id])).rows, journals, `${id}: journals untouched`);
      const payloadAfter = await payloadOf(id);
      assert.ok(!payloadAfter.xero_bank_transaction_id, `${id}: no Xero id`);
      assert.notEqual(payloadAfter.xero_sync_status, 'synced', `${id}: not marked synced`);
      assert.deepEqual(payloadAfter, payloadBefore, `${id}: nothing half-written on the line`);
    }
    const before = created().length;
    assert.equal((await gb.retry('gb-retry-clean', true)).status, 'ready');
    const clean = await gb.retry('gb-retry-clean', false);
    assert.equal(clean.status, 'retried', JSON.stringify(clean));
    assert.equal(created().length, before + 1, 'the unchanged entry is mirrored once');
    assert.equal(created().at(-1).body.BankTransactions[0].LineItems[0].TaxType, 'INPUT2');
  });
});
