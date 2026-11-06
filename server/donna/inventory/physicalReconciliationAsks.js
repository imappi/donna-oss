// Transaction-owned adapter over the canonical ask minter, resolver and delivery
// writer. No outbound messages: the mounted authenticated surface acknowledges
// actual presentation. A minted draft is never reported as on-owner/delivered.
import { assertFirmAccess, getAssignmentRoleForPrincipal } from '../db/authority.js';
import { authorizeOperatorAction } from '../operatorCapability.js';
import { __createClientEvidenceRequestWithClient, resolvePhysicalCountRequestsWithClient, escalatePhysicalCountRequestWithClient, markPhysicalCountRequestsClockCheckedWithClient } from '../db/asks.js';
import { __bumpEvidenceRequestSendCountWithClient } from '../db/channels.js';
import { buildCanonicalAnchor } from '../askIdentity.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { lockInventoryScope } from './db.js';
import { withConvergenceTransaction } from '../convergenceConnection.js';
import { openBlocker, resolveBlocker, appendCaseEvent } from '../caseManager.js';
import { physicalReviewDeadline } from './physicalReviewCalendar.js';
import { physicalAskAcknowledged } from './physicalReconciliation.js';

const fail = (code, message, statusCode = 409) => { throw Object.assign(new Error(message), { code, statusCode }); };
const dto = (r) => ({ id: r.id, status: r.status,
  deliveryStatus: physicalAskAcknowledged(r) ? 'acknowledged' : 'not_delivered',
  recipient: { principalType: r.addressee_principal_type, principalId: r.addressee_principal_id },
  dueAt: r.due_at ? new Date(r.due_at).toISOString() : null, question: r.question });

async function eligible(a, recipient, actionType = 'acknowledge_physical_request') {
  if (!recipient || !['firm_member', 'firm_collaborator'].includes(recipient.principalType) || !recipient.principalId) {
    fail('PHYSICAL_ASK_RECIPIENT_REQUIRED', 'An active named human seat is required.', 403);
  }
  const { principal } = await assertFirmAccess({ firmId: a.firmId, clientIds: [a.clientId],
    resolvedPrincipal: recipient, dbClient: a.client });
  const assignmentRole = await getAssignmentRoleForPrincipal({ firmId: a.firmId, clientId: a.clientId, principal, dbClient: a.client });
  if (!authorizeOperatorAction({ principal, assignmentRole, actionType }).allowed) fail('PHYSICAL_ASK_RECIPIENT_INELIGIBLE', 'The named seat cannot perform this physical task.', 403);
  return principal;
}
const actor = (a) => ({ principalType: a.actorType, principalId: a.actorId });

export async function physicalTaskAssignment(a, { review = false, asOf } = {}) {
  const profile = (await a.client.query('select profile from clients where firm_id=$1 and id=$2', [a.firmId, a.clientId])).rows[0]?.profile;
  const coverage = profile?.physical_reconciliation;
  if (!coverage?.reviewer || !coverage?.senior || !coverage?.calendar
      || (coverage.reviewer.principalType === coverage.senior.principalType && coverage.reviewer.principalId === coverage.senior.principalId)) {
    fail('PHYSICAL_REVIEW_COVERAGE_REQUIRED', 'Configure distinct reviewer and senior seats and their service calendar before opening physical work.');
  }
  for (const person of [coverage.reviewer, coverage.senior]) await eligible(a, person, 'resolve_physical_reconciliation');
  const recipient = review ? coverage.reviewer : actor(a);
  await eligible(a, recipient, review ? 'resolve_physical_reconciliation' : 'observe_physical_reconciliation');
  return { recipient, senior: coverage.senior, calendar: coverage.calendar,
    dueAt: physicalReviewDeadline({ asOf, businessDays: review ? 2 : 1, calendar: coverage.calendar }) };
}
async function target(a) {
  const r = await a.client.query(
    `select l.id from inventory_count_lines l join inventory_count_sessions s on s.id=l.count_session_id
     where l.firm_id=$1 and l.client_id=$2 and l.id::text=$3 and s.id::text=$4
       and s.firm_id=$1 and s.client_id=$2 for update of l`,
    [a.firmId, a.clientId, String(a.lineId), String(a.sessionId)]);
  if (!r.rows.length) fail('PHYSICAL_ASK_TARGET_INVALID', 'Physical count line was not found.', 404);
}

export async function ensurePhysicalAsk(a) {
  await target(a);
  const recipient = a.recipient || actor(a);
  await eligible(a, recipient, a.review ? 'resolve_physical_reconciliation' : 'acknowledge_physical_request');
  if (!a.question?.trim() || !Number.isFinite(Date.parse(a.dueAt))) fail('PHYSICAL_ASK_DEADLINE_REQUIRED', 'A concrete question and deadline are required.');
  const row = await __createClientEvidenceRequestWithClient({ client: a.client, firmId: a.firmId, clientId: a.clientId,
    physicalCountLineId: String(a.lineId), question: a.question, dueAt: a.dueAt, actorId: a.actorId,
    evidenceType: 'physical_inventory', audience: 'seat', addresseePrincipalType: recipient.principalType,
    addresseePrincipalId: recipient.principalId, markTransactionNeedsClient: false,
    requestContext: { physical_session_id: String(a.sessionId), physical_case_id: a.caseId,
      task_surface: 'physical_reconciliation', delivery_status: 'not_delivered',
      physical_review_calendar: a.calendar || null, physical_senior: a.senior || null,
      review_required: Boolean(a.review), instruction: 'Use the physical count task to submit evidence or resolve this request.' } });
  return dto(row);
}

export async function resolvePhysicalAsk(a) {
  await target(a);
  await eligible(a, actor(a));
  const ids = await resolvePhysicalCountRequestsWithClient(a);
  return { resolvedIds: ids, status: 'resolved' };
}

export async function acknowledgePhysicalAsk(a) {
  await lockInventoryScope(a);
  await target(a);
  await eligible(a, actor(a));
  const snapshot = await readClientConfigSnapshot(a.client, { firmId: a.firmId, clientId: a.clientId });
  if (!clientFlagActs({ flagKey: 'PHYSICAL_RECONCILIATION', snapshot, envFallback: () => false })) fail('PHYSICAL_RECONCILIATION_DISABLED', 'Physical reconciliation is paused.');
  const row = (await a.client.query(
    `select * from client_evidence_requests where firm_id=$1 and client_id=$2 and id=$3
       and canonical_anchor=$4 and evidence_type='physical_inventory' for update`,
    [a.firmId, a.clientId, a.askId, buildCanonicalAnchor({ physicalCountLineId: a.lineId })])).rows[0];
  if (!row || row.addressee_principal_type !== a.actorType || row.addressee_principal_id !== a.actorId) fail('PHYSICAL_ASK_RECIPIENT_MISMATCH', 'Only the named recipient can acknowledge this request.', 403);
  if (!['draft','open'].includes(row.status)) fail('PHYSICAL_ASK_NOT_ACTIVE', 'This physical request has already been answered.');
  if (row.status === 'open' && physicalAskAcknowledged(row)) return dto(row);
  const acknowledgedAt = new Date().toISOString();
  const result = await __bumpEvidenceRequestSendCountWithClient({ ...a, askIds: [row.id], at: acknowledgedAt });
  if (result.bumped !== 1) fail('PHYSICAL_ASK_DELIVERY_FAILED', 'Physical request acknowledgement was not persisted.');
  await a.client.query(
    `insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
     values($1,$2,$3,$4,'physical.ask_acknowledged','client_evidence_request',$5,$6::jsonb)`,
    [a.firmId, a.clientId, a.actorType, a.actorId, row.id, JSON.stringify({ surface: 'authenticated_physical_task', session_id: String(a.sessionId), line_id: String(a.lineId) })]);
  return dto({ ...row, status: 'open', send_count: Number(row.send_count || 0) + 1, last_sent_at: acknowledgedAt });
}


// Existing registered ask clock calls this worker; no new event or scheduler.
// Drafts and revoked recipients are included: an undelivered request remains
// Donna's obligation and cannot disappear from the deadline clock.
export async function sweepPhysicalReviewAsks(a) {
  return withConvergenceTransaction(a.client, async client => {
    a = { ...a, client, actorType: 'system', actorId: 'physical_review_clock' };
    await lockInventoryScope(a);
    const rows = (await client.query(
      `select r.*, l.case_id from client_evidence_requests r
       join inventory_count_lines l on l.id::text=r.request_payload->>'physical_count_line_id'
         and l.firm_id=r.firm_id and l.client_id=r.client_id
       where r.firm_id=$1 and r.client_id=$2 and r.evidence_type='physical_inventory'
         and r.status in ('draft','open','replied')
       order by r.request_payload->>'physical_clock_checked_at' nulls first, r.created_at, r.id
       limit 100 for update of r`,
      [a.firmId, a.clientId])).rows;
    const result = { examined: rows.length, escalated: 0, blocked: 0 };
    if (!rows.length) return result;
    const asOf = (await client.query('select clock_timestamp() as time')).rows[0].time.toISOString();
    const snapshot = await readClientConfigSnapshot(client, a);
    const paused = !clientFlagActs({ flagKey: 'PHYSICAL_RECONCILIATION', snapshot, envFallback: () => false });
    await markPhysicalCountRequestsClockCheckedWithClient({ ...a, requestIds: rows.map(row => row.id), checkedAt: asOf });
    for (const row of rows) {
      let currentEligible = true;
      try { await withConvergenceTransaction(a.client, tx => eligible({ ...a, client: tx },
        { principalType: row.addressee_principal_type, principalId: row.addressee_principal_id },
        row.request_payload.review_required ? 'resolve_physical_reconciliation' : 'observe_physical_reconciliation')); }
      catch { currentEligible = false; }
      const overdue = row.due_at && new Date(row.due_at).getTime() <= Date.parse(asOf);
      const existing = (await client.query(
        `select id, reason from bookkeeping_case_blockers
         where firm_id=$1 and client_id=$2 and case_id=$3 and status='open'
           and blocker_type='accountant_judgment_required' and owner_type='firm'
           and object_type='client_evidence_request' and object_id=$4 for update`,
        [a.firmId, a.clientId, row.case_id, row.id])).rows[0];
      const wasPaused = existing?.reason?.startsWith('physical_feature_paused;') || false;
      if (!paused && wasPaused) await appendCaseEvent({ ...a, caseId: row.case_id,
        eventType: 'physical.review_resumed', payload: { askId: row.id, paused: false } });
      if (!paused && currentEligible && !overdue) {
        if (wasPaused) await resolveBlocker({ client, blockerId: existing.id, reason: 'Physical review resumed with active coverage.' });
        continue;
      }
      const reason = paused ? 'physical_feature_paused' : !currentEligible ? 'physical_recipient_unavailable' : 'physical_review_overdue';
      const recipient = row.request_payload.physical_senior;
      let seniorEligible = Boolean(recipient);
      try { await withConvergenceTransaction(a.client, tx => eligible({ ...a, client: tx }, recipient, 'resolve_physical_reconciliation')); }
      catch { seniorEligible = false; }
      if (!paused && seniorEligible && !row.request_payload.physical_escalation) {
        const dueAt = physicalReviewDeadline({ asOf, businessDays: 1, calendar: row.request_payload.physical_review_calendar });
        await escalatePhysicalCountRequestWithClient({ ...a, requestId: row.id, recipient, dueAt, reason });
        await appendCaseEvent({ ...a, caseId: row.case_id, eventType: 'physical.review_escalated', payload: { askId: row.id, recipient, dueAt, reason } });
        result.escalated++;
      } else result.blocked++;
      // Refresh changed diagnostics through the existing blocker owners. An
      // unchanged sweep must not append duplicate wait events on every retry.
      const blockerReason = `${reason}; named senior ${recipient?.principalId || 'missing'}; ${seniorEligible ? 'senior review required' : 'review coverage must be restored'}`;
      if (existing?.reason === blockerReason) continue;
      if (existing) await resolveBlocker({ client, blockerId: existing.id, reason: 'Physical review coverage changed.' });
      await appendCaseEvent({ ...a, caseId: row.case_id,
        eventType: paused && !wasPaused ? 'physical.review_paused' : 'physical.review_coverage_changed',
        payload: { askId: row.id, paused, priorReason: existing?.reason || null, reason: blockerReason } });
      await openBlocker({ ...a, caseId: row.case_id, blockerType: 'accountant_judgment_required', ownerType: 'firm',
        objectType: 'client_evidence_request', objectId: row.id, reason: blockerReason, dueAt: asOf });
    }
    return result;
  });
}
