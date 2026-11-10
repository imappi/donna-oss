// Host Certificate A (entity birth-to-close certification, Gate 0B).
//
// This is an OBSERVER, not an admission gate. It names the build and the
// configured/runtime substrate, exercises the real evidence-storage adapter as
// monitoring (a receipt, not a verdict — v6), and reports PASS / FAIL /
// INCOMPLETE. It never invokes a model, never changes a client capability, and
// never persists a certificate into product state.

import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { ACCOUNT_ROLES } from './accountRoles.js';
import { ACCOUNTING_SYSTEM_IDS, DEFAULT_ACCOUNTING_SYSTEM } from './accountingSystems/index.js';
import { AUTO_FORBIDDEN_FLAGS, CONFIG_STAGES, SHADOW_CEILING_FLAGS } from './clientConfig.js';
import { nextCronOccurrence } from './desktop/cronSchedule.js';
import { DESKTOP_CLIENT_FLAG_SEEDS, DESKTOP_FINLAND_FLAG_SEEDS } from './desktop/hostPlaneSeed.js';
import { CRON_RECOVERY_DELAYS_MS } from './desktop/localJobQueue.js';
import {
  createEvidenceSignedUploadUrl,
  deleteEvidenceObjects,
  fetchEvidenceObjectBytes,
  listEvidenceObjects,
  storeLocalEvidenceBytes
} from './evidenceStorage.js';
import { queryFirmDb } from './firmDb.js';
import { FIRST_LINE_PROVIDER_ENV } from './firstLineLane.js';
import { LANE_KINDS, MODEL_LANES } from './modelLanes.js';
import { ENDPOINT_CLASSES, OPENAI_COMPATIBLE_ENV_KEYS } from './providerEndpoints.js';

// v4: workspace dirt stays visible, while only the explicit accounting-runtime
// scope gates the host. Renderer/local-artifact edits cannot brick ingestion.
// v5 (RT-01, audit F-01): `model_routes` is a lane INVENTORY check. A missing
// optional provider credential is a per-lane receipt (credential_present,
// dark_providers, dark_lanes), never INCOMPLETE — INCOMPLETE was neither
// mutation-ready nor queue-recoverable, so one absent Anthropic key stopped
// the scheduler and put every enrolled entity behind host_certificate_not_pass
// while the parse path never needed that key. Credential presence also left
// the compatibility projection (a key added in Settings must not rewrite the
// host digest every entity generation was certified against), and the
// certificate carries no expected model ids: modelLanes.js is the only
// registry for those and says they are not yet authoritative. Persisted v4
// receipts keep naming the predicate that scored them; the next boot mints v5.
// v6 (2026-09-21): `evidence_storage` scores configuration only; the synthetic
// storage lifecycle exchange is a receipt (`detail.lifecycle_probe`), never a
// health verdict — see storageCheck. A v5 receipt said PASS meant the probe
// passed; the version records that the predicate changed. Persisted v5
// receipts keep naming the predicate that scored them; the next boot or
// renewal mints v6.
// v7 (2026-09-23, "fix deployment readiness"): the cloud
// `scheduler_worker_manifest` and `provider_capability` checks score
// CONFIGURATION (required workers registered + Inngest signing key; both
// provider classes with a credential and a route). The signed execution and
// response proofs are receipts (`detail.execution_proof`,
// `detail.response_proof`), never a verdict — the v6 storage split applied
// twice. This loosens admission deliberately: historical liveness bound to the
// deployment generation voided on every merge and could only be restored by a
// daily cron or a manual button. Persisted v6 receipts keep naming the
// predicate that scored them; the next boot or renewal mints v7.
// v8 (2026-11-10, "a dead scheduled job blocks every book"): the predicate is
// unchanged — an unsuperseded dead job still fails `database_schema` with
// `work_queue_needs_recovery` — but the check now NAMES what failed:
// `detail.queue_failures`, one entry per function with unsuperseded dead
// work (the job, when it died, its last error, the recovery budget spent and
// the next recovery or scheduled run due), so a refusal can say "scheduled
// job X failed at T; next attempt at T2" instead of only "the queue needs
// recovery". The detail is a receipt, outside the compatibility projection:
// the host digest entity generations were certified against does not move.
// Persisted v7 receipts keep naming the shape that scored them; the next
// boot or renewal mints v8.
// v9 (2026-11-10, "the first-line lane is dark without its key"): the
// `model_routes` predicate is unchanged (a dark lane is still a receipt,
// never a failure) but its detail changes shape twice. The first-line
// provider (typesafe) needs TYPESAFE_API_KEY AND TYPESAFE_MODEL to send a
// request (firstLineLane.FIRST_LINE_PROVIDER_ENV), so a key without a model
// now reads dark, as the runtime treats it; and every lane carries
// `missing_env`, the names of the rows its dark providers lack, so the
// inventory says which variable lights it. Both stay outside the
// compatibility projection (lane_id, provider, kind): the host digest entity
// generations were certified against does not move. Persisted v8 receipts
// keep naming the shape that scored them; the next boot or renewal mints v9.
export const HOST_CERTIFICATE_A_VERSION = 'donna.host-certificate-a.v9';
export const HOST_COMPATIBILITY_CONTRACT_VERSION = 'donna.host-compatibility.v1';
export const HOST_CERTIFICATE_FRESHNESS_CONTRACT_VERSION = 'donna.host-certificate-freshness.v1';
export const HOST_CERTIFICATE_RENEWAL_INTERVAL_MS = 5 * 60 * 1000;
export const HOST_CERTIFICATE_VALIDITY_MS = 15 * 60 * 1000;
export const HOST_CERTIFICATE_RUNTIME = 'desktop';
export const HOST_CERTIFICATE_STATUSES = Object.freeze(['PASS', 'FAIL', 'INCOMPLETE']);
export const HOST_CERTIFICATE_REQUIRED_TABLES = Object.freeze([
  'schema_migrations',
  'client_capability_config',
  'local_jobs',
  'local_job_steps',
  'local_job_cron_state',
  'local_evidence_objects'
]);

// Credential PRESENCE per endpoint class — a receipt input, never a gate. Key
// NAMES only; no value is ever read into the certificate. The
// openai_compatible pair mirrors providerKeyDotEnv.js / capabilityReceipt.js;
// `local` needs no credential, so its lanes report `credential_present: null`.
const LANE_CREDENTIAL_ENV = Object.freeze({
  openai: Object.freeze(['OPENAI_API_KEY']),
  anthropic: Object.freeze(['ANTHROPIC_API_KEY']),
  typesafe: FIRST_LINE_PROVIDER_ENV,
  openai_compatible: Object.freeze([OPENAI_COMPATIBLE_ENV_KEYS.apiKey, OPENAI_COMPATIBLE_ENV_KEYS.baseUrl]),
  local: Object.freeze([])
});

const clean = (value) => String(value ?? '').trim();
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export const canonicalHostJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalHostJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalHostJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const hostDigest = (value) => sha256(canonicalHostJson(value));

const detailFor = (checks, id) => checks?.find((entry) => entry.id === id)?.detail || {};

// Compatibility deliberately excludes observation identity and transient probe
// readings. Health/status and freshness remain separate admission predicates, so
// a renewal or a recovered storage probe does not rewrite every entity generation.
// v7: nor does it read the cloud worker execution or provider response proofs
// (receipts), so their arrival or expiry never rewrites it either.
export const projectHostCompatibility = ({
  runtimeHost = HOST_CERTIFICATE_RUNTIME,
  checks = []
} = {}) => {
  const build = detailFor(checks, 'source_build');
  const database = detailFor(checks, 'database_schema');
  const scheduler = detailFor(checks, 'scheduler_worker_manifest');
  const storage = detailFor(checks, 'evidence_storage');
  const models = detailFor(checks, 'model_routes');
  const artifacts = detailFor(checks, 'policy_oracle_artifacts');
  const config = detailFor(checks, 'config_control_plane');
  const accounting = detailFor(checks, 'accounting_adapter');
  const spend = detailFor(checks, 'spend_meter');
  return {
    contract_version: HOST_COMPATIBILITY_CONTRACT_VERSION,
    runtime_host: runtimeHost,
    ...(runtimeHost === 'vercel' ? { cloud_runtime: {
      host_id: build.host_id || null,
      generation_digest: build.generation_digest || null,
      physical_schema_digest: database.physical_schema_digest || null,
      required_provider_classes: ['openai', 'anthropic']
    } } : {}),
    source_build: {
      commit_sha: build.commit_sha || null,
      dirty: build.dirty ?? null,
      dirty_scope: build.dirty_scope || null
    },
    database_schema: {
      server_major: database.server_major ?? null,
      expected_migration_digest: database.migration_manifest_digest || null,
      applied_migration_digest: database.applied_migration_digest || null,
      required_tables: runtimeHost === 'vercel' ? (database.required_tables || []) : [...HOST_CERTIFICATE_REQUIRED_TABLES]
    },
    scheduler_worker_manifest: {
      manifest_digest: scheduler.manifest_digest || null,
      handlers: scheduler.handlers || []
    },
    evidence_storage: {
      provider: storage.provider || null,
      operations: storage.operations || []
    },
    // v5: the lane INVENTORY only. Credential presence and model ids are
    // deliberately absent — a key change is a receipt, not a new host.
    model_routes: {
      identity_proof: models.identity_proof || null,
      lane_manifest_digest: models.lane_manifest_digest || null,
      lanes: (models.lanes || []).map(({ lane_id, provider, kind }) => ({ lane_id, provider, kind: kind || null }))
    },
    policy_oracle_artifacts: {
      country_pack_digest: artifacts.country_pack_digest || null,
      account_role_digest: artifacts.account_role_digest || null,
      policy_digest: artifacts.policy_digest || null,
      oracle_digest: artifacts.oracle_digest || null
    },
    config_control_plane: {
      schema_stages: config.schema_stages || [],
      supported_keys: config.supported_keys || []
    },
    accounting_adapter: {
      mode: accounting.mode || null,
      adapter_manifest_digest: accounting.adapter_manifest_digest || null
    },
    spend_meter: {
      reader: spend.reader || null,
      version: spend.version || null
    }
  };
};

export const hostCompatibilityDigest = ({ runtimeHost = HOST_CERTIFICATE_RUNTIME, checks = [] } = {}) =>
  hostDigest(projectHostCompatibility({ runtimeHost, checks }));

const parseTimestamp = (value) => {
  const millis = Date.parse(value);
  return Number.isFinite(millis) ? millis : null;
};

export const buildHostCertificateFreshness = ({ mintedAt } = {}) => {
  const mintedMillis = parseTimestamp(mintedAt);
  if (mintedMillis == null) throw new Error('Host Certificate A requires a valid mintedAt timestamp.');
  return {
    contract_version: HOST_CERTIFICATE_FRESHNESS_CONTRACT_VERSION,
    minted_at: new Date(mintedMillis).toISOString(),
    checked_at: new Date(mintedMillis).toISOString(),
    renew_after: new Date(mintedMillis + HOST_CERTIFICATE_RENEWAL_INTERVAL_MS).toISOString(),
    valid_until: new Date(mintedMillis + HOST_CERTIFICATE_VALIDITY_MS).toISOString(),
    renewal_interval_ms: HOST_CERTIFICATE_RENEWAL_INTERVAL_MS,
    validity_ms: HOST_CERTIFICATE_VALIDITY_MS
  };
};

export const evaluateHostCertificateFreshness = ({ certificate, asOf } = {}) => {
  const freshness = certificate?.freshness || {};
  const mintedMillis = parseTimestamp(freshness.minted_at);
  const checkedMillis = parseTimestamp(freshness.checked_at);
  const renewMillis = parseTimestamp(freshness.renew_after);
  const validUntilMillis = parseTimestamp(freshness.valid_until);
  const asOfMillis = parseTimestamp(asOf);
  const contractValid = freshness.contract_version === HOST_CERTIFICATE_FRESHNESS_CONTRACT_VERSION
    && mintedMillis != null
    && checkedMillis === mintedMillis
    && renewMillis === mintedMillis + HOST_CERTIFICATE_RENEWAL_INTERVAL_MS
    && validUntilMillis === mintedMillis + HOST_CERTIFICATE_VALIDITY_MS
    && freshness.renewal_interval_ms === HOST_CERTIFICATE_RENEWAL_INTERVAL_MS
    && freshness.validity_ms === HOST_CERTIFICATE_VALIDITY_MS
    && asOfMillis != null;
  if (!contractValid) return { status: 'invalid', reason: 'host_freshness_contract_invalid' };
  if (asOfMillis < mintedMillis) return { status: 'not_yet_valid', reason: 'host_certificate_not_yet_valid' };
  if (asOfMillis >= validUntilMillis) return { status: 'expired', reason: 'host_certificate_expired' };
  return {
    status: 'fresh',
    reason: null,
    renewal_due: asOfMillis >= renewMillis,
    valid_until: freshness.valid_until
  };
};

const check = (id, status, detail) => ({ id, status, detail });
const errorDetail = (error) => ({
  code: clean(error?.code) || 'HOST_PROBE_FAILED',
  message: clean(error?.message || error) || 'Host probe failed.'
});

const overallStatus = (checks) => {
  if (checks.some(({ status }) => status === 'FAIL')) return 'FAIL';
  if (checks.some(({ status }) => status === 'INCOMPLETE')) return 'INCOMPLETE';
  return 'PASS';
};

const walkFiles = async (rootDir, relativeDir) => {
  const absolute = path.join(rootDir, relativeDir);
  const entries = await readdir(absolute, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const relative = path.posix.join(relativeDir.replaceAll(path.sep, '/'), entry.name);
    if (entry.isDirectory()) files.push(...await walkFiles(rootDir, relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
};

const digestPaths = async (rootDir, paths) => {
  const files = [];
  for (const relative of paths) {
    const absolute = path.join(rootDir, relative);
    const statEntries = await readdir(absolute, { withFileTypes: true }).catch(() => null);
    if (statEntries) files.push(...await walkFiles(rootDir, relative));
    else files.push(relative);
  }
  const entries = [];
  for (const relative of [...new Set(files)].sort()) {
    const bytes = await readFile(path.join(rootDir, relative));
    entries.push({ path: relative.replaceAll(path.sep, '/'), sha256: sha256(bytes) });
  }
  return { digest: hostDigest(entries), files: entries.map(({ path: file }) => file) };
};

const expectedMigrations = async (rootDir) => (await readdir(path.join(rootDir, 'db', 'migrations')))
  .filter((file) => file.endsWith('.sql'))
  .map((file) => file.replace(/\.sql$/, ''))
  .sort();

const buildIdentityCheck = (env) => {
  const commit = clean(env.DONNA_BUILD_COMMIT_SHA || env.GITHUB_SHA || env.VERCEL_GIT_COMMIT_SHA);
  const workspaceDirtyRaw = clean(env.DONNA_BUILD_DIRTY).toLowerCase();
  const workspaceDirty = workspaceDirtyRaw === 'true' ? true : workspaceDirtyRaw === 'false' ? false : null;
  const runtimeDirtyRaw = clean(env.DONNA_RUNTIME_BUILD_DIRTY || env.DONNA_BUILD_DIRTY).toLowerCase();
  const runtimeDirty = runtimeDirtyRaw === 'true' ? true : runtimeDirtyRaw === 'false' ? false : null;
  const dirtyScope = clean(env.DONNA_RUNTIME_BUILD_DIRTY_SCOPE) || 'desktop-accounting-runtime.v1';
  if (!commit || workspaceDirty === null || runtimeDirty === null) {
    return check('source_build', 'INCOMPLETE', {
      commit_sha: commit || null,
      dirty: runtimeDirty,
      workspace_dirty: workspaceDirty,
      dirty_scope: dirtyScope,
      reason: !commit ? 'build_commit_missing' : 'build_dirty_state_missing'
    });
  }
  return check('source_build', runtimeDirty ? 'FAIL' : 'PASS', {
    commit_sha: commit,
    dirty: runtimeDirty,
    workspace_dirty: workspaceDirty,
    dirty_scope: dirtyScope,
    reason: runtimeDirty
      ? 'dirty_runtime_build'
      : workspaceDirty
        ? 'workspace_dirty_runtime_clean'
        : null
  });
};

// The per-document parse job's function id (desktop/parseDocumentJob.js
// PARSE_DOCUMENT_FUNCTION_ID; equality pinned by hostCertificateA.test.js —
// importing it here would pull the whole parse worker into the observer).
export const HOST_QUEUE_PARSE_DOCUMENT_FUNCTION_ID = 'parse-document';

// When a dead `parse-document` job (`j`, bound to $2) is accounted for by its
// document's stored outcome — see the work-queue rule in databaseCheck.
const DEAD_PARSE_JOB_ACCOUNTED_FOR = `(
  j.function_id = $2
  and j.payload->>'parse_run_id' is not null
  and exists (
    select 1 from documents d
     where d.firm_id = j.payload->>'firm_id'
       and d.id = j.payload->>'document_id'
       and d.parse_run_id is not null
       and (
         (d.parse_run_id::text = j.payload->>'parse_run_id'
           and d.parse_status = 'failed'
           and d.parse_error ? 'code')
         or d.parse_run_id::text <> j.payload->>'parse_run_id'
       )
  )
)`;

// The work-queue rule's one predicate over a dead job `j` ($1 = the
// manifest's cron function ids, $2 = the parse function id): dead, and
// neither a cron tick superseded by a later success of its function nor a
// parse job accounted for by its document. Counted for the verdict and
// listed for `queue_failures` from this same text, so the two cannot drift.
const DEAD_UNSUPERSEDED = `(
  j.status = 'dead'
  and not (
    j.function_id = any($1::text[])
    and exists (
      select 1 from local_jobs superseding
       where superseding.function_id = j.function_id
         and superseding.status = 'succeeded'
         and superseding.completed_at > coalesce(j.completed_at, j.created_at)
    )
  )
  and not (${DEAD_PARSE_JOB_ACCOUNTED_FOR})
)`;

const QUEUE_FAILURE_LIST_LIMIT = 20;
const isoOrNull = (value) => {
  if (value == null) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

// One entry per function holding unsuperseded dead work: its latest dead
// job, and what happens next — a live job of the function (a pending or
// running recovery or tick), else the recovery the scheduler will enqueue
// (localJobQueue.js CRON_RECOVERY_DELAYS_MS), else the next scheduled slot.
// A dead job of a cron-less function has no next attempt: it needs a person.
const queueFailures = ({ rows, cronByFunctionId, observedAt }) => {
  const byFunction = new Map();
  for (const row of rows) {
    const entry = byFunction.get(row.function_id);
    if (entry) {
      entry.dead_count += 1;
      continue;
    }
    const cron = cronByFunctionId.get(row.function_id) || null;
    const scheduledTick = Boolean(row.scheduled_tick);
    const used = Number(row.recoveries_used || 0);
    const max = CRON_RECOVERY_DELAYS_MS.length;
    const diedAt = isoOrNull(row.died_at);
    let nextAttempt = null;
    if (row.live_job?.id != null) {
      nextAttempt = {
        kind: row.live_job.is_recovery ? 'recovery' : 'queued',
        job_id: Number(row.live_job.id),
        status: row.live_job.status,
        at: isoOrNull(row.live_job.run_at)
      };
    } else if (cron && scheduledTick && used < max && diedAt) {
      nextAttempt = { kind: 'recovery', job_id: null, status: 'planned', at: new Date(Date.parse(diedAt) + CRON_RECOVERY_DELAYS_MS[used]).toISOString() };
    } else if (cron) {
      let at = null;
      try { at = nextCronOccurrence(cron, new Date(observedAt)).toISOString(); } catch { at = null; }
      nextAttempt = { kind: 'scheduled', job_id: null, status: 'planned', at };
    }
    byFunction.set(row.function_id, {
      function_id: row.function_id,
      kind: cron ? 'scheduled' : 'job',
      dead_job_id: Number(row.id),
      died_at: diedAt,
      last_error: row.last_error || null,
      dead_count: 1,
      recovery: cron && scheduledTick
        ? { recovers_job_id: Number(row.root_id), used, max, exhausted: used >= max }
        : null,
      next_attempt: nextAttempt
    });
  }
  return [...byFunction.values()].sort((a, b) => a.function_id.localeCompare(b.function_id));
};

const databaseCheck = async ({ query, rootDir, observedAt, cronFunctionIds = [], cronByFunctionId = new Map() }) => {
  if (!query) return check('database_schema', 'INCOMPLETE', { reason: 'postgresql_not_configured' });
  try {
    const expected = await expectedMigrations(rootDir);
    const [versionResult, migrationResult, tableResult, clockResult, queueResult, failureResult] = await Promise.all([
      query("select current_setting('server_version_num')::integer as server_version_num, version() as version"),
      query('select version from schema_migrations order by version'),
      query(
        `select name, to_regclass(name) is not null as present
           from unnest($1::text[]) as required(name)
          order by name`,
        [HOST_CERTIFICATE_REQUIRED_TABLES]
      ),
      query('select now() as database_now'),
      // A dead cron tick whose function has a LATER succeeded run is
      // superseded residue, not lost work: each tick re-sweeps current state,
      // and desktop life (sleep past a lease, a slow sweep) produces them
      // routinely. Only unsuperseded dead work — a dead non-cron job, or a
      // cron function with no success since its death — gates the host.
      //
      // A dead `parse-document` job is accounted for by its document's own
      // stored state, never by its error text. On its last automatic
      // attempt the worker writes the honest terminal on the row (failed,
      // a typed parse_error, the retry on the human) and the queue's
      // dead-letter is the receipt of that spent budget: an outcome about
      // that document, not lost work of the host. So the job is accounted
      // for when its document carries, for the SAME run, `failed` with a
      // typed error (`parse_error.code`), or has since moved to a LATER run
      // (a retry or re-admission minted a new parse_run_id: every worker
      // write is fenced on the run id, so the old run can never write, and
      // the new run's own job is counted here like any other). A dead
      // parse job whose document still claims that run in flight, or whose
      // document row is gone, is exactly the lost work this rule is for and
      // still fails the host.
      query(
        `select
           count(*) filter (where status = 'pending')::integer as pending,
           count(*) filter (where status = 'running')::integer as running,
           count(*) filter (where status = 'succeeded')::integer as succeeded,
           count(*) filter (where status = 'dead')::integer as dead,
           count(*) filter (where status = 'cancelled')::integer as cancelled,
           count(*) filter (where status = 'running' and lease_expires_at < now())::integer as expired_running,
           count(*) filter (where status = 'pending' and attempt_count > 0)::integer as retrying,
           count(*) filter (where ${DEAD_UNSUPERSEDED})::integer as dead_unsuperseded,
           count(*) filter (
             where status = 'dead'
               and ${DEAD_PARSE_JOB_ACCOUNTED_FOR}
           )::integer as dead_accounted_by_document
         from local_jobs j`,
        [cronFunctionIds, HOST_QUEUE_PARSE_DOCUMENT_FUNCTION_ID]
      ),
      // What the verdict counted, named: newest death first per function.
      query(
        `select j.id, j.function_id, coalesce(j.completed_at, j.created_at) as died_at,
                left(j.last_error, 300) as last_error,
                j.payload ? 'tick' as scheduled_tick,
                coalesce(nullif(j.payload->'recovers'->>'dead_job_id', '')::bigint, j.id) as root_id,
                (select count(*) from local_jobs r
                  where r.function_id = j.function_id
                    and r.payload->'recovers'->>'dead_job_id'
                        = coalesce(nullif(j.payload->'recovers'->>'dead_job_id', '')::bigint, j.id)::text
                )::integer as recoveries_used,
                (select jsonb_build_object('id', l.id, 'status', l.status, 'run_at', l.run_at,
                                           'is_recovery', l.payload ? 'recovers')
                   from local_jobs l
                  where l.function_id = j.function_id and l.status in ('pending', 'running')
                  order by l.run_at, l.id
                  limit 1) as live_job
           from local_jobs j
          where ${DEAD_UNSUPERSEDED}
          order by coalesce(j.completed_at, j.created_at) desc, j.id desc
          limit ${QUEUE_FAILURE_LIST_LIMIT * 5}`,
        [cronFunctionIds, HOST_QUEUE_PARSE_DOCUMENT_FUNCTION_ID]
      )
    ]);
    const actual = migrationResult.rows.map(({ version }) => String(version)).sort();
    const missingMigrations = expected.filter((version) => !actual.includes(version));
    const unexpectedMigrations = actual.filter((version) => !expected.includes(version));
    const missingTables = tableResult.rows.filter(({ present }) => !present).map(({ name }) => name);
    const serverVersionNum = Number(versionResult.rows[0]?.server_version_num || 0);
    const databaseNow = new Date(clockResult.rows[0]?.database_now).toISOString();
    const clockSkewMs = Math.abs(new Date(databaseNow).getTime() - new Date(observedAt).getTime());
    const queue = queueResult.rows[0] || {};
    const structuralFailure = Math.floor(serverVersionNum / 10000) !== 16
      || missingMigrations.length > 0
      || unexpectedMigrations.length > 0
      || missingTables.length > 0
      || clockSkewMs > 30_000;
    const queueFailure = Number(queue.dead_unsuperseded || 0) > 0
      || Number(queue.expired_running || 0) > 0;
    return check('database_schema', structuralFailure || queueFailure ? 'FAIL' : 'PASS', {
      ...(!structuralFailure && queueFailure ? { reason: 'work_queue_needs_recovery' } : {}),
      server_version: versionResult.rows[0]?.version || null,
      server_major: Math.floor(serverVersionNum / 10000),
      expected_migration_count: expected.length,
      applied_migration_count: actual.length,
      migration_manifest_digest: hostDigest(expected),
      applied_migration_digest: hostDigest(actual),
      missing_migrations: missingMigrations,
      unexpected_migrations: unexpectedMigrations,
      missing_tables: missingTables,
      database_clock: databaseNow,
      clock_skew_ms: clockSkewMs,
      queue: Object.fromEntries(Object.entries(queue).map(([key, value]) => [key, Number(value || 0)])),
      queue_failures: queueFailures({ rows: failureResult.rows || [], cronByFunctionId, observedAt })
        .slice(0, QUEUE_FAILURE_LIST_LIMIT)
    });
  } catch (error) {
    return check('database_schema', 'INCOMPLETE', { reason: 'postgresql_probe_failed', error: errorDetail(error) });
  }
};

const runtimeCheck = async ({ query, manifest, schedulerEnabled }) => {
  if (!manifest?.length) return check('scheduler_worker_manifest', 'INCOMPLETE', { reason: 'runtime_manifest_missing' });
  const handlers = manifest.map((entry) => ({
    function_id: entry.functionId,
    kind: entry.kind,
    cron: entry.cron || null,
    max_attempts: entry.maxAttempts ?? 1,
    concurrency: entry.concurrency ?? 1,
    lease_ms: entry.leaseMs ?? null,
    timeout_ms: entry.timeoutMs ?? null,
    handler_version: entry.handlerVersion ?? null
  })).sort((a, b) => a.function_id.localeCompare(b.function_id));
  if (!query) {
    return check('scheduler_worker_manifest', 'INCOMPLETE', {
      reason: 'postgresql_not_configured', handler_count: handlers.length, manifest_digest: hostDigest(handlers)
    });
  }
  try {
    const state = await query('select function_id, last_enqueued_tick from local_job_cron_state order by function_id');
    const expected = handlers.filter(({ cron }) => cron).map(({ function_id }) => function_id);
    const actual = state.rows.map(({ function_id }) => function_id);
    const missing = expected.filter((id) => !actual.includes(id));
    const unexpected = actual.filter((id) => !expected.includes(id));
    const failed = !schedulerEnabled || missing.length > 0 || unexpected.length > 0;
    return check('scheduler_worker_manifest', failed ? 'FAIL' : 'PASS', {
      scheduler_enabled: Boolean(schedulerEnabled),
      handler_count: handlers.length,
      manifest_digest: hostDigest(handlers),
      handlers,
      cron_state_count: actual.length,
      missing_cron_state: missing,
      unexpected_cron_state: unexpected
    });
  } catch (error) {
    return check('scheduler_worker_manifest', 'INCOMPLETE', {
      reason: 'scheduler_manifest_probe_failed',
      manifest_digest: hostDigest(handlers),
      error: errorDetail(error)
    });
  }
};

const storageConfigured = (env) => Boolean(
  clean(env.DONNA_DESKTOP_BLOB_DIR)
  || (clean(env.SUPABASE_URL || env.VITE_SUPABASE_URL)
    && clean(env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY || env.SUPABASE_SECRET_KEY))
);

// v6 (2026-09-21, the hosted Kampaamo "36 Stalled" incident): `evidence_storage`
// is a CONFIGURATION check — PASS when this host has a storage provider
// configured, INCOMPLETE when it has none. The recurring signed write →
// exact-byte read → list → delete → absence exchange still runs on every
// observation, but it is MONITORING: its outcome is receipted under
// `detail.lifecycle_probe` and never scores the check or the certificate. One
// transient synthetic PUT failure (HOST_STORAGE_UPLOAD_FAILED at 18:02 UTC;
// PASS again at 18:08) used to turn the certificate INCOMPLETE, revoke every
// enrolled entity's mutation admission and stamp every bank line Stalled —
// completed lines and open owner questions included — while the ACTUAL storage
// operations (registration's signed upload, the parse read) carry their own
// truthful receipts and bounded recovery. `provider` and `operations` are the
// adapter's declared operation contract (compatibility identity) and are
// byte-identical to the v5 PASS values, so a healthy host's compatibility
// digest is unchanged and a probe outcome can no longer rewrite it. The receipt
// keeps only safe diagnostics — the stage, the HTTP status and an error CODE —
// never a signed URL, a credential or a response body.
const STORAGE_OPERATION_CONTRACT = Object.freeze({
  local_blob: Object.freeze(['adapter_write', 'service_read', 'list', 'delete', 'list_after_delete']),
  supabase_storage: Object.freeze(['signed_write', 'service_read', 'list', 'delete', 'list_after_delete'])
});
const storageProvider = (env) => (clean(env.DONNA_DESKTOP_BLOB_DIR) ? 'local_blob' : 'supabase_storage');

const storageLifecycleProbe = async ({ env, observedAt, commitSha, fetchImpl, storageOps, signal, provider }) => {
  // Use a permitted evidence MIME without widening the bucket's allowlist.
  const bytes = Buffer.from(canonicalHostJson({ certificate_version: HOST_CERTIFICATE_A_VERSION, commit_sha: commitSha || 'unknown' }), 'utf8');
  const bucket = clean(env.DONNA_EVIDENCE_BUCKET || env.SUPABASE_EVIDENCE_BUCKET) || 'donna-evidence';
  const key = `__host_certificate_a__/${sha256(`${observedAt}:${commitSha || 'unknown'}`).slice(0, 24)}.json`;
  const contract = STORAGE_OPERATION_CONTRACT[provider];
  const completed = [];
  let operation = contract[0];
  let uploaded = false;
  let httpStatus = null;
  const receipt = (extra) => ({
    observed_at: observedAt,
    operations_completed: [...completed],
    byte_length: bytes.length,
    probe_key_digest: sha256(key),
    ...extra
  });
  try {
    if (provider === 'local_blob') {
      await storageOps.put({ bucket, key, bytes, contentType: 'application/json' });
    } else {
      const signed = await storageOps.createUpload({ bucket, key, expiresIn: 300, ...(signal ? { signal } : {}) });
      // Once PUT starts, cancellation leaves object existence uncertain.
      if (signal) uploaded = true;
      const response = await fetchImpl(signed.signed_url, {
        ...(signal ? { signal } : {}),
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-upsert': 'false' },
        body: bytes
      });
      httpStatus = Number.isInteger(response.status) ? response.status : null;
      if (!response.ok) {
        // Drain the body so a stalled response cannot outlive the deadline; its
        // text never reaches the receipt.
        await response.arrayBuffer().catch(() => {});
        throw Object.assign(new Error(`storage upload returned ${response.status}`), { code: 'HOST_STORAGE_UPLOAD_FAILED', statusCode: response.status });
      }
      uploaded = true;
      // A cloud probe owns the complete exchange, including a successful PUT
      // body. Leaving an unread stalled body would escape its deadline.
      if (signal) await response.arrayBuffer();
    }
    uploaded = true;
    completed.push(operation);
    operation = 'service_read'; httpStatus = null;
    const read = await storageOps.read({ bucket, key, ...(signal ? { signal } : {}) });
    if (!Buffer.from(read).equals(bytes)) throw Object.assign(new Error('storage read bytes differ from the written probe'), { code: 'HOST_STORAGE_READ_MISMATCH' });
    completed.push(operation);
    operation = 'list';
    const beforeDelete = await storageOps.list({ bucket, prefix: '__host_certificate_a__/', ...(signal ? { signal } : {}) });
    if (!beforeDelete.some((entry) => entry.name === key)) throw Object.assign(new Error('storage listing did not contain the written probe'), { code: 'HOST_STORAGE_LIST_MISSING' });
    completed.push(operation);
    operation = 'delete';
    const deleted = await storageOps.delete({ bucket, keys: [key], ...(signal ? { signal } : {}) });
    if (Number(deleted?.deleted || 0) !== 1 || deleted?.errors?.length) {
      throw Object.assign(new Error('storage delete did not remove exactly one probe object'), {
        code: 'HOST_STORAGE_DELETE_FAILED',
        statusCode: Number.isInteger(deleted?.errors?.[0]?.status) ? deleted.errors[0].status : undefined
      });
    }
    completed.push(operation);
    operation = 'list_after_delete';
    const afterDelete = await storageOps.list({ bucket, prefix: '__host_certificate_a__/', ...(signal ? { signal } : {}) });
    if (afterDelete.some((entry) => entry.name === key)) throw Object.assign(new Error('storage probe remained visible after delete'), { code: 'HOST_STORAGE_DELETE_UNPROVEN' });
    signal?.throwIfAborted();
    completed.push(operation);
    uploaded = false;
    return receipt({ status: 'PASS' });
  } catch (error) {
    let cleanup = uploaded ? 'unproven' : null;
    if (uploaded && !signal?.aborted) {
      cleanup = await storageOps.delete({ bucket, keys: [key], ...(signal ? { signal } : {}) })
        .then((result) => (Number(result?.deleted || 0) === 1 && !result?.errors?.length ? 'deleted' : 'unproven'))
        .catch(() => 'unproven');
    }
    const cause = signal?.aborted ? signal.reason : error;
    return receipt({
      status: 'FAIL',
      reason: 'storage_lifecycle_probe_failed',
      operation,
      http_status: Number.isInteger(cause?.statusCode) ? cause.statusCode : httpStatus,
      error: { code: clean(cause?.code) || 'HOST_PROBE_FAILED' },
      cleanup_required: uploaded && cleanup !== 'deleted'
    });
  }
};

const storageCheck = async ({ env, observedAt, commitSha, fetchImpl, storageOps, signal }) => {
  if (!storageConfigured(env)) return check('evidence_storage', 'INCOMPLETE', { reason: 'storage_not_configured' });
  const provider = storageProvider(env);
  const lifecycleProbe = await storageLifecycleProbe({ env, observedAt, commitSha, fetchImpl, storageOps, signal, provider });
  return check('evidence_storage', 'PASS', {
    provider,
    operations: [...STORAGE_OPERATION_CONTRACT[provider]],
    lifecycle_probe: lifecycleProbe
  });
};

// v5: an INVENTORY check. The lane registry (modelLanes.js) must be
// well-formed — snake_case unique ids, a known kind, a known endpoint class,
// at least one module — and that is all a host is asked to prove; a malformed
// registry is a build defect and FAILs like any other drifted dependency.
// Which providers hold a credential is receipted per lane and per provider so
// a human reads "anthropic dark" from the certificate, the boot line and
// /firms/health — every consumer already fails soft without its key
// (desktop/capabilityReceipt.js). Nothing here invokes a model.
const modelRouteCheck = (env, modelLanes = MODEL_LANES) => {
  const inventory = (Array.isArray(modelLanes) ? modelLanes : []).map((lane) => ({
    lane_id: clean(lane?.id),
    kind: clean(lane?.kind) || null,
    provider: clean(lane?.endpointClass) || null,
    // RT-12: a provider-agnostic lane names every endpoint class that may
    // serve it; the lane is LIT when any of them holds a credential.
    providers: Array.isArray(lane?.providers) && lane.providers.length
      ? lane.providers.map((entry) => clean(entry)).filter(Boolean)
      : [clean(lane?.endpointClass)].filter(Boolean),
    modules: Array.isArray(lane?.modules) ? [...lane.modules] : []
  }));
  const failures = [];
  const seen = new Set();
  if (!inventory.length) failures.push('lane_registry_empty');
  for (const lane of inventory) {
    const label = lane.lane_id || '(unnamed)';
    if (!/^[a-z][a-z0-9_]*$/.test(lane.lane_id)) failures.push(`lane_id_invalid:${label}`);
    else if (seen.has(lane.lane_id)) failures.push(`lane_id_duplicate:${label}`);
    seen.add(lane.lane_id);
    if (!LANE_KINDS.includes(lane.kind)) failures.push(`lane_kind_unknown:${label}`);
    if (!ENDPOINT_CLASSES.includes(lane.provider)) failures.push(`lane_provider_unknown:${label}`);
    for (const provider of lane.providers) {
      if (provider !== lane.provider && !ENDPOINT_CLASSES.includes(provider)) failures.push(`lane_provider_unknown:${label}:${provider}`);
    }
    if (!lane.modules.length) failures.push(`lane_modules_missing:${label}`);
  }
  // Per lane: present when ANY of its providers holds every credential it
  // needs; null when none of them needs one (`local`); false otherwise.
  const lanes = inventory.map((lane) => {
    const perProvider = lane.providers.map((provider) => {
      const credentials = LANE_CREDENTIAL_ENV[provider] || null;
      return credentials?.length ? credentials.every((name) => Boolean(clean(env[name]))) : null;
    });
    const credentialPresent = perProvider.some((present) => present === true)
      ? true
      : (perProvider.every((present) => present === null) ? null : false);
    return {
      ...lane,
      credential_present: credentialPresent,
      lit_providers: lane.providers.filter((_, index) => perProvider[index] === true),
      // v9: the rows a dark lane lacks, by name (never a value). Empty when lit.
      missing_env: credentialPresent === false
        ? [...new Set(lane.providers.flatMap((provider) => (LANE_CREDENTIAL_ENV[provider] || []).filter((name) => !clean(env[name]))))]
        : []
    };
  });
  const dark = lanes.filter(({ credential_present }) => credential_present === false);
  return check('model_routes', failures.length ? 'FAIL' : 'PASS', {
    identity_proof: 'lane_inventory_only_not_model_proven',
    inference_calls: 0,
    spend_usd: 0,
    lane_count: lanes.length,
    // Credential-free: the digest moves when a lane is added, removed or
    // re-homed to another provider — a compatibility change — and never when
    // a key is added or removed.
    lane_manifest_digest: hostDigest(inventory),
    failures,
    dark_providers: [...new Set(dark.map(({ provider }) => provider))].sort(),
    dark_lanes: dark.map(({ lane_id }) => lane_id),
    lanes
  });
};

const staticArtifactCheck = async ({ rootDir }) => {
  try {
    const [packs, policy, oracle] = await Promise.all([
      digestPaths(rootDir, ['packs']),
      digestPaths(rootDir, ['data/worlds/policy']),
      digestPaths(rootDir, ['server/donna/world/oracleSuite.js', 'server/donna/world/oracleAssurance.js'])
    ]);
    return check('policy_oracle_artifacts', 'PASS', {
      country_pack_digest: packs.digest,
      country_pack_files: packs.files,
      account_role_digest: hostDigest(ACCOUNT_ROLES),
      account_role_count: Object.keys(ACCOUNT_ROLES).length,
      policy_digest: policy.digest,
      policy_files: policy.files,
      oracle_digest: oracle.digest,
      oracle_files: oracle.files
    });
  } catch (error) {
    return check('policy_oracle_artifacts', 'INCOMPLETE', { reason: 'artifact_digest_failed', error: errorDetail(error) });
  }
};

const configPlaneCheck = async ({ query, additionalSupportedKeys = [] }) => {
  const declaredKeys = new Set([
    ...additionalSupportedKeys,
    ...DESKTOP_CLIENT_FLAG_SEEDS, ...DESKTOP_FINLAND_FLAG_SEEDS,
    ...AUTO_FORBIDDEN_FLAGS,
    ...SHADOW_CEILING_FLAGS,
    // Known optional setup/experiment-plane keys; none is a baseline seed or a
    // statutory-service capability assertion. Entity B scopes their admission.
    'AE_OPENING_BALANCES',
    'AE_VAT_FACT_AUTOMATION',
    'FISCAL_PERIOD_INTAKE',
    'BANK_LINE_DISPOSITION',
    'JEV_RECONCILIATION',
    'JEV_HELD_PLAN_COMPLETION',
    'CODING_CORRECTION_AUTO_APPLY',
    'TAX_REGISTRATION_POSTED_RECHECK',
    'CODING_OWNER_TRANSFER_POST',
    'INVENTORY_CORE', 'INVENTORY_ACCOUNTING',
    'PHYSICAL_RECONCILIATION', 'PHYSICAL_INVENTORY_APPLY', 'PHYSICAL_CAPTURE_ACCESS',
    'SG_NATIVE_PROCESSING_REVIEW',
    // Firm-default selection for the US hosted pilot birth (2026-10-01).
    'US_HOSTED_PILOT'
  ]);
  const supportedKeys = [...declaredKeys].sort();
  if (!query) {
    const keys = [...declaredKeys].sort();
    return check('config_control_plane', 'INCOMPLETE', {
      reason: 'postgresql_not_configured', schema_stages: [...CONFIG_STAGES], supported_keys: supportedKeys, declared_keys: keys,
      declared_key_digest: hostDigest(keys)
    });
  }
  try {
    const result = await query('select distinct flag_key from client_capability_config order by flag_key');
    const activeKeys = result.rows.map(({ flag_key }) => String(flag_key));
    for (const key of activeKeys) declaredKeys.add(key);
    const keys = [...declaredKeys].sort();
    return check('config_control_plane', 'PASS', {
      table: 'client_capability_config',
      schema_stages: [...CONFIG_STAGES],
      supported_keys: supportedKeys,
      declared_and_active_keys: keys,
      active_database_keys: activeKeys,
      capability_key_digest: hostDigest(keys)
    });
  } catch (error) {
    return check('config_control_plane', 'INCOMPLETE', { reason: 'config_plane_probe_failed', error: errorDetail(error) });
  }
};

const accountingCheck = () => check('accounting_adapter', 'PASS', {
  mode: 'internal_ledger_with_optional_external_adapter',
  default_external_adapter: DEFAULT_ACCOUNTING_SYSTEM,
  registered_external_adapters: [...ACCOUNTING_SYSTEM_IDS],
  adapter_manifest_digest: hostDigest(ACCOUNTING_SYSTEM_IDS)
});

const spendMeterCheck = () => check('spend_meter', 'PASS', {
  reader: 'scripts/eval_world_spend.js',
  version: 'world-spend.v3',
  this_certificate_inference_calls: 0,
  this_certificate_spend_usd: 0
});

export const observeHostCertificateA = async ({
  env = process.env,
  rootDir = process.cwd(),
  observedAt = new Date().toISOString(),
  manifest = null,
  schedulerEnabled = false,
  modelLanes = MODEL_LANES,
  fetchImpl = globalThis.fetch,
  query = clean(env.DATABASE_URL) ? queryFirmDb : null,
  storageOps = {
    put: storeLocalEvidenceBytes,
    createUpload: createEvidenceSignedUploadUrl,
    read: fetchEvidenceObjectBytes,
    list: listEvidenceObjects,
    delete: deleteEvidenceObjects
  }
} = {}) => {
  const build = buildIdentityCheck(env);
  const cronFunctionIds = (manifest || [])
    .filter((entry) => entry?.cron)
    .map((entry) => entry.functionId);
  const checks = [
    build,
    await databaseCheck({
      query, rootDir, observedAt, cronFunctionIds,
      cronByFunctionId: new Map((manifest || []).filter((entry) => entry?.cron).map((entry) => [entry.functionId, entry.cron]))
    }),
    await runtimeCheck({ query, manifest, schedulerEnabled }),
    await storageCheck({ env, observedAt, commitSha: build.detail.commit_sha, fetchImpl, storageOps }),
    modelRouteCheck(env, modelLanes),
    await staticArtifactCheck({ rootDir }),
    await configPlaneCheck({ query }),
    accountingCheck(),
    spendMeterCheck()
  ];
  const status = overallStatus(checks);
  const compatibilityDigest = hostCompatibilityDigest({
    runtimeHost: HOST_CERTIFICATE_RUNTIME,
    checks
  });
  const body = {
    version: HOST_CERTIFICATE_A_VERSION,
    certificate: 'A',
    mode: 'observe_only',
    enforcement: false,
    product_state_persisted: false,
    observed_at: observedAt,
    runtime_host: HOST_CERTIFICATE_RUNTIME,
    host_identity: {
      commit_sha: build.detail.commit_sha || null,
      dirty: build.detail.dirty ?? null,
      workspace_dirty: build.detail.workspace_dirty ?? null,
      dirty_scope: build.detail.dirty_scope || null
    },
    compatibility_contract_version: HOST_COMPATIBILITY_CONTRACT_VERSION,
    compatibility_digest: compatibilityDigest,
    freshness: buildHostCertificateFreshness({ mintedAt: observedAt }),
    status,
    model_inference_calls: 0,
    model_spend_usd: 0,
    checks
  };
  return { ...body, receipt_digest: hostDigest(body) };
};

// Shared observation primitives; cloud does not invoke desktop queue/schema probes.
export { storageCheck, modelRouteCheck, staticArtifactCheck, configPlaneCheck, accountingCheck, spendMeterCheck };
