// Donna Loops — the reconciliation wake evaluator unit tests. Load-bearing:
//   - it RENDERS the persisted verdict (reconciliation_evaluations) + live match
//     state; it never re-matches, never calls a model (usage.modelCalls === 0)
//   - INV-4: a confirmed/auto_matched match SETTLES the target → goal met,
//     outranking any verdict; a rejected match does NOT settle
//   - it carries the upstream verdict's model id as the receipt (evaluatorVersion)
//   - a no_match verdict on an unpaid document → unmet, action open_gap
//   - no target anchor → an indeterminate no-op report, zero queries
//   - every read soft-fails; the evaluator is read-only (opens/resolves nothing)

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateReconciliationWake } from './reconciliationWakeEvaluator.js';

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

const docCaseRow = (overrides = {}) => ({
  primary_object_type: 'document', primary_object_id: 'doc-1', owner_type: 'firm', ...overrides
});

test('a no_match verdict on an unpaid document → unmet, open_gap, model receipt carried', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', unmatchable_reason: 'No candidate line', model: 'gpt-5.4' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [] }, // no sticky match
    { match: 'from reconciliation_matches', rows: [] },             // no match at all
    { match: 'from documents', rows: [{ payment_status: 'unpaid' }] },
    { match: 'bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match' }] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: docCaseRow()
  });
  assert.equal(out.goalReport.status, 'unmet');
  assert.equal(out.action, 'open_gap');
  assert.equal(out.evaluatorVersion, 'gpt-5.4');   // the model id IS the receipt
  assert.equal(out.usage.modelCalls, 0);           // workflow-only, never a model call
  assert.ok(out.progressFingerprint);              // deterministic progress signal
  assert.equal(out.spec.key, 'reconciliation_gap_resolved');
});

test('INV-4: a confirmed match SETTLES the target → met, resolve_gap, even over a no_match verdict', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', model: 'm1' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [{ x: 1 }] }, // sticky present
    { match: 'from reconciliation_matches', rows: [{ x: 1 }] },
    { match: 'from documents', rows: [{ payment_status: 'paid' }] },
    { match: 'bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: docCaseRow()
  });
  assert.equal(out.goalReport.status, 'met');
  assert.equal(out.action, 'resolve_gap');
});

test('an auto_explained verdict → met, noop (immaterial recurring noise)', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'auto_explained', model: 'm2' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [] },
    { match: 'from reconciliation_matches', rows: [] },
    { match: 'from documents', rows: [{ payment_status: 'unpaid' }] },
    { match: 'bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: docCaseRow()
  });
  assert.equal(out.goalReport.status, 'met');
  assert.equal(out.action, 'noop');
});

test('a transaction target skips the documents read (no payment_status)', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', model: 'm3' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [] },
    { match: 'from reconciliation_matches', rows: [] },
    { match: 'bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1',
    caseRow: { primary_object_type: 'transaction', primary_object_id: 't-1', owner_type: 'firm' }
  });
  assert.equal(out.goalReport.status, 'unmet');
  assert.ok(!c.calls.some((q) => /from documents/.test(q.sql))); // no payment_status read for a bank line
});

// ── PR 1 (Trap-2): the upstream-resolution fresh-evaluation request ──────────

const txnCaseRow = { primary_object_type: 'transaction', primary_object_id: 't-1', owner_type: 'firm' };

test('a dependency.resolved wake on a stale no_match line REQUESTS a fresh re-match and stops waiting', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', model: 'gpt-5.4' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [] }, // no sticky
    { match: 'from reconciliation_matches', rows: [] },             // no match at all
    { match: 'bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match', owner_type: 'firm' }] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: txnCaseRow,
    triggerEventTypes: ['dependency.resolved']
  });
  assert.equal(out.action, 'request_fresh_reconciliation_evaluation');
  assert.ok(out.requestFreshEvaluation, 'flags the engine to emit the request');
  assert.equal(out.goalReport.status, 'indeterminate'); // → stop_reason 'waiting' (not a re-projected gap)
  assert.equal(out.usage.modelCalls, 0);                 // the wake never calls the model
  assert.equal(out.evaluatorVersion, 'gpt-5.4');
});

test('a NON-cascade wake on the same no_match line re-projects the gap (no request)', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', model: 'm' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [] },
    { match: 'from reconciliation_matches', rows: [] },
    { match: 'bookkeeping_case_blockers', rows: [{ blocker_type: 'unclear_match' }] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: txnCaseRow,
    triggerEventTypes: ['reconciliation.run_completed'] // a sweep/forward wake, not the cascade
  });
  assert.equal(out.action, 'open_gap');
  assert.ok(!out.requestFreshEvaluation);
});

test('a dependency.resolved wake on a STICKY-matched line does not request (already settled)', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_match', model: 'm' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [{ x: 1 }] }, // sticky settles it
    { match: 'from reconciliation_matches', rows: [{ x: 1 }] },
    { match: 'bookkeeping_case_blockers', rows: [] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: txnCaseRow,
    triggerEventTypes: ['dependency.resolved']
  });
  assert.equal(out.action, 'resolve_gap');
  assert.ok(!out.requestFreshEvaluation);
});

test('a dependency.resolved wake on a no_candidates line does not request (statement not uploaded)', async () => {
  const c = makeMockClient([
    { match: 'from reconciliation_evaluations', rows: [{ verdict: 'no_candidates', model: 'm' }] },
    { match: "status in ('confirmed', 'auto_matched')", rows: [] },
    { match: 'from reconciliation_matches', rows: [] },
    { match: 'bookkeeping_case_blockers', rows: [{ blocker_type: 'missing_bank_statement' }] }
  ]);
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: txnCaseRow,
    triggerEventTypes: ['dependency.resolved']
  });
  assert.equal(out.action, 'open_gap'); // missing_bank_statement gap, not a re-match request
  assert.ok(!out.requestFreshEvaluation);
});

test('no target anchor → an indeterminate no-op report and ZERO queries', async () => {
  let queries = 0;
  const c = { query: async () => { queries += 1; return { rows: [] }; } };
  const out = await evaluateReconciliationWake({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', caseRow: {}
  });
  assert.equal(out.goalReport.status, 'indeterminate');
  assert.equal(out.action, 'noop');
  assert.equal(queries, 0); // nothing to project → no I/O
});
