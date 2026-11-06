import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from '../db/pool.js';
import { createClientInDb } from '../db/clients.js';
import { setClientFlagStage } from '../clientConfig.js';
import { CLOUD_PILOT_PROCESSING_FLAGS, CLOUD_PILOT_PROCESSING_VERSION, US_HOSTED_PILOT_FLAG, US_HOSTED_PILOT_STAGES,
  US_HOSTED_PROFILE_ID, US_HOSTED_FIRM_POLICY_REASON } from '../cloudPilotConfig.js';
import { US_HOSTED_PILOT_VERSION, HOSTED_PILOT_VERSION, readInternalPilotAccessWithClient } from '../internalPilotAccess.js';
import { runHostedPilotTerminalConvergenceInDb } from '../hostedPilotTerminalConvergence.js';
import { readJevDecisionPolicy } from '../jevTrialProvider.js';
import { readinessProfileCoordinate } from '../runtimeReadiness.js';
import { loadAdmittedEntityProfileManifest, resolveAdmittedEntityProfile } from '../entityCertificateB.js';

// docs/design-donna-us-hosted-lane.md (Kari, 2026-10-01): a US LLC is born
// into the hosted accounting pipeline ONLY behind the firm-default
// US_HOSTED_PILOT row, with gross-only stages, the pack palette, the governed
// reconciliation seat and a pilot receipt; the convergence worker and the
// first-line coder then admit it exactly as they admit a Finnish Oy.
test('real PG: US hosted pilot birth is gated by the firm row, exact, and reaches the accounting workers', async t => {
  assert.ok(process.env.DONNA_PG_TEST_URL, 'INCOMPLETE: disposable PostgreSQL is required');
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const name = `us_hosted_intake_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 2000 });
  __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), VERCEL: '1', VERCEL_PROJECT_ID: 'us-fixture', VERCEL_ENV: 'preview',
    VERCEL_DEPLOYMENT_ID: 'us-fixture', VERCEL_GIT_COMMIT_SHA: 'us-fixture', DONNA_DESKTOP_BLOB_DIR: '',
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
  const firmId = 'us-firm';
  const memberId = 'member-us-firm';
  await seed.query('insert into firms(id,name,slug) values($1,$1,$1)', [firmId]);
  await seed.query(`insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level)
    values($1,$2,'user-us','member@us.invalid','Synthetic member','admin','active','owner')`, [memberId, firmId]);
  const create = (id, overrides = {}) => createClientInDb({ firmId, dbClient: seed,
    profile: { id, companyName: `Synthetic ${id} (demo)`, jurisdiction: 'US', entityType: 'us-llc',
      accounting_system: 'none', accounting_view: 'management_books', defaultCurrency: 'USD', ...overrides },
    creationPrincipal: { principalType: 'firm_member', principalId: memberId, authoritySource: 'authenticated_firm_create_route' } });
  const flags = async clientId => Object.fromEntries((await seed.query(
    'select flag_key,stage,source,reason from client_capability_config where firm_id=$1 and client_id=$2 and valid_to is null', [firmId, clientId]))
    .rows.map(row => [row.flag_key, row]));

  // 1. No firm row: a US create is exactly what it was before.
  const before = await create('us-before');
  assert.equal(before.hosted_birth, null);
  assert.deepEqual(await flags('us-before'), {}, 'no stage rows without the firm selection');
  assert.equal(await readInternalPilotAccessWithClient(seed, { firmId, clientId: 'us-before' }), false);

  // 2. The operator's prepare step: the firm-default selection row.
  await setClientFlagStage(seed, { firmId, clientId: null, flagKey: US_HOSTED_PILOT_FLAG, stage: 'canary',
    source: 'manual', reason: 'us demo fixture', actorType: 'firm_member', actorId: memberId });

  // 3. Wrong legal form or currency refuses with a typed 422; nothing is born.
  await assert.rejects(() => create('us-corp', { entityType: 'us-c-corp' }), { code: 'US_HOSTED_LEGAL_FORM_UNSUPPORTED', statusCode: 422 });
  await assert.rejects(() => create('us-eur', { defaultCurrency: 'EUR' }), { code: 'US_HOSTED_IDENTITY_REQUIRED', statusCode: 422 });
  assert.equal((await seed.query("select count(*)::int as n from clients where id in ('us-corp','us-eur')")).rows[0].n, 0);

  // 4. The birth: exact gross-only stages + the processing extension, chart, seat, receipt.
  const born = await create('us-demo');
  assert.equal(born.hosted_birth, US_HOSTED_PILOT_VERSION);
  const live = await flags('us-demo');
  const expected = { ...Object.fromEntries(Object.entries(US_HOSTED_PILOT_STAGES).map(([flag_key, stage]) =>
    [flag_key, { flag_key, stage, source: 'manual', reason: US_HOSTED_PILOT_VERSION }])),
    ...Object.fromEntries(CLOUD_PILOT_PROCESSING_FLAGS.map(flag_key =>
      [flag_key, { flag_key, stage: 'canary', source: 'manual', reason: CLOUD_PILOT_PROCESSING_VERSION }])) };
  assert.deepEqual(live, expected);
  assert.equal(live.JURISDICTION_TAX_CODING.stage, 'off');
  assert.ok(!Object.keys(live).some(key => /^FINLAND_|FISCAL_PERIOD_INTAKE/.test(key)));
  assert.equal(await readInternalPilotAccessWithClient(seed, { firmId, clientId: 'us-demo' }), true);
  assert.ok((await seed.query("select count(*)::int as n from ledger_accounts where firm_id=$1 and client_id='us-demo'", [firmId])).rows[0].n > 0,
    'the US pack palette chart is seeded');
  const seat = (await seed.query("select lane,basis,reason from model_lane_policy where firm_id=$1 and client_id='us-demo' and valid_to is null", [firmId])).rows;
  assert.deepEqual(seat, [{ lane: 'reconciliation_reasoning', basis: 'experiment', reason: US_HOSTED_FIRM_POLICY_REASON }]);
  const receipt = (await seed.query("select actor_id,metadata from audit_events where firm_id=$1 and client_id='us-demo' and action='pilot.prepared'", [firmId])).rows;
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].actor_id, memberId);
  assert.equal(receipt[0].metadata.version, US_HOSTED_PILOT_VERSION);
  assert.equal(receipt[0].metadata.tax_posting, 'gross_only');
  assert.equal(receipt[0].metadata.external_sends, false);

  // 5. The readiness coordinate resolves to the one admitted US hosted profile.
  const client = (await seed.query("select jurisdiction,entity_type,profile from clients where id='us-demo'")).rows[0];
  const coordinate = readinessProfileCoordinate({ client, creationPath: 'desktop_firm_intake' });
  const profile = resolveAdmittedEntityProfile({ manifest: (await loadAdmittedEntityProfileManifest()).manifest, coordinate });
  assert.equal(profile.profile_id ?? profile.profile?.profile_id, US_HOSTED_PROFILE_ID);

  // 6. The bank-line convergence worker admits the US pilot (and still the FI one).
  await seed.query(`insert into clients(id,firm_id,company_name,jurisdiction,entity_type,status,profile)
    values('fi-demo',$1,'Synthetic Oy','FI','fi-oy','active','{}'::jsonb)`, [firmId]);
  await setClientFlagStage(seed, { firmId, clientId: 'fi-demo', flagKey: 'INTERNAL_PILOT_ACCESS', stage: 'canary',
    source: 'manual', reason: HOSTED_PILOT_VERSION, actorType: 'firm_member', actorId: memberId });
  for (const clientId of ['us-demo', 'us-before', 'fi-demo']) {
    await seed.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,currency)
      values($1,$2,$3,'2026-09-02','SYNTHETIC VENDOR',42,'USD')`, [`t-${clientId}`, firmId, clientId]);
  }
  const visited = [];
  await runHostedPilotTerminalConvergenceInDb({ firmId,
    runWorkerAdmissionFn: async ({ clientId }) => { visited.push(clientId); } });
  assert.deepEqual(visited.sort(), ['fi-demo', 'us-demo'], 'the unenrolled US client is never scanned');

  // 7. The hosted first-line coder admits the US pilot with its own basis.
  await setClientFlagStage(seed, { firmId, clientId: 'us-demo', flagKey: 'JEV_RECONCILIATION', stage: 'canary',
    source: 'manual', reason: CLOUD_PILOT_PROCESSING_VERSION, actorType: 'firm_member', actorId: memberId });
  const hostedEnv = { ...process.env, VERCEL_ENV: 'production', TYPESAFE_MODEL: 'fixture-first-line', SUPABASE_URL: 'https://fixture.invalid' };
  const policy = await readJevDecisionPolicy({ client: seed, firmId, clientId: 'us-demo', env: hostedEnv });
  assert.equal(policy.policy.basis, 'hosted_us_default');
});
