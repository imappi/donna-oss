// Donna Loops — the coding (ask-batch) wake evaluator unit tests. Load-bearing:
//   - it reads the §6.2 graph (which evidence cases BLOCK this coding case) + each
//     blocking case's open missing_client_answer blocker; never the reply content
//   - every blocking question answered → met, resolve_coding_case
//   - some still outstanding → unmet, noop, with the answered count in the
//     progress fingerprint (so a partial-answer wake registers as progress)
//   - no blocking edges tracked → indeterminate no-op (nothing to assert)
//   - no anchor → indeterminate, ZERO queries; workflow-only (modelCalls === 0)

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateCodingWake } from './codingWakeEvaluator.js';

const makeMockClient = (responders = []) => {
  const calls = [];
  const queue = [...responders];
  return {
    calls,
    query: async (sql, params) => {
      calls.push({ sql: String(sql), params });
      const text = String(sql).toLowerCase();
      const idx = queue.findIndex((r) => text.includes(r.match));
      if (idx !== -1) {
        const [r] = queue.splice(idx, 1);
        if (r.throw) throw r.throw;
        return { rows: r.rows || [], rowCount: (r.rows || []).length };
      }
      return { rows: [], rowCount: 0 };
    }
  };
};

const blocksEdge = (parent, child) => ({
  id: `dep-${parent}-${child}`, parent_case_id: parent, child_case_id: child,
  relationship_type: 'blocks', resolved_at: null, created_at: 1000
});

test('every blocking question answered → met, resolve_coding_case', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: [blocksEdge('E1', 'C'), blocksEdge('E2', 'C')] },
    // neither blocking evidence case has an open answer blocker → both answered
    { match: 'from bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await evaluateCodingWake({ client: c, firmId: 'f', clientId: 'cl', caseId: 'C' });
  assert.equal(out.goalReport.status, 'met');
  assert.equal(out.action, 'resolve_coding_case');
  assert.equal(out.usage.modelCalls, 0);          // workflow-only, never a model call
  assert.equal(out.spec.key, 'ask_batch_answered');
  assert.ok(out.progressFingerprint);
});

test('some questions still outstanding → unmet, noop; answered count drives progress', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: [blocksEdge('E1', 'C'), blocksEdge('E2', 'C')] },
    // E2 still has an open answer blocker (unanswered); E1 has none (answered)
    { match: 'from bookkeeping_case_blockers', rows: [{ case_id: 'E2', open_answers: 1 }] }
  ]);
  const out = await evaluateCodingWake({ client: c, firmId: 'f', clientId: 'cl', caseId: 'C' });
  assert.equal(out.goalReport.status, 'unmet');
  assert.equal(out.action, 'noop');
  // the next-condition counts the outstanding answers off persisted state
  const crit = out.goalReport.criteria.find((k) => k.key === 'all_questions_answered');
  assert.ok((crit.evidenceRefs || []).includes('answered_1_of_2'));
});

test('a partial-answer wake produces a DIFFERENT fingerprint than a no-answer wake (real progress)', async () => {
  const none = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: [blocksEdge('E1', 'C'), blocksEdge('E2', 'C')] },
    { match: 'from bookkeeping_case_blockers', rows: [{ case_id: 'E1', open_answers: 1 }, { case_id: 'E2', open_answers: 1 }] }
  ]);
  const one = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: [blocksEdge('E1', 'C'), blocksEdge('E2', 'C')] },
    { match: 'from bookkeeping_case_blockers', rows: [{ case_id: 'E2', open_answers: 1 }] }
  ]);
  const a = await evaluateCodingWake({ client: none, firmId: 'f', clientId: 'cl', caseId: 'C' });
  const b = await evaluateCodingWake({ client: one, firmId: 'f', clientId: 'cl', caseId: 'C' });
  assert.equal(a.goalReport.status, 'unmet');
  assert.equal(b.goalReport.status, 'unmet');
  assert.notEqual(a.progressFingerprint, b.progressFingerprint); // 0/2 vs 1/2 = progress, not a stall
});

test('no blocking edges tracked → indeterminate no-op (nothing to assert)', async () => {
  const c = makeMockClient([
    { match: 'from bookkeeping_case_dependencies', rows: [] }
  ]);
  const out = await evaluateCodingWake({ client: c, firmId: 'f', clientId: 'cl', caseId: 'C' });
  assert.equal(out.goalReport.status, 'indeterminate');
  assert.equal(out.action, 'noop');
  // no blockers query when there is nothing blocking
  assert.ok(!c.calls.some((q) => /from bookkeeping_case_blockers/.test(q.sql)));
});

test('no anchor → an indeterminate no-op report and ZERO queries', async () => {
  let queries = 0;
  const c = { query: async () => { queries += 1; return { rows: [] }; } };
  const out = await evaluateCodingWake({ client: c, firmId: 'f', clientId: 'cl' /* no caseId */ });
  assert.equal(out.goalReport.status, 'indeterminate');
  assert.equal(out.action, 'noop');
  assert.equal(queries, 0);
});
