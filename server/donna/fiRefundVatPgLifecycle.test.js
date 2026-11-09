import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, postLedgerTransactionInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { getFinlandAlvReturnFromDb } from './statutoryRegistry.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'refund-proof', clientId = 'fi-refund';
async function freshFiBook(t, label) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_fi_${label}_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-only';
  t.after(async () => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic refund proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Refund Oy','FI','fi-oy',$3)", [clientId, firmId, { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash' }]);
  for (const flag of ['FINLAND_ALV_CODING', 'FINLAND_ALV_RETURN', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$1,'auto','manual')", [flag, firmId, clientId]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  const journal = async id => (await pool.query("select j.id,l.account_name,l.account_code,l.tax_type,l.debit,l.credit,l.payload from ledger_journals j join ledger_lines l on l.journal_id=j.id where j.firm_id=$1 and j.client_id=$2 and j.source_type='transaction' and j.source_id=$3 order by l.line_no", [firmId, clientId, id])).rows;
  return { pool, journal };
}

test('real PG: FI purchase and customer refunds reverse their coded VAT side, with a compatible full return', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool, journal } = await freshFiBook(t, 'refund');
  const fixtures = [
    { id: 'purchase-refund', incoming: true, account: 'Office expenses', family: 'receipt', gross: 125.5 },
    { id: 'sale', incoming: true, account: 'Sales', family: 'sales_invoice', gross: 251 },
    { id: 'purchase', incoming: false, account: 'Office expenses', family: 'receipt', gross: 251 },
    { id: 'customer-refund', incoming: false, account: 'Sales', family: 'sales_invoice', gross: 125.5 }
  ];
  const seed = async f => {
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2025-02-25',$1,$4,$5,'EUR','needs_review','{}')", [f.id, firmId, clientId, f.incoming ? f.gross : 0, f.incoming ? 0 : f.gross]);
    await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$1,$4,'completed',$5,$6,'EUR','2025-02-25','{}')", ['doc-' + f.id, firmId, clientId, f.family, f.gross, f.gross / 1.255 * .255]);
    await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.98,'auto_matched','fixture','{}')", ['match-' + f.id, firmId, clientId, f.id, f.family, 'doc-' + f.id, f.gross]);
  };
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      const f = fixtures.find(f => f.id === row.id); assert.ok(f);
      return { transaction_id: row.id, proposed_account: f.account, tax_treatment: 'ALV 25,5 %', confidence: 'high', evidence_required: false, auto_explain_limit: 5000, reasoning: 'The source supports the selected account; a refund reverses that source treatment.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  for (const f of fixtures) await seed(f);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  for (const f of fixtures) {
    const rows = await journal(f.id); assert.equal(rows.length, 3, JSON.stringify({ id: f.id, rows }));
    const net = Math.round(f.gross / 1.255 * 100) / 100, vat = Math.round((f.gross - net) * 100) / 100;
    const purchase = f.account === 'Office expenses';
    const expected = [[f.account, f.incoming ? 0 : net, f.incoming ? net : 0, purchase ? 'ALV_25_5_INPUT' : 'ALV_25_5_OUTPUT'], [purchase ? 'Vähennettävä arvonlisävero' : 'Suoritettava arvonlisävero', f.incoming ? 0 : vat, f.incoming ? vat : 0, 'NONE'], ['Business Checking · EUR', f.incoming ? f.gross : 0, f.incoming ? 0 : f.gross, 'NONE']];
    assert.deepEqual(rows.map(r => [r.account_name, Number(r.debit), Number(r.credit), r.tax_type || null]).sort(), expected.sort(), f.id);
    assert.equal(rows.find(r => r.payload.role?.startsWith('alv_')).payload.role, purchase ? 'alv_input_deductible' : 'alv_output');
    const before = JSON.stringify(rows);
    await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: f.id, dryRun: false }), { code: 'LEDGER_ALREADY_POSTED' });
    assert.equal(JSON.stringify(await journal(f.id)), before);
  }
  const report = await getFinlandAlvReturnFromDb({ firmId, clientId, period: '2025-02', readAt: '2025-03-01T12:00:00Z' });
  assert.deepEqual(report.review.blockers, []);
  assert.equal(report.alvReturn.boxes['301'], 25.5); assert.equal(report.alvReturn.boxes['307'], 25.5); assert.equal(report.alvReturn.boxes['308'], 0);
  assert.deepEqual(report.review.incompatibleLines, []);
  assert.equal(report.review.controlCheck.ran, true);
  assert.deepEqual(report.review.controlCheck.outputTax, { expected: 25.5, actual: 25.5 });
  assert.deepEqual(report.review.controlCheck.domesticDeductible, { expected: 25.5, actual: 25.5 });

  // An explicit opposite-side code is an authored conflict, not permission to
  // silently change its side. Both preview and write refuse, with no journal.
  for (const [id, account, code] of [['wrong-output', 'Office expenses', 'ALV_25_5_OUTPUT'], ['wrong-input', 'Sales', 'ALV_25_5_INPUT']]) {
    await seed({ id, account, incoming: true, gross: 125.5, family: 'receipt' });
    await pool.query("update transactions set coding_state='applied',payload=$2 where id=$1", [id, { account_name: account, account_code: account, category: account, xero_tax_type: code, tax_treatment: code }]);
    for (const dryRun of [true, false]) await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun, skipSnapshot: true }), { code: 'TRANSACTION_ALV_ACCOUNT_INCOMPATIBLE' });
    assert.equal((await journal(id)).length, 0);
  }
  // Control-account movements retain NONE and never mint a second VAT leg.
  await seed({ id: 'control-refund', incoming: true, gross: 125.5, family: 'receipt' });
  await pool.query("update transactions set coding_state='applied',payload=$1 where id='control-refund'", [{ account_name: 'Suoritettava arvonlisävero', account_code: '2939', category: 'Suoritettava arvonlisävero', xero_tax_type: 'ALV_25_5_OUTPUT', tax_treatment: 'ALV 25,5 %' }]);
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'control-refund', dryRun: false, skipSnapshot: true });
  const control = await journal('control-refund');
  assert.equal(control.length, 2); assert.ok(control.every(r => r.tax_type === 'NONE'));
  assert.ok(control.every(r => !r.payload.role?.startsWith('alv_')));

});

// Tokmanni shape (hosted FI, 2026-09-23): a small receipt-backed purchase, then
// a refund matched to that same receipt, coded by the model as Other income.
// The matched source is a purchase, so the refund reverses its expense and
// input VAT; a revenue coding against it is refused and the existing
// reconsideration recodes it with that refusal in hand.
test('real PG: a refund matched to its purchase receipt reverses expense and input VAT, never other income', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool, journal } = await freshFiBook(t, 'purchase_refund');
  const rows = [
    { id: 'tokmanni-purchase', date: '2025-02-10', out: 19.9, doc: 'doc-tokmanni', family: 'receipt' },
    { id: 'tokmanni-refund', date: '2025-02-17', in: 19.9, doc: 'doc-tokmanni', family: 'receipt' },
    { id: 'sale-refund', date: '2025-02-18', out: 125.5, doc: 'doc-sale', family: 'sales_invoice' }
  ];
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values('doc-tokmanni',$1,$2,'tokmanni.pdf','receipt','completed',19.90,4.04,'EUR','2025-02-10','{}'),('doc-sale',$1,$2,'sale.pdf','sales_invoice','completed',125.50,25.50,'EUR','2025-02-18','{}')", [firmId, clientId]);
  for (const row of rows) {
    await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,'TOKMANNI',$5,$6,'EUR','needs_review','{}')", [row.id, firmId, clientId, row.date, row.in || 0, row.out || 0]);
    await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.98,'auto_matched','fixture','{}')", ['match-' + row.id, firmId, clientId, row.id, row.family, row.doc, row.in || row.out]);
  }
  // The first coding is the observed wrong one; a recode that carries the
  // writer's refusal returns the source-side account.
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      const refusal = row.posting_recovery?.previous_refusal?.code || null; seen.push([row.id, refusal]);
      const account = row.id === 'tokmanni-purchase' ? 'Office expenses'
        : row.id === 'tokmanni-refund' ? (refusal ? 'Office expenses' : 'Other income')
          : (refusal ? 'Sales' : 'Office expenses');
      return { transaction_id: row.id, proposed_account: account, tax_treatment: 'ALV 25,5 %', confidence: 'high', evidence_required: false, auto_explain_limit: 5000, reasoning: 'Fixture coding.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  const lines = async id => (await journal(id)).map(r => [r.account_name, Number(r.debit), Number(r.credit), r.tax_type || null, r.payload.role?.startsWith('alv_') ? r.payload.role : null]).sort();
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.deepEqual(await lines('tokmanni-purchase'), [
    ['Business Checking · EUR', 0, 19.9, 'NONE', null], ['Office expenses', 15.86, 0, 'ALV_25_5_INPUT', null], ['Vähennettävä arvonlisävero', 4.04, 0, 'NONE', 'alv_input_deductible']].sort());
  // Revenue against a purchase source, and expense against a sales source,
  // contradict the matched source's side whatever the cash direction: refused.
  for (const id of ['tokmanni-refund', 'sale-refund']) {
    assert.deepEqual(await journal(id), [], `${id} must not post against its matched source side`);
    const refusal = (await pool.query("select payload->'ledger_post_refusal' r from transactions where id=$1", [id])).rows[0].r;
    assert.equal(refusal?.code, 'TRANSACTION_SOURCE_ACCOUNT_CLASS_CONFLICT', id);
  }
  const recovered = await recoverChangedCodingEvidenceInDb({ firmId });
  assert.deepEqual(recovered.map(r => r.transaction_id).sort(), ['sale-refund', 'tokmanni-refund']);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.ok(seen.some(([id, code]) => id === 'tokmanni-refund' && code === 'TRANSACTION_SOURCE_ACCOUNT_CLASS_CONFLICT'), 'the recode carries the refusal');
  assert.deepEqual(await lines('tokmanni-refund'), [
    ['Business Checking · EUR', 19.9, 0, 'NONE', null], ['Office expenses', 0, 15.86, 'ALV_25_5_INPUT', null], ['Vähennettävä arvonlisävero', 0, 4.04, 'NONE', 'alv_input_deductible']].sort());
  assert.deepEqual(await lines('sale-refund'), [
    ['Business Checking · EUR', 0, 125.5, 'NONE', null], ['Sales', 100, 0, 'ALV_25_5_OUTPUT', null], ['Suoritettava arvonlisävero', 25.5, 0, 'NONE', 'alv_output']].sort());
  const report = await getFinlandAlvReturnFromDb({ firmId, clientId, period: '2025-02', readAt: '2025-03-01T12:00:00Z' });
  assert.deepEqual(report.review.blockers, []);
  assert.deepEqual(report.review.incompatibleLines, []);
  assert.equal(report.alvReturn.boxes['307'], 0, 'the refunded purchase leaves no deductible input VAT');
  assert.equal(report.alvReturn.boxes['301'], -25.5, 'the customer refund reverses output VAT');
  assert.deepEqual(report.review.controlCheck.domesticDeductible, { expected: 0, actual: 0 });

  // The hosted line was already posted to Other income before this guard. Its
  // source settled after posting; the posted-evidence lane names the class
  // conflict as the correction, not a generic evidence change.
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values('doc-posted',$1,$2,'posted.pdf','receipt','completed',19.90,4.04,'EUR','2025-03-03','{}')", [firmId, clientId]);
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values('posted-refund',$1,$2,'2025-03-05','TOKMANNI',19.90,0,'EUR','needs_review','{}')", [firmId, clientId]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values('match-posted',$1,$2,'posted-refund','receipt','doc-posted',19.90,.6,'suggested','fixture','{}')", [firmId, clientId]);
  // The writer now refuses this autonomous output ALV without a sales source,
  // so the historical journal is minted under a reviewer receipt and the row
  // is then returned to its hosted autonomous state.
  const hosted = { ai_suggestion_status: 'auto_applied', ai_suggestion: { proposed_account: 'Other income', tax_treatment: 'ALV 25,5 %', posting_requirement: 'single_account', confidence: 'high' }, account_name: 'Other income', category: 'Other income', tax_treatment: 'ALV 25,5 %' };
  await pool.query("update transactions set coding_state='applied',payload=$1 where id='posted-refund'", [{ ...hosted, reviewed_by: 'fixture-member' }]);
  await postLedgerTransactionInDb({ firmId, clientId, transactionId: 'posted-refund', dryRun: false, skipSnapshot: true });
  await pool.query("update transactions set payload=payload-'reviewed_by' where id='posted-refund'");
  assert.ok((await lines('posted-refund')).some(([account]) => account === 'Other income'), 'fixture reproduces the pre-guard journal');
  await pool.query("update reconciliation_matches set status='auto_matched' where id='match-posted'");
  await recoverChangedCodingEvidenceInDb({ firmId });
  const requirement = (await pool.query("select payload->'coding_correction_required' r from transactions where id='posted-refund'")).rows[0].r;
  assert.equal(requirement?.status, 'pending');
  assert.equal(requirement.reason, 'posted_allocation_account_conflict');
  assert.equal(requirement.authority_basis, 'autonomous_posting_source_account_class_conflict');
  assert.deepEqual(requirement.allocation_account_conflicts.map(line => [line.account, line.account_class]), [['Other income', 'revenue']]);
});
