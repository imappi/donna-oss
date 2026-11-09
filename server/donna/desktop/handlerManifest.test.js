// handlerManifest — the desktop declaration of scheduled work. The
// load-bearing invariants (RT-14 shape — the manifest is FUNCTIONS):
//   1. every inngest-cron entry pins 1:1 against the LIVE Inngest
//      registrations (id, cron, retries) — a schedule or retry change in a
//      function module without a manifest update fails here, and vice versa;
//   2. marketing-lane functions are absent entirely (plan §4: not
//      bundled-then-disabled — not in the manifest at all);
//   3. the parse-cron task family is scheduled from the manifest's OWN table
//      (DESKTOP_PARSE_CRON_SCHEDULE) and each entry calls the task runner
//      IN-PROCESS — no http-cron kind, no self-call, no vercel.json read at
//      runtime. vercel.json is a TEST input here: the cloud's cron table and
//      the desktop's are pinned against each other both ways, and every task
//      the cloud schedules that the desktop deliberately does not run is named
//      in CLOUD_ONLY_PARSE_CRON_TASKS with its reason;
//   4. every cron expression in the manifest parses under the desktop
//      matcher, so nothing can be declared that the scheduler cannot run;
//   5. the ledger mirror sweeps are not scheduled on a book whose accounting
//      adapter is 'none' (audit F-19; the receipted skip became "not scheduled").
//
// CI-only in the same sense as serve.test.js: imports the Inngest function
// modules, which require the `inngest` package.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registeredInngestFunctions } from '../inngest/serve.js';
import {
  CLOUD_ONLY_PARSE_CRON_TASKS,
  DESKTOP_EXCLUDED_FUNCTION_IDS,
  DESKTOP_PARSE_CRON_SCHEDULE,
  NONE_ADAPTER_FUNCTION_IDS,
  buildDesktopHandlerManifest
} from './handlerManifest.js';
import { parseCronExpression } from './cronSchedule.js';
import { SUPPORTED_CRON_TASKS } from '../api.js';
import { parseCronSummaryFailures } from '../parseCronSummaryFailures.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const manifest = buildDesktopHandlerManifest();
const cronEntries = manifest.filter((e) => e.kind === 'inngest-cron');
const parseCronEntries = manifest.filter((e) => e.kind === 'parse-cron');

const registeredById = new Map(registeredInngestFunctions.map((fn) => [fn.id(), fn]));

// The cloud's cron table — read by the TEST from the repo root, never by the
// runtime. Each entry aims at /documents/parse-cron?task=<task>.
const vercelCronTasks = () => {
  const crons = JSON.parse(readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8')).crons || [];
  return crons.map(({ path: cronPath, schedule }) => ({
    task: new URL(cronPath, 'http://localhost').searchParams.get('task'),
    schedule
  }));
};

test('every inngest-cron entry matches a live registration: id, cron, and retries', () => {
  for (const entry of cronEntries) {
    const fn = registeredById.get(entry.functionId);
    assert.ok(fn, `manifest entry ${entry.functionId} has no Inngest registration`);
    const trigger = fn.opts?.triggers?.[0];
    assert.equal(trigger?.cron, entry.cron, `${entry.functionId}: manifest cron drifted from the function module`);
    assert.equal(
      entry.maxAttempts, (fn.opts?.retries ?? 0) + 1,
      `${entry.functionId}: maxAttempts must mirror the Inngest retries config`
    );
  }
});

test('the manifest covers every non-marketing cron-triggered Inngest function', () => {
  const manifestIds = new Set(cronEntries.map((e) => e.functionId));
  for (const fn of registeredInngestFunctions) {
    const isCron = Boolean(fn.opts?.triggers?.[0]?.cron);
    const excluded = DESKTOP_EXCLUDED_FUNCTION_IDS.includes(fn.id());
    if (isCron && !excluded) {
      assert.ok(manifestIds.has(fn.id()), `cron function ${fn.id()} missing from the desktop manifest`);
    }
  }
});

test('marketing-lane functions are not in the manifest at all', () => {
  const ids = new Set(manifest.map((e) => e.functionId));
  for (const excluded of DESKTOP_EXCLUDED_FUNCTION_IDS) {
    assert.ok(!ids.has(excluded), `${excluded} must not appear in the desktop manifest`);
  }
  // The exclusions correspond to real registrations — a rename would
  // silently un-exclude, so pin that each excluded id still exists.
  for (const excluded of DESKTOP_EXCLUDED_FUNCTION_IDS) {
    assert.ok(registeredById.has(excluded), `excluded id ${excluded} no longer matches a registration`);
  }
});

test('the env-dark bank-line auto-explain and rule-learning crons are gone from the registry and the manifest (RT-14 deletions)', () => {
  for (const id of ['bank-line-auto-explain', 'learn-reconciliation-rules']) {
    assert.ok(!registeredById.has(id), `${id} is deleted, not merely excluded`);
    assert.ok(!manifest.some((e) => e.functionId === id), `${id} is not on the desktop manifest`);
  }
});

test('the parse-document function is a cron-less local-event job (RT-08); the drain has no desktop entry (RT-14); the outbox does (RT-14b)', () => {
  const entry = manifest.find((e) => e.functionId === 'parse-document');
  assert.ok(entry, 'the per-document parse is a local_jobs function on the desktop manifest');
  assert.equal(entry.kind, 'local-event');
  assert.equal(entry.cron, null, 'enqueued by the routes, never by a schedule — and never a Host A cron cursor');
  assert.equal(entry.maxAttempts, 4, 'decision D7: four automatic attempts');
  assert.equal(entry.concurrency, 2, 'the desktop default (INNGEST_PARSE_CONCURRENCY overrides)');
  assert.equal(entry.timeoutMs, 5 * 60_000, 'the extraction budget: the Inngest per-attempt cap');
  assert.ok(entry.leaseMs > entry.timeoutMs, 'the lease must outlive the timeout');
  assert.equal(typeof entry.run, 'function');
  assert.ok(
    !manifest.some((e) => e.functionId === 'parse-cron:drain'),
    'the one-release drain backstop is deleted from the desktop manifest — the job owns every parse run'
  );
  const outbox = manifest.find((e) => e.functionId === 'parse-cron:outbox');
  assert.ok(outbox, 'RT-14b: the outbox IS scheduled on the appliance — it requeues the local parse job for a pending row whose register-time enqueue left none');
  assert.equal(outbox.kind, 'parse-cron');
  assert.equal(outbox.cron, '* * * * *', 'a minute is the wait a human accepts for an upload that did not start');
  assert.ok(!('outbox' in CLOUD_ONLY_PARSE_CRON_TASKS), 'the outbox is no longer named cloud-only');
});

test('the parse-document entry runs the exported worker handler with the job\'s attempt budget', async () => {
  const { runParseDocumentJob } = await import('./parseDocumentJob.js');
  const entry = manifest.find((e) => e.functionId === 'parse-document');
  assert.equal(entry.run, runParseDocumentJob, 'the manifest entry IS the job runner, not a wrapper of its own');
  const seen = [];
  const step = { __desktop: true, run: async (_name, fn) => fn() };
  const result = await runParseDocumentJob({
    step,
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    payload: { firm_id: 'f', document_id: 'd', parse_run_id: '11111111-1111-4111-8111-111111111111', client_id: 'c', document_type: 'receipt' },
    job: { id: 7, attempt_count: 2, max_attempts: 4 },
    deps: {
      handleParseEvent: async (args) => { seen.push(args); return { handled: true, outcome: 'completed', document_id: 'd' }; }
    }
  });
  assert.deepEqual(result, { handled: true, outcome: 'completed', document_id: 'd' });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].step, step);
  assert.deepEqual(seen[0].attempt, { count: 2, max: 4 });
  assert.equal(seen[0].event.id, '11111111-1111-4111-8111-111111111111');
  assert.equal(seen[0].event.name, 'document/parse.requested');
  assert.deepEqual(seen[0].event.data, {
    firm_id: 'f', document_id: 'd', parse_run_id: '11111111-1111-4111-8111-111111111111', client_id: 'c', document_type: 'receipt'
  });
});

test('the convergence drift receipt is ONE nightly desktop-cron entry that runs the exported check (RT-13)', async () => {
  const { CONVERGENCE_DRIFT_FUNCTION_ID, runConvergenceDriftCheck } = await import('../convergenceDriftCheck.js');
  const entries = manifest.filter((e) => e.functionId === CONVERGENCE_DRIFT_FUNCTION_ID);
  assert.equal(entries.length, 1, 'exactly one entry');
  const [entry] = entries;
  assert.equal(entry.kind, 'desktop-cron', 'no cloud counterpart — the column is load-bearing on the appliance');
  assert.equal(entry.cron, process.env.CONVERGENCE_DRIFT_CRON || '20 4 * * *');
  assert.equal(entry.maxAttempts, 1, 'the next night is the retry');
  assert.equal(entry.concurrency, 1);
  assert.ok(entry.leaseMs > entry.timeoutMs, 'the lease outlives the timeout');
  // The entry runs the exported check through the durable step shim, with an
  // injected firm list so this pins the wiring without a database.
  const seen = [];
  const step = { run: async (name, fn) => { seen.push(name); return fn(); } };
  const summary = await entry.run({ step, logger: { warn: () => {}, error: () => {} } });
  assert.deepEqual(seen, ['check']);
  assert.equal(typeof summary.firms, 'number');
  assert.equal(typeof runConvergenceDriftCheck, 'function');
});

// ── RT-14 — the parse-cron family as functions ────────────────────────────

test('the desktop parse-cron schedule table: every task is supported by the runner, scheduled exactly once, and every entry is kind parse-cron', () => {
  assert.ok(DESKTOP_PARSE_CRON_SCHEDULE.length >= 9, 'the appliance schedules the parse-cron sweeps');
  const tasks = DESKTOP_PARSE_CRON_SCHEDULE.map(({ task }) => task);
  assert.equal(new Set(tasks).size, tasks.length, 'a task is scheduled once');
  for (const { task, cron } of DESKTOP_PARSE_CRON_SCHEDULE) {
    assert.ok(SUPPORTED_CRON_TASKS.has(task), `${task}: the runner must support every scheduled task`);
    assert.ok(!(task in CLOUD_ONLY_PARSE_CRON_TASKS), `${task}: a task cannot be both scheduled and cloud-only`);
    assert.ok(parseCronExpression(cron), `${task}: cron must parse under the desktop matcher`);
    const entry = parseCronEntries.find((e) => e.functionId === `parse-cron:${task}`);
    assert.ok(entry, `parse-cron:${task} is on the manifest`);
    assert.equal(entry.cron, cron);
    assert.equal(entry.maxAttempts, 1, 'the next tick is the retry');
  }
  assert.equal(parseCronEntries.length, DESKTOP_PARSE_CRON_SCHEDULE.length, 'no parse-cron entry outside the table');
  for (const task of Object.keys(CLOUD_ONLY_PARSE_CRON_TASKS)) {
    assert.ok(SUPPORTED_CRON_TASKS.has(task), `${task}: a cloud-only task still exists for the cloud`);
    assert.ok(typeof CLOUD_ONLY_PARSE_CRON_TASKS[task] === 'string' && CLOUD_ONLY_PARSE_CRON_TASKS[task].length > 10, `${task}: the reason is written down`);
  }
});

test('the desktop schedule and vercel.json\'s cron table are the same table minus the named cloud-only tasks (a TEST input, never a runtime read)', () => {
  const cloud = vercelCronTasks();
  assert.ok(cloud.length >= 10, 'expected the parse-cron task family in vercel.json');
  const desktopByTask = new Map(DESKTOP_PARSE_CRON_SCHEDULE.map(({ task, cron }) => [task, cron]));
  for (const { task, schedule } of cloud) {
    if (task in CLOUD_ONLY_PARSE_CRON_TASKS) {
      assert.ok(!desktopByTask.has(task), `${task} is cloud-only and must not be on the desktop schedule`);
      continue;
    }
    assert.ok(desktopByTask.has(task), `vercel.json schedules ${task}; the desktop table must carry it (or name it cloud-only with a reason)`);
    assert.equal(desktopByTask.get(task), schedule, `${task}: the two schedules drifted`);
  }
  for (const task of desktopByTask.keys()) {
    assert.ok(cloud.some((c) => c.task === task), `${task} is on the desktop schedule but the cloud no longer runs it — decide, don't drift`);
  }
});

test('a parse-cron entry calls the task runner in-process with its task name — no HTTP, no access token, no base URL', async () => {
  const calls = [];
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => { fetchCalls.push(args); throw new Error('fetch must not be called'); };
  try {
    const built = buildDesktopHandlerManifest({
      deps: { runParseCronTask: async (args) => { calls.push(args); return { stuck: { failed: 0 }, task: args.task }; } }
    });
    const entry = built.find((e) => e.functionId === 'parse-cron:stuck');
    assert.ok(entry);
    const steps = [];
    const step = { run: async (name, fn) => { steps.push(name); return fn(); } };
    const result = await entry.run({ step, logger: { log: () => {} }, payload: { tick: '2026-09-02T09:00:00.000Z' } });
    assert.deepEqual(result, { stuck: { failed: 0 }, task: 'stuck' }, 'the job result IS the runner\'s summary');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].task, 'stuck');
    assert.deepEqual(steps, ['task'], 'runs under the durable step shim');
    assert.deepEqual(fetchCalls, []);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a parse-cron task whose summary carries a caught failure fails the run (the cloud route\'s 500 rule); a clean summary still succeeds', async () => {
  const summaries = {
    loops_inbox: { loops_inbox: { error: 'connect ECONNREFUSED 127.0.0.1:5432' } },
    coding_convergence: { coding_convergence: { firms: [{ firm_id: 'firm-synthetic-1', considered: 0 }] } }
  };
  const built = buildDesktopHandlerManifest({
    deps: { runParseCronTask: async ({ task }) => summaries[task] }
  });
  const step = { run: async (_name, fn) => fn() };
  const logger = { log: () => {}, error: () => {} };
  const run = (task) => built.find((e) => e.functionId === `parse-cron:${task}`).run({ step, logger, payload: {} });

  await assert.rejects(run('loops_inbox'), (error) => {
    assert.equal(error.code, 'PARSE_CRON_TASK_FAILED');
    assert.deepEqual(error.failures, [{ task: 'loops_inbox', error: 'connect ECONNREFUSED 127.0.0.1:5432' }]);
    assert.match(error.message, /ECONNREFUSED/, 'the failures ride in the message, which becomes the job\'s last_error');
    return true;
  });
  assert.deepEqual(await run('coding_convergence'), summaries.coding_convergence, 'a clean summary is the job result, unchanged');
  // The read-only diagnostics task is not on the desktop schedule; the one
  // rule the entries read still leaves its own read errors alone.
  assert.deepEqual(parseCronSummaryFailures({ diagnostics: { error: 'read failed', counts_error: 'read failed' } }), []);
});

test('the partial-failure shapes (outbox failed[], a per-firm coding step error, a refused orphan delete) fail their desktop run; a clean neighbour of each succeeds', async () => {
  const clean = {
    outbox: { outbox: { transport: 'local_job', picked: 1, requeued: [{ document_id: 'doc-a', parse_run_id: 'run-a', job_id: 1 }], already_queued: [], failed: [], without_run_id: 0 } },
    coding_convergence: { coding_convergence: { firms: [{ firm_id: 'firm-synthetic-1', result: { coder: [], swept: [], ledger_posted: [], errors: 1, posted_correction_recovery: [{ state: 'failed' }] } }], errors: 1 } },
    storage_orphans: { storage_orphans: { buckets: [{ bucket: 'evidence', scanned: 2, deleted: 1, refused: 1, audit_failures: 0, delete_errors: 0 }], scanned_total: 2, deleted_total: 1, refused_total: 1 } }
  };
  const failed = {
    outbox: { outbox: { ...clean.outbox.outbox, failed: [{ document_id: 'doc-b', parse_run_id: 'run-b', error: 'relation "local_jobs" does not exist' }] } },
    coding_convergence: { coding_convergence: { firms: [{ firm_id: 'firm-synthetic-1', result: { coder: [], swept: [], ledger_posted: [], errors: 1, coder_discovery_error: 'connect ECONNREFUSED 127.0.0.1:5432' } }], errors: 1 } },
    storage_orphans: { storage_orphans: { buckets: [{ bucket: 'evidence', scanned: 2, deleted: 0, refused: 0, audit_failures: 0, delete_errors: 1, delete_failures: [{ key: 'f/c/a.pdf', error: 'status 500' }] }], scanned_total: 2, deleted_total: 0, refused_total: 0 } }
  };
  let current = clean;
  const built = buildDesktopHandlerManifest({ deps: { runParseCronTask: async ({ task }) => current[task] } });
  const step = { run: async (_name, fn) => fn() };
  const logger = { log: () => {}, error: () => {} };
  const run = (task) => built.find((e) => e.functionId === `parse-cron:${task}`).run({ step, logger, payload: {} });
  for (const task of Object.keys(clean)) {
    current = clean;
    assert.deepEqual(await run(task), clean[task], `${task}: a clean summary is the job result`);
    current = failed;
    await assert.rejects(run(task), (error) => {
      assert.equal(error.code, 'PARSE_CRON_TASK_FAILED');
      assert.deepEqual(error.failures, parseCronSummaryFailures(failed[task]));
      assert.ok(error.failures.length === 1 && error.failures[0].task === task, JSON.stringify(error.failures));
      return true;
    }, `${task}: a partial failure fails the run`);
  }
});

test('the manifest module does not read vercel.json (or any file) at runtime', () => {
  const source = readFileSync(new URL('./handlerManifest.js', import.meta.url), 'utf8');
  assert.ok(!/['"`]vercel\.json['"`]/.test(source), 'vercel.json is the cloud\'s descriptor, never a path literal here; the desktop schedule lives in this module');
  assert.ok(!/from 'node:fs'|readFileSync|readFile\(/.test(source), 'no file read in the manifest builder');
  assert.ok(!source.includes("kind: 'http-cron'"), 'the http-cron kind is gone');
  assert.ok(!/fetchImpl|httpBaseUrl|httpAccessToken/.test(source), 'no self-call plumbing');
});

test('an inngest-cron entry passes the job payload through to its runner (RT-10 §4 item 5: a machine re-run job is payload-scoped)', async () => {
  const seen = [];
  const built = buildDesktopHandlerManifest({
    deps: { runners: { 'bank-line-disposition': async (args) => { seen.push(args); return { scoped: true }; } } }
  });
  const entry = built.find((e) => e.functionId === 'bank-line-disposition');
  const payload = { firm_id: 'f', client_id: 'c', target_type: 'transaction', target_id: 't1', attempt: 1 };
  const result = await entry.run({ step: { run: (_n, fn) => fn() }, logger: { log: () => {} }, payload });
  assert.deepEqual(result, { scoped: true });
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].payload, payload);
});

test('the ledger mirror sweeps are scheduled only when the firm\'s accounting adapter is not \'none\' (F-19)', () => {
  assert.deepEqual([...NONE_ADAPTER_FUNCTION_IDS].sort(), ['ledger-auto-export', 'ledger-mirror-verify']);
  const withAdapter = buildDesktopHandlerManifest({ ledgerAdapterConnected: true }).map((e) => e.functionId);
  const noneBook = buildDesktopHandlerManifest({ ledgerAdapterConnected: false }).map((e) => e.functionId);
  for (const id of NONE_ADAPTER_FUNCTION_IDS) {
    assert.ok(withAdapter.includes(id), `${id} scheduled on a connected book`);
    assert.ok(!noneBook.includes(id), `${id} not scheduled on a 'none' book`);
    assert.ok(registeredById.has(id), `${id} still exists for the cloud`);
  }
  assert.equal(withAdapter.length - noneBook.length, NONE_ADAPTER_FUNCTION_IDS.length, 'nothing else changes with the adapter');
});

test('manifest hygiene: unique ids, one of the four kinds, parseable crons (or none for a local-event job), required fields', () => {
  const ids = manifest.map((e) => e.functionId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate function ids');
  for (const entry of manifest) {
    assert.ok(['inngest-cron', 'parse-cron', 'local-event', 'desktop-cron'].includes(entry.kind), `${entry.functionId}: kind ${entry.kind}`);
    if (entry.kind === 'local-event') {
      assert.equal(entry.cron, null, `${entry.functionId}: a local-event job is enqueued, never scheduled`);
    } else {
      assert.ok(parseCronExpression(entry.cron), `${entry.functionId}: cron must parse`);
    }
    assert.ok(entry.maxAttempts >= 1);
    assert.ok(entry.concurrency >= 1);
    assert.ok(entry.leaseMs > 0);
    assert.ok(entry.timeoutMs > 0);
    assert.equal(typeof entry.run, 'function');
    assert.ok(entry.handlerVersion, 'handler_version is recorded on every job');
  }
});

test('the daily backup entry exists (desktop-cron) and skips with a receipt when unconfigured', async () => {
  const entry = manifest.find((e) => e.functionId === 'desktop-backup-daily');
  assert.ok(entry, 'plan §8 daily trigger must be declared in the manifest');
  assert.equal(entry.kind, 'desktop-cron');
  const saved = { ...process.env };
  delete process.env.DONNA_DESKTOP_BACKUP_DIR;
  try {
    const result = await entry.run({ step: { run: (_n, fn) => fn() }, logger: { log: () => {} } });
    assert.deepEqual(result, { skipped: true, reason: 'backup_env_not_configured' });
  } finally {
    process.env = saved;
  }
});

test('the loops_inbox drain is on the desktop scheduler (S3)', () => {
  // The goal-first loop's drain + dispatch tick. The desktop appliance is the
  // ONLY deployment where nobody can drive `?task=loops_inbox` by hand: on the
  // box, no tick means owner-fact lines never become drafted asks, silently.
  const entry = parseCronEntries.find((e) => e.functionId === 'parse-cron:loops_inbox');
  assert.ok(entry, 'the desktop scheduler must carry the loops_inbox drain');
  assert.ok(parseCronExpression(entry.cron), 'loops_inbox cron must parse under the desktop matcher');
});

// ── DMEM-R1 W2 — the memory plane's dark workers + the Host A manifest digest pin ──

import { hostDigest } from '../hostCertificateA.js';
import { DMEM_MEMORY_WORKER_FUNCTION_IDS } from './handlerManifest.js';

// The declared handler SURFACE (what Host A's scheduler_worker_manifest check
// digests, minus the env-derived cron strings and the tuning numbers): every
// function id, its kind and its handler version. A manifest change — an entry
// added, renamed, re-kinded or re-versioned — changes this digest and must be
// made deliberately, here, in the same commit (DMEM-R1 W2 added the two memory
// workers and re-pinned it). `CI=true npm run runtime:initialize:ci-host` after
// a handler-changing merge is the operational half of the same discipline.
const declaredHandlerSurface = (manifest) => manifest
  .map((entry) => ({ function_id: entry.functionId, kind: entry.kind, handler_version: entry.handlerVersion ?? null }))
  .sort((a, b) => a.function_id.localeCompare(b.function_id));
const HOST_A_MANIFEST_SURFACE_DIGEST = '29ad40d7b1b55eb5ecf1e2c22c3719522516dc5da25c62fd26358f7a45d8a2bf';

test('DMEM-R1 W2: the two memory workers are declared, cron-less local-event entries — dark by posture, receipted skips, no body', async () => {
  assert.deepEqual([...DMEM_MEMORY_WORKER_FUNCTION_IDS], ['memory-invalidation-outbox', 'memory-projection-rebuild']);
  for (const functionId of DMEM_MEMORY_WORKER_FUNCTION_IDS) {
    const entry = manifest.find((e) => e.functionId === functionId);
    assert.ok(entry, `${functionId} is on the manifest`);
    assert.equal(entry.kind, 'local-event', 'enqueued by a writer, never scheduled');
    assert.equal(entry.cron, null, 'no Host A cron cursor');
    assert.equal(entry.handlerVersion, '1');
    assert.equal(entry.maxAttempts, 4);
    assert.ok(entry.leaseMs > entry.timeoutMs);
  }
  // Posture seam: off / shadow / kill → dark skip; canary / authoritative → the
  // body is not landed yet, and the receipt says which wave lands it.
  const seen = [];
  const postures = { 'c-off': 'off', 'c-shadow': 'shadow', 'c-kill': 'kill', 'c-canary': 'canary', 'c-auto': 'authoritative' };
  const built = buildDesktopHandlerManifest({ deps: { memoryPosture: async ({ firmId, clientId }) => { seen.push([firmId, clientId]); return postures[clientId]; } } });
  const step = { run: async (_name, fn) => fn() };
  const logger = { log: () => {} };
  const outbox = built.find((e) => e.functionId === 'memory-invalidation-outbox');
  const rebuild = built.find((e) => e.functionId === 'memory-projection-rebuild');
  for (const clientId of ['c-off', 'c-shadow', 'c-kill']) {
    const out = await outbox.run({ step, logger, payload: { firm_id: 'f', client_id: clientId } });
    assert.deepEqual(out, { skipped: true, function_id: 'memory-invalidation-outbox', posture: postures[clientId], reason: 'memory_model_v2_dark', lands_in: null });
  }
  assert.deepEqual(await outbox.run({ step, logger, payload: { firm_id: 'f', client_id: 'c-canary' } }),
    { skipped: true, function_id: 'memory-invalidation-outbox', posture: 'canary', reason: 'memory_worker_body_not_landed', lands_in: 'W4' });
  assert.deepEqual(await rebuild.run({ step, logger, payload: { firm_id: 'f', client_id: 'c-auto' } }),
    { skipped: true, function_id: 'memory-projection-rebuild', posture: 'authoritative', reason: 'memory_worker_body_not_landed', lands_in: 'W3' });
  assert.deepEqual(await rebuild.run({ step, logger, payload: {} }),
    { skipped: true, function_id: 'memory-projection-rebuild', posture: 'off', reason: 'memory_model_v2_dark', lands_in: null }, 'no firm in the payload: off, no plane read');
  assert.equal(seen.length, 5, 'the plane was read once per firm-bearing run');
});

test('DMEM-R1 W2: the Host A manifest surface digest is pinned (re-pin deliberately with any handler change)', () => {
  const surface = declaredHandlerSurface(manifest);
  assert.equal(manifest.length, 25, 'the declared handler count');
  assert.ok(surface.some((h) => h.function_id === 'memory-invalidation-outbox') && surface.some((h) => h.function_id === 'memory-projection-rebuild'));
  assert.equal(hostDigest(surface), HOST_A_MANIFEST_SURFACE_DIGEST, `the manifest surface changed: ${JSON.stringify(surface)}`);
});
