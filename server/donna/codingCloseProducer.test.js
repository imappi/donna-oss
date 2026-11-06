// Donna Loops — the coding (ask-batch) CLOSE producer unit tests. Load-bearing:
//   - the reply that answers the LAST outstanding question resolves the batch's
//     missing_client_answer blocker AND persists a met GoalReport (verdict + ladder
//     move together — the split CLAUDE.md warns about, closed)
//   - a reply that leaves another question outstanding closes nothing (noop verdict)
//   - an evidence case that blocks no coding case is a clean no-op (graph read only)
//   - no anchor → zero queries
//   - workflow-only: no LLM, no reply CONTENT read (the producer takes a case id)

import test from 'node:test';
import assert from 'node:assert/strict';

import { closeAnsweredCodingCases } from './codingCloseProducer.js';

// Mock pg client mirroring loopsShadowProducers.test.js: seeded responders match an
// SQL substring (first match wins, one-shot); to_regclass + append-only inserts get
// realistic defaults so the §13.2 goal_evaluated pointer is non-null and the report
// write proceeds.
const makeMockClient = (responders = [], { goalTablesPresent = true } = {}) => {
  const calls = [];
  const queue = [...responders];
  let eventSeq = 0;
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
        return { rows: r.rows || [], rowCount: (r.rows || []).length };
      }
      if (text.includes('to_regclass')) {
        const present = text.includes('loop_goal_reports')
          ? (goalTablesPresent ? 'loop_goal_reports' : null)
          : 'bookkeeping_cases';
        return { rows: [{ present }] };
      }
      if (text.includes('insert into bookkeeping_case_events')) return { rows: [{ id: `case-event-${++eventSeq}` }] };
      if (text.includes('insert into loop_goal_specs')) return { rows: [{ inserted: true }] };
      if (text.includes('insert into loop_goal_reports')) return { rows: [{ inserted: true }] };
      return { rows: [], rowCount: 0 };
    }
  };
};

const blocksEdge = (parent, child) => ({
  id: `dep-${parent}-${child}`, parent_case_id: parent, child_case_id: child,
  relationship_type: 'blocks', resolved_at: null, created_at: 1000
});

// E1 + E2 both block coding case C; the reply just answered E1.
const twoQuestionGraph = [blocksEdge('E1', 'C'), blocksEdge('E2', 'C')];

test('the last outstanding answer resolves the batch blocker + persists a MET GoalReport', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: twoQuestionGraph },
    // neither E1 nor E2 has an open answer blocker → both answered (2 of 2)
    { match: 'group by case_id', rows: [] },
    // the coding batch blocker is open and resolvable
    { match: 'client_ask_batch', rows: [{ id: 'blk-C' }] },
    { match: 'update bookkeeping_case_blockers', rows: [{ case_id: 'C', firm_id: 'f', client_id: 'cl', blocker_type: 'missing_client_answer', owner_type: 'client' }] }
  ]);
  const out = await closeAnsweredCodingCases({ client: c, firmId: 'f', clientId: 'cl', evidenceCaseId: 'E1', triggerEventId: 'ev-1' });

  assert.equal(out.closedCases, 1);
  assert.equal(out.resolvedBlockers, 1);
  // resolved the batch blocker
  assert.ok(c.calls.some((q) => /update bookkeeping_case_blockers/.test(q.sql)), 'resolves the batch blocker');
  // §13.2 — a goal_evaluated pointer event precedes the report
  const goalEvent = c.calls.find((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('goal_evaluated'));
  assert.ok(goalEvent, 'goal_evaluated pointer appended');
  // a MET coding GoalReport is persisted
  const report = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
  assert.ok(report, 'persists a coding GoalReport');
  assert.match(JSON.stringify(report.params), /ask_batch_answered/, 'the coding goal');
  assert.ok(report.params.includes('met'), 'verdict is met');
  // workflow-only: no accounting writes, no model
  assert.ok(!c.calls.some((q) => /update transactions|insert into ledger_|reconciliation_matches/.test(q.sql)));
});

test('a reply that leaves another question outstanding closes nothing', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: twoQuestionGraph },
    // E2 still has an open answer blocker → only 1 of 2 answered
    { match: 'group by case_id', rows: [{ case_id: 'E2', open_answers: 1 }] }
  ]);
  const out = await closeAnsweredCodingCases({ client: c, firmId: 'f', clientId: 'cl', evidenceCaseId: 'E1', triggerEventId: 'ev-1' });

  assert.equal(out.closedCases, 0);
  assert.equal(out.resolvedBlockers, 0);
  // never reached the resolve SELECT or the blocker UPDATE
  assert.ok(!c.calls.some((q) => /client_ask_batch/.test(q.sql)), 'no batch-blocker lookup');
  assert.ok(!c.calls.some((q) => /update bookkeeping_case_blockers/.test(q.sql)), 'no blocker resolution');
  assert.ok(!c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)), 'no premature met report');
});

test('an evidence case that blocks no coding case is a clean no-op (graph read only)', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: [] }
  ]);
  const out = await closeAnsweredCodingCases({ client: c, firmId: 'f', clientId: 'cl', evidenceCaseId: 'E1' });
  assert.equal(out.closedCases, 0);
  // only the dependency read ran; no blocker queries
  assert.ok(!c.calls.some((q) => /bookkeeping_case_blockers/.test(q.sql)));
});

test('no evidence case anchor → zero queries', async () => {
  let queries = 0;
  const c = { query: async () => { queries += 1; return { rows: [] }; } };
  const out = await closeAnsweredCodingCases({ client: c, firmId: 'f', clientId: 'cl' /* no evidenceCaseId */ });
  assert.equal(out.closedCases, 0);
  assert.equal(queries, 0);
});

test('a duplicate reply (blocker already resolved) still records the met verdict but counts no new close', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: twoQuestionGraph },
    { match: 'group by case_id', rows: [] },          // all answered
    { match: 'client_ask_batch', rows: [] }           // no OPEN batch blocker (already resolved)
  ]);
  const out = await closeAnsweredCodingCases({ client: c, firmId: 'f', clientId: 'cl', evidenceCaseId: 'E1', triggerEventId: 'ev-1' });
  assert.equal(out.closedCases, 0, 'no NEW blocker resolved');
  assert.equal(out.resolvedBlockers, 0);
  // the met verdict is still persisted (idempotent, keeps the ladder + verdict aligned)
  assert.ok(c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)), 'still records the met verdict');
});

test('goal tables absent (pre-037) → resolves the blocker but writes no report (no orphan pointer)', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: twoQuestionGraph },
    { match: 'group by case_id', rows: [] },
    { match: 'client_ask_batch', rows: [{ id: 'blk-C' }] },
    { match: 'update bookkeeping_case_blockers', rows: [{ case_id: 'C', firm_id: 'f', client_id: 'cl', blocker_type: 'missing_client_answer', owner_type: 'client' }] }
  ], { goalTablesPresent: false });
  const out = await closeAnsweredCodingCases({ client: c, firmId: 'f', clientId: 'cl', evidenceCaseId: 'E1', triggerEventId: 'ev-1' });
  assert.equal(out.closedCases, 1, 'blocker still resolves on the 033 spine');
  assert.ok(!c.calls.some((q) => /insert into loop_goal_reports/.test(q.sql)), 'no report pre-037');
  assert.ok(!c.calls.some((q) => /insert into bookkeeping_case_events/.test(q.sql) && JSON.stringify(q.params).includes('goal_evaluated')), 'no orphan goal_evaluated event');
});
