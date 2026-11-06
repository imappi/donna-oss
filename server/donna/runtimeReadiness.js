import { HOSTED_PILOT_VERSIONS } from './internalPilotAccess.js';
import { SG_NATIVE_CAPABILITY_MANIFEST, hostedMarketProfileFor } from './cloudPilotConfig.js';
import { readNativeChartLineage } from './nativeChartLineage.js';
import { readConsumedOwnerAdoptionWithClient } from './existingOwnerRevalidation.js';
// Gate 1B persisted readiness and bounded recovery.
//
// This module composes Host A / Entity B around the existing writers. It owns
// only the two plane-S read models and their receipts: Host attempts use the
// narrowly global immutable table from migration 126 (audit_events cannot
// represent a pre-firm boot); entity attempts use append-only audit_events.
// Gate 1B.2 owns the admission fences; Gate 1B.3 adds the exact selected legacy
// recovery pool plus bounded retries for failed source-controlled new-client
// enrollments over the same saga and receipt substrate.

import { verifyCloudDeploymentAttestation } from './cloudDeploymentAttestation.js';
import { readAccountingProfile, accountingProfileFailures, ACCOUNTING_ADMISSION_CONTRACT } from '../../src/lib/accountingProfile.js';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  HOST_CERTIFICATE_A_VERSION,
  HOST_CERTIFICATE_RENEWAL_INTERVAL_MS,
  HOST_CERTIFICATE_RUNTIME,
  buildHostCertificateFreshness,
  evaluateHostCertificateFreshness,
  hostDigest,
  hostCompatibilityDigest,
  observeHostCertificateA
} from './hostCertificateA.js';
import {
  ENTITY_CERTIFICATE_B_VERSION,
  entityProvisioningSagaIdentity,
  observeEntityCertificateB
} from './entityCertificateB.js';
import { ENTITY_READINESS_ADMISSION_FLAG } from './clientConfig.js';
import { resolveRuntimeHostIdentity, CLOUD_RUNTIME_HOST, CLOUD_PILOT_CAPABILITY_MANIFEST, cloudCertificateIdentityMatches } from './runtimeHostIdentity.js';
import {
  ENTITY_READINESS_NEW_CLIENT_REASON,
  ENTITY_READINESS_NEW_CLIENT_SOURCE,
  classifyEntityReadinessEnrollment
} from './runtimeReadinessEnrollment.js';

export const RUNTIME_HOST_READINESS_ID = 'desktop-local';
export const ENTITY_READINESS_MAX_ATTEMPTS = 3;
export const ENTITY_READINESS_RETRY_DELAYS_MS = Object.freeze([60_000, 5 * 60_000]);
export const ENTITY_READINESS_STATES = Object.freeze(['provisioning', 'ready', 'failed']);
export const ENTITY_READINESS_RETRY_STATES = Object.freeze(['idle', 'scheduled', 'exhausted']);
export const TARGETED_ENTITY_READINESS_HEAL_LIMIT = 25;

const RUNTIME_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const clean = (value) => String(value ?? '').trim();
const sha256 = (value) => createHash('sha256').update(String(value)).digest('hex');
const rows = (result) => Array.isArray(result?.rows) ? result.rows : [];
const timestamp = (value) => {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new Error(`Invalid readiness timestamp: ${value}`);
  return { millis, iso: new Date(millis).toISOString() };
};

// RT-09 (audit F-06) — host-caused entity failures are BUDGET-FREE.
//
// The entity's three-attempt episode budget exists to stop a broken ENTITY
// from being re-proven forever. A failure whose first cause is the HOST — no
// Host A receipt yet, a receipt from another certificate version, a required
// structural check not PASS, a receipt whose digests do not recompute, a
// receipt that is stale or not yet valid — says nothing about the entity, and
// its only repairer is the host's own next PASS renewal. Before this slice
// every such attempt charged the budget and scheduled a clock (+60s/+5min)
// that no runner could honour while the host was down (the only retry
// runners already required a healthy host), so three operator Retry clicks
// against a dead host exhausted a perfectly good entity.
//
// A host-wait attempt is still observed and receipted (budget_charged false
// on the attempt receipt); the saga rests failed/scheduled with next_retry_at
// NULL — "waiting for the runtime host", no clock — and the Host A PASS
// transition's heal (healTargetedEntityReadiness on renewal) is its runner.
//
// The list below is exhaustive over what entityCertificateB.js's
// hostCompatibilityCheck mints, and runtimeReadinessHostWait.test.js scans
// that function's source to prove it: a NEW host-side code cannot silently
// start burning budgets, and a profile×host INCOMPATIBILITY (the entity
// declares a runtime host / storage provider / adapter / capability key this
// host does not offer — a fact about the entity's declaration, healed by
// nothing a renewal does) stays budgeted, deliberately. The six
// host_<check>_not_pass companions are written out rather than derived from
// REQUIRED_HOST_COMPATIBILITY_CHECKS: this module sits inside the
// firmDb ↔ certificate import cycle, and a module-level use of that binding
// is a TDZ error whichever side loads first; the test pins the expansion.
export const ENTITY_READINESS_HOST_WAIT_REASON_CODES = Object.freeze([
  'host_certificate_missing',
  'host_certificate_version_mismatch',
  'host_certificate_not_pass',
  'host_database_schema_not_pass',
  'host_scheduler_worker_manifest_not_pass',
  'host_evidence_storage_not_pass',
  'host_policy_oracle_artifacts_not_pass',
  'host_config_control_plane_not_pass',
  'host_accounting_adapter_not_pass',
  'host_certificate_digest_missing',
  'host_certificate_digest_mismatch',
  'host_compatibility_contract_version_mismatch',
  'host_compatibility_digest_missing',
  'host_compatibility_digest_mismatch',
  'host_freshness_contract_invalid',
  'host_certificate_not_yet_valid',
  'host_certificate_expired'
]);
export const ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_CODES = Object.freeze([
  'runtime_host_mismatch',
  'desktop_storage_provider_mismatch',
  'accounting_adapter_not_registered'
]);
export const ENTITY_READINESS_HOST_INCOMPATIBILITY_REASON_PREFIXES = Object.freeze([
  'host_capability_key_unsupported:'
]);
const HOST_WAIT_REASON_SET = new Set(ENTITY_READINESS_HOST_WAIT_REASON_CODES);
export const isEntityReadinessHostWaitReason = (reasonCode) => HOST_WAIT_REASON_SET.has(clean(reasonCode));

const firstCertificateFailure = (certificate) => {
  const failed = (certificate?.checks || []).find(({ status }) => status !== 'PASS') || null;
  const reason = failed?.detail?.failures?.[0]
    || failed?.detail?.reason
    || failed?.detail?.error?.code
    || (failed ? `${failed.id}_not_ready` : null);
  return failed ? {
    check_id: failed.id,
    status: failed.status,
    reason_code: clean(reason) || 'certificate_check_incomplete'
  } : null;
};

const responsibleSystemFor = (reasonCode, checkId = '') => {
  const value = `${checkId}:${reasonCode}`.toLowerCase();
  if (value.includes('host_') || value.includes('source_build') || value.includes('storage') || value.includes('scheduler')) {
    return 'donna_runtime';
  }
  if (value.includes('identity') || value.includes('actor') || value.includes('owner') || value.includes('assignment')) {
    return 'workspace_identity';
  }
  if (value.includes('chart') || value.includes('accounting') || value.includes('country_pack')) {
    return 'accounting_setup';
  }
  if (value.includes('capability') || value.includes('authority')) return 'donna_configuration';
  if (value.includes('profile') || value.includes('manifest')) return 'entity_profile';
  return 'donna_readiness';
};

const hostFailure = (certificate) => {
  const first = firstCertificateFailure(certificate);
  return {
    reasonCode: first?.reason_code || (certificate?.status === 'PASS' ? null : 'host_certificate_not_ready'),
    responsibleSystem: responsibleSystemFor(first?.reason_code, first?.check_id)
  };
};

export const persistHostReadinessAttempt = async ({
  withFirmDbClientFn,
  certificate,
  hostId = resolveRuntimeHostIdentity().host_id,
  eventType = 'boot',
  evidenceOnly = false
} = {}) => {
  if (typeof withFirmDbClientFn !== 'function') throw new Error('Host readiness persistence needs withFirmDbClientFn.');
  if (!hostId) throw new Error('Host readiness persistence needs an unambiguous runtime host identity.');
  if (certificate?.runtime_host === CLOUD_RUNTIME_HOST && certificate?.host_identity?.host_id !== hostId) {
    throw new Error('Cloud readiness receipt belongs to a different host.');
  }
  if (!certificate?.receipt_digest || !certificate?.freshness) throw new Error('Host readiness persistence needs a Host A receipt.');
  const { receipt_digest: receiptDigest, ...certificateBody } = certificate;
  if (receiptDigest !== hostDigest(certificateBody)) throw new Error('Host readiness persistence refused an invalid receipt digest.');
  if (!['boot', 'renewal', 'retry'].includes(eventType)) throw new Error(`Unknown Host A event type: ${eventType}`);
  if (evidenceOnly && (certificate?.certificate !== 'cloud_dependency_evidence' || certificate.status !== 'INCOMPLETE'
    || certificate.runtime_host !== CLOUD_RUNTIME_HOST)) throw new Error('Dependency evidence cannot project or assert host readiness.');
  const { reasonCode, responsibleSystem } = hostFailure(certificate);

  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`runtime-host-readiness:${hostId}`]);
      const current = rows(await client.query(
        'select attempt_count from runtime_host_readiness where host_id = $1 for update',
        [hostId]
      ))[0] || null;
      const highest = certificate.runtime_host === CLOUD_RUNTIME_HOST
        ? rows(await client.query('select coalesce(max(attempt_sequence), 0)::integer as n from runtime_host_readiness_attempts where host_id=$1', [hostId]))[0]?.n
        : current?.attempt_count;
      const attemptSequence = Number(highest || 0) + 1;
      let attempt = rows(await client.query(
        `insert into runtime_host_readiness_attempts
           (host_id, attempt_sequence, event_type, status, certificate_version,
            compatibility_digest, receipt_digest, reason_code, responsible_system,
            certificate, observed_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)
         on conflict (receipt_digest) do nothing
         returning id, attempt_sequence`,
        [
          hostId,
          attemptSequence,
          eventType,
          certificate.status,
          certificate.version,
          certificate.compatibility_digest || null,
          certificate.receipt_digest,
          reasonCode,
          responsibleSystem,
          JSON.stringify(certificate),
          certificate.observed_at
        ]
      ))[0] || null;
      if (!attempt) {
        attempt = rows(await client.query(
          'select id, attempt_sequence from runtime_host_readiness_attempts where receipt_digest = $1',
          [certificate.receipt_digest]
        ))[0];
      }
      if (evidenceOnly) {
        await client.query('commit');
        return { host_id: hostId, status: 'INCOMPLETE', attempt_id: Number(attempt.id),
          attempt_count: Number(attempt.attempt_sequence), certificate, evidence_only: true };
      }
      const freshness = certificate.freshness;
      await client.query(
        `insert into runtime_host_readiness
           (host_id, status, certificate_version, runtime_host, build_commit_sha, build_dirty,
            compatibility_digest, receipt_digest, latest_attempt_id, attempt_count,
            reason_code, responsible_system, minted_at, checked_at, renew_after, valid_until, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
                 $13::timestamptz, $14::timestamptz, $15::timestamptz, $16::timestamptz, now())
         on conflict (host_id) do update set
           status = excluded.status,
           certificate_version = excluded.certificate_version,
           runtime_host = excluded.runtime_host,
           build_commit_sha = excluded.build_commit_sha,
           build_dirty = excluded.build_dirty,
           compatibility_digest = excluded.compatibility_digest,
           receipt_digest = excluded.receipt_digest,
           latest_attempt_id = excluded.latest_attempt_id,
           attempt_count = greatest(runtime_host_readiness.attempt_count, excluded.attempt_count),
           reason_code = excluded.reason_code,
           responsible_system = excluded.responsible_system,
           minted_at = excluded.minted_at,
           checked_at = excluded.checked_at,
           renew_after = excluded.renew_after,
           valid_until = excluded.valid_until,
           updated_at = now()
         where excluded.attempt_count >= runtime_host_readiness.attempt_count`,
        [
          hostId,
          certificate.status,
          certificate.version,
          certificate.runtime_host,
          certificate.host_identity?.commit_sha || null,
          certificate.host_identity?.dirty ?? null,
          certificate.compatibility_digest || null,
          certificate.receipt_digest,
          attempt.id,
          Number(attempt.attempt_sequence),
          reasonCode,
          responsibleSystem,
          freshness.minted_at,
          freshness.checked_at,
          freshness.renew_after,
          certificate.runtime_host === 'vercel' ? certificate.effective_valid_until || freshness.valid_until : freshness.valid_until
        ]
      );
      const persisted = rows(await client.query(
        `select h.status, h.attempt_count, h.reason_code,
                h.latest_attempt_id, a.certificate
           from runtime_host_readiness h
           join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
          where h.host_id = $1`,
        [hostId]
      ))[0];
      await client.query('commit');
      return {
        host_id: hostId,
        status: persisted.status,
        attempt_id: Number(persisted.latest_attempt_id),
        attempt_count: Number(persisted.attempt_count),
        reason_code: persisted.reason_code,
        certificate: persisted.certificate
      };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
};

export const mintAndPersistHostReadiness = async ({
  withFirmDbClientFn,
  observe = observeHostCertificateA,
  eventType = 'boot',
  hostId = resolveRuntimeHostIdentity().host_id,
  ...observerOptions
} = {}) => {
  const certificate = await observe(observerOptions);
  return persistHostReadinessAttempt({ withFirmDbClientFn, certificate, eventType, hostId });
};

export const buildHostOperationalFailureCertificate = ({
  certificate,
  checkId,
  reasonCode,
  observedAt = new Date().toISOString()
} = {}) => {
  if (!certificate || !clean(checkId) || !clean(reasonCode)) {
    throw new Error('Operational Host A failure needs a certificate, checkId and reasonCode.');
  }
  const at = timestamp(observedAt).iso;
  const { receipt_digest: _priorDigest, ...prior } = certificate;
  const body = {
    ...prior,
    observed_at: at,
    freshness: buildHostCertificateFreshness({ mintedAt: at }),
    status: 'FAIL',
    checks: [
      ...(certificate.checks || []).filter(({ id }) => id !== checkId),
      { id: checkId, status: 'FAIL', detail: { reason: reasonCode } }
    ]
  };
  return { ...body, receipt_digest: hostDigest(body) };
};

export const readCurrentHostCertificateWithClient = async (client, hostId = resolveRuntimeHostIdentity().host_id) => {
  if (!hostId) return null;
  const result = await client.query(
    `select a.certificate
       from runtime_host_readiness h
       join runtime_host_readiness_attempts a on a.id = h.latest_attempt_id
      where h.host_id = $1`,
    [hostId]
  );
  return rows(result)[0]?.certificate || null;
};

export const readinessProfileCoordinate = ({ client, creationPath, nativeLineage = null, hostIdentity = resolveRuntimeHostIdentity() } = {}) => ({
  jurisdiction: clean(client?.jurisdiction).toUpperCase(),
  canonical_legal_form: clean(client?.entity_type),
  creation_path: creationPath,
  runtime_host: hostIdentity.runtime_host,
  accounting_adapter: clean(client?.profile?.accounting_system || 'none').toLowerCase(),
  accounting_view: readAccountingProfile(client?.profile).view.value,
  capability_manifest_version: hostIdentity.runtime_host === CLOUD_RUNTIME_HOST
    ? nativeLineage ? SG_NATIVE_CAPABILITY_MANIFEST
      : hostedMarketProfileFor(client?.jurisdiction)?.capabilityManifest || CLOUD_PILOT_CAPABILITY_MANIFEST
    : 'desktop-runtime.v2'
});

const syntheticFailedCertificate = ({ firmId, clientId, coordinate, observedAt, error }) => {
  const reasonCode = clean(error?.code) || 'ENTITY_PROFILE_UNDECLARED';
  const { sagaId, idempotencyKey } = entityProvisioningSagaIdentity({ firmId, clientId });
  const profileId = `undeclared:${clean(coordinate?.jurisdiction || 'unknown').toLowerCase()}:${clean(coordinate?.canonical_legal_form || 'unknown')}:${clean(coordinate?.creation_path || 'unknown')}`;
  const body = {
    version: ENTITY_CERTIFICATE_B_VERSION,
    certificate: 'B',
    mode: 'observe_only',
    enforcement: false,
    product_state_persisted: false,
    admission_authority: false,
    observed_at: observedAt,
    status: 'INCOMPLETE',
    admitted_profile: { profile_id: profileId, coordinate },
    checks: [{
      id: 'admitted_profile',
      status: 'INCOMPLETE',
      detail: { failures: [reasonCode], accounting_admission_contract: ACCOUNTING_ADMISSION_CONTRACT, ...(error?.details || {}) }
    }],
    provisioning_saga: {
      saga_id: sagaId,
      idempotency_key: idempotencyKey,
      initiating_principal: null,
      system_executor: { actor_type: 'system', actor_id: 'entityReadinessProvisioner' },
      authority_basis: null,
      writer_receipts: []
    }
  };
  return { ...body, receipt_digest: sha256(JSON.stringify(body)) };
};

export class EntityReadinessRetryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = 'EntityReadinessRetryError';
    this.code = code;
    this.statusCode = 409;
    this.details = details;
  }
}

const retryStateFor = ({ status, attemptCount, observedAt, hostWait = false }) => {
  if (status === 'PASS') return { retryState: 'idle', nextRetryAt: null };
  // RT-09: a host-wait failure schedules no clock and never exhausts. Its
  // runner is the Host A PASS transition, not a timestamp the host cannot
  // honour; listTargetedEntityReadinessRecoveryCandidates accepts the NULL.
  if (hostWait) return { retryState: 'scheduled', nextRetryAt: null };
  if (attemptCount >= ENTITY_READINESS_MAX_ATTEMPTS) return { retryState: 'exhausted', nextRetryAt: null };
  const delay = ENTITY_READINESS_RETRY_DELAYS_MS[Math.max(0, attemptCount - 1)]
    ?? ENTITY_READINESS_RETRY_DELAYS_MS.at(-1);
  return {
    retryState: 'scheduled',
    nextRetryAt: new Date(timestamp(observedAt).millis + delay).toISOString()
  };
};

// Retry-scope law (2026-08-31, the Desert Rose receipts): a bounded retry of a
// never-ready new-client saga re-proves birth from the BIRTH RECEIPT, never from
// live current state. Prior-generation residue is structurally impossible for an
// existing client row (client delete cascades every client_id table), so any
// rows that exist at retry time beyond what the first attempt saw are this
// generation's own receipted operation — judging them as "prior client residue"
// bricked a legitimately-operating book. The anti-laundering property survives:
// a birth whose OWN residue proof failed (or recorded no proof at all) keeps the
// strict scope until that residue is actually cleared. Pure; exported for tests.
export const __retryCompatibilityScope = ({
  enrollmentKind = null,
  everReady = false,
  birthResidueProvenClean = false
} = {}) => (
  enrollmentKind === 'new_client_default' && !everReady && !birthResidueProvenClean
    ? 'birth_residue_proof'
    : 'current_generation_compatibility'
);

// A synthetic `undeclared:<jurisdiction>:<legal form>:<creation path>` profile
// id (syntheticFailedCertificate) records WHY a birth failed; it names no
// declared profile. Retrying BY that id can never succeed, whatever the
// manifest declares later — the first FI entity on the desktop (2026-09-08)
// exhausted three heal attempts and a manual reopen that way after its cell
// had been declared. A retry re-resolves by coordinate and carries the
// birth's creation path forward from the synthetic id. Pure; exported for tests.
export const __isSyntheticProfileId = (profileId) => clean(profileId).startsWith('undeclared:');

export const __priorCreationPath = (profileId) => {
  const value = clean(profileId);
  if (!value) return null;
  const prior = value.startsWith('undeclared:')
    ? clean(value.split(':')[3])
    : clean(value.split('.')[1]?.replaceAll('-', '_'));
  // The hosted profile uses a shortened label for this existing creation lane.
  return prior === 'firm_intake' ? 'desktop_firm_intake' : prior || null;
};

export const provisionEntityReadiness = async ({
  withFirmDbClientFn,
  firmId,
  clientId,
  creationPath,
  profileId = null,
  lifecycle = 'cold_create',
  compatibilityScope = 'birth_residue_proof',
  observedAt = new Date().toISOString(),
  initiatingPrincipal = null,
  authorityBasis = null,
  retry = false,
  reopenExhausted = false,
  rootDir = RUNTIME_ROOT,
  observe = observeEntityCertificateB,
  requiredEnrollmentKind = null
} = {}) => {
  if (typeof withFirmDbClientFn !== 'function') throw new Error('Entity readiness persistence needs withFirmDbClientFn.');
  const at = timestamp(observedAt).iso;
  const sagaIdentity = entityProvisioningSagaIdentity({ firmId, clientId });

  return withFirmDbClientFn(async (client) => {
    await client.query('begin');
    try {
      await client.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`entity-readiness:${firmId}:${clientId}`]);
      const existing = rows(await client.query(
        `select * from entity_readiness_sagas
          where firm_id = $1 and client_id = $2
          for update`,
        [firmId, clientId]
      ))[0] || null;
      const enrollmentRow = rows(await client.query(
        `select flag_key, stage, source, reason, client_id
           from client_capability_config
          where firm_id = $1 and client_id = $2 and flag_key = $3
            and valid_to is null
          order by valid_from desc, id desc
          limit 1
          for share`,
        [firmId, clientId, ENTITY_READINESS_ADMISSION_FLAG]
      ))[0] || null;
      const enrollment = classifyEntityReadinessEnrollment(enrollmentRow);
      if (requiredEnrollmentKind
          && (!enrollment.valid || enrollment.enrollment_kind !== requiredEnrollmentKind)) {
        throw new EntityReadinessRetryError(
          'ENTITY_READINESS_TARGET_NOT_SELECTED',
          'This entity is not selected for the requested readiness recovery lane.',
          { required_enrollment_kind: requiredEnrollmentKind, retryable: false }
        );
      }
      if (requiredEnrollmentKind && resolveRuntimeHostIdentity().runtime_host === CLOUD_RUNTIME_HOST) {
        const pilot = await client.query(`select 1 from client_capability_config
          where firm_id = $1 and client_id = $2 and flag_key = 'INTERNAL_PILOT_ACCESS'
            and stage = 'canary' and source = 'manual' and reason = any($3::text[])
            and valid_to is null for share`, [firmId, clientId, HOSTED_PILOT_VERSIONS]);
        if (!pilot.rows.length) throw new EntityReadinessRetryError('ENTITY_READINESS_TARGET_NOT_SELECTED',
          'This entity is not selected for cloud pilot readiness recovery.', { retryable: false });
      }
      if (retry && !existing) {
        throw new EntityReadinessRetryError(
          'ENTITY_READINESS_NOT_PROVISIONED',
          'This legacy entity has not entered the certified provisioning lane yet.',
          { state: 'legacy_uncertified', retryable: false }
        );
      }
      if (retry && existing?.state === 'ready') {
        await client.query('commit');
        return {
          accepted: false,
          reason: 'already_ready',
          row: existing,
          certificate: null,
          attempt_id: Number(existing.latest_attempt_id)
        };
      }
      // Reopening an exhausted saga is the explicit, receipted operator exit
      // from 'exhausted' (two-terminal-states: the state must never rest on
      // Donna with no route out). It starts a fresh bounded episode; the
      // receipt below names who reopened and what was exhausted.
      const reopening = Boolean(
        retry && reopenExhausted
        && existing?.state === 'failed' && existing?.retry_state === 'exhausted'
      );
      if (retry && existing?.retry_state === 'exhausted' && !reopening) {
        throw new EntityReadinessRetryError(
          'ENTITY_READINESS_RETRY_EXHAUSTED',
          'Donna has reached the bounded retry limit for this setup.',
          { attempt_count: Number(existing.attempt_count), max_attempts: Number(existing.max_attempts), retryable: false }
        );
      }
      if (retry && !reopening && existing?.next_retry_at && timestamp(existing.next_retry_at).millis > timestamp(at).millis) {
        throw new EntityReadinessRetryError(
          'ENTITY_READINESS_RETRY_NOT_DUE',
          'Donna is waiting for the safe retry window.',
          { next_retry_at: new Date(existing.next_retry_at).toISOString(), retryable: true }
        );
      }
      if (!retry && existing?.state === 'failed') {
        // A replay of a create/provision request is not permission to bypass
        // the persisted retry window. The explicit retry route is the sole
        // path that advances a failed saga.
        await client.query('commit');
        return {
          accepted: false,
          reason: 'retry_required',
          row: existing,
          certificate: null,
          attempt_id: Number(existing.latest_attempt_id)
        };
      }

      const clientRow = rows(await client.query(
        `select id, firm_id, jurisdiction, entity_type, profile
           from clients where firm_id = $1 and id = $2`,
        [firmId, clientId]
      ))[0] || null;
      if (!clientRow) {
        const error = new Error('The entity no longer exists.');
        error.code = 'ENTITY_NOT_FOUND';
        error.statusCode = 404;
        throw error;
      }
      const hostIdentity = resolveRuntimeHostIdentity();
      let nativeLineage = null;
      let nativeLineageError = null;
      if (hostIdentity.runtime_host === CLOUD_RUNTIME_HOST) {
        try { nativeLineage = await readNativeChartLineage({ query: client.query.bind(client), firmId, clientId }); }
        catch (error) {
          // Corrupt retained scope is an observed refusal, never a legacy
          // selection. Persist it through the existing failed-certificate owner.
          // SQL failures still propagate to rollback with their original cause.
          if (error.code !== 'NATIVE_CHART_LINEAGE_INVALID') throw error;
          nativeLineageError = error;
        }
      }
      const coordinate = readinessProfileCoordinate({
        client: clientRow,
        hostIdentity,
        nativeLineage,
        creationPath: hostIdentity.runtime_host === CLOUD_RUNTIME_HOST
          && await readConsumedOwnerAdoptionWithClient(client,{firmId,clientId,lock:true})
          ? 'existing_owner_adoption' : creationPath || __priorCreationPath(existing?.admitted_profile_id) || 'generic_client_route'
      });
      const storedHostCertificate = await readCurrentHostCertificateWithClient(client, hostIdentity.host_id);
      const hostCertificate = hostIdentity.runtime_host === CLOUD_RUNTIME_HOST
        && !cloudCertificateIdentityMatches(storedHostCertificate, hostIdentity) ? null : storedHostCertificate;
      // Entity B gathers independent read facets with Promise.all. A pooled
      // `queryFirmDb` function can fan those out; this service deliberately
      // holds one transaction client so the observation and receipt are one
      // consistent point. Serialize calls on that client (pg@9 removes the
      // old implicit concurrent-query queue).
      let observationQueryTail = Promise.resolve();
      const observationQuery = (text, params) => {
        const result = observationQueryTail.then(() => client.query(text, params));
        observationQueryTail = result.then(() => undefined, () => undefined);
        return result;
      };
      let certificate;
      // A failed first birth has never established a ready generation, so a
      // never-ready new-client retry stays on the strict birth proof — but
      // proven from the BIRTH RECEIPT, not from live state (see
      // __retryCompatibilityScope). If the first attempt's own residue proof
      // PASSED, the birth was clean and everything since is this generation's
      // receipted work; re-judging it as prior-client residue bricked Desert
      // Rose (2026-08-31). A birth whose residue proof failed (or recorded no
      // proof) keeps the strict scope until the residue is actually cleared.
      // Manual legacy heals and invalidated formerly-ready generations remain
      // steady-state checks.
      let birthResidueProvenClean = false;
      if (existing && enrollment.enrollment_kind === 'new_client_default' && !existing.ready_dependency_digest) {
        const firstAttempt = rows(await client.query(
          `select metadata#>'{certificate_receipt,checks}' as checks
             from audit_events
            where firm_id = $1 and client_id = $2 and action = 'entity.provisioning.attempt'
            order by id asc
            limit 1`,
          [firmId, clientId]
        ))[0] || null;
        const birthChecks = Array.isArray(firstAttempt?.checks) ? firstAttempt.checks : [];
        birthResidueProvenClean = birthChecks.some(
          (entry) => entry?.id === 'birth_residue_proof' && entry?.status === 'PASS'
        );
      }
      const effectiveCompatibilityScope = existing
        ? __retryCompatibilityScope({
            enrollmentKind: enrollment.enrollment_kind,
            everReady: Boolean(existing.ready_dependency_digest),
            birthResidueProvenClean
          })
        : compatibilityScope;
      const effectiveLifecycle = existing && lifecycle === 'cold_create' ? 'retry' : lifecycle;
      // The bounded attempt budget is per failure EPISODE, not per entity
      // lifetime: reaching 'ready' closes the episode (the upsert below writes
      // attempt_count 0), and reopening an exhausted saga starts a new one.
      // Before 2026-08-31 the budget was cumulative for life, so three routine
      // dependency invalidations permanently exhausted a healthy entity.
      const baseAttemptCount = reopening ? 0 : Number(existing?.attempt_count || 0);
      if (reopening) {
        const reopenActor = initiatingPrincipal || { actor_type: 'system', actor_id: 'readiness_recovery' };
        await client.query(
          `insert into audit_events
             (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
           values ($1, $2, $3, $4, 'entity.readiness.episode_reopened', 'entity_readiness_saga', $5, $6::jsonb)`,
          [
            firmId,
            clientId,
            clean(reopenActor.actor_type) || 'system',
            clean(reopenActor.actor_id) || 'readiness_recovery',
            sagaIdentity.sagaId,
            JSON.stringify({
              contract_version: 'donna.entity-readiness-reopen.v1',
              prior_attempt_count: Number(existing?.attempt_count || 0),
              prior_reason_code: existing?.reason_code || null,
              prior_root_cause_receipt_id: existing?.root_cause_receipt_id == null
                ? null
                : Number(existing.root_cause_receipt_id),
              authority_basis: authorityBasis || { source: 'authenticated_readiness_reopen' }
            })
          ]
        );
      }
      // Only a DECLARED id is retried by id; a synthetic undeclared:* id falls
      // back to the coordinate (see __isSyntheticProfileId).
      // Caller/prior ids preserve only the creation lane; current source identity
      // always chooses the contract. A profile correction cannot retry an old view.
      if (coordinate.creation_path !== 'existing_owner_adoption' && !creationPath && profileId) coordinate.creation_path = __priorCreationPath(profileId) || coordinate.creation_path;
      try {
        if (nativeLineageError) throw nativeLineageError;
        const accountingFailures = accountingProfileFailures(clientRow.profile);
        if (accountingFailures.length) {
          const error = new Error(accountingFailures[0]);
          error.code = accountingFailures[0];
          error.details = { accounting_profile: readAccountingProfile(clientRow.profile), recovery: 'update_client_profile' };
          throw error;
        }
        certificate = await observe({
          query: observationQuery,
          rootDir,
          coordinate,
          firmId,
          clientId,
          hostCertificate,
          lifecycle: effectiveLifecycle,
          compatibilityScope: effectiveCompatibilityScope,
          observedAt: at,
          priorAttempts: Array.from({ length: baseAttemptCount }, (_, index) => ({ attempt_sequence: index + 1 }))
        });
      } catch (error) {
        certificate = syntheticFailedCertificate({ firmId, clientId, coordinate, observedAt: at, error });
      }

      const nonHostFailures = (certificate.checks || []).filter(
        ({ id, status }) => id !== 'host_compatibility' && status !== 'PASS'
      );
      if (existing?.state === 'ready'
          && existing.ready_dependency_digest === certificate.entity_dependency_digest
          && (hostIdentity.runtime_host !== CLOUD_RUNTIME_HOST || existing.host_compatibility_digest === hostCertificate?.compatibility_digest)
          && nonHostFailures.length === 0) {
        // Replaying an idempotent create against an unchanged entity does not
        // mint another attempt. Host health is intentionally independent: a
        // failed/renewed Host A row changes effective readiness without
        // rewriting every ready entity saga.
        await client.query('commit');
        return {
          accepted: false,
          reason: 'unchanged_ready_generation',
          row: existing,
          certificate,
          attempt_id: Number(existing.latest_attempt_id)
        };
      }

      const firstFailure = firstCertificateFailure(certificate);
      const reasonCode = firstFailure?.reason_code || null;
      const responsibleSystem = responsibleSystemFor(reasonCode, firstFailure?.check_id);
      // RT-09 (audit F-06): the budget is charged only for an ENTITY-side
      // verdict. When the first failure is the host compatibility check
      // carrying a host-wait reason, this observation is receipted but
      // exempt — the counter stays where it was and no clock is scheduled
      // (see ENTITY_READINESS_HOST_WAIT_REASON_CODES). Every other failure —
      // the manifest, identity, chart, capabilities, residue, a profile×host
      // incompatibility, a synthetic observer error — still burns one.
      const hostWait = certificate.status !== 'PASS'
        && firstFailure?.check_id === 'host_compatibility'
        && isEntityReadinessHostWaitReason(reasonCode);
      const attemptCount = hostWait ? baseAttemptCount : baseAttemptCount + 1;
      if (attemptCount > ENTITY_READINESS_MAX_ATTEMPTS) {
        throw new EntityReadinessRetryError(
          'ENTITY_READINESS_RETRY_EXHAUSTED',
          'Donna has reached the bounded retry limit for this setup.',
          {
            attempt_count: Number(existing?.attempt_count || 0),
            max_attempts: ENTITY_READINESS_MAX_ATTEMPTS,
            retryable: false
          }
        );
      }
      const certSaga = certificate.provisioning_saga || {};
      const admittedProfileId = certificate.admitted_profile?.profile_id
        || profileId
        || existing?.admitted_profile_id
        || `undeclared:${coordinate.jurisdiction.toLowerCase()}:${coordinate.canonical_legal_form}:${coordinate.creation_path}`;
      const actor = initiatingPrincipal || certSaga.initiating_principal || { actor_type: 'system', actor_id: 'readiness_recovery' };
      const attemptMetadata = {
        contract_version: 'donna.entity-readiness-attempt.v1',
        saga_id: sagaIdentity.sagaId,
        idempotency_key: sagaIdentity.idempotencyKey,
        // The budget position AFTER this receipt. A host-wait receipt does not
        // advance it (budget_charged false), so two consecutive host-wait
        // receipts legitimately carry the same sequence — the immutable
        // receipts keep the full history, the saga carries the budget.
        attempt_sequence: attemptCount,
        budget_charged: !hostWait,
        budget_exemption: hostWait
          ? { kind: 'host_wait', check_id: firstFailure.check_id, reason_code: reasonCode, recovery_route: 'host_certificate_pass_renewal' }
          : null,
        initiating_principal: actor,
        system_executor: { actor_type: 'system', actor_id: 'entityReadinessProvisioner' },
        authority_basis: authorityBasis || certSaga.authority_basis || { source: retry ? 'authenticated_readiness_retry' : 'post_create_observer' },
        lifecycle: effectiveLifecycle,
        compatibility_scope: effectiveCompatibilityScope,
        enrollment_kind: enrollment.valid ? enrollment.enrollment_kind : null,
        admitted_profile_id: admittedProfileId,
        entity_dependency_digest: certificate.entity_dependency_digest || null,
        host_compatibility_digest: hostCertificate?.compatibility_digest || null,
        ...(hostIdentity.runtime_host === CLOUD_RUNTIME_HOST ? { runtime_host_id: hostIdentity.host_id } : {}),
        writer_receipts: certSaga.writer_receipts || [],
        earliest_failure: firstFailure,
        certificate_receipt_digest: certificate.receipt_digest,
        certificate_receipt: certificate
      };
      const audit = rows(await client.query(
        `insert into audit_events
           (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'entity.provisioning.attempt', 'entity_readiness_saga', $5, $6::jsonb)
         returning id, created_at`,
        [
          firmId,
          clientId,
          clean(actor?.actor_type) || 'system',
          clean(actor?.actor_id) || 'readiness_recovery',
          sagaIdentity.sagaId,
          JSON.stringify(attemptMetadata)
        ]
      ))[0];
      const state = certificate.status === 'PASS' ? 'ready' : 'failed';
      const retryProjection = retryStateFor({ status: certificate.status, attemptCount, observedAt: at, hostWait });
      const rootCauseReceiptId = state === 'failed'
        ? (existing?.root_cause_receipt_id || audit.id)
        : null;
      const row = rows(await client.query(
        `insert into entity_readiness_sagas
           (firm_id, client_id, saga_id, idempotency_key, state, admitted_profile_id,
            certificate_version, manifest_version, ready_dependency_digest,
            observed_dependency_digest, host_compatibility_digest, latest_attempt_id,
            root_cause_receipt_id, attempt_count, max_attempts, retry_state,
            reason_code, responsible_system, next_retry_at, ready_at, failed_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19::timestamptz, $20::timestamptz, $21::timestamptz, now())
         on conflict (firm_id, client_id) do update set
           saga_id = excluded.saga_id,
           idempotency_key = excluded.idempotency_key,
           state = excluded.state,
           admitted_profile_id = excluded.admitted_profile_id,
           certificate_version = excluded.certificate_version,
           manifest_version = excluded.manifest_version,
           ready_dependency_digest = excluded.ready_dependency_digest,
           observed_dependency_digest = excluded.observed_dependency_digest,
           host_compatibility_digest = excluded.host_compatibility_digest,
           latest_attempt_id = excluded.latest_attempt_id,
           root_cause_receipt_id = excluded.root_cause_receipt_id,
           attempt_count = excluded.attempt_count,
           max_attempts = excluded.max_attempts,
           retry_state = excluded.retry_state,
           reason_code = excluded.reason_code,
           responsible_system = excluded.responsible_system,
           next_retry_at = excluded.next_retry_at,
           ready_at = excluded.ready_at,
           failed_at = excluded.failed_at,
           updated_at = now()
         returning *`,
        [
          firmId,
          clientId,
          sagaIdentity.sagaId,
          sagaIdentity.idempotencyKey,
          state,
          admittedProfileId,
          certificate.version || ENTITY_CERTIFICATE_B_VERSION,
          certificate.checks?.find(({ id }) => id === 'admitted_profile')?.detail?.manifest_version || 'donna.admitted-entity-profiles.v3',
          state === 'ready' ? certificate.entity_dependency_digest : existing?.ready_dependency_digest || null,
          certificate.entity_dependency_digest || null,
          hostCertificate?.compatibility_digest || null,
          audit.id,
          rootCauseReceiptId,
          // Reaching 'ready' closes the failure episode: the counter rewinds so
          // a later dependency invalidation opens a fresh bounded episode
          // instead of draining a lifetime budget (the 2026-08-31 exhaustion
          // cliff). The immutable attempt receipts keep the full history.
          state === 'ready' ? 0 : attemptCount,
          ENTITY_READINESS_MAX_ATTEMPTS,
          retryProjection.retryState,
          reasonCode,
          responsibleSystem,
          retryProjection.nextRetryAt,
          state === 'ready' ? at : existing?.ready_at || null,
          state === 'failed' ? at : null
        ]
      ))[0];
      await client.query('commit');
      return { accepted: true, row, certificate, attempt_id: Number(audit.id) };
    } catch (error) {
      await client.query('rollback').catch(() => {});
      throw error;
    }
  });
};

// `includeHostWait` (RT-09): a saga resting on a host-wait reason has
// next_retry_at NULL — no clock, because its runner is the Host A PASS
// transition. The renewal-time heal (the PASS transition) selects those; the
// queue-activity prompt heal passes false so it never re-proves an entity
// against a host that has not changed (in queue-recovery mode the scheduler
// runs while Host A is FAIL, and that would be a receipt per settlement).
// Cloud renewal may additionally name its just-persisted PASS compatibility
// digest: only explicitly selected manual pilots whose ready saga belongs to
// an older host generation are reobserved. No digest means no expanded scope.
export const listTargetedEntityReadinessRecoveryCandidates = async ({
  withFirmDbClientFn,
  asOf = new Date().toISOString(),
  limit = TARGETED_ENTITY_READINESS_HEAL_LIMIT,
  includeHostWait = true,
  renewedCloudHostCompatibilityDigest = null
} = {}) => {
  if (typeof withFirmDbClientFn !== 'function') {
    throw new Error('Targeted entity readiness recovery needs withFirmDbClientFn.');
  }
  const at = timestamp(asOf).iso;
  const cloud = resolveRuntimeHostIdentity().runtime_host === CLOUD_RUNTIME_HOST;
  const boundedLimit = Math.max(1, Math.min(TARGETED_ENTITY_READINESS_HEAL_LIMIT, Number(limit) || 1));
  return withFirmDbClientFn(async (client) => rows(await client.query(
    `select cfg.firm_id, cfg.client_id, cfg.source, cfg.reason,
            saga.saga_id, saga.state as saga_state, saga.retry_state,
            saga.next_retry_at, saga.attempt_count, saga.max_attempts,
            saga.admitted_profile_id
       from client_capability_config cfg
       join clients entity
         on entity.firm_id = cfg.firm_id and entity.id = cfg.client_id
       left join entity_readiness_sagas saga
         on saga.firm_id = cfg.firm_id and saga.client_id = cfg.client_id
      where cfg.flag_key = $1
        and cfg.client_id is not null
        and cfg.valid_to is null
        and cfg.stage = 'canary'
        and (not $7::boolean or (cfg.source = 'manual' and exists (
          select 1 from client_capability_config pilot
           where pilot.firm_id = cfg.firm_id and pilot.client_id = cfg.client_id
             and pilot.flag_key = 'INTERNAL_PILOT_ACCESS' and pilot.stage = 'canary'
             and pilot.source = 'manual' and pilot.reason = any($9::text[]) and pilot.valid_to is null
        )))
        and (
          (
            cfg.source = 'manual'
            and nullif(btrim(cfg.reason), '') is not null
            and (
              saga.client_id is null
              or ($7::boolean and $8::text is not null and saga.state = 'ready'
                  and saga.host_compatibility_digest is distinct from $8::text)
              or (
                saga.state = 'failed'
                and saga.retry_state = 'scheduled'
                and saga.attempt_count < saga.max_attempts
                and (($6::boolean and saga.next_retry_at is null) or saga.next_retry_at <= $2::timestamptz)
              )
            )
          )
          or (
            cfg.source = $4
            and cfg.reason = $5
            and saga.client_id is not null
            and saga.state = 'failed'
            and saga.retry_state = 'scheduled'
            and saga.attempt_count < saga.max_attempts
            and (($6::boolean and saga.next_retry_at is null) or saga.next_retry_at <= $2::timestamptz)
          )
        )
      order by cfg.valid_from, cfg.id
      limit $3`,
    [
      ENTITY_READINESS_ADMISSION_FLAG,
      at,
      boundedLimit,
      ENTITY_READINESS_NEW_CLIENT_SOURCE,
      ENTITY_READINESS_NEW_CLIENT_REASON,
      Boolean(includeHostWait),
      cloud,
      renewedCloudHostCompatibilityDigest,
      HOSTED_PILOT_VERSIONS
    ]
  )));
};

// Boot/renewal recovery has two exact, bounded populations: explicitly selected
// manual legacy canaries (including absent sagas), and genuinely new clients
// carrying the source-controlled default whose existing saga failed and is due.
// An arbitrary default or a default row without a failed saga is never admitted.
// provisionEntityReadiness re-checks the enrollment kind under the entity lock.
export const healTargetedEntityReadiness = async ({
  withFirmDbClientFn,
  observedAt = new Date().toISOString(),
  rootDir = RUNTIME_ROOT,
  logger = console,
  limit = TARGETED_ENTITY_READINESS_HEAL_LIMIT,
  includeHostWait = true,
  renewedCloudHostCompatibilityDigest = null
} = {}) => {
  const at = timestamp(observedAt).iso;
  const candidates = await listTargetedEntityReadinessRecoveryCandidates({
    withFirmDbClientFn,
    asOf: at,
    limit,
    includeHostWait,
    renewedCloudHostCompatibilityDigest
  });
  const results = [];
  for (const candidate of candidates) {
    try {
// A ready generation is reobserved, not a retry of a failed episode.
      // The named writer locks/revalidates selection and the full certificate.
      const revalidateReadyGeneration = candidate.saga_state === 'ready';
      const retry = Boolean(candidate.saga_id) && !revalidateReadyGeneration;
      const enrollment = classifyEntityReadinessEnrollment({
        stage: 'canary',
        source: candidate.source,
        reason: candidate.reason
      });
      if (!enrollment.valid) continue;
      const newClientRetry = enrollment.enrollment_kind === 'new_client_default';
      const result = await provisionEntityReadiness({
        withFirmDbClientFn,
        firmId: candidate.firm_id,
        clientId: candidate.client_id,
        // A declared id retries by id; a synthetic undeclared:* id lets the
        // provisioner re-resolve by coordinate from the birth's creation path.
        ...(candidate.admitted_profile_id
          ? (__isSyntheticProfileId(candidate.admitted_profile_id)
              ? {}
              : { profileId: candidate.admitted_profile_id })
          : { creationPath: resolveRuntimeHostIdentity().runtime_host === CLOUD_RUNTIME_HOST ? 'self_provision' : 'legacy_heal' }),
        lifecycle: revalidateReadyGeneration ? 'host_generation_revalidation' : retry ? 'boot_heal_retry' : 'legacy_upgrade',
        compatibilityScope: newClientRetry ? 'birth_residue_proof' : 'current_generation_compatibility',
        observedAt: at,
        retry,
        rootDir,
        requiredEnrollmentKind: enrollment.enrollment_kind,
        authorityBasis: {
          source: revalidateReadyGeneration
            ? 'cloud_host_generation_readiness_heal'
            : newClientRetry
            ? 'failed_new_client_readiness_boot_heal'
            : 'targeted_legacy_readiness_boot_heal',
          selection_reason: candidate.reason
        }
      });
      results.push({
        firm_id: candidate.firm_id,
        client_id: candidate.client_id,
        status: result.row?.state || result.certificate?.status || 'unknown',
        accepted: result.accepted,
        attempt_id: result.attempt_id,
        saga_id: result.row?.saga_id || candidate.saga_id || null
      });
    } catch (error) {
      results.push({
        firm_id: candidate.firm_id,
        client_id: candidate.client_id,
        status: 'error',
        error_code: error?.code || 'ENTITY_READINESS_TARGETED_HEAL_FAILED'
      });
      logger.error?.(
        `[runtime-server] targeted entity readiness heal failed for ${candidate.client_id}:`,
        error?.message || error
      );
    }
  }
  if (candidates.length) {
    const ready = results.filter(({ status }) => status === 'ready').length;
    logger.log?.(
      `[runtime-server] targeted entity readiness heal: ${ready}/${candidates.length} ready; ${results.length - ready} retained for visible recovery`
    );
  }
  return { selected: candidates.length, results };
};

// A due entity retry must not wait for the 5-minute Host A renewal. The
// migration-127 fence invalidates a client's saga whenever a load-bearing
// dependency changes — INCLUDING when the runtime's own admitted posting
// mints a chart account mid-sweep (ledger.account.created_at_posting →
// ledger_accounts insert → the trigger). The invalidation schedules an
// immediate retry (next_retry_at = now()), but the only retry runner was the
// renewal-time heal, so the rest of that sweep pass — and every pass landing
// between renewals — was admission-refused for up to five minutes per new
// account (the Desert Rose flap, 2026-09-01: 461 readiness_admission_blocked
// receipts, asks and postings starved while every job row showed green).
// This hook runs the SAME bounded heal (populations, receipts, attempt
// budgets, enrollment gates all unchanged) off scheduler queue activity:
// jobs settle at least once a minute on the appliance, so a self-inflicted
// invalidation heals before the next pass instead of two renewals later.
// Serialized, floored, and cheap: one existence probe gates the heal — no
// due saga means one SELECT and out.
//
// RT-09: "due" means a CLOCK is due. A saga waiting for the runtime host
// (next_retry_at NULL, a host-wait reason) is not this hook's business — its
// runner is the Host A PASS transition in runtimeServer.js — so the probe
// and the heal it triggers both exclude it (includeHostWait false). Without
// that, queue-recovery mode (scheduler running, Host A FAIL) would re-prove
// every host-waiting entity against the same failed host once per
// settlement, one receipt each, for nothing.
const PROMPT_ENTITY_HEAL_MIN_INTERVAL_MS = 15_000;

export const makePromptDueEntityHeal = ({
  withFirmDbClientFn,
  healFn = healTargetedEntityReadiness,
  rootDir = RUNTIME_ROOT,
  logger = console,
  minIntervalMs = PROMPT_ENTITY_HEAL_MIN_INTERVAL_MS,
  now = () => new Date()
} = {}) => {
  if (typeof withFirmDbClientFn !== 'function') {
    throw new Error('makePromptDueEntityHeal needs withFirmDbClientFn.');
  }
  let inFlight = null;
  let lastHealStartedAt = 0;
  return async (activity) => {
    if (activity?.kind !== 'job_settled') return null;
    if (inFlight) return inFlight; // coalesce — the running heal re-selects due sagas
    const at = now();
    if (at.getTime() - lastHealStartedAt < minIntervalMs) return null;
    lastHealStartedAt = at.getTime();
    inFlight = (async () => {
      try {
        const due = await withFirmDbClientFn(async (client) => rows(await client.query(
          `select 1 from entity_readiness_sagas
            where state = 'failed' and retry_state = 'scheduled'
              and attempt_count < max_attempts
              and next_retry_at is not null and next_retry_at <= now()
            limit 1`
        )));
        if (!due.length) return null;
        return await healFn({ withFirmDbClientFn, observedAt: at.toISOString(), rootDir, logger, includeHostWait: false });
      } catch (error) {
        logger.error?.('[runtime-server] prompt due-entity heal failed:', error?.message || error);
        return null;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };
};

// v7 (2026-09-23, "fix deployment readiness"): the cloud branch no longer asks
// whether the required workers ran or both providers answered on this
// deployment. Dropping that historical-liveness predicate LOOSENS admission,
// deliberately: it is the wrong admission condition and deadlocked every
// deploy (see cloudDependencyEvidence.js). Attested source, identity, digests, freshness
// and every configuration check stay hard gates; the execution and response
// proofs are receipts inside the PASS checks.
export const hostReadinessIsMutationReady = ({ certificate, asOf = new Date().toISOString(), hostIdentity = resolveRuntimeHostIdentity(), env = process.env } = {}) =>
  certificate?.version === HOST_CERTIFICATE_A_VERSION
  && certificate?.status === 'PASS'
  && (hostIdentity.runtime_host === CLOUD_RUNTIME_HOST
    ? cloudCertificateIdentityMatches(certificate, hostIdentity)
      && verifyCloudDeploymentAttestation({ artifact: certificate.checks?.find(c=>c.id==='source_build')?.detail?.attestation, identity: hostIdentity, env, observedAt: asOf }).status === 'PASS'
      && Array.isArray(certificate.checks) && certificate.checks.length === 10
      && new Set(certificate.checks.map(check => check.id)).size === 10
      && certificate.checks.every(check => check.status === 'PASS')
      && HOST_QUEUE_RECOVERY_CHECK_IDS.every(id => certificate.checks.some(check => check.id === id))
      && certificate.checks.some(check => check.id === 'provider_capability'
        && hostDigest(check.detail?.required_provider_classes || []) === hostDigest(['openai', 'anthropic']))
      && certificate.compatibility_digest === hostCompatibilityDigest({ runtimeHost: CLOUD_RUNTIME_HOST, checks: certificate.checks })
      && certificate.receipt_digest === hostDigest(Object.fromEntries(Object.entries(certificate).filter(([key]) => key !== 'receipt_digest')))
    : certificate?.runtime_host === HOST_CERTIFICATE_RUNTIME)
  && evaluateHostCertificateFreshness({ certificate, asOf }).status === 'fresh';

const HOST_QUEUE_RECOVERY_PASS_CHECKS = Object.freeze([
  'source_build',
  'scheduler_worker_manifest',
  'evidence_storage',
  'model_routes',
  'policy_oracle_artifacts',
  'config_control_plane',
  'accounting_adapter',
  'spend_meter'
]);
const HOST_QUEUE_RECOVERY_CHECK_IDS = Object.freeze([
  'database_schema',
  ...HOST_QUEUE_RECOVERY_PASS_CHECKS
]);

// Queue health is the one Host A failure whose repairer is the scheduler
// itself. Keep mutation admission fail-closed, but do not stop the component
// that releases expired leases and lets a later cron sweep supersede failed
// periodic work. Every structural host check must still PASS, and the database
// detail must prove that schema, migrations, tables and clock are healthy.
export const hostReadinessAllowsSchedulerRecovery = ({
  certificate,
  asOf = new Date().toISOString()
} = {}) => {
  if (certificate?.version !== HOST_CERTIFICATE_A_VERSION
      || certificate?.status !== 'FAIL'
      || certificate?.runtime_host !== HOST_CERTIFICATE_RUNTIME
      || evaluateHostCertificateFreshness({ certificate, asOf }).status !== 'fresh') {
    return false;
  }
  const checks = Array.isArray(certificate.checks) ? certificate.checks : [];
  const byId = new Map(checks.map((entry) => [entry?.id, entry]));
  if (checks.length !== HOST_QUEUE_RECOVERY_CHECK_IDS.length
      || checks.length !== byId.size
      || HOST_QUEUE_RECOVERY_CHECK_IDS.some((id) => !byId.has(id))
      || HOST_QUEUE_RECOVERY_PASS_CHECKS.some((id) => byId.get(id)?.status !== 'PASS')) {
    return false;
  }
  const database = byId.get('database_schema');
  const detail = database?.detail || {};
  const queue = detail.queue || {};
  const queueNeedsRecovery = Number(queue.expired_running || 0) > 0
    || Number(queue.dead_unsuperseded || 0) > 0;
  return database?.status === 'FAIL'
    && queueNeedsRecovery
    && Number(detail.server_major) === 16
    && Array.isArray(detail.missing_migrations) && detail.missing_migrations.length === 0
    && Array.isArray(detail.unexpected_migrations) && detail.unexpected_migrations.length === 0
    && Array.isArray(detail.missing_tables) && detail.missing_tables.length === 0
    && detail.clock_skew_ms != null
    && Number.isFinite(Number(detail.clock_skew_ms))
    && Number(detail.clock_skew_ms) <= 30_000;
};

export const startHostReadinessRenewal = async ({
  mint,
  onObservation = async () => {},
  logger = console,
  renewalIntervalMs = HOST_CERTIFICATE_RENEWAL_INTERVAL_MS,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout
} = {}) => {
  if (typeof mint !== 'function') throw new Error('Host readiness renewal needs a mint function.');
  let stopped = false;
  let timer = null;
  let attempt = 0;
  let inFlight = null;
  let queuedEventType = null;
  const scheduleNext = () => {
    if (stopped) return;
    if (timer != null) clearTimeoutFn(timer);
    timer = setTimeoutFn(() => void run('renewal'), renewalIntervalMs);
  };
  const observe = async (eventType) => {
    attempt += 1;
    let observation;
    try {
      observation = await mint({ eventType });
    } catch (error) {
      observation = { status: 'INCOMPLETE', error, certificate: null, attempt_count: attempt };
      logger.error?.('[runtime-server] Host A observation/persistence failed:', error?.message || error);
    }
    try {
      await onObservation(observation);
    } catch (error) {
      logger.error?.('[runtime-server] Host A scheduler transition failed:', error?.message || error);
    }
    return observation;
  };
  const run = (eventType) => {
    if (stopped) return Promise.resolve(null);
    if (inFlight) {
      queuedEventType = eventType;
      return inFlight;
    }
    if (timer != null) {
      clearTimeoutFn(timer);
      timer = null;
    }
    inFlight = (async () => {
      let nextEventType = eventType;
      let observation = null;
      do {
        queuedEventType = null;
        observation = await observe(nextEventType);
        nextEventType = queuedEventType;
      } while (nextEventType && !stopped);
      return observation;
    })().finally(() => {
      inFlight = null;
      scheduleNext();
    });
    return inFlight;
  };
  const initial = await run('boot');
  return {
    initial,
    renewNow: () => run('retry'),
    stop: () => {
      stopped = true;
      if (timer != null) clearTimeoutFn(timer);
    }
  };
};
