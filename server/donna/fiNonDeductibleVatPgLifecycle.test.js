import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, postLedgerTransactionInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { getFinlandAlvReturnFromDb } from './statutoryRegistry.js';
import { currentCodingEvidence, codingEvidenceDigest } from './db/codingEvidence.js';

// FIK-V (docs/plan-2026-09-22-fi-jev-decision-knowledge.md §8): the Finnish
// non-deductible input-purchase treatment, end to end through the real coder
// batch, the named ledger writer and the ALV return — beside a deductible
// neighbour in the same period so a regression in either shows.
const pgUrl = process.env.DONNA_PG_TEST_URL;
test('real PG: a non-deductible FI purchase posts gross with its code, no 2940 leg and no 307 deduction', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_fi_nondeductible_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-only';
  t.after(async () => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'nondeductible-proof', clientId = 'fi-nondeductible';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic non-deductible proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Edustus Oy','FI','fi-oy',$3)", [clientId, firmId, { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash' }]);
  for (const flag of ['FINLAND_ALV_CODING', 'FINLAND_ALV_RETURN', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'auto','manual')", [flag, firmId, clientId]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  // Every receipt prints 25,5 % VAT. Only the coder's treatment decides whether
  // the client may deduct it; the printed tax never forces a split.
  const fixtures = [
    { id: 'client-lunch', incoming: false, account: 'Meals and entertainment', treatment: 'Vähennyskelvoton ALV (osto)', gross: 125.5 },
    { id: 'client-lunch-refund', incoming: true, account: 'Meals and entertainment', treatment: 'Vähennyskelvoton ALV (osto)', gross: 25.1 },
    { id: 'supplies', incoming: false, account: 'Operating supplies', treatment: 'ALV 25,5 %', gross: 251 }
  ];
  const seed = async f => {
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2025-02-25',$1,$4,$5,'EUR','needs_review','{}')", [f.id, firmId, clientId, f.incoming ? f.gross : 0, f.incoming ? 0 : f.gross]);
    await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$1,'receipt','completed',$4,$5,'EUR','2025-02-25','{}')", ['doc-' + f.id, firmId, clientId, f.gross, Math.round(f.gross / 1.255 * 25.5) / 100]);
    await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')", ['match-' + f.id, firmId, clientId, f.id, 'doc-' + f.id, f.gross]);
  };
  let offered = null;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body);
    offered = JSON.stringify(body.text?.format?.schema || body);
    const input = JSON.parse(body.input);
    const suggestions = input.transactions.map(row => {
      const f = fixtures.find(f => f.id === row.id); assert.ok(f);
      return { transaction_id: row.id, proposed_account: f.account, tax_treatment: f.treatment, confidence: 'high', evidence_required: false, auto_explain_limit: 5000, reasoning: 'The source supports the selected account and treatment.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  for (const f of fixtures) await seed(f);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.ok(offered?.includes('Vähennyskelvoton ALV (osto)'), 'the live coder menu offers the treatment');
  const journal = async id => (await pool.query("select l.account_name,l.account_code,l.tax_type,l.debit,l.credit,l.payload from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.client_id=$2 and j.source_type='transaction' and j.source_id=$3 order by l.line_no", [firmId, clientId, id])).rows;
  const shape = rows => rows.map(r => [r.account_name, Number(r.debit), Number(r.credit), r.tax_type || null]).sort();

  for (const f of fixtures.filter(f => f.treatment !== 'ALV 25,5 %')) {
    const rows = await journal(f.id);
    assert.deepEqual(shape(rows), [
      ['Business Checking · EUR', f.incoming ? f.gross : 0, f.incoming ? 0 : f.gross, 'NONE'],
      [f.account, f.incoming ? 0 : f.gross, f.incoming ? f.gross : 0, 'ALV_NONDEDUCTIBLE_INPUT']
    ].sort(), f.id);
    assert.ok(rows.every(r => !r.payload.role?.startsWith('alv_')), `${f.id}: no VAT control leg`);
    assert.ok(rows.every(r => !/arvonlisävero/.test(r.account_name)), `${f.id}: nothing reaches 2940/2939`);
    const coded = (await pool.query('select coding_state,payload from transactions where id=$1', [f.id])).rows[0];
    assert.equal(coded.coding_state, 'posted');
    assert.equal(coded.payload.ai_suggestion.tax_treatment, 'Vähennyskelvoton ALV (osto)');
  }
  // The neighbouring deductible purchase still splits exactly as before.
  assert.deepEqual(shape(await journal('supplies')), [
    ['Business Checking · EUR', 0, 251, 'NONE'], ['Operating supplies', 200, 0, 'ALV_25_5_INPUT'], ['Vähennettävä arvonlisävero', 51, 0, 'NONE']
  ].sort());

  // The return: the non-deductible lines are coded (not uncoded expenses),
  // unreported, and 307 carries only the deductible neighbour.
  const report = await getFinlandAlvReturnFromDb({ firmId, clientId, period: '2025-02', readAt: '2025-03-01T12:00:00Z' });
  assert.deepEqual(report.review.blockers, []);
  assert.deepEqual(report.review.incompatibleLines, []);
  assert.equal(report.alvReturn.boxes['307'], 51);
  assert.equal(report.alvReturn.boxes['308'], -51);
  assert.deepEqual(report.review.controlCheck.domesticDeductible, { expected: 51, actual: 51 });
  assert.equal(report.review.uncodedExpenseLineCount, 0, 'a coded non-deductible purchase is not an uncoded expense');

  // The code is purchase-only: authored on a sales line it is a named refusal
  // at preview and write, never a journal.
  await seed({ id: 'wrong-side', incoming: true, gross: 125.5 });
  await pool.query("update transactions set coding_state='applied',payload=$2 where id=$1", ['wrong-side', { account_name: 'Sales', account_code: 'Sales', category: 'Sales', xero_tax_type: 'ALV_NONDEDUCTIBLE_INPUT', tax_treatment: 'ALV_NONDEDUCTIBLE_INPUT' }]);
  for (const dryRun of [true, false]) await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'wrong-side', dryRun, skipSnapshot: true }), { code: 'TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE' });
  assert.equal((await journal('wrong-side')).length, 0);

  // A restricted deduction on a SELF-ASSESSED purchase would drop output tax
  // that is still due, so that prose resolves to nothing and stays proposed.
  await seed({ id: 'eu-restricted', incoming: false, gross: 100 });
  await pool.query("update transactions set coding_state='applied',payload=$2 where id=$1", ['eu-restricted', { account_name: 'Meals and entertainment', account_code: 'Meals and entertainment', category: 'Meals and entertainment', tax_treatment: 'EU-palveluosto, vähennyskelvoton' }]);
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: 'eu-restricted', dryRun: false, skipSnapshot: true }), { code: 'TRANSACTION_ALV_TREATMENT_UNRESOLVED' });
  assert.equal((await journal('eu-restricted')).length, 0);
});

// The component writer (db/documentAllocation.js) is the second tax-leg path:
// one receipt, one non-deductible component and one deductible 14 % component.
// The non-deductible line posts its full source gross with no control leg; the
// deductible line still splits to exactly the source's printed VAT.
test('real PG: a document allocation mixes a non-deductible component with a deductible one', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_fi_nondeductible_alloc_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'nondeductible-alloc', clientId = 'fi-nondeductible-alloc', id = 'hotel-stay';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic allocation proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Matka Oy','FI','fi-oy',$3)", [clientId, firmId, { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash' }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'auto','manual')", [flag, firmId, clientId]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2025-02-21',$1,0,123.2,'EUR','needs_review','{}')", [id, firmId, clientId]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,parse_summary,payload) values('doc-hotel',$1,$2,'hotel.pdf','receipt','completed',123.2,23.2,'EUR','2025-02-21',$3,'{}')", [firmId, clientId, { line_amounts_include_tax: true, totals_validation: { matches: true } }]);
  for (const [i, amount, rate] of [[0, 100.4, .255], [1, 22.8, .14]]) await pool.query("insert into document_lines(id,firm_id,client_id,document_id,line_no,description,amount,payload) values($1,$2,$3,'doc-hotel',$4,'Synthetic component',$5,$6)", [`line-hotel-${i}`, firmId, clientId, i + 1, amount, { raw_extraction: { amount, tax_rate: rate } }]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values('match-hotel',$1,$2,$3,'receipt','doc-hotel',123.2,.95,'auto_matched','fixture','{}')", [firmId, clientId, id]);
  const evidence = await currentCodingEvidence({ client: pool, firmId, clientId, transactionId: id });
  const suggestion = { proposed_account: 'Meals and entertainment', tax_treatment: 'Vähennyskelvoton ALV (osto)', posting_requirement: 'document_allocation',
    evidence_digest: codingEvidenceDigest(evidence), document_allocations: [
      { line_handle: 'line_1', account: 'Meals and entertainment', tax_treatment: 'Vähennyskelvoton ALV (osto)' },
      { line_handle: 'line_2', account: 'Travel', tax_treatment: 'ALV 14 %' }] };
  await pool.query("update transactions set coding_state='applied',payload=$2 where id=$1", [id, { proposed_account: suggestion.proposed_account, tax_treatment: suggestion.tax_treatment, ai_suggestion: suggestion, ai_suggestion_status: 'auto_applied' }]);
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: false });
  const rows = (await pool.query("select l.account_name,l.tax_type,l.debit,l.credit,l.payload from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.source_id=$2 order by l.line_no", [firmId, id])).rows;
  assert.deepEqual(rows.map(r => [r.account_name, Number(r.debit), Number(r.credit), r.tax_type || null]).sort(), [
    ['Business Checking · EUR', 0, 123.2, 'NONE'],
    ['Meals and entertainment', 100.4, 0, 'ALV_NONDEDUCTIBLE_INPUT'],
    ['Travel', 20, 0, 'ALV_14_INPUT'],
    ['Vähennettävä arvonlisävero', 2.8, 0, 'NONE']
  ].sort(), JSON.stringify(rows));
  assert.equal(rows.filter(r => r.payload.role === 'alv_input_deductible').length, 1, 'only the deductible component carries a control leg');
});
