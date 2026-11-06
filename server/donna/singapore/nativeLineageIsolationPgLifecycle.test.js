import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { createClientInDb } from '../db/clients.js';
import { getFirmSnapshotFromDb } from '../db/snapshot.js';
import {
  TRANSACTION_GATHER_SQL, computeConvergenceForTransactions, projectGatheredTransaction,
  recomputeConvergenceDrift, settleCommittedConvergenceMarks, installConvergenceSettleOnPool, settleConvergenceMarks
} from '../reconcileConvergenceState.js';

// One partially-marked native book is ITS client's violation, never the firm's
// outage: the snapshot, the settle sweep and the nightly drift read every other
// client exactly as before, and the invalid client's rows hang visibly under
// `native_chart_lineage_invalid` (the admission refusal's own reason key).
test('real PG: an invalid native lineage is isolated to its client on snapshot, settle and drift', async t => {
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
  const create = (firm, id, jurisdiction, native = false) => createClientInDb({ firmId: firm, dbClient: seed,
    profile: { id, companyName: `Synthetic ${id}`, uen: '202300001A', jurisdiction,
      entityType: jurisdiction === 'SG' ? 'sg-pte' : 'fi-oy', accounting_system: 'none',
      accounting_view: 'management_books', defaultCurrency: jurisdiction === 'SG' ? 'SGD' : 'EUR' },
    creationPrincipal: { principalType: 'firm_member', principalId: `member-${firm}`, authoritySource: 'authenticated_firm_create_route' },
    ...(native ? { birthContract: { id: 'sg_pte_native.v1', bookkeeping_start_date: '2026-01-01',
      registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } } } : {}) });
  await create(firmId, 'fi-neighbor', 'FI');
  await create(firmId, 'sg-legacy', 'SG');
  await create(firmId, 'sg-native', 'SG', true);
  await create(cleanFirm, 'fi-clean', 'FI');
  const tx = (id, firm, client, currency, codingState = null) => seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency,coding_state,account_code)
    values($1,$2,$3,'2026-02-15',$4,12,$5,$6,$7)`, [id, firm, client, `Synthetic ${id}`, currency, codingState, codingState ? '6000' : null]);
  await tx('fi-applied', firmId, 'fi-neighbor', 'EUR', 'applied');
  await tx('sg-legacy-line', firmId, 'sg-legacy', 'SGD', 'applied');
  await tx('sg-native-line', firmId, 'sg-native', 'SGD', 'applied');
  await tx('fi-clean-line', cleanFirm, 'fi-clean', 'EUR', 'applied');
  await tx('fi-clean-open', cleanFirm, 'fi-clean', 'EUR');
  const convergence = async id => (await seed.query('select convergence_state,convergence_reason from transactions where id=$1', [id])).rows[0];
  const marksFor = async client => (await seed.query('select distinct target_id from convergence_marks where client_id=$1 order by target_id', [client])).rows.map(r => r.target_id);
  const settleAll = async () => { const c = await pool.connect(); try { return await settleCommittedConvergenceMarks(c, { logger: null }); } finally { c.release(); } };
  await settleAll();

  // The healthy baseline, captured BEFORE any marker is corrupted.
  const snapshotRow = (snapshot, id) => snapshot.transactions.find(row => row.id === id);
  const healthy = await getFirmSnapshotFromDb({ firmId, observedAt: '2026-03-01T00:00:00.000Z' });
  assert.equal(snapshotRow(healthy, 'fi-applied').convergence_state, 'auto_reconciled');
  assert.equal(snapshotRow(healthy, 'sg-legacy-line').convergence_state, 'auto_reconciled');
  const nativeBaseline = snapshotRow(healthy, 'sg-native-line');
  assert.deepEqual([nativeBaseline.convergence_state, nativeBaseline.convergence_reason], ['hanging', 'processing_review_only']);

  // The reviewer's reproduction: ONE partial native marker on a legacy book.
  const account = (await seed.query('select id from ledger_accounts where client_id=$1 order by id limit 1', ['sg-legacy'])).rows[0].id;
  await seed.query("update ledger_accounts set payload=payload || '{\"birth_contract\":\"synthetic_partial\"}'::jsonb where id=$1", [account]);

  await t.test('(a) the firm snapshot loads; neighbours intact; the invalid client hangs under its own reason', async () => {
    const snapshot = await getFirmSnapshotFromDb({ firmId, observedAt: '2026-03-01T00:00:00.000Z' });
    const fi = snapshotRow(snapshot, 'fi-applied');
    assert.deepEqual(fi, snapshotRow(healthy, 'fi-applied'), 'FI neighbour row byte-identical to the healthy baseline');
    assert.deepEqual(snapshot.clients.find(c => c.id === 'fi-neighbor'), healthy.clients.find(c => c.id === 'fi-neighbor'));
    const invalid = snapshotRow(snapshot, 'sg-legacy-line');
    assert.deepEqual([invalid.convergence_state, invalid.convergence_reason], ['hanging', 'native_chart_lineage_invalid']);
    assert.equal(invalid.processing_scope.enforced, true);
    assert.equal(invalid.processing_scope.review_current, false);
    assert.equal(invalid.accounting_ready, false);
    assert.deepEqual(invalid.projection_freshness, { status: 'incomplete', reason: 'native_chart_lineage_invalid', pending_targets: 0 });
    const native = snapshotRow(snapshot, 'sg-native-line');
    assert.deepEqual([native.convergence_state, native.convergence_reason], ['hanging', 'processing_review_only'],
      'healthy native neighbour projects exactly as before');
    assert.deepEqual(native.processing_scope, nativeBaseline.processing_scope);
    // Deleting every pending mark changes nothing: the read itself is isolated.
    await seed.query('delete from convergence_marks');
    const again = await getFirmSnapshotFromDb({ firmId, observedAt: '2026-03-01T00:00:00.000Z' });
    assert.equal(snapshotRow(again, 'sg-legacy-line').convergence_reason, 'native_chart_lineage_invalid');
  });

  await t.test('(b) the committed-marks sweep settles the FI neighbour and consumes the invalid client\'s marks after writing its verdict', async () => {
    await seed.query('delete from convergence_marks');
    await seed.query("update transactions set convergence_state=null,convergence_reason=null,convergence_as_of=null where id in ('fi-applied','sg-legacy-line')");
    await seed.query("update transactions set payload=payload || '{\"synthetic_touch\":true}'::jsonb where id in ('fi-applied','sg-legacy-line')");
    assert.deepEqual(await marksFor('fi-neighbor'), ['fi-applied']);
    assert.deepEqual(await marksFor('sg-legacy'), ['sg-legacy', 'sg-legacy-line'], 'the row mark plus the client-scoped native dependency mark');
    const settled = await settleAll();
    assert.equal(settled.error, undefined, JSON.stringify(settled));
    assert.ok(settled.claimed >= 2);
    assert.deepEqual(await convergence('fi-applied'), { convergence_state: 'auto_reconciled', convergence_reason: 'coding_state:applied' });
    assert.deepEqual(await convergence('sg-legacy-line'), { convergence_state: 'hanging', convergence_reason: 'native_chart_lineage_invalid' });
    assert.deepEqual(await marksFor('fi-neighbor'), []);
    assert.deepEqual(await marksFor('sg-legacy'), [], 'the hanging verdict is persisted; the sweep does not re-fail forever');
    // The nightly recompute agrees with what the settle wrote: no drift.
    const drift = await recomputeConvergenceDrift(seed, { firmId });
    assert.equal(drift.transactions_checked, 3, 'the firm-wide recompute completes across every client');
    assert.deepEqual(drift.drifted_sample.filter(row => ['sg-legacy-line', 'fi-applied'].includes(row.target_id)), [],
      JSON.stringify(drift.drifted_sample));
  });

  await t.test('(c) a clean firm with no native marker projects through the unchanged legacy path', async () => {
    const ids = ['fi-clean-line', 'fi-clean-open'];
    const computed = await computeConvergenceForTransactions(seed, { firmId: cleanFirm, transactionIds: ids });
    const gathered = (await seed.query(TRANSACTION_GATHER_SQL, [cleanFirm, ids])).rows;
    assert.deepEqual(computed.map(row => Object.keys(row).sort()), ids.map(() => ['client_id', 'derived', 'persisted', 'target_id', 'target_type']));
    assert.deepEqual(computed.map(row => row.derived), gathered.map(row => projectGatheredTransaction(row)));
    const snapshot = await getFirmSnapshotFromDb({ firmId: cleanFirm, observedAt: '2026-03-01T00:00:00.000Z' });
    for (const row of snapshot.transactions) {
      assert.equal('processing_scope' in row, false);
      assert.equal('projection_freshness' in row, false);
    }
  });

  await t.test('(d) a real database failure on the invalid client still propagates', async () => {
    const holder = new pg.Client({ connectionString: url.toString() }); await holder.connect();
    try {
      await holder.query('begin');
      // The native reader reads the company row; marker discovery does not.
      await holder.query('lock table clients in access exclusive mode');
      await seed.query('begin');
      await seed.query("set local lock_timeout = '200ms'");
      await assert.rejects(() => computeConvergenceForTransactions(seed, { firmId, transactionIds: ['sg-legacy-line'] }),
        error => error.code === '55P03');
      await seed.query('rollback');
    } finally { await holder.query('rollback'); await holder.end(); }
  });

  // F-22: EVERY typed native refusal is the client's scoped violation, not just
  // the lineage one. A `client.profile.update` audit row whose native_registration
  // does not verify is creatable by anyone with the profile route and can never
  // be removed (audit_events is append-only), so it must not wedge the global sweep.
  await t.test('(e) an unverifiable registration revision on one client hangs ITS rows under the refusal reason; the global sweep still settles another firm and leaves a receipt once', async () => {
    await seed.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
      values($1,'sg-native','firm_member','member-iso-firm','client.profile.update','client','sg-native','{"native_registration":{"bogus":true}}')`, [firmId]);
    await seed.query('delete from convergence_marks');
    await seed.query("update transactions set convergence_state=null,convergence_reason=null,convergence_as_of=null where id in ('sg-native-line','fi-clean-open')");
    await seed.query("update transactions set payload=payload || '{\"synthetic_touch\":2}'::jsonb where id in ('sg-native-line','fi-clean-open')");
    assert.deepEqual(await marksFor('sg-native'), ['sg-native', 'sg-native-line']);
    assert.deepEqual(await marksFor('fi-clean'), ['fi-clean-open']);
    const settled = await settleAll();
    assert.equal(settled.error, undefined, JSON.stringify(settled));
    assert.equal(settled.failed_firms, undefined, 'a typed refusal is a verdict, not a failed scope');
    assert.deepEqual(await convergence('sg-native-line'),
      { convergence_state: 'hanging', convergence_reason: 'native_review_refused:revision_chain_invalid' });
    assert.notEqual((await convergence('fi-clean-open')).convergence_state, null, 'the other firm settled in the same sweep');
    assert.deepEqual(await marksFor('sg-native'), []);
    assert.deepEqual(await marksFor('fi-clean'), []);
    const receipts = async () => (await seed.query(`select metadata from audit_events where client_id='sg-native'
      and action='convergence.native_review_refused'`)).rows;
    assert.equal((await receipts()).length, 1);
    assert.equal((await receipts())[0].metadata.reason, 'native_review_refused:revision_chain_invalid');
    // Re-derivation finds the same refusal: no verdict change, no second receipt, no re-fail loop.
    await seed.query("update transactions set payload=payload || '{\"synthetic_touch\":3}'::jsonb where id='sg-native-line'");
    const again = await settleAll();
    assert.equal(again.error, undefined);
    assert.equal((await receipts()).length, 1);
    assert.deepEqual(await marksFor('sg-native'), []);
    // Checkout latency: every pooled checkout's release runs the same global sweep.
    // Before, the poisoned client wedged it (2.0 s per attempt, 25 s at 40k marks).
    await seed.query("update transactions set convergence_state=null,convergence_reason=null,convergence_as_of=null where id in ('sg-native-line','fi-clean-open')");
    await seed.query("update transactions set payload=payload || '{\"synthetic_touch\":5}'::jsonb where id in ('sg-native-line','fi-clean-open')");
    const hooked = installConvergenceSettleOnPool(new pg.Pool({ connectionString: url.toString(), max: 1 }), { logger: null });
    try {
      const checkoutStarted = performance.now();
      const checkedOut = await hooked.connect(); await checkedOut.query('select 1'); await checkedOut.release();
      assert.ok(performance.now() - checkoutStarted < 3000, 'a poisoned client no longer taxes every checkout');
    } finally { await hooked.end(); }
    assert.equal((await convergence('fi-clean-open')).convergence_state !== null, true, 'the release sweep settled the other firm');
    assert.equal((await convergence('sg-native-line')).convergence_reason, 'native_review_refused:revision_chain_invalid');
    // The nightly recompute agrees with the settle; the read path is isolated too.
    const drift = await recomputeConvergenceDrift(seed, { firmId });
    assert.deepEqual(drift.drifted_sample.filter(row => row.target_id === 'sg-native-line'), []);
    const snapshot = await getFirmSnapshotFromDb({ firmId, observedAt: '2026-03-01T00:00:00.000Z' });
    assert.equal(snapshotRow(snapshot, 'sg-native-line').convergence_reason, 'native_review_refused:revision_chain_invalid');
    assert.equal(snapshotRow(snapshot, 'fi-applied').convergence_state, 'auto_reconciled', 'neighbour unaffected');
  });

  await t.test('(f) a genuine SQL failure inside one firm does not pin the global FIFO: its marks requeue at the tail, the other firm settles, the failure is reported', async () => {
    try {
      await seed.query('delete from convergence_marks');
      await seed.query("update transactions set convergence_state=null,convergence_reason=null,convergence_as_of=null where id in ('fi-applied','fi-clean-open')");
      await seed.query("update transactions set payload=payload || '{\"synthetic_touch\":4}'::jsonb where id in ('fi-applied','fi-clean-open')");
      await seed.query(`create function iso_fail() returns trigger language plpgsql as $$ begin raise exception 'synthetic firm failure' using errcode='XX000'; end $$;
            create trigger iso_fail before update of convergence_state on transactions for each row
              when (new.firm_id='iso-firm' and new.convergence_state is distinct from old.convergence_state) execute function iso_fail()`);
      const settled = await settleAll();
      assert.equal(settled.error, undefined, JSON.stringify(settled));
      assert.deepEqual(settled.failed_firms?.map(f => f.firm_id), [firmId]);
      assert.notEqual((await convergence('fi-clean-open')).convergence_state, null);
      assert.deepEqual(await marksFor('fi-neighbor'), ['fi-applied'], 'the failing firm keeps its mark for a later sweep');
      assert.equal((await convergence('fi-applied')).convergence_state, null);
    } finally { await seed.query('drop trigger iso_fail on transactions; drop function iso_fail()'); }
    const healed = await settleAll();
    assert.equal(healed.failed_firms, undefined);
    assert.equal((await convergence('fi-applied')).convergence_state, 'auto_reconciled');
    assert.deepEqual(await marksFor('fi-neighbor'), []);
  });

  await t.test('(g) the global release sweep is time-budgeted between firms: a firm reached after the budget is requeued untouched, and the first firm always runs', async () => {
    await seed.query('delete from convergence_marks');
    await seed.query("update transactions set convergence_state=null,convergence_reason=null,convergence_as_of=null where id in ('fi-applied','fi-clean-open')");
    await seed.query("update transactions set payload=payload || '{\"synthetic_touch\":6}'::jsonb where id in ('fi-applied','fi-clean-open')");
    const settled = await settleConvergenceMarks(seed, { scope: 'committed', budgetMs: -1 });
    assert.equal(settled.claimed, 2);
    assert.equal(settled.deferred_firms?.length, 1, JSON.stringify(settled));
    assert.equal(settled.firms, 2);
    const done = [(await convergence('fi-applied')).convergence_state, (await convergence('fi-clean-open')).convergence_state];
    assert.equal(done.filter(state => state !== null).length, 1, 'exactly the first firm was settled');
    const deferred = settled.deferred_firms[0].firm_id;
    assert.equal((await seed.query('select count(*)::int n from convergence_marks where firm_id=$1', [deferred])).rows[0].n, 1, 'the deferred firm keeps its mark');
    const next = await settleConvergenceMarks(seed, { scope: 'committed' });
    assert.equal(next.claimed, 1); assert.equal(next.deferred_firms, undefined);
    assert.equal((await convergence('fi-applied')).convergence_state !== null && (await convergence('fi-clean-open')).convergence_state !== null, true);
  });
});
