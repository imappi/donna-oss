// Real PG (FI and GB, synthetic data): a bank line the ledger refuses because
// the business is not recorded as VAT/ALV registered on its date does not
// rest with nobody asked. The real coder codes it, auto-post refuses it by
// name, the evidence clock re-admits it, the coder's contract
// (transactionLlm.js) turns it into the owner's registration question, in the
// owner's language, and the owner-ask writer (codingAutoPost.js) puts that
// question on the owner. Nothing posts until the record says registered.
// The owner's answer is read by the registration lane (taxRegistrationReply.js,
// through the shared owner-reply worker and a strong reading), recorded
// through the one profile writer with its receipt, and every line the question
// stood for is re-run: registered from the line's date, it posts with its VAT
// split. One question per client however many lines were refused.
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
const seedFi = async (pool, clientId, profile = { alv_registration: { status: 'not_registered' } }) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Rekisteröimätön Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
};
const FI = { currency: 'EUR', gross: 125.5, tax: 25.5, refusalCode: 'TRANSACTION_ALV_REGISTRATION_REQUIRED', field: 'alv_registration',
  verdict: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' } };
const GB = { currency: 'GBP', gross: 120, tax: 20, refusalCode: 'TRANSACTION_GB_VAT_REGISTRATION_REQUIRED', field: 'vat_registration',
  verdict: { proposed_account: 'Software subscriptions', tax_treatment: 'VAT 20%' } };

// The model fixtures: the coder (OpenAI responses) always proposes the rated
// coding; the owner-reply reader (Anthropic messages) returns `reading()`.
const mockModels = (t, reading) => {
  const counts = { coder: 0, reader: 0 };
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
    const suggestions = input.transactions.map(row => ({ transaction_id: row.id, ...reading.verdict, confidence: 'high', evidence_required: false, auto_explain_limit: 5000,
      reasoning: 'The settled receipt supports the account and its printed VAT.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' }));
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
  return counts;
};
const answerWith = (registered, from = null, until = null, confidence = 0.97) => () =>
  ({ answer: { registered, registered_from: from, registered_until: until }, confidence, clarification: null });

const addLine = async (pool, clientId, country, id, date = '2026-06-02') => {
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,$5,0,$6,$7,'needs_review','{}')", [id, firmId, clientId, date, `Synthetic office supplies ${id.slice(-1)}`, country.gross, country.currency]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic receipt.pdf','receipt','completed',$4,$5,$6,$7,'{}')", [`doc-${id}`, firmId, clientId, country.gross, country.tax, country.currency, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')", [`match-${id}`, firmId, clientId, id, `doc-${id}`, country.gross]);
};
const lineRow = async (pool, id) => (await pool.query('select coding_state,convergence_state,convergence_reason,payload from transactions where id=$1', [id])).rows[0];
const journals = async (pool, id) => (await pool.query('select count(*)::int n from ledger_journals where source_id=$1', [id])).rows[0].n;
const liveAsks = async (pool, clientId) => (await pool.query("select id,transaction_id,question,status,request_payload from client_evidence_requests where client_id=$1 and status in ('draft','open','replied') order by created_at,id", [clientId])).rows;
const profileOf = async (pool, clientId) => (await pool.query('select profile from clients where id=$1', [clientId])).rows[0].profile;

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
  assert.deepEqual((await profileOf(pool, clientId)).alv_registration, { status: 'not_registered' }, 'nothing recorded');
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

test('real PG (GB): "no" is recorded with its receipt; the line is not asked again and does not post (no VAT deduction path yet)', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-not-registered';
  await seedGb(pool, clientId);
  mockModels(t, { verdict: GB.verdict, current: answerWith('no') });
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, GB, id);
  await refuseAndAsk({ pool, clientId, ids: [id] });
  const { resolved } = await reply(pool, clientId, 'No, we are not VAT registered.');
  assert.equal(resolved.recode.owner_notice, 'We recorded that the business is not VAT-registered. Reply here if that is not right.');
  assert.equal((await profileOf(pool, clientId)).vat_registration.status, 'not_registered');
  assert.equal((await recordedReceipts(pool, clientId)).length, 1);
  await recodeAndPost(pool, clientId, [id]);
  const row = await lineRow(pool, id);
  assert.equal(row.payload.tax_registration_answer.registered, false);
  assert.equal(row.payload.ai_suggestion.tax_unresolved_guard.owner_answered, true);
  assert.equal(row.payload.ai_suggestion.ask_client_question, '');
  assert.equal((await liveAsks(pool, clientId)).length, 0, 'not asked again');
  assert.equal(await journals(pool, id), 0, 'no VAT posts for an unregistered business');
});

test('real PG (FI): a recorded fact on a prepared client is not changed; nothing is recorded and the line is not finished', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-prepared';
  await seedFi(pool, clientId);
  await pool.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,$2,'system','fixture','pilot.prepared','client',$2,'{}')", [firmId, clientId]);
  mockModels(t, { verdict: FI.verdict, current: answerWith('yes', '2026-01-01') });
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, FI, id);
  await refuseAndAsk({ pool, clientId, ids: [id] });
  const { ask } = await reply(pool, clientId, 'Kyllä, 1.1.2026 alkaen.');
  assert.deepEqual((await profileOf(pool, clientId)).alv_registration, { status: 'not_registered' }, 'the locked fact is unchanged');
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
    ['Synthetic office supplies e: tietojemme mukaan yritys ei ollut arvonlisäverorekisterissä 2026-06-02. Onko yritys merkitty arvonlisäverorekisteriin sen jälkeen? Jos on, mistä päivästä alkaen?']);
  await assert.rejects(postLedgerTransactionInDb({ firmId, clientId, transactionId: id, dryRun: true }), { code: 'TRANSACTION_CODING_REQUIREMENT_UNRESOLVED' });
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  assert.equal((await liveAsks(pool, clientId)).length, 1);
  assert.equal(await journals(pool, id), 0);
});
