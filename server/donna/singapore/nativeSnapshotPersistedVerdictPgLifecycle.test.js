import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { createClientInDb } from '../db/clients.js';
import { getFirmSnapshotFromDb } from '../db/snapshot.js';
import { settleCommittedConvergenceMarks } from '../reconcileConvergenceState.js';

// F-33 — a native book larger than the bounded projection refresh (200 rows)
// renders the PERSISTED verdict for the rows it did not refresh, and every native
// client contributes a refreshed row so its scope is known.
test('real PG: the snapshot of a >200-row native book renders the persisted verdict for unrefreshed rows; a small second client is still refreshed', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `sg_lineage_iso_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 2000 });
  __setFirmDbPoolForTests(pool);
  // Hosted birth: native chart books are born on the hosted runtime only.
  const env = { DATABASE_URL: url.toString(), VERCEL: '1', VERCEL_PROJECT_ID: 'iso-fixture', VERCEL_ENV: 'preview',
    VERCEL_DEPLOYMENT_ID: 'iso-fixture', VERCEL_GIT_COMMIT_SHA: 'iso-fixture', DONNA_DESKTOP_BLOB_DIR: '',
    ANTHROPIC_API_KEY: 'fixture-no-network', RECONCILIATION_MATCHER_LLM_MODEL: '', UNIFIED_EXTRACTOR_MODEL: '' };
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    __resetFirmDbPoolForTests(); await pool.end(); await seed.end();
    await admin.query(`drop database "${name}"`); await admin.end();
  });
  await seed.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  for (const file of (await readdir(new URL('../../../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(`../../../db/migrations/${file}`, import.meta.url), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  const firmId = 'iso-firm', cleanFirm = 'iso-clean-firm';
  for (const firm of [firmId, cleanFirm]) {
    await seed.query('insert into firms(id,name,slug) values($1,$1,$1)', [firm]);
    await seed.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
      values($1,$2,$3,$4,'Synthetic member','admin','active','owner')`, [`member-${firm}`, firm, `user-${firm}`, `${firm}@iso.invalid`]);
  }
  const create = (id) => createClientInDb({ firmId, dbClient: seed,
    profile: { id, companyName: `Synthetic ${id}`, uen: '202300001A', jurisdiction: 'SG', entityType: 'sg-pte',
      accounting_system: 'none', accounting_view: 'management_books', defaultCurrency: 'SGD' },
    creationPrincipal: { principalType: 'firm_member', principalId: `member-${firmId}`, authoritySource: 'authenticated_firm_create_route' },
    birthContract: { id: 'sg_pte_native.v1', bookkeeping_start_date: '2026-01-01',
      registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } } });
  await create('big'); await create('small');
  const N = 230;
  await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state,account_code)
    select 'a-' || lpad(g::text,4,'0'), $1, 'big', '2026-02-15', 'Synthetic ' || g, 12, 'SGD', 'applied', '6000' from generate_series(1,$2) g`, [firmId, N]);
  await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state,account_code)
    values('z-small-line',$1,'small','2026-02-15','Synthetic small',12,'SGD','applied','6000')`, [firmId]);
  const c = await pool.connect(); try { await settleCommittedConvergenceMarks(c, { logger: null }); } finally { c.release(); }
  // The persisted verdict of the last (unrefreshed) big-book row, planted stale-terminal:
  // an enforced native scope forbids a terminal, so it must render the law's own key.
  await seed.query("update transactions set convergence_state='auto_reconciled', convergence_reason='coding_state:applied' where id='a-0230'");
  const snapshot = await getFirmSnapshotFromDb({ firmId, observedAt: '2026-03-01T00:00:00.000Z' });
  const row = id => snapshot.transactions.find(r => r.id === id);
  const persisted = Object.fromEntries((await seed.query("select id,convergence_state,convergence_reason from transactions where client_id='big' and id<>'a-0230'")).rows
    .map(r => [r.id, [r.convergence_state, r.convergence_reason]]));
  const rendered = Object.keys(persisted).filter(id => row(id).processing_scope.review_reason === 'projection_not_current');
  assert.ok(rendered.length > 0, 'the fixture exceeds the refresh window');
  for (const id of Object.keys(persisted)) {
    assert.deepEqual([row(id).convergence_state, row(id).convergence_reason], persisted[id], `${id} renders its persisted verdict`);
  }
  assert.deepEqual([row('a-0230').convergence_state, row('a-0230').convergence_reason], ['hanging', 'processing_review_only'],
    'a terminal the enforced scope forbids renders the law\'s key, not a blanket stalled marker');
  assert.notEqual(row('z-small-line').processing_scope.review_reason, 'projection_not_current', 'the second client is refreshed');
  assert.notEqual(row('z-small-line').projection_freshness.reason, 'projection_batch_limit');
});
