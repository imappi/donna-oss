// Real PG (FI and GB, synthetic data): a bank line the ledger refuses because
// the business is not recorded as VAT/ALV registered on its date does not
// rest with nobody asked. With no record that settles the date, the real
// coder codes it, auto-post refuses it by name, the evidence clock re-admits
// it, the coder's contract (transactionLlm.js) turns it into the owner's
// registration question, in the owner's language, and the owner-ask writer
// (codingAutoPost.js) puts that question on the owner. The owner's answer is
// read by the registration lane (taxRegistrationReply.js, through the shared
// owner-reply worker and a strong reading), recorded through the one profile
// writer with its receipt, and every line the question stood for is re-run.
// One question per client however many lines were refused.
// When the record says NOT registered on a line's date (recorded so, an
// owner's "no", or a date before the registration start), nothing is asked:
// the coder is told the fact and the country's no-VAT treatment, and the line
// posts once, gross, with no VAT leg. A coder that still picks a VAT-carrying
// treatment is refused as before and re-run once with the refusal; it is
// never posted with VAT and never posted with its code dropped.
//   DONNA_PG_TEST_URL=... node --test server/donna/vatRegistrationOwnerQuestionPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, postLedgerTransactionInDb, resolveClientEvidenceRequestInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';
import { CODING_RECONSIDERATION_CONTRACT } from './codingPolicyRecovery.js';

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
  const priorAnthropic = process.env.ANTHROPIC_API_KEY; process.env.ANTHROPIC_API_KEY = 'fixture-only';
  t.after(async () => { if (priorKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = priorKey;
    if (priorAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = priorAnthropic;
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic registration firm',$1)", [firmId]);
  return pool;
}


const OWNER = 'owner@example.test';
const READER_MODEL = 'recorded-strong-owner-reader';
const AUTO = { CODING_AUTO_POST: { stage: 'auto' } };

const seedGb = async (pool, clientId, profile = {}) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Unrecorded Ltd','gb',$3)", [clientId, firmId, { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const flag of ['JURISDICTION_TAX_CODING', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  for (const a of GB_DEFAULT_CHART) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'GBP',$8,'active')",
    [ledgerRecordId('account', firmId, clientId, a.code), firmId, clientId, a.code, a.name_en, a.account_type, a.normal_balance, a.canonical_role || null]);
};
const seedFi = async (pool, clientId, profile = {}) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Rekisteröimätön Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
};
const FI = { currency: 'EUR', gross: 125.5, tax: 25.5, refusalCode: 'TRANSACTION_ALV_REGISTRATION_REQUIRED', field: 'alv_registration',
  verdict: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' }, sale: { proposed_account: 'Sales', tax_treatment: 'ALV 25,5 %' },
  withoutTax: { purchase: 'ALV_NONDEDUCTIBLE_INPUT', sale: 'ALV_OUT_OF_SCOPE' } };
const GB = { currency: 'GBP', gross: 120, tax: 20, refusalCode: 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED', field: 'vat_registration',
  verdict: { proposed_account: 'Software subscriptions', tax_treatment: 'VAT 20%' }, sale: { proposed_account: 'Sales', tax_treatment: 'VAT 20%' },
  withoutTax: { purchase: 'NONE', sale: 'NONE' } };

// The model fixtures: the coder (OpenAI responses) proposes the rated coding
// the receipt prints, unless its input says the business is not registered on
// the line's date: a coder that follows its input then picks the no-VAT
// treatment it is offered there (`reading.coder = 'follows'`, the default); a
// stubborn one keeps the printed rate (`'stubborn'`). The owner-reply reader
// (Anthropic messages) returns `reading.current()`. Every coder input row is kept.
const mockModels = (t, reading) => {
  const counts = { coder: 0, reader: 0, inputs: [] };
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    const url = String(endpoint);
    if (url === 'https://api.anthropic.com/v1/messages') {
      counts.reader += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice?.name, 'interpret_owner_reply');
      const context = JSON.parse(body.messages[0].content);
      const input = reading.current(context);
      return new Response(JSON.stringify({ model: READER_MODEL, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'interpret_owner_reply', input }] }), { status: 200 });
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    counts.coder += 1;
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => {
      counts.inputs.push(row);
      const sale = Number(row.money_in) > 0;
      const verdict = (sale ? reading.sale : null) || reading.verdict;
      const coder = typeof reading.coder === 'function' ? reading.coder(row, counts) : reading.coder || 'follows';
      const told = row.tax_registration?.status === 'not_registered' && row.tax_registration.treatments;
      const treatment = coder === 'follows' && told ? row.tax_registration.treatments[sale ? 'sale' : 'purchase'] : verdict.tax_treatment;
      return { transaction_id: row.id, ...verdict, tax_treatment: treatment, confidence: 'high', evidence_required: false, auto_explain_limit: 5000,
        reasoning: 'The settled receipt supports the account and the treatment.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' };
    });
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  return counts;
};
const answerWith = (registered, from = null, until = null, confidence = 0.97) => () =>
  ({ answer: { registered, registered_from: from, registered_until: until }, confidence, clarification: null });

const addLine = async (pool, clientId, country, id, date = '2026-06-02', { sale = false } = {}) => {
  const family = sale ? 'sales_invoice' : 'receipt';
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,$5,$6,$7,$8,'needs_review','{}')",
    [id, firmId, clientId, date, `Synthetic ${sale ? 'customer payment' : 'office supplies'} ${id.slice(-1)}`, sale ? country.gross : 0, sale ? 0 : country.gross, country.currency]);
  // The source prints VAT whether or not the business is registered.
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,$4,$5,'completed',$6,$7,$8,$9,'{}')", [`doc-${id}`, firmId, clientId, sale ? 'Synthetic sales invoice.pdf' : 'Synthetic receipt.pdf', family, country.gross, country.tax, country.currency, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,$5,$6,$7,.98,'auto_matched','fixture','{}')", [`match-${id}`, firmId, clientId, id, family, `doc-${id}`, country.gross]);
};
const lineRow = async (pool, id) => (await pool.query('select coding_state,convergence_state,convergence_reason,payload from transactions where id=$1', [id])).rows[0];
const journals = async (pool, id) => (await pool.query('select count(*)::int n from ledger_journals where source_id=$1', [id])).rows[0].n;
const liveAsks = async (pool, clientId) => (await pool.query("select id,transaction_id,question,status,request_payload from client_evidence_requests where client_id=$1 and status in ('draft','open','replied') order by created_at,id", [clientId])).rows;
const profileOf = async (pool, clientId) => (await pool.query('select profile from clients where id=$1', [clientId])).rows[0].profile;
// The P&L legs and any VAT leg of the journals a source posted.
const postedLegs = async (pool, sourceIds) => (await pool.query(`select l.account_code, a.account_type, l.tax_type, l.payload->>'role' as role, l.debit::float8 as debit, l.credit::float8 as credit
    from ledger_lines l join ledger_journals j on j.id = l.journal_id join ledger_accounts a on a.id = l.account_id
   where j.source_id = any($1::text[]) order by l.id`, [sourceIds])).rows;
// Posted without VAT: one P&L leg of the gross, carrying the country's no-VAT
// treatment, and no VAT control leg anywhere in the journal.
const assertPostedWithoutVat = async (pool, sourceIds, country, side = 'purchase') => {
  const legs = await postedLegs(pool, sourceIds);
  const pnl = legs.filter(leg => ['expense', 'revenue'].includes(leg.account_type));
  assert.equal(pnl.length, 1, JSON.stringify(legs));
  assert.equal(pnl[0].account_type, side === 'sale' ? 'revenue' : 'expense');
  assert.equal(side === 'sale' ? pnl[0].credit : pnl[0].debit, country.gross, 'the gross is the cost or the revenue');
  assert.equal(pnl[0].tax_type, country.withoutTax[side]);
  assert.equal(legs.filter(leg => /vat|alv/i.test(leg.role || '')).length, 0, `no VAT leg: ${JSON.stringify(legs)}`);
};
const addBill = async (pool, clientId, id) => {
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,'2026-06-02','Synthetic supplier payment',0,125.5,'EUR','needs_review','{}')", [id, firmId, clientId]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,vendor_name,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic bill.pdf','supplier_bill','completed','Synthetic Supplier Oy',125.5,25.5,'EUR','2026-02-10','{}')", [`doc-${id}`, firmId, clientId]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'supplier_bill',$5,125.5,.98,'auto_matched','fixture','{}')", [`match-${id}`, firmId, clientId, id, `doc-${id}`]);
};
const registrationQuestions = async (pool, clientId) => (await pool.query("select count(*)::int n from client_evidence_requests where client_id=$1 and request_payload->>'lane'='tax_registration'", [clientId])).rows[0].n;

// Steps 1–4 for every line of the client: code, refuse, re-admit, ask.
const refuseAndAsk = async ({ pool, clientId, ids }) => {
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  for (const id of ids) assert.ok((await lineRow(pool, id)).payload.ledger_post_refusal?.code, `${id} refused`);
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const asked = [];
  for (const id of ids) {
    assert.equal((await lineRow(pool, id)).payload.ai_suggestion?.tax_unresolved_guard?.constraint, 'tax_registration_unrecorded');
    asked.push(await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: AUTO }));
  }
  for (const id of ids) assert.equal(await journals(pool, id), 0);
  return asked;
};
// The owner answers through the real reply writer; the reply reader runs.
const reply = async (pool, clientId, text) => {
  const [ask] = await liveAsks(pool, clientId);
  await pool.query("update client_evidence_requests set status='open' where id=$1 and status='draft'", [ask.id]);
  const resolved = await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: ask.id, reply: text, actorId: OWNER, actorType: 'client' });
  return { ask, resolved };
};
// After the answer: re-code, then the auto-post sweep.
const recodeAndPost = async (pool, clientId, ids) => {
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  for (const id of ids) await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: AUTO });
};
const recordedReceipts = async (pool, clientId) => (await pool.query("select actor_id,actor_type,metadata from audit_events where client_id=$1 and action='tax_registration.owner_answer_recorded' order by id", [clientId])).rows;

for (const [label, country, seed, clientId] of [['GB', GB, seedGb, 'gb-unrecorded'], ['FI', FI, seedFi, 'fi-not-registered']]) {
  test(`real PG (${label}): "yes, registered since <date>" is read, recorded with its receipt, and the line posts with its VAT split`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    await seed(pool, clientId);
    const reading = { verdict: country.verdict, current: answerWith('yes', '2026-01-01') };
    const counts = mockModels(t, reading);
    const id = `${clientId}-purchase`;
    await addLine(pool, clientId, country, id);
    const [asked] = await refuseAndAsk({ pool, clientId, ids: [id] });
    assert.equal(asked.owner_asked, 1, JSON.stringify(asked));
    const before = (await profileOf(pool, clientId))[country.field] ?? null;
    // 5. The owner answers. The registration lane reads it (one strong call).
    const { ask, resolved } = await reply(pool, clientId, 'Yes, the business has been registered since 2026-01-01.');
    assert.equal(counts.reader, 1);
    assert.equal(resolved.recode?.applied, true, JSON.stringify(resolved.recode));
    const record = (await profileOf(pool, clientId))[country.field];
    assert.equal(record.status, 'registered');
    assert.equal(record.registered_from, '2026-01-01');
    // The receipt: who answered, the question, before and after, the reader model, the undo.
    const [receipt] = await recordedReceipts(pool, clientId);
    assert.equal(receipt.actor_id, OWNER);
    assert.equal(receipt.metadata.evidence_request_id, ask.id);
    assert.deepEqual(receipt.metadata.before, before);
    assert.equal(receipt.metadata.after.registered_from, '2026-01-01');
    assert.equal(receipt.metadata.reading.model, READER_MODEL);
    assert.deepEqual(receipt.metadata.undo, { profile_patch: { [country.field]: before } });
    const profileAudit = (await pool.query("select actor_id,metadata from audit_events where client_id=$1 and action='client.profile.update' order by id desc limit 1", [clientId])).rows[0];
    assert.equal(profileAudit.actor_id, OWNER, 'the one profile writer recorded it');
    assert.deepEqual(profileAudit.metadata.keys, [country.field]);
    const closed = (await pool.query('select status,response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0];
    assert.equal(closed.status, 'resolved');
    assert.equal(closed.response_payload.reply_processing.model, READER_MODEL);
    assert.equal(closed.response_payload.reply_processing.driven_action, 'record_tax_registration_answer');
    assert.equal(closed.response_payload.owner_notice, label === 'FI'
      ? 'Kirjasimme, että yritys on arvonlisäverorekisterissä 2026-01-01 alkaen. Vastaa tähän, jos tieto ei ole oikein.'
      : 'We recorded that the business has been VAT-registered since 2026-01-01. Reply here if that is not right.');
    assert.equal(resolved.recode.owner_notice, closed.response_payload.owner_notice);
    // 6. The line goes through the normal path again and posts with its VAT split.
    assert.equal((await lineRow(pool, id)).coding_state, 'proposed');
    await recodeAndPost(pool, clientId, [id]);
    assert.equal(await journals(pool, id), 1);
    const taxLine = (await pool.query("select l.debit from ledger_lines l join ledger_journals j on j.id=l.journal_id where j.source_id=$1 and l.debit>0 order by l.debit", [id])).rows.map(r => Number(r.debit));
    assert.deepEqual(taxLine, [country.tax, country.gross - country.tax], 'net and VAT legs');
    const posted = await lineRow(pool, id);
    assert.notEqual(posted.convergence_state, 'hanging', JSON.stringify([posted.convergence_state, posted.convergence_reason]));
    assert.equal((await liveAsks(pool, clientId)).length, 0);
  });
}

test('real PG (FI): two refused lines of one client get one question; one answer settles both and both post', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-two-lines';
  await seedFi(pool, clientId);
  const counts = mockModels(t, { verdict: FI.verdict, current: answerWith('yes', '2026-01-01') });
  const ids = [`${clientId}-a`, `${clientId}-b`];
  for (const id of ids) await addLine(pool, clientId, FI, id);
  const asked = await refuseAndAsk({ pool, clientId, ids });
  assert.deepEqual(asked.map(r => r.owner_asked), [1, 0]);
  const live = await liveAsks(pool, clientId);
  assert.equal(live.length, 1, 'one registration question per client');
  assert.deepEqual(live[0].request_payload.tax_registration.lines.map(l => l.transaction_id), ids);
  for (const id of ids) assert.equal((await lineRow(pool, id)).coding_state, 'asked');
  const joinedReceipt = (await pool.query("select metadata from audit_events where client_id=$1 and action='evidence_request.line_joined'", [clientId])).rows;
  assert.deepEqual(joinedReceipt.map(r => r.metadata.transaction_id), [ids[1]]);
  const { ask } = await reply(pool, clientId, 'Kyllä, olemme olleet rekisterissä 1.1.2026 alkaen.');
  assert.equal(counts.reader, 1);
  const [receipt] = await recordedReceipts(pool, clientId);
  assert.deepEqual(receipt.metadata.line_ids, ids);
  for (const id of ids) {
    const row = await lineRow(pool, id);
    assert.equal(row.payload.tax_registration_answer.evidence_request_id, ask.id);
    assert.equal(row.payload.tax_registration_answer.registered, true);
  }
  await recodeAndPost(pool, clientId, ids);
  for (const id of ids) assert.equal(await journals(pool, id), 1, `${id} posts`);
  assert.equal((await liveAsks(pool, clientId)).length, 0);
});

test('real PG (FI): "yes" without a date gets one follow-up for the date, in Finnish; the date then records it', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-no-date';
  await seedFi(pool, clientId);
  const reading = { verdict: FI.verdict, current: answerWith('yes', null) };
  mockModels(t, reading);
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, FI, id);
  await refuseAndAsk({ pool, clientId, ids: [id] });
  const { ask, resolved } = await reply(pool, clientId, 'Kyllä on.');
  assert.equal(resolved.recode?.needsClarification, true, JSON.stringify(resolved.recode));
  const open = (await pool.query('select status,question from client_evidence_requests where id=$1', [ask.id])).rows[0];
  assert.equal(open.status, 'open');
  assert.equal(open.question, 'Kiitos. Mistä päivästä alkaen yritys on ollut arvonlisäverorekisterissä? Kerro tarkka päivämäärä (esimerkiksi 1.3.2026) niin kuin se lukee Verohallinnon päätöksessä tai YTJ:ssä.');
  assert.equal((await profileOf(pool, clientId)).alv_registration, undefined, 'nothing recorded');
  assert.equal((await recordedReceipts(pool, clientId)).length, 0);
  assert.equal((await lineRow(pool, id)).convergence_state, 'on_owner');
  // Still no date: the bound is spent; the question stays on the owner, fixed wording.
  await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: ask.id, reply: 'Kyllä, joskus alkuvuodesta.', actorId: OWNER, actorType: 'client' });
  const exhausted = (await pool.query('select status,question from client_evidence_requests where id=$1', [ask.id])).rows[0];
  assert.equal(exhausted.status, 'open');
  assert.match(exhausted.question, /^Emme vielä pysty kirjaamaan arvonlisäverorekisteröintiä/);
  assert.equal((await pool.query("select count(*)::int n from audit_events where action='tax_registration.clarification_exhausted' and resource_id=$1", [ask.id])).rows[0].n, 1);
  assert.equal((await lineRow(pool, id)).convergence_state, 'on_owner');
  // The owner then sends the date: it is still read and recorded.
  reading.current = answerWith('yes', '2026-02-01');
  await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: ask.id, reply: 'Päätöksessä lukee 1.2.2026.', actorId: OWNER, actorType: 'client' });
  assert.equal((await profileOf(pool, clientId)).alv_registration.registered_from, '2026-02-01');
  await recodeAndPost(pool, clientId, [id]);
  assert.equal(await journals(pool, id), 1);
});

test('real PG (GB): an unclear or low-confidence reading, or a future date, records nothing and asks the fixed follow-up', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-unclear';
  await seedGb(pool, clientId);
  const reading = { verdict: GB.verdict, current: () => ({ answer: null, confidence: 0.4, clarification: 'Model wording that must not reach the owner.' }) };
  mockModels(t, reading);
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, GB, id);
  await refuseAndAsk({ pool, clientId, ids: [id] });
  const { ask } = await reply(pool, clientId, 'I think my accountant handled that?');
  const open = (await pool.query('select status,question,response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0];
  assert.equal(open.status, 'open');
  assert.equal(open.question, 'Thanks for your reply. We could not tell from it whether the business is VAT-registered. Please answer yes or no, and if yes, the date the registration is effective from.');
  assert.equal(open.response_payload.reply_processing.model, READER_MODEL);
  assert.equal((await profileOf(pool, clientId)).vat_registration, undefined, 'nothing recorded');
  assert.equal(await journals(pool, id), 0);
  // A "yes" from a date in the future fails the model-independent check.
  reading.current = answerWith('yes', '2099-01-01');
  await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: ask.id, reply: 'Yes, from 1 January 2099.', actorId: OWNER, actorType: 'client' });
  assert.equal((await profileOf(pool, clientId)).vat_registration, undefined, 'nothing recorded');
  assert.equal((await recordedReceipts(pool, clientId)).length, 0);
  assert.equal((await lineRow(pool, id)).convergence_state, 'on_owner');
});

// The owner's "no" settles the fact: the waiting line goes back to the coder
// with it, is coded without VAT, and posts gross. Not asked again.
for (const [label, country, seed, clientId] of [['GB', GB, seedGb, 'gb-not-registered'], ['FI', FI, seedFi, 'fi-not-registered']]) {
  test(`real PG (${label}): "no" is recorded with its receipt; the waiting line posts without VAT and is not asked again`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    await seed(pool, clientId);
    const counts = mockModels(t, { verdict: country.verdict, current: answerWith('no') });
    const id = `${clientId}-purchase`;
    await addLine(pool, clientId, country, id);
    await refuseAndAsk({ pool, clientId, ids: [id] });
    const { resolved } = await reply(pool, clientId, label === 'FI' ? 'Ei ole.' : 'No, we are not VAT registered.');
    assert.equal(resolved.recode.owner_notice, label === 'FI'
      ? 'Kirjasimme, että yritys ei ole arvonlisäverorekisterissä. Vastaa tähän, jos tieto ei ole oikein.'
      : 'We recorded that the business is not VAT-registered. Reply here if that is not right.');
    assert.equal((await profileOf(pool, clientId))[country.field].status, 'not_registered');
    assert.equal((await recordedReceipts(pool, clientId)).length, 1);
    assert.equal((await lineRow(pool, id)).payload.tax_registration_answer.registered, false);
    await recodeAndPost(pool, clientId, [id]);
    const told = counts.inputs.filter(row => row.id === id).at(-1).tax_registration;
    assert.equal(told.status, 'not_registered');
    assert.equal(told.on_date, '2026-06-02');
    assert.ok(told.instruction.length > 0 && told.treatments, JSON.stringify(told));
    const row = await lineRow(pool, id);
    assert.equal(row.payload.ai_suggestion.tax_registration_fact.needs_registration, false);
    assert.equal(row.payload.ai_suggestion.tax_unresolved_guard, undefined, 'no registration guard: Donna knows the treatment');
    assert.equal(row.payload.ai_suggestion.remember_candidate, false);
    assert.equal(await journals(pool, id), 1, 'posts once');
    await assertPostedWithoutVat(pool, [id], country);
    assert.equal(row.convergence_state, 'auto_reconciled', JSON.stringify([row.convergence_state, row.convergence_reason]));
    assert.equal((await liveAsks(pool, clientId)).length, 0, 'not asked again');
    assert.equal(await registrationQuestions(pool, clientId), 1, 'the one question that was answered');
  });
}

test('real PG (FI): a recorded fact on a prepared client is not changed; nothing is recorded and the line is not finished', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-prepared';
  // A record pilot preparation bound, but one that does not settle the date
  // (its status is outside the closed vocabulary): the line is asked about.
  await seedFi(pool, clientId, { alv_registration: { status: 'pending_review' } });
  await pool.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'system','fixture','pilot.prepared','client',$2,'{}')", [firmId, clientId]);
  mockModels(t, { verdict: FI.verdict, current: answerWith('yes', '2026-01-01') });
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, FI, id);
  await refuseAndAsk({ pool, clientId, ids: [id] });
  const { ask } = await reply(pool, clientId, 'Kyllä, 1.1.2026 alkaen.');
  assert.deepEqual((await profileOf(pool, clientId)).alv_registration, { status: 'pending_review' }, 'the locked fact is unchanged');
  assert.equal((await recordedReceipts(pool, clientId)).length, 0);
  const refused = (await pool.query("select metadata from audit_events where client_id=$1 and action='tax_registration.owner_answer_not_recorded'", [clientId])).rows;
  assert.equal(refused.length, 1);
  assert.equal(refused[0].metadata.refusal.code, 'FI_PROFILE_PILOT_PREPARED');
  const answered = (await pool.query('select status,response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0];
  assert.equal(answered.status, 'replied');
  assert.equal(answered.response_payload.reply_processing.driven_action, 'tax_registration_record_locked');
  await recodeAndPost(pool, clientId, [id]);
  const row = await lineRow(pool, id);
  assert.equal(row.payload.tax_registration_answer.state, 'record_locked');
  assert.notEqual(row.coding_state, 'applied');
  assert.notEqual(row.convergence_state, 'auto_reconciled', 'the row does not present as finished');
  assert.equal(await journals(pool, id), 0);
});

// The PR #55 flow, kept: before the answer nothing posts and nothing is re-asked.
test('real PG (FI): before the answer, a second clock tick neither re-asks nor posts', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-waiting';
  await seedFi(pool, clientId);
  mockModels(t, { verdict: FI.verdict, current: answerWith('unclear') });
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, FI, id);
  await refuseAndAsk({ pool, clientId, ids: [id] });
  assert.deepEqual((await liveAsks(pool, clientId)).map(ask => ask.question),
    ['Synthetic office supplies e: meillä ei ole tietoa siitä, onko yritys arvonlisäverorekisterissä. Onko yritys merkitty arvonlisäverorekisteriin? Jos on, mistä päivästä alkaen?']);
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: true }), { code: 'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED' });
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal((await liveAsks(pool, clientId)).length, 1);
  assert.equal(await journals(pool, id), 0);
});

// An answer never removes registered days the record already holds. The
// question is asked while the record is unknown; before the owner answers, the
// firm records the registration (from 2026-03-01, or 2025-01-01 to
// 2026-03-31), so the line's date falls outside it. The answer may only extend
// the record. A record the answer confirms says not registered on the line's
// date: the line posts without VAT. One the answer disputes rests for a person.
const COVERAGE = [
  { name: 'a plain "no" confirms a registered record and writes nothing; the earlier line posts without VAT', record: { status: 'registered', registered_from: '2026-03-01' },
    date: '2026-02-10', reading: answerWith('no'), outcome: 'confirmed' },
  { name: 'a plain "no" keeps a deregistered window; the later line posts without VAT', record: { status: 'deregistered', registered_from: '2025-01-01', registered_until: '2026-03-31' },
    date: '2026-06-02', reading: answerWith('no'), outcome: 'confirmed' },
  { name: 'a later start is not recorded and the line rests for a person', record: { status: 'registered', registered_from: '2026-03-01' },
    date: '2026-02-10', reading: answerWith('yes', '2026-04-01'), outcome: 'conflict' },
  { name: 'an earlier start is recorded and the line posts with VAT', record: { status: 'registered', registered_from: '2026-03-01' },
    date: '2026-02-10', reading: answerWith('yes', '2026-01-01'), outcome: 'written' }
];
for (const [label, country, seed] of [['GB', GB, seedGb], ['FI', FI, seedFi]]) for (const [index, item] of COVERAGE.entries()) {
  test(`real PG (${label}): ${item.name}`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    const clientId = `${label.toLowerCase()}-coverage-${index}`;
    await seed(pool, clientId);
    mockModels(t, { verdict: country.verdict, current: item.reading });
    const id = `${clientId}-purchase`;
    await addLine(pool, clientId, country, id, item.date);
    await refuseAndAsk({ pool, clientId, ids: [id] });
    await pool.query(`update clients set profile = jsonb_set(profile, '{${country.field}}', $2::jsonb) where id = $1`, [clientId, JSON.stringify(item.record)]);
    const stored = (await profileOf(pool, clientId))[country.field];
    const { ask } = await reply(pool, clientId, 'Synthetic owner answer.');
    const record = (await profileOf(pool, clientId))[country.field];
    const closed = (await pool.query('select status,response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0];
    if (item.outcome === 'written') {
      assert.equal(record.registered_from, '2026-01-01');
      assert.equal(closed.status, 'resolved');
      await recodeAndPost(pool, clientId, [id]);
      assert.equal(await journals(pool, id), 1);
      assert.equal((await postedLegs(pool, [id])).filter(leg => /vat|alv/i.test(leg.role || '')).length, 1, 'posted with its VAT split');
      return;
    }
    assert.deepEqual(record, stored, 'the recorded registration is unchanged');
    if (item.outcome === 'confirmed') {
      const [receipt] = await recordedReceipts(pool, clientId);
      assert.equal(receipt.metadata.outcome, 'confirmed_record');
      assert.equal(receipt.metadata.changed, false);
      assert.equal(closed.status, 'resolved');
    } else {
      assert.equal((await recordedReceipts(pool, clientId)).length, 0);
      const [refused] = (await pool.query("select metadata from audit_events where client_id=$1 and action='tax_registration.owner_answer_not_recorded'", [clientId])).rows;
      assert.equal(refused.metadata.reason, 'conflicts_with_recorded_registration');
      assert.deepEqual(refused.metadata.record, stored);
      assert.equal(refused.metadata.proposed.registered_from, '2026-04-01');
      assert.equal(closed.status, 'replied');
      assert.equal(closed.response_payload.reply_processing.driven_action, 'tax_registration_record_conflict');
    }
    await recodeAndPost(pool, clientId, [id]);
    const row = await lineRow(pool, id);
    assert.equal(row.payload.tax_registration_answer.state, item.outcome === 'confirmed' ? 'recorded' : 'record_conflict');
    if (item.outcome === 'confirmed') {
      assert.equal(await journals(pool, id), 1);
      await assertPostedWithoutVat(pool, [id], country);
      assert.equal(row.convergence_state, 'auto_reconciled');
    } else {
      assert.notEqual(row.convergence_state, 'auto_reconciled');
      assert.equal(await journals(pool, id), 0);
    }
    assert.equal((await liveAsks(pool, clientId)).filter(a => a.status !== 'replied').length, 0, 'not asked again');
  });
}

// The record says not registered: Donna applies that herself. The coder is
// told, codes without VAT, and the line posts once, gross, with no question.
for (const [label, country, seed] of [['GB', GB, seedGb], ['FI', FI, seedFi]]) {
  test(`real PG (${label}): a purchase whose receipt prints VAT, for a business recorded as not registered, posts once gross with no VAT leg and no question`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    const clientId = `${label.toLowerCase()}-recorded-not-registered`;
    await seed(pool, clientId, { [country.field]: { status: 'not_registered' } });
    const counts = mockModels(t, { verdict: country.verdict, current: answerWith('unclear') });
    const id = `${clientId}-purchase`;
    await addLine(pool, clientId, country, id);
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    const [told] = counts.inputs.map(row => row.tax_registration);
    assert.equal(told.status, 'not_registered');
    assert.equal(told.reason, 'not_registered');
    assert.match(told.instruction, label === 'FI' ? /not in the Finnish VAT register/ : /not VAT-registered/);
    const row = await lineRow(pool, id);
    assert.equal(row.payload.ledger_post_refusal, undefined, JSON.stringify(row.payload.ledger_post_refusal));
    assert.equal(await journals(pool, id), 1, 'posts once');
    await assertPostedWithoutVat(pool, [id], country);
    assert.equal(row.convergence_state, 'auto_reconciled', JSON.stringify([row.convergence_state, row.convergence_reason]));
    await recoverChangedCodingEvidenceInDb({ firmId });
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    assert.equal(await journals(pool, id), 1, 'still once');
    assert.equal(await registrationQuestions(pool, clientId), 0, 'no question to the owner');
  });

  test(`real PG (${label}): a sale by a business recorded as not registered posts its full amount as revenue with no VAT leg`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    const clientId = `${label.toLowerCase()}-sale-not-registered`;
    await seed(pool, clientId, { [country.field]: { status: 'not_registered' } });
    mockModels(t, { verdict: country.verdict, sale: country.sale, current: answerWith('unclear') });
    const id = `${clientId}-sale`;
    await addLine(pool, clientId, country, id, '2026-06-02', { sale: true });
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    const row = await lineRow(pool, id);
    assert.equal(await journals(pool, id), 1, JSON.stringify(row.payload.ledger_post_refusal || row.convergence_reason));
    await assertPostedWithoutVat(pool, [id], country, 'sale');
    assert.equal(row.convergence_state, 'auto_reconciled', JSON.stringify([row.convergence_state, row.convergence_reason]));
    assert.equal(await registrationQuestions(pool, clientId), 0);
  });

  // The coder returns a VAT-carrying code anyway: the ledger refuses it as
  // before, the clock sends it back once with the refusal, and it either posts
  // without VAT or rests visibly unfinished. Never posted with VAT, never asked.
  for (const [mode, coder] of [['keeps the printed rate', 'stubborn'], ['follows on the re-run', (row) => row.posting_recovery ? 'follows' : 'stubborn']]) {
    test(`real PG (${label}): a coder that ignores the fact is refused and re-run once; it ${mode}`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
      const pool = await freshDb(t);
      const clientId = `${label.toLowerCase()}-ignores-${typeof coder}`;
      await seed(pool, clientId, { [country.field]: { status: 'not_registered' } });
      const counts = mockModels(t, { verdict: country.verdict, coder, current: answerWith('unclear') });
      const id = `${clientId}-purchase`;
      await addLine(pool, clientId, country, id);
      await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
      const refused = (await lineRow(pool, id)).payload.ledger_post_refusal;
      assert.equal(refused?.code, country.refusalCode);
      assert.equal(refused.details.registered, false);
      for (let tick = 0; tick < 3; tick += 1) {
        await recoverChangedCodingEvidenceInDb({ firmId });
        await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
      }
      const reruns = counts.inputs.filter(row => row.id === id && row.posting_recovery);
      assert.equal(reruns.length, 1, 'back to the coder once, with the refusal');
      assert.equal(reruns[0].posting_recovery.previous_refusal.code, country.refusalCode);
      assert.equal(reruns[0].tax_registration.status, 'not_registered');
      const row = await lineRow(pool, id);
      assert.equal(await registrationQuestions(pool, clientId), 0, 'never a question');
      if (typeof coder === 'function') {
        assert.equal(await journals(pool, id), 1);
        await assertPostedWithoutVat(pool, [id], country);
        assert.equal(row.convergence_state, 'auto_reconciled');
        return;
      }
      assert.equal(await journals(pool, id), 0, 'never posted with VAT, never posted with its code dropped');
      assert.equal(row.payload.ledger_post_refusal?.code, country.refusalCode);
      assert.notEqual(row.convergence_state, 'auto_reconciled', 'shows as not finished');
      assert.equal(row.payload.coding_evidence_reconsideration.not_registered_attempts, 1);
    });
  }
}

test('real PG (FI): a line dated before the registration start posts without VAT; a line on or after it posts with its VAT split', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-registration-start';
  await seedFi(pool, clientId, { alv_registration: { status: 'registered', registered_from: '2026-03-01' } });
  const counts = mockModels(t, { verdict: FI.verdict, current: answerWith('unclear') });
  const before = `${clientId}-a`, onStart = `${clientId}-b`;
  await addLine(pool, clientId, FI, before, '2026-02-27');
  await addLine(pool, clientId, FI, onStart, '2026-03-01');
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const told = Object.fromEntries(counts.inputs.map(row => [row.id, row.tax_registration]));
  assert.deepEqual([told[before].status, told[before].reason], ['not_registered', 'not_yet_effective']);
  assert.deepEqual([told[onStart].status, told[onStart].treatments], ['registered', undefined]);
  assert.equal(await journals(pool, before), 1);
  await assertPostedWithoutVat(pool, [before], FI);
  assert.equal(await journals(pool, onStart), 1);
  const legs = await postedLegs(pool, [onStart]);
  assert.deepEqual(legs.filter(leg => leg.debit > 0).map(leg => leg.debit).sort((a, b) => a - b), [FI.tax, FI.gross - FI.tax], 'net and VAT legs');
  assert.equal(legs.filter(leg => /alv/i.test(leg.role || '')).length, 1, 'the ALV split');
  assert.equal(await registrationQuestions(pool, clientId), 0);
});

// The lines #62 left waiting: answered "no", stamped, and resting on the
// ledger's registration refusal under the old contract. The clock picks each
// up once, the coder is told the fact, and it posts the same way.
test('real PG (FI): a line left waiting after an owner "no" is picked up and posts without VAT', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-waiting-after-no';
  await seedFi(pool, clientId, { alv_registration: { status: 'not_registered', note: 'Owner answer to question evidence-request-waiting' } });
  mockModels(t, { verdict: FI.verdict, current: answerWith('unclear') });
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, FI, id);
  const refusal = { code: FI.refusalCode, source: 'posting_policy', error: 'This bank line would post the ALV code ALV_25_5_INPUT, but the business is not ALV-registered on 2026-06-02 (not_registered).',
    details: { as_of: '2026-06-02', vat_code: 'ALV_25_5_INPUT', registered: false, registration_reason: 'not_registered' } };
  // The resting shape the #62 flow leaves (applied, refused, the answer stamped,
  // the owner-answered guard, the clock's receipt with one attempt spent).
  await pool.query(`update transactions set coding_state='applied', status='needs_review', payload=$2::jsonb where id=$1`, [id, JSON.stringify({
    ai_suggestion_status: 'auto_applied', ledger_post_refusal: refusal,
    ai_suggestion: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %', confidence: 'low', evidence_required: false, posting_requirement: 'single_account',
      tax_unresolved_guard: { constraint: 'tax_registration_unrecorded', refusal_code: FI.refusalCode, as_of: '2026-06-02', registered: false, registration_reason: 'not_registered',
        owner_answered: true, answer: { evidence_request_id: 'evidence-request-waiting', receipt_id: '1', state: 'recorded' } } },
    tax_registration_answer: { evidence_request_id: 'evidence-request-waiting', receipt_id: '1', state: 'recorded', as_of: '2026-06-02', registered: false, registration_reason: 'not_registered' },
    coding_evidence_reconsideration: { digest: 'earlier-revision', contract: CODING_RECONSIDERATION_CONTRACT, attempts: 1, reason: 'coding_source_conflict' } })]);
  await recoverChangedCodingEvidenceInDb({ firmId });
  await recodeAndPost(pool, clientId, [id]);
  assert.equal(await journals(pool, id), 1);
  await assertPostedWithoutVat(pool, [id], FI);
  assert.equal((await lineRow(pool, id)).convergence_state, 'auto_reconciled');
  assert.equal(await registrationQuestions(pool, clientId), 0);
});

test('real PG (GB): after a "no", a new line is coded without VAT and posts, with no fresh question', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-no-then-new-line';
  await seedGb(pool, clientId);
  mockModels(t, { verdict: GB.verdict, current: answerWith('no') });
  await addLine(pool, clientId, GB, `${clientId}-a`);
  await refuseAndAsk({ pool, clientId, ids: [`${clientId}-a`] });
  await reply(pool, clientId, 'No.');
  const later = `${clientId}-b`;
  await addLine(pool, clientId, GB, later, '2026-07-01');
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal(await journals(pool, later), 1);
  await assertPostedWithoutVat(pool, [later], GB);
  assert.equal((await liveAsks(pool, clientId)).length, 0, 'no fresh question');
  assert.equal(await registrationQuestions(pool, clientId), 1);
});

// The UK's no-VAT treatment is only for a business the record says is not
// registered: a registered one is refused by name and sent back to the coder.
test('real PG (GB): the no-VAT treatment is refused for a registered business; every VAT_ code is still refused for an unregistered one', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const registered = 'gb-registered-no-vat', unregistered = 'gb-unregistered-zero-rated';
  await seedGb(pool, registered, { vat_registration: { status: 'registered', registered_from: '2020-01-01', vat_registration_number: 'GB123456789' } });
  await seedGb(pool, unregistered, { vat_registration: { status: 'not_registered' } });
  const verdicts = { [registered]: 'No VAT (not VAT-registered)', [unregistered]: 'Zero-rated 0%' };
  mockModels(t, { verdict: GB.verdict, coder: 'stubborn', current: answerWith('unclear') });
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => ({ transaction_id: row.id, ...GB.verdict, tax_treatment: verdicts[row.id.replace(/-purchase$/, '')], confidence: 'high', evidence_required: false,
      auto_explain_limit: 5000, reasoning: 'Fixture.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' }));
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  for (const clientId of [registered, unregistered]) {
    await addLine(pool, clientId, GB, `${clientId}-purchase`);
    await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
    assert.equal(await journals(pool, `${clientId}-purchase`), 0);
  }
  assert.equal((await lineRow(pool, `${registered}-purchase`)).payload.ledger_post_refusal?.code, 'TRANSACTION_GB_VAT_NOT_REGISTERED_TREATMENT_REFUSED');
  const zero = (await lineRow(pool, `${unregistered}-purchase`)).payload.ledger_post_refusal;
  assert.equal(zero?.code, 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED');
  assert.equal(zero.details.vat_code, 'VAT_ZR_INPUT');
});

test('real PG (FI): a supplier bill refused for registration on its own date is asked about and released by the answer', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-supplier-bill';
  await seedFi(pool, clientId, { accounting_basis: 'accrual' });
  await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,'FINLAND_EINVOICE_RECEIVE','auto','manual')", [`${clientId}-recv`, firmId, clientId]);
  mockModels(t, { verdict: FI.verdict, current: answerWith('yes', '2026-01-01') });
  const id = `${clientId}-payment`;
  await addBill(pool, clientId, id);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const refused = (await lineRow(pool, id)).payload.ledger_post_refusal;
  assert.ok(['SUPPLIER_BILL_ALV_REGISTRATION_REQUIRED', 'TRANSACTION_ALV_REGISTRATION_REQUIRED'].includes(refused?.code), JSON.stringify(refused));
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const guard = (await lineRow(pool, id)).payload.ai_suggestion?.tax_unresolved_guard;
  assert.equal(guard?.constraint, 'tax_registration_unrecorded');
  assert.equal((await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: AUTO })).owner_asked, 1);
  await reply(pool, clientId, 'Kyllä, 1.1.2026 alkaen.');
  assert.equal((await profileOf(pool, clientId)).alv_registration.registered_from, '2026-01-01');
  await recodeAndPost(pool, clientId, [id]);
  const posted = (await pool.query('select count(*)::int n from ledger_journals where firm_id=$1 and client_id=$2', [firmId, clientId])).rows[0].n;
  assert.equal(posted, 2, 'the AP journal and its settlement');
});

// A bill dated before the registration start, paid after it: the coder is told
// the bill's date settles the fact, and the bank line and its bill post
// together without VAT (the bill's expense gross, no ALV leg in either).
test('real PG (FI): a supplier bill dated before the registration start posts with its bank line without VAT', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-supplier-bill-before-start';
  await seedFi(pool, clientId, { accounting_basis: 'accrual', alv_registration: { status: 'registered', registered_from: '2026-03-01' } });
  await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,'FINLAND_EINVOICE_RECEIVE','auto','manual')", [`${clientId}-recv`, firmId, clientId]);
  const counts = mockModels(t, { verdict: FI.verdict, current: answerWith('unclear') });
  const id = `${clientId}-payment`;
  await addBill(pool, clientId, id);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  const [told] = counts.inputs.map(row => row.tax_registration);
  assert.deepEqual([told.status, told.on_date, told.date_of], ['not_registered', '2026-02-10', 'supplier_bill']);
  const row = await lineRow(pool, id);
  assert.equal(row.payload.ledger_post_refusal, undefined, JSON.stringify(row.payload.ledger_post_refusal));
  const sources = (await pool.query('select source_id, source_type from ledger_journals where firm_id=$1 and client_id=$2 order by id', [firmId, clientId])).rows;
  assert.equal(sources.length, 2, `the AP journal and its settlement: ${JSON.stringify(sources)}`);
  await assertPostedWithoutVat(pool, sources.map(source => source.source_id), FI);
  assert.equal(row.convergence_state, 'auto_reconciled', JSON.stringify([row.convergence_state, row.convergence_reason]));
  assert.equal(await registrationQuestions(pool, clientId), 0);
});
