// Shared statutory blocker persistence and lifecycle (migration 076).
// Originated in the FI lane; severity, ownership, evidence and audit contracts
// apply equally to every registered statutory surface. No country policy here.
import crypto from 'node:crypto';


// Severity — how bad. legal_violation: producing the artifact would break
// statute (the entity-unsupported refusal). review_required: a human must decide
// before close/submission. informational: surfaced, resolvable without evidence.
export const BLOCKER_SEVERITIES = ['legal_violation', 'review_required', 'informational'];


// Who it rests on — the design's named parties. A blocker always names a human;
// it is never in firm-side limbo AND never rests on nobody.
export const BLOCKER_ASSIGNEES = ['firm', 'client', 'accountant', 'auditor', 'counsel'];


// open → acknowledged → resolved. A re-raised resolved blocker returns to open.
export const BLOCKER_STATUSES = ['open', 'acknowledged', 'resolved'];


// The append-only event vocabulary (pinned to the 076 CHECK by migrations.test.js).
export const BLOCKER_EVENT_TYPES = [
  'minted', 're_raised', 'acknowledged', 'resolved', 'reassigned',
  'severity_changed', 'evidence_attached'
];


// Judgment-carrying severities cannot be resolved without an evidence_ref
// (D-FI13-2 — "resolution without evidence is impossible for judgment-carrying
// blockers"). An informational blocker may resolve on a bare acknowledgement.
export const EVIDENCE_REQUIRED_SEVERITIES = ['legal_violation', 'review_required'];


// Deterministic id: the same obstruction (firm + client + surface + reason +
// period) upserts into the ONE row instead of spamming a new blocker on every
// re-attempt. Client id IS part of the key — a blocker is client-scoped
// governance, never cross-client identity memory (the authority-grant shape, not
// the firm-fact shape). A null period_id is part of the key as the literal
// 'client-scope' so a client-wide blocker and a period-scoped one never collide.
export const buildStatutoryBlockerId = ({ firmId, clientId, surface, reasonCode, periodId = null } = {}) => {
  const hash = crypto
    .createHash('sha256')
    .update([firmId, clientId, surface, reasonCode, periodId || 'client-scope'].join('|'))
    .digest('hex')
    .slice(0, 16);
  const slug = (value) =>
    String(value || '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'unknown';
  return ['stat-blocker', slug(clientId), slug(surface), hash].join('-');
};


// Append one immutable event to a blocker's trail. Best-effort: a failed event
// write must not mask the load-bearing blocker write (same posture as the
// authority store's audit — the mint/transition is what matters). Returns
// nothing; logs a warn on a real (non-pre-migration) failure.
const appendBlockerEvent = async (client, {
  blockerId, firmId, clientId, eventType, actorType = 'system', actorId = null, reason = null, detail = {}
}) => {
  try {
    await client.query(
      `insert into statutory_blocker_events
         (blocker_id, firm_id, client_id, event_type, actor_type, actor_id, reason, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
      [blockerId, firmId, clientId, eventType, actorType, actorId, reason, JSON.stringify(detail || {})]
    );
  } catch (error) {
    if (error?.code !== '42P01' && error?.code !== '42703') {
      console.warn('[statutoryBlocker] event append failed', eventType, error?.message || error);
    }
  }
};


// Mint (or idempotently re-raise) a blocker. A genuine insert records a 'minted'
// event; re-hitting an existing OPEN/ACKNOWLEDGED blocker bumps updated_at and
// records 're_raised'; re-hitting a RESOLVED blocker REOPENS it (the obligation
// is un-met again) and records 're_raised'. Returns { id, inserted, status,
// reopened } or null when a guard rejects the mint / the store predates migration
// 076. Pre-migration soft-fail keeps the caller's refusal load-bearing.
export const mintStatutoryBlocker = async ({
  client,
  firmId,
  clientId,
  surface,
  reasonCode,
  severity,
  assignedTo,
  periodId = null,
  dueDate = null,
  resolutionPath = null,
  evidenceRef = null,
  blockedByBlockerId = null,
  closeAttemptId = null,
  entityType = null,
  detail = {},
  actorType = 'system',
  actorId = null,
  reason = null
} = {}) => {
  if (!client || !firmId || !clientId || !surface || !reasonCode) return null;
  if (!BLOCKER_SEVERITIES.includes(severity)) return null;
  if (!BLOCKER_ASSIGNEES.includes(assignedTo)) return null;

  const id = buildStatutoryBlockerId({ firmId, clientId, surface, reasonCode, periodId });

  let result;
  try {
    result = await client.query(
      `insert into statutory_blockers (
         id, firm_id, client_id, period_id, surface, reason_code, severity,
         assigned_to, status, due_date, resolution_path, evidence_ref,
         blocked_by_blocker_id, close_attempt_id, entity_type, detail
       ) values (
         $1, $2, $3, $4, $5, $6, $7,
         $8, 'open', $9, $10, $11,
         $12, $13, $14, $15::jsonb
       )
       on conflict (id) do update set
         severity = excluded.severity,
         assigned_to = excluded.assigned_to,
         due_date = excluded.due_date,
         resolution_path = excluded.resolution_path,
         blocked_by_blocker_id = excluded.blocked_by_blocker_id,
         close_attempt_id = excluded.close_attempt_id,
         entity_type = excluded.entity_type,
         detail = statutory_blockers.detail || excluded.detail,
         -- A resolved blocker whose condition recurs REOPENS. An open/acknowledged
         -- one keeps its status (a re-raise never silently un-acknowledges a human).
         status = case when statutory_blockers.status = 'resolved' then 'open' else statutory_blockers.status end,
         resolved_at = case when statutory_blockers.status = 'resolved' then null else statutory_blockers.resolved_at end,
         resolved_by = case when statutory_blockers.status = 'resolved' then null else statutory_blockers.resolved_by end,
         updated_at = now()
       returning id, (xmax = 0) as inserted, status,
         (xmax <> 0 and status = 'open') as maybe_reopened`,
      [
        id, firmId, clientId, periodId, surface, reasonCode, severity,
        assignedTo, dueDate, resolutionPath, evidenceRef,
        blockedByBlockerId, closeAttemptId, entityType, JSON.stringify(detail || {})
      ]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }

  const row = result.rows[0] || {};
  const inserted = Boolean(row.inserted);
  await appendBlockerEvent(client, {
    blockerId: id,
    firmId,
    clientId,
    eventType: inserted ? 'minted' : 're_raised',
    actorType,
    actorId,
    reason,
    detail: {
      surface,
      reason_code: reasonCode,
      severity,
      assigned_to: assignedTo,
      ...(entityType ? { entity_type: entityType } : {})
    }
  });

  return {
    id,
    inserted,
    status: row.status || 'open',
    reopened: Boolean(row.maybe_reopened)
  };
};


// Acknowledge an open blocker (a named human has seen it and taken ownership).
// Records an 'acknowledged' event. Returns { id, status } or null.
export const acknowledgeStatutoryBlocker = async ({
  client, firmId, blockerId, actorType, actorId = null, reason = null
} = {}) => {
  if (!client || !firmId || !blockerId || !actorType) return null;
  let result;
  try {
    result = await client.query(
      `update statutory_blockers
          set status = 'acknowledged',
              acknowledged_by = $3,
              acknowledged_at = now(),
              updated_at = now()
        where firm_id = $1 and id = $2 and status = 'open'
        returning id, client_id, status`,
      [firmId, blockerId, actorId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }
  if (!result.rows.length) return null;
  const row = result.rows[0];
  await appendBlockerEvent(client, {
    blockerId, firmId, clientId: row.client_id, eventType: 'acknowledged', actorType, actorId, reason
  });
  return { id: blockerId, status: row.status };
};


// Resolve a blocker. A judgment-carrying blocker (legal_violation /
// review_required) CANNOT resolve without an evidence_ref — the resolution is
// refused (returns null) rather than silently completed. informational may
// resolve on a bare acknowledgement. Records a 'resolved' event.
export const resolveStatutoryBlocker = async ({
  client, firmId, blockerId, actorType, actorId = null, evidenceRef = null, reason = null
} = {}) => {
  if (!client || !firmId || !blockerId || !actorType) return null;

  // Read the severity first so the evidence rule keys on the STORED severity, not
  // a caller-supplied one (a caller must not be able to downgrade to skip evidence).
  let existing;
  try {
    existing = await client.query(
      `select severity, evidence_ref, status, client_id from statutory_blockers where firm_id = $1 and id = $2 limit 1`,
      [firmId, blockerId]
    );
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return null;
    throw error;
  }
  const current = existing.rows[0];
  if (!current || current.status === 'resolved') return null;

  const effectiveEvidence = evidenceRef || current.evidence_ref || null;
  if (EVIDENCE_REQUIRED_SEVERITIES.includes(current.severity) && !effectiveEvidence) {
    // Refuse: a judgment-carrying blocker needs evidence to close. The caller
    // gets null and the blocker stays open, resting on its named party.
    return { id: blockerId, resolved: false, reason: 'evidence_required' };
  }

  const result = await client.query(
    `update statutory_blockers
        set status = 'resolved',
            evidence_ref = coalesce($3, evidence_ref),
            resolved_by = $4,
            resolved_at = now(),
            updated_at = now()
      where firm_id = $1 and id = $2 and status <> 'resolved'
      returning id, client_id, status`,
    [firmId, blockerId, evidenceRef, actorId]
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  await appendBlockerEvent(client, {
    blockerId, firmId, clientId: row.client_id, eventType: 'resolved', actorType, actorId, reason,
    detail: effectiveEvidence ? { evidence_ref: effectiveEvidence } : {}
  });
  return { id: blockerId, resolved: true, status: row.status };
};


// Load a client's LIVE blockers (open + acknowledged) — the surface for the
// close checklist, the owner action queue, and the firm queue. Resolved blockers
// are excluded. Pre-migration soft-fail (42P01/42703 → []).
export const loadOpenStatutoryBlockers = async ({ client, firmId, clientId, surface = null } = {}) => {
  if (!client || !firmId || !clientId) return [];
  try {
    const params = [firmId, clientId];
    let sql =
      `select * from statutory_blockers
        where firm_id = $1 and client_id = $2 and status in ('open', 'acknowledged')`;
    if (surface) {
      params.push(surface);
      sql += ` and surface = $3`;
    }
    sql += ` order by created_at desc`;
    const result = await client.query(sql, params);
    return result.rows || [];
  } catch (error) {
    if (error?.code === '42P01' || error?.code === '42703') return [];
    throw error;
  }
};
