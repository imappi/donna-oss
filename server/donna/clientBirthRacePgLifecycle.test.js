import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { createClientInDb, __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';

// Two authenticated creates of the same Singapore company race through the real
// writer. PostgreSQL resolves `on conflict (id)` only for the arbiter index; when
// both inserts pass its pre-check, the loser meets the winner on the second
// unique index (firm_id, id). The contract for a native birth is unchanged by
// that timing: one row, one birth, and the other request ends in the typed
// competing_birth refusal — never a raw unique violation (CI 2026-10-07, twice).
const pgUrl = process.env.DONNA_PG_TEST_URL;
const BARRIER_KEY = 718_221;
const ITERATIONS = 40;

test('concurrent same-company native births: exactly one row, the other request is the typed competing_birth refusal', async t => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL is required for the real birth race');
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_birth_race_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4 });
  const closed = [];
  pool.on('connect', connection => closed.push(new Promise(resolve => connection.once('end', resolve))));
  __setFirmDbPoolForTests(pool);
  const envKeys = ['DATABASE_URL', 'DONNA_DESKTOP_BLOB_DIR', 'VERCEL', 'VERCEL_PROJECT_ID', 'VERCEL_ENV'];
  const priorEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { DATABASE_URL: url.toString(), VERCEL: '1', VERCEL_PROJECT_ID: 'birth-race-fixture', VERCEL_ENV: 'preview' });
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  t.after(async () => {
    try {
      __resetFirmDbPoolForTests();
      await pool.end();
      await Promise.all(closed);
      const remaining = await admin.query(`select (count(*) filter (where backend_type = 'client backend'))::int n,
        coalesce(json_agg(json_build_object('pid', pid, 'backend_type', backend_type, 'application_name', application_name, 'query', query)), '[]'::json) sessions
        from pg_stat_activity where datname=$1`, [name]);
      assert.equal(remaining.rows[0].n, 0, `no test session may outlive the race: ${JSON.stringify(remaining.rows[0])}`);
      await admin.query(`drop database "${name}"`);
    } finally {
      await admin.end();
      for (const key of envKeys) { if (priorEnv[key] === undefined) delete process.env[key]; else process.env[key] = priorEnv[key]; }
    }
  });

  await pool.query('create schema storage; create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]); create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)');
  const migrations = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(migrations)).filter(file => file.endsWith('.sql')).sort()) await pool.query(await readFile(new URL(file, migrations), 'utf8'));
  const firmId = 'birth-race-firm', memberId = 'birth-race-member';
  await pool.query("insert into firms(id,name,slug) values($1,'Synthetic birth race firm','birth-race-firm')", [firmId]);
  await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values($1,$2,'race-owner@example.test','Synthetic owner','admin','active')", [memberId, firmId]);
  // Fixture-only alignment: both racers park at the clients insert (BEFORE ROW,
  // i.e. before PostgreSQL's arbiter pre-check) until the test releases them
  // together. Only sessions that opt in wait; the barrier decides no outcome.
  await pool.query(`create function birth_race_barrier() returns trigger language plpgsql as $$
    begin if current_setting('donna.birth_race_barrier', true) = 'on' then perform pg_advisory_xact_lock_shared(${BARRIER_KEY}); end if; return NEW; end $$;
    create trigger birth_race_barrier before insert on clients for each row execute function birth_race_barrier()`);

  const creationPrincipal = { principalType: 'firm_member', principalId: memberId, authoritySource: 'authenticated_firm_create_route' };
  const birthContract = { id: 'sg_pte_native.v1', bookkeeping_start_date: '2026-01-01',
    registration_observation: { revision: 'profile.gst_registration.observation.v1', record: null } };
  const profile = id => ({ id, companyName: 'Synthetic Race Pte. Ltd.', jurisdiction: 'SG', entityType: 'sg-pte',
    accounting_system: 'none', accounting_view: 'management_books', defaultCurrency: 'SGD' });
  const racers = [await pool.connect(), await pool.connect()];
  const gate = await pool.connect();
  try {
    for (const racer of racers) await racer.query("set donna.birth_race_barrier = 'on'");
    const create = (dbClient, id) => createClientInDb({ firmId, profile: profile(id), creationPrincipal, birthContract, dbClient });

    // The writer births a native client without the race (fixture sanity).
    const solo = await create(gate, 'birth-race-solo');
    assert.equal(solo.created, true);

    const outcomes = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const id = `birth-race-${i}`;
      await gate.query('select pg_advisory_lock($1)', [BARRIER_KEY]);
      const settled = Promise.allSettled(racers.map(racer => create(racer, id)));
      try {
        let parked = 0;
        for (let wait = 0; wait < 500 && parked < 2; wait++) {
          parked = (await gate.query("select count(*)::int n from pg_locks where locktype='advisory' and objid=$1 and not granted", [BARRIER_KEY])).rows[0].n;
          if (parked < 2) await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.equal(parked, 2, `both creates must reach the clients insert together (iteration ${i})`);
      } finally { await gate.query('select pg_advisory_unlock($1)', [BARRIER_KEY]); }
      const results = await settled;
      const rows = (await gate.query('select count(*)::int n from clients where firm_id=$1 and id=$2', [firmId, id])).rows[0].n;
      outcomes.push({ i, rows, results: results.map(result => result.status === 'fulfilled'
        ? { created: result.value.created }
        : { code: result.reason?.code, reason: result.reason?.details?.reason ?? null, constraint: result.reason?.constraint ?? null }) });
    }
    const summary = JSON.stringify(outcomes.filter(outcome => outcome.rows !== 1
      || outcome.results.filter(result => result.created === true).length !== 1
      || outcome.results.some(result => result.created === undefined && result.reason !== 'competing_birth')));
    for (const outcome of outcomes) {
      assert.equal(outcome.rows, 1, `exactly one client row per company: ${summary}`);
      assert.equal(outcome.results.filter(result => result.created === true).length, 1, `exactly one birth per company: ${summary}`);
      for (const result of outcome.results.filter(result => result.created === undefined)) {
        assert.deepEqual(result, { code: 'NATIVE_CHART_LINEAGE_INVALID', reason: 'competing_birth', constraint: null },
          `a losing concurrent birth is the typed competing_birth refusal, never a raw unique violation: ${summary}`);
      }
    }
    const refused = outcomes.filter(outcome => outcome.results.some(result => result.reason === 'competing_birth')).length;
    console.log(`[birth-race] ${ITERATIONS} aligned pairs: ${refused} competing_birth refusals`);
    assert.ok(refused > 0, 'the aligned pairs must actually contend (otherwise this proves nothing)');

    // The typed refusal is exactly the lost race on (firm_id, id) for a NATIVE
    // birth. Fixture-only triggers/indexes make each other case deterministic:
    // the same key violation on a non-native create, and an unrelated unique
    // violation on a native birth, are both rethrown unchanged (never typed).
    await gate.query(`create function birth_race_forced_key_violation() returns trigger language plpgsql as $$
      begin if NEW.id like 'birth-race-forced-%' then
        raise exception 'duplicate key value violates unique constraint "clients_firm_id_id_key"'
          using errcode = '23505', constraint = 'clients_firm_id_id_key', table = 'clients';
      end if; return NEW; end $$;
      create trigger birth_race_forced_key_violation before insert on clients for each row execute function birth_race_forced_key_violation();
      create unique index birth_race_fixture_name_key on clients (company_name) where id like 'birth-race-unrelated-%'`);
    const failure = async promise => promise.then(value => ({ created: value.created }),
      error => ({ code: error?.code, reason: error?.details?.reason ?? null, constraint: error?.constraint ?? null }));
    const fiProfile = id => ({ id, companyName: 'Synthetic Forced Oy', jurisdiction: 'FI', entityType: 'fi-oy', accounting_system: 'none' });
    assert.deepEqual({
      forced_native: await failure(create(gate, 'birth-race-forced-native')),
      forced_non_native: await failure(createClientInDb({ firmId, profile: fiProfile('birth-race-forced-fi'), creationPrincipal, dbClient: gate })),
      unrelated_first: await failure(create(gate, 'birth-race-unrelated-1')),
      unrelated_second: await failure(create(gate, 'birth-race-unrelated-2'))
    }, {
      forced_native: { code: 'NATIVE_CHART_LINEAGE_INVALID', reason: 'competing_birth', constraint: null },
      forced_non_native: { code: '23505', reason: null, constraint: 'clients_firm_id_id_key' },
      unrelated_first: { created: true },
      unrelated_second: { code: '23505', reason: null, constraint: 'birth_race_fixture_name_key' }
    });
    assert.equal((await gate.query("select count(*)::int n from clients where id like 'birth-race-forced-%' or id = 'birth-race-unrelated-2'")).rows[0].n, 0,
      'a refused or rethrown create leaves no row');
  } finally {
    for (const connection of [...racers, gate]) connection.release();
  }
});
