// Tests for the outbox-dispatch planner (goal-first uplift, design §10 Step 7).
// Pure / node --test only — no DB, no Inngest, no LLM, no external calls (INV-11
// trivially satisfied). Covers backoff, dead-lettering, idempotency dedup,
// per-target serialization, the concurrency cap, stuck-dispatch reclaim, and
// determinism. created_at values are epoch ms for clarity.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DISPATCH_POLICY,
  normalizeDispatchPolicy,
  backoffMs,
  planOutboxDispatch,
  LOOP_OUTBOX_STATUSES
} from './loopOutboxPlanner.js';

const row = (over = {}) => ({
  id: 'o1', firm_id: 'f1', client_id: 'c1', event_type: 'external_sync',
  object_type: null, object_id: null, payload: {}, status: 'pending',
  attempts: 0, last_error: null, created_at: 1_000, dispatched_at: null,
  ...over
});
const ids = (list) => list.map((x) => x.id);

// ---- policy + backoff -----------------------------------------------------

test('normalizeDispatchPolicy fills defaults for missing/garbage fields', () => {
  const p = normalizeDispatchPolicy({ maxAttempts: 3, maxConcurrent: 'nope', baseBackoffMs: 0 });
  assert.equal(p.maxAttempts, 3);
  assert.equal(p.maxConcurrent, DEFAULT_DISPATCH_POLICY.maxConcurrent); // 'nope' rejected
  assert.equal(p.baseBackoffMs, DEFAULT_DISPATCH_POLICY.baseBackoffMs);  // 0 rejected (>=1)
  assert.deepEqual(normalizeDispatchPolicy(), DEFAULT_DISPATCH_POLICY);
});

test('backoffMs is exponential and capped', () => {
  const policy = { baseBackoffMs: 1_000, maxBackoffMs: 8_000 };
  assert.equal(backoffMs(0, policy), 0);   // never attempted
  assert.equal(backoffMs(1, policy), 1_000);
  assert.equal(backoffMs(2, policy), 2_000);
  assert.equal(backoffMs(3, policy), 4_000);
  assert.equal(backoffMs(4, policy), 8_000);
  assert.equal(backoffMs(5, policy), 8_000); // capped
});

// ---- the happy path -------------------------------------------------------

test('planOutboxDispatch: fresh pending rows all dispatch now, in FIFO order', () => {
  const rows = [row({ id: 'b', created_at: 2_000 }), row({ id: 'a', created_at: 1_000 })];
  const plan = planOutboxDispatch({ rows, asOf: 10_000 });
  assert.deepEqual(ids(plan.ready), ['a', 'b']);
  assert.equal(plan.ready[0].attempt, 1); // attempts 0 -> this is attempt #1
  assert.deepEqual(plan.deferred, []);
  assert.deepEqual(plan.deadLettered, []);
  assert.deepEqual(plan.duplicates, []);
});

test('planOutboxDispatch: terminal rows are ignored', () => {
  const rows = [row({ id: 'done', status: 'dispatched' }), row({ id: 'gone', status: 'cancelled' }), row({ id: 'go' })];
  const plan = planOutboxDispatch({ rows, asOf: 10_000 });
  assert.deepEqual(ids(plan.ready), ['go']);
});

test('planOutboxDispatch: validates input', () => {
  assert.throws(() => planOutboxDispatch({ rows: 'x' }), /must be an array/);
  assert.throws(() => planOutboxDispatch({ rows: [{ status: 'pending' }] }), /needs an id/);
  assert.throws(() => planOutboxDispatch({ rows: [row({ status: 'weird' })] }), /unknown outbox status/);
});

// ---- dead-letter ----------------------------------------------------------

test('planOutboxDispatch: a row out of attempts is dead-lettered, never retried', () => {
  const rows = [row({ id: 'dead', status: 'failed', attempts: 5 }), row({ id: 'live', status: 'failed', attempts: 1, last_error: { at: 1_000 } })];
  const plan = planOutboxDispatch({ rows, asOf: 10_000, policy: { maxAttempts: 5 } });
  assert.deepEqual(plan.deadLettered, [{ id: 'dead', reason: 'max_attempts', attempts: 5 }]);
  assert.deepEqual(ids(plan.ready), ['live']); // backoff (1s from t=1000) long elapsed by t=10000
});

// ---- backoff --------------------------------------------------------------

test('planOutboxDispatch: a recently-failed row waits out its backoff window', () => {
  const r = row({ id: 'r', status: 'failed', attempts: 2, last_error: { at: 5_000 } });
  // backoff for attempts=2 is 2 * baseBackoffMs(1000) = 2000 -> readyAt = 7000.
  const early = planOutboxDispatch({ rows: [r], asOf: 6_000 });
  assert.deepEqual(early.ready, []);
  assert.deepEqual(early.deferred, [{ id: 'r', reason: 'backoff', readyAt: 7_000 }]);

  const onTime = planOutboxDispatch({ rows: [r], asOf: 7_000 });
  assert.deepEqual(ids(onTime.ready), ['r']);
  assert.equal(onTime.ready[0].attempt, 3); // attempts 2 -> attempt #3
});

// ---- idempotency dedup ----------------------------------------------------

test('planOutboxDispatch: duplicate idempotency keys collapse to the earliest', () => {
  const rows = [
    row({ id: 'first', created_at: 1_000, payload: { idempotencyKey: 'k' } }),
    row({ id: 'dup', created_at: 2_000, payload: { idempotencyKey: 'k' } }),
    row({ id: 'other', created_at: 3_000, payload: { idempotencyKey: 'k2' } })
  ];
  const plan = planOutboxDispatch({ rows, asOf: 10_000 });
  assert.deepEqual(ids(plan.ready).sort(), ['first', 'other']);
  assert.deepEqual(plan.duplicates, [{ id: 'dup', supersededBy: 'first', dedupKey: 'k' }]);
});

test('planOutboxDispatch: rows without a dedup key are never collapsed', () => {
  const rows = [row({ id: 'a', created_at: 1_000 }), row({ id: 'b', created_at: 2_000 })];
  const plan = planOutboxDispatch({ rows, asOf: 10_000 });
  assert.deepEqual(plan.duplicates, []);
  assert.deepEqual(ids(plan.ready), ['a', 'b']);
});

// ---- per-target serialization ---------------------------------------------

test('planOutboxDispatch: events for the same target serialize behind one head', () => {
  const rows = [
    row({ id: 'h', created_at: 1_000, object_type: 'transaction', object_id: 't1' }),
    row({ id: 'tail', created_at: 2_000, object_type: 'transaction', object_id: 't1' }),
    row({ id: 'elsewhere', created_at: 3_000, object_type: 'transaction', object_id: 't2' })
  ];
  const plan = planOutboxDispatch({ rows, asOf: 10_000 });
  assert.deepEqual(ids(plan.ready).sort(), ['elsewhere', 'h']); // one head per target
  assert.deepEqual(plan.deferred, [{ id: 'tail', reason: 'lane_blocked', blockedBy: 'h' }]);
});

// ---- concurrency cap ------------------------------------------------------

test('planOutboxDispatch: the concurrency cap defers extra lane heads, FIFO', () => {
  const rows = [
    row({ id: 'a', created_at: 1_000, object_type: 'doc', object_id: '1' }),
    row({ id: 'b', created_at: 2_000, object_type: 'doc', object_id: '2' }),
    row({ id: 'c', created_at: 3_000, object_type: 'doc', object_id: '3' })
  ];
  const plan = planOutboxDispatch({ rows, asOf: 10_000, policy: { maxConcurrent: 2 } });
  assert.deepEqual(ids(plan.ready), ['a', 'b']);
  assert.deepEqual(plan.deferred, [{ id: 'c', reason: 'concurrency_cap' }]);
});

// ---- stuck-dispatch reclaim -----------------------------------------------

test('planOutboxDispatch: an in-flight dispatch is left alone until it is stuck', () => {
  const r = row({ id: 'inflight', status: 'dispatching', attempts: 1, last_error: { at: 100_000 } });
  const policy = { dispatchingStuckMs: 5_000 };

  // still within the stuck window -> leave it (the dispatcher owns it)
  const held = planOutboxDispatch({ rows: [r], asOf: 102_000, policy });
  assert.deepEqual(held.ready, []);
  assert.deepEqual(held.deferred, [{ id: 'inflight', reason: 'dispatching' }]);

  // stuck past the window -> reclaim and retry now (no extra backoff wait)
  const reclaimed = planOutboxDispatch({ rows: [r], asOf: 110_000, policy });
  assert.deepEqual(ids(reclaimed.ready), ['inflight']);
});

// ---- determinism ----------------------------------------------------------

test('planOutboxDispatch: the plan is independent of input row order', () => {
  const base = [
    row({ id: 'a', created_at: 1_000, object_type: 'x', object_id: '1' }),
    row({ id: 'b', created_at: 2_000, object_type: 'x', object_id: '1' }),
    row({ id: 'c', created_at: 3_000 }),
    row({ id: 'd', status: 'failed', attempts: 9 })
  ];
  const forward = planOutboxDispatch({ rows: base, asOf: 10_000, policy: { maxAttempts: 5 } });
  const reversed = planOutboxDispatch({ rows: [...base].reverse(), asOf: 10_000, policy: { maxAttempts: 5 } });
  assert.deepEqual(forward, reversed);
  assert.deepEqual(ids(forward.ready), ['a', 'c']);
  assert.deepEqual(ids(forward.deadLettered), ['d']);
});

// ---- enum re-export -------------------------------------------------------

test('LOOP_OUTBOX_STATUSES is re-exported from the canonical owner', () => {
  assert.ok(LOOP_OUTBOX_STATUSES.includes('pending'));
  assert.ok(LOOP_OUTBOX_STATUSES.includes('dispatched'));
});
