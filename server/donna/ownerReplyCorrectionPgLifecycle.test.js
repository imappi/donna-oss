// Real PG (FI and GB, synthetic data): a reply to a question that is already
// closed. Donna tells the owner they can disagree with an answer she recorded,
// so a later reply is a correction to that answer: it is receipted as one (who,
// when, the earlier answer, the new text) and read by the reader that owns the
// question's kind (the registration lane on the structured owner-reply worker,
// or the coder's reply path for an ordinary line question). A correction that
// records nothing leaves every line the question stood for, and the question
// itself, exactly as they were. A question whose kind has no reader that can
// take a correction is not reopened at all: the reply writer refuses it and
// writes nothing, and a chat channel reads the text as a new message and says
// so. A quote-reply to Donna's in-band notice ("Reply here if that is not
// right") reaches the question, because the notice is in the delivery ledger.
//   DONNA_PG_TEST_URL=... node --test server/donna/ownerReplyCorrectionPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, resolveClientEvidenceRequestInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { DISCOVER_OWNER_REPLIES_SQL } from './ownerReplyRecovery.js';
import { listStructuredOwnerReplyEvidenceTypes } from './statutoryRegistry.js';
import { processWhatsAppInboundMessage } from './channels/whatsappInbound.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'owner-reply-correction-proof';
const OWNER = 'owner@example.test';
const READER_MODEL = 'recorded-strong-owner-reader';
const AUTO = { CODING_AUTO_POST: { stage: 'auto' } };
const skip = !pgUrl && 'DONNA_PG_TEST_URL required';

async function freshDb(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_owner_correction_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only', DATABASE_URL: url.toString() });
  t.after(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic correction firm',$1)", [firmId]);
  return pool;
}

const seedGb = async (pool, clientId) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Correction Ltd','gb',$3)", [clientId, firmId, { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash' }]);
  for (const flag of ['JURISDICTION_TAX_CODING', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  for (const a of GB_DEFAULT_CHART) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'GBP',$8,'active')",
    [ledgerRecordId('account', firmId, clientId, a.code), firmId, clientId, a.code, a.name_en, a.account_type, a.normal_balance, a.canonical_role || null]);
};
const seedFi = async (pool, clientId) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Korjaus Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash' }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
};
const FI = { label: 'FI', seed: seedFi, currency: 'EUR', gross: 125.5, tax: 25.5, field: 'alv_registration', language: 'fi',
  verdict: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' } };
const GB = { label: 'GB', seed: seedGb, currency: 'GBP', gross: 120, tax: 20, field: 'vat_registration', language: 'en',
  verdict: { proposed_account: 'Software subscriptions', tax_treatment: 'VAT 20%' } };

// The coder (OpenAI responses) returns `state.verdict` (or `state.coder(row)`);
// the owner-reply reader (Anthropic messages) returns `state.reading()`.
const mockModels = (t, state) => {
  state.reads = 0; state.codes = 0;
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    const url = String(endpoint);
    if (url === 'https://api.anthropic.com/v1/messages') {
      state.reads += 1;
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice?.name, 'interpret_owner_reply');
      const input = state.reading(JSON.parse(body.messages[0].content));
      return new Response(JSON.stringify({ model: READER_MODEL, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'interpret_owner_reply', input }] }), { status: 200 });
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    state.codes += 1;
    const input = JSON.parse(JSON.parse(init.body).input);
    const code = row => ({ transaction_id: row.id, confidence: 'high', evidence_required: false, auto_explain_limit: 5000,
      reasoning: 'The settled receipt supports the account.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '',
      ...(state.coder ? state.coder(row) : state.verdict) });
    // The reply coder codes one line; the batch coder a list.
    const output = input.transaction ? code(input.transaction) : { suggestions: input.transactions.map(code), group_summary: [] };
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify(output) }) };
  });
  return state;
};
const answerWith = (registered, from = null, until = null) => () =>
  ({ answer: { registered, registered_from: from, registered_until: until }, confidence: 0.97, clarification: null });

const addLine = async (pool, clientId, country, id, date = '2026-06-02') => {
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,'Synthetic office supplies',0,$5,$6,'needs_review','{}')", [id, firmId, clientId, date, country.gross, country.currency]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic receipt.pdf','receipt','completed',$4,$5,$6,$7,'{}')", [`doc-${id}`, firmId, clientId, country.gross, country.tax, country.currency, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')", [`match-${id}`, firmId, clientId, id, `doc-${id}`, country.gross]);
};
// Code, refuse, re-admit, ask: the registration question is on the owner.
const askRegistration = async (pool, clientId, country) => {
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, country, id);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: AUTO });
  const [ask] = (await pool.query("select * from client_evidence_requests where client_id=$1 and status in ('draft','open') and request_payload->>'lane'='tax_registration'", [clientId])).rows;
  assert.ok(ask, 'the registration question is on the owner');
  await pool.query("update client_evidence_requests set status='open' where id=$1 and status='draft'", [ask.id]);
  return { ask, lineId: id };
};
const answer = (askId, text) => resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: askId, reply: text, actorId: OWNER, actorType: 'client' });

const questionOf = async (pool, id) => (await pool.query('select status, resolved_at, response_payload from client_evidence_requests where id=$1', [id])).rows[0];
// The line as every reader sees it: coding and convergence, and the answer stamp.
const lineOf = async (pool, id) => {
  const row = (await pool.query(`select coding_state, convergence_state, convergence_reason, status, account_code,
    payload->'tax_registration_answer' as answer, payload->'ai_suggestion'->>'proposed_account' as proposed
    from transactions where id=$1`, [id])).rows[0];
  return { ...row, journals: (await pool.query('select count(*)::int n from ledger_journals where source_id=$1', [id])).rows[0].n };
};
const profileOf = async (pool, clientId) => (await pool.query('select profile from clients where id=$1', [clientId])).rows[0].profile;
const receipts = async (pool, clientId, action) => (await pool.query('select actor_id, actor_type, resource_id, metadata from audit_events where client_id=$1 and action=$2 order by id', [clientId, action])).rows;
const unreadReplies = async (pool, clientId) => (await pool.query(DISCOVER_OWNER_REPLIES_SQL, [firmId, 50, listStructuredOwnerReplyEvidenceTypes()])).rows.filter(row => row.client_id === clientId);

// ── The registration question: the reader takes the correction ────────────
for (const country of [FI, GB]) {
  test(`real PG (${country.label}): a correction to a recorded registration answer that would remove registered days records nothing; question, line and record stay as they were, with receipts`, { skip }, async t => {
    const pool = await freshDb(t);
    const clientId = `${country.label.toLowerCase()}-correction-conflict`;
    await country.seed(pool, clientId);
    const state = mockModels(t, { verdict: country.verdict, reading: answerWith('yes', '2026-01-01') });
    const { ask, lineId } = await askRegistration(pool, clientId, country);
    const first = 'Yes, registered since 2026-01-01.';
    await answer(ask.id, first);
    const closed = await questionOf(pool, ask.id);
    assert.equal(closed.status, 'resolved');
    const record = (await profileOf(pool, clientId))[country.field];
    assert.equal(record.registered_from, '2026-01-01');
    const before = await lineOf(pool, lineId);
    assert.equal(before.coding_state, 'proposed', 'the answer re-admitted the line to the coder');
    assert.equal(before.answer.state, 'recorded');

    // The owner corrects the answer: "actually it was from a later date".
    state.reading = answerWith('yes', '2026-04-01');
    const correction = 'Actually it was from a later date, 2026-04-01.';
    const result = await answer(ask.id, correction);
    assert.equal(state.reads, 2, 'the registration reader read the correction');

    const after = await questionOf(pool, ask.id);
    assert.equal(after.status, 'resolved', 'the question is closed again: nothing is asked of anyone');
    assert.deepEqual(await lineOf(pool, lineId), before, 'every line the question stood for is as it was');
    assert.deepEqual((await profileOf(pool, clientId))[country.field], record, 'the recorded registration is unchanged');
    assert.deepEqual(await unreadReplies(pool, clientId), [], 'no reply rests unread');

    const [received] = await receipts(pool, clientId, 'evidence_request.correction');
    assert.ok(received, 'the correction is receipted as one');
    assert.equal(received.resource_id, ask.id);
    assert.equal(received.actor_id, OWNER);
    assert.equal(received.metadata.reply, correction);
    assert.equal(received.metadata.earlier_reply, first);
    assert.equal(received.metadata.prior_status, 'resolved');
    assert.equal(received.metadata.reader, 'structured_owner_reply');
    assert.ok(received.metadata.responded_at && received.metadata.earlier_responded_at);
    assert.equal((await receipts(pool, clientId, 'evidence_request.reply')).length, 1, 'the first answer is the only plain reply receipt');
    const [refused] = await receipts(pool, clientId, 'tax_registration.owner_answer_not_recorded');
    assert.equal(refused.metadata.reason, 'conflicts_with_recorded_registration');
    assert.equal(refused.metadata.correction?.earlier_reply, first);
    const [restored] = await receipts(pool, clientId, 'evidence_request.correction_not_recorded');
    assert.equal(restored.resource_id, ask.id);
    assert.equal(restored.metadata.restored_status, 'resolved');
    assert.equal(after.response_payload.reply_processing.state, 'completed');
    assert.equal(after.response_payload.reply_processing.correction.outcome, 'not_recorded');
    // The owner is told the earlier answer stands, in their language.
    assert.equal(result.recode.correction?.outcome, 'not_recorded');
    assert.match(result.recode.owner_notice, country.language === 'fi' ? /aiemp/i : /earlier/i);
  });

  test(`real PG (${country.label}): a correction the registration reader records is written with its receipt and the question closes again`, { skip }, async t => {
    const pool = await freshDb(t);
    const clientId = `${country.label.toLowerCase()}-correction-recorded`;
    await country.seed(pool, clientId);
    const state = mockModels(t, { verdict: country.verdict, reading: answerWith('yes', '2026-03-01') });
    const { ask, lineId } = await askRegistration(pool, clientId, country);
    const first = 'Registered from 2026-03-01.';
    await answer(ask.id, first);
    const before = await lineOf(pool, lineId);
    assert.equal(before.coding_state, 'proposed');

    state.reading = answerWith('yes', '2025-06-01');
    const correction = 'Sorry, it was earlier: from 2025-06-01.';
    await answer(ask.id, correction);
    assert.equal((await profileOf(pool, clientId))[country.field].registered_from, '2025-06-01');
    const after = await questionOf(pool, ask.id);
    assert.equal(after.status, 'resolved');
    const recorded = await receipts(pool, clientId, 'tax_registration.owner_answer_recorded');
    assert.equal(recorded.length, 2);
    assert.equal(recorded[1].metadata.before.registered_from, '2026-03-01');
    assert.equal(recorded[1].metadata.after.registered_from, '2025-06-01');
    assert.equal(recorded[1].metadata.correction?.earlier_reply, first);
    const [received] = await receipts(pool, clientId, 'evidence_request.correction');
    assert.equal(received.metadata.reply, correction);
    assert.equal(received.metadata.earlier_reply, first);
    const line = await lineOf(pool, lineId);
    // Never backwards: the line was already with the coder, and stays there,
    // now stamped with the corrected answer.
    assert.equal(line.coding_state, before.coding_state);
    assert.equal(line.convergence_state, before.convergence_state);
    assert.equal(line.answer.state, 'recorded');
    assert.equal(line.answer.receipt_id, String((await pool.query("select id from audit_events where client_id=$1 and action='tax_registration.owner_answer_recorded' order by id desc limit 1", [clientId])).rows[0].id));
    assert.deepEqual(await unreadReplies(pool, clientId), []);
  });
}

test('real PG (FI): a correction after the line posted records nothing and the posted line is untouched', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-correction-posted';
  await FI.seed(pool, clientId);
  const state = mockModels(t, { verdict: FI.verdict, reading: answerWith('yes', '2026-01-01') });
  const { ask, lineId } = await askRegistration(pool, clientId, FI);
  await answer(ask.id, 'Kyllä, 1.1.2026 alkaen.');
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: lineId, env: {}, configSnapshot: AUTO });
  const before = await lineOf(pool, lineId);
  assert.equal(before.journals, 1, 'the line posted');
  state.reading = answerWith('yes', '2026-04-01');
  await answer(ask.id, 'Itse asiassa vasta 1.4.2026 alkaen.');
  assert.deepEqual(await lineOf(pool, lineId), before);
  assert.equal((await questionOf(pool, ask.id)).status, 'resolved');
  assert.equal((await receipts(pool, clientId, 'evidence_request.correction')).length, 1);
});

// ── An ordinary line question: the coder's reply path ─────────────────────
const ordinaryQuestion = async (pool, clientId, country, { codingState, earlier = 'It was printer paper.' }) => {
  const lineId = `${clientId}-line`;
  await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,coding_state,payload)
    values($1,$2,$3,'2026-06-02','Synthetic card payment',0,$4,$5,'needs_review',$6,'{}')`, [lineId, firmId, clientId, country.gross, country.currency, codingState]);
  const askId = `${clientId}-ask`;
  const respondedAt = '2026-06-05T10:00:00.000Z';
  await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,transaction_id,audience,evidence_type,question,status,request_payload,response_payload,responded_at,resolved_at,resolved_by)
    values($1,$2,$3,$4,'client','business_purpose','What was this card payment for?','resolved','{}'::jsonb,$5::jsonb,$6,$6,'system')`,
  [askId, firmId, clientId, lineId, JSON.stringify({ reply: earlier, responded_at: respondedAt, document_ids: [] }), respondedAt]);
  return { askId, lineId };
};
const auditCount = async (pool, clientId) => (await pool.query('select count(*)::int n from audit_events where client_id=$1', [clientId])).rows[0].n;

for (const country of [FI, GB]) {
  test(`real PG (${country.label}): a reply to a resolved ordinary line question whose line is finished has no reader; nothing is written`, { skip }, async t => {
    const pool = await freshDb(t);
    const clientId = `${country.label.toLowerCase()}-ordinary-finished`;
    await country.seed(pool, clientId);
    const state = mockModels(t, { verdict: country.verdict, reading: answerWith('unclear') });
    const { askId, lineId } = await ordinaryQuestion(pool, clientId, country, { codingState: 'posted' });
    const question = await questionOf(pool, askId);
    const line = await lineOf(pool, lineId);
    const audits = await auditCount(pool, clientId);
    await assert.rejects(answer(askId, 'Actually that was a gift for a client.'), (error) => error.code === 'EVIDENCE_REQUEST_CLOSED_NOT_CORRECTABLE' && error.statusCode === 409);
    assert.deepEqual(await questionOf(pool, askId), question, 'the question is not reopened');
    assert.deepEqual(await lineOf(pool, lineId), line);
    assert.equal(await auditCount(pool, clientId), audits, 'nothing is receipted because nothing changed');
    assert.equal(state.codes + state.reads, 0, 'no model was called');
    assert.deepEqual(await unreadReplies(pool, clientId), []);
  });
}

test('real PG (GB): a correction to a resolved ordinary line question whose line is still with the coder is read by the coder and applied', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-ordinary-correction';
  await GB.seed(pool, clientId);
  const state = mockModels(t, { verdict: { proposed_account: 'Marketing', tax_treatment: 'VAT exempt' } });
  const { askId, lineId } = await ordinaryQuestion(pool, clientId, GB, { codingState: 'proposed' });
  const correction = 'Correction: it was a client gift, not printer paper.';
  const result = await answer(askId, correction);
  assert.equal(state.codes, 1, 'the coder read the correction');
  assert.equal(result.recode?.applied, true, JSON.stringify(Object.fromEntries(Object.entries(result.recode?.suggestion || result.recode || {}).filter(([k]) => !['coding_policy'].includes(k)))).slice(0, 1500));
  const question = await questionOf(pool, askId);
  assert.equal(question.status, 'resolved');
  const line = await lineOf(pool, lineId);
  assert.ok(['applied', 'posted'].includes(line.coding_state), line.coding_state);
  assert.equal(line.proposed, 'Marketing');
  const [received] = await receipts(pool, clientId, 'evidence_request.correction');
  assert.equal(received.metadata.reader, 'coder_reply');
  assert.equal(received.metadata.earlier_reply, 'It was printer paper.');
  assert.equal(received.metadata.reply, correction);
  const [recode] = await receipts(pool, clientId, 'transaction.reply_recode');
  assert.equal(recode.metadata.applied, true);
  assert.equal(recode.metadata.correction?.earlier_reply, 'It was printer paper.');
  assert.deepEqual(await unreadReplies(pool, clientId), []);
});

test('real PG (FI): a correction the coder cannot settle leaves the line and the question as they were', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-ordinary-unsettled';
  await FI.seed(pool, clientId);
  const state = mockModels(t, { coder: () => ({ ...FI.verdict, confidence: 'low', evidence_required: true, ask_client_question: 'Could you send the receipt?' }) });
  const { askId, lineId } = await ordinaryQuestion(pool, clientId, FI, { codingState: 'proposed' });
  const question = await questionOf(pool, askId);
  const line = await lineOf(pool, lineId);
  await answer(askId, 'Hmm, maybe it was something else.');
  assert.equal(state.codes, 1);
  const after = await questionOf(pool, askId);
  assert.equal(after.status, question.status);
  assert.equal(after.response_payload.reply_processing.correction.outcome, 'not_recorded');
  assert.deepEqual(await lineOf(pool, lineId), line, 'nothing the coder could not settle moves the line');
  assert.equal((await receipts(pool, clientId, 'evidence_request.correction_not_recorded')).length, 1);
  assert.deepEqual(await unreadReplies(pool, clientId), []);
});

// ── A chat channel: a quote-reply to Donna's notice reaches the question ──
const binding = (clientId, phone) => ({ id: `binding-${clientId}`, client_id: clientId, collaborator_id: 'owner-collab', phone_hash: hashPhoneE164(phone), phone_e164: phone });
const whatsapp = ({ clientId, phone, message, texts, ids, deps = {} }) => processWhatsAppInboundMessage({ from: phone, firmId,
  env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: clientId, WHATSAPP_ACCESS_TOKEN: 'token' }, message,
  deps: {
    getBindingsByPhoneHash: async () => [binding(clientId, phone)],
    loadClientConfigSnapshot: async () => null,
    getOwnerLanguage: async () => 'en',
    appendClientPortalChatMessage: async (args) => args,
    sendText: async (args) => { texts.push(args.text); return { ok: true, id: ids.shift() || null }; },
    ...deps
  } });

test('real PG (GB): on WhatsApp a quote-reply to Donna\'s "reply here" notice reaches the question as a correction', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-whatsapp-correction';
  await GB.seed(pool, clientId);
  const state = mockModels(t, { verdict: GB.verdict, reading: answerWith('yes', '2026-01-01') });
  const { ask, lineId } = await askRegistration(pool, clientId, GB);
  // The question went out on WhatsApp: its delivery is in the ledger.
  await pool.query(`insert into message_delivery_ledger(id,message_id,channel,provider,ask_id,client_id,sent_at,provider_payload)
    values('ledger-question','wamid.question','whatsapp','meta',$1,$2,now(),'{}')`, [ask.id, clientId]);
  const phone = '+447700900321';
  const texts = []; const ids = ['wamid.notice-1', 'wamid.notice-2'];
  const answered = await whatsapp({ clientId, phone, texts, ids,
    message: { id: 'wamid.owner-answer', type: 'text', text: { body: 'Yes, registered since 2026-01-01.' }, context: { id: 'wamid.question' } } });
  assert.equal(answered.status, 'resolved', JSON.stringify(answered).slice(0, 300));
  assert.match(texts[0], /Reply here if that is not right\.$/);
  const notice = (await pool.query("select ask_id, client_id from message_delivery_ledger where provider='meta' and message_id='wamid.notice-1'")).rows[0];
  assert.deepEqual(notice, { ask_id: ask.id, client_id: clientId }, 'the notice is in the delivery ledger, tied to its question');
  const before = await lineOf(pool, lineId);
  const record = (await profileOf(pool, clientId)).vat_registration;

  state.reading = answerWith('yes', '2026-04-01');
  const corrected = await whatsapp({ clientId, phone, texts, ids,
    message: { id: 'wamid.owner-correction', type: 'text', text: { body: 'Actually it was from a later date, 2026-04-01.' }, context: { id: 'wamid.notice-1' } } });
  assert.equal(corrected.askId, ask.id, 'anchored to the question the notice was about');
  assert.equal(state.reads, 2);
  assert.equal((await questionOf(pool, ask.id)).status, 'resolved');
  assert.deepEqual(await lineOf(pool, lineId), before);
  assert.deepEqual((await profileOf(pool, clientId)).vat_registration, record);
  const [received] = await receipts(pool, clientId, 'evidence_request.correction');
  assert.equal(received.metadata.reply, 'Actually it was from a later date, 2026-04-01.');
  assert.match(texts.at(-1), /earlier/i, 'the owner is told the earlier answer stands');
});

test('real PG (FI): on WhatsApp a quote-reply to a closed question no reader can take is read as a new message, and the owner is told so', { skip }, async t => {
  const pool = await freshDb(t);
  const clientId = 'fi-whatsapp-closed';
  await FI.seed(pool, clientId);
  mockModels(t, { verdict: FI.verdict, reading: answerWith('unclear') });
  const { askId, lineId } = await ordinaryQuestion(pool, clientId, FI, { codingState: 'posted' });
  await pool.query(`insert into message_delivery_ledger(id,message_id,channel,provider,ask_id,client_id,sent_at,provider_payload)
    values('ledger-old','wamid.old-question','whatsapp','meta',$1,$2,now(),'{}')`, [askId, clientId]);
  const question = await questionOf(pool, askId);
  const line = await lineOf(pool, lineId);
  const phone = '+358401234567';
  const texts = []; const ids = [];
  const result = await whatsapp({ clientId, phone, texts, ids,
    message: { id: 'wamid.late', type: 'text', text: { body: 'Muuten, se olikin lahja asiakkaalle.' }, context: { id: 'wamid.old-question' } },
    deps: { getOwnerLanguage: async () => 'fi' } });
  assert.deepEqual(await questionOf(pool, askId), question, 'the closed question is not reopened');
  assert.deepEqual(await lineOf(pool, lineId), line);
  assert.equal((await receipts(pool, clientId, 'evidence_request.correction')).length, 0);
  // Read as a new message through the existing unanchored chat path (general
  // chat is not staged for this client, so that path ends in its nudge).
  assert.equal(result.closed_question, askId, JSON.stringify(result).slice(0, 300));
  assert.equal(result.status, 'nudged');
  assert.equal(result.reason, 'closed_question');
  assert.match(texts[0], /suljettu/i, 'the owner is told, in Finnish, that it was read as a new message');
  assert.equal(texts.length, 2, 'the notice, then the chat path\'s own reply');
});
