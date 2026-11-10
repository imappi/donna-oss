// The four loose ends PR #22 left on owner-ask delivery, each proved on real
// PostgreSQL through the real code path. Only the providers (Resend, Twilio,
// the interpretation model) are fixtures. Synthetic data only.
//
//   1. The evidence-topic reminder re-checks the question right before it
//      sends: a question answered after the sweep's read is not reminded.
//   2. On a send-contained client, Donna's in-band reply to the owner's own
//      channel message does not carry the clarifying question the gate held.
//   3. The re-ask sweep's portal path moves no sent stamp: the question being
//      visible in the portal is not a delivery. It records a portal reminder,
//      re-arms the clock, and still escalates on the same schedule.
//   4. The WhatsApp and SMS deliverers report what was delivered, not what was
//      attempted; the fan-out names the delivered asks.
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  __setFirmDbPoolForTests, __resetFirmDbPoolForTests, listOpenEvidenceTopicsForReminderInDb
} from './firmDb.js';
import { deliverSmsEvidenceAsksAfterSend, deliverWhatsAppEvidenceAsksAfterSend } from './db/channels.js';
import { deliverEvidenceAsksOnAllChannels } from './db/asks.js';
import { runAskReaskSweep } from './askReaskCadence.js';
import { runEvidenceTopicReminderSweep } from './channels/evidenceTopicReminders.js';
import { processSmsInboundMessage } from './channels/smsInbound.js';
import { hashPhoneE164, shortAskRef } from './channels/whatsappWebhookCore.js';
import { HOSTED_PILOT_VERSION } from './internalPilotAccess.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const FIRM = 'firm-ask-loose-ends';
const DAY = 86400000;

test('owner-ask delivery loose ends: re-check, held clarification, portal stamp, delivered counts', { skip: !pgUrl && 'DONNA_PG_TEST_URL not set' }, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_ask_loose_ends_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`); const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() }); const closed = [];
  pool.on('connect', c => closed.push(new Promise(resolve => c.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const priorEnv = { RESEND_API_KEY: process.env.RESEND_API_KEY, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY };
  process.env.RESEND_API_KEY = 'test-resend-key'; process.env.ANTHROPIC_API_KEY = 'test-model-key';
  t.after(async () => {
    __resetFirmDbPoolForTests();
    for (const [k, v] of Object.entries(priorEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await pool.end(); await Promise.all(closed); await admin.query(`drop database "${name}" with (force)`); await admin.end();
  });
  await pool.query(`create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb);`);
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  await pool.query("insert into firms(id,name,slug) values($1,'Example Accounting','ask-loose-ends')", [FIRM]);

  let flagN = 0;
  const flag = (clientId, flagKey, { stage = 'canary', reason = 'synthetic loose-ends test' } = {}) => pool.query(
    `insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id)
     values($1,$2,$3,$4,$5,'manual',$6,'firm_member','op')`, [`flag-${++flagN}`, FIRM, clientId, flagKey, stage, reason]);
  const seedClient = async (id, { email = null, fi = false, flags = [], contained = false } = {}) => {
    const profile = { ...(email ? { email } : {}), ...(fi ? { jurisdiction: 'FI' } : {}) };
    await pool.query('insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,$3,$4,$5::jsonb)',
      [id, FIRM, `Synthetic ${id} Oy`, fi ? 'fi' : null, JSON.stringify(profile)]);
    for (const key of flags) await flag(id, key);
    if (contained) await flag(id, 'INTERNAL_PILOT_ACCESS', { reason: HOSTED_PILOT_VERSION });
  };
  const bindPhone = async (clientId, channel, phone) => pool.query(
    `insert into client_whatsapp_bindings(id,firm_id,client_id,phone_e164,phone_hash,verified_set_by,opted_in_set_by,channel)
     values($1,$2,$3,$4,$5,'op','op',$6)`, [`bind-${clientId}-${channel}`, FIRM, clientId, phone, hashPhoneE164(phone), channel]);
  const seedPortalOwner = async (clientId) => {
    await pool.query(`insert into firm_collaborators(id,firm_id,email,name,role,status,access_level,user_id)
      values($1,$2,$3,'Synthetic owner','owner','active','client_scoped',$4)`, [`collab-${clientId}`, FIRM, `${clientId}@example.test`, `user-${clientId}`]);
    await pool.query(`insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role,assignment_kind,status)
      values($1,$2,$3,'firm_collaborator',$4,'owner','capability','active')`, [`assign-${clientId}`, FIRM, clientId, `collab-${clientId}`]);
  };
  // A genuinely sent ask: its stamps are backed by a ledger receipt (147).
  const seedAsk = async (id, clientId, { status = 'open', question = 'Who was the 120 EUR transfer to?', lastSentDaysAgo = 10, dueDaysAgo = 3, evidenceType = 'supporting_document', payload = {} } = {}) => {
    await pool.query(`insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload,audience,send_count,first_sent_at,last_sent_at,due_at,created_by)
      values($1,$2,$3,$4,$5,$6,$7::jsonb,'client',1,now()-($8||' days')::interval,now()-($8||' days')::interval,now()-($9||' days')::interval,'ask_batch')`,
    [id, FIRM, clientId, status, evidenceType, question, JSON.stringify(payload), String(lastSentDaysAgo), String(dueDaysAgo)]);
    await pool.query(`insert into message_delivery_ledger(id,message_id,channel,provider,ask_id,client_id,template_name,sent_at)
      values($1,$1,'email','resend',$2,$3,'donna_evidence_ask_email_v1',now()-($4||' days')::interval)`, [`seed-${id}`, id, clientId, String(lastSentDaysAgo)]);
  };
  const ask = async id => (await pool.query('select * from client_evidence_requests where id=$1', [id])).rows[0];
  const withClient = async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } };

  const emails = [];
  let interpretation = null;
  t.mock.method(globalThis, 'fetch', async (endpoint, options = {}) => {
    if (endpoint === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ id: `email-${emails.length}` }) };
    }
    if (endpoint === 'https://api.anthropic.com/v1/messages' && interpretation) {
      return new Response(JSON.stringify({ model: 'fixture-interpreter', stop_reason: 'tool_use',
        content: [{ type: 'tool_use', name: 'interpret_owner_reply', input: interpretation }] }), { status: 200 });
    }
    throw new Error(`no external transport in this proof: ${endpoint}`);
  });

  // ── 1. The reminder re-checks the question right before it sends ─────────
  await t.test('1. a question answered after the sweep read is not reminded; a waiting neighbour is', async () => {
    const topic = { version: 1, status: 'open', current_need: 'Please send the fuel receipt.', last_owner_message_at: '2026-01-01T00:00:00.000Z',
      last_donna_message_at: null, last_assessment: { outcome: 'defer_later', can_resolve: false, still_missing: ['receipt'], reason: 'owner_deferred_evidence' }, turns: [] };
    await seedClient('c-rem', { flags: ['EVIDENCE_TOPIC_REMINDERS'] });
    await seedClient('c-rem-2', { flags: ['EVIDENCE_TOPIC_REMINDERS'] });
    await bindPhone('c-rem', 'sms', '+15555550101');
    await bindPhone('c-rem-2', 'sms', '+15555550102');
    await seedAsk('ask-rem-answered', 'c-rem', { payload: { evidence_topic: topic } });
    await seedAsk('ask-rem-waiting', 'c-rem-2', { payload: { evidence_topic: topic } });
    const texts = [];
    const sweep = await runEvidenceTopicReminderSweep({ firmId: FIRM, now: new Date().toISOString(), deps: {
      // The owner answers between the sweep's read and its send.
      listOpenEvidenceTopics: async (args) => {
        const rows = await listOpenEvidenceTopicsForReminderInDb(args);
        await pool.query("update client_evidence_requests set status='replied' where id='ask-rem-answered'");
        return rows;
      },
      sendSmsText: async ({ to, text }) => { texts.push({ to, text }); return { ok: true, id: `sms-${texts.length}` }; }
    } });
    assert.deepEqual(texts.map(m => m.to), ['+15555550102'], `only the waiting owner is reminded: ${JSON.stringify(sweep)}`);
    assert.equal(sweep.sent, 1);
    assert.equal(sweep.not_awaiting, 1, 'the skip is reported by name');
    assert.equal(sweep.failed, 0, 'a skip is not a failure');
    assert.equal((await ask('ask-rem-answered')).request_payload.evidence_topic.reminder_count, undefined, 'not stamped');
    assert.equal((await ask('ask-rem-waiting')).request_payload.evidence_topic.reminder_count, 1);
  });

  // ── 2. A held clarification does not ride the in-band reply ──────────────
  await t.test('2. on a send-contained client the reply to the owner carries no clarifying question', async () => {
    const clarification = 'Could you send a corrected copy of the receipt, or tell me the exact amount you paid?';
    const seedTotalsAsk = async (clientId) => {
      await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,status,vendor_name,total_amount,tax_amount,currency,document_date,parse_status)
        values($1,$2,$3,'receipt.jpg','receipt','parsed','Example Cafe Oy',33.30,3.20,'EUR','2026-10-02','completed')`, [`doc-${clientId}`, FIRM, clientId]);
      await seedAsk(`ask-tot-${clientId}`, clientId, { question: 'The receipt total does not match its lines. Which amount did you pay?',
        payload: { lane: 'totals_mismatch', document_id: `doc-${clientId}` } });
    };
    const ownerWrites = async (clientId, phone) => {
      const sent = [];
      const result = await processSmsInboundMessage({ firmId: FIRM, from: phone, env: {},
        message: { MessageSid: `SM-${clientId}`, Body: `not sure, my partner paid it Ref: ${shortAskRef(`ask-tot-${clientId}`)}` },
        deps: { sendText: async (m) => { sent.push(m.text); return { ok: true, id: `sms-out-${sent.length}` }; } } });
      return { sent, result };
    };
    interpretation = { answer: null, confidence: 0.3, clarification };

    // Contained: the follow-up is refused at the one gate, so the reply only
    // acknowledges the answer.
    await seedClient('c-held', { fi: true, email: 'owner-held@example.test', flags: ['OWNER_CHANNEL_SMS', 'OWNER_EMAIL_ASKS'], contained: true });
    await bindPhone('c-held', 'sms', '+15555550111');
    await seedTotalsAsk('c-held');
    const emailsBefore = emails.length;
    const held = await ownerWrites('c-held', '+15555550111');
    assert.equal(held.result.result?.recode?.follow_up_delivery?.refused, 'INTERNAL_PILOT_SEND_DISABLED', JSON.stringify(held.result.result?.recode?.follow_up_delivery));
    assert.equal(held.sent.length, 1, JSON.stringify(held));
    assert.doesNotMatch(held.sent[0], /corrected copy|\?/, 'no question reaches a contained owner');
    assert.equal(held.sent[0], 'Vastauksesi on tallessa. Kirjaus ei ole vielä valmis.', 'the acknowledgement, in the owner\u2019s language');
    assert.equal(emails.length, emailsBefore, 'nothing by email either');
    const heldRow = await ask('ask-tot-c-held');
    assert.equal(heldRow.status, 'open', 'the question stays open on the owner, held');
    assert.equal(heldRow.question, clarification, 'the clarification is kept for release');

    // Neighbour: gate allows, the follow-up is delivered by email, the reply
    // acknowledges it (unchanged).
    await seedClient('c-free', { fi: true, email: 'owner-free@example.test', flags: ['OWNER_CHANNEL_SMS', 'OWNER_EMAIL_ASKS'] });
    await bindPhone('c-free', 'sms', '+15555550112');
    await seedTotalsAsk('c-free');
    const free = await ownerWrites('c-free', '+15555550112');
    assert.deepEqual(free.sent, ['Thanks. I sent you a follow-up question.']);
    assert.match(emails.at(-1).text, /corrected copy/);

    // Neighbour: gate allows, nothing delivered: the question rides the reply
    // to the owner's own message, as before.
    await seedClient('c-inband', { fi: true, flags: ['OWNER_CHANNEL_SMS'] });
    await bindPhone('c-inband', 'sms', '+15555550113');
    await seedTotalsAsk('c-inband');
    const inband = await ownerWrites('c-inband', '+15555550113');
    assert.deepEqual(inband.sent, [clarification]);
    interpretation = null;
  });

  // ── 3. The portal path moves no sent stamp ───────────────────────────────
  await t.test('3. a portal reminder is recorded as such; no sent stamp moves; escalation keeps its schedule', async () => {
    await seedClient('c-portal', { flags: ['ASK_REASK_CADENCE'] });
    await seedPortalOwner('c-portal');
    await seedAsk('ask-portal', 'c-portal', { question: 'Was the 64 EUR train ticket for the client visit?' });
    const before = await ask('ask-portal');
    const sweep = (now) => withClient(client => runAskReaskSweep({ client, firmId: FIRM, clientId: 'c-portal', now }));
    const t0 = Date.now();
    const first = await sweep(t0);
    assert.equal(first.portal, 1, JSON.stringify(first));
    let row = await ask('ask-portal');
    assert.equal(row.send_count, 1, 'the portal is not a delivery: send_count stays');
    assert.equal(new Date(row.last_sent_at).getTime(), new Date(before.last_sent_at).getTime(), 'last_sent_at stays');
    assert.equal(row.request_payload.evidence_request?.send_count, undefined, 'no send stamp in the envelope');
    assert.equal(row.request_payload.evidence_request?.sent_at, undefined);
    assert.deepEqual(row.request_payload.portal_reminders, [new Date(t0).toISOString()]);
    assert.equal(new Date(row.due_at).getTime(), t0 + 7 * DAY, 'the clock is re-armed');
    const nudge = (await pool.query("select metadata from audit_events where resource_id='ask-portal' and action='evidence_request.nudged'")).rows[0].metadata;
    assert.equal(nudge.surface, 'portal');
    assert.equal(nudge.send_count, 1);
    assert.equal(nudge.portal_reminder_count, 1);

    assert.equal((await sweep(t0 + DAY)).considered, 0, 'not due again inside the interval');
    const second = await sweep(t0 + 8 * DAY);
    assert.equal(second.portal, 1, JSON.stringify(second));
    // One delivered send + two portal reminders unanswered: the same third
    // step at which the old count escalated.
    const third = await sweep(t0 + 16 * DAY);
    assert.equal(third.escalated, 1, JSON.stringify(third));
    row = await ask('ask-portal');
    assert.equal(row.send_count, 1);
    assert.equal(row.request_payload.escalated_to_firm.reason, 'owner_unresponsive');
    assert.equal(row.request_payload.escalated_to_firm.send_count, 1);
    assert.equal(row.request_payload.escalated_to_firm.portal_reminder_count, 2);
    const liars = (await pool.query(`select r.id from client_evidence_requests r where r.id='ask-portal'
      and r.send_count <> (select count(*) from message_delivery_ledger l where l.ask_id=r.id and l.sent_at is not null)`)).rows;
    assert.deepEqual(liars, [], 'send_count equals the delivery receipts');
  });

  // ── 4. Deliverers report what was delivered ──────────────────────────────
  await t.test('4. WhatsApp and SMS report delivered, not attempted; the fan-out names the delivered asks', async () => {
    await seedClient('c-count');
    await bindPhone('c-count', 'sms', '+15555550121');
    await bindPhone('c-count', 'whatsapp', '+15555550122');
    await seedAsk('ask-count-1', 'c-count', { question: 'Which project was the hotel night for?' });
    await seedAsk('ask-count-2', 'c-count', { question: 'Who attended the team lunch?' });
    const env = { SMS_ENABLED: 'true', SMS_CLIENTS: 'c-count', WHATSAPP_ENABLED: 'true', WHATSAPP_CLIENTS: 'c-count' };
    // The provider accepts the first ask and refuses the second.
    const deps = { deliverOwnerMessage: async ({ template }) => (template.metadata.ask_id === 'ask-count-1'
      ? { ok: true, id: `msg-${template.metadata.ask_id}-${Math.random()}` } : { ok: false, reason: 'provider_refused' }) };
    const ids = ['ask-count-1', 'ask-count-2'];
    const sms = await withClient(client => deliverSmsEvidenceAsksAfterSend({ client, firmId: FIRM, clientId: 'c-count', evidenceRequestIds: ids, env, deps }));
    assert.equal(sms.sent, 1, JSON.stringify(sms));
    assert.deepEqual(sms.delivered, ['ask-count-1']);
    const wa = await withClient(client => deliverWhatsAppEvidenceAsksAfterSend({ client, firmId: FIRM, clientId: 'c-count', evidenceRequestIds: ids, env, deps }));
    assert.equal(wa.sent, 1, JSON.stringify(wa));
    assert.deepEqual(wa.delivered, ['ask-count-1']);
    assert.equal((await ask('ask-count-1')).send_count, 3);
    assert.equal((await ask('ask-count-2')).send_count, 1);
    // All refused: nothing delivered.
    const none = await withClient(client => deliverSmsEvidenceAsksAfterSend({ client, firmId: FIRM, clientId: 'c-count', evidenceRequestIds: ['ask-count-2'], env, deps }));
    assert.equal(none.sent, 0);
    assert.deepEqual(none.delivered, []);
    // The fan-out aggregates across channels (WhatsApp/SMS stay dark here on
    // the process env; only the shape is under test).
    const fan = await withClient(client => deliverEvidenceAsksOnAllChannels({ client, firmId: FIRM, clientId: 'c-count', evidenceRequestIds: ids, deps }));
    assert.deepEqual(fan.delivered, [], JSON.stringify(fan));
  });
});
