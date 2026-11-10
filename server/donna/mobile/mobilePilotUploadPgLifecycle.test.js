// The phone's register on a Finnish cloud-pilot book, on real PostgreSQL,
// through the real router (`handleDonnaApiRequest` over HTTP) on a process
// whose runtime identity is the cloud host. All identities, companies and
// files are synthetic.
//
// On that host the existing intake (cloudEvidenceIntake.js) checks the
// registered file's `mime_type` and `size` against the upload intent the
// server signed for it. The contract's register item carries neither, so the
// adapter recovers them from that signed intent (written by the server from
// the values it checked at signing, keyed by the server-minted quarantine
// key) and passes them to the existing route; the writer's own check and its
// byte verification are unchanged.
//
// What this file can and cannot prove on PostgreSQL 16: the signer
// (createCloudPilotUpload) needs an entity whose pilot processing was enabled,
// and enabling needs a PASS cloud host certificate, which only PostgreSQL 17
// produces (cloudProducerPgLifecycle.test.js skips the same steps on 16). So
// the intent row is written here in the signer's exact shape, attributed to
// the owner, and the register is followed to the first gate after the intent
// check. The real signer's refusal on this unenrolled book is pinned first.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { readdir, readFile } from 'node:fs/promises';
import pg from 'pg';

import { responseSchemaFor, validateAgainst } from './contractSchema.js';

const IDP = 'https://idp.mobile-pilot-fixture.invalid';
const FIRM_ID = 'mobile-pilot-firm';
const IDENTITIES = {
  owner: { id: 'user-pilot-owner', email: 'owner@mobile-pilot-fixture.example', password: 'owner-pass' },
  partner: { id: 'user-pilot-partner', email: 'partner@mobile-pilot-fixture.example', password: 'partner-pass' }
};

const installIdentityProvider = () => {
  const realFetch = globalThis.fetch;
  const live = new Map();
  let seq = 0;
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.origin !== IDP) return realFetch(input, init);
    const bearer = String(init.headers?.Authorization || '').replace(/^Bearer\s+/i, '');
    if (url.pathname === '/auth/v1/user') {
      const key = live.get(bearer);
      return key ? json({ id: IDENTITIES[key].id, email: IDENTITIES[key].email }) : json({ msg: 'invalid JWT' }, 401);
    }
    if (url.pathname === '/auth/v1/token' && url.searchParams.get('grant_type') === 'password') {
      const body = JSON.parse(init.body);
      const key = Object.keys(IDENTITIES).find((name) => IDENTITIES[name].email === body.email && IDENTITIES[name].password === body.password);
      if (!key) return json({ error: 'invalid_grant' }, 400);
      seq += 1;
      const access = `access-${key}-${seq}`;
      live.set(access, key);
      return json({ access_token: access, refresh_token: `refresh-${key}-${seq}`, expires_in: 3600, token_type: 'bearer' });
    }
    if (url.pathname === '/auth/v1/logout') return new Response(null, { status: 204 });
    return json({ error: 'unexpected' }, 404);
  };
  return { restore: () => { globalThis.fetch = realFetch; } };
};

const conformError = (response, status, code) => {
  assert.equal(response.status, status, response.text);
  assert.deepEqual(validateAgainst(response.json, { $ref: '#/components/schemas/ApiError' }), []);
  if (code) assert.equal(response.json.code, code, response.text);
};

test('real PG, cloud host: a phone register on a Finnish pilot book carries the signed intent’s type and size', {
  skip: process.env.DONNA_PG_TEST_URL ? false : 'DONNA_PG_TEST_URL not set', timeout: 300_000
}, async (t) => {
  const priorEnv = { ...process.env };
  const admin = new pg.Client({ connectionString: process.env.DONNA_PG_TEST_URL });
  await admin.connect();
  const dbName = `donna_mobile_pilot_${process.pid}_${Date.now()}`;
  await admin.query(`create database "${dbName}"`);
  const url = new URL(process.env.DONNA_PG_TEST_URL);
  url.pathname = `/${dbName}`;
  const idp = installIdentityProvider();
  let server = null;
  let pool = null;
  t.after(async () => {
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    const { __resetFirmDbPoolForTests } = await import('../db/pool.js');
    __resetFirmDbPoolForTests();
    await pool?.end();
    idp.restore();
    for (const key of Object.keys(process.env)) if (!(key in priorEnv)) delete process.env[key];
    Object.assign(process.env, priorEnv);
    await admin.query(`drop database if exists "${dbName}" with (force)`);
    await admin.end();
  });
  // The cloud host's identity, from server environment only.
  Object.assign(process.env, {
    DATABASE_URL: url.toString(), VERCEL: '1', VERCEL_ENV: 'preview', VERCEL_PROJECT_ID: 'prj_mobile_pilot_fixture',
    VERCEL_DEPLOYMENT_ID: 'dpl_mobile_pilot_fixture', VERCEL_GIT_COMMIT_SHA: 'c'.repeat(40), INNGEST_APP_ID: 'donna-firm',
    DONNA_DESKTOP_BLOB_DIR: '', SUPABASE_URL: IDP, SUPABASE_ANON_KEY: 'fixture-anon', SUPABASE_PUBLISHABLE_KEY: '',
    SUPABASE_SERVICE_ROLE_KEY: 'fixture-storage', DONNA_AUTH_ALLOWED_EMAILS: '', DONNA_MOBILE_API: '',
    DONNA_ACCESS_TOKEN: 'fixture-shared-token-not-an-owner', DONNA_DEFAULT_FIRM_ID: FIRM_ID
  });
  pool = new pg.Pool({ connectionString: url.toString(), max: 4, connectionTimeoutMillis: 2000 });
  const { __setFirmDbPoolForTests } = await import('../db/pool.js');
  __setFirmDbPoolForTests(pool);
  // The CI storage stub (scripts/prepare_ci_host_postgres.js) migration 010 needs.
  await pool.query(`create schema storage; create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid default gen_random_uuid() primary key, bucket_id text references storage.buckets(id), name text, metadata jsonb)`);
  const dir = new URL('../../../db/migrations/', import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort()) {
    await pool.query(await readFile(new URL(file, dir), 'utf8'));
    await pool.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await pool.query("insert into firms(id, name, slug) values ($1, 'Synthetic pilot firm', $1)", [FIRM_ID]);
  await pool.query("insert into firm_members(id, firm_id, email, name, role, status) values ('pilot-operator', $1, 'operator@mobile-pilot-fixture.example', 'Operator', 'admin', 'active')", [FIRM_ID]);

  const { handleDonnaApiRequest } = await import('../api.js');
  const { selfProvisionClientWorkspace } = await import('../selfProvisionDb.js');
  const { prepareFinnishHostedPilotInDb, reviewFinnishHostedPilotInDb } = await import('../hostedPilot.js');
  const { CLOUD_UPLOAD_INTENT_ACTION } = await import('../cloudEvidenceIntake.js');
  const { resolveRuntimeHostIdentity } = await import('../runtimeHostIdentity.js');
  const { MOBILE_API_PATH_PREFIX, __resetMobileSignInLimiterForTests } = await import('./mobileApi.js');
  __resetMobileSignInLimiterForTests();
  assert.equal(resolveRuntimeHostIdentity().runtime_host, 'vercel');
  assert.equal(resolveRuntimeHostIdentity().reason, null, 'a complete cloud host generation');

  const { clientId } = await selfProvisionClientWorkspace({ auth: { userId: IDENTITIES.owner.id, email: IDENTITIES.owner.email },
    companyName: 'Revontuli Ceramics Oy', jurisdiction: 'FI', entityType: 'fi-oy' });
  assert.ok(clientId);
  // The Finnish hosted pilot, prepared by its real operator writer.
  const setupReview = await reviewFinnishHostedPilotInDb({ firmId: FIRM_ID, clientId, actorId: 'pilot-operator' });
  await prepareFinnishHostedPilotInDb({ firmId: FIRM_ID, clientId, actorId: 'pilot-operator', expectedClientVersion: setupReview.client_version,
    profilePatch: { companyName: 'Revontuli Ceramics Oy', jurisdiction: 'FI', entityType: 'fi-oy', accountingCurrency: 'EUR',
      accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' } });
  const owner = (await pool.query('select id from firm_collaborators where firm_id = $1 and user_id = $2', [FIRM_ID, IDENTITIES.owner.id])).rows[0];
  assert.ok(owner?.id);

  server = createServer((req, res) => { handleDonnaApiRequest(req, res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async ({ method = 'GET', path, token, body }) => {
    const response = await fetch(`${base}${MOBILE_API_PATH_PREFIX}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    return { status: response.status, text, json };
  };
  const signIn = await api({ method: 'POST', path: '/auth/sessions', body: { email: IDENTITIES.owner.email, password: IDENTITIES.owner.password } });
  assert.equal(signIn.status, 200, signIn.text);
  assert.deepEqual(validateAgainst(signIn.json, responseSchemaFor('/auth/sessions', 'POST', 200)), []);
  const token = signIn.json.access_token;

  const bytes = Buffer.from('%PDF-1.4 synthetic pilot receipt\n');
  const checksum = createHash('sha256').update(bytes).digest('hex');

  // The real signer on this host: the book's pilot processing has not been
  // enabled (that needs the PostgreSQL 17 host certificate), so it refuses.
  conformError(await api({ method: 'POST', path: `/entities/${clientId}/documents/upload-intent`, token,
    body: { filename: 'receipt.pdf', mime_type: 'application/pdf', size: bytes.length, checksum_sha256: checksum } }),
  409, 'PILOT_PROCESSING_NOT_ENROLLED');

  // The intent exactly as createCloudPilotUpload persists it.
  const writeIntent = async ({ principalId = owner.id, mimeType = 'application/pdf', size = bytes.length } = {}) => {
    const key = `${FIRM_ID}/${clientId}/__quarantine__/${randomUUID()}/receipt.pdf`;
    await pool.query(
      `insert into audit_events(firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'firm_collaborator', $3, $4, 'evidence_upload', $5, $6::jsonb)`,
      [FIRM_ID, clientId, principalId, CLOUD_UPLOAD_INTENT_ACTION, key, JSON.stringify({
        version: 'donna.cloud-evidence-intake.v1', bucket: 'donna-evidence', key, checksum, size, mime_type: mimeType,
        host_generation: resolveRuntimeHostIdentity().generation_digest, entity_dependency_digest: null,
        principal: { type: 'firm_collaborator', id: principalId }, expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        authority_basis: 'scoped_principal_and_current_entity_readiness'
      })]);
    return key;
  };
  const register = (key, overrides = {}) => api({ method: 'POST', path: `/entities/${clientId}/documents/register`, token, body: {
    documents: [{ id: `pilot-${randomUUID()}`, filename: 'receipt.pdf', storage_bucket: 'donna-evidence', storage_object_key: key,
      checksum_sha256: checksum, source: 'camera', ...overrides }]
  } });

  // The owner's own signed intent: the type and size the server signed reach
  // the existing check, which passes; the register stops at the next gate
  // (pilot processing not enabled) — never at the intent match.
  const key = await writeIntent();
  conformError(await register(key), 409, 'PILOT_PROCESSING_NOT_ENROLLED');

  // Nothing is lifted from an intent that is not this owner's or that does
  // not match: those still fail the unchanged intent check.
  const partnerKey = await writeIntent({ principalId: 'collab-another-owner' });
  conformError(await register(partnerKey), 409, 'PILOT_UPLOAD_INTENT_MISMATCH');
  conformError(await register(key, { checksum_sha256: 'f'.repeat(64) }), 409, 'PILOT_UPLOAD_INTENT_MISMATCH');
  conformError(await register(`${FIRM_ID}/${clientId}/__quarantine__/${randomUUID()}/never-signed.pdf`), 409, 'PILOT_UPLOAD_INTENT_MISMATCH');
  assert.equal((await pool.query('select count(*)::int n from documents where firm_id = $1', [FIRM_ID])).rows[0].n, 0, 'no document was written');
});
