// localScheduler + durableStep — behavioral tests over an in-memory queue
// (the scheduler's deps seam), with a controllable clock. What must hold:
//   - first boot baselines cron state and fires nothing (no install backfill);
//   - a slept-through backlog collapses to ONE catch-up job (bounded catch-up);
//   - the durable step shim memoizes across a retried job, so a retry skips
//     completed steps and re-runs only the failed one;
//   - per-function concurrency is respected; failures back off exponentially.

import test from 'node:test';
import assert from 'node:assert/strict';

import { createLocalScheduler, retryBackoffMs } from './localScheduler.js';
import { makeDurableStep } from './durableStep.js';
import { LocalJobDeferred } from './localJobQueue.js';
import { buildDesktopHandlerManifest } from './handlerManifest.js';

// In-memory queue implementing the scheduler's deps seam.
const makeMemoryQueue = () => {
  const jobs = [];
  const steps = new Map(); // `${jobId}:${stepKey}` -> result
  const cronState = new Map();
  let nextId = 1;
  const clock = { now: new Date('2026-08-02T12:00:30Z') };

  const active = (dedupeKey) =>
    jobs.find((j) => j.dedupe_key === dedupeKey && ['pending', 'running'].includes(j.status));

  return {
    jobs, steps, cronState, clock,
    deps: {
      enqueueLocalJob: async ({ functionId, payload, dedupeKey, runAt, maxAttempts, handlerVersion }) => {
        if (dedupeKey && active(dedupeKey)) return null;
        const job = {
          id: nextId++, function_id: functionId, payload, dedupe_key: dedupeKey,
          run_at: new Date(runAt || clock.now), attempt_count: 0,
          max_attempts: maxAttempts, status: 'pending', handler_version: handlerVersion,
          last_error: null
        };
        jobs.push(job);
        return job;
      },
      claimNextLocalJob: async ({ eligibleFunctionIds }) => {
        const job = jobs
          .filter((j) => j.status === 'pending' && j.run_at <= clock.now
            && eligibleFunctionIds.includes(j.function_id))
          .sort((a, b) => a.run_at - b.run_at || a.id - b.id)[0];
        if (!job) return null;
        job.status = 'running';
        job.attempt_count += 1;
        return { ...job };
      },
      completeLocalJob: async ({ jobId, result }) => {
        const job = jobs.find((j) => j.id === jobId && j.status === 'running');
        if (!job) return null;
        job.status = 'succeeded';
        job.result = result;
        return { ...job };
      },
      failLocalJob: async ({ jobId, error, retryDelayMs }) => {
        const job = jobs.find((j) => j.id === jobId && j.status === 'running');
        if (!job) return null;
        job.last_error = String(error?.message || error);
        if (job.attempt_count >= job.max_attempts) job.status = 'dead';
        else {
          job.status = 'pending';
          job.run_at = new Date(clock.now.getTime() + retryDelayMs);
        }
        return { ...job };
      },
      recoverAbandonedLocalJobs: async () => [],
      listLocalCronState: async () =>
        [...cronState.entries()].map(([function_id, last_enqueued_tick]) => ({ function_id, last_enqueued_tick })),
      setLocalCronState: async ({ functionId, lastEnqueuedTick }) => {
        cronState.set(functionId, lastEnqueuedTick);
      },
      pruneFinishedLocalJobs: async () => 0,
      makeDurableStep: ({ jobId }) => makeDurableStep({
        jobId,
        client: null,
        deps: {
          getLocalStepResult: async ({ jobId: j, stepKey }) =>
            steps.has(`${j}:${stepKey}`)
              ? { found: true, result: steps.get(`${j}:${stepKey}`) }
              : { found: false, result: null },
          saveLocalStepResult: async ({ jobId: j, stepKey, result }) => {
            steps.set(`${j}:${stepKey}`, result);
            return true;
          },
          deleteLocalStepResult: async ({ jobId: j, stepKey }) => (steps.delete(`${j}:${stepKey}`) ? 1 : 0)
        }
      })
    }
  };
};

const makeScheduler = (mq, manifest, overrides = {}) =>
  createLocalScheduler({
    manifest,
    client: {},
    logger: { log: () => {}, warn: () => {}, error: () => {} },
    now: () => mq.clock.now,
    random: () => 0.5, // jitter factor 1.0 — deterministic backoff
    deps: mq.deps,
    ...overrides
  });

const entry = (overrides = {}) => ({
  functionId: 'test-fn', kind: 'inngest-cron', cron: '0 * * * *',
  maxAttempts: 1, concurrency: 1, leaseMs: 60_000, timeoutMs: 60_000,
  handlerVersion: '1', run: async () => 'ok',
  ...overrides
});

test('first boot baselines cron state without firing anything', async () => {
  const mq = makeMemoryQueue();
  const s = makeScheduler(mq, [entry()]);
  await s.start();
  await s.tickOnce();
  await s.stop();
  assert.equal(mq.jobs.length, 0, 'no install-time backfill');
  assert.ok(mq.cronState.has('test-fn'), 'baseline persisted');
});

test('a slept-through backlog collapses to exactly one catch-up job', async () => {
  const mq = makeMemoryQueue();
  const runs = [];
  const s = makeScheduler(mq, [entry({
    run: async ({ payload }) => { runs.push(payload.tick); return 'ok'; }
  })]);
  await s.start();
  await s.tickOnce();

  // Sleep 26 hours past 26 hourly ticks.
  mq.clock.now = new Date('2026-08-03T14:00:30Z');
  await s.tickOnce();
  await s.stop();

  const jobsForFn = mq.jobs.filter((j) => j.function_id === 'test-fn');
  assert.equal(jobsForFn.length, 1, 'one catch-up job, not 26');
  assert.equal(jobsForFn[0].dedupe_key, 'test-fn@2026-08-03T14:00:00.000Z');
  assert.equal(jobsForFn[0].status, 'succeeded');
  assert.deepEqual(runs, ['2026-08-03T14:00:00.000Z'], 'the LATEST missed tick runs');
});

test('queue activity is reported after abandoned-lease recovery and durable job settlement', async () => {
  const mq = makeMemoryQueue();
  const activities = [];
  let recovered = false;
  mq.deps.recoverAbandonedLocalJobs = async () => {
    if (recovered) return [];
    recovered = true;
    return [{ id: 91, function_id: 'test-fn', status: 'dead' }];
  };
  const s = makeScheduler(mq, [entry()], {
    onQueueActivity: async (activity) => activities.push(activity)
  });
  await s.start();
  mq.clock.now = new Date('2026-08-02T13:00:10Z');
  await s.tickOnce();
  await s.stop();

  assert.deepEqual(activities.map(({ kind }) => kind), ['leases_recovered', 'job_settled']);
  assert.deepEqual(activities[0].jobs, [{ job_id: 91, function_id: 'test-fn', status: 'dead' }]);
  assert.equal(activities[1].function_id, 'test-fn');
  assert.equal(activities[1].status, 'succeeded');
});

test('the same tick never double-enqueues across restarts (dedupe + persisted state)', async () => {
  const mq = makeMemoryQueue();
  const s1 = makeScheduler(mq, [entry()]);
  await s1.start();
  mq.clock.now = new Date('2026-08-02T13:00:10Z');
  await s1.tickOnce();
  await s1.stop();
  assert.equal(mq.jobs.length, 1);

  // Restart: cron state reloads from persistence; the tick is already covered.
  const s2 = makeScheduler(mq, [entry()]);
  await s2.start();
  await s2.tickOnce();
  await s2.stop();
  assert.equal(mq.jobs.length, 1, 'no duplicate for an already-enqueued tick');
});

test('durable step memoizes across a retry: completed steps skip, the failed one re-runs', async () => {
  const mq = makeMemoryQueue();
  const stepRuns = { a: 0, b: 0 };
  let failFirst = true;
  const s = makeScheduler(mq, [entry({
    maxAttempts: 2,
    run: async ({ step }) => {
      await step.run('a', async () => { stepRuns.a += 1; return 'a-result'; });
      return step.run('b', async () => {
        stepRuns.b += 1;
        if (failFirst) { failFirst = false; throw new Error('transient'); }
        return 'b-result';
      });
    }
  })]);
  await s.start();
  mq.clock.now = new Date('2026-08-02T13:00:10Z');
  await s.tickOnce(); // enqueue + claim + first attempt (fails at step b)
  await s.stop();

  let job = mq.jobs[0];
  assert.equal(job.status, 'pending', 'transient failure returns to pending');
  assert.equal(job.last_error, 'transient');

  // Advance past the backoff and let the retry run (same scheduler, restarted).
  mq.clock.now = new Date(job.run_at.getTime() + 1000);
  await s.start();
  await s.tickOnce();
  await s.stop();

  job = mq.jobs[0];
  assert.equal(job.status, 'succeeded');
  assert.equal(stepRuns.a, 1, 'step a ran once — the retry replayed the memoized result');
  assert.equal(stepRuns.b, 2, 'step b re-ran on the retry');
});

test('attempts exhausted → dead-letter, with exponential backoff before that', async () => {
  const mq = makeMemoryQueue();
  const s = makeScheduler(mq, [entry({
    maxAttempts: 2,
    run: async () => { throw new Error('always down'); }
  })]);
  await s.start();
  mq.clock.now = new Date('2026-08-02T13:00:10Z');
  await s.tickOnce();

  let job = mq.jobs[0];
  assert.equal(job.status, 'pending');
  const firstDelay = job.run_at.getTime() - mq.clock.now.getTime();
  assert.equal(firstDelay, 30_000, 'attempt 1 backs off 30s (jitter pinned to 1.0)');

  mq.clock.now = new Date(job.run_at.getTime() + 1000);
  await s.tickOnce();
  await s.stop();
  job = mq.jobs[0];
  assert.equal(job.status, 'dead', 'attempts exhausted rests at dead — never limbo');
  assert.equal(job.last_error, 'always down');
});

test('per-function concurrency 1: a second due job for the same function waits', async () => {
  const mq = makeMemoryQueue();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const s = makeScheduler(mq, [entry({ cron: '* * * * *', run: () => gate })], { maxConcurrent: 4 });
  await s.start();
  mq.clock.now = new Date('2026-08-02T12:01:05Z');
  await s.tickOnce(); // enqueues + claims the first job; handler blocks on the gate
  assert.equal(s.inFlightCount(), 1);

  mq.clock.now = new Date('2026-08-02T12:02:05Z');
  await s.tickOnce(); // a second tick is due, but the function is saturated
  assert.equal(s.inFlightCount(), 1, 'second job not claimed while the first runs');
  assert.equal(mq.jobs.filter((j) => j.status === 'pending').length, 1);

  release('ok');
  await s.stop();
  assert.equal(mq.jobs.filter((j) => j.status === 'succeeded').length, 1);
});

test('a job whose function is no longer in the manifest dead-letters visibly', async () => {
  const mq = makeMemoryQueue();
  await mq.deps.enqueueLocalJob({
    functionId: 'ghost-fn', payload: {}, dedupeKey: null, runAt: mq.clock.now, maxAttempts: 1, handlerVersion: '1'
  });
  // The claim seam returns ghost-fn even though the manifest lacks it (the
  // real SQL claim is scoped to eligible ids, but a rename between builds
  // can leave a claimed row behind — the scheduler must not guess).
  const claim = mq.deps.claimNextLocalJob;
  mq.deps.claimNextLocalJob = async () => claim({ eligibleFunctionIds: ['ghost-fn'] });
  const s = makeScheduler(mq, [entry()]);
  await s.start();
  await s.tickOnce();
  await s.stop();
  assert.equal(mq.jobs[0].status, 'dead');
  assert.match(mq.jobs[0].last_error, /no manifest entry/);
});

test('a hung handler times out and fails rather than wedging the scheduler', async () => {
  const mq = makeMemoryQueue();
  const s = makeScheduler(mq, [entry({
    cron: '* * * * *', timeoutMs: 20,
    run: () => new Promise(() => {}) // never settles
  })]);
  await s.start();
  mq.clock.now = new Date('2026-08-02T12:01:05Z');
  await s.tickOnce();
  await s.stop(); // stop awaits the in-flight promise, which the timeout settles
  assert.equal(mq.jobs[0].status, 'dead');
  assert.match(mq.jobs[0].last_error, /timed out after 20ms/);
});

// 2026-09-13 — the execution budget: a provider call under a job is aborted
// when the job times out, so the zombie handler's late write never happens
// (the "late body writes a coding" reproduction). The handler here awaits a
// bounded provider call whose fetch never answers; the job fails on the
// scheduler's timer AND the handler settles with the typed timeout instead
// of hanging on (and later writing) forever.
test('a hung provider call under a timed-out job is aborted through the execution budget — no late write', async () => {
  const { fetchProviderJson } = await import('../providerTransport.js');
  const mq = makeMemoryQueue();
  let handlerOutcome = null;
  let wrote = 0;
  const s = makeScheduler(mq, [entry({
    cron: '* * * * *', timeoutMs: 30,
    run: async ({ budget }) => {
      assert.ok(budget?.signal, 'the job carries its budget');
      try {
        await fetchProviderJson({ provider: 'openai', url: 'u', timeoutMs: 60_000, reserveMs: 0, minAttemptMs: 0, fetchImpl: () => new Promise(() => {}) });
        wrote += 1; // the late write the budget must prevent
      } catch (error) {
        handlerOutcome = { code: error.code, reason: error.reason };
        throw error;
      }
    }
  })]);
  await s.start();
  mq.clock.now = new Date('2026-08-02T12:01:05Z');
  await s.tickOnce();
  await s.stop();
  assert.equal(mq.jobs[0].status, 'dead');
  // The budget's own deadline and the scheduler's timer fire at the same
  // instant; whichever wins, the job fails with a typed cause and the call
  // is cancelled (exhausted by the budget, or aborted by the timer).
  assert.match(mq.jobs[0].last_error, /timed out after 30ms|execution budget was (exhausted|aborted)/);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(handlerOutcome?.code, 'PROVIDER_TIMEOUT', 'the in-flight provider call was cancelled with the job');
  assert.ok(['execution_budget_aborted', 'execution_budget_exhausted'].includes(handlerOutcome?.reason), JSON.stringify(handlerOutcome));
  assert.equal(wrote, 0, 'nothing was written after the timeout');
});

test('retryBackoffMs: exponential with a cap, jitter within ±20%', () => {
  assert.equal(retryBackoffMs(1, () => 0.5), 30_000);
  assert.equal(retryBackoffMs(2, () => 0.5), 60_000);
  assert.equal(retryBackoffMs(3, () => 0.5), 120_000);
  assert.equal(retryBackoffMs(10, () => 0.5), 15 * 60_000, 'capped at 15 minutes');
  assert.equal(retryBackoffMs(1, () => 0), 24_000);
  assert.equal(retryBackoffMs(1, () => 1), 36_000);
});

// ── RT-08: deferral — a handler's "not now" spends no attempt ────────────

test('a LocalJobDeferred from a handler releases the job to run at runAt without spending an attempt', async () => {
  const mq = makeMemoryQueue();
  mq.deps.deferLocalJob = async ({ jobId, runAt, reason }) => {
    const job = mq.jobs.find((j) => j.id === jobId && j.status === 'running');
    if (!job) return null;
    job.status = 'pending';
    job.run_at = new Date(runAt);
    job.attempt_count = Math.max(0, job.attempt_count - 1);
    job.last_error = `deferred until ${new Date(runAt).toISOString()}: ${reason}`;
    return { ...job };
  };
  // A local-event job (cron null): enqueued by a route, never by a schedule.
  await mq.deps.enqueueLocalJob({
    functionId: 'test-fn', payload: { parse_run_id: 'run-1' }, dedupeKey: 'run-1',
    runAt: mq.clock.now, maxAttempts: 1, handlerVersion: '1'
  });
  let deferOnce = true;
  const attemptsSeen = [];
  const settled = [];
  const s = makeScheduler(mq, [entry({
    cron: null, kind: 'local-event', maxAttempts: 1,
    run: async ({ job }) => {
      attemptsSeen.push(job.attempt_count);
      if (deferOnce) {
        deferOnce = false;
        throw new LocalJobDeferred({
          runAt: new Date(mq.clock.now.getTime() + 300_000),
          reason: 'admission_refused:entity_readiness_failed'
        });
      }
      return 'ok';
    }
  })], { onQueueActivity: async (activity) => { settled.push(activity); } });
  await s.start();
  await s.tickOnce();
  await s.stop(); // stop() awaits the in-flight settlement (and its activity report)
  let job = mq.jobs[0];
  assert.equal(job.status, 'pending', 'deferred, not failed');
  assert.equal(job.attempt_count, 0, 'the claim-time attempt was handed back');
  assert.equal(job.run_at.getTime(), mq.clock.now.getTime() + 300_000, 'waits until the requested runAt');
  assert.match(job.last_error, /^deferred until .*: admission_refused:entity_readiness_failed$/);
  assert.deepEqual(settled.map((a) => a.status), ['deferred'], 'the settlement is reported as a deferral');

  mq.clock.now = new Date(mq.clock.now.getTime() + 60_000);
  await s.start();
  await s.tickOnce();
  await s.stop();
  assert.equal(mq.jobs[0].status, 'pending', 'not due before runAt — nothing runs');
  assert.equal(attemptsSeen.length, 1);

  mq.clock.now = new Date(job.run_at.getTime() + 1000);
  await s.start();
  await s.tickOnce();
  await s.stop();
  job = mq.jobs[0];
  assert.equal(job.status, 'succeeded', 'maxAttempts 1 was never spent by the deferral');
  assert.equal(job.attempt_count, 1);
  assert.deepEqual(attemptsSeen, [1, 1], 'both invocations were attempt 1 — a deferral is not an attempt');
});

test('the durable step forgets a memoized step on request, so a deferred job re-runs it instead of replaying its refusal', async () => {
  const mq = makeMemoryQueue();
  const step = mq.deps.makeDurableStep({ jobId: 9 });
  let runs = 0;
  const refusal = { handled: false, reason: 'admission_refused' };
  const first = await step.run('parse-and-write', async () => { runs += 1; return refusal; });
  assert.deepEqual(first, refusal);
  assert.equal(mq.steps.has('9:parse-and-write'), true, 'a RETURNED refusal is memoized like any return');
  // A repeated name within one invocation is a NEW positional key (#2) —
  // Inngest's positional hashing — so it runs; forget() drops the latest.
  assert.equal(await step.run('parse-and-write', async () => { runs += 1; return 'second-occurrence'; }), 'second-occurrence');
  assert.equal(runs, 2);
  await step.forget('parse-and-write');
  assert.equal(mq.steps.has('9:parse-and-write#2'), false, 'forget drops the LATEST occurrence of the name in this invocation');
  assert.equal(mq.steps.has('9:parse-and-write'), true, 'earlier occurrences stay');

  // The next attempt (a fresh invocation, same job): without forget it would
  // replay the memoized refusal forever.
  const replay = mq.deps.makeDurableStep({ jobId: 9 });
  assert.deepEqual(await replay.run('parse-and-write', async () => 'never'), refusal, 'memoized: the refusal replays');
  await replay.forget('parse-and-write');
  assert.equal(mq.steps.has('9:parse-and-write'), false, 'forgotten');
  const rerun = mq.deps.makeDurableStep({ jobId: 9 });
  assert.equal(await rerun.run('parse-and-write', async () => 'claimed'), 'claimed', 'the next attempt re-runs the step');
});

test('retireUndeclaredFunctions (RT-14): only the assembly that declares the whole manifest retires the residue; a subset dispatcher never does', async () => {
  const retired = [];
  const makeDeps = (base) => ({
    ...base.deps,
    retireUndeclaredLocalFunctions: async ({ declaredFunctionIds }) => {
      retired.push(declaredFunctionIds);
      return { cron_state_deleted: ['parse-cron:drain'], jobs_cancelled: [{ id: 9, function_id: 'parse-cron:drain' }] };
    }
  });
  const manifest = [
    { functionId: 'parse-cron:stuck', kind: 'parse-cron', cron: '* * * * *', maxAttempts: 1, concurrency: 1, leaseMs: 1000, timeoutMs: 1000, handlerVersion: '2', run: async () => ({}) },
    { functionId: 'parse-document', kind: 'local-event', cron: null, maxAttempts: 4, concurrency: 2, leaseMs: 1000, timeoutMs: 1000, handlerVersion: '1', run: async () => ({}) }
  ];
  const warned = [];
  const logger = { log: () => {}, warn: (line) => warned.push(line), error: () => {} };

  // A subset dispatcher (the test harness ticking one function) must not retire its siblings.
  const subset = makeMemoryQueue();
  const subsetScheduler = createLocalScheduler({
    manifest: [manifest[0]], client: {}, logger, now: () => subset.clock.now, deps: makeDeps(subset)
  });
  await subsetScheduler.initialize();
  assert.deepEqual(retired, [], 'default: nothing retired');

  // The whole-manifest assembly retires what it no longer declares, loudly.
  const whole = makeMemoryQueue();
  const scheduler = createLocalScheduler({
    manifest, client: {}, logger, now: () => whole.clock.now, deps: makeDeps(whole), retireUndeclaredFunctions: true
  });
  await scheduler.initialize();
  assert.deepEqual(retired, [['parse-cron:stuck', 'parse-document']], 'the declared set is the whole manifest, cron-less entries included');
  assert.equal(warned.length, 1);
  assert.match(warned[0], /retired undeclared functions/);
  assert.match(warned[0], /parse-cron:drain#9/);
  // Idempotent per process: a second initialize is a no-op.
  await scheduler.initialize();
  assert.equal(retired.length, 1);
});

test('a parse-cron run whose summary carries a failure rests dead with the failure as last_error, and the next tick still runs', async () => {
  const mq = makeMemoryQueue();
  const summaries = [
    { coding_convergence: { error: 'connect ECONNREFUSED 127.0.0.1:5432' } },
    { coding_convergence: { firms: [] } }
  ];
  const parseCron = buildDesktopHandlerManifest({ deps: { runParseCronTask: async () => summaries.shift() } })
    .find((e) => e.functionId === 'parse-cron:coding_convergence');
  const s = makeScheduler(mq, [{ ...parseCron, cron: '0 * * * *' }]);
  await s.start();
  mq.clock.now = new Date('2026-08-02T13:00:10Z');
  await s.tickOnce();
  await s.stop(); // awaits the in-flight settlement
  assert.equal(mq.jobs[0].status, 'dead', 'maxAttempts 1: a failed sweep rests dead, not succeeded');
  assert.match(mq.jobs[0].last_error, /PARSE_CRON_TASK_FAILED.*ECONNREFUSED/);

  await s.start(); // the scheduler is not wedged: it resumes from its cursor
  mq.clock.now = new Date('2026-08-02T14:00:10Z');
  await s.tickOnce();
  await s.stop();
  assert.equal(mq.jobs.length, 2, 'the next tick enqueued a fresh job');
  assert.equal(mq.jobs[1].status, 'succeeded');
  assert.deepEqual(mq.jobs[1].result, { coding_convergence: { firms: [] } });
});
