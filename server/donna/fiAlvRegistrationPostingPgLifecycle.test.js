// Real PG (FI, synthetic data): the Finnish posting path through
// postLedgerTransactionInDb → finland/postingPolicy.js, the twin of
// gbVatRegistrationPostingPgLifecycle.test.js. ALV registration, not the
// FINLAND_ALV_CODING rollout switch, decides whether an ALV code may post: a
// business recorded as not registered (or with no usable record) gets no
// ALV-coded journal; the line stays unposted with a named refusal until the
// registration record says otherwise.
//   DONNA_PG_TEST_URL=... node --test server/donna/fiAlvRegistrationPostingPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { ledgerRecordId } from './db/shared.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, postLedgerTransactionInDb, seedPackPaletteChartWithClient, batchSuggestTransactionCodingInDb } from './firmDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'fi-alv-registration-proof';

test('real PG (FI): ALV registration gates ALV-coded posting', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_fi_alv_registration_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic Finnish firm',$1)", [firmId]);

  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-only';
  t.after(() => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; });

  const book = async (clientId, alvRegistration) => {
    const profile = { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', ...(alvRegistration ? { alv_registration: alvRegistration } : {}) };
    await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$3,'FI','fi-oy',$4)", [clientId, firmId, `Synthetic ${clientId} Oy`, profile]);
    for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
    await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  };
  // Each line carries its settled source, so the Finnish evidence rule is met
  // and only the registration decides.
  const fixtures = new Map();
  const line = async (clientId, id, { incoming = false, account, treatment = 'ALV 25,5 %', gross = 125.5 }) => {
    fixtures.set(id, { account, treatment });
    const family = incoming ? 'sales_invoice' : 'receipt';
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2026-06-02',$4,$5,$6,'EUR','needs_review','{}')",
      [id, firmId, clientId, `Synthetic ${id}`, incoming ? gross : 0, incoming ? 0 : gross]);
    await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$1,$4,'completed',$5,$6,'EUR','2026-06-02','{}')",
      [`doc-${id}`, firmId, clientId, family, gross, Math.round(gross / 1.255 * 0.255 * 100) / 100]);
    await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.98,'auto_matched','fixture','{}')",
      [`match-${id}`, firmId, clientId, id, family, `doc-${id}`, gross]);
  };
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      const f = fixtures.get(row.id); assert.ok(f, row.id);
      return { transaction_id: row.id, proposed_account: f.account, tax_treatment: f.treatment, confidence: 'high', evidence_required: false, auto_explain_limit: 5000,
        reasoning: 'The settled source supports the account and its printed ALV.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  const code = clientId => batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const journal = async id => (await pool.query("select l.account_name,l.debit,l.credit,l.tax_type from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.source_type='transaction' and j.source_id=$2 order by l.line_no", [firmId, id])).rows
    .map(r => [r.account_name, Number(r.debit), Number(r.credit), r.tax_type || null]);
  const refusal = async id => (await pool.query("select payload->'ledger_post_refusal' as refusal from transactions where firm_id=$1 and id=$2", [firmId, id])).rows[0]?.refusal || null;
  const post = (clientId, id, dryRun = false) => postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun });
  const refused = async (clientId, id, refusalCode) => {
    assert.deepEqual(await journal(id), [], `${id} has no journal`);
    assert.equal((await refusal(id))?.code, refusalCode, `${id} carries the named refusal`);
    await assert.rejects(post(clientId, id, true), { code: refusalCode }, `${id} preview`);
  };
  const reclaim = [['Office expenses', 100, 0, 'ALV_25_5_INPUT'], ['Vähennettävä arvonlisävero', 25.5, 0, 'NONE']];

  // 1. Recorded as not registered, switch on: the purchase would have posted
  //    net + deductible input ALV, the sale net + output ALV. Both refuse by
  //    name; nothing reaches the ledger.
  await book('unregistered', { status: 'not_registered' });
  await line('unregistered', 'u-purchase', { account: 'Office expenses' });
  await line('unregistered', 'u-sale', { incoming: true, account: 'Sales' });
  await code('unregistered');
  await refused('unregistered', 'u-purchase', 'TRANSACTION_ALV_REGISTRATION_REQUIRED');
  // The sale settles the business's own sales invoice, which prints ALV: that
  // contradicts the record, so it is refused by the sale-source rule
  // (taxSourceEvidence.js assertSalesSourceTaxRegistration) before the
  // registration rule reads its code. Still nothing reaches the ledger; the
  // registration rule on a rated sale is pinned in finland/postingPolicy.test.js.
  await refused('unregistered', 'u-sale', 'TRANSACTION_ALV_SALE_SOURCE_SHOWS_VAT_UNREGISTERED');

  // 2. No registration record at all: unknown is not "registered".
  await book('unrecorded', null);
  await line('unrecorded', 'n-purchase', { account: 'Office expenses' });
  await code('unrecorded');
  await refused('unrecorded', 'n-purchase', 'TRANSACTION_ALV_REGISTRATION_REQUIRED');

  // 3. Registered: the same purchase posts its net, input ALV and gross bank.
  await book('registered', { status: 'registered', registered_from: '2020-01-01' });
  await line('registered', 'r-purchase', { account: 'Office expenses' });
  await code('registered');
  assert.deepEqual((await journal('r-purchase')).filter(([, debit]) => debit > 0).sort(), [...reclaim].sort());

  // 4. Recording the registration is the recovery: the refused line now posts
  //    with its code, never with the code dropped.
  await pool.query("update clients set profile = profile || $2::jsonb where id=$1", ['unregistered', { alv_registration: { status: 'registered', registered_from: '2026-01-01' } }]);
  await post('unregistered', 'u-purchase');
  assert.deepEqual((await journal('u-purchase')).filter(([, debit]) => debit > 0).sort(), [...reclaim].sort());
});

// The settlement-row split books the processor fee with its own ALV split,
// whatever the sales leg carries. With FINLAND_ALV_CODING off the sales leg
// is not read for a code, so only the registration stops a deductible fee ALV
// posting on the books of a business that is not registered.
test('real PG (FI): a processor fee posts no ALV split for a business not recorded as registered', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_fi_alv_fee_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const clientId = 'fee-unregistered';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic Finnish firm',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Kortti Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', alv_registration: { status: 'not_registered' } }]);
  for (const [code, name, type, normal, role] of [['1910', 'Pankkitili', 'bank', 'debit', 'asset.cash'], ['3000', 'Sales', 'revenue', 'credit', 'revenue.operating'],
    ['4550', 'Platform and processor fees', 'expense', 'debit', 'expense.platform_fees']]) await pool.query(
    "insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'EUR',$8,'active')",
    [ledgerRecordId('account', firmId, clientId, code), firmId, clientId, code, name, type, normal, role]);
  const row = { row_no: 1, period_label: 'Week 22', gross: 1000, fee: 20, fee_tax: 5.1, net: 974.9, net_derived: false };
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,status,parse_status,total_amount,currency,document_date,payload) values('payout',$1,$2,'Synthetic payout report.pdf','payout_statement','received','completed',974.9,'EUR','2026-06-02','{}')", [firmId, clientId]);
  await pool.query("insert into document_lines(id,firm_id,client_id,document_id,description,quantity,unit_price,amount,line_no,review_status,payload) values('payout-ln-1',$1,$2,'payout','Week 22',1,974.9,974.9,1,'needs_review',$3)",
    [firmId, clientId, { raw_extraction: { description: 'Week 22', amount: 974.9, settlement_row: row } }]);
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload) values('payout-tx',$1,$2,'2026-06-02','Synthetic card payout',974.9,0,'EUR','needs_review','applied',$3)",
    [firmId, clientId, { category: 'Sales', account_code: 'Sales', account_name: 'Sales', ai_suggestion: { proposed_account: 'Sales', processor_fee_tax_treatment: 'ALV 25,5 %' } }]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,matched_line_id,match_amount,match_confidence,status,created_by,payload) values('payout-match',$1,$2,'payout-tx','payout_statement','payout','payout-ln-1',974.9,.95,'confirmed','fixture','{}')", [firmId, clientId]);
  for (const dryRun of [true, false]) await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'payout-tx', dryRun, skipSnapshot: true }),
    { code: 'TRANSACTION_ALV_REGISTRATION_REQUIRED' }, `dryRun=${dryRun}`);
  assert.equal((await pool.query("select count(*)::int n from ledger_journals where source_id='payout-tx'")).rows[0].n, 0);
  // Recorded as registered, the same line posts its fee with the ALV split.
  await pool.query("update clients set profile = profile || $2::jsonb where id=$1", [clientId, { alv_registration: { status: 'registered', registered_from: '2026-01-01' } }]);
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'payout-tx', dryRun: false, skipSnapshot: true });
  const lines = (await pool.query("select l.account_code,l.debit,l.tax_type from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.source_id='payout-tx' and l.debit>0 order by l.line_no")).rows
    .map(r => [r.account_code, Number(r.debit), r.tax_type]);
  assert.ok(lines.some(([code, debit, tax]) => code === '4550' && debit === 20 && tax === 'ALV_25_5_INPUT'), JSON.stringify(lines));
});
