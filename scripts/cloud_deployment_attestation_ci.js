#!/usr/bin/env node
// CI producer around the operator attestation (attest_cloud_deployment.js).
// Runs in GitHub Actions so that neither a production deploy nor the seven-day
// expiry depends on a laptop. On a push it attests the pushed commit's STAGED
// production build (Vercel's auto-assign of production domains is off) and only
// then promotes it (2026-09-23: attesting after Vercel had already promoted left
// every merge serving an unattested build, and Host A refused every upload
// until the job caught up). Scheduled and dispatched runs keep what production
// serves attested.
// The runtime keeps holding only the public verification key; the signing
// key, the Vercel token, the hosted catalog connection and the storage
// credential exist only inside the job. Nothing here weakens the proof: the
// same attestCloudDeployment mints (authenticated platform lookup, clean
// deployed source, PostgreSQL 17 restore qualification), the runtime's own
// verifyCloudDeploymentAttestation decides whether the stored artifact is
// still valid for the deployment, and the schema catalog is read live from
// the hosted database with the same catalog SQL the runtime runs at renewal —
// a committed snapshot would fail the runtime's digest parity on the first
// migration-bearing deploy and reinstate the manual ceremony.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { createPrivateKey, createPublicKey } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { vercelApi, attestCloudDeployment } from './attest_cloud_deployment.js';
import { readCloudSchemaCatalog } from './qualify_cloud_schema.js';
import { CLOUD_ATTESTATION_KEY, CLOUD_ATTESTATION_MAX_AGE_MS, cloudAttestationKeyFor, verifyCloudDeploymentAttestation } from '../server/donna/cloudDeploymentAttestation.js';
import { CLOUD_SCHEMA_CATALOG_VERSION } from '../server/donna/cloudSchemaQualification.js';
import { resolveRuntimeHostIdentity } from '../server/donna/runtimeHostIdentity.js';
import { fetchEvidenceObjectBytes } from '../server/donna/evidenceStorage.js';
import { hostDigest } from '../server/donna/hostCertificateA.js';

// Below this remaining validity the scheduled run re-mints; with a six-hourly
// schedule the artifact therefore never lapses while the job itself is healthy.
export const ATTESTATION_FRESH_MS = 3 * 24 * 60 * 60 * 1000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const q = value => encodeURIComponent(value);
const deploymentRecord = d => ({ deployment_id: d.id || d.uid, source_commit: d.gitSource?.sha || d.meta?.githubCommitSha || null,
  ready_state: d.readyState || d.state || null, target: d.target === 'production' ? 'production' : 'preview', url: d.url || null,
  created_at: Number(d.createdAt ?? d.created) || null });
const FAILED_BUILD = ['ERROR', 'CANCELED', 'DELETED'];

export const readDeployment = async ({ deploymentId, teamId }) => deploymentRecord(await vercelApi(`/v13/deployments/${q(deploymentId)}?teamId=${q(teamId)}`));

// The deployment the production alias serves right now — the one traffic, the
// crons and the workers reach. With staged production the project's newest
// production build is NOT necessarily it, so the alias is the source of truth.
export const readServingDeployment = async ({ alias, teamId }) => {
  if (!alias) throw new Error('The production alias (--alias) is required.');
  const record = await vercelApi(`/v4/aliases/${q(alias)}?teamId=${q(teamId)}`);
  if (!record?.deploymentId) throw new Error(`The production alias ${alias} points at no deployment.`);
  return readDeployment({ deploymentId: record.deploymentId, teamId });
};

const newestProductionBuild = async ({ projectId, teamId, sha = null }) => {
  const list = await vercelApi(`/v6/deployments?projectId=${q(projectId)}&teamId=${q(teamId)}&target=production${sha ? `&sha=${q(sha)}` : ''}&limit=1`);
  return list?.deployments?.[0] ? deploymentRecord(list.deployments[0]) : null;
};

// Which deployment this run attests, and whether it then promotes it:
// - no expected source (schedule, plain dispatch): what production serves; mode `serving`.
// - an expected source (push, dispatch with a commit): wait for THAT commit's
//   production build to be READY; mode `promote`. A newer production build of
//   another commit makes this run `superseded` — it stops at once, because the
//   newer push has its own run queued behind this one. A failed build falls
//   back to `serving` with a note: keep what serves attested, promote nothing.
export const resolveAttestationTarget = async ({ projectId, teamId, alias, expectSource = null, waitMs = 25 * 60 * 1000, pollMs = 20000, log = console.error }) => {
  const base = { project_id: projectId, team_id: teamId, alias, expected_source: expectSource };
  const serving = async note => {
    const current = await readServingDeployment({ alias, teamId });
    if (current.ready_state !== 'READY' || current.target !== 'production') throw new Error(`The deployment production serves (${current.deployment_id}) is ${current.ready_state} ${current.target}; nothing to attest.`);
    if (note) log(`NOTE: ${expectSource} will not be promoted (${note}); keeping the deployment production serves attested.`);
    return { ...current, ...base, mode: 'serving', note };
  };
  if (!expectSource) return serving(null);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const own = await newestProductionBuild({ projectId, teamId, sha: expectSource });
    const newest = await newestProductionBuild({ projectId, teamId });
    if (own && newest && newest.source_commit !== expectSource && newest.created_at > own.created_at) {
      log(`superseded: ${newest.source_commit} (${newest.deployment_id}) was built after ${expectSource}; its own run attests and promotes it.`);
      return { ...own, ...base, mode: 'superseded', superseded_by: newest.source_commit, note: 'superseded' };
    }
    log(`build for ${expectSource} is ${own ? `${own.deployment_id} ${own.ready_state}` : 'not created'}`);
    if (own && FAILED_BUILD.includes(own.ready_state)) return serving(`build_${own.ready_state.toLowerCase()}`);
    if (own?.ready_state === 'READY') {
      if (own.target !== 'production') throw new Error(`Deployment ${own.deployment_id} is not a production build; nothing to attest.`);
      return { ...own, ...base, mode: 'promote', note: null };
    }
    if (Date.now() >= deadline) return serving('wait_deadline_reached');
    await sleep(pollMs);
  }
};

// Live, read-only, schema-only export with the runtime's own catalog SQL.
export const exportHostedSchemaCatalog = async ({ databaseUrl, outputPath, env = process.env }) => {
  if (!databaseUrl) throw new Error('DONNA_HOSTED_SCHEMA_CATALOG_DATABASE_URL is required to export the hosted schema catalog.');
  // Same hosted TLS posture as server/donna/db/pool.js.
  const hosted = /supabase|neon|render|railway|amazonaws/i.test(databaseUrl);
  const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 15000, statement_timeout: 120000,
    ssl: hosted ? { rejectUnauthorized: env.DATABASE_SSL_REJECT_UNAUTHORIZED === 'true' } : undefined });
  await client.connect();
  try {
    await client.query('begin isolation level repeatable read read only');
    const catalog = await readCloudSchemaCatalog(client);
    await client.query('rollback');
    if (catalog?.version !== CLOUD_SCHEMA_CATALOG_VERSION) throw new Error('Hosted catalog export is not the v3 catalog.');
    await writeFile(outputPath, JSON.stringify(catalog), { mode: 0o600 });
    return { database_name: catalog.database_name, server_version_num: catalog.server_version_num, migrations: catalog.migrations?.length ?? 0, objects: catalog.objects?.length ?? 0 };
  } finally { await client.end(); }
};

// The runtime verifier's inputs for a production deployment. It binds
// deployment, source, project, team and environment; the database/storage
// targets belong to the runtime's own identity and are not attested.
export const attestationVerificationContext = ({ publicKeyPem, projectId, teamId, deploymentId, sourceCommit }) => ({
  env: { DONNA_HOST_ATTESTATION_PUBLIC_KEY: publicKeyPem, VERCEL_PROJECT_ID: projectId, VERCEL_ENV: 'production', VERCEL_ORG_ID: teamId },
  identity: resolveRuntimeHostIdentity({ VERCEL: '1', VERCEL_ENV: 'production', VERCEL_PROJECT_ID: projectId, VERCEL_DEPLOYMENT_ID: deploymentId,
    VERCEL_GIT_COMMIT_SHA: sourceCommit, DATABASE_URL: 'postgresql://verifier@ci.invalid/verify', SUPABASE_URL: 'https://verifier.invalid' })
});

const isNotFound = error => error?.statusCode === 404 || (error?.statusCode === 400 && /not[_ ]?found/i.test(error.message));

export const currentAttestationState = async ({ bucket, key = CLOUD_ATTESTATION_KEY, context, observedAt, freshMs = ATTESTATION_FRESH_MS, freshRead = false }) => {
  let bytes;
  try { bytes = await fetchEvidenceObjectBytes({ bucket, key, maxBytes: 32768, freshRead }); }
  catch (error) {
    if (isNotFound(error)) return { status: 'absent', deployment_id: null, expires_at: null, reason: null, digest: null, bytes: null };
    throw error;
  }
  let artifact;
  try { artifact = JSON.parse(bytes.toString('utf8')); } catch { return { status: 'unreadable', deployment_id: null, expires_at: null, reason: 'not_json', digest: hostDigest(bytes.toString('base64')), bytes }; }
  const check = verifyCloudDeploymentAttestation({ artifact, ...context, observedAt });
  const remaining = Date.parse(artifact?.payload?.expires_at) - Date.parse(observedAt);
  return { status: check.status !== 'PASS' ? 'stale' : remaining >= freshMs ? 'fresh' : 'expiring', reason: check.detail?.reason || null,
    deployment_id: artifact?.payload?.deployment_id || null, expires_at: artifact?.payload?.expires_at || null, digest: hostDigest(artifact), bytes };
};

// The read-back after an upsert is a convergence check, not a single GET: on
// 2026-09-21 the first live run (dpl_5wpb… → dpl_69EE…) uploaded the new
// artifact and immediately read the PREVIOUS one back, so it failed while
// storage already held the right bytes; the retry three minutes later found
// it fresh and no-opped. The upload therefore asks storage not to cache this
// object, every read-back bypasses caches, and a mismatch is re-read on a
// bounded ladder (~60 s) before it counts. DONNA_ATTESTATION_READBACK_DELAYS_MS
// (comma-separated) is a tuning knob for the ladder, never a switch.
export const READ_BACK_DELAYS_MS = Object.freeze([1000, 2000, 3000, 5000, 8000, 13000, 13000, 15000]);
export const readBackDelays = env => {
  // An unset knob is empty, and Number('') is 0: without dropping blanks the
  // default ladder silently became one 0 ms retry (2026-09-22 dpl_U9YH… run).
  const parsed = String(env.DONNA_ATTESTATION_READBACK_DELAYS_MS || '').split(',').map(v => v.trim()).filter(Boolean)
    .map(Number).filter(v => Number.isSafeInteger(v) && v >= 0);
  return parsed.length ? parsed : READ_BACK_DELAYS_MS;
};
const digestOf = bytes => { try { return hostDigest(JSON.parse(bytes.toString('utf8'))); } catch { return hostDigest(bytes.toString('base64')); } };

export const publishAttestation = async ({ bucket, key = CLOUD_ATTESTATION_KEY, artifactBytes, env = process.env, delays = readBackDelays(env), log = () => {} }) => {
  const url = String(env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/+$/, '');
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SECRET_KEY;
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and a service-role key are required to publish the attestation.');
  const response = await fetch(`${url}/storage/v1/object/${q(bucket)}/${key.split('/').map(q).join('/')}`, {
    method: 'POST',
    headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json', 'x-upsert': 'true', 'cache-control': 'no-cache, max-age=0' },
    body: artifactBytes });
  if (!response.ok) throw new Error(`Attestation upload failed with ${response.status}: ${(await response.text().catch(() => '')).slice(0, 200)}`);
  const minted = digestOf(artifactBytes);
  let attempts = 0, storedDigest = null, waited = 0;
  for (;;) {
    attempts += 1;
    // A per-deployment key is new on its first upload, so an edge that has not
    // converged answers "not found" instead of the previous bytes: same ladder.
    let stored;
    try { stored = await fetchEvidenceObjectBytes({ bucket, key, maxBytes: 32768, freshRead: true }); }
    catch (error) { if (!isNotFound(error)) throw error; stored = null; }
    if (stored?.equals(artifactBytes)) return { bytes: stored.length, digest: minted, read_back_attempts: attempts };
    storedDigest = stored ? digestOf(stored) : 'absent';
    if (attempts > delays.length) break;
    const delay = delays[attempts - 1];
    log(`read-back ${attempts}: storage still serves digest ${storedDigest}, minted ${minted}; retrying in ${delay} ms`);
    await sleep(delay); waited += delay;
  }
  throw new Error(`Stored attestation still differs from the minted artifact after ${attempts} read-backs over ${waited} ms (stored digest ${storedDigest}, minted ${minted}). The upload was accepted; once storage serves the minted bytes a scheduled run keeps them, otherwise re-run this job.`);
};

export const runCiAttestation = async ({ projectId, teamId, deploymentId, sourceCommit, privateKeyPath, expiresDays = 7, freshMs = ATTESTATION_FRESH_MS,
  bucket = process.env.DONNA_EVIDENCE_BUCKET || process.env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence',
  catalogDatabaseUrl = process.env.DONNA_HOSTED_SCHEMA_CATALOG_DATABASE_URL, pg17AdminUrl = process.env.DONNA_SCHEMA_PROOF_PG17_URL, log = console.error }) => {
  if (![projectId, teamId, deploymentId, sourceCommit, privateKeyPath].every(Boolean)) throw new Error('Exact project, team, deployment, source and private key are required.');
  const deployment = await readDeployment({ deploymentId, teamId });
  if (deployment.ready_state !== 'READY' || deployment.target !== 'production' || deployment.source_commit !== sourceCommit) throw new Error(`Deployment ${deploymentId} is ${deployment.ready_state} ${deployment.target} at ${deployment.source_commit}; not a READY production build of ${sourceCommit}. Nothing signed.`);
  const key = cloudAttestationKeyFor(deploymentId);
  if (!key) throw new Error(`Deployment id ${deploymentId} is not a Vercel deployment id. Nothing signed.`);
  const publicKeyPem = createPublicKey(createPrivateKey(await readFile(privateKeyPath))).export({ type: 'spki', format: 'pem' });
  const context = attestationVerificationContext({ publicKeyPem, projectId, teamId, deploymentId, sourceCommit });
  const current = await currentAttestationState({ bucket, key, context, observedAt: new Date().toISOString(), freshMs });
  log(`stored attestation: ${current.status}${current.deployment_id ? ` for ${current.deployment_id}` : ''}${current.expires_at ? `, expires ${current.expires_at}` : ''}${current.reason ? ` (${current.reason})` : ''}`);
  const base = { deployment_id: deploymentId, source_commit: sourceCommit, project_id: projectId, team_id: teamId, key, previous: current.status };
  if (current.status === 'fresh') { log(`kept: ${deploymentId} (${sourceCommit}) is attested until ${current.expires_at}`); return { action: 'kept', ...base, expires_at: current.expires_at, attestation_digest: current.digest }; }
  const directory = await mkdtemp(join(tmpdir(), 'donna-attest-'));
  try {
    const catalogPath = join(directory, 'hosted-schema-catalog.json'), outputPath = join(directory, 'deployment-attestation.json');
    const schema = await exportHostedSchemaCatalog({ databaseUrl: catalogDatabaseUrl, outputPath: catalogPath });
    log(`hosted schema catalog exported: ${schema.migrations} migrations, ${schema.objects} objects, database ${schema.database_name}`);
    const expiresAt = new Date(Date.now() + Math.min(expiresDays * 24 * 60 * 60 * 1000, CLOUD_ATTESTATION_MAX_AGE_MS) - 60000).toISOString();
    const receipt = await attestCloudDeployment({ deploymentId, projectId, teamId, environment: 'production', sourceCommit, privateKeyPath, outputPath, expiresAt, schemaCatalogPath: catalogPath, pg17AdminUrl });
    const artifactBytes = await readFile(outputPath);
    const minted = verifyCloudDeploymentAttestation({ artifact: JSON.parse(artifactBytes.toString('utf8')), ...context, observedAt: new Date().toISOString() });
    if (minted.status !== 'PASS') throw new Error(`Minted attestation does not verify (${minted.detail?.reason}); nothing published.`);
    const published = await publishAttestation({ bucket, key, artifactBytes, log });
    const after = await currentAttestationState({ bucket, key, context, observedAt: new Date().toISOString(), freshMs, freshRead: true });
    if (after.status !== 'fresh' || after.digest !== published.digest) throw new Error(`Published attestation reads back as ${after.status} (${after.reason}).`);
    log(`${current.status === 'absent' ? 'minted' : 'replaced'}: ${deploymentId} (${sourceCommit}) attested until ${receipt.expires_at}, digest ${published.digest}`);
    return { action: current.status === 'absent' ? 'minted' : 'replaced', ...base, expires_at: receipt.expires_at, attestation_digest: published.digest, read_back_attempts: published.read_back_attempts, schema_catalog: schema };
  } finally { await rm(directory, { recursive: true, force: true }); }
};

// Promotion is the LAST step and happens only for a deployment whose own
// artifact reads back PASS from storage under the runtime's verifier. Until
// the alias moves, the deployment already serving keeps its own artifact, so
// a failure anywhere before this point leaves production attested and
// unchanged. After the alias is verified, the hand-minted single slot is set
// to the same bytes, so a deployment built before per-deployment artifacts
// (e.g. an instant rollback target) still reads the artifact of what serves.
export const promoteAttestedDeployment = async ({ projectId, teamId, alias, deploymentId, sourceCommit, privateKeyPath, expectStaged = false,
  bucket = process.env.DONNA_EVIDENCE_BUCKET || process.env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence',
  waitMs = 2 * 60 * 1000, pollMs = 5000, log = console.error }) => {
  if (![projectId, teamId, alias, deploymentId, sourceCommit, privateKeyPath].every(Boolean)) throw new Error('Exact project, team, alias, deployment, source and private key are required.');
  const key = cloudAttestationKeyFor(deploymentId);
  if (!key) throw new Error(`Deployment id ${deploymentId} is not a Vercel deployment id. Nothing promoted.`);
  const deployment = await readDeployment({ deploymentId, teamId });
  if (deployment.ready_state !== 'READY' || deployment.target !== 'production' || deployment.source_commit !== sourceCommit) throw new Error(`Deployment ${deploymentId} is ${deployment.ready_state} ${deployment.target} at ${deployment.source_commit}; not a READY production build of ${sourceCommit}. Nothing promoted.`);
  const publicKeyPem = createPublicKey(createPrivateKey(await readFile(privateKeyPath))).export({ type: 'spki', format: 'pem' });
  const context = attestationVerificationContext({ publicKeyPem, projectId, teamId, deploymentId, sourceCommit });
  const attested = await currentAttestationState({ bucket, key, context, observedAt: new Date().toISOString(), freshMs: 0, freshRead: true });
  // Only a runtime-verifier PASS (fresh or expiring) may move the alias.
  if (!['fresh', 'expiring'].includes(attested.status)) throw new Error(`Deployment ${deploymentId} has no verifying attestation in storage (${attested.status}${attested.reason ? `, ${attested.reason}` : ''}). Nothing promoted; production keeps serving its attested deployment.`);
  const before = await readServingDeployment({ alias, teamId });
  const base = { deployment_id: deploymentId, source_commit: sourceCommit, alias, attestation_digest: attested.digest, previous_deployment_id: before.deployment_id };
  let action = 'already_serving';
  if (before.deployment_id === deploymentId) {
    if (expectStaged) log(`WARNING: ${alias} already served ${deploymentId} before this job promoted it — Vercel still auto-assigns production domains, so the build served unattested until the attestation landed. Turn off auto-assign (runbook: docs/donna-fi-hosted-pilot-2026-09-13.md).`);
    else log(`serving: ${alias} serves ${deploymentId}; nothing to promote.`);
  } else {
    if (before.created_at && deployment.created_at && before.created_at > deployment.created_at) throw new Error(`${alias} serves ${before.deployment_id}, built after ${deploymentId}; promoting would roll production back. Nothing promoted.`);
    log(`promoting ${deploymentId} (${sourceCommit}); ${alias} serves ${before.deployment_id} until the alias moves.`);
    await vercelApi(`/v10/projects/${q(projectId)}/promote/${q(deploymentId)}?teamId=${q(teamId)}`, { method: 'POST' });
    const deadline = Date.now() + waitMs;
    for (;;) {
      const now = await readServingDeployment({ alias, teamId });
      if (now.deployment_id === deploymentId) break;
      if (Date.now() >= deadline) throw new Error(`Promotion of ${deploymentId} was requested but ${alias} still serves ${now.deployment_id} after ${waitMs} ms. Both deployments carry their own attestation; re-run this job or promote by hand.`);
      await sleep(pollMs);
    }
    action = 'promoted';
    log(`promoted: ${alias} serves ${deploymentId} (${sourceCommit}), attested until ${attested.expires_at}.`);
  }
  const legacy = await currentAttestationState({ bucket, key: CLOUD_ATTESTATION_KEY, context, observedAt: new Date().toISOString(), freshMs: 0, freshRead: true });
  let legacySlot = 'kept';
  if (legacy.digest !== attested.digest) { await publishAttestation({ bucket, key: CLOUD_ATTESTATION_KEY, artifactBytes: attested.bytes, log }); legacySlot = 'mirrored'; }
  return { action, ...base, expires_at: attested.expires_at, legacy_slot: legacySlot };
};

const main = async () => {
  const [command, ...rest] = process.argv.slice(2);
  const options = Object.fromEntries(Array.from({ length: rest.length / 2 }, (_, i) => [rest[i * 2], rest[i * 2 + 1]]));
  let result;
  if (command === 'resolve') {
    result = await resolveAttestationTarget({ projectId: options['--project'], teamId: options['--team'], alias: options['--alias'], expectSource: options['--expect-source'] || null,
      waitMs: Number(options['--wait-minutes'] ?? 25) * 60000, pollMs: Number(options['--poll-seconds'] ?? 20) * 1000 });
    console.error(`resolved: ${result.mode} ${result.deployment_id} at ${result.source_commit}`);
  } else if (command === 'attest') {
    result = await runCiAttestation({ projectId: options['--project'], teamId: options['--team'], deploymentId: options['--deployment'], sourceCommit: options['--source'],
      privateKeyPath: options['--private-key'], expiresDays: Number(options['--expires-days'] ?? 7),
      freshMs: Math.min(options['--fresh-hours'] ? Number(options['--fresh-hours']) * 3600000 : ATTESTATION_FRESH_MS, CLOUD_ATTESTATION_MAX_AGE_MS - 3600000) });
  } else if (command === 'promote') {
    result = await promoteAttestedDeployment({ projectId: options['--project'], teamId: options['--team'], alias: options['--alias'], deploymentId: options['--deployment'],
      sourceCommit: options['--source'], privateKeyPath: options['--private-key'], expectStaged: options['--expect-staged'] === 'true',
      waitMs: Number(options['--wait-seconds'] ?? 120) * 1000, pollMs: Number(options['--poll-seconds'] ?? 5) * 1000 });
  } else throw new Error('Usage: cloud_deployment_attestation_ci.js resolve|attest|promote --team ID --project ID [...]');
  if (options['--output']) await writeFile(options['--output'], JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {
  console.error(`Cloud deployment attestation (CI) failed; no readiness is granted. ${error?.message || error}`); process.exitCode = 1;
});
