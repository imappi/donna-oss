// Donna Inventory I4·posting — P7 §12 incident records (the WRITER, D-POST-14).
//
// Consumes the waiter-drain planner's open_incident / escalate dispositions (postingWaiterDb.js →
// postingWaiters.js) and records them durably in inventory_posting_incidents (migration 084) —
// the "actual incident record with an owning path" §12 demands, plus the guarded acknowledge /
// resolve lifecycle and the ops-queue reader. This writes ONLY the new ops table: nothing here
// posts a journal, appends to the attempts log, or touches the heads projection — the waiter head
// stays open until a later attempt supersedes it, and re-draining dedupes against the table's
// natural key (ON CONFLICT DO NOTHING on the partial unique index).
//
// Failure posture is split on purpose:
//   - The WRITER fails LOUDLY pre-migration (no 42P01 degrade): silently dropping an incident is
//     exactly the dead-end D-POST-14 exists to prevent — nothing silent.
//   - The READER degrades to empty pre-migration (mirror postingWaiterDb): nothing recorded yet is
//     an honest empty queue, not an error.
// Timestamps come from SQL now() (no Date.now in code); the drain clock stays caller-injected.

import { buildIncidentRecordsFromPlans } from './postingIncidents.js';
import { planInventoryWaiterDrain } from './postingWaiterDb.js';

const isMissingRelation = (error) => error?.code === '42P01' || error?.code === '42703';

// Insert ONE incident record; returns the inserted row, or null when an open/acknowledged incident
// with the same natural key already exists (deduped — re-draining is idempotent).
export const insertInventoryPostingIncident = async (client, firmId, clientId, record, actorId) => {
  const res = await client.query(
    `insert into inventory_posting_incidents
       (firm_id, client_id, operation_id, posting_kind, incident_kind, reason_code, condition,
        waiter_type, target_queue, retries_used, retries_max, source_attempt_id, opened_by_actor_id, detail)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict do nothing
     returning *`,
    [
      firmId, clientId, record.operation_id, record.posting_kind, record.incident_kind,
      record.reason_code ?? null, record.condition ?? null, record.waiter_type ?? null,
      record.target_queue, record.retries_used ?? null, record.retries_max ?? null,
      record.source_attempt_id ?? null, actorId, JSON.stringify(record.detail ?? {})
    ]
  );
  return res.rows?.[0] ?? null;
};

// recordInventoryPostingIncidents — persist the incident-opening dispositions of a drain plan.
// Idempotent per natural key: re-running against the same open plan opens nothing new. Returns
// { opened, deduped, ignored } — opened = the rows actually inserted this call; deduped = already
// open/acknowledged; ignored = plans whose disposition correctly opens nothing (retry/wait/
// human_owned). Throws pre-migration (084 absent) — an unrecordable incident is a loud failure.
export const recordInventoryPostingIncidents = async ({ client, firmId, clientId, plans = [], actorId } = {}) => {
  if (!client || !firmId || !clientId || !actorId) {
    throw new Error('recordInventoryPostingIncidents requires client, firmId, clientId, actorId');
  }
  const { records, ignored } = buildIncidentRecordsFromPlans(plans);
  const opened = [];
  let deduped = 0;
  for (const record of records) {
    const row = await insertInventoryPostingIncident(client, firmId, clientId, record, actorId);
    if (row) opened.push(row);
    else deduped += 1;
  }
  return { opened, deduped, ignored, total: records.length };
};

// recordInventoryWaiterDrainIncidents — the end-to-end §12 drain-and-record: plan the current
// waiter drain (READ-ONLY) and durably record its open_incident / escalate dispositions. The
// retry/wait dispositions are returned in the plan but NOT acted on here — the re-post is an
// isolation-class slice behind its own GO. `now` is injected (the caller owns the clock).
export const recordInventoryWaiterDrainIncidents = async ({ client, firmId, clientId, actorId, now = null, backoffMs = undefined } = {}) => {
  const plan = await planInventoryWaiterDrain({
    client, firmId, clientId, now, ...(backoffMs !== undefined ? { backoffMs } : {})
  });
  const recorded = await recordInventoryPostingIncidents({ client, firmId, clientId, plans: plan.plans, actorId });
  return { plan, ...recorded };
};

// acknowledgeInventoryPostingIncident — open → acknowledged, guarded in SQL (the WHERE enforces
// the same edge canTransitionIncidentStatus allows). Returns the updated row, or null when the
// incident is missing / not open (no silent re-acknowledge of a resolved incident).
export const acknowledgeInventoryPostingIncident = async ({ client, firmId, clientId, incidentId, actorId } = {}) => {
  if (!client || !firmId || !clientId || !incidentId || !actorId) {
    throw new Error('acknowledgeInventoryPostingIncident requires client, firmId, clientId, incidentId, actorId');
  }
  const res = await client.query(
    `update inventory_posting_incidents
        set status = 'acknowledged', acknowledged_by_actor_id = $4, acknowledged_at = now(), updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status = 'open'
      returning *`,
    [firmId, clientId, incidentId, actorId]
  );
  return res.rows?.[0] ?? null;
};

// resolveInventoryPostingIncident — open|acknowledged → resolved (terminal), with the resolving
// actor + timestamp the 084 CHECK requires. Returns the updated row, or null when missing /
// already resolved.
export const resolveInventoryPostingIncident = async ({ client, firmId, clientId, incidentId, actorId, note = null } = {}) => {
  if (!client || !firmId || !clientId || !incidentId || !actorId) {
    throw new Error('resolveInventoryPostingIncident requires client, firmId, clientId, incidentId, actorId');
  }
  const res = await client.query(
    `update inventory_posting_incidents
        set status = 'resolved', resolved_by_actor_id = $4, resolved_at = now(), resolution_note = $5, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status in ('open', 'acknowledged')
      returning *`,
    [firmId, clientId, incidentId, actorId, note]
  );
  return res.rows?.[0] ?? null;
};

// listOpenInventoryPostingIncidents — the ops-queue read: unresolved incidents, oldest first.
// Degrades to empty pre-migration (084 absent) — an honest empty queue. READ-ONLY.
export const listOpenInventoryPostingIncidents = async (client, firmId, clientId) => {
  try {
    const res = await client.query(
      `select * from inventory_posting_incidents
        where firm_id = $1 and client_id = $2 and status in ('open', 'acknowledged')
        order by created_at asc, id asc`,
      [firmId, clientId]
    );
    return res.rows || [];
  } catch (error) {
    if (isMissingRelation(error)) return [];
    throw error;
  }
};
