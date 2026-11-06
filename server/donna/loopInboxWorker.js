// Donna Loops — Phase 3: the inbox drainer (the consumer Phase 1 deferred).
//
// Phase 1 built the at-least-once inbox (idempotent insert + claim/reclaim
// machinery) but wired NO consumer — events sat 'pending' forever. This is the
// consumer: claim pending events with claimPendingEvent (FOR UPDATE SKIP LOCKED),
// route each to its processor, mark processed / ignored / failed. Each event runs
// in its own mini-transaction so one poisoned event can't roll back its siblings,
// and stale in-flight rows are reclaimed first (worker-death recovery).
//
// Gated by the one graduation model (design §10 Step 6, loopExecutionGate): the
// drain consults the system master switch (isLoopSystemEnabled — LOOPS_SHADOW off
// still skips it entirely, default OFF), and each goal-first wake is gated PER FIRM
// (tier + suspension from firms.metadata) by decideLoopExecution before it runs.
// No LLM, no external calls, no accounting writes: the processors move WORKFLOW
// state and enqueue NON-dispatched outbox rows only (contract §7 / INV-8).

import { loopsTablesPresent, buildCaseId } from './caseManager.js';
import {
  claimPendingEvent, markProcessed, markIgnored, markFailed, reclaimStaleProcessingEvents
} from './loopEventInbox.js';
import { resumeFromClientReply } from './evidenceReplyResume.js';
import { loopDefinitionsForTrigger, resolveLoopDefinitionForTrigger } from './loopGoalRegistry.js';
import { runLoopWake } from './loopRunEngine.js';
import { evaluateReconciliationWake } from './reconciliationWakeEvaluator.js';
import { evaluateCodingWake } from './codingWakeEvaluator.js';
import {
  isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext
} from './loopExecutionGate.js';
import { readActiveCaseSuspension } from './caseSuspension.js';

const DEFAULT_LIMIT = 25;

// The injected wake evaluator per LoopDefinition (design §10 Step 5). The engine
// is case-type-agnostic; this is the only place the inbox worker knows WHICH
// "read + project" closure a given loop uses. A new loop adds a row here alongside
// its definition + evaluator file.
const WAKE_EVALUATORS = {
  reconciliation_gap_resolution: evaluateReconciliationWake,
  coding_ask_batch_resolution: evaluateCodingWake
};

// The case the wake should re-evaluate, for an event that carries an explicit
// case_id (the §6.2 cascade always sets one). Used to disambiguate a shared cascade
// event (dependency.resolved, subscribed by every case-type loop) by the woken
// case's type, so a coding case routes to the coding evaluator, not reconciliation.
const readCaseType = async ({ client, firmId, caseId }) => {
  if (!caseId) return null;
  const res = await client.query(
    `select case_type from bookkeeping_cases where firm_id = $1 and id = $2 limit 1`,
    [firmId, caseId]
  ).catch(() => ({ rows: [] }));
  return res.rows[0]?.case_type || null;
};

// Drain → wake (design §10 Step 5). An inbox event whose type a LoopDefinition
// subscribes to is dispatched to the LoopRun engine: it re-evaluates the case's
// goal and persists a bounded LoopRun + GoalReport. The case to wake is the
// event's explicit payload.case_id, else the reconciliation case anchored on the
// event's object. The engine RE-EVALUATES an existing case only (it opens none),
// so this can never collide with loopsShadowProducers' case-opening producers; a
// no-case event resolves to a clean 'case_absent' skip → IGNORED, never failed.
const dispatchLoopWake = async ({ client, event }) => {
  const firmId = event.firm_id;
  const clientId = event.client_id;
  const payload = event.payload || {};

  // Resolve the loop. A single-subscriber event routes directly; a SHARED cascade
  // event (dependency.resolved, subscribed by every case-type loop) is disambiguated
  // by the woken case's type. The cascade always carries an explicit payload.case_id,
  // so we read that case's case_type to pick the right loop (§6.2 cascade routing).
  const matches = loopDefinitionsForTrigger(event.event_type);
  if (matches.length === 0) return { handled: false, ignoredReason: 'unhandled_event_type' };
  let def = matches[0];
  if (matches.length > 1) {
    if (!payload.case_id) return { handled: false, ignoredReason: 'ambiguous_trigger_no_case' };
    const caseType = await readCaseType({ client, firmId, caseId: payload.case_id });
    def = resolveLoopDefinitionForTrigger(event.event_type, { caseType });
    if (!def) return { handled: false, ignoredReason: 'no_loop_for_case_type' };
  }
  const evaluate = WAKE_EVALUATORS[def.key];
  if (!evaluate) return { handled: false, ignoredReason: 'no_wake_evaluator' };

  const caseId = payload.case_id || buildCaseId({
    firmId, clientId, caseType: def.caseType,
    primaryObjectType: event.object_type, primaryObjectId: event.object_id
  });
  if (!firmId || !clientId || !caseId) return { handled: false, ignoredReason: 'no_case_anchor' };

  // Step 6 graduation gate (design §10): resolve this firm's tier + any firm/case
  // suspension and decide via the one execution policy. The drain master switch
  // already passed (isLoopSystemEnabled); this is the PER-FIRM/PER-CASE decision the
  // bare LOOPS_SHADOW boolean could not make — a suspended/opted-out firm OR a paused/
  // cancelled CASE has its trigger consumed (IGNORED with the typed reason:
  // firm_suspended / case_suspended / tier_off / ...), and re-evaluation resumes on
  // the next trigger/sweep once the gate reopens (a `resume` lift). caseSuspension is
  // now sourced from bookkeeping_case_suspensions (038) — the forward-compatible hook
  // Step 6 left; null pre-038, so back-compat is exact.
  const { firmMetadata } = await readFirmExecutionContext(client, firmId);
  const caseSuspension = await readActiveCaseSuspension({ client, firmId, clientId, caseId });
  const gate = decideLoopExecution({
    loopKey: def.key, firmMetadata, caseSuspension,
    requestedAction: def.wakeAction || 'goal_report_only'
  });
  if (!gate.allowed) return { handled: false, ignoredReason: gate.blockedReason };
  if (gate.actionAllowed === false) return { handled: false, ignoredReason: gate.actionBlockedReason };

  const result = await runLoopWake({
    client, firmId, clientId, caseId,
    loopDefinition: def,
    // Carry the event TYPE so the evaluator can react to WHY it woke (the §6.2
    // cascade requests a fresh re-match; a sweep/parse does not).
    triggerEvents: [{ id: event.id, type: event.event_type, createdAt: event.first_seen_at || null }],
    evaluate
  });
  if (result.skipped) return { handled: false, ignoredReason: result.reason || 'wake_skipped' };
  return { handled: true };
};

// Route one claimed event to its processor. Unknown types are IGNORED (not
// failed) — an event the current phase doesn't handle is not an error.
const processInboxEvent = async ({ client, event }) => {
  switch (event.event_type) {
    case 'client_reply.received': {
      const out = await resumeFromClientReply({ client, event });
      if (!out.resumed) return { handled: false, ignoredReason: out.reason || 'not_resumed' };
      return { handled: true };
    }
    default:
      // A loop-trigger event (reconciliation.*, document.parse_completed,
      // manual.resume, schedule.recon_sweep) wakes the engine; everything else
      // stays IGNORED.
      return dispatchLoopWake({ client, event });
  }
};

// Drain up to `limit` pending inbox events. Returns a summary. No-throw per
// event: a failure marks the row failed and the drain continues.
export const drainLoopInbox = async ({
  client, workerId = 'loops-cron', limit = DEFAULT_LIMIT, processingTtlMs
} = {}) => {
  if (!isLoopSystemEnabled()) return { skipped: true, reason: 'loops_shadow_off' };
  if (!client) return { skipped: true, reason: 'no_client' };
  if (!(await loopsTablesPresent(client))) return { skipped: true, reason: 'tables_absent' };

  const reclaimed = await reclaimStaleProcessingEvents({ client });
  const bounded = Math.min(Math.max(Number(limit) || DEFAULT_LIMIT, 1), 200);
  let claimed = 0, processed = 0, ignored = 0, failed = 0;

  for (let i = 0; i < bounded; i += 1) {
    // claimPendingEvent autocommits the status->processing flip (no surrounding
    // BEGIN), so the row is locked/marked even if processing later rolls back.
    const event = await claimPendingEvent({ client, workerId, processingTtlMs });
    if (!event) break;
    claimed += 1;
    let began = false;
    try {
      await client.query('begin');
      began = true;
      const outcome = await processInboxEvent({ client, event });
      // Mark inside the same txn as the work, so the status flip is atomic with it.
      if (outcome.handled) await markProcessed({ client, eventId: event.id });
      else await markIgnored({ client, eventId: event.id, reason: outcome.ignoredReason });
      await client.query('commit');
      if (outcome.handled) processed += 1; else ignored += 1;
    } catch (error) {
      if (began) { try { await client.query('rollback'); } catch { /* best-effort */ } }
      try { await markFailed({ client, eventId: event.id, error }); } catch { /* best-effort */ }
      failed += 1;
      try { console.warn(`[loops-drain] event ${event.id} failed: ${error?.message || error}`); } catch { /* never throw from logger */ }
    }
  }

  return { skipped: false, reclaimed, claimed, processed, ignored, failed };
};
