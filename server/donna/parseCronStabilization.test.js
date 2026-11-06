// Stabilization tests (Phase C of the async-parsing stabilization
// pass). Pin behaviours that would catch the original "stuck in
// Queued" regression class:
//   - SUPPORTED_CRON_TASKS membership (a missing/typoed task means
//     vercel.json silently aims at a 400 path)
//   - drain bounds clamping (a 0-second threshold would race
//     in-flight Inngest deliveries)
//   - Outbox skip semantics when Inngest isn't configured
//
// All tests are pure; no live DB or HTTP harness needed.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SUPPORTED_CRON_TASKS, isPublicDonnaHealthPath, isSignedDonnaCallbackPath } from './api.js';
import { clampDrainBounds } from './parseDocumentsDb.js';
import { isInngestConfigured } from './inngest/client.js';

let passed = 0;
let failed = 0;

const test = (name, fn) => {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`  fail ${name}`);
    console.error(`       ${err?.message || err}`);
  }
};

console.log('parseCronStabilization:');

// ── SUPPORTED_CRON_TASKS membership ────────────────────────────────────

test('SUPPORTED_CRON_TASKS includes outbox', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('outbox'), true);
});

test('SUPPORTED_CRON_TASKS includes stuck', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('stuck'), true);
});

test('SUPPORTED_CRON_TASKS includes drain (no-Inngest fallback)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('drain'), true);
});

test('SUPPORTED_CRON_TASKS includes storage_orphans (daily cleanup)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('storage_orphans'), true);
});

test('SUPPORTED_CRON_TASKS includes diagnostics (operator probe)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('diagnostics'), true);
});

test('SUPPORTED_CRON_TASKS includes convergence_snapshot (Slice J daily trend sampler)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('convergence_snapshot'), true);
});

test('SUPPORTED_CRON_TASKS includes statutory_watches (the jurisdiction-neutral statutory sweep)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('statutory_watches'), true);
});

test('SUPPORTED_CRON_TASKS includes statutory_watches_hourly (the hourly cadence of the same sweep, RT-19)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('statutory_watches_hourly'), true);
});

test('SUPPORTED_CRON_TASKS includes evidence_topic_reminders (the daily reminder sweep)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('evidence_topic_reminders'), true);
});

test('SUPPORTED_CRON_TASKS includes canonical_role_resolution (the daily role sweep)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('canonical_role_resolution'), true);
});

// DEPRECATED alias — delete this test together with the alias in api.js once
// the renamed vercel.json schedule is live in production. It exists only so a
// cron invocation in flight across that deploy does not 400.
test('finland_watches remains accepted as the deprecated deploy-skew alias', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('finland_watches'), true);
});

test('every vercel.json cron aims at a supported task (the exact regression this file exists for)', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  for (const cron of vercel.crons || []) {
    const task = new URLSearchParams(cron.path.split('?')[1] || '').get('task');
    assert.equal(SUPPORTED_CRON_TASKS.has(task), true, `${cron.path} aims at unsupported task '${task}'`);
  }
});

test('SUPPORTED_CRON_TASKS includes coding_convergence (batch-coder re-drive + auto-post sweep)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('coding_convergence'), true);
});

test('SUPPORTED_CRON_TASKS includes all (combined sweep)', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('all'), true);
});

test('SUPPORTED_CRON_TASKS rejects unknown task names', () => {
  assert.equal(SUPPORTED_CRON_TASKS.has('flush'), false);
  assert.equal(SUPPORTED_CRON_TASKS.has('process'), false);
  assert.equal(SUPPORTED_CRON_TASKS.has(''), false);
  assert.equal(SUPPORTED_CRON_TASKS.has('OUTBOX'), false, 'case-sensitive');
});

// ── clampDrainBounds ───────────────────────────────────────────────────

test('clampDrainBounds defaults: limit=5, thresholdSeconds=5', () => {
  const bounds = clampDrainBounds({});
  assert.equal(bounds.limit, 5);
  assert.equal(bounds.thresholdSeconds, 5);
});

test('clampDrainBounds caps limit at 50 (avoid Vercel function timeout)', () => {
  const bounds = clampDrainBounds({ limit: 999 });
  assert.equal(bounds.limit, 50);
});

test('clampDrainBounds treats limit=0 as default-5 (falsy short-circuit)', () => {
  // Number(0) || 5 → 5. 0 is meaningless for a "fetch up to N" cap,
  // so the safer interpretation is the default. -5 is still a
  // negative number, so it clamps up to the floor of 1.
  assert.equal(clampDrainBounds({ limit: 0 }).limit, 5);
  assert.equal(clampDrainBounds({ limit: -5 }).limit, 1);
});

test('clampDrainBounds floors threshold at 0 (no negatives)', () => {
  // The original 15s floor protected against racing Inngest deliveries.
  // Since Inngest is no longer a hard dependency (PR #48), threshold=0
  // is safe — runParseInline's atomic claim still guards against
  // double-processing. Negative inputs still floor to 0.
  assert.equal(clampDrainBounds({ thresholdSeconds: 0 }).thresholdSeconds, 0);
  assert.equal(clampDrainBounds({ thresholdSeconds: 10 }).thresholdSeconds, 10);
  assert.equal(clampDrainBounds({ thresholdSeconds: -100 }).thresholdSeconds, 0);
});

test('clampDrainBounds passes through valid values', () => {
  const bounds = clampDrainBounds({ limit: 10, thresholdSeconds: 120 });
  assert.equal(bounds.limit, 10);
  assert.equal(bounds.thresholdSeconds, 120);
});

test('clampDrainBounds handles non-numeric input', () => {
  // Number("abc") → NaN → finite-guard falls back to default 5.
  // null → Number(null)=0 → finite, then floored at 0.
  const bounds = clampDrainBounds({ limit: 'abc', thresholdSeconds: 'abc' });
  assert.equal(bounds.limit, 5);
  assert.equal(bounds.thresholdSeconds, 5);
  assert.equal(clampDrainBounds({ thresholdSeconds: null }).thresholdSeconds, 0);
});

// ── isInngestConfigured ───────────────────────────────────────────────

test('isInngestConfigured returns a boolean', () => {
  const result = isInngestConfigured();
  assert.equal(typeof result, 'boolean');
});

// Note: we can't assert true/false here because the result depends on
// process.env at module-load time. Setting INNGEST_EVENT_KEY after
// import has no effect (the module cached the value). The test above
// just pins that the outbox cron has a deterministic gate: it forks the
// producer on it (the Inngest re-send in the cloud; since RT-14b a
// `parse-document` local-job requeue on a host without Inngest), and the
// diagnostics endpoint reports `inngest_configured` from the same gate.

// ── isPublicDonnaHealthPath (deploy-vintage receipt exemption) ─────────

test('isPublicDonnaHealthPath exempts exactly /api/donna/firms/health', () => {
  assert.equal(isPublicDonnaHealthPath('/api/donna/firms/health'), true);
});

test('isPublicDonnaHealthPath does not leak onto sibling or nested paths', () => {
  // The exemption is a single exact path — a prefix/startsWith bug here
  // would silently open protected firm routes.
  assert.equal(isPublicDonnaHealthPath('/api/donna/firms/health/'), false);
  assert.equal(isPublicDonnaHealthPath('/api/donna/firms/healthz'), false);
  assert.equal(isPublicDonnaHealthPath('/api/donna/firms/health/extra'), false);
  assert.equal(isPublicDonnaHealthPath('/api/donna/firms'), false);
  assert.equal(isPublicDonnaHealthPath('/api/donna/firms/snapshot'), false);
  assert.equal(isPublicDonnaHealthPath(''), false);
});

// ── isSignedDonnaCallbackPath (OAuth callback access-token-gate exemption) ──

test('isSignedDonnaCallbackPath exempts all three provider callbacks', () => {
  // A provider redirect carries no Donna bearer — the signed state is the
  // control. A callback missing here is rejected with AUTH_REQUIRED before it
  // can process the code (the Procountor callback hit exactly that).
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms/xero/callback'), true);
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms/qbo/callback'), true);
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms/procountor/callback'), true);
});

test('isSignedDonnaCallbackPath does not leak onto sibling or nested paths', () => {
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms/procountor/callback/'), false);
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms/procountor/writeback-transactions'), false);
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms/procountor/connect'), false);
  assert.equal(isSignedDonnaCallbackPath('/api/donna/firms'), false);
  assert.equal(isSignedDonnaCallbackPath(''), false);
});

test('drain queue is small-docs-first: statements sort last, FIFO within class (Kari 2026-08-06)', () => {
  const src = readFileSync(new URL('./parseDocumentsDb.js', import.meta.url), 'utf8');
  const fn = src.slice(src.indexOf('fetchDrainablePendingRowsInDb'), src.indexOf('fetchOutboxPendingRowsInDb'));
  assert.match(
    fn,
    /\(coalesce\(document_type, ''\) in \('bank_statement', 'statement', 'payment_account_statement'\)\) asc/,
    'statement-family docs must sort after everything else'
  );
  assert.match(fn, /parse_enqueued_at asc/, 'FIFO must be preserved within each class');
  // RT-02: a readiness-held row (fresh parse_hold) sorts LAST of all, before
  // the statement key, so a held batch never starves other entities.
  const orderBy = fn.slice(fn.indexOf('order by'));
  assert.ok(
    orderBy.indexOf("payload->'parse_hold'->>'checked_at'") < orderBy.indexOf("coalesce(document_type, '')"),
    'held rows must be the primary sort key (last), statements the secondary'
  );
});

console.log(`\nparseCronStabilization: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
