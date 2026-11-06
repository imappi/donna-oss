// Donna Loops — the LoopRun engine: one bounded, budgeted, single-flight wake
// (goal-first uplift, design §5/§6.3/§10 Step 5; INV-15/16; §13.2/§13.4).
//
// This is the orchestrator the pure leaves were built FOR. loopRun.js owns the
// run-side controls (coalescing, budget, single-flight CAS gate, summarizeRun),
// loopGoal.js owns the goal-side primitives (the report, the idempotency keys,
// the progress fingerprint), and loopGoalStore.js owns the append-only
// persistence. This module wires them into the contract a wake must honour:
//
//   read snapshot → take/propose ONE bounded action → re-evaluate the goal →
//   persist a LoopRun + GoalReport → stop.                          (design §5)
//
// CLAUDE.md "Keep"-layer discipline, top to bottom: the engine NEVER calls an
// LLM and never decides a verdict. The judgment runs UPSTREAM (the strong model
// in reconciliationLlmCore / bankLineDispositionLlm) and is handed to the
// injected `evaluate` as already-decided state; the engine only bounds,
// de-duplicates, single-flights, and PERSISTS the wake around it. `evaluate` is
// injected (not imported) so the engine stays case-type-agnostic and fully
// unit-testable with a mock client — the reconciliation adapter lives in
// reconciliationWakeEvaluator.js, the next case type in its own file.
//
// The four invariants this enforces:
//   INV-15  every bounded run has an execution budget + a persisted stop reason;
//           repeated no-progress against identical snapshots stops + escalates.
//   INV-16  only one run may reason over a given case version at a time
//           (optimistic case_version CAS — a stale run commits nothing).
//   §13.4   a redelivered event never duplicates a receipt (the deterministic
//           run key is the row id; an idempotency pre-check skips a re-run).
//   §13.2   every GoalReport write appends its mandatory `goal_evaluated`
//           bookkeeping_case_events pointer FIRST and passes its id.
//
// Inert until a deliberate turn-on: presence-guarded on the 037 goal tables, so
// a pre-037 deploy (prod today) degrades to a clean no-op. The caller
// (loopInboxWorker) holds the LOOPS_SHADOW gate; the engine never reads it.
//
// Imports only Keep-layer leaves (loopGoal/loopRun/loopGoalStore) + caseManager's
// appendCaseEvent — the same import surface loopsShadowProducers already uses, so
// it widens no cycle.

import { appendCaseEvent } from './caseManager.js';
import {
  loopGoalTablesPresent, recordLoopRun, recordGoalReport, persistGoalSpec
} from './loopGoalStore.js';
import { buildLoopRunKey } from './loopGoal.js';
import {
  coalesceTriggerEvents, summarizeRun, normalizeExecutionPolicy
} from './loopRun.js';
import { enqueueOutbox } from './loopEventOutbox.js';

// Read the wake's case once: the single-flight basis (case_version) + the target
// anchors the injected evaluator projects from. Soft-fails to null so a missing
// relation degrades to a skip rather than aborting the surrounding drain txn.
const readCaseRow = async ({ client, firmId, caseId }) => {
  const res = await client.query(
    `select id, firm_id, client_id, case_version, status,
            primary_object_type, primary_object_id
       from bookkeeping_cases
      where firm_id = $1 and id = $2
      limit 1`,
    [firmId, caseId]
  ).catch(() => ({ rows: [] }));
  return res.rows[0] || null;
};

// Prior-run state for the no-progress contract (INV-15): the previous wake's
// AFTER fingerprint (this wake's BEFORE) and the streak of consecutive
// no_progress runs immediately preceding. Rows are newest-first; the streak is
// the run of leading no_progress stop reasons.
const readPriorRunState = async ({ client, firmId, caseId }) => {
  const res = await client.query(
    `select progress_fingerprint_after, stop_reason
       from loop_runs
      where firm_id = $1 and case_id = $2
      order by created_at desc
      limit 25`,
    [firmId, caseId]
  ).catch(() => ({ rows: [] }));
  const rows = res.rows || [];
  let consecutiveNoProgressRuns = 0;
  for (const r of rows) {
    if (r.stop_reason === 'no_progress') consecutiveNoProgressRuns += 1;
    else break;
  }
  return {
    progressFingerprintBefore: rows[0]?.progress_fingerprint_after ?? null,
    consecutiveNoProgressRuns
  };
};

// Run ONE bounded wake of `caseId` for the (coalesced) trigger events.
//
//   loopDefinition  { executionPolicy } — the per-wake budget (§6.1).
//   triggerEvents   the inbox events that woke this case; coalesced to ONE
//                   representative (the deterministic run key, §13.4). [] / a
//                   single id are both fine (a manual/sweep wake has no event).
//   evaluate        async ({ client, firmId, clientId, caseId, caseRow,
//                            representativeEventId, eventIds,
//                            progressFingerprintBefore, policy }) =>
//                     { goalReport, spec, action, progressFingerprint, usage,
//                       authorityRequired, failed, evaluatorVersion, estimatedCost }
//                   The injected, case-type-specific "read + project" step. It
//                   returns an ALREADY-DECIDED verdict; the engine persists it.
//
// Returns a structured wake summary (never throws on a per-wake failure — a
// thrown evaluator is folded into a 'failed' stop reason and still receipted).
export const runLoopWake = async ({
  client, firmId, clientId, caseId,
  loopDefinition, triggerEvents = [], evaluate
} = {}) => {
  if (!client || !firmId || !clientId || !caseId || !loopDefinition || typeof evaluate !== 'function') {
    return { skipped: true, reason: 'invalid_input' };
  }
  // Inert pre-037: never touch a case if the goal tables aren't there yet.
  if (!(await loopGoalTablesPresent(client))) return { skipped: true, reason: 'goal_tables_absent' };

  const policy = normalizeExecutionPolicy(loopDefinition.executionPolicy);

  // Coalesce the batch to ONE representative event (§6.3): an upload of 30
  // parse_completed events evaluates once. The representative is deterministic
  // (earliest by sequence/createdAt/id) so a re-delivered batch keys the SAME run.
  const coalesced = coalesceTriggerEvents(triggerEvents);
  const triggerEventId = coalesced.representativeEventId; // null for a manual/sweep wake
  // The set of trigger TYPES in this (coalesced) batch — passed to the evaluator so a
  // case-type wake can react to WHY it woke (e.g. the reconciliation wake requests a
  // fresh re-match only on the §6.2 cascade, not on a sweep). Empty for a wake whose
  // caller passes no event type (a manual/sweep wake) — the evaluator defaults safely.
  const triggerEventTypes = [...new Set((triggerEvents || []).map((e) => e?.type).filter(Boolean))];

  const caseRow = await readCaseRow({ client, firmId, caseId });
  if (!caseRow) return { skipped: true, reason: 'case_absent' };
  const leaseCaseVersion = Number(caseRow.case_version) || 1;

  // §13.4 idempotency: an event-caused run is unique on (case, trigger event).
  // If the deterministic run id is already present, the event was already
  // processed — skip BEFORE doing any work or appending a duplicate pointer.
  const runId = triggerEventId ? buildLoopRunKey({ caseId, triggerEventId }) : null;
  if (runId) {
    const existing = await client.query(
      `select id from loop_runs where id = $1 limit 1`, [runId]
    ).catch(() => ({ rows: [] }));
    if (existing.rows[0]) return { skipped: true, reason: 'already_run', runId };
  }

  const { progressFingerprintBefore, consecutiveNoProgressRuns } =
    await readPriorRunState({ client, firmId, caseId });

  // The one bounded action (injected). A thrown evaluator must not crash the
  // drain — fold it into a 'failed' run so the stall is receipted, not silent.
  let outcome;
  try {
    outcome = (await evaluate({
      client, firmId, clientId, caseId, caseRow,
      representativeEventId: triggerEventId, eventIds: coalesced.eventIds,
      triggerEventTypes, progressFingerprintBefore, policy
    })) || {};
  } catch (error) {
    try { console.warn(`[loop-engine] evaluate failed for ${caseId}: ${error?.message || error}`); } catch { /* never throw from logger */ }
    outcome = { failed: true };
  }
  const {
    goalReport = null, spec = null, action = 'noop',
    progressFingerprint: progressFingerprintAfter = null,
    usage = {}, authorityRequired = false, failed = false,
    evaluatorVersion = null, estimatedCost = null
  } = outcome;

  // Single-flight commit gate (INV-16): optimistic case_version CAS. If another
  // wake advanced the version since we read it, this run is stale — it commits
  // NO competing verdict; it stops 'superseded' and the next event re-evaluates.
  const cas = await client.query(
    `update bookkeeping_cases
        set case_version = case_version + 1, updated_at = now()
      where firm_id = $1 and id = $2 and case_version = $3`,
    [firmId, caseId, leaseCaseVersion]
  ).catch(() => ({ rowCount: 0 }));
  const committed = (cas.rowCount || 0) > 0;

  // Fold budget exhaustion (INV-15), no-progress escalation (INV-15), and the
  // commit gate (INV-16) into the one persisted stop reason.
  const summary = summarizeRun({
    goalReport, policy, usage,
    progressBefore: progressFingerprintBefore, progressAfter: progressFingerprintAfter,
    consecutiveNoProgressRuns, authorityRequired, failed, canCommit: committed
  });
  const { stopReason } = summary;

  // The LoopRun receipt — written every wake (INV-15: a persisted stop reason
  // even for a superseded/failed run). Idempotent on the §13.4 run key.
  const run = await recordLoopRun({
    client, firmId, clientId, caseId, triggerEventId,
    inputSnapshotId: goalReport?.evaluatedFromSnapshotId || null,
    outputSnapshotId: goalReport?.evaluatedFromSnapshotId || null,
    modelCalls: Math.max(0, Number(usage.modelCalls) || 0),
    toolCalls: Math.max(0, Number(usage.toolCalls) || 0),
    estimatedCost: estimatedCost ?? null,
    elapsedMs: Number.isFinite(Number(usage.elapsedMs)) ? Number(usage.elapsedMs) : null,
    progressFingerprintBefore, progressFingerprintAfter,
    stopReason, evaluatorVersion, id: runId
  });

  // The GoalReport verdict — persisted ONLY when the run committed AND produced a
  // report. A superseded/failed run writes no verdict (its dirty re-eval will).
  // §13.2: append the mandatory goal_evaluated pointer FIRST; without it, refuse
  // to write the report (no orphan verdict, no orphan pointer).
  let report = null;
  if (committed && goalReport) {
    const specResult = spec ? await persistGoalSpec({ client, spec }) : null;
    const evt = await appendCaseEvent({
      client, firmId, clientId, caseId,
      eventType: 'goal_evaluated', triggerEventId, modelName: evaluatorVersion || null,
      payload: {
        goal_key: goalReport.goalKey, goal_version: goalReport.goalVersion,
        status: goalReport.status, stop_reason: stopReason, action,
        next_unmet_conditions: goalReport.nextUnmetConditions || []
      }
    });
    if (evt?.id) {
      report = await recordGoalReport({
        client, firmId, clientId, caseId, eventId: evt.id, goalReport,
        loopRunId: run?.id || null, goalSpecHash: specResult?.goalSpecHash || null,
        progressFingerprint: progressFingerprintAfter, source: 'evaluation'
      });
    }
  }

  // §6.2 cascade PRODUCER (INV-8). A committed, goal-MET wake is a case
  // RESOLUTION: emit the post-commit outbox row so the Step-7 dispatcher fans
  // re-evaluation out to this case's downstream dependents (a `case.resolved`
  // row → `dependency.resolved` per blocked child, in topological order). This
  // is a CLAUDE.md "Keep"-layer SIDE EFFECT, not a verdict — the row is enqueued
  // INSIDE this wake's transaction so it commits atomically with the GoalReport
  // (INV-8: a side effect emitted only if the local txn commits), and the
  // dispatcher is what decides whether/where it actually fires, under the gate
  // (shadow → HELD, byte-identical to no producer). The engine/judge boundary
  // holds: enqueuing the row makes no judgment; the superseding evaluation a
  // re-woken downstream case runs is the engine's own bounded job. Guarded on a
  // persisted `report`: only a resolution actually on the books cascades (a
  // pointer-append failure that skipped the report write enqueues nothing).
  if (committed && report && stopReason === 'goal_met') {
    await enqueueOutbox({
      client, firmId, clientId,
      eventType: 'case.resolved',
      objectType: 'bookkeeping_case', objectId: caseId,
      payload: {
        case_id: caseId,
        goal_key: goalReport?.goalKey || null,
        run_id: run?.id || null,
        // Collapse a re-resolution of the same case within one dispatch batch
        // (the deeper at-least-once idempotency is the dispatcher's deterministic
        // per-child inbox key, `${outboxId}:${childCaseId}`).
        idempotencyKey: `case_resolved:${run?.id || caseId}`
      }
    });
  }

  // PR 1 — the FRESH-EVALUATION REQUEST (INV-8 durable intent; the Trap-2 close).
  // When the (case-type) evaluator decided the persisted verdict is STALE — an
  // upstream answer just landed but the target is still an unsettled gap — it flags
  // `requestFreshEvaluation`. Emit the durable outbox row INSIDE this wake's txn so
  // it commits atomically with the receipt; a separate consumer (OUTSIDE any txn)
  // runs the strong-model re-match, persists a new verdict, and emits the completed
  // event that re-wakes this case to read it. The engine does NOT call the model —
  // the engine/judge boundary holds. Gated on a committed receipt (a superseded run
  // requests nothing); idempotent via the engine's per-(case, trigger) run key, so a
  // redelivered trigger never re-requests. This is the ONE case-type-named side
  // effect the engine emits (alongside the generic case.resolved cascade), kept as a
  // literal so the loopEventRegistry source-scan can attribute the producer. Held at
  // shadow (the consumer doesn't run); the consumer honors firm/case suspension.
  if (committed && report && outcome.requestFreshEvaluation && caseRow?.primary_object_id) {
    const req = outcome.requestFreshEvaluation;
    await enqueueOutbox({
      client, firmId, clientId,
      eventType: 'reconciliation.evaluation_requested',
      objectType: caseRow.primary_object_type, objectId: caseRow.primary_object_id,
      payload: {
        case_id: caseId,
        case_version: leaseCaseVersion,
        target_type: caseRow.primary_object_type,
        target_id: caseRow.primary_object_id,
        trigger_event_id: triggerEventId,
        run_id: run?.id || null,
        reason: req.reason || 'fresh_reconciliation_judgment_requested',
        idempotencyKey: `recon_eval_requested:${caseId}:${leaseCaseVersion}:${triggerEventId || run?.id || caseId}`
      }
    });
  }

  return {
    skipped: false,
    committed,
    stopReason,
    action,
    runId: run?.id || null,
    reportId: report?.id || null,
    goalStatus: goalReport?.status || null,
    coalescedCount: coalesced.count,
    coalesced: coalesced.coalesced,
    noProgress: summary.noProgress,
    budget: summary.budget
  };
};
