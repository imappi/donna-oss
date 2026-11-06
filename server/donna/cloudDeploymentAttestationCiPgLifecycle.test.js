// Drives the CI attestation producer (scripts/cloud_deployment_attestation_ci.js)
// end to end on real PostgreSQL 17: a synthetic hosted database, a stubbed
// authenticated Vercel CLI, a stubbed Supabase Storage bucket, a clean clone of
// this checkout as the deployed source, and the RUNTIME's own verifier and
// database observer judging what the script produced. No PASS is injected
// anywhere: the artifact is minted by the real script and verified by the real
// law. Only the cloud-readiness workflow (PostgreSQL 17) runs the proof; the
// PostgreSQL 16 shards skip it with a diagnostic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import pg from 'pg';
import { prepareCiHostPostgres } from '../../scripts/prepare_ci_host_postgres.js';
import { readCloudSchemaCatalog } from '../../scripts/qualify_cloud_schema.js';
import { CLOUD_ATTESTATION_KEY, CLOUD_ATTESTATION_VERSION, cloudAttestationKeyFor, verifyCloudDeploymentAttestation } from './cloudDeploymentAttestation.js';
import { cloudSchemaCatalogDigest, CLOUD_SCHEMA_QUALIFICATION_VERSION } from './cloudSchemaQualification.js';
import { observeCloudDatabase } from './cloudHostCertificateA.js';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';

const run = promisify(execFile);
const qi = s => '"' + String(s).replaceAll('"', '""') + '"';
const pgUrl = process.env.DONNA_SCHEMA_PROOF_PG17_URL || process.env.DONNA_PG_TEST_URL;
const repoRoot = new URL('../../', import.meta.url);
const migrations = new URL('db/migrations/', repoRoot);
const TEAM = 'team_fixture', PROJECT = 'prj_fixture', TOKEN = 'fixture-vercel-token', BUCKET = 'donna-evidence', ALIAS = 'donna-fixture.vercel.app';

let created = 0;
const deployment = (id, sha, readyState = 'READY', target = 'production') => ({ id, uid: id, projectId: PROJECT, team: { id: TEAM }, ownerId: TEAM, readyState, target,
  createdAt: 1_000_000 + (created += 1000), url: `${id}.vercel.app`, gitSource: { type: 'github', sha }, meta: { githubCommitSha: sha } });
const aliasRoute = `/v4/aliases/${ALIAS}?teamId=${TEAM}`;
// `production` is what the alias serves; `ownBuild` is the pushed commit's
// (staged) production build, which is also the project's newest.
const routes = ({ production, deployments, ownBuild = null }) => ({ token: TOKEN, promote: 'move', routes: {
  [aliasRoute]: { alias: ALIAS, deploymentId: production },
  ...Object.fromEntries(deployments.map(d => [`/v13/deployments/${d.id}?teamId=${TEAM}`, d])),
  [`/v6/deployments?projectId=${PROJECT}&teamId=${TEAM}&target=production&limit=1`]: { deployments: ownBuild?.deployment ? [ownBuild.deployment] : [] },
  ...(ownBuild ? { [`/v6/deployments?projectId=${PROJECT}&teamId=${TEAM}&target=production&sha=${ownBuild.sha}&limit=1`]: { deployments: ownBuild.deployment ? [ownBuild.deployment] : [] } } : {})
} });

test('CI attestation: resolve, mint, keep, refuse, replace against real PostgreSQL 17 and the runtime verifier', {
  skip: !pgUrl && 'INCOMPLETE: a disposable local PostgreSQL 17 URL is required', timeout: 900000
}, async t => {
  const address = new URL(pgUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(address.hostname), 'local disposable host only');
  const admin = new pg.Client({ connectionString: pgUrl, connectionTimeoutMillis: 3000 });
  await admin.connect();
  const major = Math.floor((await admin.query("select current_setting('server_version_num')::int as version")).rows[0].version / 10000);
  if (major !== 17) { await admin.end(); t.skip(`INCOMPLETE: PostgreSQL 17 required for the cloud qualification; this cluster is ${major}.`); return; }
  const directory = await mkdtemp(join(tmpdir(), 'donna-attest-ci-'));
  const names = [], clients = [];
  let storage;
  t.after(async () => {
    for (const c of clients) await c.end().catch(() => {});
    for (const name of names.reverse()) await admin.query(`drop database ${qi(name)}`).catch(() => {});
    await admin.end();
    await new Promise(resolve => storage ? storage.close(resolve) : resolve());
    await rm(directory, { recursive: true, force: true });
  });

  // The hosted shape the qualifier reviews: objects authored by `postgres`,
  // browser roles present and unprivileged. These cluster roles are exactly the
  // ones cloudSchemaQualificationPgLifecycle creates transiently; here they must
  // outlive a transaction because the script connects in its own process. The
  // proof cluster (CI service or a local disposable one) is thrown away with them.
  await admin.query(`do $$ begin
    if not exists(select 1 from pg_roles where rolname='postgres') then create role postgres superuser nologin; end if;
    if not exists(select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
    if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  end $$`);
  const hostedName = `donna_hosted_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`create database ${qi(hostedName)} template template0`); names.push(hostedName);
  const hostedUrl = new URL(pgUrl); hostedUrl.pathname = '/' + hostedName;
  await prepareCiHostPostgres({ databaseUrl: hostedUrl.toString() });
  const hosted = new pg.Client({ connectionString: hostedUrl.toString(), statement_timeout: 60000 });
  await hosted.connect(); clients.push(hosted);
  await hosted.query('set role postgres');
  for (const file of (await readdir(migrations)).filter(f => f.endsWith('.sql')).sort()) {
    await hosted.query(await readFile(new URL(file, migrations), 'utf8'));
    await hosted.query('insert into schema_migrations(version) values($1) on conflict do nothing', [file.slice(0, -4)]);
  }
  await hosted.query('alter table storage.objects enable row level security; alter table storage.buckets enable row level security');
  const liveCatalogDigest = cloudSchemaCatalogDigest(await readCloudSchemaCatalog(hosted));

  // The deployed source: a clean clone of this checkout at HEAD.
  const clone = join(directory, 'deployed');
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', repoRoot.pathname, clone]);
  execFileSync('git', ['-C', clone, 'checkout', '-q', '--detach', 'HEAD']);
  await symlink(join(repoRoot.pathname, 'node_modules'), join(clone, 'node_modules'));
  const sha = execFileSync('git', ['-C', clone, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const script = join(clone, 'scripts', 'cloud_deployment_attestation_ci.js');

  // Stubbed native Vercel CLI: answers only `vercel api <path> --token <token>` from a fixture map.
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'vercel'), `#!/usr/bin/env node
const fs = require('node:fs');
const fixture = JSON.parse(fs.readFileSync(process.env.DONNA_FAKE_VERCEL_FIXTURE, 'utf8'));
const args = process.argv.slice(2), token = args.indexOf('--token'), method = args[args.indexOf('--method') + 1];
if (args[0] !== 'api' || token < 0 || args[token + 1] !== fixture.token || !args.includes('--raw')) { console.error('vercel stub: unauthenticated or unexpected invocation'); process.exit(1); }
fs.appendFileSync(process.env.DONNA_FAKE_TIMELINE, 'VERCEL ' + method + ' ' + args[1] + '\\n');
const promote = args[1].match(/^\\/v10\\/projects\\/[^/]+\\/promote\\/([^?]+)\\?/);
if (method === 'POST' && promote) {
  if (fixture.promote === 'move') { fixture.routes['${aliasRoute}'].deploymentId = promote[1]; fs.writeFileSync(process.env.DONNA_FAKE_VERCEL_FIXTURE, JSON.stringify(fixture)); }
  process.exit(0);
}
const response = method === 'GET' && fixture.routes[args[1]];
if (!response) { console.error('vercel stub: no route for ' + method + ' ' + args[1]); process.exit(1); }
process.stdout.write(JSON.stringify(response));
`); await chmod(join(bin, 'vercel'), 0o755);

  // Stubbed Supabase Storage: one in-memory bucket, service-key auth, GET + upsert POST.
  const objects = new Map(); const requests = [];
  // Stale-edge simulation: after an upsert, serve the PREVIOUS bytes for this
  // many GETs (a cache that has not converged yet), then the stored bytes.
  let staleReadsPending = 0, staleReadsAfterUpsert = 0, previousObject = null, lastUpsertKey = null;
  const timeline = join(directory, 'timeline.log');
  storage = createServer((request, response) => {
    const chunks = [];
    request.on('data', c => chunks.push(c)).on('end', () => {
      requests.push(`${request.method} ${request.url} cache-control=${request.headers['cache-control'] || ''}`);
      appendFileSync(timeline, `STORAGE ${request.method} ${decodeURIComponent(request.url.slice(`/storage/v1/object/${BUCKET}/`.length))}\n`);
      const prefix = `/storage/v1/object/${BUCKET}/`;
      if (request.headers.authorization !== 'Bearer fixture-service-key') { response.writeHead(401); return response.end('{"error":"unauthorized"}'); }
      if (!request.url.startsWith(prefix)) { response.writeHead(404); return response.end('{"error":"route"}'); }
      const key = decodeURIComponent(request.url.slice(prefix.length));
      if (request.method === 'GET') {
        if (!objects.has(key)) { response.writeHead(400, { 'content-type': 'application/json' }); return response.end('{"statusCode":"404","error":"not_found","message":"Object not found"}'); }
        if (staleReadsAfterUpsert > 0 && key === lastUpsertKey) {
          staleReadsAfterUpsert -= 1;
          // A new key's unconverged edge answers not-found; an old key's, the previous bytes.
          if (!previousObject) { response.writeHead(400, { 'content-type': 'application/json' }); return response.end('{"statusCode":"404","error":"not_found","message":"Object not found"}'); }
          response.writeHead(200, { 'content-type': 'application/json' }); return response.end(previousObject);
        }
        response.writeHead(200, { 'content-type': 'application/json' }); return response.end(objects.get(key));
      }
      if (request.method === 'POST') {
        if (objects.has(key) && request.headers['x-upsert'] !== 'true') { response.writeHead(400); return response.end('{"error":"Duplicate"}'); }
        previousObject = objects.get(key) || null; lastUpsertKey = key; staleReadsAfterUpsert = staleReadsPending; staleReadsPending = 0;
        objects.set(key, Buffer.concat(chunks)); response.writeHead(200, { 'content-type': 'application/json' }); return response.end(JSON.stringify({ Key: `${BUCKET}/${key}` }));
      }
      response.writeHead(405); response.end();
    });
  });
  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));
  const storageUrl = `http://127.0.0.1:${storage.address().port}`;

  const pair = generateKeyPairSync('ed25519');
  const privateKeyPath = join(directory, 'attestation-key.pem');
  await writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
  const fixturePath = join(directory, 'vercel-fixture.json');
  await writeFile(timeline, '');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DONNA_FAKE_VERCEL_FIXTURE: fixturePath, DONNA_FAKE_TIMELINE: timeline, VERCEL_TOKEN: TOKEN,
    SUPABASE_URL: storageUrl, SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key', DONNA_EVIDENCE_BUCKET: BUCKET,
    DONNA_HOSTED_SCHEMA_CATALOG_DATABASE_URL: hostedUrl.toString(), DONNA_SCHEMA_PROOF_PG17_URL: pgUrl };
  delete env.DONNA_DESKTOP_BLOB_DIR; delete env.DATABASE_URL; delete env.SUPABASE_SERVICE_KEY; delete env.SUPABASE_SECRET_KEY; delete env.VITE_SUPABASE_URL;
  const invoke = async (args, { expectFailure = false } = {}) => {
    try {
      const { stdout, stderr } = await run('node', [script, ...args], { cwd: directory, env, timeout: 600000, maxBuffer: 8 * 1024 * 1024 });
      assert.equal(expectFailure, false, `expected refusal, got ${stdout}`);
      return { result: JSON.parse(stdout.trim().split('\n').pop()), log: stderr };
    } catch (error) {
      if (!expectFailure || error.code === 'ERR_ASSERTION') throw error;
      return { failed: true, log: `${error.stdout || ''}${error.stderr || ''}` };
    }
  };
  const runtimeVerify = (deploymentId, artifact) => verifyCloudDeploymentAttestation({ artifact, observedAt: new Date().toISOString(),
    env: { DONNA_HOST_ATTESTATION_PUBLIC_KEY: publicKeyPem, VERCEL_PROJECT_ID: PROJECT, VERCEL_ENV: 'production', VERCEL_ORG_ID: TEAM },
    identity: resolveRuntimeHostIdentity({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: PROJECT, VERCEL_DEPLOYMENT_ID: deploymentId, VERCEL_GIT_COMMIT_SHA: sha,
      DATABASE_URL: hostedUrl.toString(), SUPABASE_URL: storageUrl }) });
  const stored = id => JSON.parse(objects.get(cloudAttestationKeyFor(id)).toString('utf8'));

  await t.test('resolve: a schedule resolves what the production alias serves', async () => {
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_live', deployments: [deployment('dpl_live', sha)] })));
    const { result } = await invoke(['resolve', '--team', TEAM, '--project', PROJECT, '--alias', ALIAS, '--output', join(directory, 'resolved.json')]);
    assert.equal(result.mode, 'serving'); assert.equal(result.deployment_id, 'dpl_live'); assert.equal(result.source_commit, sha); assert.equal(result.note, null);
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'resolved.json'), 'utf8')), result);
  });

  await t.test('resolve: a push resolves its own staged build while production still serves the previous one', async () => {
    const other = 'b'.repeat(40), previous = deployment('dpl_previous', other), staged = deployment('dpl_new', sha);
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_previous', deployments: [previous, staged], ownBuild: { sha, deployment: staged } })));
    const { result } = await invoke(['resolve', '--team', TEAM, '--project', PROJECT, '--alias', ALIAS, '--expect-source', sha, '--wait-minutes', '0', '--poll-seconds', '0']);
    assert.equal(result.mode, 'promote'); assert.equal(result.deployment_id, 'dpl_new'); assert.equal(result.source_commit, sha);
    const failedBuild = deployment('dpl_new', sha, 'ERROR');
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_previous', deployments: [previous, failedBuild], ownBuild: { sha, deployment: failedBuild } })));
    const failed = await invoke(['resolve', '--team', TEAM, '--project', PROJECT, '--alias', ALIAS, '--expect-source', sha, '--wait-minutes', '5', '--poll-seconds', '0']);
    assert.equal(failed.result.mode, 'serving'); assert.equal(failed.result.note, 'build_error'); assert.equal(failed.result.deployment_id, 'dpl_previous');
    assert.match(failed.log, /will not be promoted \(build_error\)/);
  });

  await t.test('resolve: a production that is not READY is refused', async () => {
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_building', deployments: [deployment('dpl_building', sha, 'BUILDING')] })));
    const { failed, log } = await invoke(['resolve', '--team', TEAM, '--project', PROJECT, '--alias', ALIAS], { expectFailure: true });
    assert.equal(failed, true); assert.match(log, /is BUILDING production; nothing to attest/);
  });

  let firstArtifact;
  const attestArgs = id => ['attest', '--team', TEAM, '--project', PROJECT, '--deployment', id, '--source', sha, '--private-key', privateKeyPath];
  const promoteArgs = (id, extra = []) => ['promote', '--team', TEAM, '--project', PROJECT, '--alias', ALIAS, '--deployment', id, '--source', sha,
    '--private-key', privateKeyPath, '--wait-seconds', '2', '--poll-seconds', '0', ...extra];
  await t.test('attest: mints from the live hosted catalog and the runtime verifier and observer accept it', async () => {
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_live', deployments: [deployment('dpl_live', sha)] })));
    const { result, log } = await invoke(attestArgs('dpl_live'));
    assert.equal(result.action, 'minted'); assert.equal(result.previous, 'absent'); assert.equal(result.deployment_id, 'dpl_live');
    assert.equal(result.key, cloudAttestationKeyFor('dpl_live'));
    assert.match(log, /stored attestation: absent/); assert.match(log, /minted: dpl_live/);
    assert.ok(objects.has(cloudAttestationKeyFor('dpl_live')), 'artifact published at the deployment\'s own key');
    assert.ok(!objects.has(CLOUD_ATTESTATION_KEY), 'attest alone never writes the single slot');
    firstArtifact = stored('dpl_live');
    assert.equal(firstArtifact.payload.version, CLOUD_ATTESTATION_VERSION);
    assert.equal(firstArtifact.payload.schema_qualification.version, CLOUD_SCHEMA_QUALIFICATION_VERSION);
    assert.equal(firstArtifact.payload.schema_qualification.status, 'PASS');
    assert.equal(firstArtifact.payload.schema_qualification.catalog_digest, liveCatalogDigest, 'qualified the catalog the runtime will observe');
    assert.ok(Date.parse(firstArtifact.payload.expires_at) - Date.parse(firstArtifact.payload.issued_at) <= 7 * 24 * 3600 * 1000);
    const verdict = runtimeVerify('dpl_live', firstArtifact);
    assert.equal(verdict.status, 'PASS', JSON.stringify(verdict));
    assert.equal(verdict.detail.deployment_id, 'dpl_live'); assert.equal(verdict.detail.commit_sha, sha);
    assert.equal(runtimeVerify('dpl_other', firstArtifact).detail.reason, 'cloud_attestation_generation_mismatch');
    const observed = await observeCloudDatabase({ query: (text, params) => hosted.query(text, params), rootDir: repoRoot.pathname, observedAt: new Date().toISOString(),
      schemaQualification: firstArtifact.payload.schema_qualification, connection: { fixture: 'synthetic-hosted' } });
    assert.equal(observed.status, 'PASS', JSON.stringify(observed.detail));
    assert.equal(observed.detail.restored_schema_qualification.catalog_digest, liveCatalogDigest);
    assert.equal(execFileSync('git', ['-C', clone, 'status', '--porcelain'], { encoding: 'utf8' }).trim(), '', 'the deployed clone stays clean');
    // A schedule on what serves: nothing to promote, the single slot mirrors it.
    const { result: serving } = await invoke(promoteArgs('dpl_live'));
    assert.equal(serving.action, 'already_serving'); assert.equal(serving.legacy_slot, 'mirrored');
    assert.ok(objects.get(CLOUD_ATTESTATION_KEY).equals(objects.get(cloudAttestationKeyFor('dpl_live'))));
  });

  await t.test('attest: a fresh matching attestation is kept byte for byte', async () => {
    const before = objects.get(cloudAttestationKeyFor('dpl_live')), postsBefore = requests.filter(r => r.startsWith('POST')).length;
    const { result, log } = await invoke(attestArgs('dpl_live'));
    assert.equal(result.action, 'kept'); assert.equal(result.previous, 'fresh'); assert.equal(result.expires_at, firstArtifact.payload.expires_at);
    assert.match(log, /stored attestation: fresh for dpl_live/);
    assert.ok(objects.get(cloudAttestationKeyFor('dpl_live')).equals(before)); assert.equal(requests.filter(r => r.startsWith('POST')).length, postsBefore);
  });

  await t.test('attest: a deployment that is not READY, or not the stated source, signs and publishes nothing — and so is never promoted', async () => {
    const postsBefore = requests.filter(r => r.startsWith('POST')).length;
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_live', deployments: [deployment('dpl_live', sha), deployment('dpl_next', sha, 'BUILDING')] })));
    let { failed, log } = await invoke(attestArgs('dpl_next'), { expectFailure: true });
    assert.equal(failed, true); assert.match(log, /not a READY production build/);
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_live', deployments: [deployment('dpl_live', sha), deployment('dpl_next', 'c'.repeat(40))] })));
    ({ failed, log } = await invoke(attestArgs('dpl_next'), { expectFailure: true }));
    assert.equal(failed, true); assert.match(log, /Nothing signed/);
    assert.equal(requests.filter(r => r.startsWith('POST')).length, postsBefore, 'refusals publish nothing');
    assert.ok(!objects.has(cloudAttestationKeyFor('dpl_next')));
    // Even if the promote step were reached, it refuses: nothing verifying is stored.
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_live', deployments: [deployment('dpl_live', sha), deployment('dpl_next', sha)] })));
    await writeFile(timeline, '');
    ({ failed, log } = await invoke(promoteArgs('dpl_next'), { expectFailure: true }));
    assert.equal(failed, true); assert.match(log, /no verifying attestation in storage \(absent\)\. Nothing promoted/);
    assert.ok(!(await readFile(timeline, 'utf8')).includes('/promote/'), 'no promote call');
    assert.equal(JSON.parse(await readFile(fixturePath, 'utf8')).routes[aliasRoute].deploymentId, 'dpl_live');
  });

  await t.test('attest before promote: the staged build is attested, published, read back, THEN promoted; what served stays attested throughout', async () => {
    const live = deployment('dpl_live', sha), staged = deployment('dpl_next', sha);
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_live', deployments: [live, staged], ownBuild: { sha, deployment: staged } })));
    const liveBefore = objects.get(cloudAttestationKeyFor('dpl_live'));
    await writeFile(timeline, '');
    const resolved = await invoke(['resolve', '--team', TEAM, '--project', PROJECT, '--alias', ALIAS, '--expect-source', sha, '--wait-minutes', '0', '--poll-seconds', '0']);
    assert.equal(resolved.result.mode, 'promote'); assert.equal(resolved.result.deployment_id, 'dpl_next');
    const { result, log } = await invoke(attestArgs('dpl_next'));
    assert.equal(result.action, 'minted'); assert.equal(result.previous, 'absent');
    // Between publish and promote the deployment production serves still
    // verifies from its own key: this is the window the change closes.
    assert.ok(objects.get(cloudAttestationKeyFor('dpl_live')).equals(liveBefore));
    assert.equal(runtimeVerify('dpl_live', stored('dpl_live')).status, 'PASS');
    assert.equal(runtimeVerify('dpl_next', stored('dpl_next')).status, 'PASS');
    assert.match(log, /minted: dpl_next/);
    const promoted = await invoke(promoteArgs('dpl_next', ['--expect-staged', 'true']));
    assert.equal(promoted.result.action, 'promoted'); assert.equal(promoted.result.previous_deployment_id, 'dpl_live'); assert.equal(promoted.result.legacy_slot, 'mirrored');
    assert.doesNotMatch(promoted.log, /WARNING/);
    const calls = (await readFile(timeline, 'utf8')).trim().split('\n');
    const at = pattern => calls.findIndex(c => pattern.test(c));
    const ownKey = cloudAttestationKeyFor('dpl_next').replaceAll('/', '\\/').replace('.', '\\.');
    const upload = at(new RegExp(`^STORAGE POST ${ownKey}$`));
    const readBack = calls.findIndex((c, i) => i > upload && new RegExp(`^STORAGE GET ${ownKey}$`).test(c));
    const promote = at(/^VERCEL POST \/v10\/projects\/prj_fixture\/promote\/dpl_next\?teamId=team_fixture$/);
    const aliasVerified = calls.findIndex((c, i) => i > promote && c.startsWith(`VERCEL GET ${aliasRoute}`));
    const mirrored = at(/^STORAGE POST __host_certificate_a__\/deployment-attestation\.json$/);
    assert.ok(upload >= 0 && readBack > upload && promote > readBack && aliasVerified > promote && mirrored > aliasVerified,
      `attest → publish → read-back → promote → alias → single slot: ${calls.join(' | ')}`);
    assert.equal(calls.filter(c => c.includes('/promote/')).length, 1);
    assert.equal(JSON.parse(await readFile(fixturePath, 'utf8')).routes[aliasRoute].deploymentId, 'dpl_next');
    assert.ok(objects.get(CLOUD_ATTESTATION_KEY).equals(objects.get(cloudAttestationKeyFor('dpl_next'))));
    assert.notEqual(stored('dpl_next').signature, firstArtifact.signature);
    assert.equal(runtimeVerify('dpl_next', firstArtifact).status, 'INCOMPLETE');
  });

  await t.test('attest: a stale read after the upsert converges within the read-back ladder', async () => {
    // 2026-09-21 first live run: the upload landed, the immediate read-back
    // returned the previous artifact, the job failed; three minutes later the
    // retry found the minted bytes fresh. The ladder absorbs that — and, for a
    // new per-deployment key, an edge still answering not-found.
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_next', deployments: [deployment('dpl_third', sha)] })));
    staleReadsPending = 2; env.DONNA_ATTESTATION_READBACK_DELAYS_MS = '20,20,20,20';
    const postsBefore = requests.filter(r => r.startsWith('POST')).length;
    const { result, log } = await invoke(attestArgs('dpl_third'));
    assert.equal(result.action, 'minted'); assert.equal(result.deployment_id, 'dpl_third');
    assert.equal(result.read_back_attempts, 3, 'two unconverged reads, then the minted bytes');
    assert.match(log, /read-back 1: storage still serves digest absent/); assert.match(log, /read-back 2: storage still serves digest absent/);
    assert.equal(stored('dpl_third').payload.deployment_id, 'dpl_third'); assert.equal(staleReadsAfterUpsert, 0);
    assert.equal(requests.filter(r => r.startsWith('POST')).length, postsBefore + 1, 'one upload, never re-uploaded on a stale read');
    const uploads = requests.filter(r => r.startsWith('POST')).slice(-1);
    assert.match(uploads[0], /cache-control=no-cache, max-age=0/, 'the object is stored uncacheable');
    const lastPost = requests.map((r, i) => [r, i]).filter(([r]) => r.startsWith('POST')).pop()[1];
    const readBacks = requests.slice(lastPost + 1).filter(r => r.startsWith('GET') && r.includes('dpl_third')).slice(0, 3);
    assert.equal(readBacks.length, 3);
    assert.ok(readBacks.every(r => /cache-control=no-cache/.test(r)), `read-backs bypass caches: ${readBacks.join(' | ')}`);
    assert.equal(runtimeVerify('dpl_third', stored('dpl_third')).status, 'PASS');
    // An old key's unconverged edge serves the previous bytes: same ladder.
    // Make the stored object stale (another deployment's artifact at this key)
    // so the run re-mints, then serve those previous bytes once after upsert.
    objects.set(cloudAttestationKeyFor('dpl_third'), objects.get(cloudAttestationKeyFor('dpl_live')));
    staleReadsPending = 1;
    const { result: again, log: againLog } = await invoke(attestArgs('dpl_third'));
    assert.equal(again.action, 'replaced'); assert.equal(again.read_back_attempts, 2);
    assert.match(againLog, /read-back 1: storage still serves digest [0-9a-f]{64}, minted/);
  });

  await t.test('attest: a read-back that never converges fails loudly, says the upload was accepted, and the job never reaches promote', async () => {
    await writeFile(fixturePath, JSON.stringify(routes({ production: 'dpl_next', deployments: [deployment('dpl_fourth', sha)] })));
    staleReadsPending = 99; env.DONNA_ATTESTATION_READBACK_DELAYS_MS = '10,10';
    const { failed, log } = await invoke(attestArgs('dpl_fourth'), { expectFailure: true });
    assert.equal(failed, true);
    assert.match(log, /still differs from the minted artifact after 3 read-backs over 20 ms/);
    assert.match(log, /The upload was accepted/);
    assert.equal(stored('dpl_fourth').payload.deployment_id, 'dpl_fourth', 'the minted artifact is in storage despite the failed read-back');
    staleReadsAfterUpsert = 0; staleReadsPending = 0; delete env.DONNA_ATTESTATION_READBACK_DELAYS_MS;
    assert.equal(runtimeVerify('dpl_fourth', stored('dpl_fourth')).status, 'PASS');
    assert.equal(JSON.parse(await readFile(fixturePath, 'utf8')).routes[aliasRoute].deploymentId, 'dpl_next', 'production unchanged');
  });

  t.diagnostic('Real PostgreSQL 17 CI attestation lifecycle PASS: live catalog export, real mint, runtime verifier + database observer, kept/refused, attest → publish → read-back → promote, stale read-back convergence.');
});
