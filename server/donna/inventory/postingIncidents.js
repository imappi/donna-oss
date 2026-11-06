// Donna Inventory I4·posting — P7 §12 incident records (the PURE builder + lifecycle, D-POST-14).
//
// The waiter-drain planner (postingWaiters.js) decides WHAT should happen to a stuck posting; two
// of its dispositions demand a DURABLE ops record: open_incident (an engineering-incident waiter
// "opens an actual incident record — not a log line — with an owning path") and escalate (an
// exhausted integration retry hands off to a named human queue). This module is the PURE half of
// that recording: the closed vocabularies migration 084's CHECKs pin to, the plan → insertable-
// record mapping, and the guarded status transitions. No DB, no I/O, no Date.now/Math.random/
// new Date. The writer that persists the records is postingIncidentDb.js.
//
// KEEP-LAYER: deterministic routing/lifecycle arithmetic — it substitutes for no model judgment,
// it just refuses to let an incident exist without an owning queue or vanish without a resolver.

// WHY a record exists (migration 084 CHECK): an engineering-incident waiter, or an integration
// retry that exhausted its bounded backoff schedule.
export const INVENTORY_INCIDENT_KINDS = Object.freeze(['engineering_incident', 'retry_exhausted']);

// The closed lifecycle (migration 084 CHECK): open → acknowledged → resolved. Resolved is TERMINAL
// (kept as history; the natural key frees for a genuine recurrence). Nothing is deleted or skips
// straight out of existence — two-terminal-states applied to the ops queue.
export const INVENTORY_INCIDENT_STATUSES = Object.freeze(['open', 'acknowledged', 'resolved']);

// The planner dispositions that open a durable record. retry/wait are the executor's business
// (a later isolation-class slice); human_owned already rests visibly owned on the attempts row.
export const INCIDENT_OPENING_DISPOSITIONS = Object.freeze(['open_incident', 'escalate']);

const DISPOSITION_TO_KIND = Object.freeze({
  open_incident: 'engineering_incident',
  escalate: 'retry_exhausted'
});

// The guarded lifecycle edges: open → acknowledged, open → resolved, acknowledged → resolved.
// Never backwards, never out of 'resolved' (terminal).
export const canTransitionIncidentStatus = (from, to) => {
  if (from === 'open') return to === 'acknowledged' || to === 'resolved';
  if (from === 'acknowledged') return to === 'resolved';
  return false;
};

// buildIncidentRecordFromPlan — map ONE waiter-drain plan (planWaiterDisposition's shape) to an
// insertable migration-084 record, or null when the disposition opens nothing. Throws on an
// incident-opening plan that lacks its (operation, kind) identity — an incident that can't dedupe
// or be traced is a bug to surface, never a row to guess.
export const buildIncidentRecordFromPlan = (plan = {}) => {
  const kind = DISPOSITION_TO_KIND[plan.disposition];
  if (!kind) return null;
  const operationId = plan.operation_id ?? plan.operationId ?? null;
  const postingKind = plan.posting_kind ?? plan.postingKind ?? null;
  if (!operationId || !postingKind) {
    throw new Error(`incident-opening plan (${plan.disposition}) is missing operation_id/posting_kind`);
  }
  if (!plan.target_queue) {
    throw new Error(`incident-opening plan (${plan.disposition}) has no target_queue — an incident must be owned`);
  }
  return {
    operation_id: operationId,
    posting_kind: postingKind,
    incident_kind: kind,
    reason_code: plan.reason ?? plan.reason_code ?? null,
    condition: plan.condition ?? null,
    waiter_type: plan.waiter_type ?? null,
    target_queue: plan.target_queue,
    retries_used: plan.retries_used ?? null,
    retries_max: plan.retries_max ?? null,
    source_attempt_id: plan.attempt_id ?? plan.source_attempt_id ?? null
  };
};

// buildIncidentRecordsFromPlans — map a drain plan batch to its insertable records, counting the
// dispositions that (correctly) open nothing. PURE; the DB write is postingIncidentDb.js.
export const buildIncidentRecordsFromPlans = (plans = []) => {
  const records = [];
  let ignored = 0;
  for (const plan of Array.isArray(plans) ? plans : []) {
    const record = buildIncidentRecordFromPlan(plan);
    if (record) records.push(record);
    else ignored += 1;
  }
  return { records, ignored };
};
