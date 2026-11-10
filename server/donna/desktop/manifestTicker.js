// Deterministic dispatch over the desktop handler manifest: "N minutes pass"
// without waiting N minutes. Moved out of the appliance test harness
// (testSupport/applianceHarness.js `tick()`, RT-06) so the zero-key demo
// (scripts/demo_fi.mjs) drives the same rounds the harness drives; the
// harness now calls this.
//
// What it changes and what it does not. The runtime's own scheduler
// (localScheduler.js, built by runtimeServer.js on the wall clock) is not
// touched: production timing stays exactly what it is. A caller that wants
// virtual time stops that scheduler and builds a dispatcher here, over the
// same manifest, the same queue tables and the same handler closures, with an
// injected clock for cron ARITHMETIC (which ticks are due). Due-ness of a
// queued job is decided in SQL on the database clock (`run_at <= now()`),
// which cannot be injected, so each round first COLLAPSES the waits of
// pending jobs (run_at → now()) and reports which it collapsed.

import { createLocalScheduler } from './localScheduler.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const makeManifestClock = (start) => {
  let current = new Date(start).getTime();
  if (!Number.isFinite(current)) throw new Error('manifest ticker: `now` must be a valid date');
  return {
    now: () => new Date(current),
    set: (date) => {
      const next = new Date(date).getTime();
      if (!Number.isFinite(next)) throw new Error('manifest ticker: clock.set needs a valid date');
      current = next;
      return new Date(current);
    },
    advance: (ms) => {
      current += Number(ms) || 0;
      return new Date(current);
    }
  };
};

export const createManifestTicker = ({
  manifest,
  // `query` collapses waits and reads the ledger; `queueQuery` is what the
  // dispatcher claims and settles jobs through (the runtime's own pool) —
  // the same function when the caller has one connection source.
  query,
  queueQuery = query,
  clock,
  logger = console,
  workerId = `manifest-ticker-${process.pid}`,
  maxConcurrent = undefined,
  onQueueActivity = async () => {}
}) => {
  const rows = async (text, params) => (await query(text, params)).rows;
  const queueClient = { query: (text, params) => queueQuery(text, params) };

  const collapseQueueWaits = async (functionIds = null) => rows(
    `update local_jobs set run_at = now()
      where status = 'pending' and run_at > now()
        and ($1::text[] is null or function_id = any($1::text[]))
      returning id, function_id`,
    [functionIds]
  );

  const duePending = async (functionIds, { anyPending = false } = {}) => (await rows(
    `select count(*)::int as due from local_jobs
      where status = 'pending' and ($2::boolean or run_at <= now()) and function_id = any($1::text[])`,
    [functionIds, anyPending]
  ))[0].due;

  const tick = async ({
    advanceMs = 60_000,
    functions = null,
    collapseWaits = true,
    maxRounds = 25,
    settleTimeoutMs = 180_000,
    // A round ends when no job is DUE (the harness default). With
    // `untilNoPending` it ends only when no job is pending at all: a job
    // enqueued a few milliseconds ahead runs in this round on every run,
    // instead of in this round or the next by a race with the clock — the
    // ordering the replay demo needs to ask the same questions every time.
    untilNoPending = false
  } = {}) => {
    const startedAt = Date.now();
    const advancedTo = clock.advance(advanceMs);
    const entries = functions ? manifest.filter((entry) => functions.includes(entry.functionId)) : manifest;
    if (!entries.length) throw new Error(`manifest ticker: tick() matched no manifest entries for ${JSON.stringify(functions)}`);
    const functionIds = entries.map((entry) => entry.functionId);
    const settled = [];
    const collapsed = [];
    const dispatcher = createLocalScheduler({
      manifest: entries,
      client: queueClient,
      logger,
      workerId,
      now: clock.now,
      ...(maxConcurrent ? { maxConcurrent } : {}),
      onQueueActivity: async (activity) => {
        if (activity?.kind === 'job_settled') settled.push(activity);
        await onQueueActivity(activity);
      }
    });
    await dispatcher.initialize();
    let rounds = 0;
    try {
      while (rounds < maxRounds) {
        rounds += 1;
        if (collapseWaits) collapsed.push(...await collapseQueueWaits(functionIds));
        await dispatcher.tickOnce();
        while (dispatcher.inFlightCount() > 0) {
          if (Date.now() - startedAt > settleTimeoutMs) {
            throw new Error(`manifest ticker: tick() did not settle within ${settleTimeoutMs}ms (${dispatcher.inFlightCount()} in flight)`);
          }
          await sleep(20);
        }
        if ((await duePending(functionIds, { anyPending: untilNoPending && collapseWaits })) === 0) break;
      }
    } finally {
      await dispatcher.stop();
    }
    const jobIds = settled.map((activity) => activity.job_id);
    const jobs = jobIds.length
      ? await rows(
        `select id, function_id, status, attempt_count, max_attempts, last_error, result, run_at, completed_at
           from local_jobs where id = any($1::bigint[]) order by id`,
        [jobIds]
      )
      : [];
    return { advanced_to: advancedTo.toISOString(), functions: functionIds, rounds, jobs, collapsed };
  };

  return { tick, collapseQueueWaits };
};
