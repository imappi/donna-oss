// Real PG proof for the hosted session hygiene (server/donna/db/pool.js): the
// books screen refresh and a document register run concurrently through the
// real Vercel router entry (api/donna-router.js), both complete, and once the
// last invocation in the instance has responded the pool is ended — the
// scratch database sees ZERO sessions from this process, which is what the
// session-mode pooler counts against its cap. A re-register of the same
// uploads (the tray's retry after a lost response) returns the same rows and
// parse runs instead of duplicates. Provider/platform calls are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';
import { __resetFirmDbPoolForTests, readFirmDbPoolCounts, readHostedInvocationCount } from './db/pool.js';

const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const TOKEN = 'hosted-pool-proof-token';

const respond = (routerHandler, { method = 'GET', path, query = '', body } = {}) => new Promise((resolve, reject) => {
  const req = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  req.method = method;
  req.url = `/api/donna-router?path=${path}${query}`;
  req.headers = { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' };
  const res = new EventEmitter();
  const headers = new Map(); const chunks = [];
  res.statusCode = 200;
  res.setHeader = (name, value) => headers.set(String(name).toLowerCase(), value);
  res.getHeader = (name) => headers.get(String(name).toLowerCase());
  res.write = (chunk) => { chunks.push(Buffer.from(String(chunk))); };
  res.end = (chunk) => {
    if (chunk !== undefined) chunks.push(Buffer.from(String(chunk)));
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null; try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
    // http.ServerResponse emits 'finish' once the response left the process.
    res.emit('finish');
    resolve({ statusCode: res.statusCode, json, text });
  };
  Promise.resolve(routerHandler(req, res)).catch(reject);
});

test('real PG: concurrent books refresh + register through the hosted router, sessions released after the last response, retry keeps identity', {
  skip: !PG_URL && 'INCOMPLETE: DONNA_PG_TEST_URL required', timeout: 60000
}, async (t) => {
  const admin = new pg.Client({ connectionString: PG_URL }); await admin.connect();
  const name = `donna_hosted_pool_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${name}"`);
  const url = new URL(PG_URL); url.pathname = `/${name}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_ACCESS_TOKEN', 'DONNA_DESKTOP_BLOB_DIR', 'INNGEST_EVENT_KEY', 'VERCEL', 'VERCEL_ENV'];
  const prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  const priorFetch = globalThis.fetch;
  const sends = [];
  t.after(async () => {
    globalThis.fetch = priorFetch;
    for (const key of envKeys) { if (prior[key] === undefined) delete process.env[key]; else process.env[key] = prior[key]; }
    const { closeFirmDbPool } = await import('./db/pool.js');
    await closeFirmDbPool();
    await seed.end();
    await admin.query(`drop database "${name}" with (force)`);
    await admin.end();
  });
  await seed.query(`create schema storage;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const root = new URL('../../db/migrations/', import.meta.url);
  for (const file of (await readdir(root)).filter((f) => f.endsWith('.sql')).sort()) await seed.query(await readFile(new URL(file, root), 'utf8'));
  const firmId = 'hosted-pool-firm', clientId = 'hosted-pool-client';
  await seed.query("insert into firms(id,name,slug) values($1,'Hosted pool proof',$1)", [firmId]);
  await seed.query("insert into clients(id,firm_id,company_name,jurisdiction,entity_type,profile) values($1,$2,'Kampaamo proof Oy','FI','fi-oy',$3)",
    [clientId, firmId, { jurisdiction: 'FI', accounting_system: 'none' }]);

  process.env.DATABASE_URL = url.toString();
  process.env.DATABASE_POOL_MAX = '2';
  process.env.DONNA_ACCESS_TOKEN = TOKEN;
  delete process.env.DONNA_DESKTOP_BLOB_DIR; delete process.env.INNGEST_EVENT_KEY; delete process.env.VERCEL; delete process.env.VERCEL_ENV;
  // The Inngest dev-server event POST (the cloud transport for a parse run) is
  // answered synthetically; the row's parse_run_id is the identity under test.
  globalThis.fetch = async (target, init) => {
    const body = init?.body ? JSON.parse(init.body) : null;
    sends.push({ url: String(target), names: [].concat(body || []).map((event) => event?.name) });
    return { ok: true, status: 200, headers: new Headers(), json: async () => ({ status: 200, ids: [].concat(body || []).map((_, i) => `evt-${sends.length}-${i}`) }), text: async () => '' };
  };
  __resetFirmDbPoolForTests();
  const { default: routerHandler } = await import('../../api/donna-router.js');
  // Client backends only: an autovacuum worker also appears in pg_stat_activity
  // under this datname and made the idle count read 2 (CI, 2026-09-24).
  const sessionsHere = async () => Number((await admin.query("select count(*)::int as n from pg_stat_activity where datname=$1 and backend_type='client backend'", [name])).rows[0].n);
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  const waitForSessions = async (expected) => {
    for (let i = 0; i < 50 && await sessionsHere() !== expected; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    return sessionsHere();
  };
  const uploads = (ids) => ids.map((id, index) => ({
    id, client_id: clientId, filename: `kampaamo-${index}.pdf`, document_type: 'supplier_bill', mime_type: 'application/pdf',
    storage_bucket: 'donna-evidence', storage_object_key: `${firmId}/${clientId}/evidence/2026-09/upload-${index}.pdf`,
    storage_provider: 'supabase_storage', batch_id: 'kampaamo-reupload', size_bytes: 1000 + index
  }));

  // 1. Concurrent invocations in one instance: the books refresh and the batch
  //    register share the two-client pool and both complete.
  const [snapshot, register] = await Promise.all([
    respond(routerHandler, { path: 'firms/snapshot', query: `&firm_id=${firmId}` }),
    respond(routerHandler, { method: 'POST', path: 'firms/documents/register', body: { firm_id: firmId, documents: uploads(['doc-a', 'doc-b']) } })
  ]);
  assert.equal(snapshot.statusCode, 200, snapshot.text);
  assert.equal(register.statusCode, 200, register.text);
  assert.deepEqual(register.json.documents.map((d) => [d.id, d.already_exists ?? false, d.parse_status, d.event_sent]),
    [['doc-a', false, 'pending', true], ['doc-b', false, 'pending', true]], JSON.stringify(register.json.documents.map((d) => d.event_send_warning)));
  const runs = register.json.documents.map((d) => d.parse_run_id);
  assert.ok(runs.every(Boolean));
  assert.equal(sends.filter((s) => s.names.includes('document/parse.requested')).length, 2, 'one parse event per new row');
  // The last response out ended the pool: no session from this process remains.
  await settled();
  assert.equal(readHostedInvocationCount(), 0);
  assert.equal(readFirmDbPoolCounts(), null, 'pool detached after the last invocation responded');
  assert.equal(await waitForSessions(1), 1, 'only the seed client is connected; the router holds no session while idle');

  // 2. The next invocation rebuilds the pool and reads what was registered.
  const refreshed = await respond(routerHandler, { path: 'firms/snapshot', query: `&firm_id=${firmId}` });
  assert.equal(refreshed.statusCode, 200, refreshed.text);
  assert.deepEqual(refreshed.json.documents.map((d) => d.id).sort(), ['doc-a', 'doc-b']);
  await settled();
  assert.equal(await waitForSessions(1), 1, 'released again after this response');

  // 3. Retry identity: the tray re-registers the same uploads after a lost
  //    response with fresh client ids but the same storage keys — same rows,
  //    same parse runs, no duplicate rows and no second parse event.
  const retry = await respond(routerHandler, { method: 'POST', path: 'firms/documents/register',
    body: { firm_id: firmId, documents: uploads(['doc-a-retry', 'doc-b-retry']) } });
  assert.equal(retry.statusCode, 200, retry.text);
  assert.deepEqual(retry.json.documents.map((d) => [d.id, d.already_exists, d.duplicate_reason, d.parse_run_id, d.event_sent]),
    [['doc-a', true, 'storage_object_key_match', runs[0], null], ['doc-b', true, 'storage_object_key_match', runs[1], null]]);
  assert.equal(sends.filter((s) => s.names.includes('document/parse.requested')).length, 2, 'a replay sends no parse event');
  const rows = await seed.query('select id, parse_run_id, batch_id from documents where firm_id=$1 order by id', [firmId]);
  assert.deepEqual(rows.rows, [{ id: 'doc-a', parse_run_id: runs[0], batch_id: 'kampaamo-reupload' }, { id: 'doc-b', parse_run_id: runs[1], batch_id: 'kampaamo-reupload' }]);
  await settled();
  assert.equal(await waitForSessions(1), 1);
});
