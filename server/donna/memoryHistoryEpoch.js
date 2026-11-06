// Donna — BizOS Slice 2c-iii (sub-PR 5): the HARD MEMORY-HISTORY FENCE (§F/§N-D).
//
// `known_facts = null` does not prove legacy left the prompt — legacy facts
// re-enter through prior user/assistant turns and summaries in the conversation
// history. The DECIDED mechanism is a hard fence: on a memory-mode transition we
// open a NEW epoch and exclude ALL pre-epoch user messages, assistant messages,
// AND summaries from the MODEL payload, while PRESERVING the full transcript for
// the owner UI + audit. The fence applies both ways (canary entry AND rollback).
//
// Two halves:
//   - `buildHistoryForMemoryEpoch` — the PURE fence: given the ordered history and
//     the active epoch (with a boundary), return only the in-epoch messages. This
//     is what the seam (sub-PR 7) applies to the model history; the UI projection
//     stays full.
//   - the DB reader/writer (`getActiveMemoryHistoryEpoch` / `enterMemoryHistoryEpoch`)
//     over migration 086. The lever (sub-PR 8) opens epochs; the seam reads one.
//
// Activation unit is the FULL §N-C tuple `client × audience × purpose`.

import { randomUUID } from 'node:crypto';

export const MEMORY_HISTORY_EPOCH_MODES = Object.freeze(['v2', 'legacy']);

// A message whose ROLE marks it a conversation summary. §F excludes summaries too
// — a summary generated over pre-epoch turns must not carry legacy-derived facts
// into a fenced prompt. (No summariser exists in this repo yet; this is the
// forward-safe rule, applied by the same boundary.)
const isSummaryMessage = (m) =>
  m && (m.role === 'summary' || m.payload?.is_summary === true || m.payload?.kind === 'summary');

const createdAtMs = (m) => {
  const raw = m?.created_at;
  if (raw == null) return null;
  const t = typeof raw === 'number' ? raw : Date.parse(raw);
  return Number.isFinite(t) ? t : null;
};

// buildHistoryForMemoryEpoch({ history, epoch }) → { messages, fenced, epoch_seq, excluded_count }
//
// Pure. `epoch` is the active epoch row (or null). With no epoch / no boundary the
// history passes through unfenced (legacy behaviour). With an active epoch, a
// message is KEPT iff its created_at is at or after the boundary; a message with
// no parseable created_at is EXCLUDED while a fence is active (fail closed — never
// leak a message of unknown vintage). Summaries follow the same boundary rule.
export const buildHistoryForMemoryEpoch = ({ history = [], epoch = null } = {}) => {
  const msgs = Array.isArray(history) ? history : [];
  const boundaryMs = epoch?.boundary_at != null ? Date.parse(epoch.boundary_at) : null;

  if (!epoch || !Number.isFinite(boundaryMs)) {
    return { messages: msgs, fenced: false, epoch_seq: epoch?.epoch_seq ?? null, excluded_count: 0 };
  }

  const kept = [];
  let excluded = 0;
  for (const m of msgs) {
    const ms = createdAtMs(m);
    // Fail closed: unknown vintage → excluded. Pre-boundary (incl. summaries) → excluded.
    if (ms == null || ms < boundaryMs) { excluded += 1; continue; }
    // A post-boundary summary is kept only if it is genuinely of this epoch; a
    // summariser that spans the boundary is deferred (§F), so today post-boundary
    // summaries are in-epoch by construction. Keep them.
    void isSummaryMessage;
    kept.push(m);
  }
  return { messages: kept, fenced: true, epoch_seq: epoch.epoch_seq ?? null, excluded_count: excluded };
};

// ── DB half (migration 086) ───────────────────────────────────────────────────

export const memoryHistoryEpochTablePresent = async (client) => {
  if (!client) return false;
  const res = await client.query(
    `select 1 from information_schema.tables where table_name = 'memory_history_epochs' limit 1`
  ).catch(() => ({ rows: [] }));
  return !!res?.rows?.length;
};

// The active (latest) epoch for a tuple, or null. Soft-fails to null (a missing
// table / absent row degrades to "no fence", so a pre-086 DB or an un-canaried
// client keeps full history — never throws inside the owner turn).
export const getActiveMemoryHistoryEpoch = async (client, { firmId, clientId, audience, purpose } = {}) => {
  if (!client || !firmId || !clientId || !audience || !purpose) return null;
  const res = await client.query(
    `select id, tenant_id, client_id, audience, purpose, epoch_seq, mode_entered,
            boundary_at, boundary_message_id, reason, created_at
       from memory_history_epochs
      where tenant_id = $1 and client_id = $2 and audience = $3 and purpose = $4
      order by epoch_seq desc
      limit 1`,
    [firmId, clientId, audience, purpose]
  ).catch(() => ({ rows: [] }));
  const row = res?.rows?.[0];
  if (!row) return null;
  return {
    ...row,
    boundary_at: row.boundary_at ? new Date(row.boundary_at).toISOString() : null,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null
  };
};

// Open a NEW epoch for the tuple (canary entry OR rollback). epoch_seq = prev + 1
// (first fence is 1). Writes one audit_events row so a transition is never silent.
// `boundaryAt` defaults to the DB clock (now()) so the boundary is the transition
// instant; the current + subsequent turns (created after) fall in the new epoch.
export const enterMemoryHistoryEpoch = async (client, {
  firmId, clientId, audience, purpose, modeEntered,
  boundaryMessageId = null, reason = null, actorType = 'system', actorId = null
} = {}) => {
  if (!client || !firmId || !clientId || !audience || !purpose) {
    throw new Error('enterMemoryHistoryEpoch requires client, firmId, clientId, audience, purpose');
  }
  if (!MEMORY_HISTORY_EPOCH_MODES.includes(modeEntered)) {
    throw new Error(`enterMemoryHistoryEpoch: invalid mode_entered '${modeEntered}'`);
  }
  const prev = await client.query(
    `select coalesce(max(epoch_seq), 0) as max_seq
       from memory_history_epochs
      where tenant_id = $1 and client_id = $2 and audience = $3 and purpose = $4`,
    [firmId, clientId, audience, purpose]
  );
  const nextSeq = Number(prev?.rows?.[0]?.max_seq ?? 0) + 1;
  const id = randomUUID();
  await client.query(
    `insert into memory_history_epochs
       (id, tenant_id, client_id, audience, purpose, epoch_seq, mode_entered,
        boundary_at, boundary_message_id, reason, set_by_actor_type, set_by_actor_id)
     values ($1, $2, $3, $4, $5, $6, $7, now(), $8, $9, $10, $11)`,
    [id, firmId, clientId, audience, purpose, nextSeq, modeEntered, boundaryMessageId, reason, actorType, actorId]
  );
  await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
     values ($1, $2, $3, 'memory_history.epoch_opened', 'memory_history_epoch', $4, $5::jsonb)`,
    [firmId, clientId, actorType, id, JSON.stringify({ audience, purpose, epoch_seq: nextSeq, mode_entered: modeEntered, boundary_message_id: boundaryMessageId, reason })]
  );
  return { id, firmId, clientId, audience, purpose, epoch_seq: nextSeq, mode_entered: modeEntered };
};
