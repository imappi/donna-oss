import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ENTITY_READINESS_MAX_ATTEMPTS,
  buildHostOperationalFailureCertificate,
  hostReadinessAllowsSchedulerRecovery,
  hostReadinessIsMutationReady,
  readinessProfileCoordinate,
  startHostReadinessRenewal
} from './runtimeReadiness.js';
import { HOST_CERTIFICATE_A_VERSION, buildHostCertificateFreshness } from './hostCertificateA.js';
import { hostDigest } from './hostCertificateA.js';

test('readiness profile coordinate is exact and defaults only the declared accounting axes', () => {
  assert.deepEqual(readinessProfileCoordinate({
    client: {
      jurisdiction: 'gb',
      entity_type: 'gb-ltd',
      profile: { accounting_system: 'none' }
    },
    creationPath: 'desktop_firm_intake'
  }), {
    jurisdiction: 'GB',
    canonical_legal_form: 'gb-ltd',
    creation_path: 'desktop_firm_intake',
    runtime_host: 'desktop',
    accounting_adapter: 'none',
    accounting_view: 'management_books',
    capability_manifest_version: 'desktop-runtime.v2'
  });
  assert.equal(ENTITY_READINESS_MAX_ATTEMPTS, 3);
});

test('host mutation readiness requires PASS plus the exclusive freshness window', () => {
  const mintedAt = '2026-08-30T10:00:00.000Z';
  const certificate = {
    version: HOST_CERTIFICATE_A_VERSION,
    status: 'PASS',
    runtime_host: 'desktop',
    freshness: buildHostCertificateFreshness({ mintedAt })
  };
  assert.equal(hostReadinessIsMutationReady({ certificate, asOf: mintedAt }), true);
  assert.equal(hostReadinessIsMutationReady({ certificate, asOf: certificate.freshness.valid_until }), false);
  assert.equal(hostReadinessIsMutationReady({ certificate: { ...certificate, status: 'FAIL' }, asOf: mintedAt }), false);
});

test('only a fresh queue-only Host A failure keeps the scheduler available for recovery', () => {
  const mintedAt = '2026-09-01T10:00:00.000Z';
  const passChecks = [
    'source_build',
    'scheduler_worker_manifest',
    'evidence_storage',
    'model_routes',
    'policy_oracle_artifacts',
    'config_control_plane',
    'accounting_adapter',
    'spend_meter'
  ].map((id) => ({ id, status: 'PASS', detail: {} }));
  const database = {
    id: 'database_schema',
    status: 'FAIL',
    detail: {
      server_major: 16,
      missing_migrations: [],
      unexpected_migrations: [],
      missing_tables: [],
      clock_skew_ms: 4,
      queue: { expired_running: 1, dead_unsuperseded: 0 }
    }
  };
  const queueOnly = {
    version: HOST_CERTIFICATE_A_VERSION,
    status: 'FAIL',
    runtime_host: 'desktop',
    freshness: buildHostCertificateFreshness({ mintedAt }),
    checks: [passChecks[0], database, ...passChecks.slice(1)]
  };
  assert.equal(hostReadinessAllowsSchedulerRecovery({ certificate: queueOnly, asOf: mintedAt }), true);
  assert.equal(
    hostReadinessAllowsSchedulerRecovery({
      certificate: {
        ...queueOnly,
        checks: queueOnly.checks.map((entry) => entry.id === 'database_schema'
          ? { ...entry, detail: { ...entry.detail, missing_migrations: ['999_missing'] } }
          : entry)
      },
      asOf: mintedAt
    }),
    false,
    'schema drift may not enter queue recovery mode'
  );
  assert.equal(
    hostReadinessAllowsSchedulerRecovery({
      certificate: {
        ...queueOnly,
        checks: queueOnly.checks.map((entry) => entry.id === 'model_routes'
          ? { ...entry, status: 'INCOMPLETE' }
          : entry)
      },
      asOf: mintedAt
    }),
    false,
    'another failed host dependency keeps the scheduler off'
  );
  assert.equal(
    hostReadinessAllowsSchedulerRecovery({
      certificate: {
        ...queueOnly,
        checks: [...queueOnly.checks, { id: 'future_host_check', status: 'FAIL', detail: {} }]
      },
      asOf: mintedAt
    }),
    false,
    'an unknown future check cannot be silently admitted by the recovery exception'
  );
  assert.equal(
    hostReadinessAllowsSchedulerRecovery({
      certificate: queueOnly,
      asOf: queueOnly.freshness.valid_until
    }),
    false,
    'an expired observation cannot authorize recovery work'
  );
});

test('host renewal mints immediately, records observation, and schedules the five-minute successor', async () => {
  const events = [];
  let scheduled = null;
  const cleared = [];
  let nextTimerId = 76;
  const controller = await startHostReadinessRenewal({
    mint: async ({ eventType }) => ({ status: 'PASS', certificate: { status: 'PASS' }, eventType }),
    onObservation: async (observation) => events.push(observation.eventType),
    setTimeoutFn: (callback, delay) => {
      scheduled = { callback, delay };
      nextTimerId += 1;
      return nextTimerId;
    },
    clearTimeoutFn: (id) => { cleared.push(id); }
  });
  assert.deepEqual(events, ['boot']);
  assert.equal(scheduled.delay, 5 * 60 * 1000);
  await controller.renewNow();
  assert.deepEqual(events, ['boot', 'retry'], 'queue recovery can replace the stale boot receipt immediately');
  assert.deepEqual(cleared, [77], 'an immediate retry replaces the pending five-minute timer');
  controller.stop();
  assert.deepEqual(cleared, [77, 78]);
});

test('host renewal coalesces overlapping immediate retries without dropping the later observation', async () => {
  const events = [];
  let retryCount = 0;
  let releaseFirstRetry;
  let markFirstRetryStarted;
  const firstRetryStarted = new Promise((resolve) => { markFirstRetryStarted = resolve; });
  const firstRetryGate = new Promise((resolve) => { releaseFirstRetry = resolve; });
  let nextTimerId = 0;
  const controller = await startHostReadinessRenewal({
    mint: async ({ eventType }) => {
      if (eventType === 'retry') {
        retryCount += 1;
        if (retryCount === 1) {
          markFirstRetryStarted();
          await firstRetryGate;
        }
      }
      return { status: 'PASS', certificate: { status: 'PASS' }, eventType };
    },
    onObservation: async (observation) => events.push(observation.eventType),
    setTimeoutFn: () => { nextTimerId += 1; return nextTimerId; },
    clearTimeoutFn: () => {}
  });

  const first = controller.renewNow();
  await firstRetryStarted;
  const second = controller.renewNow();
  releaseFirstRetry();
  await Promise.all([first, second]);

  assert.equal(retryCount, 2, 'the successor-settlement signal queues one follow-up observation');
  assert.deepEqual(events, ['boot', 'retry', 'retry']);
  controller.stop();
});

test('an operational scheduler failure becomes a valid failed Host A receipt', () => {
  const certificate = {
    version: HOST_CERTIFICATE_A_VERSION,
    certificate: 'A',
    observed_at: '2026-08-30T10:00:00.000Z',
    runtime_host: 'desktop',
    status: 'PASS',
    freshness: buildHostCertificateFreshness({ mintedAt: '2026-08-30T10:00:00.000Z' }),
    checks: []
  };
  const failed = buildHostOperationalFailureCertificate({
    certificate: { ...certificate, receipt_digest: hostDigest(certificate) },
    checkId: 'scheduler_process_start',
    reasonCode: 'scheduler_start_failed',
    observedAt: '2026-08-30T10:01:00.000Z'
  });
  const { receipt_digest: digest, ...body } = failed;
  assert.equal(failed.status, 'FAIL');
  assert.equal(failed.checks.at(-1).detail.reason, 'scheduler_start_failed');
  assert.equal(digest, hostDigest(body));
});

test('retry compatibility scope: birth is proven from the birth receipt, never re-judged against live state', async () => {
  const { __retryCompatibilityScope } = await import('./runtimeReadiness.js');
  // Never-ready new-client whose FIRST attempt proved a clean birth: the book
  // has legitimately operated since; retries certify the current generation.
  assert.equal(__retryCompatibilityScope({
    enrollmentKind: 'new_client_default', everReady: false, birthResidueProvenClean: true
  }), 'current_generation_compatibility');
  // A birth whose own residue proof failed (or recorded none) keeps the
  // strict scope until the residue is actually cleared — anti-laundering.
  assert.equal(__retryCompatibilityScope({
    enrollmentKind: 'new_client_default', everReady: false, birthResidueProvenClean: false
  }), 'birth_residue_proof');
  // A formerly-ready generation and every manual legacy heal stay steady-state.
  assert.equal(__retryCompatibilityScope({
    enrollmentKind: 'new_client_default', everReady: true, birthResidueProvenClean: false
  }), 'current_generation_compatibility');
  assert.equal(__retryCompatibilityScope({
    enrollmentKind: 'manual_legacy', everReady: false, birthResidueProvenClean: false
  }), 'current_generation_compatibility');
  assert.equal(__retryCompatibilityScope({}), 'current_generation_compatibility');
});

// ── 2026-09-08: a synthetic undeclared:* profile id is never retried BY id ──

test('retry leg: a synthetic undeclared:* profile id re-resolves by coordinate and carries the birth creation path', async () => {
  const { __isSyntheticProfileId, __priorCreationPath } = await import('./runtimeReadiness.js');
  assert.equal(__isSyntheticProfileId('undeclared:fi:fi-oy:desktop_firm_intake'), true);
  assert.equal(__isSyntheticProfileId('fi-oy.desktop-firm-intake.desktop.none.management-books.v2'), false);
  assert.equal(__isSyntheticProfileId(null), false);
  // The synthetic id names the birth path in its fourth segment — no '.' to split on.
  assert.equal(__priorCreationPath('undeclared:fi:fi-oy:desktop_firm_intake'), 'desktop_firm_intake');
  assert.equal(__priorCreationPath('undeclared:ae:ae-llc:generic_client_route'), 'generic_client_route');
  // A declared id keeps the dotted convention, dashes back to underscores.
  assert.equal(__priorCreationPath('gb-ltd.desktop-firm-intake.desktop.none.management-books.v2'), 'desktop_firm_intake');
  assert.equal(__priorCreationPath('us-llc.generic-client-route.desktop.none.management-books.v2'), 'generic_client_route');
  assert.equal(__priorCreationPath('fi-oy.firm-intake.vercel.none.management-books.fi-cloud-pilot-v1'), 'desktop_firm_intake');
  assert.equal(__priorCreationPath('undeclared:fi:fi-oy:firm_intake'), 'desktop_firm_intake');
  assert.equal(__priorCreationPath(''), null);
  assert.equal(__priorCreationPath(undefined), null);
});
