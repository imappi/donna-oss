import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { createClientInDb } from '../db/clients.js';
import { getFirmSnapshotFromDb } from '../db/snapshot.js';
import { recoverChangedCodingEvidenceInDb } from '../db/codingEvidence.js';

// F-26 / F-34 — a client the recovery worker cannot process (fence starved by an
// insert stream, or a corrupt native lineage) is receipted through the existing
// runtime-policy incident writer, counted, and closed by its next clean tick.
test('real PG: recovery skips are receipted as coalesced runtime incidents and close on the next clean tick', async t => {
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
  await create('nat');
  await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state,account_code,payload)
    values('nat-line',$1,'nat','2026-02-15','Synthetic',12,'SGD','applied','6000','{"review_scope":{"stale":true}}'::jsonb)`, [firmId]);
  const incidents = async (action) => (await seed.query(`select id,action,metadata from audit_events where client_id='nat' and action=$1 order by id`, [action])).rows;
  const run = () => recoverChangedCodingEvidenceInDb({ firmId });

  // Baseline: a healthy, uncontended native client is not skipped and mints nothing.
  assert.deepEqual((await run()).filter(r => r.skipped), []);
  assert.equal((await incidents('transaction.coding.policy_failed')).length, 0);

  // F-26: an ordinary insert in flight holds FOR KEY SHARE on the client row; the
  // worker's NOWAIT fence is refused. Before: console.warn only, no receipt.
  const writer = new pg.Client({ connectionString: url.toString() }); await writer.connect();
  try {
    await writer.query('begin');
    await writer.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      values('nat-stream',$1,'nat','2026-02-16','stream',1,'SGD')`, [firmId]);
    // A refused post sends the applied native review through the per-case fence.
    await seed.query(`update transactions set payload = payload || '{"ledger_post_refusal":{"code":"SYNTHETIC"}}'::jsonb where id='nat-line'`);
    const first = await run();
    const skipped = first.filter(r => r.skipped);
    assert.equal(skipped.length, 1, JSON.stringify(first));
    {
      assert.equal(skipped[0].state, 'contended');
      const rows = await incidents('transaction.coding.policy_failed');
      assert.equal(rows.length, 1, 'the skip is receipted durably');
      assert.equal(rows[0].metadata.reason_detail, 'evidence_recovery_starved');
      await run(); await run();
      assert.equal((await incidents('transaction.coding.policy_failed')).length, 1, 'coalesced per client per window — no spam');
    }
    await writer.query('rollback');
  } finally { await writer.end(); }
  const clean = await run();
  assert.deepEqual(clean.filter(r => r.skipped), []);
  const failed = await incidents('transaction.coding.policy_failed');
  const recovered = await incidents('transaction.coding.policy_recovered');
  assert.equal(recovered.length, failed.length, 'a clean tick closes the stall through the incident writer');

  // F-34: a corrupt native lineage is receipted once as an escalated incident and
  // counted as refused (not failed); repairing it closes the incident.
  const account = (await seed.query('select id from ledger_accounts where client_id=$1 order by id limit 1', ['nat'])).rows[0].id;
  const before = (await seed.query('select payload from ledger_accounts where id=$1', [account])).rows[0].payload;
  await seed.query("update ledger_accounts set payload=payload || '{\"birth_contract\":\"synthetic_partial\"}'::jsonb where id=$1", [account]);
  const ran = await run(); const refused = ran.filter(r => r.skipped);
  assert.equal(refused[0]?.state, 'refused', JSON.stringify(refused));
  const refusedReceipts = (await incidents('transaction.coding.policy_failed')).filter(r => r.metadata.reason_code === 'NATIVE_REVIEW_REFUSED');
  assert.equal(refusedReceipts.length, 1);
  assert.equal(refusedReceipts[0].metadata.escalation_required, true);
  await run();
  assert.equal((await incidents('transaction.coding.policy_failed')).filter(r => r.metadata.reason_code === 'NATIVE_REVIEW_REFUSED').length, 1, 'coalesced');
  await seed.query('update ledger_accounts set payload=$2::jsonb where id=$1', [account, JSON.stringify(before)]);
  assert.deepEqual((await run()).filter(r => r.skipped), []);
  assert.ok((await incidents('transaction.coding.policy_recovered')).length > recovered.length, 'repair closes the refusal incident');
});
