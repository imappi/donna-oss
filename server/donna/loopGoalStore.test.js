// Donna Loops — goal layer persistence (loopGoalStore) unit tests. Load-bearing
// properties (design §10 Step 2 / §13):
//   - content-addressed spec snapshot: the hash is the key, re-assert is a no-op
//   - runs/reports are idempotent on the §13.4 keys (the loopGoal.js builders ARE
//     the row ids, so a redelivered event never duplicates a receipt)
//   - a GoalReport refuses to persist without its MANDATORY event pointer (§13.2)
//     and refuses an unknown verdict status
//   - readLatestGoalReport derives from the APPEND-ONLY table, NEVER the
//     bookkeeping_cases.latest_goal_report_id cache pointer (§13.3 — the
//     structural kill for the #315 "render the cache over the verdict" class)
//   - the client-delete purge opens the append-only escape hatch and hard-deletes
//   - a pre-037 deploy degrades to a clean no-op, never an aborting 42P01

import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateGoal, buildLoopRunKey, buildGoalReportKey, computeGoalSpecHash } from './loopGoal.js';
import {
  loopGoalTablesPresent, persistGoalSpec, recordLoopRun, recordGoalReport,
  readLatestGoalReport, readLatestGoalReportsForCases, recordCaseDependency, purgeLoopGoalsForDeletedClient
} from './loopGoalStore.js';

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

const SPEC = {
  key: 'reconciliation_gap_resolved', version: '1', evaluatorType: 'deterministic',
  criteria: [{ key: 'matched_or_explained', required: true }]
};

const makeReport = (overrides = {}) => evaluateGoal(
  SPEC,
  [{ key: 'matched_or_explained', status: overrides.status || 'unmet', evidenceRefs: ['no_match_verdict'],
     nextCondition: 'Match this line to a document.' }],
  { snapshotId: overrides.snapshotId || 'snap-1', evaluatorVersion: overrides.evaluatorVersion || null }
);

test('loopGoalTablesPresent: true when to_regclass resolves, false pre-037', async () => {
  assert.equal(await loopGoalTablesPresent(makeMockClient()), true);
  assert.equal(await loopGoalTablesPresent(makeMockClient([], { tablesPresent: false })), false);
});

test('persistGoalSpec: content-addressed on the loopGoal hash; on-conflict-do-nothing', async () => {
  const c = makeMockClient([{ match: 'insert into loop_goal_specs', rows: [{ inserted: true }] }]);
  const out = await persistGoalSpec({ client: c, spec: SPEC });
  assert.equal(out.goalSpecHash, computeGoalSpecHash(SPEC));
  assert.equal(out.inserted, true);
  const insert = c.calls.find((q) => /insert into loop_goal_specs/.test(q.sql));
  assert.match(insert.sql, /on conflict \(goal_spec_hash\) do nothing/);
  assert.equal(insert.params[0], computeGoalSpecHash(SPEC)); // the hash IS the key
});

test('persistGoalSpec: an invalid spec is refused before any query; pre-037 → null', async () => {
  const c = makeMockClient();
  assert.equal(await persistGoalSpec({ client: c, spec: { key: 'x' /* no version/criteria */ } }), null);
  assert.equal(c.calls.length, 0);
  const pre = makeMockClient([], { tablesPresent: false });
  assert.equal(await persistGoalSpec({ client: pre, spec: SPEC }), null);
  assert.ok(!pre.calls.some((q) => /insert into loop_goal_specs/.test(q.sql)));
});

test('recordLoopRun: id is the deterministic §13.4 run key; idempotent on it', async () => {
  const c = makeMockClient([{ match: 'insert into loop_runs', rows: [{ inserted: true }] }]);
  const out = await recordLoopRun({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', triggerEventId: 'evt-1',
    stopReason: 'no_progress', evaluatorVersion: 'gpt-5.4'
  });
  assert.equal(out.id, buildLoopRunKey({ caseId: 'case-1', triggerEventId: 'evt-1' }));
  assert.equal(out.id, 'run:case-1:evt-1');
  const insert = c.calls.find((q) => /insert into loop_runs/.test(q.sql));
  assert.equal(insert.params[0], 'run:case-1:evt-1');
  assert.match(insert.sql, /on conflict \(id\) do nothing/);
});

test('recordLoopRun: an unknown stop_reason is refused before any query', async () => {
  const c = makeMockClient();
  assert.equal(await recordLoopRun({ client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', stopReason: 'bogus' }), null);
  assert.equal(c.calls.length, 0); // never persist a stop reason outside the runtime vocabulary
});

test('recordLoopRun: a manual run (no trigger event) gets a fresh, non-colliding id', async () => {
  const c = makeMockClient([{ match: 'insert into loop_runs', rows: [{ inserted: true }] }]);
  const out = await recordLoopRun({ client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', stopReason: 'waiting' });
  assert.ok(out.id.startsWith('lrun-')); // not deduped by (case, event) — manual wakes are distinct by design
});

test('recordGoalReport: persists the verdict, idempotent per run, and refreshes the POINTER cache', async () => {
  const c = makeMockClient([
    { match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }
    // the 'update bookkeeping_cases' pointer refresh falls through to the default responder
  ]);
  const report = makeReport({ status: 'unmet', evaluatorVersion: 'gpt-5.4' });
  const out = await recordGoalReport({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1',
    eventId: 'evt-9', loopRunId: 'run-1', goalReport: report, goalSpecHash: computeGoalSpecHash(SPEC)
  });
  assert.equal(out.id, buildGoalReportKey({ loopRunId: 'run-1' })); // 'report:run-1'
  assert.equal(out.inserted, true);
  const insert = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
  assert.match(insert.sql, /on conflict \(id\) do nothing/);
  // the mandatory event pointer + the verdict status land in the row
  assert.ok(insert.params.includes('evt-9'));
  assert.ok(insert.params.includes('unmet'));
  // the pointer cache on bookkeeping_cases is refreshed with the new report id
  const ptr = c.calls.find((q) => /update bookkeeping_cases set latest_goal_report_id/.test(q.sql));
  assert.ok(ptr, 'refreshes latest_goal_report_id');
  assert.ok(ptr.params.includes('report:run-1'));
});

test('recordGoalReport: refuses to write without its MANDATORY event pointer (§13.2)', async () => {
  const c = makeMockClient();
  const out = await recordGoalReport({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', loopRunId: 'run-1', goalReport: makeReport()
    // eventId omitted
  });
  assert.equal(out, null);
  assert.equal(c.calls.length, 0); // every report must be reachable from the append-only event stream
});

test('recordGoalReport: refuses an unknown verdict status before any query', async () => {
  const c = makeMockClient();
  const out = await recordGoalReport({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', eventId: 'evt-9',
    goalReport: { goalKey: 'g', goalVersion: '1', status: 'totally_done' }
  });
  assert.equal(out, null);
  assert.equal(c.calls.length, 0);
});

test('recordGoalReport: a correction carries source + supersedes (append-only, INV-17)', async () => {
  const c = makeMockClient([{ match: 'insert into loop_goal_reports', rows: [{ inserted: true }] }]);
  const out = await recordGoalReport({
    client: c, firmId: 'f', clientId: 'cl', caseId: 'case-1', eventId: 'evt-corr',
    goalReport: makeReport({ status: 'waived' }), source: 'correction', supersedesReportId: 'report:run-1', id: 'grep-corr-1'
  });
  assert.equal(out.id, 'grep-corr-1');
  const insert = c.calls.find((q) => /insert into loop_goal_reports/.test(q.sql));
  assert.ok(insert.params.includes('correction'));
  assert.ok(insert.params.includes('report:run-1')); // points back at the superseded receipt, never mutates it
});

test('readLatestGoalReport: reads the APPEND-ONLY table, NOT the cache pointer (§13.3)', async () => {
  const c = makeMockClient([
    { match: 'from loop_goal_reports', rows: [{ id: 'report:run-2', status: 'met', case_id: 'case-1' }] }
  ]);
  const row = await readLatestGoalReport({ client: c, firmId: 'f', caseId: 'case-1' });
  assert.equal(row.id, 'report:run-2');
  const read = c.calls.find((q) => /from loop_goal_reports/.test(q.sql));
  assert.match(read.sql, /order by created_at desc/); // latest by append order
  // THE structural guard: the read must not source the latest_goal_report_id cache.
  assert.ok(!c.calls.some((q) => /latest_goal_report_id/.test(q.sql)),
    'must never read the pointer cache as truth');
});

test('readLatestGoalReport: pre-037 (table absent) soft-fails to null', async () => {
  const missing = makeMockClient([
    { match: 'from loop_goal_reports', throw: Object.assign(new Error('no table'), { code: '42P01' }) }
  ]);
  assert.equal(await readLatestGoalReport({ client: missing, firmId: 'f', caseId: 'case-1' }), null);
});

test('readLatestGoalReportsForCases: batch DISTINCT ON the append-only table → Map by case (Step 4)', async () => {
  const c = makeMockClient([
    { match: 'from loop_goal_reports', rows: [
      { case_id: 'case-A', status: 'met', goal_key: 'reconciliation_gap_resolved' },
      { case_id: 'case-B', status: 'unmet', goal_key: 'reconciliation_gap_resolved' }
    ] }
  ]);
  const map = await readLatestGoalReportsForCases({ client: c, firmId: 'f', caseIds: ['case-A', 'case-B'] });
  assert.equal(map.get('case-A').status, 'met');
  assert.equal(map.get('case-B').status, 'unmet');
  const read = c.calls.find((q) => /from loop_goal_reports/.test(q.sql));
  assert.match(read.sql, /distinct on \(case_id\)/);
  assert.match(read.sql, /order by case_id, created_at desc/); // latest per case by append order
  assert.match(read.sql, /case_id = any\(\$2\)/);
  // the structural guard: still never the pointer cache.
  assert.ok(!c.calls.some((q) => /latest_goal_report_id/.test(q.sql)));
});

test('readLatestGoalReportsForCases: empty caseIds is a zero-query empty Map; pre-037 soft-fails to empty', async () => {
  const c = makeMockClient();
  const empty = await readLatestGoalReportsForCases({ client: c, firmId: 'f', caseIds: [] });
  assert.equal(empty.size, 0);
  assert.equal(c.calls.length, 0); // never queries with no cases

  const missing = makeMockClient([
    { match: 'from loop_goal_reports', throw: Object.assign(new Error('no table'), { code: '42P01' }) }
  ]);
  const out = await readLatestGoalReportsForCases({ client: missing, firmId: 'f', caseIds: ['case-A'] });
  assert.equal(out.size, 0);
});

test('recordCaseDependency: refuses self-dependency and unknown verbs before any query', async () => {
  const c = makeMockClient();
  assert.equal(await recordCaseDependency({ client: c, firmId: 'f', clientId: 'cl', parentCaseId: 'a', childCaseId: 'a', relationshipType: 'blocks' }), null);
  assert.equal(await recordCaseDependency({ client: c, firmId: 'f', clientId: 'cl', parentCaseId: 'a', childCaseId: 'b', relationshipType: 'sometimes_blocks' }), null);
  assert.equal(c.calls.length, 0);
});

test('recordCaseDependency: one canonical (parent→child) edge, idempotent on (parent, child, type)', async () => {
  const c = makeMockClient([
    { match: 'insert into bookkeeping_case_dependencies', rows: [{ id: 'dep-1', inserted: true }] }
  ]);
  const out = await recordCaseDependency({
    client: c, firmId: 'f', clientId: 'cl', parentCaseId: 'evidence-1', childCaseId: 'coding-1', relationshipType: 'blocks'
  });
  assert.equal(out.inserted, true);
  const insert = c.calls.find((q) => /insert into bookkeeping_case_dependencies/.test(q.sql));
  assert.match(insert.sql, /on conflict \(parent_case_id, child_case_id, relationship_type\) do nothing/);
});

test('purgeLoopGoalsForDeletedClient: opens the append-only hatch and hard-deletes all three tables', async () => {
  const c = makeMockClient([
    { match: 'delete from loop_goal_reports', rowCount: 4 },
    { match: 'delete from loop_runs', rowCount: 7 },
    { match: 'delete from bookkeeping_case_dependencies', rowCount: 2 }
  ]);
  const out = await purgeLoopGoalsForDeletedClient({ client: c, firmId: 'f', clientId: 'cl' });
  assert.deepEqual(out, { goal_reports: 4, runs: 7, dependencies: 2 });
  // the escape hatch is set LOCAL (this txn only) before the deletes — the only
  // sanctioned removal from the append-only tables.
  assert.ok(c.calls.some((q) => /set local donna\.allow_append_only_purge = 'on'/.test(q.sql)));
});

test('purgeLoopGoalsForDeletedClient: pre-037 → zeros, no deletes, no hatch', async () => {
  const missing = makeMockClient([], { tablesPresent: false });
  const out = await purgeLoopGoalsForDeletedClient({ client: missing, firmId: 'f', clientId: 'cl' });
  assert.deepEqual(out, { goal_reports: 0, runs: 0, dependencies: 0 });
  assert.ok(!missing.calls.some((q) => /^delete from/.test(q.sql.toLowerCase().trim())));
  assert.ok(!missing.calls.some((q) => /allow_append_only_purge/.test(q.sql)));
});
