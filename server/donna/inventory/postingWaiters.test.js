// Donna Inventory I4·posting — P7 §12 waiter drain: the PURE planner (D-POST-14).
//   node --test server/donna/inventory/postingWaiters.test.js
//
// Every non-human waiter must resolve to an executable disposition — a due retry, a not-yet-due
// wait with a concrete next_retry_at, an exhaustion escalation to a named human queue, or an
// engineering incident. A human-owned waiter rests. Nothing is a silent dead end.

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  planWaiterDisposition, planWaiterDrainBatch,
  WAITER_DISPOSITIONS, HUMAN_OWNED_WAITERS, DEFAULT_RETRY_BACKOFF_MS, RETRY_EXHAUSTION_QUEUE, ENGINEERING_INCIDENT_QUEUE
} from './postingWaiters.js';

const T0 = '2026-07-12T00:00:00.000Z';
const at = (ms) => new Date(Date.parse(T0) + ms);

test('engineering_incident → open_incident with the engineering owning path', () => {
  const p = planWaiterDisposition({ attempt: { waiter_type: 'engineering_incident', reason_code: 'conservation_residual', created_at: T0 }, now: at(0) });
  assert.equal(p.disposition, 'open_incident');
  assert.equal(p.target_queue, ENGINEERING_INCIDENT_QUEUE);
});

test('integration_system_retry: a DUE retry (backoff elapsed) → retry, carrying the re-test condition', () => {
  // First failure (retryCount 1). Next attempt due backoffMs[1] (5m) after created_at.
  const p = planWaiterDisposition({
    attempt: { waiter_type: 'integration_system_retry', reason_code: 'missing_close_fx_rate', next_action: 'await_fx_fact', created_at: T0 },
    retryCount: 1, now: at(DEFAULT_RETRY_BACKOFF_MS[1] + 1000)
  });
  assert.equal(p.disposition, 'retry');
  assert.equal(p.condition, 'await_fx_fact');
  assert.equal(p.retries_used, 1);
  assert.equal(p.retries_max, DEFAULT_RETRY_BACKOFF_MS.length);
});

test('integration_system_retry: NOT yet due → wait, with a concrete next_retry_at', () => {
  const p = planWaiterDisposition({
    attempt: { waiter_type: 'integration_system_retry', created_at: T0 },
    retryCount: 1, now: at(1000) // only 1s elapsed; backoffMs[1] is 5m
  });
  assert.equal(p.disposition, 'wait');
  assert.equal(p.next_retry_at, new Date(Date.parse(T0) + DEFAULT_RETRY_BACKOFF_MS[1]).toISOString());
});

test('integration_system_retry: a persisted retry_after on the row wins over the computed backoff', () => {
  const explicit = '2026-07-12T02:00:00.000Z';
  const before = planWaiterDisposition({ attempt: { waiter_type: 'integration_system_retry', created_at: T0, retry_after: explicit }, retryCount: 1, now: at(60_000) });
  assert.equal(before.disposition, 'wait');
  assert.equal(before.next_retry_at, new Date(explicit).toISOString());
  const after = planWaiterDisposition({ attempt: { waiter_type: 'integration_system_retry', created_at: T0, retry_after: explicit }, retryCount: 1, now: new Date(Date.parse(explicit) + 1000) });
  assert.equal(after.disposition, 'retry');
});

test('integration_system_retry: EXHAUSTED (retryCount ≥ backoff length) → escalate to a named human queue', () => {
  const p = planWaiterDisposition({ attempt: { waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: DEFAULT_RETRY_BACKOFF_MS.length, now: at(999_999_999) });
  assert.equal(p.disposition, 'escalate');
  assert.equal(p.target_queue, RETRY_EXHAUSTION_QUEUE);
  assert.equal(p.retries_used, DEFAULT_RETRY_BACKOFF_MS.length);
});

test('a null clock forces a due retry to WAIT (never over-eager), but exhaustion still escalates', () => {
  assert.equal(planWaiterDisposition({ attempt: { waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: 1, now: null }).disposition, 'wait');
  assert.equal(planWaiterDisposition({ attempt: { waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: 9, now: null }).disposition, 'escalate');
});

test('human-owned waiters rest (no automated drive)', () => {
  for (const w of HUMAN_OWNED_WAITERS) {
    const p = planWaiterDisposition({ attempt: { waiter_type: w }, now: at(0) });
    assert.equal(p.disposition, 'human_owned');
    assert.equal(p.target_queue, w);
  }
});

test('an unknown/absent waiter fails toward a human (accountant_operator), never a silent auto-action', () => {
  const p = planWaiterDisposition({ attempt: { waiter_type: null }, now: at(0) });
  assert.equal(p.disposition, 'human_owned');
  assert.equal(p.target_queue, 'accountant_operator');
});

test('every disposition is in the closed vocabulary', () => {
  for (const w of ['engineering_incident', 'integration_system_retry', 'owner', 'accountant_operator', null]) {
    const p = planWaiterDisposition({ attempt: { waiter_type: w, created_at: T0 }, retryCount: 1, now: at(0) });
    assert.ok(WAITER_DISPOSITIONS.includes(p.disposition), `${w} → ${p.disposition}`);
  }
});

test('planWaiterDrainBatch maps + summarizes a mixed set', () => {
  const { plans, summary, total } = planWaiterDrainBatch({
    waiters: [
      { attempt: { waiter_type: 'engineering_incident' } },
      { attempt: { waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: 99 }, // escalate
      { attempt: { waiter_type: 'integration_system_retry', created_at: T0 }, retryCount: 1 },  // wait (now=T0)
      { attempt: { waiter_type: 'accountant_operator' } }
    ],
    now: at(0)
  });
  assert.equal(total, 4);
  assert.equal(plans.length, 4);
  assert.equal(summary.open_incident, 1);
  assert.equal(summary.escalate, 1);
  assert.equal(summary.wait, 1);
  assert.equal(summary.human_owned, 1);
});
