// Donna Loops — the auto-DRAFT request CONSUMER (Slice 3 of the autonomous-loop demo;
// see docs/session-handoff-2026-06-23-autonomous-loop-autosend.md).
//
// The demo loop is: client uploads → Donna reconciles → Donna asks the open questions →
// client answers → re-reconcile. Step "asks the open questions" has two halves:
//   - DRAFT the batch (this slice) — `proposal_creation`, permitted at canary+.
//   - SEND  the batch (Slice 2)    — `client_visible_message`, V1-forbidden, permitted
//                                     only with the firm's `auto_send_client_asks` toggle.
// So a canary firm DRAFTS on its own; it only auto-SENDS once the human toggle is on.
//
// The DRAFT itself is the strong-LLM ask pipeline (askPipeline.js / __draftClientAsk-
// BatchWithClient) — the intelligence. This consumer is the Keep-layer plumbing that
// lets a reconciliation completion TRIGGER that draft without a firm operator clicking
// "draft", mirroring the PR-1b reconciliation fresh-evaluation consumer:
//   - the PRODUCER (loopsShadowProducers.onReconcileCompleteRequestAskDraft) enqueues a
//     durable `ask_draft.requested` outbox row on the post-reconcile seam, gated to
//     canary+ (so a shadow firm never accrues a held request);
//   - THIS consumer drains those rows, re-gates per firm, claims (single-flight), and
//     runs the draft OUTSIDE any DB transaction (INV-11 — the model call holds no txn),
//     then marks the row dispatched.
//
// INVARIANTS (mirror reconciliationEvalConsumer):
//   INV-11  the model call runs OUTSIDE any txn — claim (CAS → 'dispatching'), draft
//           (the draft fn opens + commits its OWN short txn), then a bare dispatched flip.
//   §13.4   idempotent: the draft pipeline SUPERSEDES the prior live draft, so a
//           redelivery (or a second tick) re-drafts/replaces rather than piling up; a
//           lost CAS means another worker took the row.
//   F-19    the drain plans through loopOutboxPlanner.planOutboxDispatch — the SAME
//           planner the dispatcher uses — so a row already in flight is DEFERRED until
//           the stuck window elapses. readDispatchableOutbox deliberately returns
//           'dispatching' rows (for crash reclaim), and the claim CAS keys on the
//           attempts token the in-flight worker already bumped, so claiming straight
//           off the raw read let a second tick re-claim a live row and spend a second
//           model call on it. Backoff and dead-lettering come with the planner.
//   Step 6  honors firm suspension + the tier gate BEFORE spending tokens (the SAME
//           decideLoopExecution the wake/dispatcher/eval-consumer use). Its action is
//           `proposal_creation` (canary+) → INERT at shadow (byte-identical to no
//           consumer, the careful-canary discipline).
//
// CLAUDE.md trust-the-strong-LLM: the model decides WHAT to ask (and short-circuits
// `nothing_to_ask`); the loop layer only TRIGGERS the draft and records the request as
// satisfied. No intelligence-substituting scaffolding.

import {
  readDispatchableOutbox, claimOutboxRow, markOutboxDispatched,
  dropOutboxRow, failOutboxRow
} from './loopEventOutbox.js';
import { planOutboxDispatch } from './loopOutboxPlanner.js';
import { loopsTablesPresent } from './caseManager.js';
import {
  isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext
} from './loopExecutionGate.js';
import { __draftClientAskBatchWithClient } from './firmDb.js';

const LOG_TAG = 'askAutoDraftConsumer';

// The outbox event the producer enqueues (read here). Exported so the loopEventRegistry
// source-scan / cross-check can attribute the consumer to this worker. The PRODUCER must
// enqueue this as a STRING LITERAL (the registry scanner only sees literals) — see
// loopsShadowProducers.onReconcileCompleteRequestAskDraft.
export const ASK_DRAFT_REQUEST_EVENT = 'ask_draft.requested';

// The per-loop tier key (loops['coding_ask_batch_resolution'].tier may override the
// firm-wide loops.tier). The loop that owns the ask-batch resolution goal.
const LOOP_KEY = 'coding_ask_batch_resolution';

// The §13.8 bounded action a draft performs: drafting a proposal (NOT applied/sent),
// permitted at canary+. So this consumer is INERT at shadow (gate blocks 'tier_too_low').
const REQUESTED_ACTION = 'proposal_creation';

const DEFAULT_LIMIT = 25;

// Process ONE ask_draft.requested outbox row. Pure + dbClient-injectable (the unit-
// testable seam); NEVER throws on the model path (a thrown draft is turned into
// failOutboxRow). `draftBatchFn` is the whole draft operation, injectable for tests; in
// prod it is the real __draftClientAskBatchWithClient (whose LLM call runs BEFORE its own
// txn — INV-11). The draft SQL itself is pinned by askBatch.test.js; this seam tests the
// consumer's gate / claim / dispatch orchestration.
//
// Lifecycle: re-gate (no claim — a held row never churns a claim) → claim (CAS) →
// draft (model, OUTSIDE any txn) → mark dispatched.
export const runAskDraftRequest = async ({
  client, row, env = process.env, asOf = Date.now(), draftBatchFn = __draftClientAskBatchWithClient
} = {}) => {
  if (!client || !row?.id) return { status: 'skipped', reason: 'no_row' };
  if (row.event_type !== ASK_DRAFT_REQUEST_EVENT) {
    return { status: 'skipped', reason: 'wrong_event_type' };
  }

  const firmId = row.firm_id;
  const clientId = row.client_id;
  if (!firmId || !clientId) {
    await dropOutboxRow({ client, id: row.id, reason: 'malformed_request', expectedStatus: row.status, asOf });
    return { status: 'dropped', reason: 'malformed_request' };
  }

  // RE-GATE before claiming — a tier drop / firm suspension landing AFTER the request was
  // enqueued still stops the spend. Drafting is proposal_creation (canary+); below that
  // the row is a resumable HOLD (left pending), exactly like the eval consumer.
  const { firmMetadata } = await readFirmExecutionContext(client, firmId);
  const gate = decideLoopExecution({
    loopKey: LOOP_KEY, firmMetadata, requestedAction: REQUESTED_ACTION, env
  });
  if (!gate.allowed || gate.actionAllowed === false) {
    return { status: 'held', reason: gate.actionBlockedReason || gate.blockedReason };
  }

  // Claim (optimistic single-flight). A lost CAS = another consumer took it.
  const claimed = await claimOutboxRow({
    client, id: row.id, expectedStatus: row.status, expectedAttempts: row.attempts || 0, asOf
  });
  if (!claimed) return { status: 'lost' };

  // THE DRAFT — the strong-model ask-pipeline call, with NO open txn (INV-11: the draft
  // fn makes its model call BEFORE opening its own begin/commit). NEVER throws to caller.
  let result;
  try {
    result = await draftBatchFn({ client, firmId, clientId, actorId: 'system' });
  } catch (error) {
    // A vanished client is permanent — drop. Anything else (no api key, transient) backs
    // off to retry; never manufacture a draft from missing infra (the model-id-is-the-
    // receipt discipline).
    if (error?.code === 'ASK_BATCH_CLIENT_NOT_FOUND') {
      await dropOutboxRow({ client, id: row.id, reason: 'client_absent', expectedStatus: 'dispatching', asOf });
      return { status: 'dropped', reason: 'client_absent' };
    }
    await failOutboxRow({ client, id: row.id, error, asOf });
    return { status: 'failed', reason: error?.message || 'draft_threw' };
  }

  // The request is satisfied whether the model drafted a batch OR short-circuited
  // `nothing_to_ask` (a valid terminal — there was nothing open to ask). Mark dispatched.
  await markOutboxDispatched({ client, id: row.id });
  return {
    status: 'dispatched',
    batchId: result?.batch?.id || null,
    reason: result?.batch ? null : (result?.reason || 'nothing_to_ask')
  };
};

// Drain up to `limit` pending ask_draft.requested outbox rows for (firm?, client?).
// Returns a summary. No-throw per row: a poisoned row is failed (backoff) and the drain
// continues. Master-gated (loops off / pre-spine migration → a clean skip).
export const drainAskDraftRequests = async ({
  client, firmId = null, clientId = null, limit = DEFAULT_LIMIT,
  env = process.env, asOf = Date.now(), policy,
  draftBatchFn = __draftClientAskBatchWithClient
} = {}) => {
  if (!isLoopSystemEnabled(env)) return { skipped: true, reason: 'loops_off' };
  if (!client) return { skipped: true, reason: 'no_client' };
  if (!(await loopsTablesPresent(client))) return { skipped: true, reason: 'tables_absent' };

  const rows = await readDispatchableOutbox({ client, firmId, clientId, limit });
  const candidates = rows.filter((r) => r.event_type === ASK_DRAFT_REQUEST_EVENT);
  const stats = {
    skipped: false, considered: rows.length, planned: candidates.length,
    dispatched: 0, dropped: 0, held: 0, failed: 0, lost: 0,
    deferred: 0, duplicates: 0, deadLettered: 0
  };
  if (!candidates.length) return stats;

  // F-19: plan BEFORE claiming. The planner defers a row another worker is still
  // running (stuck window), honors the failure backoff, collapses duplicates by
  // idempotency key, and dead-letters an exhausted row — all before a token is spent.
  const byId = new Map(candidates.map((r) => [String(r.id), r]));
  const plan = planOutboxDispatch({ rows: candidates, asOf, policy });
  stats.deferred = plan.deferred.length;

  for (const dup of plan.duplicates) {
    const raw = byId.get(String(dup.id));
    if (raw && await dropOutboxRow({ client, id: dup.id, reason: 'duplicate', expectedStatus: raw.status, asOf })) {
      stats.duplicates += 1;
    }
  }
  for (const dl of plan.deadLettered) {
    const raw = byId.get(String(dl.id));
    if (raw && await dropOutboxRow({ client, id: dl.id, reason: 'max_attempts', expectedStatus: raw.status, asOf })) {
      stats.deadLettered += 1;
      try {
        console.warn(`[${LOG_TAG}] dead-lettered outbox ${dl.id} after ${dl.attempts} attempts`);
      } catch { /* never throw from logger */ }
    }
  }

  for (const planned of plan.ready) {
    const row = byId.get(String(planned.id));
    if (!row) continue;
    let out;
    try {
      out = await runAskDraftRequest({ client, row, env, asOf, draftBatchFn });
    } catch (error) {
      try { await failOutboxRow({ client, id: row.id, error, asOf }); } catch { /* best-effort */ }
      try { console.warn(`[${LOG_TAG}] row ${row.id} threw: ${error?.message || error}`); } catch { /* never throw from logger */ }
      stats.failed += 1;
      continue;
    }
    if (out.status === 'dispatched') stats.dispatched += 1;
    else if (out.status === 'dropped') stats.dropped += 1;
    else if (out.status === 'held') stats.held += 1;
    else if (out.status === 'failed') stats.failed += 1;
    else if (out.status === 'lost') stats.lost += 1;
  }

  return stats;
};
