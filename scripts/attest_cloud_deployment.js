#!/usr/bin/env node
// Operator-only producer. Never accepts a platform JSON/PASS file as evidence.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { hostDigest } from '../server/donna/hostCertificateA.js';
import { CLOUD_ATTESTATION_VERSION, CLOUD_ATTESTATION_MAX_AGE_MS, attestationBytes } from '../server/donna/cloudDeploymentAttestation.js';
import { qualifyCloudSchema } from './qualify_cloud_schema.js';
const run = promisify(execFile);
const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
export const readAttestationSourceIdentity = async () => {
  const options = { cwd: sourceRoot, timeout: 30000, maxBuffer: 8 * 1024 * 1024 };
  const { stdout: head } = await run('git', ['rev-parse', 'HEAD'], options);
  const { stdout: dirty } = await run('git', ['status', '--porcelain', '--untracked-files=normal'], options);
  return { head: head.trim(), dirty: Boolean(dirty.trim()) };
};
// One authenticated platform request path for the operator and CI. The native
// CLI authenticates from its own login or, in CI, from VERCEL_TOKEN passed as
// --token; the token is never logged or written anywhere by this module.
// A write (the CI promotion) passes method POST; an empty response body is null.
export const vercelApi = async (path, { env = process.env, method = 'GET' } = {}) => {
  const args = ['api', path, '--method', method, '--raw'];
  if (env.VERCEL_TOKEN) args.push('--token', env.VERCEL_TOKEN);
  const { stdout } = await run('vercel', args, { env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim() ? JSON.parse(stdout) : null;
};
export const attestCloudDeployment = async ({ deploymentId, projectId, teamId, environment, sourceCommit, privateKeyPath, outputPath, expiresAt, schemaCatalogPath, pg17AdminUrl }) => {
  if (![deploymentId, projectId, teamId, environment, sourceCommit, privateKeyPath, outputPath, expiresAt].every(Boolean)
    || !['production', 'preview'].includes(environment) || !/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('Exact deployment, project, team, environment, source, key and output are required.');
  const deployment = await vercelApi(`/v13/deployments/${encodeURIComponent(deploymentId)}?teamId=${encodeURIComponent(teamId)}`);
  const actualEnvironment = deployment.target === 'production' ? 'production' : 'preview';
  const actualSource = deployment.gitSource?.sha || deployment.meta?.githubCommitSha;
  const actualTeam = deployment.team?.id || deployment.ownerId;
  if (deployment.id !== deploymentId || deployment.projectId !== projectId || actualTeam !== teamId
    || deployment.readyState !== 'READY' || actualEnvironment !== environment || actualSource !== sourceCommit) throw new Error('Authenticated platform response does not match the requested running deployment. Nothing signed.');
  const source = await readAttestationSourceIdentity();
  if (source.head !== sourceCommit || source.dirty) throw new Error('Qualification must run on the clean deployed source.');
  const schemaQualification = await qualifyCloudSchema({ catalogPath: schemaCatalogPath, adminUrl: pg17AdminUrl });
  if (schemaQualification.status !== 'PASS') throw new Error('Restored PostgreSQL schema qualification failed. Nothing signed.');
  const key = createPrivateKey(await readFile(privateKeyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Ed25519 signing key required.');
  const issuedAt = new Date();
  const expiryMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiryMs) || expiryMs <= issuedAt.getTime() || expiryMs - issuedAt.getTime() > CLOUD_ATTESTATION_MAX_AGE_MS) throw new Error('Explicit pilot expiry must be within the next seven days.');
  const payload = { version: CLOUD_ATTESTATION_VERSION, platform: 'vercel', platform_state: 'READY',
    deployment_id: deploymentId, project_id: projectId, team_id: teamId, environment,
    source_commit: sourceCommit, platform_response_digest: hostDigest(deployment),
    schema_qualification: schemaQualification, issued_at: issuedAt.toISOString(), expires_at: new Date(expiryMs).toISOString() };
  const artifact = { payload, signature: sign(null, attestationBytes(payload), key).toString('base64') };
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 });
  return { output: outputPath, deployment_id: deploymentId, source_commit: sourceCommit, digest: hostDigest(artifact), expires_at: payload.expires_at };
};
const main = async () => {
  const args = process.argv.slice(2);
  if (args[0] === '--generate-key' && args.length === 2) {
    const pair = generateKeyPairSync('ed25519');
    await writeFile(args[1], pair.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' });
    await writeFile(`${args[1]}.pub`, pair.publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644, flag: 'wx' });
    console.log(JSON.stringify({ public_key_path: `${args[1]}.pub` })); return;
  }
  const options = Object.fromEntries(Array.from({ length: args.length / 2 }, (_, i) => [args[i * 2], args[i * 2 + 1]]));
  console.log(JSON.stringify(await attestCloudDeployment({ deploymentId: options['--deployment'], projectId: options['--project'],
    teamId: options['--team'], environment: options['--environment'], sourceCommit: options['--source'],
    privateKeyPath: options['--private-key'], outputPath: options['--output'], expiresAt: options['--expires-at'],
    schemaCatalogPath: options['--schema-catalog'], pg17AdminUrl: process.env.DONNA_SCHEMA_PROOF_PG17_URL })));
};
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => { console.error(`Cloud deployment attestation failed; no readiness is granted. Check exact identifiers and native Vercel CLI authentication. ${error?.message || ''}`); process.exitCode = 1; });
