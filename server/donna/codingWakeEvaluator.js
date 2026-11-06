// Donna Loops — the coding (ask-batch) `evaluate` adapter for the LoopRun engine
// (design §6.2 typed-dependency cascade; the §13.8 "goal-report-only" action).
//
// This is the SECOND case-type wake evaluator (reconciliation was the first), and
// the one that makes the cascade real: when an evidence case resolves, the Step-7
// dispatcher fans a `dependency.resolved` event out to every coding case that
// evidence BLOCKS (§6.2 "Evidence case E blocks coding case C"), and THIS adapter
// re-evaluates the coding goal "every blocking question is answered".
//
// CLAUDE.md "Keep"-layer / "render the persisted verdict": it reads ONLY persisted
// workflow state — the typed dependency graph (which evidence cases block this
// batch) + each evidence case's open missing_client_answer blocker (answered = none
// open) — never the reply's CONTENT (INV-12). The strong-model reading of the reply
// is the proposal pipeline's job; the loop only counts answered questions. It is
// READ-ONLY (opens/resolves nothing — that is a producer's job), so a wake can never
// collide with the evidence/coding producers. Every query soft-fails to empty so a
// wake degrades to an indeterminate no-op rather than aborting the drain.

import { evaluateCodingGoal, CODING_ASK_BATCH_GOAL } from './loopGoalRegistry.js';
import { readCaseDependencies } from './loopGoalStore.js';
import { blockedBy } from './caseDependency.js';
import { computeProgressFingerprint } from './loopGoal.js';

// How many of the blocking evidence cases have been answered — an evidence case is
// answered once it has NO open missing_client_answer blocker (resumeFromClientReply
// resolves it on the client's reply). A blocking case with no open answer-blocker
// row at all (already cleared, or never had one) counts as answered.
//
// EXPORTED so the CLOSE producer (codingCloseProducer.js) counts "answered" off the
// SAME definition the read-only wake evaluator does — the evaluator/producer split
// must never disagree on whether a batch is fully answered (that disagreement is
// exactly the "GoalReport says done, blocker says waiting" drift this loop closes).
export const countAnsweredEvidenceCases = async (client, blockingCaseIds) => {
  if (!blockingCaseIds.length) return 0;
  const res = await client.query(
    `select case_id,
            count(*) filter (
              where status = 'open' and blocker_type = 'missing_client_answer'
            ) as open_answers
       from bookkeeping_case_blockers
      where case_id = any($1)
      group by case_id`,
    [blockingCaseIds]
  ).catch(() => ({ rows: [] }));
  const openByCase = new Map((res.rows || []).map((r) => [r.case_id, Number(r.open_answers) || 0]));
  return blockingCaseIds.filter((id) => (openByCase.get(id) || 0) === 0).length;
};

// The injected engine evaluator for the coding loop. Reads the §6.2 graph + the
// blocking evidence cases' answered state, projects via the single evaluator, and
// returns the engine-shaped outcome. Zero model calls — workflow-only, INV-15
// bounded. The answered count rides openBlockerTypes so each new answer changes the
// progress fingerprint (real progress, never a false no_progress stall while unmet).
export const evaluateCodingWake = async ({
  client, firmId, clientId, caseId
} = {}) => {
  const baseUsage = { modelCalls: 0, toolCalls: 1, elapsedMs: 0 };

  // No anchor → nothing to project; still produce an (indeterminate) report so the
  // wake is bounded and receipted, never a silent no-op.
  if (!client || !firmId || !clientId || !caseId) {
    const { goalReport, action } = evaluateCodingGoal({});
    return {
      goalReport, spec: CODING_ASK_BATCH_GOAL, action,
      progressFingerprint: computeProgressFingerprint({
        goalStatus: goalReport.status, criteria: goalReport.criteria
      }),
      usage: baseUsage, evaluatorVersion: null
    };
  }

  const deps = await readCaseDependencies({ client, firmId, clientId });
  // The evidence cases that block this coding case (activeOnly:false — we count the
  // structural blockers regardless of whether an edge was marked resolved).
  const blockingCaseIds = blockedBy(deps, caseId, { activeOnly: false });
  const totalBlocking = blockingCaseIds.length;
  const answered = await countAnsweredEvidenceCases(client, blockingCaseIds);

  const { goalReport, action } = evaluateCodingGoal({ totalBlocking, answered });
  const progressFingerprint = computeProgressFingerprint({
    goalStatus: goalReport.status,
    criteria: goalReport.criteria,
    openBlockerTypes: [`answered_${answered}_of_${totalBlocking}`]
  });

  return {
    goalReport,
    spec: CODING_ASK_BATCH_GOAL,
    action,
    progressFingerprint,
    usage: baseUsage,
    evaluatorVersion: null
  };
};
