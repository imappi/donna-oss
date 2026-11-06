// Donna Loops — the LoopRun engine (loopRunEngine) unit tests. Load-bearing
// properties (design §5/§10 Step 5 / §13; INV-15/16):
//   - a committed wake persists a LoopRun receipt AND a GoalReport, with the
//     MANDATORY §13.2 goal_evaluated event pointer appended FIRST
//   - §13.4 idempotency: a redelivered event (its deterministic run id already
//     present) is a clean skip — no re-evaluation, no duplicate pointer
//   - INV-16 single-flight: a stale wake (case_version advanced under it) commits
//     NO competing verdict — it stops 'superseded', the run still receipted
//   - INV-15: a met goal stops goal_met; a workflow-only wake never false-stops
//     budget_exhausted; repeated no-progress escalates to no_progress; a thrown
//     evaluator is folded into a 'failed' run, never a crash
//   - inert pre-037: the goal tables absent → a clean no-op skip
//   - the engine NEVER opens a case / resolves a blocker — it only re-evaluates
//     and persists (the injected evaluate decides; the engine bounds + receipts)

import test from 'node:test';
import assert from 'node:assert/strict';

import { runLoopWake } from './loopRunEngine.js';
import { buildLoopRunKey, evaluateGoal } from './loopGoal.js';
import { RECONCILIATION_GAP_DEFINITION, RECONCILIATION_GAP_GOAL } from './loopGoalRegistry.js';

// Mirror the loopGoalStore harness: responders matched by substring + consumed
// once; to_regclass defaults to "present" unless tablesPresent=false.
const makeMockClient = (responders = [], { tablesPresent = true } = {}) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      if (text === 'begin' || text === 'commit' || text === 'rollback') return { rows: [], rowCount: 0 };
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: r.rowCount ?? (r.rows || []).length };
      }
      if (text.includes('to_regclass')) return { rows: [{ present: tablesPresent ? 'loop_goal_reports' : null }] };
      return { rows: [], rowCount: 0 };
    }
  };
};

const reportWith = (status) =>
  evaluateGoal(RECONCILIATION_GAP_GOAL, [{ key: 'matched_or_explained', status }],
    { snapshotId: 'snap-1', evaluatorVersion: 'gpt-5.4' });

const caseRowResponder = (overrides = {}) => ({
  match: 'case_version, status',
  rows: [{
    id: 'case-1', firm_id: 'f', client_id: 'cl', case_version: 3, status: 'waiting_firm',
    primary_object_type: 'document', primary_object_id: 'doc-1', ...overrides
  }]
});

const baseArgs = (evaluate) => ({
  client: null, firmId: 'f', clientId: 'cl', caseId: 'case-1',
  loopDefinition: RECONCILIATION_GAP_DEFINITION, triggerEvents: ['evt-1'], evaluate
});

test('a committed wake persists the LoopRun + GoalReport with the §13.2 pointer', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 3 }),
    { match: 'loop_runs where id =', rows: [] },                 // §13.4: no prior run
    { match: 'progress_fingerprint_after, stop_reason', rows: [] }, // no history
    { match: 'set case_version = case_version + 1', rowCount: 1 },   // CAS commits
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-1' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('unmet'), spec: RECONCILIATION_GAP_GOAL, action: 'open_gap',
      progressFingerprint: 'fp-after', usage: { modelCalls: 0, toolCalls: 1 }, evaluatorVersion: 'gpt-5.4'
    })),
    client: c
  });

  assert.equal(out.skipped, false);
  assert.equal(out.committed, true);
  assert.equal(out.stopReason, 'authority_required'); // unmet → a human must act
  assert.equal(out.runId, buildLoopRunKey({ caseId: 'case-1', triggerEventId: 'evt-1' }));
  assert.ok(out.reportId);
  // single-flight CAS keyed off the case_version we READ
  const cas = c.calls.find((q) => /set case_version = case_version \+ 1/.test(q.sql));
  assert.ok(cas.params.includes(3));
  // §13.2: a goal_evaluated event is appended (the mandatory report pointer)
  const evt = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql));
  assert.ok(JSON.stringify(evt.params).includes('goal_evaluated'));
  // the run receipt carries the deterministic id + the stop reason
  const run = c.calls.find((q) => /insert into loop_runs/.test(q.sql));
  assert.equal(run.params[0], 'run:case-1:evt-1');
  assert.ok(run.params.includes('authority_required'));
});

test('§13.4 idempotency: a redelivered event whose run already exists is a clean skip', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 1 }),
    { match: 'loop_runs where id =', rows: [{ id: 'run:case-1:evt-1' }] } // already ran
  ]);
  let evaluated = false;
  const out = await runLoopWake({ ...baseArgs(async () => { evaluated = true; return {}; }), client: c });
  assert.deepEqual(out, { skipped: true, reason: 'already_run', runId: 'run:case-1:evt-1' });
  assert.equal(evaluated, false);                                   // no re-evaluation
  assert.ok(!c.calls.some((q) => /insert into loop_runs/.test(q.sql)));
  assert.ok(!c.calls.some((q) => /set case_version/.test(q.sql)));  // no duplicate version bump
});

test('INV-16 single-flight: a stale wake (CAS fails) stops superseded, writes no verdict', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 5 }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 0 }, // another wake won
    { match: 'insert into loop_runs', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('met'), spec: RECONCILIATION_GAP_GOAL, action: 'noop',
      progressFingerprint: 'fp', usage: { modelCalls: 0, toolCalls: 1 }
    })),
    client: c
  });
  assert.equal(out.committed, false);
  assert.equal(out.stopReason, 'superseded');
  assert.equal(out.reportId, null);
  // no competing verdict, and no orphan goal_evaluated pointer
  assert.ok(!c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)));
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql)));
  // and a stale (uncommitted) met run cascades NOTHING — no case.resolved row
  assert.ok(!c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)));
  // but the superseded run IS receipted (INV-15: a persisted stop reason every wake)
  const run = c.calls.find((q) => /insert into loop_runs/.test(q.sql));
  assert.ok(run.params.includes('superseded'));
});

test('a met goal stops goal_met, persists the verdict, AND enqueues the case.resolved cascade row', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 2 }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-2' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] },
    { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-resolved-1' }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('met'), spec: RECONCILIATION_GAP_GOAL, action: 'resolve_gap',
      progressFingerprint: 'fp-met', usage: { modelCalls: 0, toolCalls: 1 }, evaluatorVersion: 'gpt-5.4'
    })),
    client: c
  });
  assert.equal(out.stopReason, 'goal_met');
  assert.equal(out.goalStatus, 'met');
  assert.ok(out.reportId);
  // §6.2 cascade producer (INV-8): a committed resolution enqueues a case.resolved
  // outbox row — anchored on the case (serialization lane), case_id in the payload.
  const outbox = c.calls.find((q) => /insert into loop_event_outbox/.test(q.sql));
  assert.ok(outbox, 'enqueued a case.resolved outbox row');
  assert.ok(outbox.params.includes('case.resolved'), 'event_type case.resolved');
  assert.ok(outbox.params.includes('case-1'), 'anchored on the resolved case (object_id)');
  assert.match(outbox.params[6], /"case_id":"case-1"/); // payload JSON carries the case anchor
});

test('a committed but NOT-met wake (authority_required) enqueues NO cascade row', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 2 }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-2b' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('unmet'), spec: RECONCILIATION_GAP_GOAL, action: 'open_gap',
      progressFingerprint: 'fp', usage: { modelCalls: 0, toolCalls: 1 }, evaluatorVersion: 'gpt-5.4'
    })),
    client: c
  });
  assert.equal(out.stopReason, 'authority_required'); // not goal_met
  assert.ok(out.reportId);                              // verdict still persisted
  assert.ok(!c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)),
    'only a resolution cascades — an unmet verdict does not');
});

test('PR 1: a committed wake flagged requestFreshEvaluation enqueues reconciliation.evaluation_requested + stops waiting', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 4, primary_object_type: 'transaction', primary_object_id: 't-1' }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-req' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] },
    { match: 'insert into loop_event_outbox', rows: [{ id: 'ob-req-1' }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('indeterminate'), spec: RECONCILIATION_GAP_GOAL,
      action: 'request_fresh_reconciliation_evaluation',
      requestFreshEvaluation: { reason: 'dependency_resolved_requires_fresh_reconciliation_judgment' },
      progressFingerprint: 'fp-req', usage: { modelCalls: 0, toolCalls: 1 }, evaluatorVersion: 'gpt-5.4'
    })),
    client: c
  });
  // indeterminate → 'waiting' (truthful: fresh judgment pending), NOT authority_required
  assert.equal(out.stopReason, 'waiting');
  assert.ok(out.reportId);
  const outbox = c.calls.find((q) => /insert into loop_event_outbox/.test(q.sql));
  assert.ok(outbox, 'enqueued a reconciliation.evaluation_requested row');
  assert.ok(outbox.params.includes('reconciliation.evaluation_requested'), 'event_type');
  assert.ok(outbox.params.includes('t-1'), 'anchored on the bank line (object_id)');
  assert.match(outbox.params[6], /"target_id":"t-1"/);             // payload carries the target
  assert.match(outbox.params[6], /"case_version":4/);               // the leased version
  assert.match(outbox.params[6], /"idempotencyKey":"recon_eval_requested:case-1:4:evt-1"/);
});

test('PR 1: a SUPERSEDED wake flagged requestFreshEvaluation enqueues NO request (no stale spend)', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 5, primary_object_type: 'transaction', primary_object_id: 't-1' }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 0 }, // another wake won → stale
    { match: 'insert into loop_runs', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('indeterminate'), spec: RECONCILIATION_GAP_GOAL,
      action: 'request_fresh_reconciliation_evaluation',
      requestFreshEvaluation: { reason: 'x' },
      progressFingerprint: 'fp', usage: { modelCalls: 0, toolCalls: 1 }
    })),
    client: c
  });
  assert.equal(out.committed, false);
  assert.equal(out.stopReason, 'superseded');
  assert.ok(!c.calls.some((q) => /insert into loop_event_outbox/.test(q.sql)),
    'a stale run requests no fresh evaluation');
});

test('INV-15 no-progress: an identical fingerprint at the streak threshold escalates to no_progress', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 1 }),
    { match: 'loop_runs where id =', rows: [] },
    // one prior no_progress run with the SAME fingerprint this wake will re-produce
    { match: 'progress_fingerprint_after, stop_reason',
      rows: [{ progress_fingerprint_after: 'fp-stuck', stop_reason: 'no_progress' }] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-3' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('unmet'), spec: RECONCILIATION_GAP_GOAL, action: 'noop',
      progressFingerprint: 'fp-stuck', usage: { modelCalls: 0, toolCalls: 1 }
    })),
    client: c
  });
  assert.equal(out.noProgress, true);
  assert.equal(out.stopReason, 'no_progress'); // streak 1 + this = 2 = maxNoProgressRuns
});

test('a workflow-only wake (maxModelCallsPerWake:0) never false-stops budget_exhausted', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 1 }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-4' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    ...baseArgs(async () => ({
      goalReport: reportWith('unmet'), spec: RECONCILIATION_GAP_GOAL, action: 'open_gap',
      progressFingerprint: 'fp', usage: { modelCalls: 0, toolCalls: 1 } // 0 of a 0 cap
    })),
    client: c
  });
  assert.equal(out.budget.exhausted, false);
  assert.equal(out.stopReason, 'authority_required'); // NOT budget_exhausted
});

test('a thrown evaluator is folded into a failed run, never a crash', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 1 }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({ ...baseArgs(async () => { throw new Error('boom'); }), client: c });
  assert.equal(out.stopReason, 'failed');
  assert.equal(out.reportId, null); // no verdict from a failed wake
  const run = c.calls.find((q) => /insert into loop_runs/.test(q.sql));
  assert.ok(run.params.includes('failed'));
});

test('coalescing: a batch of trigger events keys ONE deterministic run', async () => {
  const c = makeMockClient([
    caseRowResponder({ case_version: 1 }),
    { match: 'loop_runs where id =', rows: [] },
    { match: 'progress_fingerprint_after, stop_reason', rows: [] },
    { match: 'set case_version = case_version + 1', rowCount: 1 },
    { match: 'insert into loop_runs', rows: [{ inserted: true }] },
    { match: 'insert into loop_goal_specs', rows: [{ inserted: true }] },
    { match: 'insert into bookkeeping_case_events', rows: [{ id: 'evt-pointer-5' }] },
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }
  ]);
  const out = await runLoopWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1',
    loopDefinition: RECONCILIATION_GAP_DEFINITION,
    // out-of-order + a duplicate; earliest sequence 'a' is the representative
    triggerEvents: [{ id: 'b', sequence: 2 }, { id: 'a', sequence: 1 }, { id: 'b', sequence: 2 }],
    evaluate: async () => ({
      goalReport: reportWith('unmet'), spec: RECONCILIATION_GAP_GOAL, action: 'open_gap',
      progressFingerprint: 'fp', usage: { modelCalls: 0, toolCalls: 1 }
    })
  });
  assert.equal(out.coalesced, true);
  assert.equal(out.coalescedCount, 2);              // 'b' de-duplicated
  assert.equal(out.runId, 'run:case-1:a');          // earliest-sequence representative
});

test('inert pre-037: the goal tables absent → a clean no-op skip', async () => {
  const c = makeMockClient([], { tablesPresent: false });
  const out = await runLoopWake({ ...baseArgs(async () => ({})), client: c });
  assert.deepEqual(out, { skipped: true, reason: 'goal_tables_absent' });
  assert.ok(!c.calls.some((q) => /bookkeeping_cases/.test(q.sql))); // never touched a case
});

test('a missing case is a skip, not an opened case (the engine re-evaluates only)', async () => {
  const c = makeMockClient([{ match: 'case_version, status', rows: [] }]);
  const out = await runLoopWake({ ...baseArgs(async () => ({})), client: c });
  assert.equal(out.skipped, true);
  assert.equal(out.reason, 'case_absent');
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_cases/.test(q.sql)));
});

test('invalid input is refused before any query', async () => {
  const c = makeMockClient();
  const out = await runLoopWake({ client: c, firmId: 'f', clientId: 'cl' /* no caseId/def/evaluate */ });
  assert.deepEqual(out, { skipped: true, reason: 'invalid_input' });
  assert.equal(c.calls.length, 0);
});
