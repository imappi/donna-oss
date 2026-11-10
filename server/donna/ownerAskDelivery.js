// Donna — the ONE gate in front of every message to a business owner, and the
// ONE place that decides where an ask rests when a send could not reach anyone.
//
// Owner messages are the most dangerous surface in the system. Before this
// module the client-level gates (pilot send containment and entity-readiness
// admission at 'ask_send') lived inside the ask-batch send and, as a copy, in
// the re-ask sweep; the evidence-topic reminder sweep, the operator resend and
// every other caller of the channel fan-out sent without them. Now:
//
//   • evaluateOwnerSendGateWithClient is the one decision. The first send
//     (db/asks.js __sendClientAskBatchWithClient) calls it under its batch lock
//     before committing; the channel fan-out (deliverEvidenceAsksOnAllChannels)
//     calls it before any deliverer runs, so every fan-out caller — the first
//     send, the re-ask sweep, the operator resend, the firm-chat asks, a
//     rejection follow-up, a clarification follow-up — is gated by the same
//     answer; the re-ask and evidence-topic sweeps call it once per client
//     before choosing what to send.
//   • gateOwnerSendWithClient records a refusal as a visible receipt
//     ('evidence_request.send_refused'), so a held message is explicable to the
//     operator from the audit trail, never a silent drop.
//   • deliverOwnerFollowUpWithClient is the re-ask sweep's precedent for a
//     follow-up the system owes the owner (a rejected-evidence follow-up, a
//     clarification): one fan-out; only a deliverer moves the send stamps;
//     refused ⇒ nothing sent or counted, the ask stays open on the owner; not
//     delivered but a customer-side person can see it in the portal ⇒ it stays
//     with the owner there; nobody reachable ⇒ escalated to the firm
//     ('owner_unreachable') at once, never left to age invisibly.
//
// Keep-layer plumbing only: no model call, no rewording of any question.

import { openOrFindCase, openBlocker, loopsTablesPresent } from './caseManager.js';
import { readInternalPilotSendContainmentWithClient } from './internalPilotAccess.js';
import { evaluateEntityReadinessAdmissionWithClient } from './runtimeReadinessAdmission.js';

export const INTERNAL_PILOT_SEND_DISABLED = 'INTERNAL_PILOT_SEND_DISABLED';
export const ENTITY_READINESS_REFUSED = 'ENTITY_READINESS_REFUSED';
export const SEND_GATE_UNREADABLE = 'SEND_GATE_UNREADABLE';
export const OWNER_SEND_REFUSED_ACTION = 'evidence_request.send_refused';

// The statuses in which an ask is still waiting on the owner: a never-sent
// draft (its first genuine send opens it) or an open question. Anything else
// (replied, resolved, cancelled, merged away) is not to be sent again.
export const AWAITING_OWNER_STATUSES = Object.freeze(['draft', 'open']);

// A re-ask step that reached the owner only as a question waiting in the portal
// (askReaskCadence.js). It is not a delivery, so it never moves send_count; the
// sweep records it here (ISO timestamps, oldest first) and counts it toward the
// escalation bound alongside the delivered sends.
export const portalRemindersOf = (row) => (Array.isArray(row?.request_payload?.portal_reminders)
  ? row.request_payload.portal_reminders.filter((at) => typeof at === 'string' && at)
  : []);

// The client-level decision. `{ allowed: true }`, or `{ allowed: false, code,
// admission?, error? }`. Fail closed: an unreadable gate is a refusal, never a
// send (the caller that must surface the raw error — the first send, inside its
// transaction — reads `error`).
export const evaluateOwnerSendGateWithClient = async ({ client, firmId, clientId, lock = false, deps = {} } = {}) => {
  const readContainment = deps.readSendContainment || readInternalPilotSendContainmentWithClient;
  const evaluateAdmission = deps.evaluateAdmission || evaluateEntityReadinessAdmissionWithClient;
  try {
    if ((await readContainment(client, { firmId, clientId }))?.contained) {
      return { allowed: false, code: INTERNAL_PILOT_SEND_DISABLED };
    }
    const admission = await evaluateAdmission({ client, firmId, clientId, boundary: 'ask_send', lock });
    if (admission && admission.allowed === false) {
      return { allowed: false, code: admission.reason_code || ENTITY_READINESS_REFUSED, admission };
    }
    return { allowed: true };
  } catch (error) {
    return { allowed: false, code: SEND_GATE_UNREADABLE, error };
  }
};

const uniqueIds = (ids) => [...new Set((Array.isArray(ids) ? ids : []).filter(Boolean).map(String))];

// Best-effort operator-visible receipt of a refusal. Never throws: the refusal
// itself (nothing sent, nothing counted) is the invariant; this is its trail.
export const recordOwnerSendRefusalWithClient = async ({
  client, firmId, clientId, gate, surface, evidenceRequestIds = [], actorId = 'owner_send_gate'
} = {}) => {
  if (!client || !firmId || !clientId || !gate || gate.allowed) return false;
  try {
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, $4, 'client', $2, $5::jsonb)`,
      [firmId, clientId, actorId, OWNER_SEND_REFUSED_ACTION, JSON.stringify({
        code: gate.code,
        surface: surface || null,
        evidence_request_ids: uniqueIds(evidenceRequestIds),
        ...(gate.admission ? {
          boundary: 'ask_send',
          responsible_system: gate.admission.responsible_system || null,
          retryable: gate.admission.retryable !== false
        } : {}),
        ...(gate.error ? { error: String(gate.error?.message || gate.error).slice(0, 300) } : {})
      })]
    );
    return true;
  } catch {
    return false;
  }
};

// The gate as every sender outside the first send uses it: decide, and when
// refused leave the receipt.
export const gateOwnerSendWithClient = async ({
  client, firmId, clientId, surface, evidenceRequestIds = [], deps = {}
} = {}) => {
  const gate = await evaluateOwnerSendGateWithClient({ client, firmId, clientId, lock: false, deps });
  if (!gate.allowed) {
    await recordOwnerSendRefusalWithClient({ client, firmId, clientId, gate, surface, evidenceRequestIds });
  }
  return gate;
};

// A customer-side person who can see the ask in the portal: an active,
// signed-in, client-scoped owner with a live capability assignment to this
// client (the same principal shape owner provisioning and the hosted pilot
// require). Fail-closed: a read error means "not visible".
const PORTAL_RECIPIENT_SQL = `
  select 1
    from firm_collaborators fc
    join client_assignments ca
      on ca.firm_id = fc.firm_id
     and ca.principal_type = 'firm_collaborator'
     and ca.principal_id = fc.id
   where fc.firm_id = $1
     and ca.client_id = $2
     and fc.role = 'owner'
     and fc.seat_role is null
     and fc.status = 'active'
     and fc.access_level = 'client_scoped'
     and fc.user_id is not null
     and (fc.ends_at is null or fc.ends_at > now())
     and ca.assignment_kind = 'capability'
     and ca.status = 'active'
     and (ca.starts_at is null or ca.starts_at <= now())
     and (ca.ends_at is null or ca.ends_at > now())
   limit 1`;

export const hasPortalRecipientWithClient = async (client, { firmId, clientId }) => {
  try {
    const res = await client.query(PORTAL_RECIPIENT_SQL, [firmId, clientId]);
    return (res.rows || []).length > 0;
  } catch {
    return false;
  }
};

// Best-effort firm-queue surface: a firm-owned blocker on the request's
// evidence case (openOrFindCase dedupes; openBlocker records the named
// exception). Never throws — the escalation receipt on the request row +
// audit event are the durable record; the case blocker is the queue surface.
const openFirmEscalationBlocker = async (client, { firmId, clientId, request, reason }) => {
  try {
    if (!(await loopsTablesPresent(client))) return false;
    const kase = await openOrFindCase({
      client, firmId, clientId, caseType: 'evidence',
      primaryObject: { type: 'client_evidence_request', id: request.id },
      title: request.question ? String(request.question).slice(0, 200) : null,
      summary: 'Client evidence requested.'
    });
    if (!kase) return false;
    // blocker_type is a CLOSED enum (033 CHECK): the missing client answer is
    // still the blocker — what changed is WHO owns chasing it (ownerType
    // 'firm', distinct from the client-owned blocker openEvidenceCase minted,
    // so openBlocker's dedupe treats it as the escalation row it is). The
    // named exception rides in `reason`.
    await openBlocker({
      client, firmId, clientId, caseId: kase.id,
      blockerType: 'missing_client_answer', ownerType: 'firm',
      objectType: 'client_evidence_request', objectId: request.id,
      reason: reason === 'owner_unreachable'
        ? 'owner_unreachable: no channel delivered and nobody can see the question in the portal; escalated to the firm queue.'
        : `owner_unresponsive: no answer after ${request.send_count} sends${portalRemindersOf(request).length
          ? ` and ${portalRemindersOf(request).length} portal reminders` : ''}; escalated to the firm queue.`
    });
    return true;
  } catch {
    return false;
  }
};

// ESCALATE — stop the re-ask clock (due_at null) and hand the named exception
// to the firm. The request keeps its status (the owner can still answer; the
// reply legs resolve it), but its resting place is now the firm's queue. One
// transaction; the case blocker is post-commit and best-effort. The caller
// holds no open transaction.
export const escalateAskToFirmWithClient = async (client, { firmId, clientId, row, nowIso, reason }) => {
  const sendCount = Number(row.send_count || 0);
  const portalReminderCount = portalRemindersOf(row).length;
  const escalation = {
    at: nowIso,
    reason,
    send_count: sendCount,
    ...(portalReminderCount ? { portal_reminder_count: portalReminderCount } : {}),
    first_sent_at: row.first_sent_at ? new Date(row.first_sent_at).toISOString() : null
  };
  await client.query('begin');
  try {
    await client.query(
      `update client_evidence_requests
          set request_payload = request_payload || $3::jsonb,
              due_at = null,
              updated_at = now()
        where firm_id = $1 and id = $2 and status in ('draft', 'open')
          and coalesce(request_payload->>'escalated_to_firm', '') = ''`,
      [firmId, row.id, JSON.stringify({ escalated_to_firm: escalation })]
    );
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', 'evidence_request.escalated_to_firm', 'client_evidence_request', $3, $4::jsonb)`,
      [firmId, clientId, row.id, JSON.stringify({
        transaction_id: row.transaction_id || null,
        ...escalation
      })]
    );
    await client.query('commit');
  } catch (error) {
    try { await client.query('rollback'); } catch { /* best-effort */ }
    throw error;
  }
  await openFirmEscalationBlocker(client, { firmId, clientId, request: row, reason });
};

const defaultDeliver = async (args) => {
  const { deliverEvidenceAsksOnAllChannels } = await import('./db/asks.js');
  return deliverEvidenceAsksOnAllChannels(args);
};

const readAskStates = async (client, { firmId, clientId, ids }) => {
  const res = await client.query(
    `select id, status, send_count, first_sent_at, transaction_id, question, request_payload
       from client_evidence_requests
      where firm_id = $1 and client_id = $2 and id = any($3::text[])`,
    [firmId, clientId, ids]
  );
  return new Map((res.rows || []).map((row) => [row.id, row]));
};

// Deliver a follow-up question the system owes the owner (the re-ask sweep's
// precedent; see the header). Runs OUTSIDE any transaction: the fan-out is a
// network side effect. Returns { delivered, portal, escalated, held, skipped,
// refused?, channel_fanout } (ask-id arrays). Never throws for a delivery
// failure — the outcome is what it reports.
export const deliverOwnerFollowUpWithClient = async ({
  client, firmId, clientId, evidenceRequestIds = [], surface = 'owner_follow_up',
  nowIso = new Date().toISOString(), deliver = defaultDeliver, deps
} = {}) => {
  const ids = uniqueIds(evidenceRequestIds);
  const out = { delivered: [], portal: [], escalated: [], held: [], skipped: [] };
  if (!client || !firmId || !clientId || !ids.length) return out;
  const before = await readAskStates(client, { firmId, clientId, ids });
  const waiting = ids.filter((id) => AWAITING_OWNER_STATUSES.includes(before.get(id)?.status));
  out.skipped = ids.filter((id) => !waiting.includes(id));
  if (!waiting.length) return out;

  const channelFanout = await deliver({ client, firmId, clientId, evidenceRequestIds: waiting, surface, deps })
    .catch((error) => ({ error: error?.message || 'fanout_failed' }));
  out.channel_fanout = channelFanout;
  if (channelFanout?.refused) {
    // Refused at the client gate: nothing sent, nothing counted; the ask stays
    // open on the owner and the refusal receipt is already written.
    out.refused = channelFanout.refused;
    out.held = waiting;
    return out;
  }

  // The fan-out names the asks a deliverer delivered; the re-read is only for
  // the rest (still waiting, or answered while the fan-out ran).
  const deliveredIds = new Set(Array.isArray(channelFanout?.delivered) ? channelFanout.delivered : []);
  out.delivered = waiting.filter((id) => deliveredIds.has(id));
  const rest = waiting.filter((id) => !deliveredIds.has(id));
  const after = rest.length ? await readAskStates(client, { firmId, clientId, ids: rest }) : new Map();
  const undelivered = [];
  for (const id of rest) {
    const now = after.get(id);
    if (AWAITING_OWNER_STATUSES.includes(now?.status)) undelivered.push(now);
    else out.skipped.push(id); // answered while the fan-out ran
  }
  if (!undelivered.length) return out;
  if (await hasPortalRecipientWithClient(client, { firmId, clientId })) {
    out.portal = undelivered.map((row) => row.id);
    return out;
  }
  for (const row of undelivered) {
    if (row.request_payload?.escalated_to_firm) { out.escalated.push(row.id); continue; }
    try {
      await escalateAskToFirmWithClient(client, { firmId, clientId, row, nowIso, reason: 'owner_unreachable' });
      out.escalated.push(row.id);
    } catch (error) {
      try { console.warn(`[ownerAskDelivery] escalation of ${row.id} failed: ${error?.message || error}`); } catch { /* never throw */ }
    }
  }
  return out;
};
