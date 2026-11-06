// Operational repair ownership over the existing policy audit spine. No second
// queue, accounting mutation, configuration authority or manual resolution lives
// here. Only the named writer's exact recovered_failure_id closes an incident.
import {
  CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION,
  withCodingPolicyIncidentLock
} from './codingPolicyRecovery.js';
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
import { supportsStructuredOwnerReply } from './statutoryRegistry.js';
import { evaluateRetainedProcessingScopeWithClient, EntityReadinessAdmissionError } from './runtimeReadinessAdmission.js';

export const RUNTIME_POLICY_CLAIMED_ACTION = 'runtime.policy_incident.claimed';
export const RUNTIME_POLICY_RETRY_REQUESTED_ACTION = 'runtime.policy_incident.retry_requested';
export const RUNTIME_POLICY_RETRY_COMPLETED_ACTION = 'runtime.policy_incident.retry_completed';
export const RUNTIME_POLICY_RETRY_LEASE_SECONDS = 300;
const REPLY_FAILED_ACTION = 'evidence_request.reply_processing_failed';
const REPLY_RECOVERED_ACTION = 'evidence_request.reply_processed';
const sourceActions = [CODING_POLICY_FAILED_ACTION, CODING_POLICY_RECOVERED_ACTION, REPLY_FAILED_ACTION, REPLY_RECOVERED_ACTION];
const replySource = row => row.resource_type === 'client_evidence_request';
const sourceProjection = row => replySource(row) ? { ...row, metadata: { ...row.metadata, operation: 'owner_reply' } } : row;
const currentReply = row => row.request_status === 'replied'
  // Visibility follows the registered ask kind; an unresolved country is the
  // condition to repair, while the worker still refuses it before any effect.
  && (row.transaction_id || (row.audience === 'client' && supportsStructuredOwnerReply(row)))
  && (row.transaction_id || null) === (row.metadata.transaction_id || null)
  && ownerReplyIdentity({ id: row.resource_id, response_payload: row.response_payload, responded_at: row.responded_at }) === row.metadata.reply_key;
const sourceJoins = `
       left join client_evidence_requests r on a.resource_type = 'client_evidence_request'
         and r.id = a.resource_id and r.firm_id = a.firm_id and r.client_id = a.client_id
       left join transactions t on t.id = case when a.resource_type = 'transaction' then a.resource_id else r.transaction_id end
         and t.firm_id = a.firm_id and t.client_id = a.client_id
       join clients c on c.id = a.client_id and c.firm_id = a.firm_id`;
const sourceColumns = `a.*, t.coding_state, t.description, c.company_name,
       case when a.resource_type = 'transaction' then t.id else r.transaction_id end as transaction_id,
       r.status as request_status, r.response_payload, r.request_payload, r.responded_at, r.evidence_type, r.audience`;
const fail = (code, message, statusCode = 409) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
};
const required = ({ client, firmId }) => {
  if (!client || !firmId) throw new TypeError('Runtime policy incidents require client and firmId.');
};
const member = async ({ client, firmId, principal }) => {
  if (principal?.principalType !== 'firm_member' || !principal.principalId) {
    fail('RUNTIME_POLICY_MEMBER_REQUIRED', 'An identified workspace maintainer is required.', 403);
  }
  const result = await client.query(
    `select id, name, email from firm_members where firm_id = $1 and id = $2 and status = 'active' for share`,
    [firmId, principal.principalId]
  );
  if (!result.rows.length) fail('RUNTIME_POLICY_MEMBER_REQUIRED', 'The workspace maintainer is no longer active.', 403);
  return result.rows[0];
};
const source = async ({ client, firmId, failureId }) => {
  if (!/^\d+$/.test(String(failureId || ''))) fail('RUNTIME_POLICY_INCIDENT_NOT_FOUND', 'Runtime repair incident not found.', 404);
  const result = await client.query(
    `select ${sourceColumns} from audit_events a ${sourceJoins}
      where a.firm_id = $1 and a.id = $2::bigint and
        ((a.resource_type = 'transaction' and a.action = $3 and t.id is not null)
          or (a.resource_type = 'client_evidence_request' and a.action = $4 and r.id is not null))`,
    [firmId, String(failureId), CODING_POLICY_FAILED_ACTION, REPLY_FAILED_ACTION]
  );
  if (!result.rows.length) fail('RUNTIME_POLICY_INCIDENT_NOT_FOUND', 'Runtime repair incident not found.', 404);
  return sourceProjection(result.rows[0]);
};
const current = async (client, row) => {
  const result = await client.query(
    `select id, action, metadata from audit_events
      where firm_id = $1 and client_id = $2 and resource_type = $6 and resource_id = $3
        and ($4 = 'owner_reply' or metadata->>'operation' = $4) and action = any($5::text[])
      order by id desc limit 1`,
    [row.firm_id, row.client_id, row.resource_id, row.metadata.operation, sourceActions, row.resource_type]
  );
  return result.rows[0] || null;
};
const assertCurrent = async (client, row) => {
  const latest = await current(client, row);
  const eligible = replySource(row)
    ? row.metadata.state === 'exhausted' && row.metadata.policy_failure !== true && currentReply(row)
    : row.metadata.escalation_required === true && row.metadata.failure_kind !== 'missing_owner_fact'
      && ['coding', 'posting'].includes(row.metadata.operation);
  if (String(latest?.id) !== String(row.id) || !eligible) {
    fail('RUNTIME_POLICY_INCIDENT_STALE', 'This repair incident has recovered or been superseded. Refresh the incident list.');
  }
  const terminal = row.metadata.operation === 'posting'
    ? ['posted', 'synced', 'closed'] : ['applied', 'held', 'posted', 'synced', 'closed'];
  if (terminal.includes(row.coding_state)) {
    fail('RUNTIME_POLICY_SOURCE_TERMINAL', 'The source is already decided; this incident cannot rerun it.');
  }
};
const claim = async (client, row) => {
  const result = await client.query(
    `select a.id, a.actor_id, a.created_at, m.name, coalesce(m.status = 'active', false) as active
       from audit_events a
       left join firm_members m on m.firm_id = a.firm_id and m.id = a.actor_id
      where a.firm_id = $1 and a.client_id = $2 and a.action = $3
        and a.metadata->>'failure_id' = $4
      order by a.id desc limit 1`,
    [row.firm_id, row.client_id, RUNTIME_POLICY_CLAIMED_ACTION, String(row.id)]
  );
  return result.rows[0] || null;
};
const retry = async (client, row, { idempotencyKey = null, requestId = null } = {}) => {
  const result = await client.query(
    `select a.*, (a.created_at + ($6::integer * interval '1 second') > now()) as lease_active,
            a.created_at + ($6::integer * interval '1 second') as lease_expires_at,
            (select d.id from audit_events d where d.firm_id = a.firm_id and d.client_id = a.client_id
              and d.action = $5 and d.metadata->>'retry_request_id' = a.id::text order by d.id desc limit 1) as completion_id,
            (select d.metadata from audit_events d where d.firm_id = a.firm_id and d.client_id = a.client_id
              and d.action = $5 and d.metadata->>'retry_request_id' = a.id::text order by d.id desc limit 1) as completion
       from audit_events a
      where a.firm_id = $1 and a.client_id = $2 and a.action = $3 and a.metadata->>'failure_id' = $4
        and ($7::text is null or a.metadata->>'idempotency_key' = $7)
        and ($8::bigint is null or a.id = $8)
      order by a.id desc limit 1`,
    [row.firm_id, row.client_id, RUNTIME_POLICY_RETRY_REQUESTED_ACTION, String(row.id),
      RUNTIME_POLICY_RETRY_COMPLETED_ACTION, RUNTIME_POLICY_RETRY_LEASE_SECONDS, idempotencyKey, requestId]
  );
  return result.rows[0] || null;
};
const append = async (client, row, actor, action, metadata) => {
  const result = await client.query(
    `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
     values ($1, $2, 'firm_member', $3, $4, $7, $5, $6::jsonb) returning *`,
    [row.firm_id, row.client_id, actor.id, action, row.resource_id,
      JSON.stringify({ failure_id: String(row.id), operation: row.metadata.operation,
        ...(replySource(row) ? { evidence_request_id: row.resource_id, reply_key: row.metadata.reply_key, transaction_id: row.transaction_id || null } : {}),
        authority_basis: 'authenticated_workspace_maintainer', ...metadata }), row.resource_type]
  );
  return result.rows[0];
};
const project = (row, owner, request, scope = null) => ({
  failure_id: String(row.id), firm_id: row.firm_id, client_id: row.client_id,
  transaction_id: row.transaction_id, operation: row.metadata.operation,
  ...(replySource(row) ? { evidence_request_id: row.resource_id, reply_key: row.metadata.reply_key } : {}),
  company_name: row.company_name, description: row.description,
  reason_code: row.metadata.reason_code || row.metadata.code, reason_detail: row.metadata.reason_detail || null,
  error: row.metadata.error || row.metadata.message || null, attempts: Number(row.metadata.attempts || 1),
  unlock_condition: row.metadata.unlock_condition || null, opened_at: row.created_at,
  ...(scope?.allowed === false ? { can_retry: false, retry_unavailable_reason: scope.reason_code } : {}),
  status: owner?.active ? request && !request.completion_id && request.lease_active ? 'retrying' : 'acknowledged' : 'unclaimed',
  claimant: owner ? { id: owner.actor_id, name: owner.name, active: owner.active,
    receipt_id: String(owner.id), claimed_at: owner.created_at } : null,
  latest_retry: request ? { id: String(request.id), requested_at: request.created_at,
    lease_expires_at: request.lease_expires_at, lease_active: request.lease_active && !request.completion_id,
    outcome: request.completion?.outcome || null, error_code: request.completion?.error_code || null,
    completion_id: request.completion_id ? String(request.completion_id) : null } : null
});
const postingScope = (client, row) => row.metadata.operation === 'posting'
  ? evaluateRetainedProcessingScopeWithClient({ client, firmId: row.firm_id, clientId: row.client_id, lock: false })
  : null;
const locked = async (args, callback) => {
  required(args);
  const row = await source(args);
  return withCodingPolicyIncidentLock({ ...args, clientId: row.client_id,
    transactionId: row.transaction_id || row.resource_id, operation: row.metadata.operation }, async () => {
    // Re-read authoritative state after waiting; neither the caller's projection
    // nor the row observed before a concurrent successful writer is authority.
    const fresh = await source(args);
    const actor = await member(args);
    return callback(fresh, actor);
  });
};

export const listRuntimePolicyIncidents = async ({ client, firmId, limit = 50, afterFailureId = null } = {}) => {
  required({ client, firmId });
  if (afterFailureId !== null && !/^\d+$/.test(String(afterFailureId))) fail('RUNTIME_POLICY_CURSOR_INVALID', 'Invalid repair incident cursor.', 400);
  const rows = [];
  const postingScopes = new Map();
  const requestedLimit = Math.min(100, Math.max(1, Number(limit) || 50));
  let cursor = afterFailureId;
  // Source-identity validation is shared with the writer's JS hash. Continue
  // scanning after stale source projections so a short page cannot hide repairs.
  while (rows.length < requestedLimit) {
    const result = await client.query(
      `with latest as (
         select distinct on (a.client_id, a.resource_type, a.resource_id, coalesce(a.metadata->>'operation', 'owner_reply')) a.*
           from audit_events a where a.firm_id = $1
             and a.action = any($2::text[])
           order by a.client_id, a.resource_type, a.resource_id, coalesce(a.metadata->>'operation', 'owner_reply'), a.id desc
       ) select ${sourceColumns} from latest a ${sourceJoins}
        where ($5::bigint is null or a.id > $5) and (
          (a.resource_type = 'transaction' and a.action = $3 and a.metadata->>'escalation_required' = 'true'
            and a.metadata->>'operation' in ('coding', 'posting') and t.id is not null
            and coalesce(a.metadata->>'failure_kind', '') <> 'missing_owner_fact'
            and coalesce(t.coding_state, '') <> all(case when a.metadata->>'operation' = 'posting'
              then array['posted','synced','closed'] else array['applied','held','posted','synced','closed'] end))
          or (a.resource_type = 'client_evidence_request' and a.action = $6
            and a.metadata->>'state' = 'exhausted' and coalesce(a.metadata->>'policy_failure', 'false') <> 'true'
            and r.status = 'replied' and (r.transaction_id is null or t.id is not null)
            and coalesce(t.coding_state, '') <> all(array['applied','held','posted','synced','closed']))
        ) order by a.id limit $4`,
      [firmId, sourceActions, CODING_POLICY_FAILED_ACTION, requestedLimit - rows.length, cursor, REPLY_FAILED_ACTION]
    );
    if (!result.rows.length) break;
    for (const raw of result.rows) {
      cursor = String(raw.id);
      const row = sourceProjection(raw);
      if (replySource(row) && !currentReply(row)) continue;
      if (row.metadata.operation === 'posting' && !postingScopes.has(row.client_id)) {
        postingScopes.set(row.client_id, await postingScope(client, row));
      }
      rows.push(project(row, await claim(client, row), await retry(client, row),
        row.metadata.operation === 'posting' ? postingScopes.get(row.client_id) : null));
    }
  }

  return rows;
};

export const claimRuntimePolicyIncident = async (args = {}) => locked(args, async (row, actor) => {
  await assertCurrent(args.client, row);
  let owner = await claim(args.client, row);
  if (owner?.active && owner.actor_id !== actor.id) {
    fail('RUNTIME_POLICY_ALREADY_CLAIMED', 'Another workspace maintainer has acknowledged this incident.');
  }
  if (!owner?.active) {
    const receipt = await append(args.client, row, actor, RUNTIME_POLICY_CLAIMED_ACTION,
      { previous_claim_id: owner ? String(owner.id) : null });
    owner = { id: receipt.id, actor_id: actor.id, created_at: receipt.created_at, name: actor.name, active: true };
  }
  return project(row, owner, await retry(args.client, row), await postingScope(args.client, row));
});

export const requestRuntimePolicyIncidentRetry = async (args = {}) => locked(args, async (row, actor) => {
  const key = typeof args.idempotencyKey === 'string' ? args.idempotencyKey.trim() : '';
  const note = typeof args.repairNote === 'string' ? args.repairNote.trim() : '';
  if (!key || key.length > 160) fail('RUNTIME_POLICY_RETRY_KEY_REQUIRED', 'A bounded retry idempotency key is required.', 400);
  if (!note || note.length > 1000) fail('RUNTIME_POLICY_REPAIR_NOTE_REQUIRED', 'Describe the configuration or runtime repair before retrying.', 400);
  // A duplicate after successful recovery must still return the original request
  // without launching another model call or accounting mutation.
  const duplicate = await retry(args.client, row, { idempotencyKey: key });
  if (duplicate) {
    if (duplicate.actor_id !== actor.id) fail('RUNTIME_POLICY_RETRY_KEY_CONFLICT', 'This retry key belongs to another maintainer.');
    const scope = await postingScope(args.client,row);
    // A persisted request from before scope enforcement is still our lifecycle
    // to finish. Replaying it must neither run accounting nor leave its lease
    // looking active until timeout. Use the existing completion writer.
    if (scope?.allowed === false && !duplicate.completion_id) {
      await completeRuntimePolicyIncidentRetry({...args,requestId:duplicate.id,
        errorCode:new EntityReadinessAdmissionError(scope).code});
      const completed=await retry(args.client,row,{requestId:duplicate.id});
      return {incident:project(row,await claim(args.client,row),completed,scope),request:completed,execute:false};
    }
    return { incident: project(row, await claim(args.client, row), duplicate,scope), request: duplicate, execute: false };
  }
  await assertCurrent(args.client, row);
  const scope = await postingScope(args.client, row);
  if (scope?.allowed === false) throw new EntityReadinessAdmissionError(scope);
  const owner = await claim(args.client, row);
  if (!owner?.active || owner.actor_id !== actor.id) fail('RUNTIME_POLICY_CLAIM_REQUIRED', 'Acknowledge this incident before requesting its repair retry.');
  const previous = await retry(args.client, row);
  if (previous && !previous.completion_id && previous.lease_active) fail('RUNTIME_POLICY_RETRY_IN_PROGRESS', 'A repair retry is already running.');
  const request = await append(args.client, row, actor, RUNTIME_POLICY_RETRY_REQUESTED_ACTION,
    { idempotency_key: key, repair_note: note, claim_id: String(owner.id),
      previous_retry_id: previous ? String(previous.id) : null, lease_seconds: RUNTIME_POLICY_RETRY_LEASE_SECONDS });
  const stored = await retry(args.client, row, { requestId: request.id });
  return { incident: project(row, owner, stored), request: stored, execute: true };
});

export const completeRuntimePolicyIncidentRetry = async (args = {}) => locked(args, async (row, actor) => {
  if (!/^\d+$/.test(String(args.requestId || ''))) fail('RUNTIME_POLICY_RETRY_NOT_FOUND', 'Repair retry not found.', 404);
  const request = await retry(args.client, row, { requestId: args.requestId });
  if (!request || request.actor_id !== actor.id) fail('RUNTIME_POLICY_RETRY_NOT_FOUND', 'Repair retry not found.', 404);
  if (request.completion_id) return { id: String(request.completion_id), ...request.completion };
  const recovery = await args.client.query(
    `select id from audit_events where firm_id = $1 and client_id = $2 and resource_type = $7
      and resource_id = $3 and action = $4 and metadata->>'recovered_failure_id' = $5
      and ($6 = 'owner_reply' or metadata->>'operation' = $6) order by id desc limit 1`,
    [row.firm_id, row.client_id, row.resource_id, replySource(row) ? REPLY_RECOVERED_ACTION : CODING_POLICY_RECOVERED_ACTION, String(row.id), row.metadata.operation, row.resource_type]
  );
  const recoveryId = recovery.rows[0]?.id;
  const latest = await current(args.client, row);
  // Transport success is never proof of repair; a named writer's exact receipt is.
  const outcome = recoveryId ? 'recovered' : String(latest?.id) !== String(row.id) || (replySource(row) && !currentReply(row)) ? 'superseded' : 'still_open';
  const errorCode = typeof args.errorCode === 'string' ? args.errorCode.slice(0, 160) : null;
  const receipt = await append(args.client, row, actor, RUNTIME_POLICY_RETRY_COMPLETED_ACTION,
    { retry_request_id: String(request.id), outcome, error_code: errorCode,
      recovery_receipt_id: recoveryId ? String(recoveryId) : null });
  return { id: String(receipt.id), ...receipt.metadata };
});
