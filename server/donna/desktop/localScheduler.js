// The desktop local durable scheduler (technical plan §4) — the dispatcher
// that replaces Inngest Cloud + Vercel's cron runner on desktop. One
// instance per app; it owns three loops on a single timer:
//
//   1. cron enqueue — for each manifest entry, enqueue a job when a tick
//      comes due. Catch-up after sleep is BOUNDED: at most the LATEST missed
//      tick is enqueued (dedupe-keyed by function id + tick), never the
//      backlog. Cron state is loaded once and then owned in memory (single
//      dispatcher), written through to local_job_cron_state.
//   2. claim/execute — claim due jobs up to the global and per-function
//      concurrency caps, run them with the durable step shim, then
//      complete/fail (exponential backoff with jitter; dead-letter on
//      exhausted attempts).
//   3. recovery — periodically release expired leases (crash, force-quit,
//      slept past the lease) back to pending or dead, then give each dead
//      scheduled tick with no success since a prompt, bounded recovery tick
//      (localJobQueue.js, "Prompt recovery of a dead scheduled tick"):
//      planned from the stored dead row, never from memory, so a restart or
//      a sleep neither loses nor multiplies it. A scheduled slot that comes
//      due while a recovery is pending is absorbed by it; while one is
//      running the slot waits for it (the cursor holds), so recovery never
//      puts two live ticks of one function on the queue.
//
// Timeouts mirror the cloud bounds: on expiry the job FAILS (retry/dead) and
// the zombie handler's late writes stay safe the same way they do under
// Inngest — handler-level gating (e.g. parse_run_id), not scheduler magic.
//
// Retirement (RT-14): the assembly that declares the whole manifest passes
// `retireUndeclaredFunctions: true`; initialize then deletes the cron cursor
// and cancels the pending / dead jobs of every function this build no longer
// declares (the drain's desktop entry, the env-dark crons, a ledger sweep on
// a 'none' book) — the residue Host A would otherwise report as
// unexpected_cron_state / dead_unsuperseded on every boot after an upgrade.
//
// Wall-clock discipline: due-ness comparisons happen in SQL (`run_at <=
// now()`) on the DB clock; cron tick computation uses the injected `now`
// (UTC arithmetic). A backwards clock jump therefore pauses cron enqueue
// rather than double-firing (the dedupe key catches the re-walk forward).
//
// Deferral (RT-08): a handler may throw LocalJobDeferred (localJobQueue.js)
// to say "not now — at T". The lease is released, the job returns to pending
// at T and the attempt is handed back; nothing else about the job changes.
// The parse worker uses it for an entity-readiness hold and for a run still
// owned by a zombie attempt — neither is this job's failure.
//
// Starvation (RT-08, plan step 5): the per-document parse is now a job with
// its own concurrency (2 by default) inside the global `maxConcurrent` (4).
// Claim order is `run_at, id` across every ELIGIBLE function — plain FIFO,
// no priority classes. A long parse cannot starve the cron ticks because a
// function that holds its concurrency drops out of the eligible set until
// one of its jobs settles, so two slots always remain for everything else;
// and a parse that hangs is cut by its own timeout, not by a neighbour.
// Priority classes were considered and rejected: the crons are a minute
// apart and idempotent (a late tick costs nothing), while a priority scheme
// would need a starvation guard of its own.

import { previousCronOccurrence } from './cronSchedule.js';
import { makeDurableStep } from './durableStep.js';
import { createExecutionBudget, runWithExecutionBudget } from '../executionBudget.js';
import {
  absorbScheduledTickIntoCronRecovery, claimNextLocalJob, completeLocalJob, deferLocalJob,
  enqueueCronRecoveryTicks, enqueueLocalJob, failLocalJob, isLocalJobDeferral, listLocalCronState,
  pruneFinishedLocalJobs, recoverAbandonedLocalJobs, retireUndeclaredLocalFunctions, setLocalCronState
} from './localJobQueue.js';

const BACKOFF_BASE_MS = 30_000;
const BACKOFF_CAP_MS = 15 * 60_000;

export const retryBackoffMs = (attemptCount, random = Math.random) => {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** Math.max(0, attemptCount - 1));
  const jitter = 0.8 + random() * 0.4; // ±20%
  return Math.round(exponential * jitter);
};

export const createLocalScheduler = ({
  manifest,
  client,
  logger = console,
  workerId = `desktop-${process.pid}`,
  pollIntervalMs = 1000,
  recoverIntervalMs = 30_000,
  pruneIntervalMs = 24 * 60 * 60_000,
  maxConcurrent = 4,
  now = () => new Date(),
  random = Math.random,
  onQueueActivity = async () => {},
  // RT-14: true only for the assembly that declares the WHOLE manifest
  // (runtimeServer.js, the CI cursor initializer). On initialize it retires
  // cron cursors and pending/dead jobs of functions this build no longer
  // declares — the residue an upgrade leaves behind. A dispatcher over a
  // SUBSET of the manifest (the appliance test harness ticks one function
  // at a time) must leave the default, or it would retire its siblings.
  retireUndeclaredFunctions = false,
  deps = {}
} = {}) => {
  if (!manifest?.length) throw new Error('createLocalScheduler needs a non-empty manifest');
  if (!client) throw new Error('createLocalScheduler needs a db client');

  const q = {
    enqueueLocalJob, claimNextLocalJob, completeLocalJob, failLocalJob, deferLocalJob,
    recoverAbandonedLocalJobs, listLocalCronState, setLocalCronState,
    pruneFinishedLocalJobs, retireUndeclaredLocalFunctions, makeDurableStep,
    enqueueCronRecoveryTicks, absorbScheduledTickIntoCronRecovery,
    ...deps
  };

  const byFunctionId = new Map(manifest.map((entry) => [entry.functionId, entry]));
  if (byFunctionId.size !== manifest.length) throw new Error('manifest has duplicate function ids');

  const cronState = new Map(); // functionId -> last enqueued tick (Date)
  const inFlight = new Map(); // jobId -> { functionId, promise }
  let timer = null;
  let stopped = true;
  let ticking = false;
  let lastRecoverAt = 0;
  let lastPruneAt = 0;
  let initialized = false;
  const heldBehindRecovery = new Set(); // functionIds whose due slot waits on a running recovery (log once)

  const notifyQueueActivity = async (activity) => {
    try {
      await onQueueActivity(activity);
    } catch (error) {
      logger?.error?.(`[desktop-scheduler] queue activity observer failed: ${error?.message || error}`);
    }
  };

  const loadCronState = async () => {
    if (initialized) return;
    if (retireUndeclaredFunctions) {
      const retired = await q.retireUndeclaredLocalFunctions({
        client, declaredFunctionIds: manifest.map((entry) => entry.functionId)
      });
      if (retired.cron_state_deleted.length || retired.jobs_cancelled.length) {
        logger?.warn?.(
          `[desktop-scheduler] retired undeclared functions: cron cursors ${JSON.stringify(retired.cron_state_deleted)}, `
          + `jobs cancelled ${JSON.stringify(retired.jobs_cancelled.map((job) => `${job.function_id}#${job.id}`))}`
        );
      }
    }
    const rows = await q.listLocalCronState({ client });
    const persisted = new Map(rows.map((r) => [r.function_id, r.last_enqueued_tick]));
    const bootTime = now();
    for (const entry of manifest) {
      if (!entry.cron) continue;
      const existing = persisted.get(entry.functionId);
      if (existing) {
        cronState.set(entry.functionId, new Date(existing));
      } else {
        // First boot for this function: baseline at "now" — no backfill of
        // ticks from before the install (bounded catch-up starts here).
        cronState.set(entry.functionId, bootTime);
        await q.setLocalCronState({
          client, functionId: entry.functionId, lastEnqueuedTick: bootTime.toISOString()
        });
      }
    }
    initialized = true;
  };

  const enqueueDueCronJobs = async () => {
    const at = now();
    for (const entry of manifest) {
      if (!entry.cron) continue;
      const last = cronState.get(entry.functionId);
      const latestDue = previousCronOccurrence(entry.cron, at);
      if (!last || latestDue <= last) continue;
      const tickIso = latestDue.toISOString();
      const recovery = await q.absorbScheduledTickIntoCronRecovery({
        client, functionId: entry.functionId, tick: tickIso
      });
      if (recovery.live && !recovery.absorbed) {
        // A recovery tick is running: the slot waits for it (cursor held).
        if (!heldBehindRecovery.has(entry.functionId)) {
          heldBehindRecovery.add(entry.functionId);
          logger?.log?.(`[desktop-scheduler] ${entry.functionId} slot ${tickIso} waits for running recovery #${recovery.live.id}`);
        }
        continue;
      }
      heldBehindRecovery.delete(entry.functionId);
      if (recovery.absorbed) {
        logger?.log?.(`[desktop-scheduler] ${entry.functionId} slot ${tickIso} is served by pending recovery #${recovery.live.id}`);
        cronState.set(entry.functionId, latestDue);
        await q.setLocalCronState({ client, functionId: entry.functionId, lastEnqueuedTick: tickIso });
        continue;
      }
      await q.enqueueLocalJob({
        client,
        functionId: entry.functionId,
        payload: { tick: tickIso },
        dedupeKey: `${entry.functionId}@${tickIso}`,
        runAt: tickIso,
        maxAttempts: entry.maxAttempts ?? 1,
        handlerVersion: entry.handlerVersion ?? '1'
      });
      cronState.set(entry.functionId, latestDue);
      await q.setLocalCronState({
        client, functionId: entry.functionId, lastEnqueuedTick: tickIso
      });
    }
  };

  // Loop 3's second half: one statement plans every due recovery tick of
  // this dispatcher's cron functions from the stored dead rows.
  const enqueueDueCronRecoveries = async () => {
    const at = now();
    const functions = manifest
      .filter((entry) => entry.cron)
      .map((entry) => ({
        functionId: entry.functionId,
        handlerVersion: entry.handlerVersion ?? '1',
        maxAttempts: entry.maxAttempts ?? 1,
        slotTick: previousCronOccurrence(entry.cron, at).toISOString()
      }));
    if (!functions.length) return [];
    const enqueued = await q.enqueueCronRecoveryTicks({ client, functions });
    for (const row of enqueued) {
      const recovers = row.payload?.recovers || {};
      logger?.warn?.(
        `[desktop-scheduler] ${row.function_id} recovery ${recovers.recovery}/${recovers.of} #${row.id} for dead tick #${recovers.dead_job_id} due ${new Date(row.run_at).toISOString()}`
      );
    }
    if (enqueued.length) {
      await notifyQueueActivity({
        kind: 'cron_recovery_enqueued',
        jobs: enqueued.map((row) => ({
          job_id: row.id,
          function_id: row.function_id,
          recovers_job_id: row.payload?.recovers?.dead_job_id ?? null,
          run_at: new Date(row.run_at).toISOString()
        }))
      });
    }
    return enqueued;
  };

  const runningCount = (functionId) => {
    let count = 0;
    for (const { functionId: fid } of inFlight.values()) if (fid === functionId) count += 1;
    return count;
  };

  const executeJob = async (job, entry) => {
    const step = q.makeDurableStep({ jobId: job.id, client });
    const timeoutMs = entry.timeoutMs ?? 300_000;
    let timeoutHandle = null;
    let settledStatus = null;
    // The job's execution budget (executionBudget.js, 2026-09-13): the same
    // deadline the timer below enforces, carried as an ambient signal so a
    // provider call anywhere under the handler is bounded by the job that
    // owns it and is ABORTED when the job times out — a hung body no longer
    // outlives its job and writes late (the zombie the header describes).
    // Wall-clock on purpose: the timer is wall-clock, and the injected `now`
    // is the cron clock, not a stopwatch.
    const budget = createExecutionBudget({ timeoutMs, now: Date.now, label: `${job.function_id}#${job.id}` });
    try {
      const result = await Promise.race([
        runWithExecutionBudget(budget, () => entry.run({ step, logger, payload: job.payload, job, budget })),
        new Promise((_, reject) => {
          // NOT unref'd: this timer must fire even if it is the last thing
          // on the loop — it is what releases a hung job's row.
          timeoutHandle = setTimeout(() => {
            budget.abort('execution_budget_aborted');
            reject(new Error(`timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
      const completed = await q.completeLocalJob({ client, jobId: job.id, result });
      settledStatus = completed?.status || 'succeeded';
      logger?.log?.(`[desktop-scheduler] ${job.function_id} #${job.id} succeeded (attempt ${job.attempt_count})`);
    } catch (error) {
      if (isLocalJobDeferral(error)) {
        // Not a failure: the handler asked to run again later. The attempt
        // the claim counted is handed back and the job waits at `runAt`.
        const deferred = await q.deferLocalJob({
          client, jobId: job.id, runAt: error.runAt, reason: error.reason
        });
        settledStatus = deferred ? 'deferred' : 'failed';
        logger?.log?.(
          `[desktop-scheduler] ${job.function_id} #${job.id} deferred until ${error.runAt.toISOString()} (${error.reason}); attempt not spent`
        );
      } else {
        const failed = await q.failLocalJob({
          client, jobId: job.id, error, retryDelayMs: retryBackoffMs(job.attempt_count, random)
        });
        settledStatus = failed?.status || 'failed';
        const disposition = failed?.status === 'dead' ? 'dead-lettered' : 'will retry';
        logger?.warn?.(
          `[desktop-scheduler] ${job.function_id} #${job.id} failed (attempt ${job.attempt_count}, ${disposition}): ${error?.message || error}`
        );
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      inFlight.delete(job.id);
      await notifyQueueActivity({
        kind: 'job_settled',
        job_id: job.id,
        function_id: job.function_id,
        status: settledStatus
      });
    }
  };

  const fillClaimSlots = async () => {
    while (inFlight.size < maxConcurrent) {
      const eligible = manifest
        .filter((entry) => runningCount(entry.functionId) < (entry.concurrency ?? 1))
        .map((entry) => entry.functionId);
      if (!eligible.length) return;
      const job = await q.claimNextLocalJob({
        client,
        workerId,
        eligibleFunctionIds: eligible,
        leaseMs: Math.max(...eligible.map((fid) => byFunctionId.get(fid)?.leaseMs ?? 600_000))
      });
      if (!job) return;
      const entry = byFunctionId.get(job.function_id);
      if (!entry) {
        // A job for a handler this build no longer declares (downgrade,
        // renamed function): dead-letter it visibly rather than guessing.
        await q.failLocalJob({ client, jobId: job.id, error: new Error(`no manifest entry for ${job.function_id}`), retryDelayMs: 0 });
        continue;
      }
      inFlight.set(job.id, { functionId: job.function_id, promise: executeJob(job, entry) });
    }
  };

  const tickOnce = async () => {
    if (ticking) return;
    ticking = true;
    try {
      const nowMs = now().getTime();
      if (nowMs - lastRecoverAt >= recoverIntervalMs) {
        lastRecoverAt = nowMs;
        const recovered = await q.recoverAbandonedLocalJobs({ client });
        for (const row of recovered) {
          logger?.warn?.(`[desktop-scheduler] recovered abandoned job ${row.function_id} #${row.id} → ${row.status}`);
        }
        if (recovered.length) {
          await notifyQueueActivity({
            kind: 'leases_recovered',
            jobs: recovered.map((row) => ({
              job_id: row.id,
              function_id: row.function_id,
              status: row.status
            }))
          });
        }
        await enqueueDueCronRecoveries();
      }
      if (nowMs - lastPruneAt >= pruneIntervalMs) {
        lastPruneAt = nowMs;
        await q.pruneFinishedLocalJobs({ client });
      }
      await enqueueDueCronJobs();
      await fillClaimSlots();
    } catch (error) {
      logger?.error?.(`[desktop-scheduler] tick failed: ${error?.message || error}`);
    } finally {
      ticking = false;
    }
  };

  const start = async () => {
    if (!stopped) return;
    await loadCronState();
    stopped = false;
    timer = setInterval(() => { tickOnce(); }, pollIntervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const stop = async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    await Promise.allSettled([...inFlight.values()].map((entry) => entry.promise));
  };

  return {
    // Boot certification needs the persisted manifest rows before it can
    // compare them, but must not claim/execute work first. This initializer
    // writes only the scheduler's recoverable cron cursors; start() reuses it.
    initialize: loadCronState,
    start,
    stop,
    tickOnce,
    inFlightCount: () => inFlight.size,
    cronStateSnapshot: () => new Map(cronState)
  };
};
