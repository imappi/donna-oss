// The partial-failure shapes parseCronSummaryFailures reads, driven by real
// failures on real PostgreSQL through the real parse-cron route: a local queue
// that refuses the outbox requeue, an Inngest send that fails (cloud outbox),
// a database that refuses one coding-convergence step for a firm, and an
// evidence store that refuses an orphan delete. Each is preceded by the
// healthy neighbour of the same task and followed by the recovering tick.
// Only the storage and Inngest wires are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  return { status: res.statusCode, body: JSON.parse(body) };
};

test('real PG: outbox, coding-convergence and storage-orphan partial failures fail the parse-cron run; the next tick recovers', {
  skip: !pgUrl && 'INCOMPLETE: PostgreSQL required', timeout: 180000
}, async t => {
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  const name = `donna_partial_failure_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(pgUrl); url.pathname = `/${name}`;
  const pool = new pg.Pool({ connectionString: url.toString() });
  const ended = []; pool.on('connect', c => ended.push(new Promise(resolve => c.once('end', resolve))));
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: 'pf01-fixture', DONNA_DESKTOP_BLOB_DIR: undefined,
    INNGEST_EVENT_KEY: undefined, SUPABASE_URL: 'https://storage.fixture.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fixture-only',
    ANTHROPIC_API_KEY: undefined, CLIENT_CONFIG_FORCE_DISABLE: '', DONNA_ACCESS_TOKEN: undefined,
    VERCEL: undefined, VERCEL_ENV: undefined, VERCEL_PROJECT_ID: undefined };
  const saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  const priorFetch = globalThis.fetch;
  const { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } = await import('./db/pool.js');
  __setFirmDbPoolForTests(pool);
  t.after(async () => {
    globalThis.fetch = priorFetch; __resetFirmDbPoolForTests();
    await pool.end(); await Promise.all(ended);
    await admin.query(`drop database "${name}" with (force)`); await admin.end();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  await pool.query(`create schema storage;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  const dir = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter(f => f.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, dir), 'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  const firmId = 'pf01-fixture';
  const clientId = 'pf01-client';
  await pool.query("insert into firms(id,name,slug,metadata) values($1,'Synthetic partial-failure firm',$1,'{}')", [firmId]);
  await pool.query("insert into clients(id,firm_id,company_name,jurisdiction,profile) values($1,$2,'Synthetic Partial Oy','fi',$3)", [clientId, firmId, { jurisdiction: 'fi' }]);
  const { handleDonnaApiRequest } = await import('./api.js');

  // ── outbox (local-job path: the appliance host has no Inngest) ─────────
  const blobDir = await mkdtemp(join(tmpdir(), 'pf01-blob-'));
  t.after(() => rm(blobDir, { recursive: true, force: true }));
  process.env.DONNA_DESKTOP_BLOB_DIR = blobDir;
  const runIds = { 'pf01-doc-outbox': '00000000-0000-4000-8000-0000000000a1', 'pf01-doc-cloud': '00000000-0000-4000-8000-0000000000a2' };
  const pendingDoc = async (id) => pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,parse_run_id,parse_enqueued_at,payload)
    values($1,$2,$3,'synthetic.pdf','receipt','pending',$4,now() - interval '5 minutes','{}')`, [id, firmId, clientId, runIds[id]]);
  const healthyOutbox = await cronRequest(handleDonnaApiRequest, 'outbox');
  assert.equal(healthyOutbox.status, 200, JSON.stringify(healthyOutbox.body));
  assert.deepEqual(healthyOutbox.body.outbox.failed, []);
  await pendingDoc('pf01-doc-outbox');
  await pool.query('alter table local_jobs rename to local_jobs_unavailable');
  let failedOutbox;
  try { failedOutbox = await cronRequest(handleDonnaApiRequest, 'outbox'); }
  finally { await pool.query('alter table local_jobs_unavailable rename to local_jobs'); }
  assert.equal(failedOutbox.status, 500, JSON.stringify(failedOutbox.body));
  assert.equal(failedOutbox.body.code, 'PARSE_CRON_TASK_FAILED');
  assert.equal(failedOutbox.body.outbox.failed.length, 1, 'the shape the helper reads: failed[] on the local-job path');
  assert.deepEqual(failedOutbox.body.failures.map(f => [f.task, f.document_id, f.parse_run_id]), [['outbox', 'pf01-doc-outbox', runIds['pf01-doc-outbox']]]);
  assert.match(failedOutbox.body.failures[0].error, /local_jobs/);
  const recoveredOutbox = await cronRequest(handleDonnaApiRequest, 'outbox');
  assert.equal(recoveredOutbox.status, 200, JSON.stringify(recoveredOutbox.body));
  assert.equal(recoveredOutbox.body.outbox.requeued.length, 1, 'the next tick requeues the row the refused tick named');

  // ── outbox (cloud path): the Inngest send fails. Off the appliance the
  // producer is the event bus (isInngestConfigured reads the host per call).
  delete process.env.DONNA_DESKTOP_BLOB_DIR;
  await pendingDoc('pf01-doc-cloud');
  globalThis.fetch = async () => { throw new Error('inngest unreachable (fixture)'); };
  let failedCloud;
  try { failedCloud = await cronRequest(handleDonnaApiRequest, 'outbox'); }
  finally { globalThis.fetch = priorFetch; }
  assert.equal(failedCloud.status, 500, JSON.stringify(failedCloud.body));
  assert.deepEqual(failedCloud.body.outbox, { picked: 1, resent: 0, failed: 1 }, 'the shape the helper reads: a count on the cloud path');
  assert.deepEqual(failedCloud.body.failures, [{ task: 'outbox', error: '1 of 1 outbox resend(s) failed' }]);
  await pool.query("update documents set parse_event_sent_at = now() where id = 'pf01-doc-cloud'");
  const healthyCloud = await cronRequest(handleDonnaApiRequest, 'outbox');
  assert.equal(healthyCloud.status, 200, JSON.stringify(healthyCloud.body));
  assert.deepEqual(healthyCloud.body.outbox, { picked: 0, resent: 0, failed: 0 });

  // ── coding_convergence: one step's query refused for the firm ─────────
  const healthyCoding = await cronRequest(handleDonnaApiRequest, 'coding_convergence');
  assert.equal(healthyCoding.status, 200, JSON.stringify(healthyCoding.body));
  await pool.query('alter table transaction_review_queue rename to transaction_review_queue_unavailable');
  let failedCoding;
  try { failedCoding = await cronRequest(handleDonnaApiRequest, 'coding_convergence'); }
  finally { await pool.query('alter table transaction_review_queue_unavailable rename to transaction_review_queue'); }
  assert.equal(failedCoding.status, 500, JSON.stringify(failedCoding.body));
  const firmResult = failedCoding.body.coding_convergence.firms.find(f => f.firm_id === firmId).result;
  assert.ok(firmResult.errors > 0 && !failedCoding.body.coding_convergence.error, 'the firm ran; one step failed inside it');
  assert.ok(failedCoding.body.failures.some(f => f.task === 'coding_convergence' && f.firm_id === firmId && f.step === 'release'
    && /transaction_review_queue/.test(f.error)), JSON.stringify(failedCoding.body.failures));
  const recoveredCoding = await cronRequest(handleDonnaApiRequest, 'coding_convergence');
  assert.equal(recoveredCoding.status, 200, JSON.stringify(recoveredCoding.body));

  // ── storage_orphans: the evidence store refuses a delete ──────────────
  const bucket = 'donna-evidence';
  const orphanKey = `${firmId}/${clientId}/orphan-synthetic.pdf`;
  await pool.query(`insert into documents(id,firm_id,client_id,filename,document_type,parse_status,storage_bucket,storage_object_key,payload)
    values('pf01-doc-kept',$1,$2,'kept.pdf','receipt','completed',$3,$4,'{}')`, [firmId, clientId, bucket, `${firmId}/${clientId}/kept.pdf`]);
  let deleteStatus = 200;
  const deletes = [];
  globalThis.fetch = async (target, init = {}) => {
    const href = String(target);
    assert.match(href, /^https:\/\/storage\.fixture\.invalid\/storage\/v1\/object\//, 'no other external transport allowed');
    if (href.includes('/object/list/')) {
      const listed = [{ name: orphanKey, id: 'obj-1', metadata: { size: 10 }, created_at: new Date(Date.now() - 2 * 3600e3).toISOString() }];
      return new Response(JSON.stringify(JSON.parse(init.body).offset ? [] : listed), { status: 200 });
    }
    deletes.push(JSON.parse(init.body).prefixes);
    return deleteStatus === 200
      ? new Response(JSON.stringify([{ name: orphanKey }]), { status: 200 })
      : new Response('storage backend unavailable', { status: deleteStatus });
  };
  deleteStatus = 503;
  const failedStorage = await cronRequest(handleDonnaApiRequest, 'storage_orphans');
  assert.equal(failedStorage.status, 500, JSON.stringify(failedStorage.body));
  const failedBucket = failedStorage.body.storage_orphans.buckets.find(b => b.bucket === bucket);
  assert.equal(failedBucket.delete_errors, 1, 'the shape the helper reads: buckets[].delete_errors');
  assert.deepEqual(failedBucket.delete_failures, [{ key: orphanKey, error: 'status 503 storage backend unavailable' }]);
  assert.deepEqual(failedStorage.body.failures, [{ task: 'storage_orphans', bucket, error: '1 orphan delete(s) failed: status 503 storage backend unavailable' }]);
  const authorized = await pool.query("select count(*)::int as n from audit_events where action = 'storage.cleanup_authorized'");
  assert.equal(authorized.rows[0].n, 1, 'the authorized receipt stands as the record of the attempt');
  deleteStatus = 200;
  const recoveredStorage = await cronRequest(handleDonnaApiRequest, 'storage_orphans');
  assert.equal(recoveredStorage.status, 200, JSON.stringify(recoveredStorage.body));
  assert.equal(recoveredStorage.body.storage_orphans.deleted_total, 1, 'the next sweep deletes the kept orphan');
  assert.deepEqual(deletes, [[orphanKey], [orphanKey]]);

  // audit_failures: the database refuses the pre-delete receipt (fail closed).
  globalThis.fetch = async (target, init = {}) => {
    if (String(target).includes('/object/list/')) return new Response(JSON.stringify(JSON.parse(init.body).offset ? [] : [{ name: orphanKey, id: 'obj-2', metadata: { size: 10 }, created_at: new Date(Date.now() - 2 * 3600e3).toISOString() }]), { status: 200 });
    throw new Error('a delete must not run without its receipt');
  };
  await pool.query(`create function pf01_refuse_cleanup() returns trigger language plpgsql as $$ begin
    if new.action = 'storage.cleanup_authorized' then raise exception 'audit insert refused (fixture)'; end if; return new; end $$;
    create trigger pf01_refuse_cleanup before insert on audit_events for each row execute function pf01_refuse_cleanup()`);
  let auditFailed;
  try { auditFailed = await cronRequest(handleDonnaApiRequest, 'storage_orphans'); }
  finally { await pool.query('drop trigger pf01_refuse_cleanup on audit_events; drop function pf01_refuse_cleanup()'); }
  assert.equal(auditFailed.status, 500, JSON.stringify(auditFailed.body));
  assert.deepEqual(auditFailed.body.failures, [{ task: 'storage_orphans', bucket, error: '1 cleanup audit receipt(s) failed' }]);
});
