// Real PG (Finland, synthetic data): a filed ALV return protects the figures it
// read. Filing does not lock the close period, so without a guard a bank line,
// a bill or an invoice that arrives late for the filed month posts into it and
// the filed return's basis changes with nobody having decided it.
//
// Every journal passes one of two row writers (db/ledger.js
// __writeLedgerJournalRows, insertLedgerCorrectionJournal), and each asks the
// one rule #81's adjustment writer asks (taxRegistrationPeriodState and
// correctionReturnMovement): a journal whose lines change what a filed return
// reads is refused with LEDGER_JOURNAL_DATE_IN_FILED_RETURN, before anything
// of it is written. For each writer that can reach it:
// - a journal the return reads, dated inside the filed period: refused with the
//   named code and the amounts by key, nothing written, and the caller records
//   it as a refusal it already knows (the bank line's row receipt and
//   convergence reason, the outbound invoice's skip reason);
// - a journal the return does not read, dated inside the filed period: posts;
// - the same journal dated in an open period: posts;
// - with the period also locked: the lock refuses first, under its own code.
// A fresh computation of the filed period's return reads what it read when it
// was filed. A UK book (no filed-return record) is unchanged.
//   DONNA_PG_TEST_URL=... node --test server/donna/ledgerJournalFiledReturnPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import {
  postSupplierBillJournalWithClient, postSalesInvoiceJournalWithClient, postCreditNoteJournalWithClient,
  postDocumentSettlementJournalWithClient, postOpeningBalanceJournalWithClient, postOutboundArJournalWithClient,
  __reverseOutboundArJournalWithClient, postLedgerAdjustmentInDb, upsertLedgerAccountForJournal
} from './db/ledger.js';
import { writeValidatedJournalWithinTransaction } from './ledgerPostingGateway.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { sweepLedgerAutoPost } from './ledgerAutoPost.js';
import { getFinlandAlvReturnFromDb } from './finland/statutoryDb.js';
import { postIssuanceArLeg } from './outbound/issuance.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const skip = !pgUrl && 'DONNA_PG_TEST_URL required';
const firmId = 'journal-filed-return-proof';
const MEMBER_ID = 'member';
const CODE = 'LEDGER_JOURNAL_DATE_IN_FILED_RETURN';
const GROSS = 125.5;
const REGISTERED = { status: 'registered', registered_from: '2025-01-01' };
const NOT_REGISTERED = { status: 'not_registered' };
const VERDICT = { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' };
// The filed return: March 2026. April is open.
const FILED = { id: 'alv-2026-03', period: '2026-03', starts: '2026-03-01', ends: '2026-03-31' };
const IN_FILED = '2026-03-20';
const OPEN = '2026-04-20';

async function harness(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_jn_filed_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 6 }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: firmId, OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-no-network',
    RECONCILIATION_MATCHER_LLM_MODEL: '', UNIFIED_EXTRACTOR_MODEL: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  // The only outbound call: the coder that codes the fixture bank lines (it
  // follows its input: no VAT on a date the record says not registered).
  globalThis.fetch = async (endpoint, init) => {
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      const told = row.tax_registration?.status === 'not_registered' && row.tax_registration.treatments;
      return { transaction_id: row.id, ...VERDICT, tax_treatment: told ? told.purchase : VERDICT.tax_treatment,
        confidence: 'high', evidence_required: false, auto_explain_limit: 5000, reasoning: 'The settled source supports the account and the treatment.',
        posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  };
  t.after(async () => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic filed-return firm',$1)", [firmId]);
  await pool.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
    values($1,$2,'user-member','member@auth.invalid','Synthetic Member','admin','active','owner')`, [MEMBER_ID, firmId]);
  return pool;
}

const FI_FLAGS = ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST',
  'FINLAND_ALV_RETURN', 'FINLAND_EINVOICE_RECEIVE', 'FINLAND_INVOICING', 'OUTBOUND_INVOICING', 'FINLAND_TILIKAUSI', 'FINLAND_OPENING_BALANCES'];
const flag = (pool, clientId, key, stage = 'auto') => pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,set_by_actor_type,set_by_actor_id,reason) values($1,$2,$3,$4,$5,'manual','firm_member',$6,'Synthetic proof') on conflict do nothing",
  [`${clientId}-${key}`, firmId, clientId, key, stage, MEMBER_ID]);
const seedFi = async (pool, clientId, registration = REGISTERED) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,incorporation_date,profile) values($1,$2,'Synthetic Myöhässä Oy','FI','fi-oy','2020-01-01',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'accrual', alv_registration: registration }]);
  for (const key of FI_FLAGS) await flag(pool, clientId, key);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
};
const fileReturn = (pool, clientId) => pool.query(`insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status,filed_at,filed_by)
  values($1,$2,$3,$4,'month',$5,$6,'filed',now(),$7)`, [`${clientId}-${FILED.id}`, firmId, clientId, FILED.period, FILED.starts, FILED.ends, MEMBER_ID]);
const lockPeriod = (pool, clientId) => pool.query("insert into close_periods(id,firm_id,client_id,period_start,period_end,status,locked_at) values($1,$2,$3,$4,$5,'locked',now())",
  [`${clientId}-lock-03`, firmId, clientId, FILED.starts, FILED.ends]);
// What a fresh computation of a period's return reads from the ledger: its
// boxes and its control cross-check (the review's blockers are read apart).
const returnRead = async (clientId, period) => {
  const read = await getFinlandAlvReturnFromDb({ firmId, clientId, period });
  return { boxes: read.alvReturn.boxes, control: read.review.controlCheck };
};
const reviewOf = async (clientId, period) => (await getFinlandAlvReturnFromDb({ firmId, clientId, period })).review;
const journals = async (pool, clientId) => (await pool.query(`select source_type, source_id, journal_date::text as journal_date, status,
    (select coalesce(jsonb_agg(jsonb_build_object('code', l.account_code, 'tax_type', l.tax_type, 'debit', l.debit::float8, 'credit', l.credit::float8) order by l.line_no), '[]'::jsonb)
       from ledger_lines l where l.journal_id = j.id) as lines
  from ledger_journals j where client_id = $1 order by journal_date, source_type, source_id`, [clientId])).rows;
// Everything a write could leave behind: journals, lines, accounts, vouchers.
const effects = async (pool, clientId) => (await pool.query(`select
    (select count(*)::int from ledger_journals where client_id = $1) as journals,
    (select count(*)::int from ledger_lines where client_id = $1) as lines,
    (select count(*)::int from ledger_accounts where client_id = $1) as accounts,
    (select count(*)::int from audit_events where client_id = $1 and action in ('ledger.journal_posted', 'ledger.adjustment_posted')) as posted_audits`, [clientId])).rows[0];
const inTx = async (pool, fn) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
};
const refusedWith = (journalDate, extra = {}) => (error) => {
  assert.equal(error.code, CODE, error.message);
  assert.equal(error.statusCode, 409);
  assert.equal(error.details.journal_date, journalDate);
  assert.equal(error.details.filed_return_period, FILED.period);
  assert.ok(error.details.filed_return_id.endsWith(FILED.id));
  assert.ok(error.details.tax_moved.length, 'the amounts by key are named');
  for (const [key, value] of Object.entries(extra)) assert.deepEqual(error.details[key], value, key);
  assert.match(error.message, /filed VAT return 2026-03, and this journal changes what that return reads/);
  return true;
};

const bankLine = async (pool, clientId, id, date) => {
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,'Synthetic office supplies',0,$5,'EUR','needs_review','{}')",
    [id, firmId, clientId, date, GROSS]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic receipt.pdf','receipt','completed',$4,25.5,'EUR',$5,'{}')",
    [`doc-${id}`, firmId, clientId, GROSS, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')",
    [`match-${id}`, firmId, clientId, id, `doc-${id}`, GROSS]);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  // Donna's own automatic path: the coding auto-post accepts and posts.
  await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } } });
  return (await pool.query('select coding_state, convergence_state, convergence_reason, payload from transactions where id = $1', [id])).rows[0];
};

test('real PG (FI): a late bank line with a deductible purchase, dated inside the filed return, is refused on Donna\'s automatic path; the row says why and the sweep does not loop', { skip }, async t => {
  const pool = await harness(t);
  const clientId = 'fi-bank';
  await seedFi(pool, clientId);
  await fileReturn(pool, clientId);
  const filedRead = await returnRead(clientId, FILED.period);
  const before = await effects(pool, clientId);

  const late = await bankLine(pool, clientId, 'late-purchase', IN_FILED);
  assert.equal(late.payload.ledger_journal_id, undefined, 'no journal');
  assert.equal(late.payload.ledger_post_refusal.code, CODE);
  // The coding batch posts inline and records its refusal (db/coding.js,
  // recordRefusalViaDb) over the writer's own row receipt; either way the
  // row names the code.
  assert.deepEqual(late.payload.ledger_post_refusal.details.tax_moved, [
    { key: 'control_leg:alv_input_deductible', currency: 'EUR', amount: 25.5 },
    { key: 'tax_code:ALV_25_5_INPUT', currency: 'EUR', amount: 100 }]);
  assert.equal(late.payload.ledger_post_refusal.details.source_type, 'transaction');
  assert.equal(late.coding_state, 'applied', 'the coding stays; only the post is refused');
  assert.equal(late.convergence_state, 'hanging');
  assert.equal(late.convergence_reason, `ledger_post_refused:${CODE}`);
  assert.deepEqual(await effects(pool, clientId), before, 'nothing of the journal was written');
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead, 'the filed period reads what it read when filed');

  // Recorded once (the inline post's receipt); the posting sweep is damped by
  // it and does not retry the line every tick.
  await sweepLedgerAutoPost({ firmId, clientId, configSnapshot: { LEDGER_AUTO_POST: { stage: 'auto' } }, env: {} });
  await sweepLedgerAutoPost({ firmId, clientId, configSnapshot: { LEDGER_AUTO_POST: { stage: 'auto' } }, env: {} });
  const sweepRefusals = (await pool.query("select metadata from audit_events where client_id = $1 and action = 'ledger.auto_post_refused' and resource_id = 'late-purchase'", [clientId])).rows;
  assert.equal(sweepRefusals.length, 1, 'refused once, then damped');
  assert.ok(['ledger_auto_post_sweep', 'coding_batch_inline_post'].includes(sweepRefusals[0].metadata.source));
  assert.equal(sweepRefusals[0].metadata.code, CODE);
  assert.deepEqual(await effects(pool, clientId), before);

  // The same purchase dated in the open month posts, with its input ALV.
  const open = await bankLine(pool, clientId, 'open-purchase', OPEN);
  assert.ok(open.payload.ledger_journal_id, JSON.stringify(open.payload.ledger_post_refusal || null));
  assert.equal(open.payload.ledger_post_refusal, undefined);
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);
});

test('real PG (FI): a bank line the filed return does not read posts into it; with the period locked, the lock refuses first', { skip }, async t => {
  const pool = await harness(t);
  // Not in the VAT register: the purchase posts gross with no input ALV, which
  // the ALV return does not read.
  const clientId = 'fi-bank-unread';
  await seedFi(pool, clientId, NOT_REGISTERED);
  await fileReturn(pool, clientId);
  const filedRead = await returnRead(clientId, FILED.period);
  const unread = await bankLine(pool, clientId, 'unread-purchase', IN_FILED);
  assert.ok(unread.payload.ledger_journal_id, JSON.stringify(unread.payload.ledger_post_refusal || null));
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  const lockedClient = 'fi-bank-locked';
  await seedFi(pool, lockedClient);
  await fileReturn(pool, lockedClient);
  await lockPeriod(pool, lockedClient);
  const locked = await bankLine(pool, lockedClient, 'locked-purchase', IN_FILED);
  assert.equal(locked.payload.ledger_journal_id, undefined);
  // The lock's refusal reaches the posting sweep under its own code.
  await sweepLedgerAutoPost({ firmId, clientId: lockedClient, configSnapshot: { LEDGER_AUTO_POST: { stage: 'auto' } }, env: {} });
  const refusal = (await pool.query("select metadata from audit_events where client_id = $1 and action = 'ledger.auto_post_refused'", [lockedClient])).rows;
  assert.equal(refusal.length, 1);
  assert.equal(refusal[0].metadata.code, 'LEDGER_LOCKED_PERIOD_IMMUTABLE');
});

const supplierBill = async (pool, clientId, id, date) => {
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,vendor_name,total_amount,tax_amount,currency,document_date,reference_number,payload)
    values($1,$2,$3,'Synthetic bill.xml','supplier_bill','completed','Synthetic Toimittaja Oy',125.5,25.5,'EUR',$4,'RF18539007547034','{}')`, [id, firmId, clientId, date]);
  return id;
};
const billCoding = (taxTreatment) => ({ proposed_account: 'Ulkopuoliset palvelut', account_code: '4400', account_type: 'expense',
  confidence: 'high', model: 'synthetic-coder', tax_treatment: taxTreatment });
const postBill = (pool, clientId, documentId, taxTreatment = 'ALV 25,5 %') => inTx(pool, client => postSupplierBillJournalWithClient({ client, firmId, clientId, documentId,
  coding: billCoding(taxTreatment), authorityBasis: { source: 'synthetic_proof' }, model: 'synthetic-coder', actorId: 'system' }));
// A sale: whatever its ALV, its revenue line is read by the Finnish return
// (a coded base, or the uncoded-revenue blocker), so no sales invoice can be
// one the return does not read.
const salesInvoice = (number, date) => ({ invoiceNumber: number, date, currency: 'EUR', subtotal: 100, alvTotal: 0, total: 100,
  buyer: { name: 'Synthetic Asiakas Oy' } });
const postInvoice = (pool, clientId, invoice) => inTx(pool, client => postSalesInvoiceJournalWithClient({ client, firmId, clientId, invoice,
  authorityBasis: { source: 'synthetic_proof' }, model: null, actorId: 'owner' }));

test('real PG (FI): a supplier bill and a sales invoice dated inside the filed return are refused and leave nothing; open-dated they post; locked, the lock refuses first', { skip }, async t => {
  const pool = await harness(t);
  const clientId = 'fi-documents';
  await seedFi(pool, clientId);
  await fileReturn(pool, clientId);
  const filedRead = await returnRead(clientId, FILED.period);
  const before = await effects(pool, clientId);

  // A supplier bill with deductible input ALV, dated in the filed month.
  await supplierBill(pool, clientId, 'bill-late', IN_FILED);
  await assert.rejects(postBill(pool, clientId, 'bill-late'), refusedWith(IN_FILED, { source_type: 'supplier_bill', source_id: 'bill-late' }));
  // A sales invoice with output ALV, dated in the filed month.
  await assert.rejects(postInvoice(pool, clientId, salesInvoice('2026031', IN_FILED)), refusedWith(IN_FILED));
  assert.deepEqual(await effects(pool, clientId), before, 'nothing of either journal was written');
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);
  // The refused bill is not lost: the filed period's return review names it
  // as a purchase document the ledger does not recognise (FI-09).
  const review = await reviewOf(clientId, FILED.period);
  assert.ok(review.blockers.includes('unrecognized_purchase_documents'), JSON.stringify(review.blockers));
  assert.ok(review.unrecognizedPurchases.items.some(item => (item.document_id || item.id) === 'bill-late'), JSON.stringify(review.unrecognizedPurchases.items));

  // A bill the return does not read (no deduction right: the gross stays on
  // the expense with a code the return does not report) posts into the month.
  await supplierBill(pool, clientId, 'bill-unread', IN_FILED);
  const unread = await postBill(pool, clientId, 'bill-unread', 'Vähennyskelvoton ALV (osto)');
  assert.ok(unread.journal_id);
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  // The same documents dated in the open month post.
  await supplierBill(pool, clientId, 'bill-open', OPEN);
  assert.ok((await postBill(pool, clientId, 'bill-open')).journal_id);
  assert.ok((await postInvoice(pool, clientId, salesInvoice('2026041', OPEN))).journal_id);
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  // Locked as well as filed: the lock refuses first, under its own code.
  await lockPeriod(pool, clientId);
  await supplierBill(pool, clientId, 'bill-locked', IN_FILED);
  await assert.rejects(postBill(pool, clientId, 'bill-locked'), { code: 'LEDGER_LOCKED_PERIOD_IMMUTABLE' });
  await assert.rejects(postInvoice(pool, clientId, salesInvoice('2026032', IN_FILED)), { code: 'LEDGER_LOCKED_PERIOD_IMMUTABLE' });
});

const creditNote = (number, date) => ({ invoiceNumber: number, creditsInvoiceNumber: '2026041', kind: 'credit_note', date, currency: 'EUR',
  subtotal: 40, alvTotal: 0, total: 40, buyer: { name: 'Synthetic Asiakas Oy' } });
const postCredit = (pool, clientId, note) => inTx(pool, client => postCreditNoteJournalWithClient({ client, firmId, clientId, creditNote: note,
  authorityBasis: { source: 'synthetic_proof' }, actorId: 'owner' }));
const settlementDocument = async (pool, clientId, id, date) => {
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,vendor_name,total_amount,tax_amount,currency,document_date,payload)
    values($1,$2,$3,'Synthetic card receipt.pdf','receipt','completed','Synthetic Kauppa Oy',125.5,25.5,'EUR',$4,$5)`,
  [id, firmId, clientId, date, { no_line_disposition: { settlement_channel: 'personal_card', funding_source: 'owner' } }]);
  return { id, currency: 'EUR', total_amount: 125.5, tax_amount: 25.5, document_date: date };
};
const postSettlement = (pool, clientId, document, taxTreatment) => inTx(pool, client => postDocumentSettlementJournalWithClient({ client, firmId, clientId, document,
  expenseAccount: { code: '4400', name: 'Ulkopuoliset palvelut', type: 'expense', proposed_account: 'Ulkopuoliset palvelut', account_code: '4400', tax_treatment: taxTreatment },
  settlement: { settlement_channel: 'personal_card', verdict_source: 'owner_reply' }, authorityBasis: 'owner_reply', actorId: 'owner' }));
const outboundInvoice = (number, date) => ({ invoiceNumber: number, date, currency: 'EUR', subtotal: 100, taxTotal: 0, total: 100,
  buyer: { name: 'Synthetic Asiakas Oy' }, referenceNumber: null });
// The outbound writer resolves its two accounts by canonical role: the
// receivable and the revenue account the other writers mint by code.
const arChart = async (pool, clientId) => {
  for (const [code, name, type, role] of [['1700', 'Myyntisaamiset', 'asset', 'asset.accounts_receivable'], ['3000', 'Myynti', 'revenue', 'revenue.operating']]) {
    await upsertLedgerAccountForJournal({ client: pool, firmId, clientId, account: { code, name, type }, currency: 'EUR' });
    await pool.query("update ledger_accounts set status = 'archived' where client_id = $1 and canonical_role = $2 and code is distinct from $3", [clientId, role, code]);
    await pool.query("update ledger_accounts set canonical_role = $2, status = 'active' where client_id = $1 and code = $3", [clientId, role, code]);
  }
};
const postAr = (pool, clientId, invoice) => inTx(pool, client => postOutboundArJournalWithClient({ client, firmId, clientId, invoice,
  authorityBasis: { source: 'synthetic_proof' }, actorId: 'outbound_executor' }));
const gatewayJournal = (sourceId, date, { inputAlv = true } = {}) => ({
  source_type: 'synthetic_gateway', source_id: sourceId, journal_date: date, currency: 'EUR', memo: 'Synthetic gateway journal', amount: 125.5,
  accounts: [], lines: inputAlv ? [
    { account: { code: '4400', name: 'Ulkopuoliset palvelut', type: 'expense', tax_type: 'ALV_25_5_INPUT' }, direction: 'debit', debit: 100, credit: 0, amount: 100, currency: 'EUR' },
    { account: { code: '2940', name: 'Vähennettävä arvonlisävero', type: 'asset', role: 'alv_input_deductible' }, direction: 'debit', debit: 25.5, credit: 0, amount: 25.5, currency: 'EUR' },
    { account: { code: '2870', name: 'Ostovelat', type: 'liability' }, direction: 'credit', debit: 0, credit: 125.5, amount: 125.5, currency: 'EUR' }
  ] : [
    { account: { code: '6800', name: 'Poistot', type: 'expense' }, direction: 'debit', debit: 125.5, credit: 0, amount: 125.5, currency: 'EUR' },
    { account: { code: '1150', name: 'Koneet ja kalusto', type: 'asset' }, direction: 'credit', debit: 0, credit: 125.5, amount: 125.5, currency: 'EUR' }
  ] });
const viaGateway = (pool, clientId, journal) => inTx(pool, tx => writeValidatedJournalWithinTransaction(tx, journal, { firmId, clientId, actorId: 'system' }));

test('real PG (FI): credit note, document settlement, outbound AR and its reversal, and the posting gateway refuse a journal the filed return reads, and post one it does not or one dated in an open month', { skip }, async t => {
  const pool = await harness(t);
  const clientId = 'fi-writers';
  await seedFi(pool, clientId);
  await arChart(pool, clientId);
  await fileReturn(pool, clientId);
  const filedRead = await returnRead(clientId, FILED.period);
  const before = await effects(pool, clientId);

  await assert.rejects(postCredit(pool, clientId, creditNote('2026033', IN_FILED)), refusedWith(IN_FILED));
  const lateReceipt = await settlementDocument(pool, clientId, 'settle-late', IN_FILED);
  await assert.rejects(postSettlement(pool, clientId, lateReceipt, 'ALV 25,5 %'), refusedWith(IN_FILED, { source_type: 'document_settlement' }));
  await assert.rejects(postAr(pool, clientId, outboundInvoice('AR-0320', IN_FILED)), refusedWith(IN_FILED));
  await assert.rejects(viaGateway(pool, clientId, gatewayJournal('gw-late', IN_FILED)), refusedWith(IN_FILED, { source_type: 'synthetic_gateway', source_id: 'gw-late' }));
  assert.deepEqual(await effects(pool, clientId), before, 'nothing of any journal was written');
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  // Journals the return does not read post into the filed month.
  const unreadReceipt = await settlementDocument(pool, clientId, 'settle-unread', IN_FILED);
  assert.ok((await postSettlement(pool, clientId, unreadReceipt, 'Vähennyskelvoton ALV (osto)')).journal_id);
  assert.ok((await viaGateway(pool, clientId, gatewayJournal('gw-depreciation', IN_FILED, { inputAlv: false }))).ledger_journal_id);
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  // The same journals dated in the open month post.
  assert.ok((await postCredit(pool, clientId, creditNote('2026043', OPEN))).journal_id);
  assert.ok((await postSettlement(pool, clientId, await settlementDocument(pool, clientId, 'settle-open', OPEN), 'ALV 25,5 %')).journal_id);
  const ar = await postAr(pool, clientId, outboundInvoice('AR-0420', OPEN));
  assert.ok(ar.journal_id);
  assert.ok((await viaGateway(pool, clientId, gatewayJournal('gw-open', OPEN))).ledger_journal_id);

  // A re-post through the gateway that moves an open-month journal into the
  // filed month is refused; nothing of the re-post is written.
  const moved = await effects(pool, clientId);
  await assert.rejects(viaGateway(pool, clientId, gatewayJournal('gw-open', IN_FILED)), refusedWith(IN_FILED, { prior_journal_date: OPEN }));
  assert.deepEqual(await effects(pool, clientId), moved);
  assert.equal((await pool.query("select journal_date::text as d from ledger_journals where client_id = $1 and source_id = 'gw-open'", [clientId])).rows[0].d, OPEN);

  // The outbound AR reversal (a correction journal) dated in the filed month
  // is refused; dated in the open month it posts.
  await assert.rejects(inTx(pool, client => __reverseOutboundArJournalWithClient({ client, firmId, clientId, arJournalId: ar.journal_id, journalDate: IN_FILED, actorId: 'owner' })),
    refusedWith(IN_FILED, { source_type: 'adjustment' }));
  assert.deepEqual(await effects(pool, clientId), moved);
  assert.ok((await inTx(pool, client => __reverseOutboundArJournalWithClient({ client, firmId, clientId, arJournalId: ar.journal_id, journalDate: OPEN, actorId: 'owner' }))).reversal_journal_id);
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  // The adjustment writer keeps its own code and its rule: refused once, under
  // LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN, never under the shared code; a
  // depreciation with no VAT dated into the filed month posts as before.
  const vatLines = gatewayJournal('adj', IN_FILED).lines.map(line => ({ ...line.account, account_code: line.account.code, account_name: line.account.name,
    account_type: line.account.type, debit: line.debit, credit: line.credit, currency: 'EUR' }));
  await assert.rejects(postLedgerAdjustmentInDb({ firmId, clientId, journalDate: IN_FILED, reason: 'Synthetic late purchase', lines: vatLines, actorId: MEMBER_ID }),
    { code: 'LEDGER_ADJUSTMENT_DATE_IN_FILED_RETURN' });
  const depreciation = gatewayJournal('adj', IN_FILED, { inputAlv: false }).lines.map(line => ({ account_code: line.account.code, account_name: line.account.name,
    account_type: line.account.type, debit: line.debit, credit: line.credit, currency: 'EUR' }));
  assert.ok((await postLedgerAdjustmentInDb({ firmId, clientId, journalDate: IN_FILED, reason: 'Synthetic year-end depreciation', lines: depreciation, actorId: MEMBER_ID })).ledger_adjustment);
  assert.deepEqual(await returnRead(clientId, FILED.period), filedRead);

  // Locked as well as filed: each writer's lock refuses first.
  await lockPeriod(pool, clientId);
  await assert.rejects(postCredit(pool, clientId, creditNote('2026034', IN_FILED)), { code: 'LEDGER_LOCKED_PERIOD_IMMUTABLE' });
  await assert.rejects(postSettlement(pool, clientId, await settlementDocument(pool, clientId, 'settle-locked', IN_FILED), 'ALV 25,5 %'), { code: 'LEDGER_LOCKED_PERIOD_IMMUTABLE' });
  await assert.rejects(postAr(pool, clientId, outboundInvoice('AR-0321', IN_FILED)), { code: 'LEDGER_LOCKED_PERIOD_IMMUTABLE' });
  await assert.rejects(viaGateway(pool, clientId, gatewayJournal('gw-locked', IN_FILED)), { code: 'LEDGER_ADJUSTMENT_DATE_LOCKED' });
  const ar2 = await postAr(pool, clientId, outboundInvoice('AR-0421', OPEN));
  await assert.rejects(inTx(pool, client => __reverseOutboundArJournalWithClient({ client, firmId, clientId, arJournalId: ar2.journal_id, journalDate: IN_FILED, actorId: 'owner' })),
    { code: 'LEDGER_ADJUSTMENT_DATE_LOCKED' });
  await assert.rejects(postLedgerAdjustmentInDb({ firmId, clientId, journalDate: IN_FILED, reason: 'Synthetic late purchase', lines: vatLines, actorId: MEMBER_ID }),
    { code: 'LEDGER_ADJUSTMENT_DATE_LOCKED' });
});

test('real PG (FI): the outbound issuance leg records the refusal as a named skip; an opening balance the January return reads is refused, also on a re-post', { skip }, async t => {
  const pool = await harness(t);
  const clientId = 'fi-outbound-opening';
  await seedFi(pool, clientId);
  await arChart(pool, clientId);
  await fileReturn(pool, clientId);
  // The issuance executor's AR leg (outbound/issuance.js): the invoice is
  // sent, its AR journal is not posted, and the skip names the reason.
  const leg = await inTx(pool, client => postIssuanceArLeg(client, { firmId, clientId, authority: 'synthetic_proof', approvedBy: MEMBER_ID,
    action: { id: 'action-0322', action_type: 'issue_invoice', approved_by_actor_id: MEMBER_ID },
    anchorRow: { draft: { invoice: outboundInvoice('AR-0322', IN_FILED) } }, impls: { postArJournal: postOutboundArJournalWithClient } }));
  assert.deepEqual(leg, { status: 'skipped', reason: 'filed_return_period' });
  assert.equal((await pool.query("select count(*)::int as n from ledger_journals where client_id = $1 and source_id = 'AR-0322'", [clientId])).rows[0].n, 0);

  // The opening balance is dated on the tilikausi start: 2026-01-01, inside
  // a filed January return. An ALV control-account balance is read by the
  // return (its unmarked control movement); bank and equity are not.
  await pool.query(`insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status,filed_at,filed_by)
    values('alv-2026-01',$1,$2,'2026-01','month','2026-01-01','2026-01-31','filed',now(),$3)`, [firmId, clientId, MEMBER_ID]);
  // An osakeyhtiö's tilikausi is a persisted period: the calendar year 2026.
  await pool.query("insert into fiscal_years(id,firm_id,client_id,label,starts_on,ends_on,status) values($1,$2,$3,'2026','2026-01-01','2026-12-31','open')",
    [`${clientId}-fy-2026`, firmId, clientId]);
  const janRead = await returnRead(clientId, '2026-01');
  const line = (code, name, type, debit, credit) => ({ account: { code, name, type }, debit, credit });
  const withAlvLiability = [line('1910', 'Pankkitili', 'bank', 1000, 0), line('2939', 'Arvonlisäverovelka', 'liability', 0, 255), line('2000', 'Osakepääoma', 'equity', 0, 745)];
  const plain = [line('1910', 'Pankkitili', 'bank', 1000, 0), line('2000', 'Osakepääoma', 'equity', 0, 1000)];
  const opening = (openingLines) => inTx(pool, client => postOpeningBalanceJournalWithClient({ client, firmId, clientId, asOf: '2026-02-01', openingLines,
    authorityBasis: { source: 'synthetic_proof' }, actorId: MEMBER_ID }));
  const opened = (error) => {
    assert.equal(error.code, CODE, error.message);
    assert.equal(error.details.journal_date, '2026-01-01');
    assert.equal(error.details.filed_return_period, '2026-01');
    assert.deepEqual(error.details.tax_moved, [{ key: 'control_account:2939', currency: 'EUR', amount: -255 }]);
    return true;
  };
  const before = await effects(pool, clientId);
  await assert.rejects(opening(withAlvLiability), opened);
  assert.deepEqual(await effects(pool, clientId), before);
  const posted = await opening(plain);
  assert.ok(posted.journal_id || posted.ledger_journal_id, JSON.stringify(posted));
  // Re-posting the same tilikausi's opening journal with the ALV balance:
  // what it adds to the January return is what it replaces it with, refused.
  const reposted = await effects(pool, clientId);
  await assert.rejects(opening(withAlvLiability), (error) => opened(error) && error.details.prior_journal_date === '2026-01-01');
  assert.deepEqual(await effects(pool, clientId), reposted);
  // Re-posting it unchanged moves nothing and posts.
  assert.ok(await opening(plain));
  assert.deepEqual(await returnRead(clientId, '2026-01'), janRead);
});

test('real PG (UK): a book whose country keeps no filed-return record is unchanged — the guard reads nothing and a VAT journal posts on any date', { skip }, async t => {
  const pool = await harness(t);
  const clientId = 'gb-book';
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Late Ltd','GB','gb-ltd',$3)", [clientId, firmId,
    { jurisdiction: 'GB', accounting_system: 'none', accounting_basis: 'accrual', vat_registration: { status: 'registered', registered_from: '2025-01-01' } }]);
  for (const key of ['JURISDICTION_ACCOUNT_PALETTE', 'JURISDICTION_TAX_CODING']) await flag(pool, clientId, key);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  const client = await pool.connect();
  const seen = [];
  const recording = { query: (sql, params) => { seen.push(String(sql)); return client.query(sql, params); } };
  try {
    await client.query('begin');
    const post = await writeValidatedJournalWithinTransaction(recording, {
      source_type: 'synthetic_gateway', source_id: 'gb-vat', journal_date: IN_FILED, currency: 'GBP', memo: 'Synthetic UK purchase', amount: 120, accounts: [],
      lines: [
        { account: { code: '5000', name: 'Cost of sales', type: 'expense', tax_type: 'INPUT2' }, direction: 'debit', debit: 100, credit: 0, amount: 100, currency: 'GBP' },
        { account: { code: '2201', name: 'VAT input', type: 'asset', role: 'vat_input_reclaimable' }, direction: 'debit', debit: 20, credit: 0, amount: 20, currency: 'GBP' },
        { account: { code: '2100', name: 'Trade creditors', type: 'liability' }, direction: 'credit', debit: 0, credit: 120, amount: 120, currency: 'GBP' }
      ] }, { firmId, clientId, actorId: 'system' });
    await client.query('commit');
    assert.ok(post.ledger_journal_id);
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
  assert.deepEqual(seen.filter(sql => /alv_returns|select code, account_type from ledger_accounts|lj\.journal_date::text as journal_date/.test(sql)), [],
    'no filed-return reader, no line read, no prior-journal read');
});
