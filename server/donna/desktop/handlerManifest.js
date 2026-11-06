// The desktop handler MANIFEST (technical plan §4): the explicit declaration
// of exactly which scheduled work exists on desktop — as FUNCTIONS (RT-14,
// audit F-09 / F-10). Every entry's `run` is a callable closure that invokes
// the handler in-process through the durable step shim; nothing here dials
// the runtime's own router, and nothing here reads a cloud descriptor.
//
// Four kinds:
//
// 1. 'inngest-cron' — the Inngest cron functions (server/donna/inngest/*).
//    Each entry drives the module's EXPORTED runner through the step shim —
//    the same one-line handler body the cloud function wraps — and passes the
//    job payload through, so a payload-scoped job (RT-10's machine re-run
//    lane enqueues one for the disposition sweeps with firm / client /
//    target) sweeps its target rather than every enrolled client. The
//    manifest test pins every entry's id/cron/retries against
//    `registeredInngestFunctions`, so a drifted schedule fails CI rather than
//    silently diverging. The ledger mirror sweeps (`NONE_ADAPTER_FUNCTION_IDS`)
//    are scheduled only when the firm's accounting adapter is not 'none'
//    (audit F-19): the assembly resolves that from the book at boot; a
//    restart after connecting Xero/QBO schedules them.
//
// 2. 'parse-cron' — the parse-cron task family (api.js `runParseCronTask`,
//    the same runner the cloud's /documents/parse-cron route calls). The
//    cloud schedules these through vercel.json's `crons:`; the appliance
//    schedules them from DESKTOP_PARSE_CRON_SCHEDULE below and calls the
//    runner directly. vercel.json is NOT a runtime input any more — the
//    manifest test reads it as a TEST input and pins the two tables against
//    each other (same tasks, same schedules), with every task the cloud runs
//    that the appliance deliberately does not named in
//    CLOUD_ONLY_PARSE_CRON_TASKS with its reason. The outbox is NOT one of
//    them since RT-14b: on the appliance `?task=outbox` requeues the local
//    parse job for a pending row whose register-time enqueue left none (the
//    producer fork, dedupe_key = parse_run_id), so the register route's
//    "the sweeper picks this up" holds on both hosts. Until RT-14 each of these
//    was an 'http-cron' entry that fetched the router over the Unix socket
//    with the runtime's own access token and a Vercel-shaped budget; the
//    HTTP hop, the token, and the budget are gone with it.
//
// 3. 'local-event' — the per-document parse (RT-08 — audit F-02, F-09,
//    F-10). `parse-document` is a cron-less local_jobs function: the
//    register / retry-parse / resolve-duplicate routes enqueue one job per
//    parse run (dedupe_key = parse_run_id, desktop/parseDocumentJob.js) and
//    the entry runs the exported Inngest handler through the step shim, so a
//    retry after a killed post-parse leg replays the memoized
//    `parse-and-write` and re-runs the leg alone. The queue owns retries
//    (four attempts, decision D7); a refused readiness claim defers the job
//    instead of spending one. The drain that RT-08 kept for one release as a
//    backstop has no desktop entry any more (RT-14): the job IS the owner of
//    every parse run on the appliance; the cloud keeps its drain.
//
// 4. 'desktop-cron' — desktop-native scheduled work with no cloud
//    counterpart: the daily backup package, and (RT-13) the nightly
//    convergence drift receipt over the persisted two-terminal verdict.
//
// DMEM-R1 W2 (2026-09-04) adds the memory plane's two workers as 'local-event'
// entries, DARK: `memory-invalidation-outbox` (the INV-27 dispatch worker over
// the generation-checked claim — a correction's invalidation / recomputation
// work, doctrine §2.6) and `memory-projection-rebuild` (the deterministic
// rebuild of memory_projections from confirmed claim revisions, doctrine §2.4).
// Neither has a schedule (cron null — enqueued by their W3 / W4 writers, never a
// Host A cron cursor) and neither has a body yet: each resolves the
// MEMORY_MODEL_V2 posture for its payload's client through the ONE resolver and
// returns a receipted skip — `memory_model_v2_dark` when the posture does not
// act, `memory_worker_body_not_landed` when it does (W3 lands the rebuild, W4
// the outbox drain). They are declared now because the manifest is the
// appliance's closed declaration of scheduled work (Host A pins its digest):
// a worker that appears in the manifest the day it gains a body would be an
// undeclared handler until then. DMEM_MEMORY_WORKER_FUNCTION_IDS names them.
//
// Marketing-lane handlers (marketing-prospects-due, marketing-reply-triage)
// are NOT in the manifest — per the plan, "not bundled-then-disabled; not in
// the manifest at all." Desktop is the customer's books, not Kari's funnel.
// The env-dark bank-line auto-explain and rule-learning crons are not merely
// excluded: RT-14 (2026-09-02) deleted them and their gates for good.

import { parseDocumentJobDeclaration, runParseDocumentJob } from './parseDocumentJob.js';
import { convergenceDriftNightlyEntry } from '../convergenceDriftCheck.js';
import { runBankLineDisposition } from '../inngest/bankLineDisposition.js';
import { runDocumentTerminalDrainSweep } from '../inngest/documentTerminalDrain.js';
import { runConvergenceMetricsDaily, runAskClockSweeps } from '../inngest/convergenceClocks.js';
import { runLedgerAutoExportSweep } from '../inngest/ledgerAutoExport.js';
import { runLedgerMirrorVerifySweep } from '../inngest/ledgerMirrorVerify.js';
import { runLlmDecisionRetentionSweep } from '../inngest/llmDecisionRetention.js';
import { runOutboundActionsDueSweep } from '../inngest/outboundActionsDue.js';
import { runOutboundMetricsRollup } from '../inngest/outboundMetricsRollup.js';
import { runOutboundOwnerDigestSweep } from '../inngest/outboundOwnerDigest.js';

// DMEM-R1 W2 — the memory plane's dark workers (see the header).
export const DMEM_MEMORY_WORKER_FUNCTION_IDS = Object.freeze([
  'memory-invalidation-outbox',
  'memory-projection-rebuild'
]);

export const DESKTOP_EXCLUDED_FUNCTION_IDS = Object.freeze([
  'marketing-prospects-due',
  'marketing-reply-triage'
]);

// Scheduled only when the firm's accounting adapter is not 'none' (F-19).
// Both sweeps enumerate clients whose CHOSEN system has a connected row and
// skip with a receipt otherwise; on a Donna-ledger book that receipt was the
// whole tick, every night. Not scheduled beats receipted-skip.
export const NONE_ADAPTER_FUNCTION_IDS = Object.freeze([
  'ledger-mirror-verify',
  'ledger-auto-export'
]);

const DEFAULT_LEASE_MS = 10 * 60_000;
// The scheduler's zombie cut for a sweep tick: a handler that has not
// returned in five minutes fails the job (retry / next tick) and its late
// writes stay safe by handler-level gating, exactly as under Inngest. Not a
// platform budget — no function cap sits under the appliance any more.
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

// Cron defaults mirror the function modules' own env||default lines; the
// manifest test pins them against the live Inngest registrations.
const INNGEST_CRON_ENTRIES = [
  { functionId: 'bank-line-disposition', cron: () => process.env.BANK_LINE_DISPOSITION_CRON || '0 * * * *', stepName: 'sweep', runner: runBankLineDisposition },
  { functionId: 'document-terminal-drain', cron: () => process.env.DOCUMENT_TERMINAL_DRAIN_CRON || '15 * * * *', stepName: 'sweep', runner: runDocumentTerminalDrainSweep },
  { functionId: 'convergence-metrics-daily', cron: () => process.env.CONVERGENCE_METRICS_CRON || '0 4 * * *', stepName: 'sample', runner: runConvergenceMetricsDaily },
  { functionId: 'ask-clock-sweeps-daily', cron: () => process.env.ASK_CLOCK_SWEEP_CRON || '30 4 * * *', stepName: 'sweep', runner: runAskClockSweeps },
  { functionId: 'ledger-auto-export', cron: () => process.env.LEDGER_AUTO_EXPORT_CRON || '23 4 * * *', stepName: 'sweep', runner: runLedgerAutoExportSweep },
  { functionId: 'ledger-mirror-verify', cron: () => process.env.LEDGER_MIRROR_VERIFY_CRON || '47 3 * * *', stepName: 'sweep', runner: runLedgerMirrorVerifySweep },
  { functionId: 'llm-decision-retention', cron: () => process.env.LLM_DECISION_RETENTION_CRON || '40 3 * * *', stepName: 'sweep', runner: runLlmDecisionRetentionSweep },
  { functionId: 'outbound-actions-due', cron: () => process.env.OUTBOUND_ACTIONS_DUE_CRON || '20 * * * *', stepName: 'sweep', runner: runOutboundActionsDueSweep },
  { functionId: 'outbound-metrics-rollup', cron: () => process.env.OUTBOUND_METRICS_ROLLUP_CRON || '10 2 * * *', stepName: 'rollup', runner: runOutboundMetricsRollup },
  { functionId: 'outbound-owner-digest', cron: () => process.env.OUTBOUND_OWNER_DIGEST_CRON || '40 13 * * *', stepName: 'digest', runner: runOutboundOwnerDigestSweep }
];

// The appliance's schedule for the parse-cron task family — the SAME tasks
// and the SAME schedules the cloud runs through vercel.json (pinned by the
// manifest test, both ways), minus the tasks named cloud-only below. The
// task names are api.js SUPPORTED_CRON_TASKS members; the runner is
// api.js `runParseCronTask`, called in-process.
export const DESKTOP_PARSE_CRON_SCHEDULE = Object.freeze([
  // RT-14b: a pending row with no job-exists receipt (a register-time enqueue
  // that failed, or a stamp that did) gets its `parse-document` job through
  // the producer fork — one job per run, dedupe_key = parse_run_id — and is
  // named in `summary.outbox.requeued`. A minute is the wait a human accepts
  // for an upload that "did not start"; the cloud runs the same cadence.
  Object.freeze({ task: 'outbox', cron: '* * * * *' }),
  // Fail rows stuck in `processing` past the heartbeat threshold, then sweep
  // owner-media terminal summaries for the rows the flip left chat-silent.
  Object.freeze({ task: 'stuck', cron: '* * * * *' }),
  // The goal-first loop's drain + dispatch tick (S3): owner-fact lines
  // become drafted asks here; the appliance is the ONLY deployment where
  // nobody can drive it by hand.
  Object.freeze({ task: 'loops_inbox', cron: '* * * * *' }),
  // The batch-coder re-drive + the CODING_AUTO_POST sweep, bounded per tick.
  Object.freeze({ task: 'coding_convergence', cron: '*/5 * * * *' }),
  // Evidence-store orphan cleanup (the local blob store on the appliance).
  Object.freeze({ task: 'storage_orphans', cron: '0 3 * * *' }),
  // The daily convergence-metrics sampler (Slice J).
  Object.freeze({ task: 'convergence_snapshot', cron: '0 2 * * *' }),
  // The jurisdiction-neutral statutory sweep, daily and hourly cadences.
  Object.freeze({ task: 'statutory_watches', cron: '15 4 * * *' }),
  Object.freeze({ task: 'statutory_watches_hourly', cron: '45 * * * *' }),
  // Evidence-topic reminders (plane-gated per client; inert until staged).
  Object.freeze({ task: 'evidence_topic_reminders', cron: '0 8 * * *' }),
  // Canonical-role resolution for Donna-ledger ('none') clients whose chart
  // grows at posting time.
  Object.freeze({ task: 'canonical_role_resolution', cron: '30 7 * * *' })
]);

// Tasks the cloud schedules that the appliance deliberately does not.
export const CLOUD_ONLY_PARSE_CRON_TASKS = Object.freeze({
  drain: 'Runs the parse worker inline for pending rows the event transport dropped. On the appliance parse is a local job (RT-08) and the one-release backstop entry is deleted (RT-14); the cloud keeps its drain and its Vercel budgets.'
});

// Desktop-native scheduled work (kind 'desktop-cron') — work with no cloud
// counterpart. The daily backup package (plan §8): create → verify → rotate,
// through the step shim so a retry after a crash mid-rotation skips the
// already-verified create. Skips with a receipt when the host isn't
// configured for backups (headless runs without a data dir).
const desktopBackupDailyEntry = () => ({
  functionId: 'desktop-backup-daily',
  kind: 'desktop-cron',
  cron: process.env.DONNA_DESKTOP_BACKUP_CRON || '30 1 * * *',
  maxAttempts: 2,
  concurrency: 1,
  leaseMs: 30 * 60_000, // a large book's pg_dump is slow; the lease must outlive it
  timeoutMs: 30 * 60_000,
  handlerVersion: '1',
  run: async ({ step, logger }) => {
    const backupsDir = process.env.DONNA_DESKTOP_BACKUP_DIR || null;
    const blobDir = process.env.DONNA_DESKTOP_BLOB_DIR || null;
    const databaseUrl = process.env.DATABASE_URL || null;
    if (!backupsDir || !blobDir || !databaseUrl) {
      return { skipped: true, reason: 'backup_env_not_configured' };
    }
    const { createBackupPackage, rotateBackupPackages } = await import('./backupPackage.js');
    const { findPgBin } = await import('./pgSupervisor.js');
    const pgBin = findPgBin();
    const created = await step.run('create-and-verify', async () => {
      const result = await createBackupPackage({
        backupsDir, blobDir, pgBin, databaseUrl, reason: 'daily', logger
      });
      return { packageDir: result.packageDir, blob_count: result.manifest.blob_count };
    });
    const rotated = await step.run('rotate', () =>
      rotateBackupPackages({
        backupsDir, keep: Number(process.env.DONNA_DESKTOP_BACKUP_KEEP || 14), logger
      })
    );
    return { ...created, rotated: rotated.deleted?.length || 0, rotation_skipped: rotated.skipped || null };
  }
});

// DMEM-R1 W2 — the dark memory workers. `deps.memoryPosture` is the test seam
// (an async ({ firmId, clientId }) → posture); the default reads the plane
// through readMemoryModelV2PostureForClient on the firm pool, lazily imported so
// the manifest stays buildable by scripts that never open a database.
const memoryWorkerEntry = ({ functionId, landsIn, deps }) => ({
  functionId,
  kind: 'local-event',
  cron: null,
  maxAttempts: 4,
  concurrency: 1,
  leaseMs: DEFAULT_LEASE_MS,
  timeoutMs: DEFAULT_TIMEOUT_MS,
  handlerVersion: '1',
  run: async ({ step, logger, payload }) => step.run('posture', async () => {
    const firmId = payload?.firm_id || null;
    const clientId = payload?.client_id || null;
    let posture = 'off';
    if (firmId) {
      if (typeof deps.memoryPosture === 'function') {
        posture = await deps.memoryPosture({ firmId, clientId });
      } else {
        const [{ readMemoryModelV2PostureForClient }, { withFirmDbClient }] = await Promise.all([
          import('../memoriesDb.js'),
          import('../firmDb.js')
        ]);
        posture = await withFirmDbClient((client) => readMemoryModelV2PostureForClient({ client, firmId, clientId }));
      }
    }
    const acts = posture === 'canary' || posture === 'authoritative';
    const receipt = {
      skipped: true,
      function_id: functionId,
      posture,
      reason: acts ? 'memory_worker_body_not_landed' : 'memory_model_v2_dark',
      lands_in: acts ? landsIn : null
    };
    logger?.log?.(`[desktop-scheduler] ${functionId} → ${receipt.reason} (posture ${posture})`);
    return receipt;
  })
});

// The parse-cron runner is imported lazily: api.js is the whole router and
// the manifest is also built by scripts that never serve a request. The
// module cache makes the second call free; `deps.runParseCronTask` lets a
// test pin the wiring without loading the router at all.
const loadParseCronRunner = async () => (await import('../api.js')).runParseCronTask;

// `ledgerAdapterConnected`: the assembly answers it from the book at boot
// (any live client whose profile.accounting_system is not 'none'); default
// true so a caller that cannot read the book (the CI cursor initializer)
// declares the superset and the sweeps' own receipted skip still governs.
// `deps`: test seams only — `runParseCronTask` (the parse-cron runner) and
// `runners` (an inngest-cron runner by function id).
export const buildDesktopHandlerManifest = ({ ledgerAdapterConnected = true, deps = {} } = {}) => {
  const entries = INNGEST_CRON_ENTRIES
    .filter(({ functionId }) => ledgerAdapterConnected || !NONE_ADAPTER_FUNCTION_IDS.includes(functionId))
    .map(({ functionId, cron, stepName, runner }) => {
      const run = deps.runners?.[functionId] || runner;
      return {
        functionId,
        kind: 'inngest-cron',
        cron: cron(),
        maxAttempts: 1, // every cron function declares retries: 0 today
        concurrency: 1,
        leaseMs: DEFAULT_LEASE_MS,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        handlerVersion: '1',
        // The payload rides through: a cron tick carries { tick }, a
        // machine re-run job carries { firm_id, client_id, target_type,
        // target_id, attempt } and the runner scopes itself to it.
        run: ({ step, logger, payload }) => step.run(stepName, () => run({ logger, payload }))
      };
    });

  for (const { task, cron } of DESKTOP_PARSE_CRON_SCHEDULE) {
    entries.push({
      functionId: `parse-cron:${task}`,
      kind: 'parse-cron',
      cron,
      maxAttempts: 1, // the next tick is the retry, as on Vercel
      concurrency: 1,
      leaseMs: DEFAULT_LEASE_MS,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      handlerVersion: '2', // RT-14: in-process call (was an HTTP self-call)
      run: async ({ step, logger }) => {
        const runTask = deps.runParseCronTask || await loadParseCronRunner();
        const summary = await step.run('task', () => runTask({ task, logger }));
        logger?.log?.(`[desktop-scheduler] parse-cron ${task} → ${Object.keys(summary || {}).join(',') || 'empty'}`);
        return summary;
      }
    });
  }

  // The per-document parse (RT-08): enqueued by the routes, never by a
  // schedule — `cron: null` keeps it out of the cron cursors Host A pins.
  entries.push({ ...parseDocumentJobDeclaration(), run: runParseDocumentJob });

  entries.push(desktopBackupDailyEntry());

  // RT-13 — the nightly convergence drift receipt (kind 'desktop-cron', no
  // cloud counterpart): re-derives every row's two-terminal verdict and
  // reports where the persisted column disagrees; never rewrites.
  entries.push(convergenceDriftNightlyEntry());

  // DMEM-R1 W2 — the memory plane's dark workers (declared, cron-less, bodiless).
  entries.push(memoryWorkerEntry({ functionId: 'memory-invalidation-outbox', landsIn: 'W4', deps }));
  entries.push(memoryWorkerEntry({ functionId: 'memory-projection-rebuild', landsIn: 'W3', deps }));

  return entries;
};
