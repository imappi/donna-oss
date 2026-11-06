// FI-01: a scheduled sweep whose database work fails is a failed run, never a
// success. Real PostgreSQL and the real drain function and parse-cron route.
// The controlled failure is a pool that logs in as a role the server does not
// have: PostgreSQL refuses it the way the Supabase pooler refused the hosted
// runtime on 2026-10-14 ("tenant or user not found"). Putting the real pool
// back is the next tick. Only the model wire is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import pg from 'pg';

const pgUrl = process.env.DONNA_SCHEMA_PROOF_PG17_URL || process.env.DONNA_PG_TEST_URL;

const cronRequest = async (handleDonnaApiRequest, task) => {
  const req = Readable.from([]);
  req.method = 'GET';
  req.url = `/api/donna/firms/documents/parse-cron?task=${task}`;
  req.headers = {};
  let body = '';
  let done;
  const ended = new Promise(resolve => { done = resolve; });
  const res = { statusCode: 200, setHeader() {}, end(value = '') { body = String(value); done(); } };
  await handleDonnaApiRequest(req, res);
  await ended;
  return { status: res.statusCode, body };
};

test('real PG: a refused database fails the drain and the parse-cron route visibly; the next tick recovers', {
  skip: !pgUrl && 'INCOMPLETE: PostgreSQL required', timeout: 120000
}, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_sweep_failure_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const refusedUrl = new URL(url); refusedUrl.username = 'no_such_tenant_fi01'; refusedUrl.password = 'x';
  const pool = new pg.Pool({ connectionString: url.toString() });
  const refused = new pg.Pool({ connectionString: refusedUrl.toString(), connectionTimeoutMillis: 5000 });
  const ended = []; pool.on('connect', c => ended.push(new Promise(resolve => c.once('end', resolve))));
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: 'fi01-fixture', DONNA_DESKTOP_BLOB_DIR: '',
    LOOPS_TIER: 'canary', LOOPS_SHADOW: 'true', ANTHROPIC_API_KEY: 'fixture-only', CLIENT_CONFIG_FORCE_DISABLE: '',
    DONNA_ACCESS_TOKEN: undefined, VERCEL: undefined, VERCEL_ENV: undefined, VERCEL_PROJECT_ID: undefined };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const priorFetch = globalThis.fetch;
  const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } = await import('./db/pool.js');
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    globalThis.fetch = priorFetch; __resetFirmDbPoolForTests();
    await refused.end(); await pool.end(); await Promise.all(ended);
    await admin.query(`drop database "${name}"`); await admin.end();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, dir), 'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  const firmId = 'fi01-fixture';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,'Synthetic sweep firm',$1,$2)", [firmId, { loops: { tier: 'canary' } }]);
  await pool.query("insert into firm_members(id,firm_id,email,name,role,status) values('fixture-operator',$1,'operator@fixture.invalid','Operator','admin','active')", [firmId]);
  const { selfProvisionClientWorkspace } = await import('./selfProvisionDb.js');
  const { prepareFinnishHostedPilotInDb } = await import('./hostedPilot.js');
  const { setClientFlagStage } = await import('./clientConfig.js');
  const { HOSTED_PILOT_VERSION } = await import('./internalPilotAccess.js');
  const { documentTerminalDrainFunction, DOCUMENT_DRAIN_SWEEP_FAILED } = await import('./inngest/documentTerminalDrain.js');
  const { handleDonnaApiRequest } = await import('./api.js');
  const { clientId } = await selfProvisionClientWorkspace({ auth: { userId: 'fixture-owner', email: 'owner@fixture.invalid' }, companyName: 'Synthetic Sweep Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
  await prepareFinnishHostedPilotInDb({ firmId, clientId, actorId: 'fixture-operator', profilePatch: { companyName: 'Synthetic Sweep Oy', jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR', accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' } });
  await setClientFlagStage(pool, { firmId, clientId, flagKey: 'DOCUMENT_NO_LINE_DISPOSITION', stage: 'canary', source: 'manual', reason: HOSTED_PILOT_VERSION, actorType: 'firm_member', actorId: 'fixture-operator' });
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,total_amount,currency,document_date,vendor_name,payment_status,payload)
    values('doc-fi01',$1,$2,'synthetic.pdf','receipt','completed',10,'EUR','2025-02-15','Synthetic fuel','paid','{}')`, [firmId, clientId]);
  for (const date of ['2025-02-01', '2025-02-28']) await pool.query(`insert into transactions(id,firm_id,client_id,transaction_date,description,money_out,money_in,currency,status,payload)
    values($1,$2,$3,$4,'Synthetic unrelated bank line',100,0,'EUR','needs_review','{}')`, [`fi01-${date}`, firmId, clientId, date]);
  const calls = [];
  globalThis.fetch = async (target, init) => {
    assert.match(String(target), /api\.anthropic\.com/, 'no other external transport allowed');
    calls.push(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify({ disposition: 'auto_explain', materiality: 'immaterial', expense_kind: 'fuel', settlement_channel: 'personal_card', confidence: 0.98, reasoning: 'Synthetic paid receipt and complete bank coverage.' }) }], usage: { input_tokens: 1, output_tokens: 1 } }));
  };
  const clock = () => documentTerminalDrainFunction.fn({ event: { name: 'inngest/scheduled.timer', data: {} },
    step: { run: async (_name, work) => work() }, logger: { info() {}, warn() {}, error() {} } });

  // The neighbouring valid case first: a healthy route answer, kept to compare.
  const healthyCron = await cronRequest(handleDonnaApiRequest, 'statutory_watches_hourly');
  assert.equal(healthyCron.status, 200, healthyCron.body);
  assert.equal(JSON.parse(healthyCron.body).statutory_watches_hourly.errors, 0);

  // The database refuses the runtime's login.
  __setFirmDbPoolForTests(refused);
  await assert.rejects(clock(), error => {
    assert.equal(error.code, DOCUMENT_DRAIN_SWEEP_FAILED);
    assert.equal(error.summary.errors[0].stage, 'enumeration');
    assert.match(error.summary.errors[0].message, /no_such_tenant_fi01/);
    assert.match(error.message, /enumeration/);
    return true;
  }, 'an enumeration failure fails the run instead of returning a summary');
  assert.equal(calls.length, 0);
  for (const task of ['statutory_watches_hourly', 'canonical_role_resolution', 'coding_convergence', 'evidence_topic_reminders']) {
    const failed = await cronRequest(handleDonnaApiRequest, task);
    assert.equal(failed.status, 500, `${task} must not answer 200 when its database work failed: ${failed.body}`);
    const body = JSON.parse(failed.body);
    assert.equal(body.code, 'PARSE_CRON_TASK_FAILED');
    assert.ok(body.failures.length > 0 && body.failures.every(f => f.task === task && /no_such_tenant_fi01/.test(f.error)), failed.body);
  }
  const thrown = await cronRequest(handleDonnaApiRequest, 'stuck');
  assert.notEqual(thrown.status, 200, 'a task that throws still fails the request');

  // The next tick, with the database back: the sweep recovers the backlog.
  __setFirmDbPoolForTests(pool);
  const recovered = await clock();
  assert.deepEqual(recovered.errors, [], JSON.stringify(recovered));
  assert.equal(recovered.clients_enrolled, 1);
  assert.equal(recovered.clients_evaluated, 1);
  assert.equal(recovered.documents_evaluated, 1);
  assert.equal(calls.length, 1);
  const again = await clock();
  assert.deepEqual(again.errors, [], 'a second healthy tick still returns its summary');
  assert.equal(again.clients_evaluated, 1);
  const recoveredCron = await cronRequest(handleDonnaApiRequest, 'statutory_watches_hourly');
  assert.equal(recoveredCron.status, 200);
  assert.equal(recoveredCron.body, healthyCron.body, 'a successful run keeps a byte-identical response');

  // A per-client failure after enumeration also fails the run: on the hosted
  // runtime each client's pilot-access read is database work of its own.
  Object.assign(process.env, { VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_PROJECT_ID: 'fixture' });
  await pool.query('alter table client_capability_config rename column reason to unavailable_reason');
  try {
    await assert.rejects(clock(), error => error.code === DOCUMENT_DRAIN_SWEEP_FAILED && error.summary.errors.some(e => e.client_id === clientId));
  } finally {
    await pool.query('alter table client_capability_config rename column unavailable_reason to reason');
  }
});
