// Tests for the LoopRun engine's pure pieces (goal-first uplift, design §5/§6.3,
// INV-15/16). Pure / node --test only — no DB, no Inngest, no LLM. Covers the
// single-flight lease (INV-16), event coalescing / dirty-marking (§6.3), budget
// accounting (INV-15), and the summarizeRun composition over loopGoal.js.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXECUTION_POLICY,
  normalizeExecutionPolicy,
  decideLease,
  canCommitRun,
  nextCaseVersion,
  coalesceTriggerEvents,
  emptyCaseRunState,
  noteTriggerEvent,
  settleRun,
  accountBudget,
  canSpend,
  summarizeRun,
  STOP_REASONS
} from './loopRun.js';

// ---- executionPolicy ------------------------------------------------------

test('normalizeExecutionPolicy fills defaults for missing/garbage fields', () => {
  const p = normalizeExecutionPolicy({ maxModelCallsPerWake: 4, maxToolCallsPerWake: 'nope', maxRetries: -2 });
  assert.equal(p.maxModelCallsPerWake, 4);
  assert.equal(p.maxToolCallsPerWake, DEFAULT_EXECUTION_POLICY.maxToolCallsPerWake);
  assert.equal(p.maxRetries, DEFAULT_EXECUTION_POLICY.maxRetries); // -2 rejected
  assert.equal(p.maxElapsedMs, DEFAULT_EXECUTION_POLICY.maxElapsedMs);
});

test('normalizeExecutionPolicy floors non-integers and accepts an empty policy', () => {
  assert.equal(normalizeExecutionPolicy({ maxToolCallsPerWake: 3.9 }).maxToolCallsPerWake, 3);
  assert.deepEqual(normalizeExecutionPolicy(), DEFAULT_EXECUTION_POLICY);
  assert.deepEqual(normalizeExecutionPolicy(null), DEFAULT_EXECUTION_POLICY);
});

// ---- single-flight lease (INV-16) -----------------------------------------

test('decideLease: no active lease -> acquire at the current case version', () => {
  const d = decideLease({ activeLease: null, caseVersion: 3 });
  assert.equal(d.decision, 'acquire');
  assert.equal(d.leaseCaseVersion, 3);
  assert.equal(d.reason, 'no_active_lease');
});

test('decideLease: a held lease -> coalesce (single-flight)', () => {
  const d = decideLease({ activeLease: { runId: 'r1', status: 'active' }, caseVersion: 3 });
  assert.equal(d.decision, 'coalesce');
  assert.equal(d.reason, 'single_flight_active');
});

test('decideLease: a released lease -> acquire (not held)', () => {
  const d = decideLease({ activeLease: { runId: 'r1', status: 'released' }, caseVersion: 5 });
  assert.equal(d.decision, 'acquire');
  assert.equal(d.reason, 'no_active_lease');
});

test('decideLease: an expired-TTL lease is stolen -> acquire with stolenFrom', () => {
  const d = decideLease({
    activeLease: { runId: 'r-old', status: 'active', expiresAt: 1000 },
    caseVersion: 2, asOf: 2000
  });
  assert.equal(d.decision, 'acquire');
  assert.equal(d.reason, 'lease_expired');
  assert.equal(d.stolenFrom, 'r-old');
});

test('decideLease: a not-yet-expired lease still holds', () => {
  const d = decideLease({
    activeLease: { runId: 'r-old', status: 'active', expiresAt: 5000 },
    caseVersion: 2, asOf: 2000
  });
  assert.equal(d.decision, 'coalesce');
});

test('decideLease: rejects a non-positive-integer case version', () => {
  assert.throws(() => decideLease({ caseVersion: 0 }), /positive integer/);
  assert.throws(() => decideLease({ caseVersion: 1.5 }), /positive integer/);
});

test('canCommitRun: commits only when the case version has not advanced', () => {
  assert.equal(canCommitRun({ leaseCaseVersion: 4, currentCaseVersion: 4 }), true);
  assert.equal(canCommitRun({ leaseCaseVersion: 4, currentCaseVersion: 5 }), false);
});

test('nextCaseVersion increments; rejects bad input', () => {
  assert.equal(nextCaseVersion(1), 2);
  assert.throws(() => nextCaseVersion(0), /positive integer/);
});

// ---- coalescing / dirty-marking (§6.3) ------------------------------------

test('coalesceTriggerEvents: 30 events for one case collapse to one representative', () => {
  const events = Array.from({ length: 30 }, (_, i) => ({ id: `e${String(i).padStart(2, '0')}`, sequence: i }));
  const r = coalesceTriggerEvents(events);
  assert.equal(r.count, 30);
  assert.equal(r.coalesced, true);
  assert.equal(r.representativeEventId, 'e00'); // earliest by sequence
});

test('coalesceTriggerEvents: representative is input-order-independent (idempotent key)', () => {
  const a = coalesceTriggerEvents([{ id: 'b', sequence: 2 }, { id: 'a', sequence: 1 }]);
  const b = coalesceTriggerEvents([{ id: 'a', sequence: 1 }, { id: 'b', sequence: 2 }]);
  assert.equal(a.representativeEventId, b.representativeEventId);
  assert.equal(a.representativeEventId, 'a');
});

test('coalesceTriggerEvents: dedups repeated ids and falls back to id ordering', () => {
  const r = coalesceTriggerEvents(['z', 'a', 'a', 'm']);
  assert.deepEqual(r.eventIds, ['a', 'm', 'z']);
  assert.equal(r.representativeEventId, 'a');
  assert.equal(r.count, 3);
});

test('coalesceTriggerEvents: a single event is not flagged coalesced', () => {
  const r = coalesceTriggerEvents(['only']);
  assert.equal(r.coalesced, false);
  assert.equal(r.representativeEventId, 'only');
});

test('coalesceTriggerEvents: rejects an event with no id and a non-array', () => {
  assert.throws(() => coalesceTriggerEvents([{ sequence: 1 }]), /needs an id/);
  assert.throws(() => coalesceTriggerEvents('nope'), /must be an array/);
});

test('dirty-marking: event while idle -> acquire; while active -> coalesce + dirty', () => {
  let { next, decision } = noteTriggerEvent(emptyCaseRunState(), 'e1');
  assert.equal(decision, 'acquire');
  assert.equal(next.active, true);
  assert.equal(next.dirty, false);

  ({ next, decision } = noteTriggerEvent(next, 'e2'));
  assert.equal(decision, 'coalesce');
  assert.equal(next.dirty, true);
  assert.deepEqual(next.pendingEventIds, ['e2']);
});

test('dirty-marking: settleRun re-evaluates once iff the case went dirty', () => {
  // clean run: nothing arrived mid-run -> no re-eval
  const clean = settleRun({ active: true, dirty: false, pendingEventIds: [] });
  assert.equal(clean.reEvaluate, false);
  assert.deepEqual(clean.coalescedEventIds, []);
  assert.deepEqual(clean.next, emptyCaseRunState());

  // dirty run: re-eval once, handing back the coalesced ids
  const dirty = settleRun({ active: true, dirty: true, pendingEventIds: ['e2', 'e3'] });
  assert.equal(dirty.reEvaluate, true);
  assert.deepEqual(dirty.coalescedEventIds, ['e2', 'e3']);
  assert.deepEqual(dirty.next, emptyCaseRunState());
});

test('dirty-marking: noteTriggerEvent does not mutate the input state', () => {
  const state = emptyCaseRunState();
  state.active = true;
  const frozen = JSON.stringify(state);
  noteTriggerEvent(state, 'e9');
  assert.equal(JSON.stringify(state), frozen);
});

// ---- budget accounting (INV-15) -------------------------------------------

test('accountBudget: under budget -> not exhausted, remaining reported', () => {
  const b = accountBudget({
    policy: { maxModelCallsPerWake: 2, maxToolCallsPerWake: 3, maxElapsedMs: 30000, maxRetries: 2 },
    usage: { modelCalls: 1, toolCalls: 1, elapsedMs: 5000, retries: 0 }
  });
  assert.equal(b.exhausted, false);
  assert.deepEqual(b.exceeded, []);
  assert.deepEqual(b.remaining, { modelCalls: 1, toolCalls: 2, elapsedMs: 25000, retries: 2 });
});

test('accountBudget: reaching a cap marks that dimension exhausted', () => {
  const b = accountBudget({
    policy: { maxModelCallsPerWake: 1 },
    usage: { modelCalls: 1 }
  });
  assert.equal(b.exhausted, true);
  assert.deepEqual(b.exceeded, ['modelCalls']);
  assert.equal(b.remaining.modelCalls, 0);
});

test('accountBudget: a zero-cap dimension with zero usage is NOT exhausted', () => {
  // A workflow-only loop (maxModelCallsPerWake:0) that makes zero model calls
  // must not false-stop 'budget_exhausted' — the reconciliation gap loop's wake.
  const b = accountBudget({
    policy: { maxModelCallsPerWake: 0, maxToolCallsPerWake: 2 },
    usage: { modelCalls: 0, toolCalls: 1 }
  });
  assert.equal(b.exhausted, false);
  assert.deepEqual(b.exceeded, []);
  // overspending a zero cap IS exhausted (a disallowed model call slipped through)
  const over = accountBudget({ policy: { maxModelCallsPerWake: 0 }, usage: { modelCalls: 1 } });
  assert.equal(over.exhausted, true);
  assert.deepEqual(over.exceeded, ['modelCalls']);
});

test('accountBudget: multiple exhausted dimensions are all listed', () => {
  const b = accountBudget({
    policy: { maxModelCallsPerWake: 1, maxToolCallsPerWake: 2 },
    usage: { modelCalls: 3, toolCalls: 2 }
  });
  assert.deepEqual(b.exceeded.sort(), ['modelCalls', 'toolCalls']);
});

test('canSpend: gates each kind against its cap; +1 must fit', () => {
  const policy = { maxModelCallsPerWake: 1, maxToolCallsPerWake: 3, maxRetries: 2, maxElapsedMs: 30000 };
  assert.equal(canSpend({ policy, usage: { modelCalls: 0 }, kind: 'model_call' }), true);
  assert.equal(canSpend({ policy, usage: { modelCalls: 1 }, kind: 'model_call' }), false);
  assert.equal(canSpend({ policy, usage: { toolCalls: 2 }, kind: 'tool_call' }), true);
  assert.equal(canSpend({ policy, usage: { retries: 2 }, kind: 'retry' }), false);
  assert.equal(canSpend({ policy, usage: { elapsedMs: 29999 }, kind: 'elapsed' }), true);
  assert.equal(canSpend({ policy, usage: { elapsedMs: 30000 }, kind: 'elapsed' }), false);
});

test('canSpend: unknown kind throws', () => {
  assert.throws(() => canSpend({ policy: {}, usage: {}, kind: 'bogus' }), /unknown kind/);
});

// ---- summarizeRun composition ---------------------------------------------

const policy = { maxModelCallsPerWake: 1, maxToolCallsPerWake: 3, maxElapsedMs: 30000, maxRetries: 2, maxNoProgressRuns: 2 };

test('summarizeRun: a met goal stops goal_met', () => {
  const r = summarizeRun({ goalReport: { status: 'met' }, policy, usage: {} });
  assert.equal(r.stopReason, 'goal_met');
  assert.ok(STOP_REASONS.includes(r.stopReason));
});

test('summarizeRun: an exhausted budget stops budget_exhausted', () => {
  const r = summarizeRun({
    goalReport: { status: 'unmet' }, policy, usage: { modelCalls: 1 }
  });
  assert.equal(r.budget.exhausted, true);
  assert.equal(r.stopReason, 'budget_exhausted');
});

test('summarizeRun: one stalled wake waits; the threshold escalates to no_progress', () => {
  // below threshold: same fingerprint, streak 0 -> 1, max 2 -> not yet escalated
  const below = summarizeRun({
    goalReport: { status: 'unmet' }, policy,
    progressBefore: 'fp', progressAfter: 'fp', consecutiveNoProgressRuns: 0
  });
  assert.equal(below.noProgress, true);
  assert.equal(below.escalateNoProgress, false);
  assert.equal(below.stopReason, 'authority_required'); // unmet -> waits for action, not no_progress

  // at threshold: streak 1 -> 2, max 2 -> escalate and stop no_progress
  const at = summarizeRun({
    goalReport: { status: 'unmet' }, policy,
    progressBefore: 'fp', progressAfter: 'fp', consecutiveNoProgressRuns: 1
  });
  assert.equal(at.escalateNoProgress, true);
  assert.equal(at.stopReason, 'no_progress');
});

test('summarizeRun: a stale run (case advanced under it) stops superseded', () => {
  const r = summarizeRun({
    goalReport: { status: 'met' }, policy, canCommit: false
  });
  assert.equal(r.superseded, true);
  assert.equal(r.stopReason, 'superseded'); // outranks goal_met
});

test('summarizeRun: progress moved -> not no_progress; unmet -> authority_required', () => {
  const r = summarizeRun({
    goalReport: { status: 'unmet' }, policy,
    progressBefore: 'fp-a', progressAfter: 'fp-b', consecutiveNoProgressRuns: 5
  });
  assert.equal(r.noProgress, false);
  assert.equal(r.effectiveNoProgressRuns, 0);
  assert.equal(r.stopReason, 'authority_required');
});
