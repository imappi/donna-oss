// Real PG (FI and GB, synthetic data): a bank line the ledger refuses because
// the business is not recorded as VAT/ALV registered on its date does not
// rest with nobody asked. The real coder codes it, auto-post refuses it by
// name, the evidence clock re-admits it, the coder's contract
// (transactionLlm.js) turns it into the owner's registration question, in the
// owner's language, and the owner-ask writer (codingAutoPost.js) puts that
// question on the owner. Nothing posts until the record says registered.
//   DONNA_PG_TEST_URL=... node --test server/donna/vatRegistrationOwnerQuestionPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, postLedgerTransactionInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'vat-registration-question-proof';

async function freshDb(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_vat_reg_question_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const priorKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = 'fixture-only';
  t.after(async () => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey; __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic registration firm',$1)", [firmId]);
  return pool;
}

const run = async ({ t, pool, clientId, verdict, refusalCode, expectedQuestion, currency }) => {
  const id = `${clientId}-purchase`;
  const gross = currency === 'EUR' ? 125.5 : 120;
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2026-06-02','Synthetic office supplies',0,$4,$5,'needs_review','{}')", [id, firmId, clientId, gross, currency]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic receipt.pdf','receipt','completed',$4,$5,$6,'2026-06-02','{}')", [`doc-${id}`, firmId, clientId, gross, currency === 'EUR' ? 25.5 : 20, currency]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')", [`match-${id}`, firmId, clientId, id, `doc-${id}`, gross]);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    assert.equal(String(endpoint), 'https://api.openai.com/v1/responses');
    calls += 1;
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => ({ transaction_id: row.id, ...verdict, confidence: 'high', evidence_required: false, auto_explain_limit: 5000,
      reasoning: 'The settled receipt supports the account and its printed VAT.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' }));
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  const row = async () => (await pool.query('select coding_state,payload from transactions where id=$1', [id])).rows[0];
  const journals = async () => (await pool.query('select count(*)::int n from ledger_journals where source_id=$1', [id])).rows[0].n;
  const asks = async () => (await pool.query("select question,status from client_evidence_requests where transaction_id=$1 and status in ('draft','open')", [id])).rows;

  // 1. The coder codes it; auto-post refuses it by name. Nothing posts.
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal((await row()).payload.ledger_post_refusal?.code, refusalCode);
  assert.equal(await journals(), 0);
  // 2. The evidence clock owns the refusal: it re-admits the line to the coder.
  const recovered = await recoverChangedCodingEvidenceInDb({ firmId });
  assert.ok(recovered.some(item => item.transaction_id === id), `the clock re-admits ${id}: ${JSON.stringify(recovered)}`);
  // 3. The coder's contract turns it into the owner's registration question.
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const recoded = await row();
  assert.equal(calls, 2);
  assert.equal(recoded.payload.ai_suggestion?.posting_requirement, 'owner_fact');
  assert.equal(recoded.payload.ai_suggestion?.tax_unresolved_guard?.constraint, 'tax_registration_unrecorded');
  assert.equal(recoded.payload.ai_suggestion?.ask_client_question, expectedQuestion);
  assert.equal(recoded.coding_state, 'proposed');
  // 4. The owner-ask writer puts it on the owner; still nothing posts.
  const result = await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: { CODING_AUTO_POST: { stage: 'auto' } } });
  assert.equal(result.owner_asked, 1, JSON.stringify(result));
  assert.deepEqual((await asks()).map(ask => ask.question), [expectedQuestion]);
  assert.equal(await journals(), 0);
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: true }), { code: 'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED' });
  // 5. A second clock tick and coding round neither re-ask nor post.
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal((await asks()).length, 1);
  assert.equal(await journals(), 0);
};

test('real PG (GB): a line refused for VAT registration becomes the owner\'s registration question', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-unrecorded';
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Unrecorded Ltd','gb',$3)", [clientId, firmId, { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash' }]);
  for (const flag of ['JURISDICTION_TAX_CODING', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  for (const a of GB_DEFAULT_CHART) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'GBP',$8,'active')",
    [ledgerRecordId('account', firmId, clientId, a.code), firmId, clientId, a.code, a.name_en, a.account_type, a.normal_balance, a.canonical_role || null]);
  await run({ t, pool, clientId, currency: 'GBP', refusalCode: 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED',
    verdict: { proposed_account: 'Software subscriptions', tax_treatment: 'VAT 20%' },
    expectedQuestion: 'Synthetic office supplies: we have no record of whether the business is VAT-registered. Is the business registered for VAT? If so, from what date is the registration effective?' });
});

test('real PG (FI): a line refused for ALV registration becomes the owner\'s registration question, in Finnish', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-not-registered';
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Rekisteröimätön Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', alv_registration: { status: 'not_registered' } }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  await run({ t, pool, clientId, currency: 'EUR', refusalCode: 'TRANSACTION_ALV_REGISTRATION_REQUIRED',
    verdict: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' },
    expectedQuestion: 'Synthetic office supplies: tietojemme mukaan yritys ei ollut arvonlisäverorekisterissä 2026-06-02. Onko yritys merkitty arvonlisäverorekisteriin sen jälkeen? Jos on, mistä päivästä alkaen?' });
});
