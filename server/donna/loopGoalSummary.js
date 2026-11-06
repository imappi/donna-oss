// Donna Loops — the goal SUMMARY read/assembly for the "show the goal" UI (uplift Step 8).
//
// See docs/loops-architecture-uplift-design.md §10 (Step 8 — "Show the goal to the
// user") + §8 + INV-13, and the CLAUDE.md rail "Render the persisted verdict, not the
// legacy layer". Step 8 gives every case panel: Goal (what Donna is trying to
// accomplish) · Done-when (the criteria) · Progress (which criteria are met) · Stopped-
// because (the terminal state / next-unmet conditions), plus the answered-count and the
// regression/reopen history.
//
// The load-bearing rule is INV-13 / "render the persisted verdict": this module READS
// the append-only loop_goal_reports (+ the content-addressed loop_goal_specs) and
// ASSEMBLES a render shape. It judges nothing, infers nothing, calls no model. The
// verdict ran upstream inside a bounded LoopRun and was persisted; here we only
//   - join the latest report to its resolved spec (the human "done when" labels),
//   - parse the answered-count the coding evaluator already stamped into a criterion's
//     evidenceRefs (loopGoalRegistry.evaluateCodingGoal — `answered_<done>_of_<total>`),
//   - derive the canonical reconciliation terminal state (Step 4,
//     reconciliationTerminalState.js), and
//   - reconstruct the reopen history from the superseding-report chain (§13.10).
//
// Absent-safe: a case with no persisted report gets `goal: null` (the panel renders
// nothing), so this is inert until the goal layer is producing reports (LOOPS_SHADOW /
// canary) — additive, byte-identical to today below that.

import {
  readLatestGoalReportsForCases, readGoalReportsForCases, readGoalSpecs
} from './loopGoalStore.js';
import { deriveReconciliationTerminalState } from './reconciliationTerminalState.js';
import { LOOP_TERMINAL_STATUSES } from './caseManager.js';

// `answered_<done>_of_<total>` rides the coding goal's criterion evidenceRefs
// (loopGoalRegistry.evaluateCodingGoal). Parse it back for the "Answered N of M" line —
// reading the persisted verdict, not recomputing the count. Returns null when no such
// ref exists (e.g. the reconciliation goal, whose single criterion carries none).
const ANSWERED_RE = /^answered_(\d+)_of_(\d+)$/;
export const parseAnsweredCount = (report) => {
  for (const c of (Array.isArray(report?.criteria) ? report.criteria : [])) {
    for (const ref of (Array.isArray(c?.evidenceRefs) ? c.evidenceRefs : [])) {
      const m = ANSWERED_RE.exec(String(ref));
      if (m) return { answered: Number(m[1]), total: Number(m[2]) };
    }
  }
  return null;
};

// The reopen/regression history is the persisted record of "met once is not met
// forever" (§13.10): each non-'evaluation' report (source 'regression' | 'correction')
// is a superseding row pointing back at the report it invalidated. Pure given the
// newest-first report list. Returns { reopen_count, entries } (newest first).
export const buildRegressionHistory = (reports = []) => {
  const entries = [];
  for (const r of (Array.isArray(reports) ? reports : [])) {
    if (r?.source && r.source !== 'evaluation') {
      entries.push({
        id: r.id,
        source: r.source,
        status: r.status,
        supersedes_report_id: r.supersedes_report_id || null,
        created_at: r.created_at || null
      });
    }
  }
  return { reopen_count: entries.length, entries };
};

// Join the latest report (the persisted verdict) to its resolved spec (the human
// "done when" labels) into one render shape. Pure given the rows — the DB reads happen
// in attachGoalSummaries. A criterion's status comes from the REPORT (the verdict); its
// description/required from the SPEC, joined by key. Falls back gracefully when the
// spec snapshot is absent (the criterion key still renders).
export const buildGoalSummary = ({ report, specRow = null, history = null, terminal = null } = {}) => {
  if (!report) return null;
  const spec = specRow?.spec || null;
  const specCriteria = Array.isArray(spec?.criteria) ? spec.criteria : [];
  const specByKey = new Map(specCriteria.map((c) => [c.key, c]));
  const criteria = (Array.isArray(report.criteria) ? report.criteria : []).map((c) => {
    const sc = specByKey.get(c.key) || null;
    return {
      key: c.key,
      description: sc?.description || null,
      required: sc ? sc.required !== false : true,
      status: c.status || null,
      next_condition: c.nextCondition || null
    };
  });
  return {
    key: report.goal_key,
    version: report.goal_version,
    title: specRow?.description || spec?.description || null,
    status: report.status,
    evaluator_type: report.evaluator_type || null,
    // The receipt: the model id for a model-assisted evaluator, the evaluator version
    // otherwise ("the model id is part of the receipt" rail — surface it, don't hide it).
    evaluator_version: report.evaluator_version || null,
    evaluated_at: report.created_at || null,
    source: report.source || 'evaluation',
    criteria,
    next_unmet_conditions: Array.isArray(report.next_unmet_conditions) ? report.next_unmet_conditions : [],
    answered: parseAnsweredCount(report),
    terminal,
    history: history || { reopen_count: 0, entries: [] }
  };
};

// Batch enrichment for the close-blockers feed: attach `goal` to each case (null when
// the case has no persisted report). ONE latest-report query + ONE history query + ONE
// spec query for the whole set. Reconciliation cases also carry the canonical Step-4
// terminal state (deriveReconciliationTerminalState reads the report row directly).
export const attachGoalSummaries = async ({ client, firmId, clientId, cases = [] } = {}) => {
  const list = Array.isArray(cases) ? cases : [];
  if (!client || !firmId || list.length === 0) return list;
  const caseIds = list.map((c) => c?.id).filter(Boolean);
  if (caseIds.length === 0) return list.map((c) => ({ ...c, goal: null }));

  const latestByCase = await readLatestGoalReportsForCases({ client, firmId, caseIds });
  if (latestByCase.size === 0) return list.map((c) => ({ ...c, goal: null }));

  const reportsByCase = await readGoalReportsForCases({ client, firmId, caseIds });
  const hashes = [...new Set([...latestByCase.values()].map((r) => r.goal_spec_hash).filter(Boolean))];
  const specsByHash = await readGoalSpecs({ client, hashes });

  return list.map((c) => {
    const report = latestByCase.get(c?.id) || null;
    if (!report) return { ...c, goal: null };
    const history = buildRegressionHistory(reportsByCase.get(c.id) || []);
    const terminal = c.case_type === 'reconciliation'
      ? deriveReconciliationTerminalState(report, { legacyStatus: null })
      : null;
    const specRow = report.goal_spec_hash ? (specsByHash.get(report.goal_spec_hash) || null) : null;
    return { ...c, goal: buildGoalSummary({ report, specRow, history, terminal }) };
  });
};

// List a client's RESOLVED goals — the complement of the close-blockers feed. That
// feed lists only NON-terminal cases holding an open blocker, so a case whose goal
// was MET (and therefore went terminal) drops off it with no trace — the bookkeeper
// loses the record that the work was finished and WHY. This lists the TERMINAL cases
// (LOOP_TERMINAL_STATUSES) whose LATEST persisted goal report is met/waived, each
// enriched with the same goal render shape (attachGoalSummaries → Goal / done-when /
// progress / reopen history / the evaluator receipt).
//
// Render-the-persisted-verdict (INV-12/INV-13): a case appears here BECAUSE its latest
// loop_goal_report is met/waived — never a fresh inference, never the legacy status
// column. The `exists` clause pins on the latest report (max created_at) so a case that
// later REGRESSED (its newest report flipped to unmet, §13.10) correctly drops OUT of
// the resolved view and back onto the close feed. Soft-fails to [] on a pre-037 deploy
// (the query references loop_goal_reports), so prod is byte-identical until the goal
// layer is producing reports.
export const listResolvedGoalsForClient = async ({ client, firmId, clientId, limit = 100 } = {}) => {
  if (!client || !firmId || !clientId) return [];
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const cases = await client.query(
    `select c.id, c.case_type, c.status, c.title, c.summary,
            c.primary_object_type, c.primary_object_id, c.due_at, c.last_activity_at
       from bookkeeping_cases c
      where c.firm_id = $1 and c.client_id = $2
        and c.status = any($3::text[])
        and exists (
          select 1 from loop_goal_reports r
           where r.firm_id = c.firm_id and r.case_id = c.id
             and r.status in ('met', 'waived')
             and r.created_at = (
               select max(r2.created_at) from loop_goal_reports r2
                where r2.firm_id = c.firm_id and r2.case_id = c.id))
      order by c.last_activity_at desc
      limit $4`,
    [firmId, clientId, LOOP_TERMINAL_STATUSES, bounded]
  ).catch(() => ({ rows: [] }));
  const rows = (cases.rows || []).map((c) => ({
    id: c.id,
    case_type: c.case_type,
    status: c.status,
    title: c.title || null,
    summary: c.summary || null,
    primary_object_type: c.primary_object_type || null,
    primary_object_id: c.primary_object_id || null,
    due_at: c.due_at || null,
    last_activity_at: c.last_activity_at
  }));
  if (rows.length === 0) return [];
  return attachGoalSummaries({ client, firmId, clientId, cases: rows });
};
