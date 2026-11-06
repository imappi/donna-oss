// Donna Loops — the reconciliation `evaluate` adapter for the LoopRun engine
// (design §6.3 / §10 Step 5; the §13.8 "goal-report-only" bounded action).
//
// This is the case-type-specific half of a wake: it READS a reconciliation
// case's PERSISTED state and projects it through the ONE declarative evaluator
// (loopGoalRegistry.evaluateReconciliationGoal), handing the engine an
// already-decided GoalReport to persist. It is the re-evaluation complement of
// loopsShadowProducers' open/close producers:
//
//   - It never re-matches and never calls a model — the verdict was decided
//     upstream (reconciliationLlmCore, persisted in reconciliation_evaluations)
//     and a live sticky match outranks it (INV-4). This only RENDERS the
//     persisted verdict (CLAUDE.md "render the persisted verdict" rail).
//   - It is READ-ONLY: it opens no case and resolves no blocker (those are the
//     producers' job — Step 3). Its single bounded action is "goal-report-only"
//     (§13.8): re-evaluate the goal and let the engine receipt it. So waking an
//     existing case can never collide with or double-fire the producers.
//
// All state comes from PERSISTED workflow columns (verdict / match status /
// payment_status), never the document's content — the same boundary the
// producers hold. Every query soft-fails to empty so a wake degrades to an
// indeterminate no-op rather than aborting the drain.

import {
  evaluateReconciliationGoal, reconciliationFreshEvaluationRequested, RECONCILIATION_GAP_GOAL
} from './loopGoalRegistry.js';
import { computeProgressFingerprint } from './loopGoal.js';

// The trigger types that mean "new information just landed upstream" — a client
// answer cleared a blocking question (the §6.2 coding→reconciliation cascade). On
// such a wake, a line still on a stale `no_match` verdict deserves a FRESH
// strong-model re-match, not a re-projection of the old verdict (Trap-2). Kept to
// the cascade only (NOT a sweep / parse / a manual resume) so a normal wake never
// requests — those either ARE a fresh evaluation or would loop.
const UPSTREAM_RESOLUTION_TRIGGERS = new Set(['dependency.resolved']);

const firstRow = async (client, sql, params) => {
  const res = await client.query(sql, params).catch(() => ({ rows: [] }));
  return res.rows?.[0] || null;
};

// The latest persisted verdict for the case's target (rail #1 — never re-match).
// SHADOW-mode disposition rows are excluded: a verdict stamped with
// payload.matcher_mode 'shadow' (the doc-first drain's observe stage) is
// observational only — letting it become the "latest verdict" a wake projects
// would be a shadow row driving live case state. Non-disposition families never
// stamp matcher_mode in payload, so this is a no-op for them.
const readLatestVerdict = (client, { firmId, clientId, targetType, targetId }) =>
  firstRow(client,
    `select verdict, unmatchable_reason, model
       from reconciliation_evaluations
      where firm_id = $1 and client_id = $2 and target_type = $3 and target_id = $4
        and payload->>'matcher_mode' is distinct from 'shadow'
      order by evaluated_at desc
      limit 1`,
    [firmId, clientId, targetType, targetId]);

// INV-4: a confirmed/auto_matched match SETTLES the target regardless of any
// verdict. (A rejected match does NOT settle — it is a human "no", not a
// resolution — so it is excluded here.) Mirrors the producers' sticky-match
// subquery, scoped to the one target.
//
// DMEM-R1 W1 (INV-11, audit F-08, S02/L1): a settled match that a MATERIAL
// correction invalidated (`payload.invalidated_by_correction`, written by
// loopsShadowProducers.onDocumentCorrected) is NOT sticky — it cannot settle the
// goal again until a fresh evaluation ran. It is reported separately
// (`hasInvalidatedMatch`) so the wake requests that fresh evaluation instead of
// re-projecting the stale verdict.
const readMatchState = async (client, { firmId, clientId, targetType, targetId }) => {
  const matchPredicate =
    `( ($3 = 'transaction' and bank_transaction_id = $4)
       or ($3 <> 'transaction' and matched_object_type = $3 and matched_object_id = $4) )`;
  const notInvalidated = `coalesce(payload->'invalidated_by_correction', 'null'::jsonb) = 'null'::jsonb`;
  const sticky = await firstRow(client,
    `select 1 from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and status in ('confirmed', 'auto_matched')
        and ${notInvalidated}
        and ${matchPredicate}
      limit 1`,
    [firmId, clientId, targetType, targetId]);
  const invalidated = await firstRow(client,
    `select 1 from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and status in ('confirmed', 'auto_matched')
        and not (${notInvalidated})
        and ${matchPredicate}
      limit 1`,
    [firmId, clientId, targetType, targetId]);
  const any = await firstRow(client,
    `select 1 from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and ${matchPredicate}
      limit 1`,
    [firmId, clientId, targetType, targetId]);
  return { hasStickyMatch: Boolean(sticky), hasAnyMatch: Boolean(any), hasInvalidatedMatch: Boolean(invalidated) };
};

// Open blockers feed the progress fingerprint: if a re-evaluation moves the
// open-blocker set, the goal status, or the owner, the wake made progress; if it
// produces the byte-identical fingerprint again, INV-15's no-progress guard
// escalates. The owner is a property of the open blocker (the case has no owner
// column), so it is read here, not from the case row.
const readOpenBlockers = async (client, caseId) => {
  const res = await client.query(
    `select blocker_type, owner_type from bookkeeping_case_blockers
      where case_id = $1 and status = 'open'
      order by created_at asc, id asc`,
    [caseId]
  ).catch(() => ({ rows: [] }));
  const rows = res.rows || [];
  return { types: rows.map((r) => r.blocker_type), ownerType: rows[0]?.owner_type ?? null };
};

// The injected engine evaluator for the reconciliation loop. Reads the case's
// persisted state, projects via the single evaluator, and returns the
// engine-shaped outcome (goalReport + spec + the progress fingerprint + the
// receipt's model id). Zero model calls — workflow-only, INV-15 bounded.
export const evaluateReconciliationWake = async ({
  client, firmId, clientId, caseId, caseRow = null, triggerEventTypes = []
} = {}) => {
  const targetType = caseRow?.primary_object_type || null;
  const targetId = caseRow?.primary_object_id || null;
  const baseUsage = { modelCalls: 0, toolCalls: 1, elapsedMs: 0 };
  const isUpstreamResolutionWake = (triggerEventTypes || []).some((t) => UPSTREAM_RESOLUTION_TRIGGERS.has(t));

  // No target anchor → nothing to project. Still produce an (indeterminate)
  // report so the wake is bounded and receipted, never a silent no-op.
  if (!client || !targetType || !targetId) {
    const { goalReport, action } = evaluateReconciliationGoal({});
    return {
      goalReport, spec: RECONCILIATION_GAP_GOAL, action,
      progressFingerprint: computeProgressFingerprint({
        goalStatus: goalReport.status, criteria: goalReport.criteria
      }),
      usage: baseUsage, evaluatorVersion: null
    };
  }

  const verdict = await readLatestVerdict(client, { firmId, clientId, targetType, targetId });
  const { hasStickyMatch, hasAnyMatch, hasInvalidatedMatch } =
    await readMatchState(client, { firmId, clientId, targetType, targetId });

  // W1 (INV-11 / doctrine §2.6 step 8): the settling match was invalidated by a
  // material correction and nothing else settles the target — the goal cannot
  // be terminal on the stale match, and re-projecting the old verdict would
  // just re-settle it. Request the fresh evaluation and stop waiting (the same
  // durable request the dependency-resolved wake uses).
  if (hasInvalidatedMatch && !hasStickyMatch) {
    const { goalReport, action } = reconciliationFreshEvaluationRequested();
    const openBlockers = await readOpenBlockers(client, caseId);
    return {
      goalReport,
      spec: RECONCILIATION_GAP_GOAL,
      action,
      requestFreshEvaluation: { reason: 'material_correction_invalidated_settled_match' },
      progressFingerprint: computeProgressFingerprint({
        goalStatus: goalReport.status, criteria: goalReport.criteria,
        ownerType: openBlockers.ownerType, openBlockerTypes: openBlockers.types
      }),
      usage: baseUsage,
      evaluatorVersion: verdict?.model ?? null
    };
  }

  // PR 1 (Trap-2) — an upstream coding case just resolved (a client answer cleared a
  // blocking question on this line), but the line is still on a stale `no_match`
  // verdict with no settling match. Re-projecting that verdict would re-open the SAME
  // gap (read-only, correct — but useless: nothing changed). Instead ask for a FRESH
  // strong-model re-match and stop WAITING: the engine emits the durable
  // reconciliation.evaluation_requested outbox row (INV-8), a separate consumer runs
  // the matcher UPSTREAM and persists a new verdict, and reconciliation.evaluation_
  // completed re-wakes this case to read it. `no_match` ONLY — `no_candidates` means
  // the covering statement isn't uploaded yet (an answer can't fix that), and a sticky
  // match already settles the line. The request itself is idempotent at the engine
  // (one wake per case + trigger event).
  if (isUpstreamResolutionWake && verdict?.verdict === 'no_match' && !hasStickyMatch) {
    const { goalReport, action } = reconciliationFreshEvaluationRequested();
    const openBlockers = await readOpenBlockers(client, caseId);
    return {
      goalReport,
      spec: RECONCILIATION_GAP_GOAL,
      action,
      requestFreshEvaluation: { reason: 'dependency_resolved_requires_fresh_reconciliation_judgment' },
      progressFingerprint: computeProgressFingerprint({
        goalStatus: goalReport.status, criteria: goalReport.criteria,
        ownerType: openBlockers.ownerType, openBlockerTypes: openBlockers.types
      }),
      usage: baseUsage,
      evaluatorVersion: verdict?.model ?? null
    };
  }

  let paymentStatus = null;
  if (targetType === 'document') {
    const doc = await firstRow(client,
      `select payment_status from documents where id = $1 limit 1`, [targetId]);
    paymentStatus = doc?.payment_status ?? null;
  }

  const { goalReport, action, desiredCase } = evaluateReconciliationGoal({
    verdict: verdict?.verdict ?? null,
    unmatchableReason: verdict?.unmatchable_reason ?? null,
    hasStickyMatch,
    paymentStatus,
    hasAnyMatch,
    hasEvaluation: verdict?.verdict != null
  });

  const openBlockers = await readOpenBlockers(client, caseId);
  const progressFingerprint = computeProgressFingerprint({
    goalStatus: goalReport.status,
    criteria: goalReport.criteria,
    ownerType: desiredCase?.ownerType ?? openBlockers.ownerType,
    openBlockerTypes: openBlockers.types
  });

  return {
    goalReport,
    spec: RECONCILIATION_GAP_GOAL,
    action,
    progressFingerprint,
    usage: baseUsage,
    // the model id IS the receipt: the run carries the upstream verdict's model.
    evaluatorVersion: verdict?.model ?? null
  };
};
