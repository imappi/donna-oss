// Customer-safe Gate 1B.1 read projection. The database rows and immutable
// receipts retain technical detail; routine firm snapshots expose only closed
// reason codes, responsible subsystem, receipt refs and bounded retry timing.

import { SG_HOSTED_PROFILE_ID, SG_NATIVE_PROFILE_ID } from './cloudPilotConfig.js';
import { accountingProfileRecovery } from '../../src/lib/accountingProfile.js';
import { isEntityReadinessHostWaitReason } from './runtimeReadiness.js';

export const RUNTIME_READINESS_PROJECTION_VERSION = 'donna.runtime-readiness-projection.v1';

const millis = (value) => {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const iso = (value) => {
  const parsed = millis(value);
  return parsed == null ? null : new Date(parsed).toISOString();
};

const COPY = Object.freeze({
  ready: {
    label: 'Readiness observed',
    detail: 'Donna verified this entity against the current desktop setup.'
  },
  failed: {
    label: 'Setup needs attention',
    detail: 'Donna could not complete the readiness check. The reason and retry state are recorded.'
  },
  legacy_uncertified: {
    label: 'Not certified yet',
    detail: 'This entity predates persisted readiness. Its existing reads and records remain available.'
  },
  host_unavailable: {
    label: 'Runtime needs attention',
    detail: 'The entity check passed, but the current desktop runtime is not ready for new automated work.'
  },
  // RT-09: the entity's last check failed only because the runtime host was
  // not ready. Nothing about the entity is known to be wrong; no retry budget
  // was used; Donna re-checks automatically when the host passes.
  host_wait: {
    label: 'Waiting for the runtime host',
    detail: 'The entity check is paused until the desktop runtime passes its own readiness check. Donna retries automatically when it does; this wait uses no retry budget.'
  }
});

export const projectHostReadiness = (row, { asOf = new Date().toISOString(), runtimeHost = 'desktop' } = {}) => {
  if (!row) {
    return {
      projection_version: RUNTIME_READINESS_PROJECTION_VERSION,
      ...(runtimeHost === 'vercel' ? { runtime_host: runtimeHost } : {}),
      state: 'missing',
      mutation_ready: false,
      reason_code: 'host_readiness_missing',
      responsible_system: 'donna_runtime',
      retryable: true,
      checked_at: null,
      valid_until: null,
      receipt_ref: null
    };
  }
  const asOfMs = millis(asOf);
  const mintedAt = millis(row.minted_at);
  const validUntil = millis(row.valid_until);
  const notYetValid = asOfMs == null || mintedAt == null || asOfMs < mintedAt;
  const expired = asOfMs == null || validUntil == null || asOfMs >= validUntil;
  const mutationReady = row.status === 'PASS' && !notYetValid && !expired;
  const freshnessState = notYetValid
    ? { state: 'not_yet_valid', reasonCode: 'host_certificate_not_yet_valid' }
    : expired
      ? { state: 'expired', reasonCode: 'host_certificate_expired' }
      : { state: String(row.status || '').toLowerCase(), reasonCode: row.reason_code || null };
  return {
    projection_version: RUNTIME_READINESS_PROJECTION_VERSION,
    ...(runtimeHost === 'vercel' ? { runtime_host: runtimeHost } : {}),
    state: freshnessState.state,
    mutation_ready: mutationReady,
    reason_code: freshnessState.reasonCode,
    responsible_system: row.responsible_system || 'donna_runtime',
    retryable: !mutationReady,
    checked_at: iso(row.checked_at),
    renew_after: iso(row.renew_after),
    valid_until: iso(row.valid_until),
    compatibility_digest: row.compatibility_digest || null,
    receipt_ref: row.latest_attempt_id == null ? null : {
      store: 'runtime_host_readiness_attempts',
      id: Number(row.latest_attempt_id)
    }
  };
};

export const projectEntityReadiness = (row, {
  hostReadiness = null,
  asOf = new Date().toISOString()
} = {}) => {
  if (!row) {
    return {
      projection_version: RUNTIME_READINESS_PROJECTION_VERSION,
      state: 'legacy_uncertified',
      effective_state: 'legacy_uncertified',
      mutation_ready: false,
      ...COPY.legacy_uncertified,
      reason_code: 'legacy_uncertified',
      responsible_system: 'donna_readiness',
      attempt_count: 0,
      max_attempts: 0,
      retry_state: 'idle',
      retryable: false,
      can_retry_now: false,
      can_reopen: false,
      waiting_for_host: false,
      next_retry_at: null,
      receipt_ref: null,
      root_cause_receipt_ref: null,
      updated_at: null
    };
  }
  const host = hostReadiness || projectHostReadiness(null, { asOf });
  const entityReady = row.state === 'ready';
  const retryable = row.state === 'failed' && row.retry_state === 'scheduled';
  // RT-09: a failed saga whose recorded reason is a host-wait code is
  // waiting on the runtime host, not on an operator — the Host A PASS
  // transition heals it, so the card names the host and offers no Retry.
  // Keyed on the reason alone (not on next_retry_at) so a row the OLD rule
  // charged and clocked still reads as the host wait it is.
  const waitingForHost = retryable && isEntityReadinessHostWaitReason(row.reason_code);
  const effectiveState = entityReady && !host.mutation_ready
    ? 'host_unavailable'
    : waitingForHost ? 'host_wait' : row.state;
  const copy = (!entityReady && accountingProfileRecovery(row.reason_code)) || COPY[effectiveState] || COPY.failed;
  const nextRetryAt = iso(row.next_retry_at);
  const retryDue = nextRetryAt == null || (millis(asOf) ?? 0) >= millis(nextRetryAt);
  return {
    projection_version: RUNTIME_READINESS_PROJECTION_VERSION,
    state: row.state,
    effective_state: effectiveState,
    mutation_ready: entityReady && host.mutation_ready,
    ...copy,
    ...(host.runtime_host === 'vercel' ? { detail: copy.detail.replaceAll('desktop', 'hosted') } : {}),
    ...([SG_HOSTED_PROFILE_ID, SG_NATIVE_PROFILE_ID].includes(row.admitted_profile_id) ? {
      processing_scope: 'document_processing_review_only', accounting_ready: false,
      ...(effectiveState === 'ready' ? { label: 'Document processing ready',
        detail: 'Document extraction and review only. Automatic posting is off; this does not certify accounting, GST or filing readiness.' } : {})
    } : {}),
    reason_code: effectiveState === 'host_unavailable'
      ? (host.reason_code || 'host_readiness_not_ready')
      : (row.reason_code || null),
    responsible_system: effectiveState === 'host_unavailable'
      ? host.responsible_system
      : (row.responsible_system || (waitingForHost ? 'donna_runtime' : 'donna_readiness')),
    admitted_profile_id: row.admitted_profile_id || null,
    saga_id: row.saga_id || null,
    attempt_count: Number(row.attempt_count || 0),
    max_attempts: Number(row.max_attempts || 0),
    retry_state: row.retry_state || 'idle',
    retryable,
    // A host wait has no operator action: the Retry it would offer is the
    // click that burnt budgets before RT-09, and the heal runs on its own.
    can_retry_now: retryable && retryDue && !waitingForHost,
    waiting_for_host: waitingForHost,
    // 'exhausted' is never a resting state: the explicit reopen action
    // (readiness/retry with reopen_exhausted) starts a fresh bounded episode.
    can_reopen: row.state === 'failed' && row.retry_state === 'exhausted',
    next_retry_at: nextRetryAt,
    receipt_ref: row.latest_attempt_id == null ? null : {
      store: 'audit_events',
      id: Number(row.latest_attempt_id)
    },
    root_cause_receipt_ref: row.root_cause_receipt_id == null ? null : {
      store: 'audit_events',
      id: Number(row.root_cause_receipt_id)
    },
    updated_at: iso(row.updated_at)
  };
};
