import { getFirmDatabaseUrl, withFirmDbClient } from './db/pool.js';
import { describeDatabaseConnection } from './db/databaseConnectionMode.js';
import { acquireSessionAdmissionLease, releaseAdmissionLeasePreservingError } from './db/admissionLeaseLifecycle.js';
import { OWNER_ADOPTION_PROFILE_ID, readConsumedOwnerAdoptionWithClient } from './existingOwnerRevalidation.js';
import { readNativeChartLineage } from './nativeChartLineage.js';
// Gate 1B.2–1B.3 — the one client-scoped mutation admission decision.
//
// ENTITY_READINESS_ADMISSION is deliberately narrower than an ordinary flag.
// Firm defaults and cohorts cannot enroll a legacy book by accident, and the
// env fallback is permanently false. Gate 1B.3 admits two exact client-scoped
// canary postures: a manual target and the source-controlled new-client default.
// When the flag does not act, behavior stays byte-identical. When it acts,
// every irreversible seam locks the same entity saga and current Host A row
// before it mutates.
//
// Migration 127 makes every load-bearing entity dependency invalidate that
// saga in the dependency writer's transaction. The shared row lock here is the
// TOCTOU boundary: an already-started mutation drains under its pinned ready
// generation, while a dependency change that commits first makes the mutation
// refuse. Host renewal/failure uses the same serialization on the host row.

import {
  ENTITY_READINESS_ADMISSION_FLAG,
  clientFlagActs
} from './clientConfig.js';
import { hostReadinessIsMutationReady } from './runtimeReadiness.js';
import { classifyEntityReadinessEnrollment } from './runtimeReadinessEnrollment.js';
import { resolveRuntimeHostIdentity, CLOUD_RUNTIME_HOST } from './runtimeHostIdentity.js';

export const ENTITY_READINESS_ADMISSION_ERROR = 'ENTITY_READINESS_ADMISSION_BLOCKED';
export const ENTITY_READINESS_BLOCKED_ACTION = 'runtime.readiness_admission_blocked';
export const PROCESSING_REVIEW_ONLY = 'processing_review_only';
export const PROCESSING_SCOPE_ADMISSION_ERROR = 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE';

// Birth scope survives configuration revocation and profile changes. This is
// the single decision consumed by journal/close writers and posting workers;
// it is deliberately separate from recoverable, flag-enrolled readiness.
export const evaluateRetainedProcessingScopeWithClient = async ({ client, firmId, clientId, boundary = 'ledger_write', lock = true }) => {
  let lineage;
  try {
    lineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId, lock });
  } catch (error) {
    // SQL/NOWAIT failures retain their original transaction semantics.
    if (error.code !== 'NATIVE_CHART_LINEAGE_INVALID') throw error;
    return nativeChartLineageInvalidDecision(error, { boundary });
  }
  if (lineage) return retainedProcessingScopeDecision(lineage, { boundary });
  // The SG hosted-review (legacy26) profile has no native lineage but persists
  // the SAME scope on its birth `pilot.prepared` receipt. Same owner, same
  // refusal: a review-only book never posts, whichever chart it was born on.
  return persistedReviewOnlyScopeDecision(await readPersistedReviewOnlyReceipt({ client, firmId, clientId }), { boundary });
};

// Current-life only (after the last client.delete), like the native marker.
// Keyed on (firm_id, resource_id, action) so audit_events_firm_resource_action_idx
// (migration 157) serves it: this runs on every non-native ledger_write admission,
// and both pilot.prepared writers set resource_id = client_id.
// A hosted-SG creation receipt that predates the scope field fails closed to
// review-only via its authority_basis rather than needing a backfill.
const readPersistedReviewOnlyReceipt = async ({ client, firmId, clientId }) => (await client.query(
  `select id::text, metadata from audit_events where firm_id=$1 and resource_id=$2 and action='pilot.prepared'
      and (metadata->>'processing_scope' = 'document_processing_review_only'
           or metadata->>'authority_basis' = 'authenticated_singapore_firm_creation')
      and id > coalesce((select max(d.id) from audit_events d
            where d.firm_id=$1 and d.resource_id=$2 and d.action='client.delete'), 0)
    order by audit_events.id desc limit 1`, [firmId, clientId])).rows[0] || null;

const persistedReviewOnlyScopeDecision = (receipt, { boundary = 'ledger_write' } = {}) => !receipt
  ? { enforced: false, allowed: true, boundary, reason_code: null }
  : { enforced: true, allowed: false, boundary, reason_code: PROCESSING_REVIEW_ONLY,
      responsible_system: 'donna_processing_scope', retryable: false, accounting_ready: false,
      processing_scope: 'document_processing_review_only',
      entity_receipt_ref: { store: 'audit_events', id: Number(receipt.id) } };

// One client's unverifiable native lineage (a partial/corrupt retained marker)
// is that client's scoped refusal — never authority, never a firm-wide failure.
// Shared by admission and the convergence projection so both speak one shape.
export const NATIVE_CHART_LINEAGE_INVALID = 'native_chart_lineage_invalid';
export const nativeChartLineageInvalidDecision = (error, { boundary = 'ledger_write' } = {}) => ({
  enforced: true, allowed: false, boundary, reason_code: NATIVE_CHART_LINEAGE_INVALID,
  responsible_system: 'donna_processing_scope', retryable: false, lineage_error: error?.details ?? null,
  accounting_ready: false, entity_receipt_ref: null });

// Every OTHER verifiable-native refusal the review projection can raise for one
// client (a registration revision chain that does not verify, a coding-choice or
// coding-policy refusal) is the same shape of violation: that client's scoped
// refusal, never a firm-wide failure. The reason key carries the refusal's own
// reason so the hanging rows name what to repair. Only these typed refusals map
// here; SQL/NOWAIT/infrastructure errors are not refusals and keep propagating.
export const NATIVE_REVIEW_REFUSED = 'native_review_refused';
const NATIVE_REVIEW_REFUSAL_CODES = Object.freeze(['SINGAPORE_NATIVE_REGISTRATION_INVALID', 'NATIVE_CODING_CHOICE_INVALID']);
export const isNativeReviewRefusal = (error) => error?.code === 'NATIVE_CHART_LINEAGE_INVALID'
  || NATIVE_REVIEW_REFUSAL_CODES.includes(error?.code)
  || (error?.name === 'CodingPolicyError' && typeof error.code === 'string');
export const nativeReviewRefusalDecision = (error, { boundary = 'review_projection' } = {}) => {
  if (error?.code === 'NATIVE_CHART_LINEAGE_INVALID') return nativeChartLineageInvalidDecision(error, { boundary });
  const slug = String(error?.details?.reason || error?.code || 'unknown').toLowerCase().replace(/[^a-z0-9_]+/g, '_').slice(0, 64);
  return { enforced: true, allowed: false, boundary, native_refusal: true,
    reason_code: `${NATIVE_REVIEW_REFUSED}:${slug}`, responsible_system: 'donna_processing_scope', retryable: false,
    refusal_error: { code: error?.code ?? null, reason: error?.details?.reason ?? null },
    accounting_ready: false, entity_receipt_ref: null };
};

export const retainedProcessingScopeDecision = (lineage, { boundary = 'ledger_write' } = {}) => {
  if (!lineage) return { enforced: false, allowed: true, boundary, reason_code: null };
  return { enforced: true, allowed: false, boundary, reason_code: PROCESSING_REVIEW_ONLY,
    responsible_system: 'donna_processing_scope', retryable: false, accounting_ready: false,
    processing_scope: lineage.receipt.metadata.processing_scope,
    entity_receipt_ref: { store: 'audit_events', id: lineage.receipt.id },
    birth_receipt_digest: lineage.receipt.metadata.receipt_digest, client_life: lineage.client_life };
};

export const readRetainedProcessingScopeInDb = (options) => withFirmDbClient(client =>
  evaluateRetainedProcessingScopeWithClient({ ...options, client, lock: false }));

export const ENTITY_READINESS_BOUNDARIES = Object.freeze([
  'upload_sign',
  'local_blob_put',
  'document_register',
  'parse_claim',
  'worker_discovery',
  'ask_send',
  'reconciliation_authority',
  'action_authority',
  'ledger_write'
]);

// An enrolled entity whose readiness saga rests at failed/exhausted has no
// automatic exit: the heal only re-drives 'scheduled' sagas, and the one way
// out is the owner's explicit Reopen (`reopen_exhausted`). Admission would
// refuse it at every boundary, so a periodic discovery that selects it only
// mints a refusal receipt per tick, forever (old Kampaamo, 2026-09-16..23:
// 4,159 worker_discovery refusals). Client discoveries exclude it with this
// ONE fragment; the saga row itself — projected with can_reopen — is the
// visible resting state. This is a discovery filter, never an admission: a
// client it lets through still meets the unchanged admission check above,
// and a not-enrolled or saga-less client is never excluded. (Under a
// CLIENT_CONFIG_FORCE_DISABLE kill of the admission flag an exhausted entity
// still waits for Reopen — narrower, never wider.)
export const entityReadinessExhaustedRestSql = (firmColumn, clientColumn) => `exists (
      select 1
        from entity_readiness_sagas exhausted_saga
        join client_capability_config exhausted_enrollment
          on exhausted_enrollment.firm_id = exhausted_saga.firm_id
         and exhausted_enrollment.client_id = exhausted_saga.client_id
         and exhausted_enrollment.flag_key = '${ENTITY_READINESS_ADMISSION_FLAG}'
         and exhausted_enrollment.valid_to is null
         and exhausted_enrollment.stage in ('canary', 'auto')
       where exhausted_saga.firm_id = ${firmColumn}
         and exhausted_saga.client_id = ${clientColumn}
         and exhausted_saga.state = 'failed'
         and exhausted_saga.retry_state = 'exhausted'
    )`;

const clean = (value) => String(value ?? '').trim();
const rows = (result) => Array.isArray(result?.rows) ? result.rows : [];

const blocked = ({
  boundary,
  reasonCode,
  responsibleSystem = 'donna_readiness',
  flagRow = null,
  enrollmentKind = null,
  saga = null,
  host = null,
  expectedDependencyDigest = null
}) => ({
  enforced: true,
  allowed: false,
  boundary,
  reason_code: reasonCode,
  responsible_system: responsibleSystem,
  retryable: true,
  flag_stage: flagRow?.stage || null,
  flag_source: flagRow?.source || null,
  enrollment_kind: enrollmentKind,
  saga_id: saga?.saga_id || null,
  saga_state: saga?.state || null,
  retry_state: saga?.retry_state || null,
  ready_dependency_digest: saga?.ready_dependency_digest || null,
  observed_dependency_digest: saga?.observed_dependency_digest || null,
  expected_dependency_digest: expectedDependencyDigest || null,
  entity_receipt_ref: saga?.latest_attempt_id == null ? null : {
    store: 'audit_events',
    id: Number(saga.latest_attempt_id)
  },
  root_cause_receipt_ref: saga?.root_cause_receipt_id == null ? null : {
    store: 'audit_events',
    id: Number(saga.root_cause_receipt_id)
  },
  host_receipt_ref: host?.latest_attempt_id == null ? null : {
    store: 'runtime_host_readiness_attempts',
    id: Number(host.latest_attempt_id)
  },
  // What the host's work-queue failure is, named (Host A v8
  // `database_schema.detail.queue_failures`): the function, when its job
  // died, and the next recovery or scheduled run. Read from the same receipt
  // the verdict came from; it informs, it never decides.
  host_queue_failures: hostQueueFailures(host)
});

const hostQueueFailures = (host) => {
  const failures = (host?.certificate?.checks || [])
    .find((entry) => entry?.id === 'database_schema')?.detail?.queue_failures;
  if (!Array.isArray(failures) || !failures.length) return null;
  return failures.map((entry) => ({
    function_id: entry.function_id,
    kind: entry.kind,
    dead_job_id: entry.dead_job_id ?? null,
    died_at: entry.died_at ?? null,
    last_error: entry.last_error ?? null,
    recovery: entry.recovery ?? null,
    next_attempt: entry.next_attempt ?? null
  }));
};

// "Scheduled job X failed at T; next attempt at T2." — one clause per failure.
const describeQueueFailures = (failures) => failures.map((entry) => {
  const noun = entry.kind === 'scheduled' ? 'Scheduled job' : 'Job';
  const died = entry.died_at ? ` failed at ${entry.died_at}` : ' failed';
  const next = entry.next_attempt?.at
    ? `; next attempt at ${entry.next_attempt.at}${entry.next_attempt.kind === 'recovery' && entry.recovery
      ? ` (recovery ${Math.min(entry.recovery.used + (entry.next_attempt.job_id == null ? 1 : 0), entry.recovery.max)} of ${entry.recovery.max})`
      : entry.next_attempt.kind === 'scheduled' ? ' (its next scheduled run)' : ''}`
    : '; it will not be retried automatically';
  return `${noun} ${entry.function_id}${died}${next}.`;
}).join(' ');

// The refusal names its actual condition. "Recovery" is only honest while a
// retry is scheduled or the host is being re-checked; an exhausted or failed
// saga says so and points at the Retry control (2026-09-16: a removed creator
// membership rendered as an indefinite "recovery" banner).
export const describeEntityReadinessAdmission = (decision = {}) => {
  if (decision.responsible_system === 'donna_processing_scope') {
    return decision.reason_code === PROCESSING_REVIEW_ONLY
      ? 'This workspace supports document processing and review only. Accounting posting and period locking are unavailable.'
      : 'The retained chart identity could not be verified. Accounting posting and period locking are unavailable.';
  }
  const reason = clean(decision?.reason_code);
  const sagaState = clean(decision?.saga_state);
  const retryState = clean(decision?.retry_state);
  if (sagaState === 'failed' && retryState === 'exhausted') {
    return `Donna could not finish preparing this company for automated work (${reason || 'readiness_exhausted'}). Open the company's readiness panel and choose Retry, or contact support if it fails again.`;
  }
  if (sagaState === 'failed' && reason && !reason.startsWith('host_')) {
    return `Donna's readiness check for this company failed (${reason}) and is being retried automatically. Use Retry in the company's readiness panel if it does not clear.`;
  }
  if (Array.isArray(decision?.host_queue_failures) && decision.host_queue_failures.length) {
    return `Donna is holding new automated work until its work queue recovers. ${describeQueueFailures(decision.host_queue_failures)} New work resumes when it succeeds.`;
  }
  return 'Donna is completing a runtime readiness recovery before accepting new automated work.';
};

export class EntityReadinessAdmissionError extends Error {
  constructor(decision) {
    super(describeEntityReadinessAdmission(decision));
    this.name = 'EntityReadinessAdmissionError';
    this.code = decision.responsible_system === 'donna_processing_scope'
      ? PROCESSING_SCOPE_ADMISSION_ERROR : ENTITY_READINESS_ADMISSION_ERROR;
    this.statusCode = decision.retryable === false ? 409 : 503;
    this.details = decision;
    this.retryable = decision.retryable !== false;
  }
}

const readExplicitFlagRow = async (client, { firmId, clientId, lock }) => {
  try {
    const result = await client.query(
      `select flag_key, stage, source, reason, client_id
         from client_capability_config
        where firm_id = $1 and client_id = $2 and flag_key = $3
          and valid_to is null
        order by valid_from desc, id desc
        limit 1${lock ? ' for share' : ''}`,
      [firmId, clientId, ENTITY_READINESS_ADMISSION_FLAG]
    );
    return rows(result).find((row) => row?.flag_key === ENTITY_READINESS_ADMISSION_FLAG) || null;
  } catch (error) {
    // Rolling deploy from a pre-042/pre-127 database cannot contain an acting
    // readiness row, so it remains outside this explicitly enrolled canary.
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }
};

const readSaga = async (client, { firmId, clientId, lock }) => {
  const result = await client.query(
    `select * from entity_readiness_sagas
      where firm_id = $1 and client_id = $2${lock ? ' for share' : ''}`,
    [firmId, clientId]
  );
  return rows(result)[0] || null;
};

const readHost = async (client, { lock, hostId }) => {
  if (!hostId) return null;
  const result = await client.query(lock
    ? `select h.*, a.certificate from runtime_host_readiness h
         join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
        where h.host_id = $1 for share of h`
    : `select h.*, a.certificate from runtime_host_readiness h
         join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
        where h.host_id = $1`, [hostId]);
  return rows(result)[0] || null;
};

export const evaluateEntityReadinessAdmissionWithClient = async ({
  client,
  firmId,
  clientId,
  boundary,
  expectedDependencyDigest = null,
  asOf = new Date().toISOString(),
  env = process.env,
  lock = true
} = {}) => {
  if (!client || !clean(firmId) || !clean(clientId)) {
    throw new Error('Entity readiness admission needs client, firmId and clientId.');
  }
  if (!ENTITY_READINESS_BOUNDARIES.includes(boundary)) {
    throw new Error(`Unknown entity readiness boundary: ${boundary}`);
  }

  if (boundary === 'ledger_write') {
    const scope = await evaluateRetainedProcessingScopeWithClient({ client, firmId, clientId, boundary, lock });
    if (!scope.allowed) return scope;
  }

  // Do not use the generic snapshot reader here: its firm/cohort inheritance
  // is correct for ordinary flags but would silently enroll legacy entities.
  const flagRow = await readExplicitFlagRow(client, { firmId, clientId, lock });
  const acts = clientFlagActs({
    flagKey: ENTITY_READINESS_ADMISSION_FLAG,
    snapshot: flagRow ? { [ENTITY_READINESS_ADMISSION_FLAG]: flagRow } : {},
    envFallback: () => false,
    env
  });
  if (!acts) {
    return {
      enforced: false,
      allowed: true,
      boundary,
      reason_code: 'readiness_admission_not_enrolled',
      entity_dependency_digest: null
    };
  }
  const enrollment = classifyEntityReadinessEnrollment(flagRow);
  if (!enrollment.valid) {
    return blocked({
      boundary,
      reasonCode: 'readiness_admission_flag_posture_invalid',
      responsibleSystem: 'donna_configuration',
      flagRow,
      expectedDependencyDigest
    });
  }

  // Keep the lock order identical to provisioning and migration 127:
  // entity advisory key first, saga row second. A mutation such as the shared
  // ledger writer can itself change a certified dependency (for example mint
  // a genuinely new chart account), whose trigger needs the exclusive form
  // of this key. Taking the transaction-scoped shared key before the saga row
  // avoids an advisory↔row lock inversion with a concurrent retry while still
  // letting the mutation finish against the generation it admitted.
  if (lock) {
    await client.query(
      'select pg_advisory_xact_lock_shared(hashtextextended($1, 0))',
      [`entity-readiness:${firmId}:${clientId}`]
    );
  }

  const saga = await readSaga(client, { firmId, clientId, lock });
  if (!saga) {
    return blocked({
      boundary,
      reasonCode: 'legacy_uncertified',
      flagRow,
      enrollmentKind: enrollment.enrollment_kind,
      expectedDependencyDigest
    });
  }
  if (saga.state !== 'ready') {
    return blocked({
      boundary,
      reasonCode: saga.reason_code || `entity_readiness_${saga.state || 'not_ready'}`,
      responsibleSystem: saga.responsible_system || 'donna_readiness',
      flagRow,
      enrollmentKind: enrollment.enrollment_kind,
      saga,
      expectedDependencyDigest
    });
  }
  if (!clean(saga.ready_dependency_digest)
      || saga.ready_dependency_digest !== saga.observed_dependency_digest) {
    return blocked({
      boundary,
      reasonCode: 'entity_dependency_digest_changed',
      flagRow,
      enrollmentKind: enrollment.enrollment_kind,
      saga,
      expectedDependencyDigest
    });
  }
  if (expectedDependencyDigest
      && expectedDependencyDigest !== saga.ready_dependency_digest) {
    return blocked({
      boundary,
      reasonCode: 'entity_generation_changed',
      flagRow,
      enrollmentKind: enrollment.enrollment_kind,
      saga,
      expectedDependencyDigest
    });
  }

  const hostIdentity = resolveRuntimeHostIdentity();
  const host = await readHost(client, { lock, hostId: hostIdentity.host_id });
  if (hostIdentity.reason) return blocked({ boundary, reasonCode: hostIdentity.reason,
    responsibleSystem: 'donna_runtime', flagRow, enrollmentKind: enrollment.enrollment_kind, saga, host });
  if (!host || !hostReadinessIsMutationReady({ certificate: host.certificate, asOf, hostIdentity, env })) {
    return blocked({
      boundary,
      reasonCode: host?.reason_code || 'host_readiness_not_ready',
      responsibleSystem: host?.responsible_system || 'donna_runtime',
      flagRow,
      enrollmentKind: enrollment.enrollment_kind,
      saga,
      host,
      expectedDependencyDigest
    });
  }

  if (hostIdentity.runtime_host === CLOUD_RUNTIME_HOST && saga.host_compatibility_digest !== host.certificate.compatibility_digest) {
    return blocked({ boundary, reasonCode: 'cloud_host_compatibility_changed', responsibleSystem: 'donna_runtime',
      flagRow, enrollmentKind: enrollment.enrollment_kind, saga, host, expectedDependencyDigest });
  }

  if (saga.admitted_profile_id === OWNER_ADOPTION_PROFILE_ID) {
    let adoption;
    try { adoption=await readConsumedOwnerAdoptionWithClient(client,{firmId,clientId,lock}); }
    catch(error) {
      // SQL errors (including NOWAIT contention) abort the transaction. Let
      // its owner roll it back; attempting a refusal audit here would mask
      // the root cause with 25P02 and falsely label contention invalid ownership.
      if(!String(error.code||'').startsWith('OWNER_REVALIDATION_')) throw error;
    }
    if(enrollment.enrollment_kind!=='manual_target' || !adoption) return blocked({boundary,
      reasonCode:'current_owner_adoption_invalid',flagRow,enrollmentKind:enrollment.enrollment_kind,saga,host,expectedDependencyDigest});
  }

  // RT-09 (audit F-21): scope the migration-127/133 dependency fence to THIS
  // admitted transaction. A write Donna makes under an admission decision
  // (the ledger post path minting a chart account, a grant chokepoint, the
  // locked ask send) must not invalidate the generation that admitted it.
  // The value is the exact ready generation digest and the setting is
  // transaction-local (set_config(..., true)): it cannot outlive the
  // transaction or leak to another pooled connection, so a foreign write on
  // any other connection — or a stale digest — still invalidates exactly as
  // before. Outside a transaction block (the lease preflight) the statement
  // is its own transaction and the setting evaporates with it — a no-op,
  // never a leak. Set BEFORE the decision is returned so every admitted seam
  // gets the scope without touching a writer.
  await client.query(
    "select set_config('donna.admitted_generation', $1, true)",
    [saga.ready_dependency_digest]
  );

  return {
    enforced: true,
    allowed: true,
    boundary,
    reason_code: null,
    enrollment_kind: enrollment.enrollment_kind,
    entity_dependency_digest: saga.ready_dependency_digest,
    saga_id: saga.saga_id,
    host_compatibility_digest: host.compatibility_digest,
    entity_receipt_ref: saga.latest_attempt_id == null ? null : {
      store: 'audit_events', id: Number(saga.latest_attempt_id)
    },
    host_receipt_ref: host.latest_attempt_id == null ? null : {
      store: 'runtime_host_readiness_attempts', id: Number(host.latest_attempt_id)
    }
  };
};

export const recordEntityReadinessBlockedWithClient = async ({
  client,
  firmId,
  clientId,
  boundary,
  decision,
  resourceType = 'entity_readiness_boundary',
  resourceId = null,
  actorId = 'entityReadinessAdmission',
  actorType = 'system'
} = {}) => {
  if (!client || decision?.allowed !== false) return null;
  const result = await client.query(
    `insert into audit_events
       (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, $7, $8, $3, $4, $5, $6::jsonb)
     returning id, created_at`,
    [
      firmId,
      clientId,
      ENTITY_READINESS_BLOCKED_ACTION,
      resourceType,
      resourceId || `${clientId}:${boundary}`,
      JSON.stringify({
        boundary,
        reason_code: decision.reason_code,
        responsible_system: decision.responsible_system,
        retryable: decision.retryable !== false,
        processing_scope: decision.processing_scope,
        birth_receipt_digest: decision.birth_receipt_digest,
        client_life: decision.client_life,
        lineage_error: decision.lineage_error,
        flag_stage: decision.flag_stage,
        flag_source: decision.flag_source,
        enrollment_kind: decision.enrollment_kind,
        saga_id: decision.saga_id,
        ready_dependency_digest: decision.ready_dependency_digest,
        observed_dependency_digest: decision.observed_dependency_digest,
        expected_dependency_digest: decision.expected_dependency_digest,
        entity_receipt_ref: decision.entity_receipt_ref,
        root_cause_receipt_ref: decision.root_cause_receipt_ref,
        host_receipt_ref: decision.host_receipt_ref
      }), actorType, actorId
    ]
  );
  return rows(result)[0] || null;
};

export const checkEntityReadinessAdmissionWithClient = async (options = {}) => {
  const decision = await evaluateEntityReadinessAdmissionWithClient(options);
  if (!decision.allowed) {
    await recordEntityReadinessBlockedWithClient({ ...options, decision });
  }
  return decision;
};

export const assertEntityReadinessAdmissionWithClient = async (options = {}) => {
  const decision = await checkEntityReadinessAdmissionWithClient(options);
  if (!decision.allowed) throw new EntityReadinessAdmissionError(decision);
  return decision;
};

// A few historical reconciliation writers intentionally run without a SQL
// transaction so a failed cascade can be persisted and retried. They cannot
// hold a row lock across that sequence. A session-scoped shared advisory lease
// uses the same entity key as provisioning and migration 127's invalidator,
// preserving those partial-failure semantics while still fencing dependency
// changes until the reconciliation consequence has finished.
export const acquireEntityReadinessAdmissionLeaseWithClient = async (options = {}) => {
  const { client, firmId, clientId } = options;
  const preflight = await evaluateEntityReadinessAdmissionWithClient({ ...options, lock: false });
  if (!preflight.enforced) {
    return { decision: preflight, release: async () => {} };
  }
  const connection = describeDatabaseConnection(client.connectionParameters || getFirmDatabaseUrl());
  if (connection.inferred_pool_mode === 'supabase_transaction') {
    throw Object.assign(new Error('This worker requires a session-preserving database connection. Configure the Supabase session endpoint before retrying.'), {
      code: 'ADMISSION_SESSION_POOLING_UNSUPPORTED', responsible_system: 'donna_database_connection',
      retryable: true, statusCode: 503, connection
    });
  }
  const lease = await acquireSessionAdmissionLease(client, `entity-readiness:${firmId}:${clientId}`);
  try {
    const decision = await checkEntityReadinessAdmissionWithClient({ ...options, lock: false });
    if (!decision.allowed) throw new EntityReadinessAdmissionError(decision);
    return { decision, release: lease.release };
  } catch (error) {
    await releaseAdmissionLeasePreservingError(lease, error);
    throw error;
  }
};

export const runWithEntityReadinessWorkerAdmission = async ({
  client,
  firmId,
  clientId,
  work,
  leaseAcrossWork = true
} = {}) => {
  if (typeof work !== 'function') throw new Error('Worker admission needs a work callback.');
  // Some legacy convergence coordinators dispatch their per-item writes
  // through independently pooled transactions. Holding a session lock on
  // this coordinator connection would make one of those child transactions
  // wait forever when its legitimate mutation changes a certified dependency.
  // For that shape, fence the discovery itself in a short transaction; every
  // irreversible child seam (ask, authority, ledger) still performs its own
  // final transactional admission check.
  if (!leaseAcrossWork) {
    await client.query('begin');
    let decision;
    try {
      decision = await checkEntityReadinessAdmissionWithClient({
        client,
        firmId,
        clientId,
        boundary: 'worker_discovery',
        resourceType: 'client_worker_pool',
        resourceId: clientId
      });
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
    if (!decision.allowed) throw new EntityReadinessAdmissionError(decision);
    return work(client);
  }
  const lease = await acquireEntityReadinessAdmissionLeaseWithClient({
    client,
    firmId,
    clientId,
    boundary: 'worker_discovery',
    resourceType: 'client_worker_pool',
    resourceId: clientId
  });
  let firstError;
  try {
    return await work(client);
  } catch (error) {
    firstError = error;
    throw error;
  } finally {
    await releaseAdmissionLeasePreservingError(lease, firstError);
  }
};
