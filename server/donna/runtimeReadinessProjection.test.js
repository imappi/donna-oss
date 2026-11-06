import assert from 'node:assert/strict';
import test from 'node:test';

import { projectEntityReadiness, projectHostReadiness } from './runtimeReadinessProjection.js';

const NOW = '2026-08-30T10:00:00.000Z';

test('an absent entity row is visibly legacy_uncertified without inventing a retry', () => {
  const projection = projectEntityReadiness(null, { asOf: NOW });
  assert.equal(projection.state, 'legacy_uncertified');
  assert.equal(projection.mutation_ready, false);
  assert.equal(projection.retryable, false);
  assert.equal(projection.receipt_ref, null);
  assert.match(projection.detail, /predates persisted readiness/i);
});

test('a ready entity is effective only while the separate Host A row is PASS and fresh', () => {
  const hostRow = {
    status: 'PASS',
    minted_at: NOW,
    checked_at: NOW,
    renew_after: '2026-08-30T10:05:00.000Z',
    valid_until: '2026-08-30T10:15:00.000Z',
    latest_attempt_id: '41',
    responsible_system: 'donna_runtime'
  };
  const host = projectHostReadiness(hostRow, { asOf: NOW });
  const row = {
    state: 'ready',
    admitted_profile_id: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2',
    saga_id: 'entity-saga-1',
    attempt_count: 1,
    max_attempts: 3,
    retry_state: 'idle',
    latest_attempt_id: '42',
    updated_at: NOW
  };
  assert.equal(projectEntityReadiness(row, { hostReadiness: host, asOf: NOW }).mutation_ready, true);

  const expired = projectHostReadiness({ ...hostRow, valid_until: NOW }, { asOf: NOW });
  const blocked = projectEntityReadiness(row, { hostReadiness: expired, asOf: NOW });
  assert.equal(blocked.state, 'ready', 'host health never rewrites the stable entity state');
  assert.equal(blocked.effective_state, 'host_unavailable');
  assert.equal(blocked.reason_code, 'host_certificate_expired');
  assert.equal(blocked.mutation_ready, false);
});

test('a PASS Host A receipt is not effective before its minted boundary', () => {
  const projection = projectHostReadiness({
    status: 'PASS',
    minted_at: '2026-08-30T10:01:00.000Z',
    checked_at: '2026-08-30T10:01:00.000Z',
    renew_after: '2026-08-30T10:06:00.000Z',
    valid_until: '2026-08-30T10:16:00.000Z',
    latest_attempt_id: '43'
  }, { asOf: NOW });

  assert.equal(projection.state, 'not_yet_valid');
  assert.equal(projection.reason_code, 'host_certificate_not_yet_valid');
  assert.equal(projection.mutation_ready, false);
});

test('failed projection exposes bounded safe retry and closed receipt refs, not certificate internals', () => {
  // An ENTITY-side reason: a host-wait reason projects no Retry since RT-09
  // (the host transition is its runner) — see the RT-09 test below.
  const projection = projectEntityReadiness({
    state: 'failed',
    reason_code: 'required_capability_missing:CODING_AUTO_POST',
    responsible_system: 'donna_configuration',
    admitted_profile_id: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2',
    saga_id: 'entity-saga-1',
    attempt_count: 2,
    max_attempts: 3,
    retry_state: 'scheduled',
    next_retry_at: '2026-08-30T09:59:00.000Z',
    latest_attempt_id: '51',
    root_cause_receipt_id: '50',
    updated_at: NOW
  }, { asOf: NOW });
  assert.equal(projection.can_retry_now, true);
  assert.deepEqual(projection.receipt_ref, { store: 'audit_events', id: 51 });
  assert.deepEqual(projection.root_cause_receipt_ref, { store: 'audit_events', id: 50 });
  assert.equal('certificate_receipt' in projection, false);
  assert.equal('metadata' in projection, false);
});

test('an exhausted saga projects the explicit reopen action — never a dead pill', async () => {
  const { projectEntityReadiness } = await import('./runtimeReadinessProjection.js');
  const NOW = '2026-08-31T20:00:00.000Z';
  const base = {
    state: 'failed',
    reason_code: 'entity_dependency_changed',
    responsible_system: 'donna_readiness',
    admitted_profile_id: 'profile-x',
    saga_id: 'entity-saga-x',
    attempt_count: 3,
    max_attempts: 3,
    retry_state: 'exhausted',
    next_retry_at: null,
    latest_attempt_id: '9',
    root_cause_receipt_id: '8',
    updated_at: NOW
  };
  const exhausted = projectEntityReadiness(base, { asOf: NOW });
  assert.equal(exhausted.can_retry_now, false);
  assert.equal(exhausted.can_reopen, true);
  const scheduled = projectEntityReadiness(
    { ...base, retry_state: 'scheduled', next_retry_at: NOW },
    { asOf: NOW }
  );
  assert.equal(scheduled.can_retry_now, true);
  assert.equal(scheduled.can_reopen, false);
  const missing = projectEntityReadiness(null, { asOf: NOW });
  assert.equal(missing.can_reopen, false);
});

test('RT-09: a saga waiting for the runtime host names the host, offers no Retry, and reads as a wait even under a legacy clock', async () => {
  const { projectEntityReadiness } = await import('./runtimeReadinessProjection.js');
  const NOW = '2026-09-02T09:00:00.000Z';
  const base = {
    state: 'failed',
    reason_code: 'host_certificate_not_pass',
    responsible_system: 'donna_runtime',
    admitted_profile_id: 'gb-ltd.desktop-firm-intake.desktop.none.management-books.v2',
    saga_id: 'entity-saga-host-wait',
    attempt_count: 0,
    max_attempts: 3,
    retry_state: 'scheduled',
    next_retry_at: null,
    latest_attempt_id: '71',
    root_cause_receipt_id: '70',
    updated_at: NOW
  };
  const waiting = projectEntityReadiness(base, { asOf: NOW });
  assert.equal(waiting.waiting_for_host, true);
  assert.equal(waiting.effective_state, 'host_wait');
  assert.equal(waiting.label, 'Waiting for the runtime host');
  assert.match(waiting.detail, /uses no retry budget/i);
  assert.equal(waiting.reason_code, 'host_certificate_not_pass');
  assert.equal(waiting.responsible_system, 'donna_runtime');
  assert.equal(waiting.retryable, true, 'the persisted retry contract is unchanged');
  assert.equal(waiting.can_retry_now, false, 'the card offers no click — the Host A PASS transition is the runner');
  assert.equal(waiting.can_reopen, false);
  assert.equal(waiting.next_retry_at, null);
  assert.equal(waiting.attempt_count, 0);

  // Every host-wait reason projects the same way, not just the common one.
  for (const reasonCode of ['host_certificate_missing', 'host_certificate_expired', 'host_database_schema_not_pass', 'host_compatibility_digest_mismatch']) {
    const projection = projectEntityReadiness({ ...base, reason_code: reasonCode }, { asOf: NOW });
    assert.equal(projection.waiting_for_host, true, reasonCode);
    assert.equal(projection.can_retry_now, false, reasonCode);
  }

  // A row the OLD rule charged and clocked (attempt 2, a due clock) is still
  // the host wait it always was: keyed on the reason, not on the clock.
  const legacy = projectEntityReadiness(
    { ...base, attempt_count: 2, next_retry_at: '2026-09-02T08:59:00.000Z' },
    { asOf: NOW }
  );
  assert.equal(legacy.waiting_for_host, true);
  assert.equal(legacy.can_retry_now, false);
  assert.equal(legacy.effective_state, 'host_wait');

  // An ENTITY-side failure keeps the operator Retry and the attention copy.
  const entitySide = projectEntityReadiness(
    { ...base, reason_code: 'entity_dependency_changed', responsible_system: 'donna_readiness', next_retry_at: NOW },
    { asOf: NOW }
  );
  assert.equal(entitySide.waiting_for_host, false);
  assert.equal(entitySide.effective_state, 'failed');
  assert.equal(entitySide.label, 'Setup needs attention');
  assert.equal(entitySide.can_retry_now, true);

  // A profile×host INCOMPATIBILITY is not a wait: the entity's declaration is
  // the thing to fix, and the Retry stays.
  const incompatible = projectEntityReadiness(
    { ...base, reason_code: 'runtime_host_mismatch', next_retry_at: NOW },
    { asOf: NOW }
  );
  assert.equal(incompatible.waiting_for_host, false);
  assert.equal(incompatible.can_retry_now, true);

  // Ready and legacy rows never wait.
  assert.equal(projectEntityReadiness({ ...base, state: 'ready', retry_state: 'idle' }, { asOf: NOW }).waiting_for_host, false);
  assert.equal(projectEntityReadiness(null, { asOf: NOW }).waiting_for_host, false);
  // An exhausted legacy host row keeps its explicit reopen exit (migration 133
  // restores such rows to the clockless wait; a row it missed is still not a dead pill).
  const exhaustedLegacy = projectEntityReadiness({ ...base, attempt_count: 3, retry_state: 'exhausted' }, { asOf: NOW });
  assert.equal(exhaustedLegacy.waiting_for_host, false);
  assert.equal(exhaustedLegacy.can_reopen, true);
});

test('SG technical readiness describes document review without claiming accounting completion', () => {
  const row = { state: 'ready', admitted_profile_id: 'sg-pte.firm-intake.vercel.none.management-books.sg-cloud-review-v1', retry_state: 'idle' };
  const ready = projectEntityReadiness(row, { hostReadiness: { runtime_host: 'vercel', mutation_ready: true } });
  assert.equal(ready.label, 'Document processing ready');
  assert.equal(ready.accounting_ready, false);
  assert.match(ready.detail, /Automatic posting is off/);
  const paused = projectEntityReadiness(row, { hostReadiness: { runtime_host: 'vercel', mutation_ready: false, reason_code: 'host_certificate_expired' } });
  assert.equal(paused.reason_code, 'host_certificate_expired');
  assert.equal(paused.mutation_ready, false);
  assert.equal(paused.accounting_ready, false);
  assert.equal(paused.label, 'Runtime needs attention');
});
