import { describeDatabaseConnection } from './db/databaseConnectionMode.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolveRuntimeHostIdentity, cloudCertificateIdentityMatches } from './runtimeHostIdentity.js';
import { observeCloudHostCertificateA } from './cloudHostCertificateA.js';
import { hostReadinessIsMutationReady, readinessProfileCoordinate } from './runtimeReadiness.js';
import { buildHostCertificateFreshness, HOST_CERTIFICATE_A_VERSION, hostDigest, hostCompatibilityDigest } from './hostCertificateA.js';
import { validateAdmittedEntityProfileManifest, resolveAdmittedEntityProfile } from './entityCertificateB.js';

const at = '2026-09-13T12:00:00.000Z';
const env = { VERCEL: '1', VERCEL_PROJECT_ID: 'prj_test', VERCEL_ENV: 'preview', VERCEL_DEPLOYMENT_ID: 'dpl_test',
  VERCEL_GIT_COMMIT_SHA: 'abc123', DATABASE_URL: 'postgresql://postgres.project:private-password@pool.invalid:5432/postgres',
  SUPABASE_URL: 'https://project.supabase.invalid' };

// These are labelled fixtures for the existing admission predicate, not minted
// cloud authority. The real observer below cannot produce this PASS.
const fixtureCertificate = (identity) => {
  const checks = ['source_build', 'database_schema', 'scheduler_worker_manifest', 'evidence_storage',
    'model_routes', 'provider_capability', 'policy_oracle_artifacts', 'config_control_plane',
    'accounting_adapter', 'spend_meter'].map(id => ({ id, status: 'PASS', detail:
      id === 'source_build' ? { host_id: identity.host_id, generation_digest: identity.generation_digest }
      : id === 'provider_capability' ? { required_provider_classes: ['openai', 'anthropic'] } : {} }));
  const body = { version: HOST_CERTIFICATE_A_VERSION, runtime_host: 'vercel', status: 'PASS',
    host_identity: identity, checks, freshness: buildHostCertificateFreshness({ mintedAt: at }),
    compatibility_digest: hostCompatibilityDigest({ runtimeHost: 'vercel', checks }) };
  return { ...body, receipt_digest: hostDigest(body) };
};

test('cloud identity is project/environment scoped and never contains connection credentials', () => {
  const identity = resolveRuntimeHostIdentity(env);
  assert.equal(identity.reason, null);
  assert.equal(identity.runtime_host, 'vercel');
  assert.ok(!JSON.stringify(identity).includes('private-password'));
  assert.ok(!JSON.stringify(identity).includes('pool.invalid'));
  assert.deepEqual(resolveRuntimeHostIdentity({}), { runtime_host: 'desktop', host_id: 'desktop-local', reason: null });
  for (const missing of ['VERCEL_PROJECT_ID', 'VERCEL_ENV']) {
    const copy = { ...env }; delete copy[missing];
    assert.equal(resolveRuntimeHostIdentity(copy).host_id, null);
  }
  assert.equal(resolveRuntimeHostIdentity({ ...env, DONNA_DESKTOP_BLOB_DIR: '/not-cloud' }).host_id, null);
  for (const change of [{ VERCEL_PROJECT_ID: 'prj_other' }, { VERCEL_ENV: 'production' }]) {
    assert.notEqual(resolveRuntimeHostIdentity({ ...env, ...change }).host_id, identity.host_id);
  }
});

test('cloud admission binds source, deployment and targets and expires at the exclusive boundary', () => {
  const identity = resolveRuntimeHostIdentity(env), certificate = fixtureCertificate(identity);
  assert.equal(hostReadinessIsMutationReady({ certificate, asOf: at, hostIdentity: identity }), false, 'legacy PASS fixtures have no authenticated producer proofs');
  for (const change of [
    { VERCEL_DEPLOYMENT_ID: 'dpl_next' }, { VERCEL_GIT_COMMIT_SHA: 'def456' },
    { DATABASE_URL: env.DATABASE_URL.replace('postgres.project:', 'postgres.other:') },
    { SUPABASE_URL: 'https://other.supabase.invalid' }, { SUPABASE_EVIDENCE_BUCKET: 'other-bucket' },
    { INNGEST_APP_ID: 'other-app' }
  ]) {
    const next = resolveRuntimeHostIdentity({ ...env, ...change });
    assert.equal(next.host_id, identity.host_id);
    assert.equal(cloudCertificateIdentityMatches(certificate, next), false);
    assert.equal(hostReadinessIsMutationReady({ certificate, asOf: at, hostIdentity: next }), false);
  }
  assert.equal(hostReadinessIsMutationReady({ certificate, asOf: '2026-09-13T12:15:00Z', hostIdentity: identity }), false);
  assert.equal(hostReadinessIsMutationReady({ certificate, asOf: '2026-09-13T11:59:59Z', hostIdentity: identity }), false);
  assert.equal(hostReadinessIsMutationReady({ certificate: { ...certificate, runtime_host: 'desktop' }, asOf: at, hostIdentity: identity }), false);
  for (const id of ['provider_capability', 'scheduler_worker_manifest', 'evidence_storage', 'database_schema']) {
    const broken = structuredClone(certificate);
    broken.checks.find(check => check.id === id).status = 'INCOMPLETE';
    assert.equal(hostReadinessIsMutationReady({ certificate: broken, asOf: at, hostIdentity: identity }), false, id);
  }
  const unknown = structuredClone(certificate);
  unknown.checks.find(check => check.id === 'database_schema').id = 'caller_claim';
  unknown.compatibility_digest = hostCompatibilityDigest({ runtimeHost: 'vercel', checks: unknown.checks });
  const { receipt_digest: _old, ...body } = unknown;
  unknown.receipt_digest = hostDigest(body);
  assert.equal(hostReadinessIsMutationReady({ certificate: unknown, asOf: at, hostIdentity: identity }), false);
});

test('keys and caller PASS claims cannot manufacture cloud deployment, provider or worker evidence', async () => {
  const certificate = await observeCloudHostCertificateA({ env: { ...env, OPENAI_API_KEY: 'presence-only', ANTHROPIC_API_KEY: 'presence-only' },
    query: null, observedAt: at, observations: { deployment: 'PASS', providers: 'PASS', workers: 'PASS' },
    fetchImpl: () => { throw new Error('external fetch forbidden'); } });
  assert.equal(certificate.status, 'INCOMPLETE');
  assert.equal(certificate.model_inference_calls, 0);
  assert.equal(certificate.checks.find(check => check.id === 'model_routes').status, 'PASS');
  for (const id of ['source_build', 'scheduler_worker_manifest']) {
    assert.equal(certificate.checks.find(check => check.id === id).status, 'INCOMPLETE');
  }
  assert.equal(certificate.checks.find(check => check.id === 'scheduler_worker_manifest').detail.reason, 'cloud_inngest_signing_key_missing');
  // Host A v7: credentials plus a route are the provider CONFIGURATION, so the
  // check passes on them — but a key or a caller claim still mints no proof.
  const providers = certificate.checks.find(check => check.id === 'provider_capability');
  assert.equal(providers.status, 'PASS');
  assert.equal(providers.detail.response_proof.status, 'unverified');
  assert.deepEqual(providers.detail.proofs, []);
  assert.deepEqual(certificate.checks.find(check => check.id === 'scheduler_worker_manifest').detail.proofs, []);
  assert.equal(hostReadinessIsMutationReady({ certificate, asOf: at, hostIdentity: resolveRuntimeHostIdentity(env) }), false);
});

test('only the explicit FI self-provision pilot coordinate is declared, with both providers and no authority expansion', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../data/worlds/admitted-entity-profiles.json', import.meta.url)));
  assert.deepEqual(validateAdmittedEntityProfileManifest(manifest), { valid: true, errors: [] });
  const coordinate = readinessProfileCoordinate({ client: { jurisdiction: 'FI', entity_type: 'fi-oy',
    profile: { accounting_system: 'none', accounting_view: 'management_books', accountingBasis: 'accrual' } },
    creationPath: 'self_provision', hostIdentity: resolveRuntimeHostIdentity(env) });
  const profile = resolveAdmittedEntityProfile({ manifest, coordinate });
  assert.deepEqual(profile.required_provider_classes, ['openai', 'anthropic']);
  const baseline = manifest.capability_manifests[coordinate.capability_manifest_version].required_baseline;
  assert.equal(baseline.find(row => row.flag_key === 'FINLAND_ALV_FILING').stage, 'off');
  assert.equal(baseline.find(row => row.flag_key === 'RECONCILE_RETRACTION_AUTOSEND').stage, 'off');
  assert.equal(baseline.filter(row => row.flag_key.startsWith('OUTBOUND_')).every(row => row.stage === 'off'), true);
  assert.equal(baseline.some(row => ['CODING_AUTO_POST', 'LEDGER_AUTO_POST', 'RECONCILIATION_MATERIAL_AUTO_FYI'].includes(row.flag_key)), false);
  assert.throws(() => resolveAdmittedEntityProfile({ manifest, coordinate: { ...coordinate, creation_path: 'generic_client_route' } }));
  const invalid = structuredClone(manifest); invalid.profiles.at(-1).required_provider_classes.pop();
  assert.equal(validateAdmittedEntityProfileManifest(invalid).valid, false);
});


test('database connection diagnostics infer only the port and pooling mode, including configured aliases', async () => {
  const secretUrl = 'postgresql://private-user:private-password@aws-0-private-project.pooler.supabase.com:6543/private-database';
  assert.deepEqual(describeDatabaseConnection(secretUrl), { port: 6543, inferred_pool_mode: 'supabase_transaction' });
  assert.deepEqual(describeDatabaseConnection('postgresql://u:p@localhost:5432/db?host=aws-0-private.pooler.supabase.com&port=6543'), { port: 6543, inferred_pool_mode: 'supabase_transaction' });
  assert.deepEqual(describeDatabaseConnection(secretUrl.replace(':6543/', ':5432/')), { port: 5432, inferred_pool_mode: 'supabase_session' });
  assert.deepEqual(describeDatabaseConnection('postgresql://user:password@db.project.supabase.co:5432/postgres'), { port: 5432, inferred_pool_mode: 'supabase_direct' });
  assert.deepEqual(describeDatabaseConnection('postgresql://user:password@db.project.supabase.co:6543/postgres'), { port: 6543, inferred_pool_mode: 'supabase_transaction' });
  for (const address of ['invalid-secret', '', 'https://private.invalid', 'postgresql://x@pooler.supabase.com.attacker.invalid:6543/db']) {
    assert.equal(describeDatabaseConnection(address).inferred_pool_mode, 'unknown');
    assert.doesNotMatch(JSON.stringify(describeDatabaseConnection(address)), /secret|private|attacker/);
  }
  for (const alias of ['DATABASE_URL', 'POSTGRES_URL', 'SUPABASE_DB_URL']) {
    const aliasEnv = { ...env, DATABASE_URL: undefined, [alias]: secretUrl };
    const certificate = await observeCloudHostCertificateA({ env: aliasEnv, query: null, observedAt: at,
      fetchImpl: () => { throw new Error('external fetch forbidden'); } });
    assert.equal(certificate.checks.length, 10);
    const db = certificate.checks.find(check => check.id === 'database_schema');
    assert.deepEqual(db.detail.connection, { port: 6543, inferred_pool_mode: 'supabase_transaction' });
    assert.doesNotMatch(JSON.stringify(certificate), /private-user|private-password|private-project|private-database/);
  }
});

// Attest before promote (2026-09-23): the CI job publishes each deployment's
// artifact under its own key before it moves the production alias, so the
// deployment still serving keeps verifying. The observer reads its OWN key
// first and falls back to the single hand-minted slot; an artifact signed for
// another deployment never passes from either place.
test('source_build reads this deployment\'s own attestation key before the single slot', async () => {
  const { generateKeyPairSync, sign } = await import('node:crypto');
  const { CLOUD_ATTESTATION_KEY, CLOUD_ATTESTATION_VERSION, attestationBytes, cloudAttestationKeyFor } = await import('./cloudDeploymentAttestation.js');
  const pair = generateKeyPairSync('ed25519');
  const attestEnv = { ...env, VERCEL_ENV: 'production', VERCEL_ORG_ID: 'team_test',
    DONNA_HOST_ATTESTATION_PUBLIC_KEY: pair.publicKey.export({ type: 'spki', format: 'pem' }) };
  const artifactFor = deploymentId => {
    const payload = { version: CLOUD_ATTESTATION_VERSION, platform: 'vercel', platform_state: 'READY', deployment_id: deploymentId,
      project_id: 'prj_test', team_id: 'team_test', environment: 'production', source_commit: 'abc123', platform_response_digest: 'sha256:fixture',
      issued_at: '2026-09-13T11:00:00.000Z', expires_at: '2026-09-15T11:00:00.000Z' };
    return Buffer.from(JSON.stringify({ payload, signature: sign(null, attestationBytes(payload), pair.privateKey).toString('base64') }));
  };
  assert.equal(cloudAttestationKeyFor('dpl_test'), '__host_certificate_a__/deployments/dpl_test.json');
  for (const unsafe of ['', null, '../dpl_x', 'dpl_a/b', 'prj_test']) assert.equal(cloudAttestationKeyFor(unsafe), null, String(unsafe));
  const observeWith = async objects => {
    const reads = [];
    const certificate = await observeCloudHostCertificateA({ env: attestEnv, query: null, observedAt: at,
      fetchImpl: () => { throw new Error('external fetch forbidden'); },
      storageOps: { read: async ({ key }) => { reads.push(key); if (!objects[key]) throw Object.assign(new Error('Object not found'), { statusCode: 404 }); return objects[key]; },
        createUpload: async () => { throw new Error('no upload'); }, list: async () => [], delete: async () => ({ deleted: 0, errors: [] }) } });
    const build = certificate.checks.find(check => check.id === 'source_build');
    return { build, reads };
  };
  const own = cloudAttestationKeyFor('dpl_test');
  // A staged build's artifact sits beside this one: the single slot names the
  // next deployment, this deployment's own key still verifies.
  let { build, reads } = await observeWith({ [own]: artifactFor('dpl_test'), [CLOUD_ATTESTATION_KEY]: artifactFor('dpl_next') });
  assert.equal(build.status, 'PASS'); assert.equal(build.detail.deployment_id, 'dpl_test'); assert.deepEqual(reads, [own]);
  // A hand-minted single slot is still honoured when no own key exists.
  ({ build, reads } = await observeWith({ [CLOUD_ATTESTATION_KEY]: artifactFor('dpl_test') }));
  assert.equal(build.status, 'PASS'); assert.deepEqual(reads, [own, CLOUD_ATTESTATION_KEY]);
  // Neither place may carry another deployment's attestation into a PASS.
  ({ build } = await observeWith({ [own]: artifactFor('dpl_other'), [CLOUD_ATTESTATION_KEY]: artifactFor('dpl_next') }));
  assert.equal(build.status, 'INCOMPLETE'); assert.equal(build.detail.reason, 'cloud_attestation_generation_mismatch');
  ({ build } = await observeWith({}));
  assert.equal(build.status, 'INCOMPLETE'); assert.equal(build.detail.reason, 'cloud_attestation_unavailable');
});
