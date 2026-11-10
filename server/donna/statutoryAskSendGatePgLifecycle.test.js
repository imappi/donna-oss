// The Finnish and UK statutory owner questions go through the ONE gated send
// path, and their send stamps equal their real deliveries. Real PostgreSQL,
// the real statutory writers, the real fan-out and the real WhatsApp deliverer;
// only the provider endpoints are fixtures behind global fetch, so no message
// leaves the test. Synthetic data only.
//
//   1. A send-contained Finnish client receives nothing from the scope-drift
//      drain, the prepayment-register escalation, the ALV-threshold
//      escalation or the ALV-return escalation / confirmation; each refusal is
//      receipted; nothing is stamped as sent. A send-contained UK client gets
//      nothing from the VAT-threshold escalation.
//   2. Stamps are deliveries: a delivered question carries send_count 1 with
//      one channel receipt; a failed send and an unbound owner carry no stamp.
//   3. No new channel: these questions still go out on WhatsApp only, even for
//      a client whose owner-email asks are on.
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { prepareCiHostPostgres } from '../../scripts/prepare_ci_host_postgres.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './db/pool.js';
import {
  deliverPendingFinlandScopeDriftAsks, drainFinlandAlvThresholdEscalations,
  recordPrepaymentRegisterCheckInDb, startFinlandAlvReturnFilingInDb
} from './finland/statutoryDb.js';
import { drainGbVatThresholdEscalations } from './gb/statutoryDb.js';
import { SCOPE_DRIFT_EVIDENCE_TYPE } from './finland/scopeDrift.js';
import { hashPhoneE164 } from './channels/whatsappWebhookCore.js';
import { HOSTED_PILOT_VERSION } from './internalPilotAccess.js';
import { OWNER_SEND_REFUSED_ACTION } from './ownerAskDelivery.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const FIRM = 'firm-statutory-gate';
const FAILING_PHONE = '+15555550199';

test('statutory owner questions: one gate, stamps only for deliveries — real PostgreSQL', { skip: !pgUrl && 'DONNA_PG_TEST_URL not set' }, async (t) => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const database = `sasg_${randomUUID().replaceAll('-', '')}`;
  const url = new URL(pgUrl); url.pathname = `/${database}`;
  await admin.query(`create database "${database}"`);
  const envKeys = ['DATABASE_URL', 'CLIENT_CONFIG_FORCE_DISABLE', 'WHATSAPP_ENABLED', 'WHATSAPP_CLIENTS', 'WHATSAPP_ACCESS_TOKEN',
    'WHATSAPP_PHONE_NUMBER_ID', 'RESEND_API_KEY', 'SMS_ENABLED', 'TELEGRAM_ENABLED'];
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  let seed; let pool;
  t.after(async () => {
    __resetFirmDbPoolForTests();
    if (pool) await pool.end();
    if (seed) await seed.end();
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await admin.query(`drop database "${database}" with (force)`);
    await admin.end();
  });
  await prepareCiHostPostgres({ databaseUrl: url.toString() });
  seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const migrationRoot = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrationRoot)).filter((f) => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(file, migrationRoot), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  process.env.DATABASE_URL = url.toString(); delete process.env.CLIENT_CONFIG_FORCE_DISABLE;
  pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  __setFirmDbPoolForTests(pool);
  await seed.query("insert into firms(id,name,slug) values($1,'Example Accounting','statutory-gate')", [FIRM]);

  // Provider fixtures: WhatsApp (Meta graph) accepts every send except to the
  // failing number; owner email (Resend) is recorded so a new channel shows.
  const whatsapp = [];
  const emails = [];
  t.mock.method(globalThis, 'fetch', async (endpoint, options = {}) => {
    const target = String(endpoint);
    if (target.startsWith('https://graph.facebook.com/')) {
      const body = JSON.parse(options.body);
      if (body.to === FAILING_PHONE) return { ok: false, status: 500, json: async () => ({ error: { message: 'synthetic provider failure' } }) };
      whatsapp.push(body);
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: `wamid.synthetic.${whatsapp.length}` }] }) };
    }
    if (target === 'https://api.resend.com/emails') {
      emails.push(JSON.parse(options.body));
      return { ok: true, status: 200, json: async () => ({ id: `email-${emails.length}` }) };
    }
    throw new Error(`no external transport in this proof: ${target}`);
  });
  const whatsappClients = [];
  Object.assign(process.env, {
    WHATSAPP_ENABLED: 'true', WHATSAPP_ACCESS_TOKEN: 'synthetic-token', WHATSAPP_PHONE_NUMBER_ID: '000000000000000',
    RESEND_API_KEY: 'synthetic-resend-key', SMS_ENABLED: 'false', TELEGRAM_ENABLED: 'false'
  });

  let seq = 0;
  const newClient = async ({ jurisdiction = 'fi', flags = [], contained = false, phone = null, email = null, entityType = null } = {}) => {
    const clientId = `sasg-client-${++seq}`;
    const profile = { jurisdiction: jurisdiction.toUpperCase(), ...(email ? { email } : {}) };
    await seed.query('insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$3,$4,$5,$6::jsonb)',
      [clientId, FIRM, `Synthetic ${seq} Oy`, jurisdiction, entityType, JSON.stringify(profile)]);
    const allFlags = [...flags, ...(contained ? [['INTERNAL_PILOT_ACCESS', HOSTED_PILOT_VERSION]] : [])];
    for (const entry of allFlags) {
      const [flagKey, reason] = Array.isArray(entry) ? entry : [entry, 'synthetic statutory send-gate test'];
      await seed.query(`insert into client_capability_config(id,firm_id,client_id,flag_key,stage,source,reason,set_by_actor_type,set_by_actor_id)
        values($1,$2,$3,$4,'canary','manual',$5,'firm_member','op')`, [`flag-${clientId}-${flagKey}`, FIRM, clientId, flagKey, reason]);
    }
    if (phone) {
      await seed.query(`insert into client_whatsapp_bindings(id,firm_id,client_id,phone_e164,phone_hash,verified_set_by,opted_in_set_by,channel)
        values($1,$2,$3,$4,$5,'op','op','whatsapp')`, [`bind-${clientId}`, FIRM, clientId, phone, hashPhoneE164(phone)]);
      whatsappClients.push(clientId);
      process.env.WHATSAPP_CLIENTS = whatsappClients.join(',');
    }
    return clientId;
  };
  const post = async (clientId, { id, date = '2026-06-10', currency = 'EUR', lines }) => {
    await seed.query(`insert into ledger_journals(id,firm_id,client_id,source_type,source_id,journal_date,currency,status)
      values($1,$2,$3,'sasg_fixture',$1,$4,$5,'posted')`, [id, FIRM, clientId, date, currency]);
    for (const [n, [code, type, debit, credit, taxType, role]] of lines.entries()) {
      const account = `${clientId}-${code}`;
      await seed.query(`insert into ledger_accounts(id,firm_id,client_id,code,name,account_type,currency)
        values($1,$2,$3,$4,$4,$5,$6) on conflict do nothing`, [account, FIRM, clientId, code, type, currency]);
      await seed.query(`insert into ledger_lines(id,journal_id,firm_id,client_id,account_id,account_code,line_no,direction,debit,credit,amount,currency,tax_type,payload)
        values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [`${id}-${n + 1}`, id, FIRM, clientId, account, code, n + 1, debit ? 'debit' : 'credit', debit, credit, debit || credit, currency, taxType || null, role ? { role } : {}]);
    }
  };
  // The posting seam's mint (finland/postingAdmission.js): open, no stamp.
  const seedScopeDriftAsk = async (clientId) => {
    const id = `scope-drift-${clientId}`;
    await seed.query(`insert into client_evidence_requests(id,firm_id,client_id,status,evidence_type,question,request_payload,send_count,created_by)
      values($1,$2,$3,'open',$4,'Kirjanpidossa on rakennusalan käännettyä ALV:tä — kerrotko, mitä työ oli?',$5::jsonb,0,'system')`,
    [id, FIRM, clientId, SCOPE_DRIFT_EVIDENCE_TYPE, JSON.stringify({ kind: SCOPE_DRIFT_EVIDENCE_TYPE, trigger_id: 'reverse_charge' })]);
    return id;
  };
  const asksOf = async (clientId) => (await seed.query(
    `select r.id, r.evidence_type, r.status, r.send_count, r.first_sent_at, r.last_sent_at,
            (select count(*)::int from message_delivery_ledger l where l.ask_id = r.id and l.sent_at is not null) as receipts
       from client_evidence_requests r where r.client_id = $1 order by r.created_at, r.id`, [clientId])).rows;
  const refusalsOf = async (clientId) => (await seed.query(
    'select metadata from audit_events where client_id = $1 and action = $2 order by id', [clientId, OWNER_SEND_REFUSED_ACTION])).rows.map((r) => r.metadata);
  const sentTo = (phone) => whatsapp.filter((m) => m.to === phone).length;
  // The stamp law, per question: the count is the channel receipts, and a
  // question nobody received carries no sent time.
  const assertStampsAreDeliveries = (rows, label) => {
    assert.ok(rows.length > 0, `${label}: the flow minted its question`);
    for (const row of rows) {
      assert.equal(row.send_count, row.receipts, `${label}: ${row.id} send_count ${row.send_count} must equal its ${row.receipts} deliveries`);
      if (row.receipts === 0) {
        assert.equal(row.first_sent_at, null, `${label}: ${row.id} was never delivered but carries first_sent_at`);
        assert.equal(row.last_sent_at, null, `${label}: ${row.id} was never delivered but carries last_sent_at`);
      }
    }
  };
  const withClient = async (fn) => { const c = await pool.connect(); try { return await fn(c); } finally { c.release(); } };

  await t.test('scope-drift drain: contained ⇒ nothing sent; delivered ⇒ one stamp; failed ⇒ none', async () => {
    const containedPhone = '+15555550101';
    const contained = await newClient({ contained: true, phone: containedPhone });
    const open = await newClient({ phone: '+15555550102', email: 'owner-drift@example.test', flags: ['OWNER_EMAIL_ASKS'] });
    const failing = await newClient({ phone: FAILING_PHONE });
    for (const clientId of [contained, open, failing]) await seedScopeDriftAsk(clientId);
    const emailsBefore = emails.length;
    const summary = await withClient((client) => deliverPendingFinlandScopeDriftAsks({ client }));
    assert.equal(sentTo(containedPhone), 0, 'a send-contained client receives no scope-drift question');
    assert.equal(sentTo('+15555550102'), 1, 'the uncontained client receives it once');
    assert.equal(emails.length, emailsBefore, 'no new channel: the question was not also emailed');
    assertStampsAreDeliveries(await asksOf(contained), 'contained');
    assertStampsAreDeliveries(await asksOf(open), 'delivered');
    assertStampsAreDeliveries(await asksOf(failing), 'failed send');
    assert.equal((await refusalsOf(contained)).length, 1, 'the refusal is receipted');
    assert.equal((await refusalsOf(contained))[0].surface, 'finland_scope_drift');
    assert.equal(summary.pending, 3);
    // The held question is retried on the next daily run, and held again.
    await withClient((client) => deliverPendingFinlandScopeDriftAsks({ client }));
    assert.equal(sentTo(containedPhone), 0);
    assert.equal(sentTo('+15555550102'), 1, 'a delivered question is not sent again');
    assertStampsAreDeliveries(await asksOf(contained), 'contained, second run');
  });

  await t.test('prepayment-register escalation: contained ⇒ nothing sent; delivered ⇒ one stamp; unbound ⇒ none', async () => {
    const containedPhone = '+15555550111';
    const contained = await newClient({ contained: true, phone: containedPhone });
    const openPhone = '+15555550112';
    const open = await newClient({ phone: openPhone });
    const unbound = await newClient();
    const check = { subject_type: 'supplier', counterparty_name: 'Synthetic Rakennus Oy', status: 'not_registered', checked_on: '2026-06-20' };
    for (const clientId of [contained, open, unbound]) {
      await seed.query(`insert into documents(id,firm_id,client_id,filename,document_type,vendor_name,document_date)
        values($1,$2,$3,'bill.pdf','supplier_bill','Synthetic Rakennus Oy','2026-06-01')`, [`bill-${clientId}`, FIRM, clientId]);
      const result = await recordPrepaymentRegisterCheckInDb({ firmId: FIRM, clientId, check, onDate: '2026-06-20' });
      assert.ok(result.escalation?.ask?.id, 'the escalation question is minted');
    }
    assert.equal(sentTo(containedPhone), 0, 'a send-contained client receives no prepayment-register question');
    assert.equal(sentTo(openPhone), 1);
    assertStampsAreDeliveries(await asksOf(contained), 'contained');
    assertStampsAreDeliveries(await asksOf(open), 'delivered');
    assertStampsAreDeliveries(await asksOf(unbound), 'unbound');
    assert.equal((await refusalsOf(contained))[0]?.surface, 'finland_prepayment_register');
  });

  await t.test('ALV-threshold escalation: contained ⇒ nothing sent; delivered ⇒ one stamp', async () => {
    const containedPhone = '+15555550121';
    const contained = await newClient({ contained: true, phone: containedPhone, flags: ['FINLAND_ALV_THRESHOLD_WATCH'] });
    const openPhone = '+15555550122';
    const open = await newClient({ phone: openPhone, flags: ['FINLAND_ALV_THRESHOLD_WATCH'] });
    for (const clientId of [contained, open]) {
      await post(clientId, { id: `alvw-${clientId}`, lines: [['3000', 'revenue', 0, 40000, null], ['1910', 'asset', 40000, 0]] });
    }
    const summary = await withClient((client) => drainFinlandAlvThresholdEscalations({ client, firmId: FIRM, year: 2026 }));
    assert.equal(summary.minted, 2, JSON.stringify(summary));
    assert.equal(sentTo(containedPhone), 0, 'a send-contained client receives no ALV-threshold question');
    assert.equal(sentTo(openPhone), 1);
    assertStampsAreDeliveries(await asksOf(contained), 'contained');
    assertStampsAreDeliveries(await asksOf(open), 'delivered');
    assert.equal((await refusalsOf(contained))[0]?.surface, 'finland_alv_threshold');
  });

  await t.test('ALV-return escalation and confirmation: contained ⇒ nothing sent; delivered ⇒ one stamp', async () => {
    const flags = ['FINLAND_ALV_RETURN', 'FINLAND_ALV_FILING'];
    const cases = [
      { label: 'confirmation, contained', phone: '+15555550131', contained: true, ready: true },
      { label: 'confirmation, delivered', phone: '+15555550132', contained: false, ready: true },
      { label: 'escalation, contained', phone: '+15555550133', contained: true, ready: false },
      { label: 'escalation, delivered', phone: '+15555550134', contained: false, ready: false }
    ];
    for (const item of cases) {
      const clientId = await newClient({ contained: item.contained, phone: item.phone, flags, entityType: 'fi-toiminimi' });
      // Ready: a coded sale. Not ready: a revenue line with no ALV treatment.
      await post(clientId, { id: `alvr-${clientId}`, lines: item.ready
        ? [['3000', 'revenue', 0, 1000, 'ALV_25_5_OUTPUT'], ['2939', 'liability', 0, 255, null, 'alv_output'], ['1910', 'asset', 1255, 0]]
        : [['3000', 'revenue', 0, 1000, null], ['1910', 'asset', 1000, 0]] });
      const result = await startFinlandAlvReturnFilingInDb({ firmId: FIRM, clientId, period: '2026-06', actorId: 'op' });
      assert.equal(result.action, item.ready ? 'confirmation_requested' : 'escalated', `${item.label}: ${JSON.stringify(result).slice(0, 300)}`);
      assert.equal(sentTo(item.phone), item.contained ? 0 : 1, `${item.label}: WhatsApp sends`);
      assertStampsAreDeliveries(await asksOf(clientId), item.label);
      if (item.contained) assert.equal((await refusalsOf(clientId))[0]?.surface, 'finland_alv_return');
    }
  });

  await t.test('UK VAT-threshold escalation: contained ⇒ nothing sent; delivered ⇒ one stamp', async () => {
    const containedPhone = '+15555550141';
    const contained = await newClient({ jurisdiction: 'gb', contained: true, phone: containedPhone, flags: ['GB_VAT_THRESHOLD_WATCH'] });
    const openPhone = '+15555550142';
    const open = await newClient({ jurisdiction: 'gb', phone: openPhone, flags: ['GB_VAT_THRESHOLD_WATCH'] });
    for (const clientId of [contained, open]) {
      await post(clientId, { id: `gbw-${clientId}`, currency: 'GBP', lines: [['3000', 'revenue', 0, 200000, null], ['1200', 'asset', 200000, 0]] });
    }
    const summary = await withClient((client) => drainGbVatThresholdEscalations({ client, firmId: FIRM, asOf: '2026-07-01' }));
    assert.equal(summary.minted, 2, JSON.stringify(summary));
    assert.equal(sentTo(containedPhone), 0, 'a send-contained UK client receives no VAT-threshold question');
    assert.equal(sentTo(openPhone), 1);
    assertStampsAreDeliveries(await asksOf(contained), 'contained');
    assertStampsAreDeliveries(await asksOf(open), 'delivered');
    assert.equal((await refusalsOf(contained))[0]?.surface, 'gb_vat_threshold');
  });

  await t.test('no new channel: every message in this proof went out on WhatsApp', async () => {
    assert.equal(emails.length, 0, 'no owner email from these flows');
  });
});
