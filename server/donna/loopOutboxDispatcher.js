// Donna Loops — the real outbox DISPATCHER (goal-first uplift, design §10 Step 7).
//
// GREENFIELD. Migration 033 shipped loop_event_outbox but NO dispatcher — "Phase 1
// NEVER marks a row 'dispatched'… No dispatcher ships here" (033:183-184) — so rows
// sit 'pending' forever. This is that dispatcher: it drains the outbox under the
// gate and finally marks rows 'dispatched'.
//
// It consumes the three PURE brains already on main and adds NO new intelligence:
//   - loopOutboxPlanner.planOutboxDispatch  — the deterministic plan (FIFO order,
//     backoff, idempotency dedup, dead-letter, per-target serialization, the
//     concurrency cap). The dispatcher only executes the plan.
//   - caseDependency.cascadeOrder           — a resolved case fans re-evaluation
//     out to its downstream dependents in topological order (§6.2).
//   - loopGoalRegression.decideRegression   — "met once" is not "met forever"
//     (§13.10): a regression event reopens the case (or is ignored).
//
// DISPATCH-TIME RE-GATE. Every ready row is re-gated through the SAME pair the wake
// path uses — readActiveCaseSuspension + decideLoopExecution — so a case paused or
// a firm suspended AFTER the row was enqueued still stops the side effect. The
// suspension's mode/terminal split is load-bearing here:
//   - terminal DROP  (a CANCELLED case)  -> the row is dropped ('cancelled'),
//                                            never retried (the work is dead).
//   - resumable HOLD (paused / tier off) -> the row is left 'pending', re-attempted
//                                            on the next trigger once the gate reopens.
//
// AT-LEAST-ONCE + IDEMPOTENT (INV-8/INV-11 + §13.4). A row is claimed by optimistic
// CAS (one dispatcher wins), the side effect runs in its own mini-transaction
// (enqueue + mark atomic), and every downstream INBOX event is keyed deterministically
// (source_event_id) so a redelivered outbox row re-enqueues the SAME key → the inbox
// dedupes (INV-6) → no duplicate downstream effect. INV-11 is trivially satisfied:
// the only side effect in V1 is enqueuing internal inbox events (a DB write) — there
// is NO external API call. external_sync.requested is deliberately NOT a handled
// type: dispatching it means a connector call (accounting mutation, V1-forbidden /
// INV-13). A future phase adds it behind a real connector, OUTSIDE the txn.
//
// CLAUDE.md "Keep"-layer mover: NO LLM, NO accounting writes — it moves persisted
// outbox rows into downstream workflow events under the gate. The engine/judge
// boundary (loopRunEngine.js:34) stays intact: the fresh evaluateGoal that mints a
// superseding report after a reopen happens inside the engine's bounded LoopRun on
// re-wake, never here.

import { planOutboxDispatch } from './loopOutboxPlanner.js';
import { cascadeOrder } from './caseDependency.js';
import { decideRegression } from './loopGoalRegression.js';
import { readActiveCaseSuspension } from './caseSuspension.js';
import {
  isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext
} from './loopExecutionGate.js';
import {
  readDispatchableOutbox, claimOutboxRow, markOutboxDispatched,
  dropOutboxRow, failOutboxRow
} from './loopEventOutbox.js';
import { insertLoopEvent } from './loopEventInbox.js';
import { loopsTablesPresent, reopenCase } from './caseManager.js';
import { readCaseDependencies, readLatestGoalReport } from './loopGoalStore.js';

// The §13.8 bounded action a dispatch performs: both handlers move loop-internal
// WORKFLOW state (re-wake a downstream case / reopen a regressed case). That action
// is permitted only at canary+ (resolveAutonomy), so the dispatcher is INERT at
// shadow — exactly today's behaviour (the outbox never dispatched), now NAMED. The
// careful-canary discipline: a firm dispatches its outbox only once graduated.
const DISPATCH_ACTION = 'workflow_mutation';

// The source tag for every downstream inbox event the dispatcher emits — so the
// (source, source_event_id) idempotency key is namespaced to the outbox dispatch.
const DISPATCH_SOURCE = 'loop_outbox';

// The case a row's side effect targets: producers set payload.case_id (the engine
// and the shadow producers both anchor their events on it). No case anchor → the
// case-scoped handlers no-op (a malformed/global row is dispatched, not retried).
const resolveCaseId = (row) => row?.payload?.case_id || row?.payload?.caseId || null;

const readCaseRow = async ({ client, firmId, caseId }) => {
  const res = await client.query(
    `select id, status, case_version, client_id from bookkeeping_cases
      where firm_id = $1 and id = $2 limit 1`,
    [firmId, caseId]
  ).catch(() => ({ rows: [] }));
  return res.rows[0] || null;
};

// ── handlers: outbox event_type -> downstream inbox events ───────────────────
// ONLY these types are dispatched. Any other type is left 'pending' (a future phase
// adds its handler) — we never mark a row we do not understand 'dispatched'.

// CASCADE (§6.2): "E blocks C blocks M — when E resolves, C re-evaluates; if C
// resolves, M re-evaluates." Reads the typed dependency graph and enqueues a
// `dependency.resolved` inbox event per downstream case, in topological order.
// Idempotent on (DISPATCH_SOURCE, `${outboxId}:${childCaseId}`): a redelivered
// outbox row re-enqueues the SAME keys → the inbox dedupes → no double-cascade.
const handleCascade = async ({ client, row, caseId, firmId, clientId }) => {
  if (!caseId) return { enqueued: 0, noop: 'no_case_anchor' };
  const deps = await readCaseDependencies({ client, firmId, clientId });
  const downstream = cascadeOrder(deps, caseId, { types: ['blocks'] });
  let enqueued = 0;
  for (const childCaseId of downstream) {
    const out = await insertLoopEvent({
      client, firmId, clientId,
      source: DISPATCH_SOURCE,
      sourceEventId: `${row.id}:${childCaseId}`,
      eventType: 'dependency.resolved',
      objectType: 'bookkeeping_case', objectId: childCaseId,
      payload: { case_id: childCaseId, resolved_case_id: caseId, via: 'cascade', outbox_id: row.id }
    });
    if (out?.inserted) enqueued += 1;
  }
  return { enqueued };
};

// REGRESSION / REOPEN (§13.10). The row's payload carries the regression event
// ({ id, kind, supersedesReportId? }). decideRegression (pure) decides reopen /
// new_case_version / ignore against the case's terminal-ness + its CURRENT goal
// report. On an act we REOPEN the case (caseManager.reopenCase — workflow-only,
// version bump = INV-16) and enqueue a re-wake so the ENGINE mints the superseding
// report (the judge boundary). On ignore (no met report to un-meet, or a stale
// event) it is a clean no-op. A permanently-malformed regression payload is a
// no-op too (dispatched, not retried) — refusing a bad kind, never looping on it.
const handleRegression = async ({ client, row, caseId, firmId, clientId }) => {
  if (!caseId) return { enqueued: 0, noop: 'no_case_anchor' };
  const regression = row.payload?.regression || row.payload?.regression_event || null;
  if (!regression) return { enqueued: 0, noop: 'no_regression_event' };

  const caseRow = await readCaseRow({ client, firmId, caseId });
  if (!caseRow) return { enqueued: 0, noop: 'case_absent' };
  const currentGoalReport = await readLatestGoalReport({ client, firmId, caseId });

  let decision;
  try {
    decision = decideRegression({
      caseStatus: caseRow.status,
      currentGoalReport,
      regressionEvent: { ...regression, caseId },
      caseVersion: Number(caseRow.case_version) || 1,
      asOf: row.created_at || null
    });
  } catch (error) {
    // Unknown kind / corrupt status — permanently malformed, so don't retry it.
    return { enqueued: 0, noop: `invalid_regression:${error?.message || 'refused'}` };
  }
  if (decision.decision === 'ignore') return { enqueued: 0, noop: decision.reason };

  await reopenCase({
    client, firmId, clientId, caseId,
    reason: `goal_regression:${decision.kind}`,
    supersededReportId: decision.supersededReportId,
    regressionKey: decision.regressionKey,
    nextCaseVersion: decision.nextCaseVersion
  });

  const out = await insertLoopEvent({
    client, firmId, clientId,
    source: DISPATCH_SOURCE,
    sourceEventId: decision.regressionKey, // idempotent reopen (§13.4)
    eventType: 'manual.resume',
    objectType: 'bookkeeping_case', objectId: caseId,
    payload: {
      case_id: caseId, via: 'goal_regression', kind: decision.kind,
      supersedes_report_id: decision.supersededReportId, outbox_id: row.id
    }
  });
  return { enqueued: out?.inserted ? 1 : 0, reopened: true };
};

const HANDLERS = Object.freeze({
  'case.resolved': handleCascade,
  'goal.regressed': handleRegression
});

export const DISPATCH_HANDLED_EVENT_TYPES = Object.freeze(Object.keys(HANDLERS));

// ── the dispatch run ─────────────────────────────────────────────────────────

// Drain up to `limit` dispatchable outbox rows for (firm?, client?). Returns a
// summary. No-throw per row: a poisoned row is marked 'failed' (backed off, then
// dead-lettered) and the run continues. Deterministic given (rows, asOf, policy) —
// the plan is pure; asOf is injected for replayability, like nextCaseSelector.
export const dispatchLoopOutbox = async ({
  client, firmId = null, clientId = null, limit = 100,
  asOf = Date.now(), policy, env = process.env
} = {}) => {
  // Master switch (the one graduation model): LOOPS_SHADOW off / tier 'off' skips
  // the whole dispatch, byte-identical to today (nothing dispatched). Per-row the
  // ACTION gate (canary+) decides whether each row actually fires.
  if (!isLoopSystemEnabled(env)) return { skipped: true, reason: 'loops_off' };
  if (!client) return { skipped: true, reason: 'no_client' };
  if (!(await loopsTablesPresent(client))) return { skipped: true, reason: 'tables_absent' };

  const rows = await readDispatchableOutbox({ client, firmId, clientId, limit });
  // Only event types we know how to dispatch reach the planner; the rest stay
  // 'pending' (honest — a future phase adds their handler).
  const candidates = rows.filter((r) => HANDLERS[r.event_type]);
  const stats = {
    skipped: false, considered: rows.length, planned: candidates.length,
    dispatched: 0, enqueued: 0, held: 0, dropped: 0,
    deadLettered: 0, duplicates: 0, failed: 0, lost: 0
  };
  if (!candidates.length) return stats;

  const byId = new Map(candidates.map((r) => [String(r.id), r]));
  const plan = planOutboxDispatch({ rows: candidates, asOf, policy });

  // Duplicates → collapse to the survivor (terminal drop, race-safe CAS).
  for (const dup of plan.duplicates) {
    const raw = byId.get(String(dup.id));
    if (raw && await dropOutboxRow({ client, id: dup.id, reason: 'duplicate', expectedStatus: raw.status, asOf })) {
      stats.duplicates += 1;
    }
  }
  // Dead-letters → give up + escalate (the planner's circuit-breaker). 'cancelled'
  // so the planner never re-reports them; the warn is the (V1) escalation.
  for (const dl of plan.deadLettered) {
    const raw = byId.get(String(dl.id));
    if (raw && await dropOutboxRow({ client, id: dl.id, reason: 'max_attempts', expectedStatus: raw.status, asOf })) {
      stats.deadLettered += 1;
      try {
        console.warn(`[loops-dispatch] dead-lettered outbox ${dl.id} (${raw.event_type}) after ${dl.attempts} attempts`);
      } catch { /* never throw from logger */ }
    }
  }

  // Ready → re-gate, then dispatch. Cache the firm execution context per run so a
  // batch of one firm's rows reads firms.metadata once.
  const firmCtxCache = new Map();
  for (const r of plan.ready) {
    const raw = byId.get(String(r.id));
    if (!raw) continue;
    const rowFirmId = raw.firm_id;
    const rowClientId = raw.client_id;
    const caseId = resolveCaseId(raw);

    // DISPATCH-TIME RE-GATE (read before claiming so a held row never churns a
    // claim). The SAME readActiveCaseSuspension + decideLoopExecution the wake uses.
    let firmCtx = firmCtxCache.get(rowFirmId);
    if (!firmCtx) { firmCtx = await readFirmExecutionContext(client, rowFirmId); firmCtxCache.set(rowFirmId, firmCtx); }
    const caseSuspension = caseId
      ? await readActiveCaseSuspension({ client, firmId: rowFirmId, clientId: rowClientId, caseId })
      : null;
    const gate = decideLoopExecution({
      loopKey: null, firmMetadata: firmCtx.firmMetadata, caseSuspension,
      requestedAction: DISPATCH_ACTION, env
    });
    if (!gate.allowed || gate.actionAllowed === false) {
      // mode/terminal: a CANCELLED case (terminal) drops its row for good; any other
      // block (firm/case paused, tier too low) is a resumable HOLD — leave it pending.
      if (caseSuspension?.terminal) {
        if (await dropOutboxRow({ client, id: r.id, reason: `case_${caseSuspension.mode}`, expectedStatus: raw.status, asOf })) {
          stats.dropped += 1;
        }
      } else {
        stats.held += 1; // never claimed → re-attempted when the gate reopens
      }
      continue;
    }

    // Claim (optimistic single-flight). A lost CAS = another dispatcher took it.
    const claimed = await claimOutboxRow({
      client, id: r.id, expectedStatus: raw.status, expectedAttempts: raw.attempts, asOf
    });
    if (!claimed) { stats.lost += 1; continue; }

    // Side effect in its own mini-transaction: enqueue + mark are atomic, so a
    // poisoned row never rolls back its siblings, and an at-least-once redelivery
    // re-enqueues idempotent keys (no duplicate downstream effect). INV-11: DB-only.
    let began = false;
    try {
      await client.query('begin'); began = true;
      const result = await HANDLERS[raw.event_type]({ client, row: raw, caseId, firmId: rowFirmId, clientId: rowClientId });
      await markOutboxDispatched({ client, id: r.id });
      await client.query('commit');
      stats.dispatched += 1;
      stats.enqueued += result?.enqueued || 0;
    } catch (error) {
      if (began) { try { await client.query('rollback'); } catch { /* best-effort */ } }
      try { await failOutboxRow({ client, id: r.id, error, asOf }); } catch { /* best-effort */ }
      stats.failed += 1;
      try { console.warn(`[loops-dispatch] outbox ${r.id} failed: ${error?.message || error}`); } catch { /* never throw from logger */ }
    }
  }

  return stats;
};
