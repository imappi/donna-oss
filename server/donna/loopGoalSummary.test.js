// node --test — the Step 8 goal-summary read/assembly (loopGoalSummary.js).
// Pure helpers tested directly; attachGoalSummaries tested with a mock client that
// routes on SQL text. No DB / no LLM — INV-13: it only reads + assembles persisted
// verdicts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseAnsweredCount, buildRegressionHistory, buildGoalSummary, attachGoalSummaries,
  listResolvedGoalsForClient
} from './loopGoalSummary.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const reconLatest = {
  id: 'rep-recon-2', case_id: 'case-recon', goal_spec_hash: 'hash-recon',
  goal_key: 'reconciliation_gap_resolved', goal_version: '1',
  status: 'unmet', evaluator_type: 'deterministic', evaluator_version: 'gpt-5.4',
  criteria: [{ key: 'matched_or_explained', status: 'unmet',
    evidenceRefs: ['no_match_verdict'], nextCondition: 'No match found for this line.' }],
  next_unmet_conditions: ['No match found for this line.'],
  supersedes_report_id: 'rep-recon-1', source: 'regression', created_at: '2026-06-21T10:00:00Z'
};
const reconEarlier = {
  id: 'rep-recon-1', case_id: 'case-recon', goal_spec_hash: 'hash-recon',
  goal_key: 'reconciliation_gap_resolved', goal_version: '1',
  status: 'met', evaluator_type: 'deterministic', evaluator_version: 'gpt-5.4',
  criteria: [{ key: 'matched_or_explained', status: 'met', evidenceRefs: ['sticky_match'] }],
  next_unmet_conditions: [], supersedes_report_id: null, source: 'evaluation',
  created_at: '2026-06-20T10:00:00Z'
};
const codingLatest = {
  id: 'rep-coding-1', case_id: 'case-coding', goal_spec_hash: 'hash-coding',
  goal_key: 'ask_batch_answered', goal_version: '1',
  status: 'unmet', evaluator_type: 'deterministic', evaluator_version: null,
  criteria: [{ key: 'all_questions_answered', status: 'unmet',
    evidenceRefs: ['answered_2_of_3'], nextCondition: '1 of 3 client answers still outstanding.' }],
  next_unmet_conditions: ['1 of 3 client answers still outstanding.'],
  supersedes_report_id: null, source: 'evaluation', created_at: '2026-06-21T09:00:00Z'
};

const specs = [
  { goal_spec_hash: 'hash-recon', goal_key: 'reconciliation_gap_resolved', goal_version: '1',
    evaluator_type: 'deterministic',
    description: 'The reconciliation target is settled by a match or explained as immaterial.',
    spec: { key: 'reconciliation_gap_resolved', version: '1', evaluatorType: 'deterministic',
      description: 'The reconciliation target is settled by a match or explained as immaterial.',
      criteria: [{ key: 'matched_or_explained', required: true,
        description: 'A sticky match settles the target, or the verdict is auto_explained.' }] } },
  { goal_spec_hash: 'hash-coding', goal_key: 'ask_batch_answered', goal_version: '1',
    evaluator_type: 'deterministic',
    description: 'Every client question this ask batch is waiting on has been answered.',
    spec: { key: 'ask_batch_answered', version: '1', evaluatorType: 'deterministic',
      description: 'Every client question this ask batch is waiting on has been answered.',
      criteria: [{ key: 'all_questions_answered', required: true,
        description: 'No evidence request blocking this batch is still awaiting a client answer.' }] } }
];

const makeClient = (reports, { throwCode = null } = {}) => ({
  query: async (sql, params) => {
    if (throwCode) { const e = new Error('relation missing'); e.code = throwCode; throw e; }
    const text = String(sql);
    if (text.includes('distinct on (case_id)')) {
      const ids = params[1];
      const byCase = new Map();
      for (const r of reports) {
        if (!ids.includes(r.case_id)) continue;
        const prev = byCase.get(r.case_id);
        if (!prev || new Date(r.created_at) > new Date(prev.created_at)) byCase.set(r.case_id, r);
      }
      const rows = [...byCase.values()];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('from loop_goal_reports')) {
      const ids = params[1];
      const rows = reports.filter((r) => ids.includes(r.case_id)).slice().sort((a, b) =>
        (a.case_id < b.case_id ? -1 : a.case_id > b.case_id ? 1 : (new Date(b.created_at) - new Date(a.created_at))));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('from loop_goal_specs')) {
      const hashes = params[0];
      const rows = specs.filter((s) => hashes.includes(s.goal_spec_hash));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
});

// ── parseAnsweredCount ────────────────────────────────────────────────────────

test('parseAnsweredCount: reads answered_N_of_M off a criterion evidenceRef', () => {
  assert.deepEqual(parseAnsweredCount(codingLatest), { answered: 2, total: 3 });
});

test('parseAnsweredCount: null when no answered ref (reconciliation goal)', () => {
  assert.equal(parseAnsweredCount(reconLatest), null);
  assert.equal(parseAnsweredCount(null), null);
  assert.equal(parseAnsweredCount({ criteria: [{ key: 'x', evidenceRefs: ['sticky_match'] }] }), null);
});

// ── buildRegressionHistory ────────────────────────────────────────────────────

test('buildRegressionHistory: counts only non-evaluation (superseding) reports, newest first', () => {
  const h = buildRegressionHistory([reconLatest, reconEarlier]);
  assert.equal(h.reopen_count, 1);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].id, 'rep-recon-2');
  assert.equal(h.entries[0].source, 'regression');
  assert.equal(h.entries[0].supersedes_report_id, 'rep-recon-1');
});

test('buildRegressionHistory: a clean evaluation-only history has zero reopens', () => {
  const h = buildRegressionHistory([codingLatest]);
  assert.equal(h.reopen_count, 0);
  assert.deepEqual(h.entries, []);
  assert.deepEqual(buildRegressionHistory([]), { reopen_count: 0, entries: [] });
});

// ── buildGoalSummary ──────────────────────────────────────────────────────────

test('buildGoalSummary: joins report status to spec criterion descriptions by key', () => {
  const specRow = specs[0];
  const summary = buildGoalSummary({ report: reconLatest, specRow });
  assert.equal(summary.key, 'reconciliation_gap_resolved');
  assert.equal(summary.status, 'unmet');
  assert.equal(summary.title, specRow.description);
  assert.equal(summary.criteria.length, 1);
  assert.equal(summary.criteria[0].status, 'unmet'); // from the REPORT
  assert.equal(summary.criteria[0].description, // from the SPEC
    'A sticky match settles the target, or the verdict is auto_explained.');
  assert.equal(summary.criteria[0].next_condition, 'No match found for this line.');
  assert.equal(summary.evaluator_version, 'gpt-5.4'); // the receipt is surfaced
});

test('buildGoalSummary: falls back to humanizable key when the spec snapshot is absent', () => {
  const summary = buildGoalSummary({ report: reconLatest, specRow: null });
  assert.equal(summary.title, null);
  assert.equal(summary.criteria[0].description, null); // no spec → UI humanizes the key
  assert.equal(summary.criteria[0].key, 'matched_or_explained');
});

test('buildGoalSummary: null report → null', () => {
  assert.equal(buildGoalSummary({ report: null }), null);
});

// ── attachGoalSummaries ───────────────────────────────────────────────────────

test('attachGoalSummaries: attaches goal per case; a case with no report gets goal:null', async () => {
  const client = makeClient([reconLatest, reconEarlier, codingLatest]);
  const cases = [
    { id: 'case-recon', case_type: 'reconciliation', blockers: [] },
    { id: 'case-coding', case_type: 'coding', blockers: [] },
    { id: 'case-noreport', case_type: 'upload', blockers: [] }
  ];
  const out = await attachGoalSummaries({ client, firmId: 'firm-1', clientId: 'cl-1', cases });

  const recon = out.find((c) => c.id === 'case-recon').goal;
  assert.equal(recon.status, 'unmet');
  assert.equal(recon.title, specs[0].description);
  // reconciliation cases carry the canonical Step-4 terminal state
  assert.equal(recon.terminal.reconciliation_status, 'needs_review');
  assert.equal(recon.terminal.goal_status, 'not_achieved');
  assert.equal(recon.terminal.verdict_present, true);
  // the latest report was a regression → one reopen in history
  assert.equal(recon.history.reopen_count, 1);
  assert.equal(recon.answered, null);

  const coding = out.find((c) => c.id === 'case-coding').goal;
  assert.equal(coding.status, 'unmet');
  assert.deepEqual(coding.answered, { answered: 2, total: 3 });
  assert.equal(coding.terminal, null); // not a reconciliation case
  assert.equal(coding.history.reopen_count, 0);

  assert.equal(out.find((c) => c.id === 'case-noreport').goal, null);
});

test('attachGoalSummaries: no reports at all → every case goal:null (inert at shadow)', async () => {
  const client = makeClient([]);
  const cases = [{ id: 'case-recon', case_type: 'reconciliation', blockers: [] }];
  const out = await attachGoalSummaries({ client, firmId: 'firm-1', clientId: 'cl-1', cases });
  assert.equal(out[0].goal, null);
});

test('attachGoalSummaries: pre-037 deploy (42P01) degrades to goal:null, never throws', async () => {
  const client = makeClient([reconLatest], { throwCode: '42P01' });
  const cases = [{ id: 'case-recon', case_type: 'reconciliation', blockers: [] }];
  const out = await attachGoalSummaries({ client, firmId: 'firm-1', clientId: 'cl-1', cases });
  assert.equal(out[0].goal, null);
});

test('attachGoalSummaries: empty cases / no client → passthrough, no query', async () => {
  assert.deepEqual(await attachGoalSummaries({ client: makeClient([]), firmId: 'f', cases: [] }), []);
  const cases = [{ id: 'c', case_type: 'coding' }];
  assert.deepEqual(await attachGoalSummaries({ client: null, firmId: 'f', cases }), cases);
});

// ── listResolvedGoalsForClient ────────────────────────────────────────────────

// A terminal case whose LATEST report is met (what the SQL exists-clause selects).
const resolvedMetReport = {
  id: 'rep-resolved-1', case_id: 'case-resolved', goal_spec_hash: 'hash-recon',
  goal_key: 'reconciliation_gap_resolved', goal_version: '1',
  status: 'met', evaluator_type: 'deterministic', evaluator_version: 'gpt-5.4',
  criteria: [{ key: 'matched_or_explained', status: 'met', evidenceRefs: ['sticky_match'] }],
  next_unmet_conditions: [], supersedes_report_id: null, source: 'evaluation',
  created_at: '2026-06-21T12:00:00Z'
};
const resolvedCaseRow = {
  id: 'case-resolved', case_type: 'reconciliation', status: 'resolved',
  title: 'ACME invoice', summary: 'Matched to bank line.',
  primary_object_type: 'document', primary_object_id: 'doc-1',
  due_at: null, last_activity_at: '2026-06-21T12:00:00Z'
};

// Mock client for the lister: the cases query is checked BEFORE the report queries
// because the lister's exists-subquery ALSO contains 'from loop_goal_reports'.
const makeResolvedClient = (caseRows, reports) => ({
  query: async (sql, params) => {
    const text = String(sql);
    if (text.includes('from bookkeeping_cases')) {
      return { rows: caseRows, rowCount: caseRows.length };
    }
    if (text.includes('distinct on (case_id)')) {
      const ids = params[1];
      const byCase = new Map();
      for (const r of reports) {
        if (!ids.includes(r.case_id)) continue;
        const prev = byCase.get(r.case_id);
        if (!prev || new Date(r.created_at) > new Date(prev.created_at)) byCase.set(r.case_id, r);
      }
      const rows = [...byCase.values()];
      return { rows, rowCount: rows.length };
    }
    if (text.includes('from loop_goal_reports')) {
      const ids = params[1];
      const rows = reports.filter((r) => ids.includes(r.case_id));
      return { rows, rowCount: rows.length };
    }
    if (text.includes('from loop_goal_specs')) {
      const hashes = params[0];
      const rows = specs.filter((s) => hashes.includes(s.goal_spec_hash));
      return { rows, rowCount: rows.length };
    }
    return { rows: [], rowCount: 0 };
  }
});

test('listResolvedGoalsForClient: lists terminal cases with a met latest goal, enriched with the verdict', async () => {
  const client = makeResolvedClient([resolvedCaseRow], [resolvedMetReport]);
  const out = await listResolvedGoalsForClient({ client, firmId: 'firm-1', clientId: 'cl-1' });
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 'case-resolved');
  assert.equal(out[0].status, 'resolved');
  // enriched with the persisted GoalReport (INV-13), joined to its spec
  assert.equal(out[0].goal.status, 'met');
  assert.equal(out[0].goal.title, specs[0].description);
  assert.equal(out[0].goal.evaluator_version, 'gpt-5.4'); // the receipt
  assert.ok(out[0].goal.terminal); // reconciliation case carries the Step-4 terminal state
});

test('listResolvedGoalsForClient: pre-037 (cases query throws 42P01) → [] (soft-fail, never throws)', async () => {
  const client = { query: async () => { const e = new Error('relation missing'); e.code = '42P01'; throw e; } };
  assert.deepEqual(await listResolvedGoalsForClient({ client, firmId: 'firm-1', clientId: 'cl-1' }), []);
});

test('listResolvedGoalsForClient: no client / no terminal cases → []', async () => {
  assert.deepEqual(await listResolvedGoalsForClient({ client: null, firmId: 'f', clientId: 'c' }), []);
  assert.deepEqual(await listResolvedGoalsForClient({ client: makeResolvedClient([], []), firmId: 'f', clientId: 'c' }), []);
});
