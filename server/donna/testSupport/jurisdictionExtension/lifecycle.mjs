import { deriveRequiredRolesForClient } from '../../canonicalRoleResolutionDb.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, updateClientProfileInDb,
  getClientAccountOptionsFromDb, suggestTransactionCodingInDb, updateTransactionReviewItemInDb,
  ensureTransactionReviewItemInDb, postLedgerTransactionInDb, getOwnerInvoiceSellerContextInDb,
  upsertLedgerAccountForJournal, resolveClientFiscalYearTx, getClientEntityAxisFromDb } from '../../firmDb.js';
import { __test__extractDocument } from '../../inngest/parseDocument.js';
import { upsertParsedTransactionsInDb } from '../../parseDocumentsDb.js';
import { getExtractionContextInDb } from '../../extractionContextDb.js';
import { resolveCountryCapability } from '../../countryCapabilities.js';
import { resolveCodingPolicy, codingPolicyReceipt } from '../../codingPolicy.js';
import { resolvePostingPolicy, executePostingPolicyOperation } from '../../postingPolicy.js';
import { settleCommittedConvergenceMarks } from '../../reconcileConvergenceState.js';
import { setFixtureGeneration } from './implementations.mjs';

const firmId = 'extension-firm'; const clientId = 'extension-client'; const actorId = 'fixture-owner';

test('seventh-country composition, policy upgrade/rollback and replay preserve current and historical authority', async (t) => {
  const name = `donna_jn_extension_${Date.now().toString(36)}_${process.pid}`;
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect(); await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const closed = [];
  pool.on('connect', (connection) => closed.push(new Promise((resolve) => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'offline-extension-fixture';
  t.after(async () => {
    setFixtureGeneration(1); __resetFirmDbPoolForTests();
    if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    await pool.end(); await Promise.all(closed);
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query(`create schema storage;
    create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects (id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
  const migrations = new URL('../../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter((file) => file.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  }
  await pool.query("insert into firms (id,name,slug) values ($1,'Extension fixture','extension-fixture')", [firmId]);
  await pool.query(`insert into clients (id,firm_id,company_name,jurisdiction,profile)
    values ($1,$2,'Synthetic seventh-country company','NZ','{"jurisdiction":"nz","accounting_system":"none","accountingCurrency":"NZD"}')`, [clientId, firmId]);
  await updateClientProfileInDb({ firmId, clientId, actorId,
    profilePatch: { fixture_registration: { identifier: '  FIXTURE-ONLY  ' } } });
  const stored = (await pool.query('select * from clients where id=$1', [clientId])).rows[0];
  assert.equal(await getClientEntityAxisFromDb({ firmId, clientId }), 'fixture-entity');
  assert.deepEqual(await resolveClientFiscalYearTx({ client: pool, firmId, clientId, date: '2026-09-05' }),
    { label: 'fixture-2026', starts_on: '2026-02-01', ends_on: '2027-01-31' });
  assert.equal(deriveRequiredRolesForClient({ jurisdiction: 'nz', profile: stored.profile, onDate: '2026-09-05' }).evidence.fixture_registration, true);

  assert.deepEqual(stored.profile.fixture_registration, { identifier: 'FIXTURE-ONLY' });
  const extraction = await getExtractionContextInDb({ firmId, clientId });
  assert.equal(extraction.jurisdiction, 'nz'); assert.equal(extraction.ledger_currency, 'NZD');
  const seller = await getOwnerInvoiceSellerContextInDb({ firmId, clientId, onDate: '2026-09-05' });
  assert.equal(seller.seller.taxRegistrationId, 'FIXTURE-ONLY');
  assert.equal(seller.pack, null, 'tax registration does not invent an outbound implementation');
  assert.equal(resolveCountryCapability({ jurisdiction: 'nz', operation: 'outbound' }), null);
  assert.equal(resolveCountryCapability({ jurisdiction: 'nz', operation: 'coding' }).jurisdiction, 'nz');
  assert.throws(() => executePostingPolicyOperation(resolvePostingPolicy({ jurisdiction: 'nz' }), 'supplierBillTaxPosting', {}),
    { code: 'posting_operation_unsupported' });
  assert.throws(() => executePostingPolicyOperation(resolvePostingPolicy({ jurisdiction: 'nz' }), 'sourceTaxPosting', {}),
    { code: 'posting_operation_unsupported' });
  const menu = await getClientAccountOptionsFromDb({ firmId, clientId });
  assert.ok(menu.includes('Fixture operations')); assert.ok(menu.includes('Fixture suspense')); assert.ok(!menu.includes('CPF payable'));

  for (const account of [
    { code: '1000', name: 'Fixture bank', type: 'bank', normal_balance: 'debit' },
    { code: '6100', name: 'Fixture operations', type: 'expense', normal_balance: 'debit' },
    { code: '6200', name: 'Fixture corrected cost', type: 'expense', normal_balance: 'debit' }
  ]) await upsertLedgerAccountForJournal({ client: pool, firmId, clientId, account, currency: 'NZD' });
  const documentId = 'extension-statement';
  await pool.query(`insert into documents (id,firm_id,client_id,filename,document_type)
    values ($1,$2,$3,'statement_SGD.csv','bank_statement')`, [documentId, firmId, clientId]);
  const extracted = await __test__extractDocument({
    document: { id: documentId, client_id: clientId, filename: 'statement_SGD.csv', document_type: 'bank_statement', payload: { mime_type: 'text/csv' } },
    bytes: Buffer.from('Date,Description,Debit,Credit,Balance,Currency\n05/09/2026,Recorded fixture expense,40,,60,NZD'),
    clientIdentity: extraction, ledgerCurrency: extraction.ledger_currency
  });
  assert.equal(extracted.kind, 'completed');
  assert.equal(extracted.transactions.length, 1);
  assert.equal(extracted.summary.currency_resolution.currency, 'NZD');
  assert.deepEqual(extracted.summary.currency_resolution.filename_candidates, ['SGD']);
  const replayIntake = () => upsertParsedTransactionsInDb({ firmId, clientId, documentId, transactions: extracted.transactions });
  assert.deepEqual(await replayIntake(), { written: 1, skipped: 0 });
  // The fixture owns parsing directly; persist its actual successful read
  // before testing a writer that correctly refuses still-pending sources.
  await pool.query("update documents set parse_status='completed', parse_summary=$2::jsonb where id=$1",
    [documentId,JSON.stringify(extracted.summary)]);
  const idFor = (id) => id === 'posted' ? extracted.transactions[0].id : id;
  for (const id of ['rollback', 'correction']) {
    await pool.query(`insert into transactions (id,firm_id,client_id,transaction_date,description,money_out,currency,status,coding_state,payload)
      values ($1,$2,$3,'2026-09-05','Recorded fixture expense',40,'NZD','needs_review','proposed','{"currency":"NZD"}')`, [id, firmId, clientId]);
  }
  for (const id of ['posted', 'rollback', 'correction']) {
    await ensureTransactionReviewItemInDb({ firmId, clientId, transactionId: idFor(id), reason: 'extension_fixture', actorId });
  }
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(endpoint, 'https://api.openai.com/v1/responses');
    const body = JSON.parse(init.body); const input = JSON.parse(body.input);
    calls.push(body);
    assert.ok(JSON.stringify(body).includes('Fixture operations'));
    assert.ok(!JSON.stringify(body).includes('CPF payable'));
    const output = { transaction_id: input.transaction.id, proposed_account: 'Fixture operations', contact: 'Fixture supplier',
      tax_treatment: 'Fixture no tax', support_note: 'Recorded fixture evidence.', ask_client_question: '',
      evidence_required: false, remember_candidate: false, merchant_pattern: '', missing_account_name: '',
      missing_account_type: '', missing_account_reason: '', auto_explain_limit: 0, confidence: 'high',
      materiality: 'normal', reasoning: 'Synthetic fixture expense.', warnings: [], alternatives: [] };
    return { ok: true, json: async () => ({ id: `fixture-response-${calls.length}`, output_text: JSON.stringify(output) }) };
  });
  const read = async (id) => (await pool.query('select * from transactions where id=$1', [idFor(id)])).rows[0];
  const reviewId = async (id) => (await pool.query("select id from transaction_review_queue where item_id=$1 and item_type='transaction'", [idFor(id)])).rows[0].id;
  const apply = async (id, patch = {}) => updateTransactionReviewItemInDb({ firmId, reviewItemId: await reviewId(id), actorId,
    patch: { status: 'resolved', review_state: 'accepted', ...patch }, returnSnapshot: false, distillFactsFn: async () => [] });
  const post = (id) => postLedgerTransactionInDb({ firmId, clientId, transactionId: idFor(id), actorId, dryRun: false, skipSnapshot: true });
  for (const id of ['posted', 'rollback', 'correction']) {
    await suggestTransactionCodingInDb({ firmId, transactionId: idFor(id) });
    assert.equal((await read(id)).payload.ai_suggestion.coding_policy.policyId, 'nz_extension_fixture');
  }
  assert.equal(calls.length, 3);
  const originalJudgment = structuredClone((await read('correction')).payload.ai_suggestion);
  await apply('posted'); await post('posted');
  const settle = await pool.connect();
  try { await settleCommittedConvergenceMarks(settle); } finally { settle.release(); }
  const postedBefore = await read('posted');
  const journalSnapshot = async () => ({
    journals: (await pool.query('select * from ledger_journals order by id')).rows,
    lines: (await pool.query('select * from ledger_lines order by id')).rows
  });
  const originalJournal = await journalSnapshot();
  assert.equal(originalJournal.journals.length, 1);
  assert.equal(originalJournal.journals[0].payload.posting_policy.coding_policy.policyVersion, 1);

  setFixtureGeneration(2);
  await assert.rejects(apply('rollback'), { code: 'jurisdiction_context_conflict' });
  await assert.rejects(post('rollback'), { code: 'jurisdiction_context_conflict' });
  assert.deepEqual(await read('posted'), postedBefore);
  assert.deepEqual(await journalSnapshot(), originalJournal);
  assert.equal(calls.length, 3, 'upgrade/refusal never replays provider work implicitly');

  await apply('correction', { proposed_account: 'Fixture corrected cost', account_name: 'Fixture corrected cost',
    account_code: '6200', tax_treatment: 'Fixture no tax', reviewer_note: 'Owner corrected the recorded purpose.' });
  const corrected = await read('correction');
  assert.deepEqual(corrected.payload.ai_suggestion, originalJudgment);
  assert.equal(corrected.payload.accepted_coding_policy.policyVersion, 2);
  await post('correction');

  setFixtureGeneration(null);
  assert.equal((await getExtractionContextInDb({ firmId, clientId })).jurisdiction, 'nz', 'intake context remains available without coding policy');
  await assert.rejects(post('rollback'), { code: 'coding_policy_unavailable' });
  setFixtureGeneration(1);
  await apply('rollback'); await post('rollback');
  const allJournals = await journalSnapshot();
  assert.equal(allJournals.journals.length, 3);
  const correctedJournal = allJournals.journals.find((journal) => journal.source_id === 'correction');
  assert.ok(allJournals.lines.some((line) => line.journal_id === correctedJournal.id && line.account_code === '6200' && Number(line.debit) === 40));
  // A rollback may change current policy availability; historical receipts retain
  // their original version, including the accepted correction written under v2.
  assert.equal(correctedJournal.payload.posting_policy.coding_policy.policyVersion, 2);
  assert.deepEqual((await read('correction')).payload.ai_suggestion, originalJudgment);
  assert.deepEqual(await read('posted'), postedBefore);
  for (const id of ['posted', 'rollback', 'correction']) {
    await assert.rejects(post(id));
  }
  assert.deepEqual(await replayIntake(), { written: 0, skipped: 1 });
  assert.deepEqual(await read('posted'), postedBefore, 'repeated evidence cannot rewrite posted accounting');
  assert.deepEqual(await journalSnapshot(), allJournals, 'repeat delivery cannot duplicate or rewrite any posted journal');
  const v1 = codingPolicyReceipt(resolveCodingPolicy({ jurisdiction: 'nz', businessDate: '2026-09-05', accountingSystem: 'none' }));
  assert.equal(v1.policyVersion, 1);
});
