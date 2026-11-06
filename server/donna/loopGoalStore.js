// Donna Loops — the goal layer persistence leaf (uplift Step 2).
//
// See docs/loops-architecture-uplift-design.md §10 (Step 2) + §13. This is the
// thin store BETWEEN the pure goal runtime (loopGoal.js — what to compute) and
// migration 037 (loop_goal_specs / loop_runs / loop_goal_reports /
// bookkeeping_case_dependencies — where it lives). It does NOTHING intelligent:
// it persists already-decided verdicts and reads them back. The judgment ran
// upstream, inside a bounded LoopRun, and is handed here as a finished GoalReport
// (the same Keep-layer discipline as recordReconciliationEvaluation).
//
// THE load-bearing rule (design §8 / INV-13 / "render the persisted verdict"):
// a GoalReport is a thing surfaces render by READING — readLatestGoalReport
// derives from the APPEND-ONLY loop_goal_reports table, never from the
// bookkeeping_cases.latest_goal_report_id pointer (that pointer is a cache; §13.3).
// No function here re-judges anything at read time.
//
// Patterned on memoryCandidates.js: an injected `client`, a to_regclass table-
// presence guard so a pre-037 deploy degrades to a clean no-op (never an aborting
// 42P01), soft-fail to []/null on missing relations, idempotent writes, and an
// explicit client-delete purge (the plain client_id column means the clients
// cascade misses these rows — firm memory dies with its client, CLAUDE.md rail).
// It imports ONLY loopGoal.js (a dependency-free leaf) so it stays cycle-free for
// caseManager / firmDb readers to import without widening an import cycle.

import crypto from 'node:crypto';

import {
  GOAL_STATUSES, EVALUATOR_TYPES, STOP_REASONS,
  validateGoalSpec, computeGoalSpecHash,
  buildLoopRunKey, buildGoalReportKey
} from './loopGoal.js';

export const CASE_DEPENDENCY_TYPES = [
  'blocks', 'spawned_from', 'satisfies', 'aggregates', 'supersedes', 'child_of'
];
export const GOAL_REPORT_SOURCES = ['evaluation', 'correction', 'regression'];

const newId = (prefix) => `${prefix}-${crypto.randomUUID()}`;

// to_regclass returns null (never throws) for a missing relation, so this is a
// transaction-safe presence check: a 033-but-not-037 deploy degrades to a no-op
// instead of aborting the surrounding transaction with 42P01. Keys off
// loop_goal_reports — the load-bearing table the readers depend on.
export const loopGoalTablesPresent = async (client) => {
  if (!client) return false;
  const present = await client.query("select to_regclass('public.loop_goal_reports') as present");
  return Boolean(present.rows[0]?.present);
};

const softFail = (error) => {
  if (error?.code === '42P01' || error?.code === '42703') return { rows: [] };
  throw error;
};

// Persist the RESOLVED GoalSpec snapshot, content-addressed on its hash (§13.5):
// the same product spec content de-dupes to one row; tuning the spec changes the
// content → a new hash → a new row. Idempotent — re-asserting the same spec is a
// no-op (on conflict do nothing). Returns { goalSpecHash, inserted }.
export const persistGoalSpec = async ({ client, spec } = {}) => {
  if (!client || !spec) return null;
  let resolved;
  try { resolved = validateGoalSpec(spec); } catch { return null; }
  if (!(await loopGoalTablesPresent(client))) return null;
  const goalSpecHash = computeGoalSpecHash(resolved);
  const evaluatorType = EVALUATOR_TYPES.includes(resolved.evaluatorType)
    ? resolved.evaluatorType : 'deterministic';
  const result = await client.query(
    `insert into loop_goal_specs
       (goal_spec_hash, goal_key, goal_version, evaluator_type, description, spec, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now())
     on conflict (goal_spec_hash) do nothing
     returning (xmax = 0) as inserted`,
    [goalSpecHash, resolved.key, resolved.version, evaluatorType,
     resolved.description || null, JSON.stringify(resolved)]
  );
  // on-conflict-do-nothing returns no row when the spec already existed.
  return { goalSpecHash, inserted: Boolean(result.rows[0]?.inserted) };
};

// Record one bounded LoopRun receipt (§5, INV-15). APPEND-ONLY: the table's
// trigger forbids UPDATE/DELETE, so this only ever inserts. Idempotent on the
// (case, triggering event) key (§13.4): the deterministic id from buildLoopRunKey
// makes a redelivered inbox event a no-op (on conflict do nothing). A run with no
// trigger event (manual/sweep) gets a fresh id and is not deduped, by design.
export const recordLoopRun = async ({
  client, firmId, clientId, caseId, triggerEventId = null,
  inputSnapshotId = null, outputSnapshotId = null,
  modelCalls = 0, toolCalls = 0, estimatedCost = null, elapsedMs = null,
  progressFingerprintBefore = null, progressFingerprintAfter = null,
  stopReason, evaluatorVersion = null, id = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId) return null;
  if (!STOP_REASONS.includes(stopReason)) return null; // never persist an unknown stop reason
  if (!(await loopGoalTablesPresent(client))) return null;
  const runId = id || (triggerEventId ? buildLoopRunKey({ caseId, triggerEventId }) : newId('lrun'));
  const result = await client.query(
    `insert into loop_runs
       (id, firm_id, client_id, case_id, trigger_event_id, input_snapshot_id, output_snapshot_id,
        model_calls, tool_calls, estimated_cost, elapsed_ms,
        progress_fingerprint_before, progress_fingerprint_after, stop_reason, evaluator_version, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now())
     on conflict (id) do nothing
     returning (xmax = 0) as inserted`,
    [runId, firmId, clientId, caseId, triggerEventId, inputSnapshotId, outputSnapshotId,
     modelCalls, toolCalls, estimatedCost, elapsedMs,
     progressFingerprintBefore, progressFingerprintAfter, stopReason, evaluatorVersion]
  );
  return { id: runId, inserted: Boolean(result.rows[0]?.inserted) };
};

// Persist a GoalReport — the verdict of the loop (§4.2). APPEND-ONLY. The event
// pointer is MANDATORY (§13.2): the caller appends a 'goal_evaluated'
// bookkeeping_case_events row (via caseManager) and passes its id, so every
// report is reachable from the single append-only audit stream; without it we
// refuse to write (the schema NOT NULL is the hard backstop). Idempotent per run
// (§13.4). After the append, the bookkeeping_cases.latest_goal_report_id POINTER
// is refreshed — a cache only; readLatestGoalReport never trusts it (§13.3).
// A correction/waiver/regression passes source + supersedesReportId; it writes a
// NEW row, never mutating the prior receipt (INV-17 / §13.10).
export const recordGoalReport = async ({
  client, firmId, clientId, caseId, eventId, goalReport,
  loopRunId = null, goalSpecHash = null, progressFingerprint = null,
  source = 'evaluation', supersedesReportId = null, id = null
} = {}) => {
  if (!client || !firmId || !clientId || !caseId || !eventId || !goalReport) return null;
  if (!GOAL_STATUSES.includes(goalReport.status)) return null; // refuse an unknown verdict
  if (!GOAL_REPORT_SOURCES.includes(source)) return null;
  const evaluatorType = EVALUATOR_TYPES.includes(goalReport.evaluatorType)
    ? goalReport.evaluatorType : 'deterministic';
  if (!(await loopGoalTablesPresent(client))) return null;

  const snapshotId = goalReport.evaluatedFromSnapshotId || null;
  let reportId = id;
  if (!reportId) {
    try {
      reportId = buildGoalReportKey({
        loopRunId, caseId, snapshotId,
        goalKey: goalReport.goalKey, goalVersion: goalReport.goalVersion,
        evaluatorVersion: goalReport.evaluatorVersion, progressFingerprint
      });
    } catch { reportId = newId('grep'); }
  }

  const result = await client.query(
    `insert into loop_goal_reports
       (id, firm_id, client_id, case_id, loop_run_id, event_id, goal_spec_hash,
        goal_key, goal_version, status, evaluator_type, evaluator_version,
        evaluated_from_snapshot_id, criteria, next_unmet_conditions,
        progress_fingerprint, supersedes_report_id, source, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
             $14::jsonb, $15::jsonb, $16, $17, $18, now())
     on conflict (id) do nothing
     returning (xmax = 0) as inserted`,
    [reportId, firmId, clientId, caseId, loopRunId, eventId, goalSpecHash,
     goalReport.goalKey, goalReport.goalVersion, goalReport.status, evaluatorType,
     goalReport.evaluatorVersion || null, snapshotId,
     JSON.stringify(goalReport.criteria || []),
     JSON.stringify(goalReport.nextUnmetConditions || []),
     progressFingerprint, supersedesReportId, source]
  );
  const inserted = Boolean(result.rows[0]?.inserted);

  // Refresh the denormalized pointer (cache only — §13.3). Never read as truth.
  if (inserted) {
    await client.query(
      `update bookkeeping_cases set latest_goal_report_id = $3, updated_at = now()
        where firm_id = $1 and id = $2`,
      [firmId, caseId, reportId]
    ).catch(() => {});
  }
  return { id: reportId, inserted };
};

// The canonical "render the persisted verdict" read (design §8 / INV-13 / Step 4).
// Derives the latest goal report from the APPEND-ONLY table ordered by created_at —
// NOT from bookkeeping_cases.latest_goal_report_id. This is the structural guard
// against the #315 bug class: a surface that reads this can never render a stale
// cache OVER the verdict, because the cache is not in the query. Soft-fails to
// null on a pre-037 deploy.
export const readLatestGoalReport = async ({ client, firmId, caseId } = {}) => {
  if (!client || !firmId || !caseId) return null;
  const result = await client.query(
    `select id, case_id, loop_run_id, event_id, goal_spec_hash, goal_key, goal_version,
            status, evaluator_type, evaluator_version, evaluated_from_snapshot_id,
            criteria, next_unmet_conditions, progress_fingerprint, supersedes_report_id,
            source, created_at
       from loop_goal_reports
      where firm_id = $1 and case_id = $2
      order by created_at desc
      limit 1`,
    [firmId, caseId]
  ).catch(softFail);
  return result.rows[0] || null;
};

// Batch sibling of readLatestGoalReport for the feed read path (Step 4): the latest
// report per case for a SET of cases, in one DISTINCT ON query, derived from the
// APPEND-ONLY table (never the latest_goal_report_id pointer). Returns a Map keyed by
// case_id. Soft-fails to an empty Map on a pre-037 deploy, so the snapshot read never
// breaks. The single terminal-state derivation (reconciliationTerminalState.js) maps
// each row a surface renders — the structural #315 guard, in bulk.
export const readLatestGoalReportsForCases = async ({ client, firmId, caseIds = [] } = {}) => {
  const byCase = new Map();
  if (!client || !firmId || !Array.isArray(caseIds) || caseIds.length === 0) return byCase;
  const result = await client.query(
    `select distinct on (case_id)
            id, case_id, loop_run_id, event_id, goal_spec_hash, goal_key, goal_version,
            status, evaluator_type, evaluator_version, evaluated_from_snapshot_id,
            criteria, next_unmet_conditions, progress_fingerprint, supersedes_report_id,
            source, created_at
       from loop_goal_reports
      where firm_id = $1 and case_id = any($2)
      order by case_id, created_at desc`,
    [firmId, caseIds]
  ).catch(softFail);
  for (const row of result.rows || []) byCase.set(row.case_id, row);
  return byCase;
};

// Read the resolved GoalSpec snapshots for a set of content hashes (§13.5) — the
// human "done when" labels a report's criteria join to by key (the spec carries the
// criterion descriptions the report rows do not). ONE query; returns a Map keyed by
// goal_spec_hash. Soft-fails to an empty Map on a pre-037 deploy so a reader never
// breaks. Reads only; judges nothing.
export const readGoalSpecs = async ({ client, hashes = [] } = {}) => {
  const byHash = new Map();
  const list = [...new Set((hashes || []).filter(Boolean))];
  if (!client || list.length === 0) return byHash;
  const result = await client.query(
    `select goal_spec_hash, goal_key, goal_version, evaluator_type, description, spec, created_at
       from loop_goal_specs
      where goal_spec_hash = any($1)`,
    [list]
  ).catch(softFail);
  for (const row of result.rows || []) byHash.set(row.goal_spec_hash, row);
  return byHash;
};

// All goal reports for a SET of cases, newest-first per case — the reopen/regression
// history read (§13.10). The superseding-report chain (rows with source 'regression'
// | 'correction', each pointing back via supersedes_report_id) IS the persisted
// "met once is not met forever" record; reading it here is the same render-the-
// persisted-verdict discipline as readLatestGoalReport (no re-inference). Derived
// from the APPEND-ONLY table; ONE query, grouped in JS, capped so a pathological case
// can't unbound the read. Soft-fails to an empty Map on a pre-037 deploy.
export const readGoalReportsForCases = async ({ client, firmId, caseIds = [], limit = 200 } = {}) => {
  const byCase = new Map();
  if (!client || !firmId || !Array.isArray(caseIds) || caseIds.length === 0) return byCase;
  const bounded = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  const result = await client.query(
    `select id, case_id, loop_run_id, event_id, goal_spec_hash, goal_key, goal_version,
            status, evaluator_type, evaluator_version, evaluated_from_snapshot_id,
            criteria, next_unmet_conditions, progress_fingerprint, supersedes_report_id,
            source, created_at
       from loop_goal_reports
      where firm_id = $1 and case_id = any($2)
      order by case_id, created_at desc
      limit $3`,
    [firmId, caseIds, bounded]
  ).catch(softFail);
  for (const row of result.rows || []) {
    if (!byCase.has(row.case_id)) byCase.set(row.case_id, []);
    byCase.get(row.case_id).push(row);
  }
  return byCase;
};

// Record a typed case dependency edge (§6.2). ONE canonical direction only
// (parent → child); inverses are derived by readers, never stored as rows.
// Idempotent on (parent, child, type); refuses self-dependency and unknown verbs
// before any query (the CHECK constraints are the DB backstop).
export const recordCaseDependency = async ({
  client, firmId, clientId, parentCaseId, childCaseId,
  relationshipType, createdEventId = null, id = null
} = {}) => {
  if (!client || !firmId || !clientId || !parentCaseId || !childCaseId) return null;
  if (parentCaseId === childCaseId) return null; // no self-dependency
  if (!CASE_DEPENDENCY_TYPES.includes(relationshipType)) return null;
  if (!(await loopGoalTablesPresent(client))) return null;
  const depId = id || newId('dep');
  const result = await client.query(
    `insert into bookkeeping_case_dependencies
       (id, firm_id, client_id, parent_case_id, child_case_id, relationship_type, created_event_id, created_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (parent_case_id, child_case_id, relationship_type) do nothing
     returning id, (xmax = 0) as inserted`,
    [depId, firmId, clientId, parentCaseId, childCaseId, relationshipType, createdEventId]
  );
  const row = result.rows[0];
  return { id: row?.id || depId, inserted: Boolean(row?.inserted) };
};

// Read all typed dependency edges for a (firm, client) — the in-memory array
// caseDependency.cascadeOrder traverses (parent → child, one canonical direction;
// inverses are derived, never stored). The Step 7 dispatcher reads this to fan a
// resolved case's re-evaluation out to its downstream dependents (§6.2). Soft-fails
// to [] on a pre-037 deploy so the cascade degrades to a clean no-op.
export const readCaseDependencies = async ({ client, firmId, clientId } = {}) => {
  if (!client || !firmId || !clientId) return [];
  const result = await client.query(
    `select id, parent_case_id, child_case_id, relationship_type, resolved_at, created_at
       from bookkeeping_case_dependencies
      where firm_id = $1 and client_id = $2`,
    [firmId, clientId]
  ).catch(softFail);
  return result.rows || [];
};

// Client-delete purge (CLAUDE.md "firm memory dies with its client"). The plain
// client_id column means the clients-delete cascade misses these rows, so this
// explicit hard-delete — run INSIDE the client-delete transaction (to be folded
// into caseManager.purgeLoopsShadowForDeletedClient in a later step) — is
// load-bearing. The append-only tables forbid DELETE; the one sanctioned removal
// is opened by setting `donna.allow_append_only_purge` for this transaction only
// (set local), which the migration's guard trigger honours. Presence-guarded so a
// pre-037 deploy never blocks a client deletion.
export const purgeLoopGoalsForDeletedClient = async ({ client, firmId, clientId } = {}) => {
  const summary = { goal_reports: 0, runs: 0, dependencies: 0 };
  if (!client || !firmId || !clientId) return summary;
  if (!(await loopGoalTablesPresent(client))) return summary;
  // Open the append-only escape hatch for THIS transaction only.
  await client.query("set local donna.allow_append_only_purge = 'on'");
  const reports = await client.query(
    'delete from loop_goal_reports where firm_id = $1 and client_id = $2', [firmId, clientId]
  );
  const runs = await client.query(
    'delete from loop_runs where firm_id = $1 and client_id = $2', [firmId, clientId]
  );
  const deps = await client.query(
    'delete from bookkeeping_case_dependencies where firm_id = $1 and client_id = $2', [firmId, clientId]
  );
  summary.goal_reports = reports.rowCount || 0;
  summary.runs = runs.rowCount || 0;
  summary.dependencies = deps.rowCount || 0;
  return summary;
};
