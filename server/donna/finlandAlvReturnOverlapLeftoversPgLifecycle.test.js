// The three leftovers of the ALV return overlap guard (#44), against PostgreSQL
// through the real functions:
//   1. returns that already overlapped before migration 172 must not both be
//      filed — the confirm path checks for an overlapping live return BEFORE
//      anything is transmitted;
//   2. the start motion refuses a covered period BEFORE it computes the return
//      or asks the owner anything;
//   3. the period read shows what already covers the requested dates.
// Transmission never leaves the test: the filing channel is the same injected
// `submitReturn` fake the route tests use, and it records every call.
// node --test server/donna/finlandAlvReturnOverlapLeftoversPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import * as registry from './statutoryRegistry.js';
import { resolveAlvPeriod } from './finland/alvReturn.js';
import { ALV_RETURN_ASK_KIND, resolveAlvReturnInbound } from './finland/alvReturnRoute.js';
import { SUOMIFI_MANDATE_SCOPE_TAX } from './finland/suomifiMandate.js';

const {
  cancelAlvReturnInDb,
  createAlvReturnDraftInDb,
  getAlvReturnByIdInDb,
  getAlvReturnForPeriodInDb,
  markAlvReturnFiledInDb,
  startFinlandAlvReturnFilingInDb
} = registry;

const pgUrl = process.env.DONNA_PG_TEST_URL;
const skip = !pgUrl && 'DONNA_PG_TEST_URL required';
const firmId = 'alv-overlap-leftovers';
const clientId = 'fi-leftovers';
const migrationsDir = new URL('../../db/migrations/', import.meta.url);

const readyVerdict = () => ({
  alvReturn: { boxes: { 301: 25.5, 307: 0, 308: 25.5 }, payable: 25.5, refund: false, nilReturn: false, selfAssessedFullyDeductible: true },
  review: { status: 'ready', blockers: [] },
  provenance: { source: 'ledger_read_model', deterministic: true }
});

async function freshBook(t, label, { upTo = null } = {}) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_alvl_${label}_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() });
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const files = (await readdir(migrationsDir)).filter(n => n.endsWith('.sql')).sort();
  const apply = async (filter) => { for (const file of files.filter(filter)) await pool.query(await readFile(new URL(file, migrationsDir), 'utf8')); };
  await apply(file => !upTo || file < upTo);
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic leftovers proof',$1)", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Synthetic Leftover Oy','FI','fi-oy','{}')", [clientId, firmId]);
  return { pool, applyRest: () => apply(file => upTo && file >= upTo) };
}

// The shape the pre-172 bug could leave behind, inserted before 172 exists.
const legacyRow = (id, key, status) => {
  const period = resolveAlvPeriod(key);
  return { id, key, type: period.type, starts_on: period.starts_on, ends_on: period.ends_on, status };
};
async function insertLegacy(pool, rows) {
  for (const row of rows) {
    await pool.query(
      `insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status,verdict,filed_at,filed_by,filing_receipt)
       values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12::jsonb)`,
      [row.id, firmId, clientId, row.key, row.type, row.starts_on, row.ends_on, row.status, JSON.stringify(readyVerdict()),
        row.status === 'filed' ? new Date('2026-10-12T09:00:00Z') : null, row.status === 'filed' ? 'owner-fixture' : null,
        JSON.stringify(row.status === 'filed' ? { channel: 'omavero_test', submission_id: `SUB-${row.key}` } : null)]
    );
  }
}

const snapshot = async (pool) => (await pool.query('select id, period_key, status, starts_on::text, ends_on::text, verdict, filing_receipt, filed_at, updated_at from alv_returns order by id')).rows;

// The confirm lane as channels/whatsappInbound.js wires it, with the real
// store functions and a recording fake for the filing channel.
const confirmLane = () => {
  const transmitted = [];
  const sent = [];
  const resolved = [];
  const reply = (alvReturnId, replyText, n = 1) => resolveAlvReturnInbound({
    firmId,
    clientId,
    ask: { id: `ask-${alvReturnId}`, evidence_type: ALV_RETURN_ASK_KIND, request_payload: { kind: ALV_RETURN_ASK_KIND, alv_return: { phase: 'confirm_request', alv_return_id: alvReturnId } } },
    replyText,
    message: { id: `wamid.synthetic-${alvReturnId}-${n}`, timestamp: '2026-11-10T09:00:00Z' },
    phoneHash: 'ph-synthetic',
    actorId: 'owner-fixture',
    flagActs: true,
    getAlvReturnImpl: getAlvReturnByIdInDb,
    getMandateImpl: async ({ scope }) => (scope === SUOMIFI_MANDATE_SCOPE_TAX
      ? { id: 'suomifi-mandate-synthetic', scope, status: 'active', granted_on: '2026-01-15', expires_on: null }
      : null),
    assertFileableImpl: registry.assertAlvReturnFileableInDb,
    markFiledImpl: markAlvReturnFiledInDb,
    cancelImpl: cancelAlvReturnInDb,
    submitReturn: async (payload) => { transmitted.push(payload.period.key); return { channel: 'omavero_test', submission_id: `SUB-${payload.period.key}` }; },
    resolveAsk: async ({ askId, resolutionNote }) => resolved.push(`${askId}:${resolutionNote}`),
    sendText: async ({ text }) => sent.push(text)
  });
  return { transmitted, sent, resolved, reply };
};

test('real PG: a pending month inside an already FILED quarter is never transmitted', { skip }, async t => {
  const { pool, applyRest } = await freshBook(t, 'filedq', { upTo: '172_' });
  await insertLegacy(pool, [legacyRow('legacy-q3', '2026-Q3', 'filed'), legacyRow('legacy-09', '2026-09', 'draft_pending_confirmation')]);
  await applyRest();
  const before = await snapshot(pool);
  const lane = confirmLane();

  const result = await lane.reply('legacy-09', 'kyllä');
  assert.equal(result.action, 'file_failed', JSON.stringify(result));
  assert.equal(result.error, 'ALV_RETURN_FILING_OVERLAP');
  assert.deepEqual(lane.transmitted, [], 'nothing reached the filing channel');
  assert.deepEqual(await snapshot(pool), before, 'no row changed: the filed quarter is history, the month stays pending');
  assert.deepEqual(lane.resolved, [], 'the ask stays open: the owner can still answer "ei"');
  assert.match(lane.sent.at(-1), /2026-Q3/, 'the owner is told which return already covers the dates');
  assert.match(lane.sent.at(-1), /lähetetty/);
  assert.match(lane.sent.at(-1), /“ei”/);
  const audits = (await pool.query("select count(*)::int as n from audit_events where action = 'alv_return.filed'")).rows[0].n;
  assert.equal(audits, 0);

  // Declining the month is still possible and frees nothing filed.
  assert.equal((await lane.reply('legacy-09', 'ei')).action, 'cancelled');
  assert.equal((await getAlvReturnByIdInDb({ firmId, clientId, alvReturnId: 'legacy-q3' })).status, 'filed');
});

test('real PG: two overlapping returns both awaiting confirmation — neither files until one is cancelled', { skip }, async t => {
  const { pool, applyRest } = await freshBook(t, 'bothpending', { upTo: '172_' });
  await insertLegacy(pool, [legacyRow('legacy-q3', '2026-Q3', 'draft_pending_confirmation'), legacyRow('legacy-08', '2026-08', 'draft_pending_confirmation')]);
  await applyRest();
  const lane = confirmLane();

  for (const id of ['legacy-q3', 'legacy-08']) {
    const result = await lane.reply(id, 'kyllä');
    assert.equal(result.action, 'file_failed', `${id}: ${JSON.stringify(result)}`);
    assert.equal(result.error, 'ALV_RETURN_FILING_OVERLAP');
  }
  assert.deepEqual(lane.transmitted, []);
  assert.match(lane.sent[0], /2026-08/, 'the quarter names the month that overlaps it');
  assert.match(lane.sent[1], /2026-Q3/, 'the month names the quarter that overlaps it');
  assert.match(lane.sent[1], /odottaa vahvistusta/);

  // Both at once: still neither transmits.
  const raced = await Promise.all([lane.reply('legacy-q3', 'kyllä', 2), lane.reply('legacy-08', 'kyllä', 2)]);
  assert.deepEqual(raced.map(r => r.error), ['ALV_RETURN_FILING_OVERLAP', 'ALV_RETURN_FILING_OVERLAP']);
  assert.deepEqual(lane.transmitted, []);

  // The owner cancels the month; the quarter may now proceed — once.
  assert.equal((await lane.reply('legacy-08', 'ei')).action, 'cancelled');
  const filed = await lane.reply('legacy-q3', 'kyllä', 3);
  assert.equal(filed.action, 'confirm_and_file', JSON.stringify(filed));
  assert.deepEqual(lane.transmitted, ['2026-Q3']);
  const statuses = (await pool.query('select period_key, status from alv_returns order by period_key')).rows.map(r => `${r.period_key}:${r.status}`);
  assert.deepEqual(statuses, ['2026-08:cancelled', '2026-Q3:filed']);
});

test('real PG: a pending return with no overlap files as before', { skip }, async t => {
  await freshBook(t, 'clean');
  const row = await createAlvReturnDraftInDb({ firmId, clientId, period: resolveAlvPeriod('2026-09'), verdict: readyVerdict(), actorId: 'member-fixture' });
  const lane = confirmLane();
  const result = await lane.reply(row.id, 'kyllä');
  assert.equal(result.action, 'confirm_and_file', JSON.stringify(result));
  assert.deepEqual(lane.transmitted, ['2026-09']);
  assert.equal((await getAlvReturnByIdInDb({ firmId, clientId, alvReturnId: row.id })).status, 'filed');
});

test('real PG: the start motion refuses a covered period before computing it or asking the owner anything', { skip }, async t => {
  const { pool } = await freshBook(t, 'start');
  const quarter = await createAlvReturnDraftInDb({ firmId, clientId, period: resolveAlvPeriod('2026-Q3'), verdict: readyVerdict(), actorId: 'member-fixture' });
  await markAlvReturnFiledInDb({ firmId, clientId, alvReturnId: quarter.id, filingReceipt: { channel: 'omavero_test', submission_id: 'SUB-2026-Q3' }, authorityBasis: { source: 'owner_whatsapp_alv_filing_confirmation' }, actorId: 'owner-fixture' });

  const computed = [];
  const delivered = [];
  const needsReview = async ({ period }) => {
    computed.push(period);
    const p = resolveAlvPeriod(period);
    return { period: p, alvReturn: readyVerdict().alvReturn, review: { status: 'needs_review', blockers: ['uncoded_revenue_lines'], uncodedRevenueLines: [{ journal_id: 'j-1', account_code: '3000', amount: 100 }] }, provenance: { deterministic: true } };
  };
  const start = (period, computeImpl = needsReview) => startFinlandAlvReturnFilingInDb({
    firmId, clientId, period, actorId: 'member-fixture',
    flagActsImpl: async () => true,
    computeImpl,
    scopeDriftImpl: async () => null,
    deliverAsksImpl: async (args) => { delivered.push(args); return { delivered: 0 }; }
  });

  await assert.rejects(start('2026-09'), (error) => {
    assert.equal(error.code, 'ALV_RETURN_PERIOD_OVERLAP');
    assert.equal(error.statusCode, 409);
    assert.deepEqual(error.details.overlapping.map(r => `${r.period_key}:${r.status}`), ['2026-Q3:filed']);
    assert.match(error.message, /2026-Q3/);
    return true;
  });
  await assert.rejects(start('2026-Q3'), { code: 'ALV_RETURN_ALREADY_LIVE' }, 'the same key keeps its refusal, also before the compute');
  assert.deepEqual(computed, [], 'nothing was computed for a period that cannot be created');
  assert.deepEqual(delivered, [], 'nobody was asked');
  const asks = (await pool.query('select count(*)::int as n from client_evidence_requests')).rows[0].n;
  assert.equal(asks, 0, 'no clarification ask was created');

  // An uncovered period still computes and asks as before.
  const escalated = await start('2026-10');
  assert.equal(escalated.action, 'escalated');
  assert.deepEqual(computed, ['2026-10']);
  assert.equal(delivered.length, 1);
});

test('real PG: the period read shows the return that already covers the requested dates', { skip }, async t => {
  await freshBook(t, 'read');
  const quarter = await createAlvReturnDraftInDb({ firmId, clientId, period: resolveAlvPeriod('2026-Q3'), verdict: readyVerdict(), actorId: 'member-fixture' });
  await markAlvReturnFiledInDb({ firmId, clientId, alvReturnId: quarter.id, filingReceipt: { channel: 'omavero_test', submission_id: 'SUB-2026-Q3' }, authorityBasis: { source: 'owner_whatsapp_alv_filing_confirmation' }, actorId: 'owner-fixture' });
  const june = await createAlvReturnDraftInDb({ firmId, clientId, period: resolveAlvPeriod('2026-06'), verdict: readyVerdict(), actorId: 'member-fixture' });
  await cancelAlvReturnInDb({ firmId, clientId, alvReturnId: june.id, reason: 'owner_declined', authorityBasis: { source: 'fixture' }, actorId: 'owner-fixture' });

  const september = await getAlvReturnForPeriodInDb({ firmId, clientId, periodKey: '2026-09' });
  assert.equal(september.lifecycle, null, 'no 2026-09 return exists');
  assert.deepEqual(september.covered_by.map(r => `${r.period_key}:${r.status}:${r.starts_on}:${r.ends_on}`), ['2026-Q3:filed:2026-07-01:2026-09-30']);

  const year = await getAlvReturnForPeriodInDb({ firmId, clientId, periodKey: '2026' });
  assert.deepEqual(year.covered_by.map(r => r.period_key), ['2026-Q3'], 'a cancelled return covers nothing');

  const own = await getAlvReturnForPeriodInDb({ firmId, clientId, periodKey: '2026-q3' });
  assert.equal(own.lifecycle.status, 'filed', 'the exact key still reads its own row');
  assert.deepEqual(own.covered_by, [], 'a return does not cover itself');

  const juneRead = await getAlvReturnForPeriodInDb({ firmId, clientId, periodKey: '2026-06' });
  assert.equal(juneRead.lifecycle.status, 'cancelled');
  assert.deepEqual(juneRead.covered_by, []);
});
