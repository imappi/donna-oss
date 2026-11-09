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

import { SUPPORTED_CRON_TASKS, isPublicDonnaHealthPath, isSignedDonnaCallbackPath, parseCronSummaryFailures } from './api.js';
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

// ── parseCronSummaryFailures: the partial-failure shapes ─────────────────
// Each failure shape beside a clean summary of the same task (which must stay
// a success), and each item-level outcome that has its own receipt (which
// must not fail the run). Shapes are the ones runParseCronTask writes.

const FIRM = 'firm-synthetic-1';

test('outbox (local job): a row the queue refused fails the run; requeued / deduped rows do not', () => {
  const clean = { outbox: { transport: 'local_job', picked: 2, requeued: [{ document_id: 'doc-a', parse_run_id: 'run-a', job_id: 7 }], already_queued: [{ document_id: 'doc-b' }], failed: [], without_run_id: 1 } };
  assert.deepEqual(parseCronSummaryFailures(clean), []);
  const failed = { outbox: { ...clean.outbox, failed: [{ document_id: 'doc-c', client_id: 'client-1', parse_run_id: 'run-c', reason: 'no_job_receipt', error: 'relation "local_jobs" does not exist' }] } };
  assert.deepEqual(parseCronSummaryFailures(failed), [{ task: 'outbox', document_id: 'doc-c', parse_run_id: 'run-c', error: 'relation "local_jobs" does not exist' }]);
});

test('outbox (cloud): a failed Inngest resend count fails the run; failed: 0 does not', () => {
  assert.deepEqual(parseCronSummaryFailures({ outbox: { picked: 3, resent: 3, failed: 0 } }), []);
  assert.deepEqual(parseCronSummaryFailures({ outbox: { picked: 3, resent: 1, failed: 2 } }), [{ task: 'outbox', error: '2 of 3 outbox resend(s) failed' }]);
});

test('coding_convergence: a per-firm step error or a client whose work threw fails the run; a clean firm does not', () => {
  const cleanResult = { coder: [{ client_id: 'client-1', unseen_lines: 2, scanned: 2, suggested: 2, auto_applied: 0, remembered: 0, ask_draft: { enqueued: 1 } }], released: [], ask_draft_recovery: [], swept: [{ client_id: 'client-1', evaluated: 2, errors: 0 }], sweep_gated: 0, ledger_posted: [], ledger_post_gated: 0, errors: 0 };
  const clean = { coding_convergence: { ...cleanResult, firms: [{ firm_id: FIRM, result: cleanResult }], errors: 0 } };
  assert.deepEqual(parseCronSummaryFailures(clean), []);

  const brokenResult = { ...cleanResult, errors: 3, sweep_discovery_error: 'column t.coding_state does not exist',
    coder: [{ client_id: 'client-1', error: 'connect ECONNREFUSED 127.0.0.1:5432', code: 'ECONNREFUSED', reason_code: null },
      { client_id: 'client-2', scanned: 1, suggested: 1, auto_applied: 0, remembered: 0, ask_draft_error: 'insert refused' }],
    ledger_posted: [{ client_id: 'client-3', error: 'ledger receipt write failed', code: null }] };
  const broken = { coding_convergence: { firms: [{ firm_id: FIRM, result: brokenResult }, { firm_id: 'firm-synthetic-2', result: cleanResult }], errors: 3 } };
  assert.deepEqual(parseCronSummaryFailures(broken), [
    { task: 'coding_convergence', firm_id: FIRM, step: 'sweep_discovery', error: 'column t.coding_state does not exist' },
    { task: 'coding_convergence', firm_id: FIRM, step: 'coder', client_id: 'client-1', error: 'connect ECONNREFUSED 127.0.0.1:5432' },
    { task: 'coding_convergence', firm_id: FIRM, step: 'ask_draft', client_id: 'client-2', error: 'insert refused' },
    { task: 'coding_convergence', firm_id: FIRM, step: 'ledger_posted', client_id: 'client-3', error: 'ledger receipt write failed' }
  ]);
});

test('coding_convergence: item outcomes with their own receipt (errors count, exhausted correction, policy incident, readiness refusal) do not fail the run', () => {
  const result = { coder: [{ client_id: 'client-1', scanned: 1, suggested: 0, policy_failure: true, error: 'coding_policy_unavailable' }],
    released: [], ask_draft_recovery: [],
    swept: [{ client_id: 'client-2', error: 'Entity readiness blocks this worker.', code: 'ENTITY_READINESS_ADMISSION_BLOCKED' }],
    ledger_posted: [{ client_id: 'client-3', error: 'Accounting unavailable.', code: 'PROCESSING_SCOPE_ACCOUNTING_UNAVAILABLE' }],
    posted_correction_recovery: [{ state: 'failed', code: 'CODING_CORRECTION_ATTEMPTS_EXHAUSTED' }],
    reconciliation_provider_recovery: [{ outcome: 'error' }],
    owner_reply_recovery: [{ evidence_request_id: 'ask-1', error: 'reply not processable' }],
    sweep_gated: 0, ledger_post_gated: 0, errors: 5 };
  assert.deepEqual(parseCronSummaryFailures({ coding_convergence: { ...result, firms: [{ firm_id: FIRM, result }], errors: 5 } }), []);
});

test('storage_orphans: refused deletes and refused audit receipts fail the run; a clean bucket and kept foreign keys do not', () => {
  const clean = { storage_orphans: { buckets: [{ bucket: 'donna-evidence', scanned: 4, deleted: 1, refused: 1, refused_keys: [{ bucket: 'donna-evidence', key: 'not-a-firm/x.pdf', firm_prefix: 'not-a-firm' }], audit_failures: 0, delete_errors: 0 }, { bucket: 'other', scanned: 0, deleted: 0, refused: 0 }], scanned_total: 4, deleted_total: 1, refused_total: 1 } };
  assert.deepEqual(parseCronSummaryFailures(clean), []);
  const failed = { storage_orphans: { ...clean.storage_orphans, buckets: [{ ...clean.storage_orphans.buckets[0], audit_failures: 1, delete_errors: 2, delete_failures: [{ key: `${FIRM}/c/a.pdf`, error: 'status 500 storage unavailable' }] }] } };
  assert.deepEqual(parseCronSummaryFailures(failed), [
    { task: 'storage_orphans', bucket: 'donna-evidence', error: '2 orphan delete(s) failed: status 500 storage unavailable' },
    { task: 'storage_orphans', bucket: 'donna-evidence', error: '1 cleanup audit receipt(s) failed' }
  ]);
});

test('statutory sweeps: a binding with candidate errors or an unloadable pack fails the run; a clean sweep does not', () => {
  const ran = { packId: 'fi', obligationId: 'fi.alv_threshold', outcome: 'ran', summary: { scanned: 2, exceeded: 0, minted: 0, delivered: 0, skipped: 0, errors: 0 } };
  const clean = { statutory_watches: { cadence: 'daily', dispatched: 1, ran: 1, errors: 0, obligations: [ran], unbuilt: [], unsurveyed: [], unloadable: [] } };
  assert.deepEqual(parseCronSummaryFailures(clean), []);
  const failed = { statutory_watches: { ...clean.statutory_watches, obligations: [{ ...ran, summary: { ...ran.summary, errors: 2 } }], unloadable: [{ packId: 'xx', error: 'pack manifest invalid' }] } };
  assert.deepEqual(parseCronSummaryFailures(failed), [
    { task: 'statutory_watches', obligation_id: 'fi.alv_threshold', error: '2 candidate error(s)' },
    { task: 'statutory_watches', pack_id: 'xx', error: 'pack manifest invalid' }
  ]);
});

test('canonical_role_resolution: a client whose run threw fails the run; model_error / refused / completed do not', () => {
  const clean = { canonical_role_resolution: { firm_id: FIRM, considered: 3, clients: [{ client_id: 'c1', status: 'completed' }, { client_id: 'c2', status: 'model_error', reason: 'api_error' }, { client_id: 'c3', status: 'refused', reason: 'missing_target' }], tally: {} } };
  assert.deepEqual(parseCronSummaryFailures(clean), []);
  const failed = { canonical_role_resolution: { ...clean.canonical_role_resolution, clients: [...clean.canonical_role_resolution.clients, { client_id: 'c4', status: 'error', reason: '57P01' }] } };
  assert.deepEqual(parseCronSummaryFailures(failed), [{ task: 'canonical_role_resolution', client_id: 'c4', error: '57P01' }]);
});

test('owner-media terminal summaries: a thrown attempt fails the run; send_failed (typed, logged, claim burned) does not', () => {
  assert.deepEqual(parseCronSummaryFailures({ stuck: { stuck_count: 0, failed_count: 0 }, owner_media_terminal_summaries: { swept: 2, sent: 1, skipped: { send_failed: 1 } } }), []);
  assert.deepEqual(parseCronSummaryFailures({ owner_media_terminal_summaries: { swept: 2, sent: 1, skipped: { threw: 1 } } }), [{ task: 'owner_media_terminal_summaries', error: '1 terminal summary attempt(s) threw' }]);
});

test('item-level counters with their own receipts never fail the run (loops, drain, reminders)', () => {
  assert.deepEqual(parseCronSummaryFailures({
    loops_inbox: { skipped: false, reclaimed: { requeued: 0, failed: 1 }, claimed: 2, processed: 1, ignored: 0, failed: 1 },
    loops_outbox: { skipped: false, considered: 3, dispatched: 1, deadLettered: 1, failed: 1 },
    loops_recon_eval: { skipped: false, failed: 1, deadLettered: 1 },
    loops_auto_send: { skipped: false, considered: 1, sent: 0, failed: 1 },
    drain: { picked: 1, worker_failed: 1, errors: [{ document_id: 'doc-a', code: 'X', error: 'parse failed' }] },
    evidence_topic_reminders: { skipped: false, considered: 1, sent: 0, failed: 1 }
  }), []);
});

console.log(`\nparseCronStabilization: ${passed} passed, ${failed} failed.`);
if (failed > 0) process.exit(1);
