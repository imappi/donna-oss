// Donna Loops — the coding (ask-batch) CLOSE producer: the deferred half of the
// §6.2 evidence→coding cascade (design §6.2 / §13.8).
//
// The wake evaluator (codingWakeEvaluator.js) is READ-ONLY by contract
// (wakeAction `goal_report_only`): on a `dependency.resolved` wake it re-projects
// the coding goal "every blocking question is answered" and persists a GoalReport,
// but it RESOLVES NOTHING. So a fully-answered coding case's GoalReport reads `met`
// while its `missing_client_answer` blocker stays open and its status stays
// `waiting_client` — the exact "GoalReport says done, blocker ladder says waiting"
// split CLAUDE.md warns about. This module is the producer that closes it.
//
// It mirrors reconciliation's evaluator/producer split: just as
// reconciliationWakeEvaluator re-projects while resolveReconciliationGapCaseOnMatch
// is the producer that resolves the gap blocker AND persists the same declarative
// met GoalReport, this producer — when the client's reply answers the LAST
// outstanding question a coding case is blocked on — resolves that batch's
// `missing_client_answer` blocker AND persists the met coding GoalReport, so the
// verdict and the blocker ladder move as ONE.
//
// CLAUDE.md "Keep"-layer / "render the persisted verdict": it reads ONLY persisted
// workflow state — the typed dependency graph (which evidence cases block the
// batch) + each evidence case's open answer blocker — never the reply's CONTENT
// (INV-12). The met verdict is the SAME declarative `evaluateCodingGoal` projection
// the read-only wake would mint; the producer does not re-judge.
//
// Trigger + transaction posture: evidenceReplyResume.resumeFromClientReply calls
// this AFTER it resolves an evidence case's answer blocker, passing that evidence
// case id. We walk the graph to the coding case(s) the evidence case UNBLOCKS
// (§6.2 'blocks' children) and close any whose every blocking question is now
// answered. It runs INSIDE the inbox-drain transaction the caller owns — NOT a
// post-commit runShadow hook — because its trigger is loop-internal (the drain),
// not a firmDb business write to ride. Like the rest of the resume it is therefore
// a shadow-level workflow mutation; the cross-case cascade fan-out (the dispatcher)
// remains the part held at canary+. No LLM, no accounting write, no client send.

import { appendCaseEvent, resolveBlocker } from './caseManager.js';
import { readCaseDependencies, persistGoalSpec, recordGoalReport, loopGoalTablesPresent } from './loopGoalStore.js';
import { unblocks, blockedBy } from './caseDependency.js';
import { evaluateCodingGoal, CODING_ASK_BATCH_GOAL } from './loopGoalRegistry.js';
import { countAnsweredEvidenceCases } from './codingWakeEvaluator.js';

// Persist the met coding GoalReport for a resolved batch (§13.2), mirroring
// loopsShadowProducers.recordReconciliationGoalReport. The bookkeeping_case_events
// pointer is MANDATORY: append a 'goal_evaluated' event FIRST and pass its id, so
// every report is reachable from the single append-only audit stream. Presence-
// guarded on the 037 goal tables so a pre-037 deploy degrades to a clean no-op
// (and never leaves a goal_evaluated event with no report behind it).
const recordCodingGoalReport = async ({
  client, firmId, clientId, caseId, goalReport, triggerEventId = null
}) => {
  if (!caseId || !goalReport) return null;
  if (!(await loopGoalTablesPresent(client))) return null;
  const spec = await persistGoalSpec({ client, spec: CODING_ASK_BATCH_GOAL });
  const evt = await appendCaseEvent({
    client, firmId, clientId, caseId,
    eventType: 'goal_evaluated', triggerEventId,
    payload: {
      goal_key: goalReport.goalKey, goal_version: goalReport.goalVersion,
      status: goalReport.status, next_unmet_conditions: goalReport.nextUnmetConditions || []
    }
  });
  if (!evt?.id) return null; // no pointer → refuse to write the report (§13.2)
  return recordGoalReport({
    client, firmId, clientId, caseId, eventId: evt.id, goalReport,
    goalSpecHash: spec?.goalSpecHash || null, source: 'evaluation'
  });
};

// Resolve the open `missing_client_answer` batch blocker on one fully-answered
// coding case (anchored on its client_ask_batch). Returns the count resolved; a
// batch with no open answer blocker (already closed, or a duplicate reply) is a
// clean no-op. Mirrors loopsShadowProducers.resolveReconciliationGapCaseOnMatch's
// per-target resolve. The object_type filter keeps this to the BATCH blocker — a
// coding case carries exactly one missing_client_answer blocker, anchored on the
// client_ask_batch (openAskBatchCase) — never an evidence-style per-question one.
const resolveCodingBatchBlocker = async ({ client, codingCaseId, triggerEventId }) => {
  const open = await client.query(
    `select id from bookkeeping_case_blockers
      where case_id = $1 and status = 'open'
        and blocker_type = 'missing_client_answer'
        and coalesce(object_type, '') in ('', 'client_ask_batch')
      order by created_at asc, id asc`,
    [codingCaseId]
  );
  let resolved = 0;
  let status = null;
  for (const b of open.rows) {
    const r = await resolveBlocker({
      client, blockerId: b.id,
      resolutionEventId: triggerEventId || null,
      reason: 'Every client question this batch was waiting on has been answered.'
    });
    if (r.resolved) { resolved += 1; status = r.status; }
  }
  return { resolved, status };
};

// The CLOSE producer. Given the evidence case a client reply just answered, walk
// the typed graph to the coding case(s) it unblocks (§6.2 'blocks' children) and,
// for each whose every blocking question is now answered, resolve its batch blocker
// and persist the met GoalReport — verdict and blocker ladder move together.
//
// Reads the graph at activeOnly:false (the structural blockers, regardless of which
// edges were marked resolved) so it agrees with the read-only wake evaluator. A
// reply that does not complete any batch (other questions still outstanding) leaves
// every coding case standing — exactly evaluateCodingGoal's `noop` verdict. Returns
// { closedCases, resolvedBlockers } for the caller's accounting; never throws on a
// soft DB miss (the caller's drain txn still owns rollback on a hard error).
export const closeAnsweredCodingCases = async ({
  client, firmId, clientId, evidenceCaseId, triggerEventId = null
} = {}) => {
  const result = { closedCases: 0, resolvedBlockers: 0 };
  if (!client || !firmId || !clientId || !evidenceCaseId) return result;

  const deps = await readCaseDependencies({ client, firmId, clientId });
  // The coding cases this evidence case BLOCKS (it is the parent of a 'blocks'
  // edge). activeOnly:false: the structural unblock targets, matching the wake.
  const codingCaseIds = unblocks(deps, evidenceCaseId, { activeOnly: false });
  for (const codingCaseId of codingCaseIds) {
    // Re-project the coding goal off the SAME persisted state the wake reads.
    const blockingCaseIds = blockedBy(deps, codingCaseId, { activeOnly: false });
    const totalBlocking = blockingCaseIds.length;
    if (totalBlocking === 0) continue; // nothing tracked → nothing to close
    const answered = await countAnsweredEvidenceCases(client, blockingCaseIds);
    const { goalReport, action } = evaluateCodingGoal({ totalBlocking, answered });
    if (action !== 'resolve_coding_case') continue; // still waiting on a client answer

    const { resolved } = await resolveCodingBatchBlocker({ client, codingCaseId, triggerEventId });
    // Persist the met verdict alongside the resolution (the reconciliation close
    // pattern). Even if the blocker was already resolved (duplicate reply), record
    // the met report so the verdict is on the books and consistent with the ladder.
    await recordCodingGoalReport({ client, firmId, clientId, caseId: codingCaseId, goalReport, triggerEventId });
    if (resolved > 0) { result.closedCases += 1; result.resolvedBlockers += resolved; }
  }
  return result;
};
