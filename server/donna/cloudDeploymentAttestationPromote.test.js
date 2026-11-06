// Attest before promote (2026-09-23 finding): the CI job resolves the pushed
// commit's STAGED production build, attests it, and only then promotes it, so
// production never serves a build without a published attestation. This file
// drives the real producer script's `resolve` and `promote` subcommands as a
// subprocess against a stubbed authenticated Vercel CLI (stateful: a promote
// moves the alias) and a stubbed Storage bucket, with one shared timeline so
// the order of storage reads and platform writes is asserted, not assumed.
// The artifact is signed here with the attestation format and judged by the
// runtime's own verifier inside the script; minting against PostgreSQL 17 is
// covered by cloudDeploymentAttestationCiPgLifecycle.test.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, sign } from 'node:crypto';
import { CLOUD_ATTESTATION_KEY, CLOUD_ATTESTATION_VERSION, attestationBytes, cloudAttestationKeyFor } from './cloudDeploymentAttestation.js';

const run = promisify(execFile);
const script = new URL('../../scripts/cloud_deployment_attestation_ci.js', import.meta.url).pathname;
const TEAM = 'team_fixture', PROJECT = 'prj_fixture', TOKEN = 'fixture-vercel-token', BUCKET = 'donna-evidence', ALIAS = 'donna-fixture.vercel.app';
const OLD_SHA = 'a'.repeat(40), NEW_SHA = 'b'.repeat(40), NEWER_SHA = 'c'.repeat(40);

const deployment = (id, sha, createdAt, readyState = 'READY', target = 'production') => ({ id, uid: id, projectId: PROJECT, team: { id: TEAM }, ownerId: TEAM,
  readyState, target, createdAt, url: `${id}.vercel.app`, gitSource: { type: 'github', sha }, meta: { githubCommitSha: sha } });
const listPath = sha => `/v6/deployments?projectId=${PROJECT}&teamId=${TEAM}&target=production${sha ? `&sha=${sha}` : ''}&limit=1`;
const fixture = ({ serving, deployments, newest = null, own = {}, promote = 'move' }) => ({ token: TOKEN, promote, routes: {
  [`/v4/aliases/${ALIAS}?teamId=${TEAM}`]: { alias: ALIAS, deploymentId: serving },
  ...Object.fromEntries(deployments.map(d => [`/v13/deployments/${d.id}?teamId=${TEAM}`, d])),
  [listPath(null)]: { deployments: newest ? [newest] : [] },
  ...Object.fromEntries(Object.entries(own).map(([sha, d]) => [listPath(sha), { deployments: d ? [d] : [] }]))
} });

test('attest before promote: resolve the staged build, promote only a verifying artifact, verify the alias', { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'donna-attest-promote-'));
  const timeline = join(directory, 'timeline.log'), fixturePath = join(directory, 'vercel-fixture.json');
  let storage;
  t.after(async () => { await new Promise(resolve => storage ? storage.close(resolve) : resolve()); await rm(directory, { recursive: true, force: true }); });

  // Stubbed native Vercel CLI. GETs answer from the fixture; the promote POST
  // moves the alias (or, with promote=ignore, accepts and changes nothing).
  const bin = join(directory, 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, 'vercel'), `#!/usr/bin/env node
const fs = require('node:fs');
const path = process.env.DONNA_FAKE_VERCEL_FIXTURE, fixture = JSON.parse(fs.readFileSync(path, 'utf8'));
const args = process.argv.slice(2), token = args.indexOf('--token'), method = args[args.indexOf('--method') + 1];
if (args[0] !== 'api' || token < 0 || args[token + 1] !== fixture.token || !args.includes('--raw')) { console.error('vercel stub: unauthenticated or unexpected invocation'); process.exit(1); }
fs.appendFileSync(process.env.DONNA_FAKE_TIMELINE, 'VERCEL ' + method + ' ' + args[1] + '\\n');
const promote = args[1].match(/^\\/v10\\/projects\\/([^/]+)\\/promote\\/([^?]+)\\?teamId=(.+)$/);
if (method === 'POST' && promote) {
  if (fixture.promote === 'move') { fixture.routes['/v4/aliases/${ALIAS}?teamId=${TEAM}'].deploymentId = promote[2]; fs.writeFileSync(path, JSON.stringify(fixture)); }
  process.exit(0);
}
const response = method === 'GET' && fixture.routes[args[1]];
if (!response) { console.error('vercel stub: no route for ' + method + ' ' + args[1]); process.exit(1); }
process.stdout.write(JSON.stringify(response));
`); await chmod(join(bin, 'vercel'), 0o755);

  const objects = new Map();
  storage = createServer((request, response) => {
    const chunks = [];
    request.on('data', c => chunks.push(c)).on('end', () => {
      const prefix = `/storage/v1/object/${BUCKET}/`;
      if (request.headers.authorization !== 'Bearer fixture-service-key' || !request.url.startsWith(prefix)) { response.writeHead(401); return response.end('{"error":"unauthorized"}'); }
      const key = decodeURIComponent(request.url.slice(prefix.length));
      appendFileSync(timeline, `STORAGE ${request.method} ${key}\n`);
      if (request.method === 'GET') {
        if (!objects.has(key)) { response.writeHead(400, { 'content-type': 'application/json' }); return response.end('{"statusCode":"404","error":"not_found","message":"Object not found"}'); }
        response.writeHead(200, { 'content-type': 'application/json' }); return response.end(objects.get(key));
      }
      if (request.method === 'POST' && request.headers['x-upsert'] === 'true') { objects.set(key, Buffer.concat(chunks)); response.writeHead(200); return response.end('{}'); }
      response.writeHead(405); response.end();
    });
  });
  await new Promise(resolve => storage.listen(0, '127.0.0.1', resolve));

  const pair = generateKeyPairSync('ed25519');
  const privateKeyPath = join(directory, 'attestation-key.pem');
  await writeFile(privateKeyPath, pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const artifactFor = (deploymentId, sourceCommit, { expiresInMs = 5 * 24 * 3600 * 1000 } = {}) => {
    const payload = { version: CLOUD_ATTESTATION_VERSION, platform: 'vercel', platform_state: 'READY', deployment_id: deploymentId,
      project_id: PROJECT, team_id: TEAM, environment: 'production', source_commit: sourceCommit, platform_response_digest: 'sha256:fixture',
      issued_at: new Date(Date.now() - 60000).toISOString(), expires_at: new Date(Date.now() + expiresInMs).toISOString() };
    return Buffer.from(JSON.stringify({ payload, signature: sign(null, attestationBytes(payload), pair.privateKey).toString('base64') }));
  };

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DONNA_FAKE_VERCEL_FIXTURE: fixturePath, DONNA_FAKE_TIMELINE: timeline, VERCEL_TOKEN: TOKEN,
    SUPABASE_URL: `http://127.0.0.1:${storage.address().port}`, SUPABASE_SERVICE_ROLE_KEY: 'fixture-service-key', DONNA_EVIDENCE_BUCKET: BUCKET,
    DONNA_ATTESTATION_READBACK_DELAYS_MS: '10,10' };
  delete env.SUPABASE_SERVICE_KEY; delete env.SUPABASE_SECRET_KEY; delete env.VITE_SUPABASE_URL;
  const invoke = async (args, { expectFailure = false } = {}) => {
    await writeFile(timeline, '');
    const started = Date.now();
    try {
      const { stdout, stderr } = await run('node', [script, ...args], { cwd: directory, env, timeout: 60000 });
      assert.equal(expectFailure, false, `expected refusal, got ${stdout}`);
      return { result: JSON.parse(stdout.trim().split('\n').pop()), log: stderr, ms: Date.now() - started, calls: (await readFile(timeline, 'utf8')).trim().split('\n').filter(Boolean) };
    } catch (error) {
      if (!expectFailure || error.code === 'ERR_ASSERTION') throw error;
      return { failed: true, log: `${error.stdout || ''}${error.stderr || ''}`, calls: (await readFile(timeline, 'utf8')).trim().split('\n').filter(Boolean) };
    }
  };
  const common = ['--team', TEAM, '--project', PROJECT, '--alias', ALIAS];
  const promoteArgs = (id, sha, extra = []) => ['promote', ...common, '--deployment', id, '--source', sha, '--private-key', privateKeyPath, '--wait-seconds', '1', '--poll-seconds', '0', ...extra];
  const promotePosts = calls => calls.filter(c => c.startsWith('VERCEL POST /v10/projects/'));

  const live = deployment('dpl_live', OLD_SHA, 1000), staged = deployment('dpl_staged', NEW_SHA, 2000), newer = deployment('dpl_newer', NEWER_SHA, 3000);

  await t.test('resolve: a push waits for its own staged production build, not for what production serves', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_live', deployments: [live, staged], newest: staged, own: { [NEW_SHA]: staged } })));
    const { result } = await invoke(['resolve', ...common, '--expect-source', NEW_SHA, '--wait-minutes', '0', '--poll-seconds', '0']);
    assert.equal(result.mode, 'promote'); assert.equal(result.deployment_id, 'dpl_staged'); assert.equal(result.source_commit, NEW_SHA);
  });

  await t.test('resolve: a superseded push stops at once with a plain receipt line', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_live', deployments: [live, deployment('dpl_staged', NEW_SHA, 2000, 'BUILDING'), newer],
      newest: deployment('dpl_newer', NEWER_SHA, 3000, 'BUILDING'), own: { [NEW_SHA]: deployment('dpl_staged', NEW_SHA, 2000, 'BUILDING') } })));
    const { result, log, ms, calls } = await invoke(['resolve', ...common, '--expect-source', NEW_SHA, '--wait-minutes', '25', '--poll-seconds', '20']);
    assert.equal(result.mode, 'superseded'); assert.equal(result.superseded_by, NEWER_SHA);
    assert.match(log, new RegExp(`superseded: ${NEWER_SHA} \\(dpl_newer\\) was built after ${NEW_SHA}`));
    assert.ok(ms < 15000, `skipped without polling (${ms} ms)`);
    assert.equal(promotePosts(calls).length, 0); assert.ok(!calls.some(c => c.startsWith('STORAGE')), 'no storage touched');
  });

  await t.test('resolve: a failed build or a schedule keeps what production serves attested, promoting nothing', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_live', deployments: [live, deployment('dpl_staged', NEW_SHA, 2000, 'ERROR')],
      newest: deployment('dpl_staged', NEW_SHA, 2000, 'ERROR'), own: { [NEW_SHA]: deployment('dpl_staged', NEW_SHA, 2000, 'ERROR') } })));
    const failed = await invoke(['resolve', ...common, '--expect-source', NEW_SHA, '--wait-minutes', '5', '--poll-seconds', '0']);
    assert.equal(failed.result.mode, 'serving'); assert.equal(failed.result.note, 'build_error'); assert.equal(failed.result.deployment_id, 'dpl_live');
    assert.match(failed.log, /will not be promoted \(build_error\)/);
    const scheduled = await invoke(['resolve', ...common]);
    assert.equal(scheduled.result.mode, 'serving'); assert.equal(scheduled.result.deployment_id, 'dpl_live'); assert.equal(scheduled.result.note, null);
  });

  await t.test('promote: refuses without a verifying artifact for this deployment, and never calls promote', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_live', deployments: [live, staged] })));
    objects.clear();
    objects.set(cloudAttestationKeyFor('dpl_live'), artifactFor('dpl_live', OLD_SHA));
    let refused = await invoke(promoteArgs('dpl_staged', NEW_SHA), { expectFailure: true });
    assert.match(refused.log, /has no verifying attestation in storage \(absent\)\. Nothing promoted/);
    assert.equal(promotePosts(refused.calls).length, 0);
    // An artifact for another deployment at this deployment's key, or one
    // signed by another key, is the same refusal.
    objects.set(cloudAttestationKeyFor('dpl_staged'), artifactFor('dpl_live', OLD_SHA));
    refused = await invoke(promoteArgs('dpl_staged', NEW_SHA), { expectFailure: true });
    assert.match(refused.log, /\(stale, cloud_attestation_generation_mismatch\)\. Nothing promoted/);
    assert.equal(promotePosts(refused.calls).length, 0);
    const foreign = generateKeyPairSync('ed25519');
    const payload = JSON.parse(artifactFor('dpl_staged', NEW_SHA).toString('utf8')).payload;
    objects.set(cloudAttestationKeyFor('dpl_staged'), Buffer.from(JSON.stringify({ payload, signature: sign(null, attestationBytes(payload), foreign.privateKey).toString('base64') })));
    refused = await invoke(promoteArgs('dpl_staged', NEW_SHA), { expectFailure: true });
    assert.match(refused.log, /cloud_attestation_signature_invalid\)\. Nothing promoted/);
    assert.equal(promotePosts(refused.calls).length, 0);
    assert.equal(JSON.parse(await readFile(fixturePath, 'utf8')).routes[`/v4/aliases/${ALIAS}?teamId=${TEAM}`].deploymentId, 'dpl_live', 'production unchanged');
  });

  await t.test('promote: reads the artifact back verifying, THEN promotes, THEN verifies the alias, then mirrors the single slot', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_live', deployments: [live, staged] })));
    objects.clear();
    const liveArtifact = artifactFor('dpl_live', OLD_SHA), stagedArtifact = artifactFor('dpl_staged', NEW_SHA);
    objects.set(cloudAttestationKeyFor('dpl_live'), liveArtifact); objects.set(CLOUD_ATTESTATION_KEY, liveArtifact);
    objects.set(cloudAttestationKeyFor('dpl_staged'), stagedArtifact);
    const { result, log, calls } = await invoke(promoteArgs('dpl_staged', NEW_SHA, ['--expect-staged', 'true']));
    assert.equal(result.action, 'promoted'); assert.equal(result.previous_deployment_id, 'dpl_live'); assert.equal(result.legacy_slot, 'mirrored');
    assert.match(log, /promoted: donna-fixture\.vercel\.app serves dpl_staged/);
    const at = pattern => calls.findIndex(c => pattern.test(c));
    const readBack = at(/^STORAGE GET __host_certificate_a__\/deployments\/dpl_staged\.json$/);
    const promoted = at(/^VERCEL POST \/v10\/projects\/prj_fixture\/promote\/dpl_staged\?teamId=team_fixture$/);
    const aliasAfter = calls.findIndex((c, i) => i > promoted && /^VERCEL GET \/v4\/aliases\//.test(c));
    const mirrored = at(/^STORAGE POST __host_certificate_a__\/deployment-attestation\.json$/);
    assert.ok(readBack >= 0 && promoted > readBack, `artifact read back before promote: ${calls.join(' | ')}`);
    assert.ok(aliasAfter > promoted, 'alias verified after promote');
    assert.ok(mirrored > aliasAfter, 'single slot written only after the alias serves the new deployment');
    assert.equal(promotePosts(calls).length, 1);
    assert.ok(objects.get(CLOUD_ATTESTATION_KEY).equals(stagedArtifact));
    // The previous deployment's own artifact was never touched: until the
    // alias moved, what served production still verified.
    assert.ok(objects.get(cloudAttestationKeyFor('dpl_live')).equals(liveArtifact));
    assert.ok(!calls.some(c => c === `STORAGE POST ${cloudAttestationKeyFor('dpl_live')}`));
  });

  await t.test('promote: a scheduled run on what already serves promotes nothing; a staged push that was auto-assigned says so', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_staged', deployments: [live, staged] })));
    let { result, log, calls } = await invoke(promoteArgs('dpl_staged', NEW_SHA));
    assert.equal(result.action, 'already_serving'); assert.equal(result.legacy_slot, 'kept'); assert.equal(promotePosts(calls).length, 0);
    assert.doesNotMatch(log, /WARNING/);
    ({ result, log, calls } = await invoke(promoteArgs('dpl_staged', NEW_SHA, ['--expect-staged', 'true'])));
    assert.equal(result.action, 'already_serving'); assert.equal(promotePosts(calls).length, 0);
    assert.match(log, /WARNING: .*already served dpl_staged before this job promoted it.*Turn off auto-assign/);
  });

  await t.test('promote: never rolls production back to an older build', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_newer', deployments: [live, staged, newer] })));
    const { log, calls } = await invoke(promoteArgs('dpl_staged', NEW_SHA), { expectFailure: true });
    assert.match(log, /serves dpl_newer, built after dpl_staged; promoting would roll production back\. Nothing promoted/);
    assert.equal(promotePosts(calls).length, 0);
  });

  await t.test('promote: an alias that never moves fails loudly and leaves the single slot on what serves', async () => {
    await writeFile(fixturePath, JSON.stringify(fixture({ serving: 'dpl_live', deployments: [live, staged], promote: 'ignore' })));
    const liveArtifact = artifactFor('dpl_live', OLD_SHA);
    objects.set(CLOUD_ATTESTATION_KEY, liveArtifact);
    const { log, calls } = await invoke(promoteArgs('dpl_staged', NEW_SHA), { expectFailure: true });
    assert.match(log, /Promotion of dpl_staged was requested but donna-fixture\.vercel\.app still serves dpl_live after 1000 ms/);
    assert.equal(promotePosts(calls).length, 1);
    assert.ok(objects.get(CLOUD_ATTESTATION_KEY).equals(liveArtifact), 'single slot not moved to a deployment that does not serve');
  });
});
