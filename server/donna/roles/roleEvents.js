// Donna — cross-role events + narration substrate (S5 of
// docs/design-donna-specialist-roles.md §5).
//
// INV-S5 (events, not chatter): cross-specialist awareness is SHARED PERSISTED
// STATE plus TYPED EVENTS with receipts. There is NO LLM-to-LLM message
// channel — this module is that law made executable. A role event is a closed,
// validated attribution record of work crossing an ownership boundary on the
// §1 work-attribution shape (`responsible_role · current_actor ·
// next_commitment`), never a message: the shape is a strict field allowlist,
// so a "message to Clara" cannot even be expressed. The UI narrates these
// events as teamwork (src/lib/teamRosterView.js narrateTeamworkEvent); the
// narration renders the event, it is never the mechanism.
//
// Two halves, both over EXISTING stores (INV-S4 — no new store):
//   - the RECEIPT: an audit_events row (action = the event type, the same
//     pattern as roleEmployment's role.hired family), written in the caller's
//     transaction beside the state change it attributes;
//   - the TRIGGER: a typed loop_event_inbox row through the same
//     insertLoopEvent path every loop producer uses, registered in
//     loopEventRegistry.js (parked until a role-lane LoopDefinition
//     subscribes). The Team narration reads the receipts and never drains the
//     queue; the queue exists so a future role loop can wake on handoffs
//     without a new channel being invented.
//
// The only v1 producer is the outbound (R1 / invoicing_collections) lane —
// the one lane with live role traffic. Producers live at the STORE WRITERS
// (actionStore.js mint/hold/approve/cancel + the executor's cadence
// escalation), so every surface that moves work across the role↔owner
// boundary emits the event — no per-surface wiring to forget. Role↔role
// events gain their producers when a second lane ships verbs; the vocabulary
// and shape law here already govern them.
//
// The hired-only law (the S4 tag law, applied to events): an event is
// recorded ONLY when the action's lane belongs to a role that is ACTIVELY
// HIRED on the client. Donna-core work (unclaimed verbs, un-hired roles) is
// never narrated as a teammate — a team that is not hired must not be implied
// (the S4 "never invent a teammate" law).
//
// Failure posture: savepoint-guarded and soft (the earnedAutoLadder pattern).
// A narration/awareness receipt must never break an owner's approval or the
// executor's sweep — the transition's OWN receipt (outbound_action.approved,
// held_at_send, …) is the authorization record; this event is attribution on
// top. Under-narrating on failure is safe; blocking the books is not.

import { randomUUID } from 'node:crypto';

import { findRoleDefinition, roleForActionIdentity } from './roleRegistry.js';
import { readActiveSpecialistAssignment } from './roleEmployment.js';
import { insertLoopEvent } from '../loopEventInbox.js';

// ── The closed vocabulary ───────────────────────────────────────────────────

export const ROLE_EVENT_TYPES = Object.freeze({
  handedToOwner: 'role.handed_to_owner',
  resumedFromOwner: 'role.resumed_from_owner'
});

export const ROLE_EVENT_TYPE_LIST = Object.freeze(Object.values(ROLE_EVENT_TYPES));

// Who holds the next move. 'owner' is the human principal; the occupant kinds
// mirror the RoleAssignment substrate (§12 — humans occupy the same roles).
export const ROLE_EVENT_ACTORS = Object.freeze(['owner', 'ai_occupant', 'human_occupant']);

// What happens next — typed, never freeform (INV-S8: a tracked continuation
// has a named next action; narration templates key off these).
export const ROLE_EVENT_NEXT_COMMITMENTS = Object.freeze([
  'approve_or_decline_send',      // a send rests on the owner's approval
  'decide_collection_next_step',  // cadence exhausted — the owner's call
  'send_on_next_sweep',           // approved — the role's lane resumes
  'closed'                        // declined/withdrawn — the item terminated
]);

// How a held item left the owner's queue.
export const ROLE_EVENT_OUTCOMES = Object.freeze(['approved', 'declined', 'withdrawn']);

// The INV-S5 shape law: the event is a strict field ALLOWLIST. There is no
// message, body, text, prompt, or addressee field — typed attribution only.
// Any key outside this list refuses validation, so a conversational payload
// cannot ride an event even by accident.
export const ROLE_EVENT_FIELDS = Object.freeze([
  'type', 'responsible_role', 'current_actor', 'next_commitment',
  'action_type', 'object_type', 'object_id', 'occupant', 'outcome', 'reasons'
]);

const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

// Returns an array of problem strings; empty = valid.
export const validateRoleEvent = (event) => {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return ['event must be an object'];
  }
  const problems = [];
  const unknown = Object.keys(event).filter((key) => !ROLE_EVENT_FIELDS.includes(key));
  if (unknown.length) {
    problems.push(
      `unknown field(s) ${unknown.join(', ')} — the role-event shape is closed `
      + '(INV-S5: typed attribution, never a message)'
    );
  }
  if (!ROLE_EVENT_TYPE_LIST.includes(event.type)) problems.push(`unknown type '${event.type}'`);
  if (!findRoleDefinition(event.responsible_role)) {
    problems.push(`responsible_role '${event.responsible_role}' is not a registry role`);
  }
  if (!ROLE_EVENT_ACTORS.includes(event.current_actor)) {
    problems.push(`bad current_actor '${event.current_actor}'`);
  }
  if (!ROLE_EVENT_NEXT_COMMITMENTS.includes(event.next_commitment)) {
    problems.push(`bad next_commitment '${event.next_commitment}'`);
  }
  if (!isNonEmptyString(event.action_type)) problems.push('missing action_type');
  if (!isNonEmptyString(event.object_type)) problems.push('missing object_type');
  if (!isNonEmptyString(event.object_id)) problems.push('missing object_id');
  const occ = event.occupant;
  if (!occ || typeof occ !== 'object'
    || !isNonEmptyString(occ.principal_type) || !isNonEmptyString(occ.principal_id)) {
    problems.push('occupant requires principal_type + principal_id');
  }
  if (event.type === ROLE_EVENT_TYPES.resumedFromOwner) {
    if (!ROLE_EVENT_OUTCOMES.includes(event.outcome)) {
      problems.push(`resumed_from_owner requires an outcome from [${ROLE_EVENT_OUTCOMES.join(', ')}]`);
    }
  } else if (event.outcome != null) {
    problems.push('handed_to_owner carries no outcome');
  }
  if (!Array.isArray(event.reasons) || !event.reasons.every(isNonEmptyString)) {
    problems.push('reasons must be a list of strings');
  }
  return problems;
};

// Savepoint guard (the earnedAutoLadder `guarded` pattern): run under a
// savepoint when a transaction is open, plain otherwise; any failure rolls
// back to the savepoint and reports soft — the caller's transaction stays
// healthy.
const guarded = async (client, name, fn, warn) => {
  let savepointed = false;
  try {
    await client.query(`savepoint ${name}`);
    savepointed = true;
  } catch { savepointed = false; }
  try {
    const result = await fn();
    if (savepointed) await client.query(`release savepoint ${name}`);
    return result;
  } catch (error) {
    if (savepointed) {
      try { await client.query(`rollback to savepoint ${name}`); } catch { /* best-effort */ }
    }
    try { warn?.(`[roleEvents] role event skipped: ${error?.message || error}`); } catch { /* never throw */ }
    return { recorded: false, reason: 'role_event_failed' };
  }
};

// ── The v1 producer: outbound role↔owner transitions ────────────────────────
// Called by the outbound store writers (mint-at-hold, hold-at-send,
// approve, decline/withdraw) and the executor's cadence escalation — inside
// the SAME transaction as the transition they attribute.
//
// transition 'handed_to_owner'   → the item came to rest on the owner;
// transition 'resumed_from_owner' → the owner decided (approved/declined) or
//                                   Donna withdrew the held item.
// Returns { recorded, ... } and never throws for runtime conditions — an
// unclaimed verb or an un-hired role is a clean no-op, a DB failure is a
// warned soft skip. Only a caller-side programming error (unknown transition)
// throws.
export const recordOutboundRoleTransition = async (client, {
  firmId, clientId, action,
  transition, outcome = null, reasons = [], nextCommitment = null,
  actorType = 'system', actorId = null, warn = null
} = {}) => {
  if (!client || !firmId || !clientId || !action?.id || !action?.action_type) {
    return { recorded: false, reason: 'missing_args' };
  }
  if (!['handed_to_owner', 'resumed_from_owner'].includes(transition)) {
    throw new Error(`recordOutboundRoleTransition: unknown transition '${transition}'`);
  }
  // Attribution is by action_set claim (the S1 law): an unclaimed type runs
  // on Donna core's own surface and is never narrated as a teammate.
  const roleId = roleForActionIdentity(action.action_type);
  if (!roleId) return { recorded: false, reason: 'unclaimed_action_type' };

  return guarded(client, 'role_event', async () => {
    // Hired-only (the S4 tag law): no active occupant, no event.
    const assignment = await readActiveSpecialistAssignment(client, { firmId, clientId, roleId });
    if (!assignment) return { recorded: false, reason: 'role_not_hired' };

    const handed = transition === 'handed_to_owner';
    const event = {
      type: handed ? ROLE_EVENT_TYPES.handedToOwner : ROLE_EVENT_TYPES.resumedFromOwner,
      responsible_role: roleId,
      current_actor: handed
        ? 'owner'
        : assignment.principal_type === 'ai_occupant' ? 'ai_occupant' : 'human_occupant',
      next_commitment: nextCommitment
        || (handed ? 'approve_or_decline_send'
          : outcome === 'approved' ? 'send_on_next_sweep' : 'closed'),
      action_type: action.action_type,
      object_type: 'outbound_action',
      object_id: String(action.id),
      occupant: {
        principal_type: assignment.principal_type,
        principal_id: assignment.principal_id,
        ai_profile: assignment.ai_profile ?? null
      },
      outcome: handed ? null : outcome,
      reasons: (reasons || []).map((r) => String(r))
    };
    const problems = validateRoleEvent(event);
    if (problems.length) {
      try { warn?.(`[roleEvents] invalid role event refused: ${problems.join('; ')}`); } catch { /* never throw */ }
      return { recorded: false, reason: 'invalid_event', problems };
    }

    // The receipt: one audit row, the role_event_id linking it to the trigger.
    const roleEventId = `role-event-${randomUUID()}`;
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, $3, $4, $5, 'outbound_action', $6, $7::jsonb)`,
      [firmId, clientId, actorType, actorId, event.type, String(action.id),
        JSON.stringify({ role_event_id: roleEventId, ...event })]
    );

    // The trigger: a typed inbox row through the one loop-event path. Literal
    // eventType per branch on purpose — the loopEventRegistry static scan
    // reads these call sites, so a new type cannot ship unregistered.
    if (handed) {
      await insertLoopEvent({
        client, firmId, clientId,
        source: 'role_events', sourceEventId: roleEventId,
        eventType: 'role.handed_to_owner',
        objectType: 'outbound_action', objectId: String(action.id),
        payload: { role_event_id: roleEventId, ...event }
      });
    } else {
      await insertLoopEvent({
        client, firmId, clientId,
        source: 'role_events', sourceEventId: roleEventId,
        eventType: 'role.resumed_from_owner',
        objectType: 'outbound_action', objectId: String(action.id),
        payload: { role_event_id: roleEventId, ...event }
      });
    }
    return { recorded: true, role_event_id: roleEventId, type: event.type };
  }, warn);
};

// ── The narration read ──────────────────────────────────────────────────────
// Renders FROM the receipts (render-the-persisted-verdict): the newest role
// events for a client, shaped for the deterministic narration view-model.
// Deliberately not the queue — a read must never drain or race the worker.
export const readRoleTeamwork = async (client, { firmId, clientId, limit = 12 } = {}) => {
  if (!client || !firmId || !clientId) return [];
  const bounded = Math.min(Math.max(Number(limit) || 12, 1), 50);
  const { rows } = await client.query(
    `select id, action, actor_type, actor_id, metadata, created_at
       from audit_events
      where firm_id = $1 and client_id = $2 and action = any($3::text[])
      order by created_at desc, id desc
      limit $4`,
    [firmId, clientId, [...ROLE_EVENT_TYPE_LIST], bounded]
  );
  return rows.map((row) => ({
    ...(row.metadata || {}),
    id: String(row.id),
    type: row.action,
    at: row.created_at,
    actor_type: row.actor_type || null
  }));
};
