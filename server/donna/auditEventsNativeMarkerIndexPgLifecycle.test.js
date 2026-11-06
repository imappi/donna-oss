import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { ELIGIBLE_LINES_SQL, DISCOVER_LEDGER_POST_CLIENTS_SQL } from './ledgerAutoPost.js';
import { retainedNativeMarkerSql, readNativeChartReceipts } from './nativeChartLineage.js';

// The retained-native marker and the receipt reader probe audit_events by
// (firm_id, resource_id, action). Migration 157 owns the index; this proves the
// real call sites use it (not a firm-wide scan) and that the once-per-client
// rewrite of the two ledger-post queries keeps the marker's semantics.
const plan = async (db, sql, params) => (await db.query(`explain (costs off) ${sql}`, params)).rows.map(r => r['QUERY PLAN']).join('\n');
const INDEX = 'audit_events_firm_resource_action_idx';

test('real PG: native marker + receipt probes use the audit_events resource index', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `audit_idx_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() }); await db.connect();
  t.after(async () => { await db.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await db.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await db.query(await readFile(new URL(file, dir), 'utf8'));
    await db.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await db.query(`insert into firms(id,name,slug) values('f','f','f'),('g','g','g')`);
  for (const id of ['native', 'plain']) await db.query(`insert into clients(id,firm_id,company_name) values($1,'f',$1)`, [id]);
  // Bulk history seeded with the statement triggers off; the seed is not the subject.
  await db.query(`alter table audit_events disable trigger user; alter table transactions disable trigger user`);
  await db.query(`insert into audit_events(firm_id,action,resource_type,resource_id,metadata)
    values('f','client.create','client','native','{"native_chart_birth":true}')`);
  await db.query(`insert into audit_events(firm_id,action,resource_type,resource_id)
    select case when g%10=0 then 'g' else 'f' end,(array['ledger.auto_post_refused','transaction.ai_suggest','ledger.post'])[1+g%3],
      'transaction','tx'||g from generate_series(1,30000) g`);
  await db.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state)
    select 'tx'||g,'f',case when g%2=0 then 'native' else 'plain' end,'2026-01-01','d',1,'SGD','applied' from generate_series(1,2000) g`);
  await db.query(`alter table audit_events enable trigger user; alter table transactions enable trigger user`);
  await db.query('analyze');

  const probes = {
    receipts: [`select id from audit_events where firm_id=$1 and resource_id=$2 and action = any($3::text[]) order by id`,
      ['f', 'plain', ['client.create', 'client.delete', 'ledger.chart.palette_seeded']]],
    eligible: [ELIGIBLE_LINES_SQL, ['f', 'plain', 20, null]],
    discovery: [DISCOVER_LEDGER_POST_CLIENTS_SQL, ['f', 100]],
    perRowMarker: [`select id from transactions t where firm_id=$1 and id=$2 and not ${retainedNativeMarkerSql('t')}`, ['f', 'tx1']]
  };
  for (const [label, [sql, params]] of Object.entries(probes)) {
    const text = await plan(db, sql, params);
    assert.match(text, new RegExp(INDEX), `${label} must use ${INDEX}:\n${text}`);
    assert.doesNotMatch(text, /Seq Scan on audit_events/, `${label} must not scan audit_events:\n${text}`);
  }

  // Same answers as the per-row marker: the native client stays excluded.
  assert.deepEqual((await db.query(DISCOVER_LEDGER_POST_CLIENTS_SQL, ['f', 100])).rows, [{ client_id: 'plain', unposted_lines: 1000 }]);
  assert.equal((await db.query(ELIGIBLE_LINES_SQL, ['f', 'native', 20, null])).rows.length, 0);
  assert.equal((await db.query(ELIGIBLE_LINES_SQL, ['f', 'plain', 20, null])).rows.length, 20);
  assert.equal((await readNativeChartReceipts({ query: (s, p) => db.query(s, p), firmId: 'f', clientId: 'native' })).length, 1);
  // A later client.delete retires the birth receipt exactly as before.
  await db.query(`insert into audit_events(firm_id,action,resource_type,resource_id) values('f','client.delete','client','native')`);
  assert.equal((await db.query(ELIGIBLE_LINES_SQL, ['f', 'native', 20, null])).rows.length, 20);
});
