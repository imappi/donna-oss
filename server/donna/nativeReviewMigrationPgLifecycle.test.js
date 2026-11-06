import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { retainedNativeMarkerSql } from './nativeChartLineage.js';

// F-24 / F-23: the native-review migration series is safe whether or not 155-157
// were already applied. The runner has no checksum verification, so 156 itself
// creates the audit_events probe index before any trigger or backfill; 157 is a
// no-op; 158 owns the (client-scoped, idempotent) backfill.
const MIGRATIONS = new URL('../../db/migrations/', import.meta.url);
const read = file => readFile(new URL(file, MIGRATIONS), 'utf8');

test('migration 156 creates the audit probe index before any trigger or backfill and mints nothing itself', async () => {
  const sql = await read('156_native_review_source_marks.sql');
  const index = sql.indexOf('create index if not exists audit_events_firm_resource_action_idx');
  assert.ok(index >= 0);
  assert.ok(index < sql.indexOf('create trigger'), 'index precedes every trigger');
  assert.ok(index < sql.indexOf('create or replace function mark_native_review_sources'));
  assert.equal(/select\s+mark_native_review_sources\(/i.test(sql), false, '156 no longer backfills (158 owns it)');
  assert.match(await read('157_audit_events_resource_action_index.sql'), /create index if not exists audit_events_firm_resource_action_idx/);
});

test('real PG: on a 200k-event pre-lane database the marker probe is index-served inside 156, and the series is idempotent', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL }); await admin.connect();
  const name = `native_migration_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() }); await db.connect();
  t.after(async () => { await db.end(); await admin.query(`drop database "${name}"`); await admin.end(); });
  await db.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const files = (await readdir(MIGRATIONS)).filter(f => f.endsWith('.sql')).sort();
  const upTo155 = files.filter(f => f.slice(0, 3) <= '155');
  for (const file of upTo155) await db.query(await read(file));

  // A native client (retained birth audit) among many others, with 200k audit events.
  await db.query("insert into firms(id,name,slug) values('mf','mf','mf')");
  await db.query(`insert into clients(id,firm_id,company_name,jurisdiction)
    select 'mc-'||n,'mf','Synthetic '||n,'SG' from generate_series(1,100) n`);
  await db.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
    select 'mt-'||n,'mf','mc-'||(1+n%100),date '2026-02-01','Synthetic '||n,1,'SGD' from generate_series(1,5000) n`);
  await db.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    select 'mf','mc-'||(1+n%100),'system','x','synthetic.event','client','mc-'||(1+n%100),'{}' from generate_series(1,200000) n`);
  await db.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values('mf','mc-1','system','donna','ledger.chart.palette_seeded','client','mc-1','{"birth_contract":"synthetic"}')`);
  await db.query('analyze');

  // 156 as one transaction (the runner's shape): the probe is index-served at the
  // point the (formerly slow) backfill used to run.
  await db.query('begin');
  await db.query(await read('156_native_review_source_marks.sql'));
  const plan = JSON.stringify((await db.query(`explain (format json) select 1 from transactions t
    where t.firm_id='mf' and t.id='mt-100' and ${retainedNativeMarkerSql('t')}`)).rows[0]['QUERY PLAN']);
  assert.match(plan, /audit_events_firm_resource_action_idx/);
  assert.equal(/"Node Type":\s*"Seq Scan","[^}]*"Relation Name":\s*"audit_events"/.test(plan), false, plan);
  const probeStarted = performance.now();
  await db.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency) values('mt-probe','mf','mc-1','2026-02-01','probe',1,'SGD')");
  assert.ok(performance.now() - probeStarted < 2000, 'a single-row insert no longer scans the 200k-event history');
  await db.query('commit');
  await db.query(await read('157_audit_events_resource_action_index.sql'));

  const marks = async () => (await db.query(`select client_id,source,target_type,count(*)::int n from convergence_marks
    where source like 'native_review_%' group by 1,2,3 order by 1,2,3`)).rows;
  // (Between 156 and 158 the 156 function is still the old per-transaction owner.)
  assert.ok((await marks()).length >= 1);

  // Legacy state a database that already ran the old 156 carries: one mark per transaction.
  await db.query("delete from convergence_marks where source like 'native_review_%'");
  await db.query(`insert into convergence_marks(firm_id,client_id,target_type,target_id,source)
    select firm_id,client_id,'transaction',id,'native_review_source' from transactions where client_id='mc-1'`);
  await db.query(`insert into convergence_marks(firm_id,client_id,target_type,target_id,source)
    select firm_id,client_id,'transaction',id,'native_review_source' from transactions where client_id='mc-1'`);
  const legacyCount = (await db.query("select count(*)::int n from convergence_marks where target_type='transaction' and source='native_review_source'")).rows[0].n;
  assert.ok(legacyCount >= 100);

  const m158 = await read('158_native_review_client_marks.sql');
  await db.query('begin'); await db.query(m158); await db.query('commit');
  const first = await marks();
  assert.deepEqual(first, [{ client_id: 'mc-1', source: 'native_review_scope', target_type: 'client', n: 1 }],
    'the duplicated per-transaction marks collapse into ONE client scope mark; non-native clients get none');
  assert.equal((await db.query("select count(*)::int n from convergence_marks where target_type='transaction' and source='native_review_source'")).rows[0].n, 0);
  // Running the series again changes nothing.
  await db.query('begin'); await db.query(m158); await db.query('commit');
  await db.query(await read('157_audit_events_resource_action_index.sql'));
  assert.deepEqual(await marks(), first);
  // A native-client source change is de-duplicated against the unsettled scope mark.
  await db.query("insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency) values('mt-again','mf','mc-1','2026-02-01','again',1,'SGD')");
  assert.deepEqual(await marks(), first);
});
