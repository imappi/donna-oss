// Donna Loops — the reconciliation fresh-evaluation CONSUMER (PR 1b; the Trap-2 close).
//
// PR 1a's reconciliation wake, on an upstream-resolution cascade (a client answer
// cleared a blocking question on a still-unmatched bank line), stops WAITING and
// emits a durable `reconciliation.evaluation_requested` outbox row — a request for a
// FRESH strong-model re-match instead of re-projecting the stale `no_match` verdict.
// That row PARKED with no consumer (the dispatcher deliberately does not handle the
// type). THIS is the consumer: it drains those rows, re-runs the strong matcher for
// the ONE requested target (feeding the client's answer as context), persists a fresh
// verdict, and emits `reconciliation.evaluation_completed` so the reconciliation case
// re-wakes to read it (INV-12). That completion is NOT a cascade trigger, so the
// re-wake reads the fresh verdict and resolves/surfaces the gap — it never re-requests
// (no loop).
//
// CLAUDE.md trust-the-strong-LLM: this is where the strong model RE-ENTERS, and it
// enters UPSTREAM (the disposition matcher core, runBankLineDispositionForTransaction),
// exactly per Failure-B's prescription — give the model the line + the firm context +
// the client's answer in ONE call. The loop layer only TRIGGERS (PR 1a) and RE-WAKES
// to read the persisted verdict; the engine stays no-LLM (the engine/judge boundary).
//
// INVARIANTS:
//   INV-11  the model call runs OUTSIDE any DB transaction — the row is claimed
//           (CAS → 'dispatching'), the re-match runs with no open txn, then the
//           completion + the dispatched flip land in a short mini-txn.
//   §13.4   idempotent: the re-match re-stamps the SAME deterministic verdict row and
//           the completion re-uses the SAME source_event_id (the inbox dedupes on
//           (source, source_event_id)) → a redelivery causes no duplicate effect.
//   Step 6  honors firm/case suspension BEFORE spending tokens, via the SAME gate pair
//           the wake + dispatcher use (readActiveCaseSuspension + decideLoopExecution).
//           Its action is 'proposal_creation' (canary+), so it is INERT at shadow —
//           byte-identical to no consumer (the careful-canary inertness discipline). A
//           terminal (cancelled) case DROPS its row; a resumable HOLD leaves it pending.
//   F-19    the drain plans through loopOutboxPlanner.planOutboxDispatch — the SAME
//           planner the dispatcher uses — so a row another worker is still running is
//           DEFERRED until the stuck window elapses. readDispatchableOutbox
//           deliberately returns 'dispatching' rows (for crash reclaim), and the claim
//           CAS keys on the attempts token the in-flight worker already bumped, so
//           claiming straight off the raw read let a second tick re-claim a live row
//           and spend a second model call on it. Backoff and dead-lettering come with
//           the planner (the per-row failOutboxRow backoff was previously never read).
//
// SCOPE (deliberate, documented). The ONLY producer (PR 1a) requests on the §6.2
// coding→reconciliation cascade, and that edge links ONLY transaction-anchored
// reconciliation cases (loopsShadowProducers walks client_evidence_requests.
// transaction_id). So every request carries target_type='transaction' and the scoped
// re-match is the bank-line disposition for that one line. A non-transaction target is
// anomalous (no producer emits one today): it is DROPPED with 'unsupported_target_type'
// rather than parked forever. When a document-target producer + a document scoped
// re-match land, add the branch here and update the registry owner note.
//
// Pure + dbClient-injectable (mirrors __runReconciliationForBankStatementInDbWithClient):
// runReconciliationEvalRequest takes ONE row + the client, so its core unit-tests in the
// sandbox with a mock client + mock fetch; the cron wiring + the live LLM path validate
// in CI / prod.

import {
  readDispatchableOutbox, claimOutboxRow, markOutboxDispatched,
  dropOutboxRow, failOutboxRow
} from './loopEventOutbox.js';
import { planOutboxDispatch } from './loopOutboxPlanner.js';
import { insertLoopEvent } from './loopEventInbox.js';
import { loopsTablesPresent } from './caseManager.js';
import { readActiveCaseSuspension } from './caseSuspension.js';
import {
  isLoopSystemEnabled, decideLoopExecution, readFirmExecutionContext
} from './loopExecutionGate.js';
import { runBankLineDispositionForTransaction } from './bankLineDispositionLlm.js';
import { sanitizeUntrustedText } from './untrustedContent.js';

const LOG_TAG = 'reconciliationEvalConsumer';

// The outbox event PR 1a produces (read here) and the inbox event this consumer
// produces (the reconciliation loop subscribes to it). Kept as exported literals so
// the registry source-scan can attribute producer/consumer.
export const RECON_EVAL_REQUEST_EVENT = 'reconciliation.evaluation_requested';
export const RECON_EVAL_COMPLETED_EVENT = 'reconciliation.evaluation_completed';

// The §13.8 bounded action a re-match performs — drafting a fresh verdict is a
// proposal_creation, permitted only at canary+. So the consumer is INERT at shadow
// (the gate blocks it 'tier_too_low'), exactly like the dispatcher.
const REQUESTED_ACTION = 'proposal_creation';

// Source tag for the completion inbox event — namespaces the (source, source_event_id)
// idempotency key to this consumer.
const COMPLETION_SOURCE = 'reconciliation_eval';

const DEFAULT_LIMIT = 25;

const readCaseRow = async ({ client, firmId, caseId }) => {
  const res = await client.query(
    `select id, status, case_version from bookkeeping_cases
      where firm_id = $1 and id = $2 limit 1`,
    [firmId, caseId]
  ).catch(() => ({ rows: [] }));
  return res.rows[0] || null;
};

// INV-4: a confirmed/auto_matched match settles the target regardless of any verdict
// — re-matching it is pointless. Mirrors reconciliationWakeEvaluator.readMatchState,
// scoped to the one target.
const hasStickyMatch = async ({ client, firmId, clientId, targetType, targetId }) => {
  const res = await client.query(
    `select 1 from reconciliation_matches
      where firm_id = $1 and client_id = $2
        and status in ('confirmed', 'auto_matched')
        and ( ($3 = 'transaction' and bank_transaction_id = $4)
              or ($3 <> 'transaction' and matched_object_type = $3 and matched_object_id = $4) )
      limit 1`,
    [firmId, clientId, targetType, targetId]
  ).catch(() => ({ rows: [] }));
  return Boolean(res.rows[0]);
};

// The client's answer to the blocking question about THIS bank line — PR 1b's
// intelligence-layer context. The §6.2 edge links via client_evidence_requests.
// transaction_id, so the answer is the latest answered request for this line.
// Untrusted content (§6): sanitize to evidence (bounded copy + injection annotation)
// before it can reach the prompt. Returns the sanitized object or null.
const readClientAnswerForTransaction = async ({ client, firmId, clientId, transactionId }) => {
  if (!transactionId) return null;
  const res = await client.query(
    `select response_payload
       from client_evidence_requests
      where firm_id = $1 and client_id = $2 and transaction_id = $3
        and coalesce(response_payload->>'reply', '') <> ''
      order by responded_at desc nulls last, updated_at desc, created_at desc
      limit 1`,
    [firmId, clientId, transactionId]
  ).catch(() => ({ rows: [] }));
  const reply = res.rows[0]?.response_payload?.reply;
  if (!reply) return null;
  return sanitizeUntrustedText({ source: 'client_reply', text: reply });
};

// Process ONE reconciliation.evaluation_requested outbox row. The pure, dbClient-
// injectable core (the unit-testable seam). Returns a status object; NEVER throws on
// the model path (the re-match no-throws) — a thrown error is an infra fault the caller
// turns into failOutboxRow + continue.
//
// Lifecycle (mirrors the dispatcher's re-gate → claim → side-effect → mark, but the
// side effect — an LLM call — runs OUTSIDE any txn):
//   re-gate (no claim; a held row never churns a claim) → claim (CAS) →
//   stale/settled checks (no tokens spent) → scoped re-match (model) →
//   emit completion + mark dispatched (mini-txn).
export const runReconciliationEvalRequest = async ({
  client, row, apiKeyOverride, modelOverride, fetchImpl, env = process.env, asOf = Date.now()
} = {}) => {
  if (!client || !row?.id) return { status: 'skipped', reason: 'no_row' };
  if (row.event_type !== RECON_EVAL_REQUEST_EVENT) {
    return { status: 'skipped', reason: 'wrong_event_type' };
  }

  const firmId = row.firm_id;
  const clientId = row.client_id;
  const payload = row.payload || {};
  const caseId = payload.case_id || null;
  const targetType = payload.target_type || row.object_type || null;
  const targetId = payload.target_id || row.object_id || null;
  const requestedCaseVersion = Number(payload.case_version);

  // Permanently malformed — drop (never retry a row we can never satisfy).
  if (!firmId || !clientId || !caseId || !targetType || !targetId) {
    await dropOutboxRow({ client, id: row.id, reason: 'malformed_request', expectedStatus: row.status, asOf });
    return { status: 'dropped', reason: 'malformed_request' };
  }

  // RE-GATE before claiming — the SAME readFirmExecutionContext + readActiveCaseSuspension
  // + decideLoopExecution pair the wake/dispatcher use, so a firm/case suspended AFTER the
  // request still stops the spend. A terminal (cancelled) case DROPS the row; any other
  // block (firm/case paused, tier below canary) is a resumable HOLD — left pending.
  const { firmMetadata } = await readFirmExecutionContext(client, firmId);
  const caseSuspension = await readActiveCaseSuspension({ client, firmId, clientId, caseId });
  const gate = decideLoopExecution({
    loopKey: 'reconciliation_gap_resolution', firmMetadata, caseSuspension,
    requestedAction: REQUESTED_ACTION, env
  });
  if (!gate.allowed || gate.actionAllowed === false) {
    if (caseSuspension?.terminal) {
      await dropOutboxRow({ client, id: row.id, reason: `case_${caseSuspension.mode}`, expectedStatus: row.status, asOf });
      return { status: 'dropped', reason: `case_${caseSuspension.mode}` };
    }
    return { status: 'held', reason: gate.actionBlockedReason || gate.blockedReason };
  }

  // Claim (optimistic single-flight). A lost CAS = another consumer took it.
  const claimed = await claimOutboxRow({
    client, id: row.id, expectedStatus: row.status, expectedAttempts: row.attempts || 0, asOf
  });
  if (!claimed) return { status: 'lost' };

  // STALE-RESULT REJECTION (keyed on case_version), checked AFTER the claim but BEFORE
  // spending tokens. PR 1a stamps the PRE-wake version (leaseCaseVersion) into the
  // payload, and THAT wake's CAS bumped the case to requested+1 — so the expected
  // current version right after the request is requested+1. A version BEYOND that means
  // a NEWER wake superseded this request (a fresher answer / a settling verdict already
  // re-evaluated the case); its result stands, so drop without re-matching. A case that
  // vanished (deleted/reset) drops too.
  const caseRow = await readCaseRow({ client, firmId, caseId });
  if (!caseRow) {
    await dropOutboxRow({ client, id: row.id, reason: 'case_absent', expectedStatus: 'dispatching', asOf });
    return { status: 'dropped', reason: 'case_absent' };
  }
  const currentVersion = Number(caseRow.case_version) || 0;
  if (Number.isFinite(requestedCaseVersion) && currentVersion > requestedCaseVersion + 1) {
    await dropOutboxRow({ client, id: row.id, reason: 'superseded_case_version', expectedStatus: 'dispatching', asOf });
    return { status: 'dropped', reason: 'superseded_case_version' };
  }

  // A sticky match settled the line since the request — re-matching is pointless (INV-4).
  if (await hasStickyMatch({ client, firmId, clientId, targetType, targetId })) {
    await dropOutboxRow({ client, id: row.id, reason: 'already_settled', expectedStatus: 'dispatching', asOf });
    return { status: 'dropped', reason: 'already_settled' };
  }

  // Only transaction targets are produced today (see SCOPE). Anything else is anomalous
  // — drop rather than park forever (the registry monitor watches the pending backlog).
  if (targetType !== 'transaction') {
    await dropOutboxRow({ client, id: row.id, reason: 'unsupported_target_type', expectedStatus: 'dispatching', asOf });
    return { status: 'dropped', reason: 'unsupported_target_type' };
  }

  // The client's answer to the blocking question on this line (untrusted → sanitized).
  const answer = await readClientAnswerForTransaction({ client, firmId, clientId, transactionId: targetId });

  // THE SCOPED RE-MATCH — the strong-model call, with NO open txn (INV-11). NEVER throws.
  let result;
  try {
    result = await runBankLineDispositionForTransaction({
      client, firmId, clientId, transactionId: targetId,
      clientAnswer: answer?.safe_text || null,
      apiKeyOverride, modelOverride, fetchImpl
    });
  } catch (error) {
    await failOutboxRow({ client, id: row.id, error, asOf });
    return { status: 'failed', reason: error?.message || 'rematch_threw' };
  }

  if (!result?.ran) {
    // A permanent reason (the line is gone, or already resolved by a match/posting)
    // drops; a transient one (no api key) backs off to retry — never manufacture a
    // verdict from missing infra (the "model id is part of the receipt" discipline).
    if (result?.reason === 'transaction_absent' || result?.reason === 'already_resolved') {
      await dropOutboxRow({ client, id: row.id, reason: result.reason, expectedStatus: 'dispatching', asOf });
      return { status: 'dropped', reason: result.reason };
    }
    await failOutboxRow({ client, id: row.id, error: new Error(result?.reason || 'rematch_not_run'), asOf });
    return { status: 'failed', reason: result?.reason || 'rematch_not_run' };
  }

  // Persist signal + mark dispatched. The fresh verdict is already stamped (inside the
  // re-match). Emit the completion inbox event so the reconciliation case re-wakes to
  // read it (INV-12); the inbox dedupes on (source, source_event_id) so a redelivery is
  // idempotent. Then flip the outbox row dispatched (CAS on 'dispatching'). Wrapped in a
  // mini-txn so the two land atomically; a crash leaves the row 'dispatching' to be
  // reclaimed and re-run (idempotent).
  let began = false;
  try {
    await client.query('begin'); began = true;
    await insertLoopEvent({
      client, firmId, clientId,
      source: COMPLETION_SOURCE,
      sourceEventId: result.evaluationId,
      // LITERAL, not the RECON_EVAL_COMPLETED_EVENT constant: the loopEventRegistry
      // source-scan attributes a producer only by a quoted eventType, so a dynamic
      // value would escape the invariant (the proposal_rerun.requested-class orphan).
      eventType: 'reconciliation.evaluation_completed',
      objectType: targetType, objectId: targetId,
      payload: {
        case_id: caseId,
        target_type: targetType,
        target_id: targetId,
        evaluation_id: result.evaluationId,
        model: result.model,
        verdict: result.verdict,
        disposition: result.disposition,
        based_on_case_version: Number.isFinite(requestedCaseVersion) ? requestedCaseVersion : null,
        requested_by_event_id: row.id,
        injection_detected: answer?.injection_detected || false
      }
    });
    await markOutboxDispatched({ client, id: row.id });
    await client.query('commit');
  } catch (error) {
    if (began) { try { await client.query('rollback'); } catch { /* best-effort */ } }
    try { await failOutboxRow({ client, id: row.id, error, asOf }); } catch { /* best-effort */ }
    return { status: 'failed', reason: error?.message || 'persist_failed' };
  }

  return {
    status: 'dispatched',
    verdict: result.verdict,
    disposition: result.disposition,
    evaluationId: result.evaluationId
  };
};

// Drain up to `limit` pending reconciliation.evaluation_requested outbox rows for
// (firm?, client?). Returns a summary. No-throw per row: a poisoned row is marked
// failed (backoff → dead-letter is the dispatcher's planner; here a plain failOutboxRow)
// and the drain continues. Master-gated (loops off / pre-037 → a clean skip).
export const drainReconciliationEvalRequests = async ({
  client, firmId = null, clientId = null, limit = DEFAULT_LIMIT,
  apiKeyOverride, modelOverride, fetchImpl, env = process.env, asOf = Date.now(),
  policy
} = {}) => {
  if (!isLoopSystemEnabled(env)) return { skipped: true, reason: 'loops_off' };
  if (!client) return { skipped: true, reason: 'no_client' };
  if (!(await loopsTablesPresent(client))) return { skipped: true, reason: 'tables_absent' };

  const rows = await readDispatchableOutbox({ client, firmId, clientId, limit });
  const candidates = rows.filter((r) => r.event_type === RECON_EVAL_REQUEST_EVENT);
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
      out = await runReconciliationEvalRequest({
        client, row, apiKeyOverride, modelOverride, fetchImpl, env, asOf
      });
    } catch (error) {
      // The per-row fn no-throws on the model path; a throw here is an infra fault.
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
