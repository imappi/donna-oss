// localJobQueue — the SQL layer under the desktop scheduler. Mock-client
// tests (the proposalStore convention) pin the load-bearing statement
// properties: dedupe arbiter on the partial index, SKIP LOCKED claim with
// lease + attempt increment, the retry-vs-dead CASE in fail/recovery, and
// that memoization rows are written with upsert semantics. Live behavior is
// exercised end-to-end by scripts/desktop-boot.mjs against a real Postgres.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  LocalJobDeferred, cancelLocalJob, claimNextLocalJob, completeLocalJob, deferLocalJob,
  deleteLocalStepResult, enqueueLocalJob, failLocalJob, getLocalStepResult, isLocalJobDeferral,
  pruneFinishedLocalJobs, recoverAbandonedLocalJobs, saveLocalStepResult, setLocalCronState
} from './localJobQueue.js';

const makeMockClient = (rows = []) => {
  const calls = [];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql).toLowerCase().replace(/\s+/g, ' ').trim(), params });
      return { rows, rowCount: rows.length };
    }
  };
};

test('enqueueLocalJob: dedupe arbiter targets the active partial index and returns null on conflict', async () => {
  const c = makeMockClient([]);
  const row = await enqueueLocalJob({
    client: c, functionId: 'bank-line-disposition', dedupeKey: 'bank-line-disposition@2026-08-02T13:00:00.000Z'
  });
  assert.equal(row, null, 'a dedupe conflict (no returned row) yields null');
  const [call] = c.calls;
  assert.match(call.sql, /insert into local_jobs/);
  assert.match(call.sql, /on conflict \(dedupe_key\) where dedupe_key is not null and status in \('pending', 'running'\) do nothing/);
  assert.equal(call.params[0], 'bank-line-disposition');
  assert.equal(call.params[3], 'bank-line-disposition@2026-08-02T13:00:00.000Z');
});

test('enqueueLocalJob: refuses without client or functionId', async () => {
  assert.equal(await enqueueLocalJob({ functionId: 'x' }), null);
  assert.equal(await enqueueLocalJob({ client: makeMockClient() }), null);
});

test('claimNextLocalJob: single-statement claim — skip locked, lease, attempt increment', async () => {
  const c = makeMockClient([{ id: 7, function_id: 'ledger-auto-export' }]);
  const job = await claimNextLocalJob({
    client: c, workerId: 'w1', eligibleFunctionIds: ['ledger-auto-export'], leaseMs: 60_000
  });
  assert.equal(job.id, 7);
  const [call] = c.calls;
  assert.match(call.sql, /for update skip locked/);
  assert.match(call.sql, /attempt_count = attempt_count \+ 1/);
  assert.match(call.sql, /lease_expires_at = now\(\) \+ make_interval/);
  assert.match(call.sql, /status = 'pending' and run_at <= now\(\)/);
  assert.deepEqual(call.params, ['w1', 60_000, ['ledger-auto-export']]);
});

test('claimNextLocalJob: no eligible functions → no query at all', async () => {
  const c = makeMockClient();
  assert.equal(await claimNextLocalJob({ client: c, workerId: 'w1', eligibleFunctionIds: [] }), null);
  assert.equal(c.calls.length, 0);
});

test('completeLocalJob: only transitions a running row and clears the lock', async () => {
  const c = makeMockClient([{ id: 7, status: 'succeeded' }]);
  await completeLocalJob({ client: c, jobId: 7, result: { swept: 3 } });
  const [call] = c.calls;
  assert.match(call.sql, /set status = 'succeeded'/);
  assert.match(call.sql, /where id = \$1 and status = 'running'/);
  assert.match(call.sql, /locked_by = null/);
  assert.equal(call.params[1], JSON.stringify({ swept: 3 }));
});

test('failLocalJob: retry-vs-dead is decided in SQL off attempt_count vs max_attempts', async () => {
  const c = makeMockClient([{ id: 7, status: 'pending' }]);
  await failLocalJob({ client: c, jobId: 7, error: new Error('boom'), retryDelayMs: 45_000 });
  const [call] = c.calls;
  assert.match(call.sql, /case when attempt_count >= max_attempts then 'dead' else 'pending' end/);
  assert.match(call.sql, /where id = \$1 and status = 'running'/);
  assert.equal(call.params[1], 'boom');
  assert.equal(call.params[2], 45_000);
});

test('recoverAbandonedLocalJobs: expired leases release to pending or dead-letter', async () => {
  const c = makeMockClient([{ id: 9, function_id: 'parse-cron:drain', status: 'pending' }]);
  const rows = await recoverAbandonedLocalJobs({ client: c });
  assert.equal(rows.length, 1);
  const [call] = c.calls;
  assert.match(call.sql, /where status = 'running' and lease_expires_at < now\(\)/);
  assert.match(call.sql, /case when attempt_count >= max_attempts then 'dead' else 'pending' end/);
});

test('cancelLocalJob: only a pending job can be cancelled', async () => {
  const c = makeMockClient([]);
  await cancelLocalJob({ client: c, jobId: 3 });
  assert.match(c.calls[0].sql, /where id = \$1 and status = 'pending'/);
});

test('step results: upsert on (job_id, step_key); found flag distinguishes null results', async () => {
  const c = makeMockClient([]);
  await saveLocalStepResult({ client: c, jobId: 7, stepKey: 'sweep', result: null });
  assert.match(c.calls[0].sql, /on conflict \(job_id, step_key\) do update set result = excluded.result/);

  const miss = await getLocalStepResult({ client: makeMockClient([]), jobId: 7, stepKey: 'sweep' });
  assert.deepEqual(miss, { found: false, result: null });
  const hit = await getLocalStepResult({ client: makeMockClient([{ result: null }]), jobId: 7, stepKey: 'sweep' });
  assert.deepEqual(hit, { found: true, result: null }, 'a memoized null is FOUND, not re-run');
});

test('cron state upserts by function id; prune deletes only resting states', async () => {
  const c = makeMockClient([]);
  await setLocalCronState({ client: c, functionId: 'x', lastEnqueuedTick: '2026-08-02T13:00:00.000Z' });
  assert.match(c.calls[0].sql, /on conflict \(function_id\) do update set last_enqueued_tick/);

  const p = makeMockClient([]);
  await pruneFinishedLocalJobs({ client: p, olderThanDays: 30 });
  assert.match(p.calls[0].sql, /status in \('succeeded', 'dead', 'cancelled'\)/);
});

// ── RT-08: deferral and step forgetting ─────────────────────────────────

test('deferLocalJob: back to pending at runAt with the attempt handed back — only a running row', async () => {
  const c = makeMockClient([{ id: 7, status: 'pending' }]);
  const at = new Date('2026-08-02T13:05:00.000Z');
  const row = await deferLocalJob({ client: c, jobId: 7, runAt: at, reason: 'admission_refused:entity_readiness_failed' });
  assert.equal(row.id, 7);
  const [call] = c.calls;
  assert.match(call.sql, /set status = 'pending', run_at = \$2::timestamptz, attempt_count = greatest\(0, attempt_count - 1\)/);
  assert.match(call.sql, /locked_by = null, locked_at = null, lease_expires_at = null/);
  assert.match(call.sql, /where id = \$1 and status = 'running'/);
  assert.equal(call.params[0], 7);
  assert.equal(call.params[1], at.toISOString());
  assert.equal(call.params[2], 'deferred until 2026-08-02T13:05:00.000Z: admission_refused:entity_readiness_failed');
  assert.equal(await deferLocalJob({ client: c, jobId: 7 }), null, 'a deferral needs a runAt');
  assert.equal(await deferLocalJob({ jobId: 7, runAt: at }), null, 'and a client');
});

test('LocalJobDeferred is the typed "not now"; isLocalJobDeferral recognizes it and nothing else', () => {
  const at = new Date('2026-08-02T13:05:00.000Z');
  const deferral = new LocalJobDeferred({ runAt: at, reason: 'run_owned_elsewhere:processing' });
  assert.equal(deferral.name, 'LocalJobDeferred');
  assert.equal(deferral.runAt.getTime(), at.getTime());
  assert.equal(deferral.reason, 'run_owned_elsewhere:processing');
  assert.match(deferral.message, /^deferred until 2026-08-02T13:05:00\.000Z: run_owned_elsewhere:processing$/);
  assert.equal(isLocalJobDeferral(deferral), true);
  assert.equal(isLocalJobDeferral(new Error('deferred until whenever')), false, 'a plain error is a failure, whatever it says');
  assert.equal(isLocalJobDeferral(null), false);
  assert.throws(() => new LocalJobDeferred({ runAt: 'not a date' }), /valid runAt/);
});

test('deleteLocalStepResult: forgets exactly one memoized step by (job_id, step_key)', async () => {
  const c = makeMockClient([]);
  await deleteLocalStepResult({ client: c, jobId: 7, stepKey: 'parse-and-write' });
  assert.match(c.calls[0].sql, /^delete from local_job_steps where job_id = \$1 and step_key = \$2$/);
  assert.deepEqual(c.calls[0].params, [7, 'parse-and-write']);
  assert.equal(await deleteLocalStepResult({ client: c, jobId: 7 }), 0, 'no step key, no delete');
});

test('retireUndeclaredLocalFunctions (RT-14): deletes the cron cursors and cancels the pending/dead jobs of every function the manifest no longer declares', async () => {
  const { retireUndeclaredLocalFunctions } = await import('./localJobQueue.js');
  const c = makeMockClient([{ id: 4, function_id: 'parse-cron:drain' }]);
  const result = await retireUndeclaredLocalFunctions({ client: c, declaredFunctionIds: ['parse-cron:stuck', 'parse-document'] });
  assert.equal(c.calls.length, 2);
  const [cursors, jobs] = c.calls;
  assert.match(cursors.sql, /delete from local_job_cron_state where not \(function_id = any\(\$1::text\[\]\)\) returning function_id/);
  assert.deepEqual(cursors.params, [['parse-cron:stuck', 'parse-document']]);
  assert.match(jobs.sql, /set status = 'cancelled', cancelled_at = now\(\)/);
  assert.match(jobs.sql, /where status in \('pending', 'dead'\) and not \(function_id = any\(\$1::text\[\]\)\)/);
  assert.match(jobs.sql, /function retired from the desktop manifest/);
  assert.deepEqual(result.jobs_cancelled, [{ id: 4, function_id: 'parse-cron:drain' }]);
  // Refuses to retire EVERYTHING: an empty declared list is a caller bug, not a wipe.
  const empty = makeMockClient([]);
  assert.deepEqual(await retireUndeclaredLocalFunctions({ client: empty, declaredFunctionIds: [] }), { cron_state_deleted: [], jobs_cancelled: [] });
  assert.equal(empty.calls.length, 0);
});

// ── DMEM-R1 W2: the generation-checked compare-and-swap at the claim ────────

test('claimNextLocalJob: the legacy claim (no fence) is byte-identical — same statement shape, same three params', async () => {
  const c = makeMockClient([{ id: 7 }]);
  await claimNextLocalJob({ client: c, workerId: 'w1', eligibleFunctionIds: ['x'], leaseMs: 60_000 });
  const [call] = c.calls;
  assert.deepEqual(call.params, ['w1', 60_000, ['x']]);
  assert.ok(!/claim_generation/.test(call.sql), 'no generation predicate without an expected generation');
  assert.ok(!/and id = \$/.test(call.sql), 'no job pin without a jobId');
});

test('claimNextLocalJob: with jobId + expectedClaimGeneration the swap is fenced on the row generation (INV-27)', async () => {
  const c = makeMockClient([]);
  const out = await claimNextLocalJob({ client: c, workerId: 'w1', eligibleFunctionIds: ['memory-invalidation-outbox'], leaseMs: 60_000, jobId: 42, expectedClaimGeneration: 3 });
  assert.equal(out, null, 'a stale generation (no row matched) loses the claim');
  const [call] = c.calls;
  assert.match(call.sql, /and id = \$4::bigint/);
  assert.match(call.sql, /and claim_generation = \$5::bigint/);
  assert.match(call.sql, /for update skip locked/);
  assert.match(call.sql, /set status = 'running'/);
  assert.deepEqual(call.params, ['w1', 60_000, ['memory-invalidation-outbox'], 42, 3]);
  await assert.rejects(() => claimNextLocalJob({ client: c, workerId: 'w1', eligibleFunctionIds: ['x'], expectedClaimGeneration: 0 }), /positive integer/);
});

test('bumpLocalJobClaimGeneration: advances only a PENDING job (a running one is past the fence — an in-flight conflict, never a cancellation)', async () => {
  const { bumpLocalJobClaimGeneration } = await import('./localJobQueue.js');
  const c = makeMockClient([{ id: 42, function_id: 'memory-invalidation-outbox', status: 'pending', claim_generation: '2' }]);
  const out = await bumpLocalJobClaimGeneration({ client: c, jobId: 42 });
  assert.deepEqual(out, { id: 42, function_id: 'memory-invalidation-outbox', status: 'pending', claim_generation: 2 });
  const [call] = c.calls;
  assert.match(call.sql, /set claim_generation = claim_generation \+ 1/);
  assert.match(call.sql, /where id = \$1::bigint and status = 'pending'/);
  assert.equal(await bumpLocalJobClaimGeneration({ client: makeMockClient([]), jobId: 42 }), null, 'not pending → null (in flight / finished / absent)');
  assert.equal(await bumpLocalJobClaimGeneration({ client: c }), null);
});
