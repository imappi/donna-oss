import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import pg from 'pg';
import donnaRouter from '../../api/donna-router.js';
import { __setFirmDbPoolForTests, __resetFirmDbPoolForTests } from './firmDb.js';

const pgUrl = process.env.DONNA_PG_TEST_URL;

// Real router + vercel rewrites + real PG. The signer is the real
// createEvidenceSignedUrl talking to a stubbed storage host, so what the test
// observes is exactly which bucket/key the service-role key was used for.
test('real PG/HTTP: document PATCH cannot retarget a download; download signs only the persisted own reference', async t => {
  assert.ok(pgUrl, 'INCOMPLETE: DONNA_PG_TEST_URL must name disposable PostgreSQL');
  const dbName = `donna_download_ref_${process.pid}_${Date.now()}`;
  const admin = new pg.Client({ connectionString: pgUrl }); await admin.connect();
  await admin.query(`create database "${dbName}"`);
  const url = new URL(pgUrl); url.pathname = `/${dbName}`;
  const seed = new pg.Client({ connectionString: url.toString() }); await seed.connect();
  const pool = new pg.Pool({ connectionString: url.toString(), connectionTimeoutMillis: 2000 });
  __setFirmDbPoolForTests(pool);
  const env = { DATABASE_URL: url.toString(), DONNA_DEFAULT_FIRM_ID: 'rb-firm-a', DONNA_DESKTOP_BLOB_DIR: '',
    DONNA_ACCESS_TOKEN: 'unused', SUPABASE_URL: 'https://rb.invalid', SUPABASE_ANON_KEY: 'fixture',
    SUPABASE_PUBLISHABLE_KEY: '', SUPABASE_SERVICE_ROLE_KEY: 'fixture-no-network', SUPABASE_SERVICE_KEY: '', SUPABASE_SECRET_KEY: '',
    DONNA_EVIDENCE_BUCKET: '', SUPABASE_EVIDENCE_BUCKET: '',
    DONNA_AUTH_ALLOWED_EMAILS: '', VERCEL: '1', VERCEL_PROJECT_ID: 'rb-fixture', VERCEL_ENV: 'preview',
    VERCEL_DEPLOYMENT_ID: 'rb-fixture-deployment', VERCEL_GIT_COMMIT_SHA: 'rb-fixture-source',
    OPENAI_API_KEY: 'fixture-no-network', ANTHROPIC_API_KEY: 'fixture-no-network' };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env);
  const realFetch = globalThis.fetch;
  const signed = [];
  globalThis.fetch = async (address, init = {}) => {
    const u = new URL(String(address));
    if (u.origin === 'https://rb.invalid' && u.pathname === '/auth/v1/user') {
      const token = init.headers.Authorization.replace('Bearer ', '');
      return new Response(JSON.stringify({ id: `user-${token}`, email: `${token}@rb.invalid` }));
    }
    if (u.origin === 'https://rb.invalid' && u.pathname.startsWith('/storage/v1/object/sign/')) {
      signed.push(decodeURIComponent(u.pathname.replace('/storage/v1/object/sign/', '')));
      return new Response(JSON.stringify({ signedURL: `/object/sign/x?token=t${signed.length}` }));
    }
    if (u.hostname === 'inn.gs' || (u.hostname === 'localhost' && u.port === '8288')) return new Response(JSON.stringify({ ids: ['e'], status: 200 }));
    throw new Error(`Unexpected external call: ${address}`);
  };
  const rewrites = JSON.parse(await readFile(new URL('../../vercel.json', import.meta.url), 'utf8')).rewrites;
  const server = http.createServer((req, res) => {
    const incoming = new URL(req.url, 'http://fixture');
    // vercel.json rewrites with `:param` segments, matched the way Vercel does.
    let destination = null;
    for (const row of rewrites) {
      const names = [];
      const match = incoming.pathname.match(new RegExp(`^${row.source.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`));
      if (!match) continue;
      destination = names.reduce((d, n, i) => d.replaceAll(`:${n}`, match[i + 1]), row.destination);
      break;
    }
    if (!destination) { res.statusCode = 404; res.end('{}'); return; }
    const target = new URL(destination, 'http://fixture');
    for (const [key, value] of incoming.searchParams) target.searchParams.append(key, value);
    req.url = target.pathname + target.search;
    donnaRouter(req, res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    globalThis.fetch = realFetch; __resetFirmDbPoolForTests(); await pool.end(); await seed.end();
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await admin.query(`drop database "${dbName}"`); await admin.end();
  });
  const call = (token, method, path, body) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, res => {
      let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : {} }));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });

  await seed.query(`create schema storage;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key,bucket_id text references storage.buckets(id),name text,metadata jsonb)`);
  for (const file of (await readdir(new URL('../../db/migrations/', import.meta.url))).filter(f => f.endsWith('.sql')).sort()) {
    await seed.query(await readFile(new URL(`../../db/migrations/${file}`, import.meta.url), 'utf8'));
    await seed.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  for (const name of ['a', 'b']) {
    await seed.query("insert into firms(id,name,slug,jurisdiction,default_currency) values($1,$1,$1,'FI','EUR')", [`rb-firm-${name}`]);
    await seed.query("insert into firm_members(id,firm_id,user_id,email,name,role,status,access_level) values($1,$2,$3,$4,'Member','admin','active','owner')",
      [`member-${name}`, `rb-firm-${name}`, `user-${name}`, `${name}@rb.invalid`]);
  }
  const firmId = 'rb-firm-a';
  await seed.query("insert into clients(id,firm_id,company_name,status) values('own',$1,'own','active'),('victim','rb-firm-b','victim','active')", [firmId]);
  await seed.query("insert into firm_collaborators(id,firm_id,user_id,email,name,status) values('collab',$1,'user-c','c@rb.invalid','Owner','active')", [firmId]);
  await seed.query("insert into client_assignments(id,firm_id,client_id,principal_type,principal_id,role) values('own-assign',$1,'own','firm_collaborator','collab','owner')", [firmId]);

  const checksum = createHash('sha256').update('own').digest('hex');
  const ownKey = `${firmId}/own/evidence/own.pdf`;
  const foreignKey = 'rb-firm-b/victim/evidence/secret.pdf';
  const registered = await call('a', 'POST', '/api/donna/firms/documents/register', { firm_id: firmId, documents: [{
    id: 'own-doc', client_id: 'own', filename: 'own.pdf', document_type: 'unknown', storage_bucket: 'donna-evidence',
    storage_object_key: ownKey, checksum_sha256: checksum, file_size: 3, mime_type: 'application/pdf', storage_provider: 'supabase_storage' }] });
  assert.equal(registered.status, 200, JSON.stringify(registered));
  const persisted = async () => (await seed.query("select storage_bucket, storage_object_key, payload from documents where id='own-doc'")).rows[0];
  const download = token => call(token, 'GET', `/api/donna/firms/documents/own-doc/download?firm_id=${firmId}`);
  const patch = (token, body) => call(token, 'PATCH', '/api/donna/firms/documents/own-doc', { firm_id: firmId, patch: body });

  // (a) the exploit sequence: refused for the member and the scoped portal owner.
  const exploits = [
    { storage_key: foreignKey },
    { storage_bucket: 'some-other-private-bucket', storage_key: 'any/object' },
    { storage_object_key: foreignKey }, { storage_provider: 'local_blob' },
    { file_storage: { bucket: 'some-other-private-bucket', key: foreignKey } },
    { storage_key: null }, { file_storage: null }, { client_id: 'victim' }, { checksum_sha256: 'x' },
    { reviewer_note: 'fine', storage_key: foreignKey }
  ];
  const before = await persisted();
  for (const token of ['a', 'c']) for (const body of exploits) {
    const response = await patch(token, body);
    assert.equal(response.status, 400, `${token} ${JSON.stringify(body)}: ${JSON.stringify(response)}`);
    assert.equal(response.body.code, 'DOCUMENT_PATCH_RESERVED_KEY');
  }
  assert.deepEqual(await persisted(), before, 'refused patches leave the row untouched');

  // (b) neighbouring valid case: review fields patch, and download signs the own key.
  for (const token of ['a', 'c']) {
    const ok = await patch(token, { reviewer_note: `note-${token}` });
    assert.equal(ok.status, 200, JSON.stringify(ok));
    signed.length = 0;
    const dl = await download(token);
    assert.equal(dl.status, 200, JSON.stringify(dl));
    assert.deepEqual(signed, [`donna-evidence/${ownKey}`]);
  }
  assert.equal((await persisted()).payload.reviewer_note, 'note-c');

  // Even a payload poisoned directly in SQL (pre-fix rows, or any future writer)
  // never reaches the signer: only the persisted columns are signed.
  await seed.query(`update documents set payload = payload || $1::jsonb where id='own-doc'`, [JSON.stringify({
    storage_key: foreignKey, storage_bucket: 'some-other-private-bucket',
    file_storage: { bucket: 'some-other-private-bucket', key: foreignKey } })]);
  for (const token of ['a', 'c']) {
    signed.length = 0;
    assert.equal((await download(token)).status, 200);
    assert.deepEqual(signed, [`donna-evidence/${ownKey}`], 'poisoned payload is ignored');
  }

  // A poisoned persisted column (outside this firm/client, or another bucket) is refused, never signed.
  for (const [bucket, key] of [['donna-evidence', foreignKey], ['donna-evidence', `${firmId}/other-client/evidence/x.pdf`],
    ['donna-evidence', `${firmId}/own/../victim/evidence/x.pdf`], ['some-other-private-bucket', ownKey]]) {
    await seed.query("update documents set storage_bucket=$1, storage_object_key=$2 where id='own-doc'", [bucket, key]);
    for (const token of ['a', 'c']) {
      signed.length = 0;
      const dl = await download(token);
      assert.equal(dl.status, 403, `${bucket}/${key}: ${JSON.stringify(dl)}`);
      assert.equal(dl.body.code, 'EVIDENCE_DOWNLOAD_REFERENCE_INVALID');
      assert.deepEqual(signed, []);
    }
  }

  // Historical pilot quarantine key shape still reads.
  const quarantine = `${firmId}/own/__quarantine__/0b0f/own.pdf`;
  await seed.query("update documents set storage_bucket='donna-evidence', storage_object_key=$1 where id='own-doc'", [quarantine]);
  signed.length = 0;
  assert.equal((await download('a')).status, 200);
  assert.deepEqual(signed, [`donna-evidence/${quarantine}`]);
});
