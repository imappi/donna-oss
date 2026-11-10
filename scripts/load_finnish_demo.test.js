// scripts/load_finnish_demo.mjs — the quickstart's demo loader. Load-bearing:
//   - the company comes from the synthetic pack's own entity block (FI Oy, EUR);
//   - the pack's answer key (file 90) is never uploaded;
//   - re-running keeps the firm (409), does not re-create the company and does
//     not upload a document twice;
//   - the signed upload PUT carries no access token;
//   - on real PostgreSQL, through the real routes on a local (desktop) host,
//     the company is born Finnish with its Finnish plane flags staged and the
//     statement queued for parsing. Opt-in: DONNA_PG_TEST_URL.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import {
  ANSWER_KEY_PREFIX,
  DEMO_CLIENT_ID,
  DEMO_FIRM,
  DEMO_PACK_DIR,
  DEMO_STATEMENT_FILE,
  buildDemoClientProfile,
  createRuntimeClient,
  demoDocumentType,
  listDemoDocuments,
  loadFinnishDemo
} from './load_finnish_demo.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PG_URL = process.env.DONNA_PG_TEST_URL || '';
const packFiles = () => readdirSync(path.join(DEMO_PACK_DIR, 'sources'));

test('the demo profile is the pack\'s Finnish Oy', () => {
  const labels = JSON.parse(readFileSync(path.join(DEMO_PACK_DIR, 'labels.json'), 'utf8'));
  const profile = buildDemoClientProfile(labels.entity);
  assert.equal(profile.id, DEMO_CLIENT_ID);
  assert.equal(profile.companyName, 'Kampaamo Kultalanka Oy');
  assert.equal(profile.jurisdiction, 'FI');
  assert.equal(profile.entityType, 'fi-oy');
  assert.equal(profile.defaultCurrency, 'EUR');
  assert.equal(profile.uen, labels.entity.business_id);
  assert.equal(profile.vatNumber, labels.entity.vat_id);
  assert.throws(() => buildDemoClientProfile({ ...labels.entity, jurisdiction: 'GB' }), /Finnish/);
  assert.throws(() => buildDemoClientProfile(null), /Finnish/);
});

test('the document list never includes the answer key', () => {
  const files = packFiles();
  assert.ok(files.some((name) => name.startsWith(ANSWER_KEY_PREFIX)), 'the pack has an answer key to exclude');
  assert.deepEqual(listDemoDocuments(files), [DEMO_STATEMENT_FILE]);
  const all = listDemoDocuments(files, { all: true });
  assert.equal(all[0], DEMO_STATEMENT_FILE);
  assert.equal(all.length, files.filter((name) => name.endsWith('.pdf')).length - 1);
  assert.ok(all.every((name) => !name.startsWith(ANSWER_KEY_PREFIX)));
  assert.throws(() => listDemoDocuments(['47 Kuitti.pdf']), /bank statement/);
  assert.equal(demoDocumentType(DEMO_STATEMENT_FILE), 'bank_statement');
  assert.equal(demoDocumentType('47 Kuitti 21.02 - VR lippu.pdf'), 'unknown');
});

// A fake runtime: records calls, answers like the real routes.
const fakeRuntime = ({ firmStatus = 201, clients = [], documents = [] } = {}) => {
  const calls = [];
  const json = (status, body) => ({ status, text: async () => JSON.stringify(body) });
  const fetchFn = async (url, init) => {
    const pathname = url.pathname;
    calls.push({ method: init.method, pathname, headers: init.headers, body: init.body });
    if (pathname === '/api/donna/firms/health') return json(200, { database_configured: true });
    if (pathname === '/api/donna/firms/first-run') return json(firmStatus, { firm_id: 'firm-demo-tilitoimisto', currency: 'EUR', error: 'x' });
    if (pathname === '/api/donna/firms/snapshot') return json(200, { firm: { id: 'firm-demo-tilitoimisto' }, clients, documents });
    if (pathname === '/api/donna/firms/clients') return json(200, {});
    if (pathname === '/api/donna/firms/documents/upload-url') {
      return json(200, { signed_url: '/api/donna/evidence-local?token=signed', bucket: 'b', key: 'k', provider: 'local' });
    }
    if (pathname === '/api/donna/evidence-local') return json(200, {});
    if (pathname === '/api/donna/firms/documents/register') return json(200, { documents: [{}] });
    return json(404, { error: 'unexpected' });
  };
  return { calls, client: createRuntimeClient({ baseUrl: 'http://127.0.0.1:1', accessToken: 'tok', fetchFn }) };
};

test('a first run mints the firm, creates the company and uploads only the statement', async () => {
  const { calls, client } = fakeRuntime();
  const result = await loadFinnishDemo({ client, log: () => {} });
  assert.deepEqual(result.uploaded, [DEMO_STATEMENT_FILE]);
  const mint = calls.find((call) => call.pathname === '/api/donna/firms/first-run');
  assert.deepEqual(JSON.parse(mint.body), DEMO_FIRM);
  const created = calls.find((call) => call.pathname === '/api/donna/firms/clients');
  assert.equal(JSON.parse(created.body).profile.id, DEMO_CLIENT_ID);
  const put = calls.find((call) => call.method === 'PUT');
  assert.equal(put.headers.Authorization, undefined, 'the signed PUT carries no access token');
  const register = JSON.parse(calls.find((call) => call.pathname.endsWith('/register')).body);
  assert.equal(register.documents[0].document_type, 'bank_statement');
  assert.equal(register.documents[0].client_id, DEMO_CLIENT_ID);
  for (const call of calls.filter((entry) => entry.method !== 'PUT' && !entry.pathname.endsWith('/health'))) {
    assert.equal(call.headers.Authorization, 'Bearer tok');
  }
});

test('a re-run keeps the firm, does not re-create the company and does not upload twice', async () => {
  const { calls, client } = fakeRuntime({
    firmStatus: 409,
    clients: [{ id: DEMO_CLIENT_ID }],
    documents: [{ client_id: DEMO_CLIENT_ID, filename: DEMO_STATEMENT_FILE }]
  });
  const result = await loadFinnishDemo({ client, log: () => {} });
  assert.deepEqual(result.uploaded, []);
  assert.equal(calls.filter((call) => call.pathname === '/api/donna/firms/clients').length, 0);
  assert.equal(calls.filter((call) => call.pathname.includes('upload-url')).length, 0);
});

test('a runtime that is not a local book is refused with a clear message', async () => {
  const { client } = fakeRuntime({ firmStatus: 403 });
  await assert.rejects(loadFinnishDemo({ client, log: () => {} }), /npm run local:runtime/);
});

test('real routes + PG: the demo company is born Finnish and its statement is queued',
  { skip: PG_URL ? false : 'DONNA_PG_TEST_URL not set — demo loader lifecycle not exercised' }, async () => {
    const dbName = `donna_demo_fi_${Date.now().toString(36)}_${process.pid}`;
    const admin = new pg.Client({ connectionString: PG_URL });
    await admin.connect();
    await admin.query(`create database "${dbName}"`);
    const scratchUrl = new URL(PG_URL); scratchUrl.pathname = `/${dbName}`;
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    const blobDir = mkdtempSync(path.join(os.tmpdir(), 'donna-demo-fi-blobs-'));
    const envKeys = ['DATABASE_URL', 'DATABASE_POOL_MAX', 'DONNA_DESKTOP_BLOB_DIR', 'DONNA_ACCESS_TOKEN', 'DONNA_DEFAULT_FIRM_ID',
      'DONNA_DESKTOP_SCHEDULER', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_MODEL'];
    const priorEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    let runtime = null;
    let endPool = null;
    try {
      // The book the quickstart boots: the storage stub the local Postgres
      // supervisor creates (pgSupervisor.js), then the real migration runner,
      // which records each migration as Host A requires.
      await db.query(`create schema if not exists storage;
        create table if not exists storage.buckets (id text primary key, name text, public boolean,
          file_size_limit bigint, allowed_mime_types text[]);
        create table if not exists storage.objects (id uuid default gen_random_uuid() primary key,
          bucket_id text references storage.buckets(id), name text, metadata jsonb);`);
      execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'migrate_firm_db.js')], {
        cwd: ROOT, stdio: 'pipe', env: { ...process.env, DATABASE_URL: scratchUrl.toString() }
      });
      for (const key of ['DONNA_DEFAULT_FIRM_ID', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'TYPESAFE_API_KEY', 'TYPESAFE_MODEL']) delete process.env[key];
      Object.assign(process.env, {
        DATABASE_URL: scratchUrl.toString(), DATABASE_POOL_MAX: '2', DONNA_DESKTOP_BLOB_DIR: blobDir, DONNA_ACCESS_TOKEN: 'demo-test-token'
      });
      // The runtime assembly `npm run local:runtime` starts: router, Host A
      // readiness and the local scheduler. No provider key is set, so the
      // parse job ends 'skipped' rather than reading the statement.
      delete process.env.DONNA_DESKTOP_SCHEDULER;
      const probe = http.createServer();
      const port = await new Promise((resolve) => probe.listen(0, '127.0.0.1', () => resolve(probe.address().port)));
      await new Promise((resolve) => probe.close(resolve));
      const { createDonnaRuntimeServer } = await import('../server/donna/desktop/runtimeServer.js');
      ({ __endFirmDbPoolForTests: endPool } = await import('../server/donna/firmDb.js'));
      runtime = await createDonnaRuntimeServer({ listen: { host: '127.0.0.1', port }, logger: { log: () => {}, error: () => {} } });
      const client = createRuntimeClient({ baseUrl: `http://127.0.0.1:${port}`, accessToken: 'demo-test-token' });

      const first = await loadFinnishDemo({ client, log: () => {} });
      assert.deepEqual(first.uploaded, [DEMO_STATEMENT_FILE]);

      const firm = (await db.query('select id, jurisdiction, default_currency from firms')).rows;
      assert.deepEqual(firm, [{ id: 'firm-demo-tilitoimisto', jurisdiction: 'FI', default_currency: 'EUR' }]);
      const company = (await db.query('select id, firm_id, jurisdiction, entity_type from clients')).rows;
      assert.deepEqual(company, [{ id: DEMO_CLIENT_ID, firm_id: 'firm-demo-tilitoimisto', jurisdiction: 'FI', entity_type: 'fi-oy' }]);
      const flags = new Set((await db.query(
        'select flag_key from client_capability_config where client_id = $1 and valid_to is null', [DEMO_CLIENT_ID]
      )).rows.map((row) => row.flag_key));
      for (const key of ['FINLAND_ALV_CODING', 'DOCUMENT_SETTLEMENT_LEDGER_ENTRY', 'DOCUMENT_ROUTER_ENABLED', 'JEV_RECONCILIATION']) {
        assert.ok(flags.has(key), `${key} is staged at birth`);
      }
      const accounts = Number((await db.query('select count(*)::int as n from ledger_accounts where client_id = $1', [DEMO_CLIENT_ID])).rows[0].n);
      assert.ok(accounts > 0, 'the Finnish chart is born with the company');
      const docs = (await db.query('select filename, document_type, parse_status, parse_run_id from documents where client_id = $1', [DEMO_CLIENT_ID])).rows;
      assert.equal(docs.length, 1);
      assert.equal(docs[0].filename, DEMO_STATEMENT_FILE);
      assert.equal(docs[0].document_type, 'bank_statement');
      assert.ok(docs[0].parse_run_id, 'the statement was queued for parsing');
      assert.ok(['pending', 'processing', 'skipped'].includes(docs[0].parse_status), docs[0].parse_status);

      const second = await loadFinnishDemo({ client, log: () => {} });
      assert.deepEqual(second.uploaded, [], 'a re-run uploads nothing');
      assert.equal(Number((await db.query('select count(*)::int as n from firms')).rows[0].n), 1);
      assert.equal(Number((await db.query('select count(*)::int as n from documents')).rows[0].n), 1);
    } finally {
      if (runtime) await runtime.stop();
      if (endPool) await endPool();
      for (const key of envKeys) {
        if (priorEnv[key] === undefined) delete process.env[key];
        else process.env[key] = priorEnv[key];
      }
      await db.end();
      await admin.query(`drop database if exists "${dbName}" with (force)`);
      await admin.end();
      rmSync(blobDir, { recursive: true, force: true });
    }
  });
