// Donna Loops — the post-commit outbox (Phase 1 enqueue + Step 7 row-state).
//
// Side-effect events (external sync requests, downstream notifications) must be
// emitted only AFTER the local transaction commits (INV-8): the row is enqueued
// inside the same transaction as the case write, then the dispatcher emits it and
// marks it dispatched.
//
// Phase 1 shipped ONLY the enqueue + a read-only debug lister: 'dispatched' must
// mean a real side effect happened, and no dispatcher existed, so rows sat
// 'pending' forever (migration 033: "No dispatcher ships here"). Step 7
// (loopOutboxDispatcher.js — design §10) is that dispatcher; the row-state
// helpers it needs live HERE (the table's owner module), mirroring how
// loopEventInbox owns the inbox's claim/mark helpers that loopInboxWorker
// consumes. These helpers do NO external I/O and call NO LLM — they are the
// at-least-once status machine over the table; the dispatcher does the (DB-only,
// in V1) side effect under the gate.

import crypto from 'node:crypto';

export const LOOP_OUTBOX_STATUSES = ['pending', 'dispatching', 'dispatched', 'failed', 'cancelled'];

const newOutboxId = () => `loop-outbox-${crypto.randomUUID()}`;

// Enqueue a side-effect event. Call this INSIDE the same transaction as the
// case write so it is emitted only if that transaction commits (INV-8).
export const enqueueOutbox = async ({
  client, firmId, clientId, eventType, objectType = null, objectId = null, payload = {}
} = {}) => {
  const cleanEventType = String(eventType || '').trim();
  if (!client || !firmId || !clientId || !cleanEventType) return null;
  const id = newOutboxId();
  const result = await client.query(
    `insert into loop_event_outbox
       (id, firm_id, client_id, event_type, object_type, object_id, payload, status)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, 'pending')
     returning id`,
    [id, firmId, clientId, cleanEventType, objectType, objectId, JSON.stringify(payload || {})]
  );
  return result.rows[0]?.id ? { id: result.rows[0].id } : null;
};

// Read-only: what WOULD be dispatched. Phase 1 never mutates status — a row is
// 'dispatched' only once a real side effect was emitted (later phases).
export const listPendingOutboxForDebug = async ({ client, firmId = null, clientId = null, limit = 100 } = {}) => {
  if (!client) return [];
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const conditions = [`status = 'pending'`];
  const params = [];
  if (firmId) { params.push(firmId); conditions.push(`firm_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conditions.push(`client_id = $${params.length}`); }
  params.push(bounded);
  const result = await client.query(
    `select id, firm_id, client_id, event_type, object_type, object_id, payload, status, created_at
       from loop_event_outbox
      where ${conditions.join(' and ')}
      order by created_at asc
      limit $${params.length}`,
    params
  );
  return result.rows;
};

// ── Step 7: the dispatcher's row-state machine ───────────────────────────────
// The full row shape the planner (loopOutboxPlanner.planOutboxDispatch) reads:
// attempts + last_error (the attempt stamp) drive backoff / dead-letter, payload
// carries the idempotency key, object_* the serialization lane. Includes the
// non-terminal statuses only (the planner ignores dispatched/cancelled anyway).

const toIso = (asOf) => {
  const ms = typeof asOf === 'number' ? asOf : Date.parse(asOf);
  return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
};

export const readDispatchableOutbox = async ({ client, firmId = null, clientId = null, limit = 100 } = {}) => {
  if (!client) return [];
  const bounded = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const conditions = [`status in ('pending', 'failed', 'dispatching')`];
  const params = [];
  if (firmId) { params.push(firmId); conditions.push(`firm_id = $${params.length}`); }
  if (clientId) { params.push(clientId); conditions.push(`client_id = $${params.length}`); }
  params.push(bounded);
  const result = await client.query(
    `select id, firm_id, client_id, event_type, object_type, object_id, payload,
            status, attempts, last_error, created_at, dispatched_at
       from loop_event_outbox
      where ${conditions.join(' and ')}
      order by created_at asc
      limit $${params.length}`,
    params
  );
  return result.rows;
};

// Claim a planned-ready row for dispatch. Optimistic CAS on (id, status, attempts):
// only ONE dispatcher wins — even reclaiming a stuck 'dispatching' row — because
// the attempts token changes on the first update, so a concurrent claim's WHERE no
// longer matches. Bumps attempts and stamps the attempt time into last_error.at
// (the planner reads it to measure the backoff / stuck-reclaim window; the table
// has no dedicated last_attempt_at column, and last_error is its only timestamp
// slot — the planner treats .at generically). Returns true iff this caller claimed it.
export const claimOutboxRow = async ({ client, id, expectedStatus, expectedAttempts, asOf = Date.now() } = {}) => {
  if (!client || !id || !expectedStatus) return false;
  const result = await client.query(
    `update loop_event_outbox
        set status = 'dispatching',
            attempts = attempts + 1,
            last_error = jsonb_strip_nulls(jsonb_build_object(
              'at', $4::text, 'phase', 'dispatching',
              'previous_error', case
                when last_error #> '{details,provider_failure}' is not null then last_error - 'previous_error'
                when last_error #> '{previous_error,details,provider_failure}' is not null then last_error->'previous_error'
                else null end
            ))
      where id = $1 and status = $2 and attempts = $3
      returning id`,
    [id, expectedStatus, Math.max(0, Math.floor(Number(expectedAttempts) || 0)), toIso(asOf)]
  );
  return (result.rowCount || 0) > 0;
};

// The terminal success flip: a real side effect happened, so 'dispatched' is now
// honest. CAS on 'dispatching' so only the claimer marks it (and a redelivery is a no-op).
export const markOutboxDispatched = async ({ client, id } = {}) => {
  if (!client || !id) return false;
  const result = await client.query(
    `update loop_event_outbox set status = 'dispatched', dispatched_at = now(), last_error = null
      where id = $1 and status = 'dispatching' returning id`,
    [id]
  );
  return (result.rowCount || 0) > 0;
};

// Terminally drop a row (a cancelled case's row — terminal DROP, a planner
// duplicate, or a dead-lettered row). 'cancelled' is the table's terminal "will
// never dispatch" status; the reason rides in last_error for the audit trail. CAS
// on the observed status so a concurrent dispatcher never double-acts.
export const dropOutboxRow = async ({ client, id, reason = 'dropped', expectedStatus = null, asOf = Date.now() } = {}) => {
  if (!client || !id) return false;
  const params = [id, String(reason), toIso(asOf)];
  let where = `id = $1`;
  if (expectedStatus) { params.push(expectedStatus); where += ` and status = $${params.length}`; }
  else { where += ` and status not in ('dispatched', 'cancelled')`; }
  const result = await client.query(
    `update loop_event_outbox
        set status = 'cancelled',
            last_error = jsonb_strip_nulls(jsonb_build_object(
              'at', $3::text,
              'reason', $2::text,
              'previous_error', case
                when last_error->>'phase' = 'dispatching'
                  and last_error #> '{previous_error,details,provider_failure}' is not null
                then last_error->'previous_error'
                else last_error end
            ))
      where ${where} returning id`,
    params
  );
  return (result.rowCount || 0) > 0;
};

// A transient dispatch failure: back to 'failed' with the failure time stamped into
// last_error.at so the planner backs it off (and dead-letters it after maxAttempts).
// Keeps the bumped attempts — a real failure counts toward the cap.
export const failOutboxRow = async ({ client, id, error = null, asOf = Date.now() } = {}) => {
  if (!client || !id) return false;
  const message = error ? String(error.message || error).slice(0, 500) : 'dispatch_failed';
  const code = error?.code ? String(error.code).slice(0, 120) : '';
  let details = null;
  try {
    const serialized = error?.details == null ? null : JSON.stringify(error.details);
    // A bounded diagnostic receipt is preferable to either an unbounded row
    // or invalid JSON produced by slicing a serialized object mid-token.
    details = serialized && serialized.length <= 8000
      ? serialized
      : (serialized ? JSON.stringify({ truncated: true }) : null);
  } catch {
    details = JSON.stringify({ unreadable: true });
  }
  const result = await client.query(
    `update loop_event_outbox
        set status = 'failed',
            last_error = jsonb_strip_nulls(jsonb_build_object(
              'at', $2::text,
              'message', $3::text,
              'code', nullif($4::text, ''),
              'details', $5::jsonb
            ))
      where id = $1 and status = 'dispatching' returning id`,
    [id, toIso(asOf), message, code, details]
  );
  return (result.rowCount || 0) > 0;
};
