// ALV return drafts may not overlap a live return of the same client.
//
// Uniqueness used to be per period KEY only (alv_returns_live_period_idx), so
// after a verokausi change a monthly '2026-09' draft could be minted while a
// pending or filed quarterly '2026-Q3' already covered the same dates — the
// same sales and purchases reported twice. These tests drive the real writer
// (createAlvReturnDraftInDb / markAlvReturnFiledInDb) against PostgreSQL.
// node --test server/donna/finlandAlvReturnOverlapPgLifecycle.test.js
import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';
import { createAlvReturnDraftInDb, markAlvReturnFiledInDb, cancelAlvReturnInDb } from './statutoryRegistry.js';
import { resolveAlvPeriod } from './finland/alvReturn.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;
const firmId = 'alv-overlap-proof';
const clientId = 'fi-overlap', otherClientId = 'fi-overlap-other';
const migrationsDir = new URL('../../db/migrations/', import.meta.url);

const readyVerdict = () => ({
  alvReturn: { boxes: { 301: 25.5, 307: 0, 308: 25.5 }, payable: 25.5, refund: false, nilReturn: false },
  review: { status: 'ready', blockers: [] },
  provenance: { source: 'ledger_read_model', deterministic: true }
});

async function freshBook(t, label, { upTo = null } = {}) {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_alv_${label}_${process.pid}_${Date.now().toString(36)}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = '/' + name;
  const pool = new pg.Pool({ connectionString: url.toString() });
  __setFirmDbPoolForTests(pool);
  t.after(async () => { __resetFirmDbPoolForTests(); await pool.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await pool.query('create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const files = (await readdir(migrationsDir)).filter(n => n.endsWith('.sql')).sort();
  const apply = async (filter) => { for (const file of files.filter(filter)) await pool.query(await readFile(new URL(file, migrationsDir), 'utf8')); };
  await apply(file => !upTo || file < upTo);
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic overlap proof',$1)", [firmId]);
  for (const [id, label2] of [[clientId, 'Synthetic Overlap Oy'], [otherClientId, 'Synthetic Neighbour Oy']]) {
    await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$3,'FI','fi-oy','{}')", [id, firmId, label2]);
  }
  return { pool, applyRest: () => apply(file => upTo && file >= upTo) };
}

const draft = (key, client = clientId) => createAlvReturnDraftInDb({ firmId, clientId: client, period: resolveAlvPeriod(key), verdict: readyVerdict(), actorId: 'member-fixture' });
const file = (row) => markAlvReturnFiledInDb({ firmId, clientId: row.client_id, alvReturnId: row.id, filingReceipt: { channel: 'omavero_test', submission_id: `SUB-${row.period_key}` }, authorityBasis: { source: 'owner_whatsapp_alv_filing_confirmation' }, actorId: 'owner-fixture' });
const snapshot = async (pool) => (await pool.query('select id, period_key, status, starts_on::text, ends_on::text, verdict, filing_receipt, filed_at, updated_at from alv_returns order by id')).rows;
const overlapRefusal = (covering) => (error) => {
  assert.equal(error.code, 'ALV_RETURN_PERIOD_OVERLAP');
  assert.equal(error.statusCode, 409);
  assert.deepEqual(error.details.overlapping.map(r => `${r.period_key}:${r.status}`), covering);
  assert.match(error.message, /already covers/);
  return true;
};

test('real PG: a monthly draft inside a FILED quarterly return is refused, and the filed return is untouched', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool } = await freshBook(t, 'filed');
  const quarter = await file(await draft('2026-Q3'));
  assert.equal(quarter.status, 'filed');
  const before = await snapshot(pool);

  await assert.rejects(draft('2026-09'), overlapRefusal(['2026-Q3:filed']));
  await assert.rejects(draft('2026'), overlapRefusal(['2026-Q3:filed']), 'a yearly return over the same dates is refused too');
  assert.deepEqual(await snapshot(pool), before, 'no row inserted, the filed return unchanged');
  const audits = (await pool.query("select count(*)::int as n from audit_events where action = 'alv_return.draft_created'")).rows[0].n;
  assert.equal(audits, 1, 'a refused draft leaves no audit event behind');

  // Adjacent periods and other clients are unaffected.
  assert.equal((await draft('2026-10')).status, 'draft_pending_confirmation');
  assert.equal((await draft('2026-06')).status, 'draft_pending_confirmation');
  assert.equal((await draft('2026-09', otherClientId)).status, 'draft_pending_confirmation');
});

test('real PG: a PENDING return blocks overlapping drafts; a cancelled one frees its dates', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool } = await freshBook(t, 'pending');
  const august = await draft('2026-08');
  await assert.rejects(draft('2026-Q3'), overlapRefusal(['2026-08:draft_pending_confirmation']));
  await assert.rejects(draft('2026-08'), { code: 'ALV_RETURN_ALREADY_LIVE' }, 'the same key keeps its existing refusal');
  await cancelAlvReturnInDb({ firmId, clientId, alvReturnId: august.id, reason: 'owner_declined', authorityBasis: { source: 'fixture' }, actorId: 'owner-fixture' });
  const quarter = await draft('2026-Q3');
  assert.equal(quarter.period_key, '2026-Q3');
  const statuses = (await pool.query('select period_key, status from alv_returns order by period_key')).rows.map(r => `${r.period_key}:${r.status}`);
  assert.deepEqual(statuses, ['2026-08:cancelled', '2026-Q3:draft_pending_confirmation']);
});

// The quarter overlaps both months; the two months do not overlap each other.
// The writer and the trigger serialise a client's drafts on one advisory lock,
// so the outcome is decided by who takes the lock first: the quarter alone, or
// both months (the quarter refused). The rule, whatever the order: no two
// created returns share a date, and every refused draft names the created
// returns it overlaps.
const RACE_KEYS = ['2026-Q3', '2026-09', '2026-07'];
const overlaps = (a, b) => a.starts_on <= b.ends_on && a.ends_on >= b.starts_on;
const expectedFor = (order) => {
  const created = [];
  const refused = {};
  for (const key of order) {
    const period = resolveAlvPeriod(key);
    const covering = created.filter(c => overlaps(c, period)).sort((a, b) => a.starts_on.localeCompare(b.starts_on) || a.key.localeCompare(b.key));
    if (covering.length) refused[key] = covering.map(c => `${c.key}:draft_pending_confirmation`);
    else created.push(period);
  }
  return { created: created.map(c => c.key).sort(), refused };
};
const assertRaceRule = async (pool, results, clientKey) => {
  const outcome = Object.fromEntries(RACE_KEYS.map((key, i) => [key, results[i]]));
  const created = RACE_KEYS.filter(key => outcome[key].status === 'fulfilled').sort();
  assert.ok([['2026-Q3'], ['2026-07', '2026-09']].some(valid => JSON.stringify(valid) === JSON.stringify(created)),
    `either the quarter alone or both months: ${JSON.stringify(created)}`);
  // A refusal names what was live when it ran: created returns it overlaps
  // (a month created after the quarter was refused is not named by it).
  for (const key of RACE_KEYS.filter(k => outcome[k].status === 'rejected')) {
    const error = outcome[key].reason;
    assert.equal(error.code, 'ALV_RETURN_PERIOD_OVERLAP', `${key}: ${error.message}`);
    const named = error.details.overlapping.map(r => r.period_key);
    assert.ok(named.length, `${key} was refused without naming what covers it`);
    for (const c of named) {
      assert.ok(created.includes(c) && overlaps(resolveAlvPeriod(c), resolveAlvPeriod(key)), `${key} names ${c}, which is not a created return over its dates`);
    }
  }
  const live = (await pool.query("select period_key, starts_on::text, ends_on::text from alv_returns where client_id = $1 and status in ('draft_pending_confirmation','filed') order by starts_on", [clientKey])).rows;
  assert.deepEqual(live.map(r => r.period_key).sort(), created, 'the rows are exactly the created returns');
  for (let i = 0; i < live.length; i += 1) for (let j = i + 1; j < live.length; j += 1) {
    assert.ok(!overlaps(live[i], live[j]), `two created returns share dates: ${JSON.stringify([live[i], live[j]])}`);
  }
  return created;
};

test('real PG: overlapping drafts started at the same moment — no two created returns share a date', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool } = await freshBook(t, 'race');
  const results = await Promise.allSettled(RACE_KEYS.map(key => draft(key)));
  t.diagnostic(`created: ${JSON.stringify(await assertRaceRule(pool, results, clientId))}`);
});

test('real PG: every order of three contending drafts, forced through the writer’s own lock', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool } = await freshBook(t, 'order');
  const orders = [];
  const permute = (rest, prefix = []) => rest.length ? rest.forEach((k, i) => permute([...rest.slice(0, i), ...rest.slice(i + 1)], [...prefix, k])) : orders.push(prefix);
  permute(RACE_KEYS);
  assert.equal(orders.length, 6);
  const waiting = async () => (await pool.query(
    "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted and database = (select oid from pg_database where datname = current_database())")).rows[0].n;
  for (const [n, order] of orders.entries()) {
    const orderClient = `fi-overlap-order-${n}`;
    await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,$3,'FI','fi-oy','{}')", [orderClient, firmId, `Synthetic Order ${n} Oy`]);
    // Hold the client's period lock, queue the drafts on it one at a time in
    // this order (PostgreSQL grants queued conflicting requests in arrival
    // order), then let them through.
    const holder = await pool.connect();
    const pending = {};
    try {
      await holder.query('begin');
      await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`alv-return-periods:${firmId}:${orderClient}`]);
      for (const [i, key] of order.entries()) {
        pending[key] = draft(key, orderClient).then(value => ({ status: 'fulfilled', value }), reason => ({ status: 'rejected', reason }));
        let queued = false;
        for (let attempt = 0; attempt < 250 && !queued; attempt += 1) {
          queued = (await waiting()) === i + 1;
          if (!queued) await new Promise(resolve => setTimeout(resolve, 20));
        }
        assert.ok(queued, `order ${order}: ${key} did not queue on the period lock`);
      }
      await holder.query('commit');
    } finally { holder.release(); }
    const results = await Promise.all(RACE_KEYS.map(key => pending[key]));
    const expected = expectedFor(order);
    const created = await assertRaceRule(pool, results, orderClient);
    assert.deepEqual(created, expected.created, `order ${order.join(' → ')}`);
    for (const [key, covering] of Object.entries(expected.refused)) overlapRefusal(covering)(results[RACE_KEYS.indexOf(key)].reason);
    t.diagnostic(`${order.join(' → ')}: created ${JSON.stringify(created)}`);
  }
});

test('real PG: the database refuses an overlapping live row even outside the writer', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool } = await freshBook(t, 'trigger');
  await file(await draft('2026-Q3'));
  await assert.rejects(
    pool.query("insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status) values('raw-1',$1,$2,'2026-09','month','2026-09-01','2026-09-30','draft_pending_confirmation')", [firmId, clientId]),
    (error) => error.code === '23P01' && /alv_returns_live_period_overlap/.test(error.message)
  );
  // A cancelled row is history, not a live claim on the dates.
  await pool.query("insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status) values('raw-2',$1,$2,'2026-09','month','2026-09-01','2026-09-30','cancelled')", [firmId, clientId]);
  await assert.rejects(pool.query("update alv_returns set status = 'draft_pending_confirmation' where id = 'raw-2'"), { code: '23P01' });
});

test('real PG: migration 172 applies over already-overlapping rows without changing them', { skip: !pgUrl && 'DONNA_PG_TEST_URL required' }, async t => {
  const { pool, applyRest } = await freshBook(t, 'legacy', { upTo: '172_' });
  // The shape the bug could already have left behind: a filed quarter and a
  // pending month over the same dates.
  await pool.query(`insert into alv_returns(id,firm_id,client_id,period_key,period_type,starts_on,ends_on,status,filed_at,filed_by) values
    ('legacy-q3',$1,$2,'2026-Q3','quarter','2026-07-01','2026-09-30','filed',now(),'owner-fixture'),
    ('legacy-09',$1,$2,'2026-09','month','2026-09-01','2026-09-30','draft_pending_confirmation',null,null)`, [firmId, clientId]);
  const before = await snapshot(pool);
  await applyRest();
  assert.deepEqual(await snapshot(pool), before, 'existing returns are history: the migration alters none');
  // From here on, no new overlap — including against the legacy pair.
  await assert.rejects(draft('2026-08'), overlapRefusal(['2026-Q3:filed']));
  // Filing the legacy pending month is a status change on an existing row,
  // not a new claim, so the database does not block it; it stays visible.
  const legacy = (await pool.query("select * from alv_returns where id = 'legacy-09'")).rows[0];
  assert.equal(legacy.status, 'draft_pending_confirmation');
});
