import { getFirmDatabaseUrl } from './db/pool.js';
import { describeDatabaseConnection } from './db/databaseConnectionMode.js';
// Bounded cloud observer. Missing trusted producers remain INCOMPLETE.
// There is deliberately no caller-supplied observation/PASS input and no model call.
import { CLOUD_PILOT_PROCESSING_FLAGS } from './cloudPilotConfig.js';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  HOST_CERTIFICATE_A_VERSION, HOST_COMPATIBILITY_CONTRACT_VERSION,
  buildHostCertificateFreshness, hostDigest, hostCompatibilityDigest,
  storageCheck, modelRouteCheck, staticArtifactCheck, configPlaneCheck,
  accountingCheck, spendMeterCheck
} from './hostCertificateA.js';
import { resolveRuntimeHostIdentity, CLOUD_RUNTIME_HOST } from './runtimeHostIdentity.js';
import { PILOT_REQUIRED_COLUMNS, compareHostedPilotSchema } from './cloudHostSchema.js';
import { createEvidenceSignedUploadUrl, fetchEvidenceObjectBytes, listEvidenceObjects, deleteEvidenceObjects } from './evidenceStorage.js';
import { CLOUD_ATTESTATION_KEY, cloudAttestationKeyFor, verifyCloudDeploymentAttestation } from './cloudDeploymentAttestation.js';
import { cloudSchemaCatalogDigest, CLOUD_SCHEMA_QUALIFICATION_VERSION, CLOUD_HISTORICAL_MIGRATIONS } from './cloudSchemaQualification.js';
import { readCloudDependencyEvidence } from './cloudDependencyEvidence.js';
import { MODEL_LANES } from './modelLanes.js';
import { cloudWorkerManifest, CLOUD_REQUIRED_WORKERS } from './inngest/cloudProvenance.js';
import { queryFirmDb } from './firmDb.js';

export const CLOUD_HOST_OBSERVATION_VERSION = 'donna.cloud-host-observation.v1';
export const CLOUD_POSTGRES_MAJOR = 17;
export const CLOUD_STORAGE_PROBE_TIMEOUT_MS = 20000;
const incomplete = (id, reason, detail = {}) => ({ id, status: 'INCOMPLETE', detail: { ...detail, reason } });

export const observeCloudDatabase = async ({ query, rootDir, observedAt, schemaQualification, connection = describeDatabaseConnection(getFirmDatabaseUrl()) }) => {
  if (!query) return incomplete('database_schema', 'postgresql_not_configured', { connection });
  try {
    const expected = (await readdir(path.join(rootDir, 'db/migrations'))).filter(file => file.endsWith('.sql')).map(file => file.slice(0, -4)).sort();
    // Serial reads also work on a single transaction-bound PostgreSQL client.
    const version = (await query("select current_setting('server_version_num')::integer as version, now() as database_now")).rows[0];
    const applied = (await query('select version from schema_migrations order by version')).rows.map(row => row.version);
    const tables = Object.keys(PILOT_REQUIRED_COLUMNS).sort();
    const columns = (await query(`select table_name, column_name, data_type, udt_name, is_nullable, column_default
      from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, ordinal_position`, [tables])).rows;
    const constraints = (await query(`select c.relname as table_name, k.conname, k.contype, k.convalidated,
      pg_get_constraintdef(k.oid) as definition from pg_constraint k
      join pg_class c on c.oid = k.conrelid join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = any($1::text[]) order by c.relname, k.conname`, [tables])).rows;
    const triggers = (await query(`select c.relname as table_name, t.tgname, t.tgenabled,
      pg_get_triggerdef(t.oid) as definition, pg_get_functiondef(p.oid) as function_definition
      from pg_trigger t join pg_class c on c.oid = t.tgrelid
      join pg_namespace n on n.oid = c.relnamespace join pg_proc p on p.oid = t.tgfoid
      where n.nspname = 'public' and not t.tgisinternal and c.relname = any($1::text[])
      order by c.relname, t.tgname`, [tables])).rows;
    const comparison = compareHostedPilotSchema({ expected, applied, columns, allowedHistorical: CLOUD_HISTORICAL_MIGRATIONS });
    const major = Math.floor(Number(version.version) / 10000);
    const clockSkew = Math.abs(Date.parse(version.database_now) - Date.parse(observedAt));
    const catalog = (await query(await readFile(new URL('../../scripts/sql/cloud_schema_catalog.sql', import.meta.url), 'utf8'))).rows[0].cloud_schema_catalog;
    const catalogDigest = cloudSchemaCatalogDigest(catalog);
    const qualified = schemaQualification?.version === CLOUD_SCHEMA_QUALIFICATION_VERSION
      && schemaQualification.status === 'PASS' && schemaQualification.catalog_digest === catalogDigest;
    const result = incomplete('database_schema', major !== CLOUD_POSTGRES_MAJOR ? 'cloud_postgresql_17_compatibility_required'
      : comparison.status !== 'PASS' ? 'cloud_schema_inventory_mismatch'
      : !Number.isFinite(clockSkew) || clockSkew > 30_000 ? 'cloud_database_clock_mismatch'
      : 'cloud_restored_schema_parity_unproven', {
      ...comparison, connection, server_major: major, required_server_major: CLOUD_POSTGRES_MAJOR,
      migration_manifest_digest: hostDigest(expected), applied_migration_digest: hostDigest(applied),
      required_tables: tables, clock_skew_ms: clockSkew,
      physical_schema_digest: catalogDigest, restored_schema_qualification: qualified ? schemaQualification : null,
      physical_object_counts: { columns: columns.length, constraints: constraints.length, triggers: triggers.length },
      // Catalog definitions are hashed here, not copied into a customer snapshot.
      recovery: 'review_disposable_postgresql_17_restored_schema_parity'
    });
    if (major === CLOUD_POSTGRES_MAJOR && comparison.status === 'PASS' && Number.isFinite(clockSkew) && clockSkew <= 30000 && qualified) {
      result.status = 'PASS'; result.detail.reason = null;
    }
    return result;
  } catch (error) {
    return incomplete('database_schema', 'cloud_database_probe_failed', { code: error?.code || 'CLOUD_DATABASE_PROBE_FAILED', connection });
  }
};

export const observeCloudHostCertificateA = async ({
  env = process.env, rootDir = process.cwd(), observedAt = new Date().toISOString(),
  query = getFirmDatabaseUrl(env) ? queryFirmDb : null, manifest = null,
  signal,
  fetchImpl = globalThis.fetch, modelLanes = MODEL_LANES,
  storageOps = { createUpload: createEvidenceSignedUploadUrl, read: fetchEvidenceObjectBytes,
    list: listEvidenceObjects, delete: deleteEvidenceObjects }
} = {}) => {
  const identity = resolveRuntimeHostIdentity(env);
  let build = incomplete('source_build', identity.reason || 'cloud_authenticated_deployment_unproven', {
    host_id: identity.host_id, generation_digest: identity.generation_digest || null,
    commit_sha: identity.generation?.source_commit || null, dirty: null,
    dirty_scope: 'vercel-deployment', recovery: 'verify_authenticated_platform_deployment_metadata'
  });
  // Never write a local object and call it a cloud storage probe.
  const storageAbort = new AbortController();
  const storageSignal = signal ? AbortSignal.any([signal, storageAbort.signal]) : storageAbort.signal;
  const storageTimer = setTimeout(() => storageAbort.abort(Object.assign(new Error('Cloud storage probe deadline exceeded.'),
    { code: 'CLOUD_STORAGE_PROBE_TIMEOUT' })), CLOUD_STORAGE_PROBE_TIMEOUT_MS);
  let storage, artifact = null;
  try {
    if (!identity.reason && env.DONNA_HOST_ATTESTATION_PUBLIC_KEY) {
      // This deployment's own artifact first (minted before promotion), then the
      // hand-minted single slot. Each candidate faces the same verifier; an
      // artifact for any other deployment never passes.
      const bucket = env.DONNA_EVIDENCE_BUCKET || env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence';
      const keys = [cloudAttestationKeyFor(identity.generation?.deployment_id), CLOUD_ATTESTATION_KEY].filter(Boolean);
      let first = null;
      for (const key of keys) {
        let candidate, verdict;
        try {
          const bytes = await storageOps.read({ bucket, key, signal: storageSignal, maxBytes: 32768 });
          if (bytes.length > 32768) throw new Error('Artifact too large.');
          candidate = JSON.parse(bytes.toString('utf8'));
          verdict = verifyCloudDeploymentAttestation({ artifact: candidate, identity, env, observedAt });
        } catch { verdict = null; }
        if (verdict?.status === 'PASS') { artifact = candidate; build = verdict; build.detail.attestation = artifact; break; }
        first ||= verdict;
      }
      if (build.status !== 'PASS') build = first || incomplete('source_build', 'cloud_attestation_unavailable');
    }
    storage = identity.runtime_host !== CLOUD_RUNTIME_HOST || identity.reason
      ? incomplete('evidence_storage', 'cloud_storage_identity_unresolved')
      : await storageCheck({ env, observedAt, commitSha: build.detail.commit_sha, fetchImpl, storageOps, signal: storageSignal });
  } finally { clearTimeout(storageTimer); }
  // v6: the storage check scores configuration; a failed lifecycle exchange is
  // a code-only receipt under detail.lifecycle_probe (renewCloudHostReadinessIfDue
  // reports it once per renewal). The only non-PASS storage outcomes here are
  // an unconfigured provider or an unresolved cloud identity, both INCOMPLETE.
  // v7: both dependency checks score configuration; the signed execution and
  // response proofs are receipts inside them (cloudDependencyEvidence.js).
  const handlers = cloudWorkerManifest(manifest);
  const [providers, workers] = await readCloudDependencyEvidence({ query, identity, observedAt, env, manifestDigest: hostDigest(handlers),
    requiredWorkers: CLOUD_REQUIRED_WORKERS, handlers, modelLanes });
  workers.detail = { ...workers.detail, handlers, manifest_digest: hostDigest(handlers) };
  const checks = [build, await observeCloudDatabase({ query, rootDir, observedAt, schemaQualification: build.status === 'PASS' ? artifact?.payload?.schema_qualification : null, connection: describeDatabaseConnection(getFirmDatabaseUrl(env)) }),
    workers, storage, modelRouteCheck(env, modelLanes), providers,
    await staticArtifactCheck({ rootDir }), await configPlaneCheck({ query,
      additionalSupportedKeys: ['FINLAND_ALV_RETURN', 'FINLAND_ALV_FILING', 'INTERNAL_PILOT_ACCESS', ...CLOUD_PILOT_PROCESSING_FLAGS] }), accountingCheck(), spendMeterCheck()];
  for (const check of checks) if (check.detail?.error) check.detail.error = { code: check.detail.error.code || 'CLOUD_PROBE_FAILED' };
  // Readiness consumes signed producer facts; this observer itself never calls a model.
  const body = {
    version: HOST_CERTIFICATE_A_VERSION, certificate: 'A', mode: 'observe_only',
    enforcement: false, product_state_persisted: false, observed_at: observedAt,
    runtime_host: CLOUD_RUNTIME_HOST, observation_contract: CLOUD_HOST_OBSERVATION_VERSION,
    host_identity: { ...identity, commit_sha: build.detail.commit_sha, dirty: build.detail.dirty ?? null },
    compatibility_contract_version: HOST_COMPATIBILITY_CONTRACT_VERSION,
    compatibility_digest: hostCompatibilityDigest({ runtimeHost: CLOUD_RUNTIME_HOST, checks }),
    freshness: buildHostCertificateFreshness({ mintedAt: observedAt }), status: checks.every(check => check.status === 'PASS') ? 'PASS' : 'INCOMPLETE',
    model_inference_calls: 0, model_spend_usd: 0, checks
  };
  // A proof's own expiry is monitoring (v7); only freshness and the deployment
  // attestation bound the certificate.
  const proofDeadlines = [body.freshness.valid_until, build.detail?.expires_at];
  body.effective_valid_until = new Date(Math.min(...proofDeadlines.filter(Boolean).map(Date.parse))).toISOString();
  return { ...body, receipt_digest: hostDigest(body) };
};
