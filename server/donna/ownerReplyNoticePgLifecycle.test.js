// Real PG (FI and GB, synthetic data): the owner answers a question in the
// client portal and is shown, on that answered question, what Donna did with
// the answer. The owner answers the VAT/ALV registration question through the
// portal's own reply route while the reader is unavailable, the owner-reply
// worker reads the answer later, and the route the portal reads (the
// owner-scoped snapshot) returns the stored line for that question, in the
// owner's language and without an invitation to a reply the closed question
// does not have (ownerReplyNotice.js). The same holds for an answer that
// records nothing (the record is locked, or the answer conflicts with it), for
// any lane adapter that returns a notice (a test adapter here), and a chat
// channel still speaks the line once, in-band, and sends nothing else.
//   DONNA_PG_TEST_URL=... node --test server/donna/ownerReplyNoticePgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests, batchSuggestTransactionCodingInDb, resolveClientEvidenceRequestInDb, seedPackPaletteChartWithClient } from './firmDb.js';
import { installConvergenceSettleOnPool } from './reconcileConvergenceState.js';
import { recoverChangedCodingEvidenceInDb } from './db/codingEvidence.js';
import { runCodingAutoPostForTransaction } from './codingAutoPost.js';
import { recoverOwnerRepliesInDb } from './ownerReplyRecovery.js';
import { processStructuredOwnerReplyWithClient } from './structuredOwnerReply.js';
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
import { ownerNoticeStatementOf } from './ownerReplyNotice.js';
import { requestDonnaApi } from './testSupport/apiSeamHarness.js';
import { buildResolvedReplyText } from './channels/inboundCore.js';
import { processWhatsAppInboundMessage } from './channels/whatsappInbound.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';
import { GB_DEFAULT_CHART } from './gb/defaultChart.js';
import { ledgerRecordId } from './db/shared.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'owner-notice-proof';
const OWNER = 'owner@example.test';
const AUTH_HOST = 'https://owner-notice-auth.test';
const READER_MODEL = 'recorded-strong-owner-reader';
const AUTO = { CODING_AUTO_POST: { stage: 'auto' } };

async function freshDb(t) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_owner_notice_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  installConvergenceSettleOnPool(pool); __setFirmDbPoolForTests(pool);
  const keys = ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DATABASE_URL', 'DONNA_ACCESS_TOKEN', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'DONNA_AUTH_ALLOWED_EMAILS'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { OPENAI_API_KEY: 'fixture-only', ANTHROPIC_API_KEY: 'fixture-only', DATABASE_URL: url.toString(),
    DONNA_ACCESS_TOKEN: 'fixture-token', SUPABASE_URL: AUTH_HOST, SUPABASE_PUBLISHABLE_KEY: 'fixture', DONNA_AUTH_ALLOWED_EMAILS: '' });
  t.after(async () => {
    for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    __resetFirmDbPoolForTests(); await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}"`); await admin.end();
  });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(n => n.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic notice firm',$1)", [firmId]);
  await pool.query("insert into firm_collaborators(id,firm_id,email,name,role) values('owner-collab',$1,$2,'Synthetic owner','owner')", [firmId, OWNER]);
  return pool;
}

// The owner may see only their own client.
const assignOwner = (pool, clientId) => pool.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role)
  values($1,$2,$3,'firm_collaborator','owner-collab','owner')`, [`assign-${clientId}`, firmId, clientId]);
const seedGb = async (pool, clientId, profile = {}) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Notice Ltd','gb',$3)", [clientId, firmId, { jurisdiction: 'gb', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const flag of ['JURISDICTION_TAX_CODING', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  for (const a of GB_DEFAULT_CHART) await pool.query("insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,normal_balance,currency,canonical_role,status) values($1,$2,$3,$4,$5,$6,$7,'GBP',$8,'active')",
    [ledgerRecordId('account', firmId, clientId, a.code), firmId, clientId, a.code, a.name_en, a.account_type, a.normal_balance, a.canonical_role || null]);
  await assignOwner(pool, clientId);
};
const seedFi = async (pool, clientId, profile = { alv_registration: { status: 'not_registered' } }) => {
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Ilmoitus Oy','FI','fi-oy',$3)", [clientId, firmId,
    { jurisdiction: 'FI', accounting_system: 'none', accounting_basis: 'cash', ...profile }]);
  for (const flag of ['FINLAND_ALV_CODING', 'JURISDICTION_ACCOUNT_PALETTE', 'RECONCILIATION_CODE_MATCHED_NO_REVIEW', 'CODING_AUTO_POST', 'LEDGER_AUTO_POST']) await pool.query("insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source) values($1,$2,$3,$4,'auto','manual')", [`${clientId}-${flag}`, firmId, clientId, flag]);
  await seedPackPaletteChartWithClient(pool, { firmId, clientId });
  await assignOwner(pool, clientId);
};
const FI = { currency: 'EUR', gross: 125.5, tax: 25.5, field: 'alv_registration', verdict: { proposed_account: 'Office expenses', tax_treatment: 'ALV 25,5 %' } };
const GB = { currency: 'GBP', gross: 120, tax: 20, field: 'vat_registration', verdict: { proposed_account: 'Software subscriptions', tax_treatment: 'VAT 20%' } };

// The providers: the owner's session (auth), the coder (OpenAI responses) and
// the owner-reply reader (Anthropic messages), which can be down.
const mockProviders = (t, state) => {
  t.mock.method(globalThis, 'fetch', async (endpoint, init) => {
    const url = String(endpoint);
    if (url === `${AUTH_HOST}/auth/v1/user`) return new Response(JSON.stringify({ id: 'owner-user', email: OWNER }), { status: 200 });
    if (url === 'https://api.anthropic.com/v1/messages') {
      state.reads += 1;
      if (state.readerDown) return new Response(JSON.stringify({ error: { message: 'recorded temporary outage' } }), { status: 503 });
      const body = JSON.parse(init.body);
      assert.equal(body.tool_choice?.name, 'interpret_owner_reply');
      const input = state.reading(JSON.parse(body.messages[0].content));
      return new Response(JSON.stringify({ model: READER_MODEL, stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'interpret_owner_reply', input }] }), { status: 200 });
    }
    assert.equal(url, 'https://api.openai.com/v1/responses');
    const input = JSON.parse(JSON.parse(init.body).input);
    const suggestions = input.transactions.map(row => ({ transaction_id: row.id, ...state.verdict, confidence: 'high', evidence_required: false, auto_explain_limit: 5000,
      reasoning: 'The settled receipt supports the account and its printed VAT.', posting_requirement: 'single_account', document_allocations: [], ask_client_question: '' }));
    return { ok: true, status: 200, json: async () => ({ output_text: JSON.stringify({ suggestions, group_summary: [] }) }) };
  });
};
const answerWith = (registered, from = null, until = null) => () =>
  ({ answer: { registered, registered_from: from, registered_until: until }, confidence: 0.97, clarification: null });

const addLine = async (pool, clientId, country, id, date = '2026-06-02') => {
  await pool.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_in,money_out,currency,status,payload) values($1,$2,$3,$4,'Synthetic office supplies',0,$5,$6,'needs_review','{}')", [id, firmId, clientId, date, country.gross, country.currency]);
  await pool.query("insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,tax_amount,currency,document_date,payload) values($1,$2,$3,'Synthetic receipt.pdf','receipt','completed',$4,$5,$6,$7,'{}')", [`doc-${id}`, firmId, clientId, country.gross, country.tax, country.currency, date]);
  await pool.query("insert into reconciliation_matches(id,firm_id,client_id,bank_transaction_id,matched_object_type,matched_object_id,match_amount,match_confidence,status,created_by,payload) values($1,$2,$3,$4,'receipt',$5,$6,.98,'auto_matched','fixture','{}')", [`match-${id}`, firmId, clientId, id, `doc-${id}`, country.gross]);
};
// Code, refuse, re-admit, ask: the registration question is on the owner.
const askRegistration = async (pool, clientId, country, date) => {
  const id = `${clientId}-purchase`;
  await addLine(pool, clientId, country, id, date);
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await recoverChangedCodingEvidenceInDb({ firmId });
  await batchSuggestTransactionCodingInDb({ firmId, clientIds: [clientId] });
  await runCodingAutoPostForTransaction({ firmId, clientId, transactionId: id, env: {}, configSnapshot: AUTO });
  const [ask] = (await pool.query("select * from client_evidence_requests where client_id=$1 and status in ('draft','open') and request_payload->>'lane'='tax_registration'", [clientId])).rows;
  assert.ok(ask, 'the registration question is on the owner');
  await pool.query("update client_evidence_requests set status='open' where id=$1 and status='draft'", [ask.id]);
  return ask;
};

// The portal's own routes, as the owner.
const asOwner = async (pool, request) => {
  const response = await requestDonnaApi({ pool, headers: { authorization: 'Bearer owner-session' }, ...request });
  __setFirmDbPoolForTests(pool);
  assert.ok(response.statusCode >= 200 && response.statusCode < 300, `${request.url} → ${response.statusCode}: ${JSON.stringify(response.json).slice(0, 400)}`);
  return response.json;
};
const portalReply = (pool, askId, reply) => asOwner(pool, { method: 'POST', url: `/api/donna/firms/evidence/requests/${encodeURIComponent(askId)}/resolve`,
  body: { firm_id: firmId, reply, resolution_note: 'Client replied from portal.' } });
const portalRead = async (pool, askId) => {
  const snapshot = await asOwner(pool, { method: 'GET', url: `/api/donna/firms/snapshot?firm_id=${firmId}` });
  assert.equal(snapshot.workspaceAccess?.surface, 'owner', 'the owner-scoped read');
  return snapshot.clientEvidenceRequests.find(request => request.id === askId) || null;
};

const RECORDED = {
  FI: { line: 'Kirjasimme, että yritys on arvonlisäverorekisterissä 2026-01-01 alkaen. Vastaa tähän, jos tieto ei ole oikein.',
    statement: 'Kirjasimme, että yritys on arvonlisäverorekisterissä 2026-01-01 alkaen.' },
  GB: { line: 'We recorded that the business has been VAT-registered since 2026-01-01. Reply here if that is not right.',
    statement: 'We recorded that the business has been VAT-registered since 2026-01-01.' }
};

for (const [label, country, seed, clientId] of [['FI', FI, seedFi, 'fi-portal-owner'], ['GB', GB, seedGb, 'gb-portal-owner']]) {
  test(`real PG (${label}): a portal answer read later by the worker shows the stored line on the answered question, in the owner's language`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    await seed(pool, clientId);
    const state = { reads: 0, readerDown: false, verdict: country.verdict, reading: answerWith('yes', '2026-01-01') };
    mockProviders(t, state);
    const ask = await askRegistration(pool, clientId, country);
    // The owner answers in the portal while the reader is down: the answer is saved and waits.
    state.readerDown = true;
    const saved = await portalReply(pool, ask.id, 'Yes, registered since 2026-01-01.');
    assert.equal(saved.evidence_request.status, 'replied');
    const waiting = (await pool.query('select status,response_payload from client_evidence_requests where id=$1', [ask.id])).rows[0];
    assert.equal(waiting.status, 'replied');
    assert.equal(waiting.response_payload.reply_processing.state, 'retry_pending', 'the answer is saved and waits for the worker');
    assert.equal(ownerNoticeStatementOf(await portalRead(pool, ask.id)), null, 'nothing to show before the answer is read');
    // Later, the worker reads it.
    state.readerDown = false;
    const [worked] = await recoverOwnerRepliesInDb({ firmId });
    assert.equal(worked.evidence_request_id, ask.id);
    assert.equal(worked.applied, true, JSON.stringify(worked));
    // The route the portal reads returns the stored line for that question.
    const read = await portalRead(pool, ask.id);
    assert.equal(read.status, 'resolved');
    assert.equal(read.response_payload.owner_notice, RECORDED[label].line, 'the channel line is kept as it was');
    assert.equal(read.response_payload.owner_notice_statement, RECORDED[label].statement);
    assert.equal(read.response_payload.owner_notice_reply_key, ownerReplyIdentity(read));
    assert.equal(ownerNoticeStatementOf(read), RECORDED[label].statement, 'what the portal renders');
    // The receipt still carries the line it recorded.
    const receipt = (await pool.query("select metadata from audit_events where client_id=$1 and action='tax_registration.owner_answer_recorded'", [clientId])).rows[0];
    assert.equal(receipt.metadata.owner_notice, RECORDED[label].line);
  });
}

const NOT_RECORDED = {
  FI: 'Vastauksesi on tallennettu, mutta emme muuttaneet yrityksen arvonlisäverorekisteröinnistä olevaa tietoa. Kirjanpitäjän on tarkistettava asia ennen kuin tietoa muutetaan.',
  GB: 'Your answer is saved, but we did not change the VAT registration details we hold for the business. Your accountant needs to check it before the record is changed.'
};
for (const item of [
  { label: 'FI', name: 'a locked record (prepared client)', state: 'record_locked', country: FI, seed: seedFi, clientId: 'fi-portal-locked',
    prepare: pool => pool.query("insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata) values($1,'fi-portal-locked','system','fixture','pilot.prepared','client','fi-portal-locked','{}')", [firmId]),
    reading: answerWith('yes', '2026-01-01') },
  { label: 'GB', name: 'an answer that conflicts with the record', state: 'record_conflict', country: GB, clientId: 'gb-portal-conflict',
    seed: (pool, id) => seedGb(pool, id, { vat_registration: { status: 'registered', registered_from: '2026-03-01' } }), date: '2026-02-10',
    reading: answerWith('yes', '2026-04-01') }
]) {
  test(`real PG (${item.label}): ${item.name} records nothing; the portal says so, never that it was recorded`, { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
    const pool = await freshDb(t);
    await item.seed(pool, item.clientId);
    if (item.prepare) await item.prepare(pool);
    const before = (await pool.query('select profile from clients where id=$1', [item.clientId])).rows[0].profile[item.country.field];
    const state = { reads: 0, readerDown: false, verdict: item.country.verdict, reading: item.reading };
    mockProviders(t, state);
    const ask = await askRegistration(pool, item.clientId, item.country, item.date);
    const answered = await portalReply(pool, ask.id, 'Synthetic owner answer.');
    assert.equal(answered.recode.drivenAction, `tax_registration_${item.state}`);
    assert.deepEqual((await pool.query('select profile from clients where id=$1', [item.clientId])).rows[0].profile[item.country.field], before, 'nothing recorded');
    const read = await portalRead(pool, ask.id);
    assert.equal(read.status, 'replied', 'the question rests answered, with a person');
    assert.equal(read.response_payload.reply_processing.state, 'completed');
    assert.equal(ownerNoticeStatementOf(read), NOT_RECORDED[item.label]);
    assert.doesNotMatch(ownerNoticeStatementOf(read), /recorded that|Kirjasimme/);
    // A channel reply would say the same line in-band.
    assert.equal(buildResolvedReplyText({ resolved: { evidence_request: read, recode: answered.recode }, fallback: 'x' }), NOT_RECORDED[item.label]);
  });
}

test('real PG: any lane adapter that returns a notice gets it kept and shown the same way (a test adapter)', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-test-adapter';
  await seedGb(pool, clientId);
  const state = { reads: 0, readerDown: false, verdict: GB.verdict, reading: () => ({ answer: { opening_cash: '250.00' }, confidence: 0.98, clarification: null }) };
  mockProviders(t, state);
  await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,status,audience,evidence_type,question,request_payload)
    values('ask-synthetic-fact',$1,$2,'open','client','synthetic_fact','How much cash was in the till on 1 January?','{"lane":"synthetic_fact"}')`, [firmId, clientId]);
  // The ordinary reply writer saves the answer (no registered consumer claims this type).
  await resolveClientEvidenceRequestInDb({ firmId, evidenceRequestId: 'ask-synthetic-fact', reply: 'About 250 pounds.', actorId: OWNER, actorType: 'client' });
  const request = (await pool.query("select * from client_evidence_requests where id='ask-synthetic-fact'")).rows[0];
  assert.equal(request.status, 'replied');
  const adapter = { evidenceType: 'synthetic_fact', action: 'record_synthetic_fact', instructions: 'Read the opening cash amount.',
    answerSchema: { type: 'object', additionalProperties: false, required: ['opening_cash'], properties: { opening_cash: { type: 'string' } } },
    validateAnswer: answer => typeof answer?.opening_cash === 'string',
    apply: async ({ client, firmId: firm, request: current, actorId }) => {
      await client.query("update client_evidence_requests set status='resolved', resolved_at=now(), resolved_by=$3 where firm_id=$1 and id=$2", [firm, current.id, actorId]);
      return { recorded: true, owner_notice: 'We recorded 250.00 as the opening cash. Reply here if that is not right.',
        owner_notice_statement: 'We recorded 250.00 as the opening cash.' };
    } };
  const client = await pool.connect();
  let outcome;
  try {
    outcome = await processStructuredOwnerReplyWithClient({ client, firmId, request, expectedReplyKey: ownerReplyIdentity(request),
      env: { ANTHROPIC_API_KEY: 'fixture-only' }, resolveAdapter: () => adapter });
  } finally { client.release(); }
  assert.equal(outcome.applied, true);
  const read = await portalRead(pool, 'ask-synthetic-fact');
  assert.equal(read.response_payload.owner_notice_statement, 'We recorded 250.00 as the opening cash.');
  assert.equal(ownerNoticeStatementOf(read), 'We recorded 250.00 as the opening cash.');
  assert.equal(buildResolvedReplyText({ resolved: { evidence_request: read, recode: outcome }, fallback: 'x' }),
    'We recorded 250.00 as the opening cash. Reply here if that is not right.');
});

test('real PG (GB): a WhatsApp answer speaks the line once, in-band, and sends nothing else', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const pool = await freshDb(t);
  const clientId = 'gb-whatsapp-owner';
  await seedGb(pool, clientId);
  const state = { reads: 0, readerDown: false, verdict: GB.verdict, reading: answerWith('yes', '2026-01-01') };
  mockProviders(t, state);
  const ask = await askRegistration(pool, clientId, GB);
  const phone = '+447700900456';
  const texts = [];
  const result = await processWhatsAppInboundMessage({ from: phone, firmId,
    env: { WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: clientId, WHATSAPP_ACCESS_TOKEN: 'token' },
    message: { id: 'wamid.owner-answer', type: 'text', text: { body: 'Yes, registered since 2026-01-01.' }, context: { id: 'wamid.question' } },
    deps: {
      getBindingsByPhoneHash: async () => [{ id: 'binding-1', client_id: clientId, collaborator_id: 'owner-collab', phone_hash: hashPhoneE164(phone), phone_e164: phone }],
      getDeliveryByMessageId: async ({ messageId }) => messageId === 'wamid.question' ? { ask_id: ask.id, client_id: clientId } : null,
      loadClientConfigSnapshot: async () => null,
      getOwnerLanguage: async () => 'en',
      claimInboundMessage: async () => ({ claimed: true }),
      recordLedger: async ({ entry }) => entry,
      appendClientPortalChatMessage: async (args) => args,
      sendText: async (args) => { texts.push(args.text); return { ok: true }; }
    } });
  assert.equal(result.status, 'resolved', JSON.stringify(result).slice(0, 400));
  assert.deepEqual(texts, [RECORDED.GB.line], 'spoken once, in-band');
  assert.equal(result.result.recode.follow_up_delivery, undefined, 'no follow-up send');
  const outbound = (await pool.query("select count(*)::int n from message_delivery_ledger where client_id=$1", [clientId])).rows[0].n;
  assert.equal(outbound, 0, 'no other delivery to the owner');
  // The answered question keeps the same line as its record (the portal shows its statement, a record, not a message).
  const read = await portalRead(pool, ask.id);
  assert.equal(read.response_payload.owner_notice, RECORDED.GB.line);
  assert.equal(ownerNoticeStatementOf(read), RECORDED.GB.statement);
});
