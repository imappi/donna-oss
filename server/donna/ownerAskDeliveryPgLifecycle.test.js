// Every message to a business owner goes through ONE gated fan-out, and a
// "sent" stamp always means a delivery. Real PostgreSQL, real writers, the real
// fan-out and the real email deliverer; only the provider (Resend / the model
// endpoint) is a fixture behind global fetch. Synthetic data only.
//
//   1. Rejecting evidence: the follow-up is DELIVERED through the fan-out and
//      only the deliverer moves send_count / last_sent_at; the writer's
//      fallback question follows the owner's language; nobody reachable ⇒
//      escalated 'owner_unreachable' with no stamp moved.
//   2. A document-only reply that needs clarification: the clarification ask
//      is delivered through the same fan-out by the owner-reply clock.
//   3. A send-contained client gets nothing from the rejection follow-up, the
//      operator resend, the re-ask sweep or the evidence-topic sweep; nothing
//      is counted and every refusal is receipted; an uncontained neighbour is
//      still delivered.
//   4. A deliverer skips an ask that is no longer awaiting the owner, and says so.
//   5. A delivered reminder whose re-arm write fails is not sent again.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  __setFirmDbPoolForTests, __resetFirmDbPoolForTests, rejectClientEvidenceRequestInDb,
  resendClientEvidenceRequestInDb, resolveClientEvidenceRequestInDb
} from './firmDb.js';
import { deliverEmailEvidenceAsksAfterSend } from './db/channels.js';
import { runAskReaskSweep } from './askReaskCadence.js';
import { runEvidenceTopicReminderSweep } from './channels/evidenceTopicReminders.js';
import { HOSTED_PILOT_VERSION } from './internalPilotAccess.js';
import { OWNER_SEND_REFUSED_ACTION } from './ownerAskDelivery.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const FIRM = 'firm-owner-send';

test('owner asks: one gated fan-out, honest send stamps, on every path', { skip: !pgUrl && 'DONNA_PG_TEST_URL not set' }, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_owner_send_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const prior = { RESEND_API_KEY: process.env.RESEND_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.RESEND_API_KEY = 'test-resend-key'; process.env.ANTHROPIC_API_KEY = 'test-model-key';
  t.after(async () => {
    __resetFirmDbPoolForTests();
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}" with (force)`); await admin.end();
  });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Example Accounting','owner-send')", [FIRM]);

  let flagN = 0;
  const flag = (clientId, flagKey, { stage = 'canary', reason = 'synthetic owner-send test' } = {}) => pool.query(
    `insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id)
     values($1,$2,$3,$4,$5,'manual',$6,'firm_member','op')`, [`flag-${++flagN}`, FIRM, clientId, flagKey, stage, reason]);
  const seedClient = async (id, { email = null, fi = false, flags = [], contained = false } = {}) => {
    const profile = { ...(email ? { email } : {}), ...(fi ? { jurisdiction: 'FI' } : {}) };
    await pool.query('insert into clients(id,firm_id,company_name,profile) values($1,$2,$3,$4::jsonb)', [id, FIRM, `Synthetic ${id} Oy`, JSON.stringify(profile)]);
    for (const key of flags) await flag(id, key);
    if (contained) await flag(id, 'INTERNAL_PILOT_ACCESS', { reason: HOSTED_PILOT_VERSION });
  };
  // A genuinely sent ask: its stamps are backed by a ledger receipt (147).
  const seedAsk = async (id, clientId, { status = 'open', question = 'Who was the 120 EUR transfer to?', lastSentDaysAgo = 10, dueDaysAgo = 3, reply = null, payload = {} } = {}) => {
    await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload,response_payload,audience,send_count,first_sent_at,last_sent_at,due_at,created_by)
      values($1,$2,$3,$4,'supporting_document',$5,$6::jsonb,$7::jsonb,'client',1,now()-($8||' days')::interval,now()-($8||' days')::interval,now()-($9||' days')::interval,'ask_batch')`,
    [id, FIRM, clientId, status, question, JSON.stringify(payload), JSON.stringify(reply ? { reply, responded_at: new Date().toISOString() } : {}), String(lastSentDaysAgo), String(dueDaysAgo)]);
    await pool.query(`insert into message_delivery_ledger(id,message_id,channel,provider,ask_id,client_id,template_name,sent_at)
      values($1,$1,'email','resend',$2,$3,'donna_evidence_ask_email_v1',now()-($4||' days')::interval)`, [`seed-${id}`, id, clientId, String(lastSentDaysAgo)]);
  };
  const ask = async id => (await pool.query('select * from client_evidence_requests where id=$1', [id])).rows[0];
  const receipts = async id => (await pool.query('select count(*)::int n from message_delivery_ledger where ask_id=$1 and sent_at is not null', [id])).rows[0].n;
  const refusals = async clientId => (await pool.query('select metadata from audit_events where client_id=$1 and action=$2 order by id', [clientId, OWNER_SEND_REFUSED_ACTION])).rows.map(r => r.metadata);
  // 147's law, checked directly: a sent state only with a channel receipt.
  const assertHonestStamps = async () => {
    const liars = (await pool.query(`select r.id from client_evidence_requests r
      where (r.send_count > 0 or r.last_sent_at is not null or r.first_sent_at is not null)
        and not exists (select 1 from message_delivery_ledger l where l.ask_id = r.id and l.sent_at is not null)`)).rows;
    assert.deepEqual(liars, [], 'no sent stamp without a delivery receipt');
  };

  const emails = [];
  let model = null;
  t.mock.method(globalThis, 'fetch', async (endpoint, options = {}) => {
    if (endpoint === 'https://api.resend.com/emails') {
      const body = JSON.parse(options.body);
      emails.push(body);
      return { ok: true, status: 200, json: async () => ({ id: `email-${emails.length}` }) };
    }
    if (endpoint === 'https://api.anthropic.com/v1/messages' && model) {
      return { ok: true, status: 200, json: async () => ({ id: 'msg-1', type: 'message', role: 'assistant', model: 'fixture-model',
        content: [{ type: 'text', text: JSON.stringify(model) }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0 } }) };
    }
    throw new Error(`no external transport in this proof: ${endpoint}`);
  });

  await seedClient('c-open', { email: 'owner-open@example.test', flags: ['OWNER_EMAIL_ASKS'] });
  await seedClient('c-fi', { email: 'omistaja@example.test', fi: true, flags: ['OWNER_EMAIL_ASKS'] });
  await seedClient('c-dark');
  await seedClient('c-con', { email: 'owner-con@example.test', flags: ['OWNER_EMAIL_ASKS', 'ASK_REASK_CADENCE'], contained: true });

  // ── 1. Reject: the follow-up is a real delivery ──────────────────────────
  await t.test('1. rejecting evidence delivers the follow-up; only the deliverer stamps; owner-language fallback; nobody reachable escalates', async () => {
    await seedAsk('ask-reject', 'c-open', { status: 'replied', reply: 'Here is the order confirmation.' });
    const rejected = await rejectClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: 'ask-reject',
      rejectionReason: 'Order confirmation, not an invoice.', followUpQuestion: 'Please send the invoice itself, not the order confirmation.', actorId: 'reviewer-1' });
    assert.deepEqual(rejected.follow_up_delivery.delivered, ['ask-reject'], JSON.stringify(rejected.follow_up_delivery));
    assert.equal(emails.length, 1, 'one follow-up email');
    assert.deepEqual(emails[0].to, ['owner-open@example.test']);
    assert.match(emails[0].text, /Please send the invoice itself/);
    let row = await ask('ask-reject');
    assert.equal(row.status, 'open');
    assert.equal(row.send_count, 2, 'moved once, by the deliverer');
    assert.equal(await receipts('ask-reject'), 2, 'the seed receipt + the follow-up receipt');
    assert.equal(rejected.evidence_request.send_count, 2, 'the writer reports the delivered state');

    // Fallback question in the owner's language; English unchanged.
    await seedAsk('ask-fi', 'c-fi', { status: 'replied', question: '', reply: 'Liitteenä kuva.' });
    await rejectClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: 'ask-fi', actorId: 'reviewer-1' });
    assert.equal((await ask('ask-fi')).question, 'Lähetäthän vielä tähän liittyvän tositteen.');
    assert.match(emails.at(-1).text, /Lähetäthän vielä tähän liittyvän tositteen\./);
    await seedAsk('ask-en', 'c-open', { status: 'replied', question: '', reply: 'Attached.' });
    await rejectClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: 'ask-en', actorId: 'reviewer-1' });
    assert.equal((await ask('ask-en')).question, 'Please upload supporting evidence.');

    // Nobody reachable: no stamp moves, the firm owns it now.
    await seedAsk('ask-dark', 'c-dark', { status: 'replied', reply: 'Photo attached.' });
    const sentBefore = emails.length;
    const before = await ask('ask-dark');
    const dark = await rejectClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: 'ask-dark', followUpQuestion: 'Please send a readable copy.', actorId: 'reviewer-1' });
    row = await ask('ask-dark');
    assert.equal(emails.length, sentBefore, 'nothing sent');
    assert.equal(row.send_count, 1, 'no phantom send');
    assert.equal(new Date(row.last_sent_at).getTime(), new Date(before.last_sent_at).getTime());
    assert.equal(row.request_payload.evidence_request?.sent_at, undefined, 'no envelope send stamp either');
    assert.deepEqual(dark.follow_up_delivery.escalated, ['ask-dark']);
    assert.equal(row.request_payload.escalated_to_firm.reason, 'owner_unreachable');
    assert.equal(row.status, 'open', 'still answerable by the owner');
  });

  // ── 3. A contained client gets nothing from any path ─────────────────────
  await t.test('3. a send-contained client gets nothing from any path; every refusal is receipted; neighbours still delivered', async () => {
    await seedAsk('ask-con', 'c-con', { status: 'replied', reply: 'Receipt attached.' });
    const conSent = emails.length;
    const conReject = await rejectClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: 'ask-con', followUpQuestion: 'Please send the full receipt.', actorId: 'reviewer-1' });
    assert.equal(conReject.follow_up_delivery.refused, 'INTERNAL_PILOT_SEND_DISABLED');
    assert.deepEqual(conReject.follow_up_delivery.held, ['ask-con']);
    const conResend = await resendClientEvidenceRequestInDb({ firmId: FIRM, clientId: 'c-con', evidenceRequestId: 'ask-con', actorId: 'operator-1' });
    assert.equal(conResend.resent, false);
    assert.equal(conResend.skipped_reason, 'send_refused');
    assert.equal(conResend.send_refused, 'INTERNAL_PILOT_SEND_DISABLED');
    const sweepClient = await pool.connect();
    try {
      const sweep = await runAskReaskSweep({ client: sweepClient, firmId: FIRM, clientId: 'c-con' });
      assert.equal(sweep.held, 1, JSON.stringify(sweep));
      assert.equal(sweep.nudged, 0);
    } finally { sweepClient.release(); }
    const row = await ask('ask-con');
    assert.equal(emails.length, conSent, 'the contained owner got nothing from reject, resend or re-ask');
    assert.equal(row.send_count, 1, 'nothing counted');
    assert.equal(row.status, 'open', 'the ask stays open on the owner');
    assert.equal(row.request_payload.escalated_to_firm, undefined, 'held, not escalated');
    assert.deepEqual((await refusals('c-con')).map(m => m.surface), ['evidence_rejection', 'operator_resend', 'ask_reask'],
      'every refusal is visible to the operator');

    // The evidence-topic sweep (where the re-ask cadence does not act): the
    // contained client is refused, the uncontained neighbour is sent.
    await seedClient('c-topic', { flags: ['EVIDENCE_TOPIC_REMINDERS'] });
    await seedClient('c-topic-con', { flags: ['EVIDENCE_TOPIC_REMINDERS'], contained: true });
    const topic = { version: 1, status: 'open', current_need: 'Please send the fuel receipt.', last_owner_message_at: '2026-01-01T00:00:00.000Z', last_donna_message_at: null,
      last_assessment: { outcome: 'defer_later', can_resolve: false, still_missing: ['receipt'], reason: 'owner_deferred_evidence' }, turns: [] };
    await seedAsk('ask-topic', 'c-topic', { payload: { evidence_topic: topic } });
    await seedAsk('ask-topic-con', 'c-topic-con', { payload: { evidence_topic: topic } });
    const reminded = [];
    const topicSweep = await runEvidenceTopicReminderSweep({ firmId: FIRM, now: new Date().toISOString(),
      deps: { sendReminder: async (args) => { reminded.push(args.clientId); return { message_id: `rem-${args.evidenceRequestId}` }; } } });
    assert.deepEqual(reminded, ['c-topic'], JSON.stringify(topicSweep));
    assert.equal(topicSweep.refused, 1);
    assert.deepEqual((await refusals('c-topic-con')).map(m => m.surface), ['evidence_topic_reminder']);

    // Neighbouring valid case: an uncontained operator resend still delivers.
    await seedAsk('ask-resend', 'c-open');
    const resend = await resendClientEvidenceRequestInDb({ firmId: FIRM, clientId: 'c-open', evidenceRequestId: 'ask-resend', actorId: 'operator-1' });
    assert.equal(resend.resent, true);
    assert.equal(resend.delivered, true);
    assert.equal((await ask('ask-resend')).send_count, 2);
  });

  // ── 4. A deliverer skips an ask that is no longer awaiting the owner ─────
  await t.test('4. a deliverer skips an ask that is no longer awaiting the owner', async () => {
    await seedAsk('ask-answered', 'c-open', { status: 'replied', question: 'Was this a business lunch?', reply: 'Yes, with a client.' });
    await seedAsk('ask-waiting', 'c-open', { question: 'Which project was the train ticket for?' });
    const skipSent = emails.length;
    const skipClient = await pool.connect();
    let skip;
    try {
      skip = await deliverEmailEvidenceAsksAfterSend({ client: skipClient, firmId: FIRM, clientId: 'c-open', evidenceRequestIds: ['ask-answered', 'ask-waiting'] });
    } finally { skipClient.release(); }
    assert.deepEqual(skip.skipped_not_awaiting, ['ask-answered']);
    assert.equal(skip.sent, 1);
    assert.equal(emails.length, skipSent + 1);
    assert.doesNotMatch(emails.at(-1).text, /business lunch/);
    assert.match(emails.at(-1).text, /train ticket/);
    assert.equal((await ask('ask-answered')).send_count, 1, 'the answered ask is not stamped');
  });

  // ── 5. A delivered reminder whose re-arm write fails is not repeated ─────
  await t.test('5. a delivered reminder whose re-arm write fails is not repeated', async () => {
    await seedClient('c-reask', { email: 'owner-reask@example.test', flags: ['OWNER_EMAIL_ASKS', 'ASK_REASK_CADENCE'] });
    await seedAsk('ask-reask', 'c-reask', { question: 'Who was the 80 EUR payment to?' });
    const reaskSent = emails.length;
    const real = await pool.connect();
    try {
      const failingRearm = { query: (sql, params) => (String(sql).includes('set due_at = $3::timestamptz')
        ? Promise.reject(new Error('simulated write failure after delivery'))
        : real.query(sql, params)) };
      const first = await runAskReaskSweep({ client: failingRearm, firmId: FIRM, clientId: 'c-reask' });
      assert.equal(first.errors, 1, JSON.stringify(first));
      assert.equal(emails.length, reaskSent + 1, 'the reminder was delivered once');
      const second = await runAskReaskSweep({ client: real, firmId: FIRM, clientId: 'c-reask' });
      assert.equal(second.considered, 0, 'the delivery stamp keeps it off the next tick');
      assert.equal(emails.length, reaskSent + 1, 'not reminded again');
    } finally { real.release(); }
  });

  // ── 2. A document-only reply that needs clarification ────────────────────
  await t.test('2. a document-only reply needing clarification is delivered through the fan-out', async () => {
    await seedClient('c-doc', { email: 'owner-doc@example.test', flags: ['OWNER_EMAIL_ASKS', 'DOCUMENT_NO_LINE_DISPOSITION'] });
    await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,status,vendor_name,total_amount,currency,document_date,parse_status)
      values('doc-c','${FIRM}','c-doc','bill.pdf','supplier_bill','parsed','Example Supplies Oy',240,'EUR','2026-06-10','completed')`);
    await seedAsk('ask-doc', 'c-doc', { question: 'How was this bill paid?', payload: { document_id: 'doc-c' } });
    await pool.query("update client_evidence_requests set evidence_type='payment_method' where id='ask-doc'");
    model = { disposition: 'needs_human', materiality: 'material', expense_kind: 'office_supplies', settlement_channel: 'unknown',
      funding_source: 'unknown', confidence: 0.4, unmatchable_reason: 'owner_reply_unclear', reasoning: 'The answer does not say how the bill was paid.' };
    const docSent = emails.length;
    const answered = await resolveClientEvidenceRequestInDb({ firmId: FIRM, evidenceRequestId: 'ask-doc',
      reply: 'it was sorted', actorId: 'owner-doc@example.test', actorType: 'client' });
    const clarificationId = answered.document_disposition?.clarification_request_id;
    assert.ok(clarificationId, JSON.stringify(answered.document_disposition));
    const clarification = await ask(clarificationId);
    assert.equal(clarification.status, 'open', 'its first genuine send opened it');
    assert.equal(clarification.send_count, 1);
    assert.equal(await receipts(clarificationId), 1);
    assert.equal(emails.length, docSent + 1, 'the clarification reached the owner by email');
    assert.match(emails.at(-1).text, new RegExp(clarification.question.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  await t.test('147: no sent stamp anywhere without a channel receipt', assertHonestStamps);
});
