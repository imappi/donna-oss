// Donna Loops — the at-least-once event inbox (Phase 1).
//
// Domain events (client replies, parse outcomes, ask sends) are at-least-once:
// they get duplicated, delayed, retried, reordered. The inbox is the dedupe +
// idempotent-claim boundary (INV-6): every event is recorded once, keyed on
// (source, source_event_id), and a worker claims pending rows one at a time
// with FOR UPDATE SKIP LOCKED so two workers never process the same event.
//
// Phase 1 is shadow-only: events are recorded and claimable, but no consumer
// worker is wired yet. No LLM, no external calls.

import crypto from 'node:crypto';

export const LOOP_INBOX_STATUSES = ['pending', 'processing', 'processed', 'failed', 'ignored'];

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_PROCESSING_TTL_MS = 5 * 60 * 1000;

const newInboxId = () => `loop-inbox-${crypto.randomUUID()}`;

// Stable hash of the event payload, so a re-delivery with identical content is
// recognisably the same event even beyond the (source, source_event_id) key.
export const buildPayloadHash = (payload = {}) => {
  let serialized;
  try {
    serialized = JSON.stringify(payload ?? {});
  } catch {
    serialized = '';
  }
  return crypto.createHash('sha256').update(serialized).digest('hex').slice(0, 32);
};

// Record an incoming domain event. Idempotent: a duplicate
// (source, source_event_id) does NOT insert a second row — it returns the
// existing row's id with inserted=false. Returns { id, inserted } or null on
// bad input.
export const insertLoopEvent = async ({
  client, firmId, clientId, source, sourceEventId, eventType,
  objectType = null, objectId = null, payload = {}
} = {}) => {
  const cleanSource = String(source || '').trim();
  const cleanSourceEventId = String(sourceEventId || '').trim();
  const cleanEventType = String(eventType || '').trim();
  if (!client || !firmId || !clientId || !cleanSource || !cleanSourceEventId || !cleanEventType) return null;
  const id = newInboxId();
  const payloadHash = buildPayloadHash(payload);
  const result = await client.query(
    `insert into loop_event_inbox
       (id, firm_id, client_id, source, source_event_id, event_type, object_type, object_id, payload_hash, payload, status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, 'pending')
     on conflict (source, source_event_id) do nothing
     returning id`,
    [id, firmId, clientId, cleanSource, cleanSourceEventId, cleanEventType, objectType, objectId, payloadHash, JSON.stringify(payload || {})]
  );
  if (result.rows[0]?.id) return { id: result.rows[0].id, inserted: true };
  const existing = await client.query(
    `select id from loop_event_inbox where source = $1 and source_event_id = $2 limit 1`,
    [cleanSource, cleanSourceEventId]
  );
  return { id: existing.rows[0]?.id || id, inserted: false };
};

// Claim one pending event. FOR UPDATE SKIP LOCKED so concurrent workers never
// grab the same row. Marks it processing, bumps attempts, records the lock
// owner + a processing deadline (for stale reclaim).
export const claimPendingEvent = async ({
  client, workerId = 'worker', processingTtlMs = DEFAULT_PROCESSING_TTL_MS
} = {}) => {
  if (!client) return null;
  const ttl = Math.max(1000, Number(processingTtlMs) || DEFAULT_PROCESSING_TTL_MS);
  const claimed = await client.query(
    `update loop_event_inbox
       set status = 'processing',
           attempts = attempts + 1,
           locked_by = $1,
           processing_started_at = now(),
           processing_deadline_at = now() + ($2 || ' milliseconds')::interval
     where id = (
       select id from loop_event_inbox
        where status = 'pending'
        order by first_seen_at asc
        for update skip locked
        limit 1
     )
     returning *`,
    [String(workerId || 'worker'), String(ttl)]
  );
  return claimed.rows[0] || null;
};

export const markProcessed = async ({ client, eventId } = {}) => {
  if (!client || !eventId) return false;
  const result = await client.query(
    `update loop_event_inbox set status = 'processed', processed_at = now()
      where id = $1 returning id`,
    [eventId]
  );
  return result.rows.length > 0;
};

export const markFailed = async ({ client, eventId, error = null } = {}) => {
  if (!client || !eventId) return false;
  const payload = error ? { message: String(error.message || error) } : {};
  const result = await client.query(
    `update loop_event_inbox set status = 'failed', last_error = $2::jsonb
      where id = $1 returning id`,
    [eventId, JSON.stringify(payload)]
  );
  return result.rows.length > 0;
};

export const markIgnored = async ({ client, eventId, reason = '' } = {}) => {
  if (!client || !eventId) return false;
  const result = await client.query(
    `update loop_event_inbox set status = 'ignored', last_error = $2::jsonb, processed_at = now()
      where id = $1 returning id`,
    [eventId, JSON.stringify({ ignored_reason: String(reason || '') })]
  );
  return result.rows.length > 0;
};

// Worker-death recovery: a row stuck in 'processing' past its deadline is
// requeued (under the attempt cap) or failed (over it). Idempotent.
export const reclaimStaleProcessingEvents = async ({ client, maxAttempts = DEFAULT_MAX_ATTEMPTS } = {}) => {
  if (!client) return { requeued: 0, failed: 0 };
  const cap = Math.max(1, Number(maxAttempts) || DEFAULT_MAX_ATTEMPTS);
  const requeued = await client.query(
    `update loop_event_inbox
       set status = 'pending', locked_by = null,
           processing_started_at = null, processing_deadline_at = null
     where status = 'processing'
       and processing_deadline_at is not null
       and processing_deadline_at < now()
       and attempts < $1
     returning id`,
    [cap]
  );
  const failed = await client.query(
    `update loop_event_inbox
       set status = 'failed', locked_by = null,
           last_error = coalesce(last_error, '{}'::jsonb) || '{"reclaim":"max_attempts_exceeded"}'::jsonb
     where status = 'processing'
       and processing_deadline_at is not null
       and processing_deadline_at < now()
       and attempts >= $1
     returning id`,
    [cap]
  );
  return { requeued: requeued.rows.length, failed: failed.rows.length };
};
