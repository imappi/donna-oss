// Task credentials narrow an existing named seat; they never confer book authority.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { assertFirmAccess, getAssignmentRoleForPrincipal } from '../db/authority.js';
import { readClientConfigSnapshot, clientFlagActs } from '../clientConfig.js';
import { authorizeOperatorAction } from '../operatorCapability.js';
import { physicalHash } from './physicalReconciliation.js';

export const CAPTURE_ACCESS_FLAG = 'PHYSICAL_CAPTURE_ACCESS';
export const secretHash = value => createHash('sha256').update(String(value)).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
export const captureFail = (code, statusCode = 403) => { throw Object.assign(new Error(code), { code, statusCode }); };
export const requestKey = key => {
  if (typeof key !== 'string' || !key.trim() || key.length > 200) captureFail('CAPTURE_IDEMPOTENCY_REQUIRED', 400);
  return key;
};
export const captureTransaction = async (client, work) => {
  await client.query('begin');
  try { const result = await work(); await client.query('commit'); return result; }
  catch (error) { await client.query('rollback'); throw error; }
};
const scopeEnabled = async (client, scope) => {
  const entity = (await client.query('select id from clients where firm_id=$1 and id=$2 for update', [scope.firmId, scope.clientId])).rows[0];
  if (!entity) captureFail('CAPTURE_SCOPE_REFUSED');
  await client.query('select id from client_capability_config where firm_id=$1 and (client_id=$2 or client_id is null) for share', [scope.firmId, scope.clientId]);
  const snapshot = await readClientConfigSnapshot(client, { ...scope, strict: true });
  for (const flagKey of [CAPTURE_ACCESS_FLAG, 'PHYSICAL_RECONCILIATION', 'INVENTORY_CORE']) {
    if (!clientFlagActs({ flagKey, snapshot, envFallback: () => false })) captureFail('CAPTURE_DISABLED');
  }
  // Neither firm defaults nor cohort flags enroll a capture task.
  const exact = (await client.query(`select flag_key from client_capability_config where firm_id=$1 and client_id=$2
    and flag_key=any($3::text[]) and valid_to is null and stage in ('canary','auto')`, [scope.firmId, scope.clientId, [CAPTURE_ACCESS_FLAG, 'PHYSICAL_RECONCILIATION']])).rows;
  if (exact.length !== 2) captureFail('CAPTURE_DISABLED');
};
const eligible = async (client, scope, principal, verb) => {
  if (!['firm_member', 'firm_collaborator'].includes(principal?.principalType) || !principal.principalId) captureFail('CAPTURE_PERSON_REQUIRED');
  const current = (await assertFirmAccess({ firmId: scope.firmId, clientIds: [scope.clientId], resolvedPrincipal: principal, dbClient: client })).principal;
  const identity = (await client.query(`select user_id,created_at from firm_members where firm_id=$1 and id=$2 and $3='firm_member'
    union all select user_id,created_at from firm_collaborators where firm_id=$1 and id=$2 and $3='firm_collaborator'`,
    [scope.firmId, principal.principalId, principal.principalType])).rows[0];
  if (!identity?.user_id) captureFail('CAPTURE_IDENTITY_NOT_BOUND');
  const assignmentRole = await getAssignmentRoleForPrincipal({ ...scope, principal: current, dbClient: client });
  if (!authorizeOperatorAction({ principal: current, assignmentRole, actionType: verb }).allowed) captureFail('CAPTURE_AUTHORITY_REFUSED');
  return { ...current, userId: identity.user_id, createdAt: identity.created_at };
};
export const authorizeCaptureManager = async (client, scope, principal, enabled = true) => {
  if (enabled) await scopeEnabled(client, scope);
  else await client.query('select id from clients where firm_id=$1 and id=$2 for update', [scope.firmId, scope.clientId]);
  return eligible(client, scope, principal, 'assign_physical_capture_task');
};
export const listCaptureRecipients = async (client, scope, principal, sessionId) => {
  await authorizeCaptureManager(client, scope, principal);
  if (!/^[1-9][0-9]*$/.test(String(sessionId))) captureFail('CAPTURE_SCOPE_REQUIRED', 400);
  const workers = [];
  const rows = (await client.query(`select id,name,'firm_member' as principal_type from firm_members where firm_id=$1 and status='active'
    union all select id,name,'firm_collaborator' from firm_collaborators where firm_id=$1 and status='active' order by name`, [scope.firmId])).rows;
  for (const row of rows) {
    try {
      await eligible(client, scope, { principalType: row.principal_type, principalId: row.id }, 'observe_physical_reconciliation');
      workers.push({ principalType: row.principal_type, principalId: row.id, name: row.name });
    } catch (error) { if (![403].includes(error.statusCode)) throw error; }
  }
  const tasks = (await client.query(`select id,name,principal_type,principal_id,revoked_at,invitation_expires_at,credential_expires_at
    from inventory_capture_tasks where firm_id=$1 and client_id=$2 and count_session_id=$3 order by created_at desc`, [scope.firmId, scope.clientId, sessionId])).rows;
  return { workers, tasks };
};
export const captureAudit = async (client, task, principal, action, metadata = {}) => {
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,$3,$4,$5,'inventory_capture_task',$6,$7::jsonb)`, [task.firm_id, task.client_id, principal.principalType, principal.principalId,
    action, task.id, JSON.stringify({ ...metadata, authority_basis: 'named_seat_current_scope_and_single_capture_task' })]);
};
const session = async (client, scope, id) => {
  if (!/^[1-9][0-9]*$/.test(String(id))) captureFail('CAPTURE_SCOPE_REFUSED');
  const row = (await client.query(`select id,state from inventory_count_sessions where firm_id=$1 and client_id=$2 and id=$3
    and physical_reconciliation for share`, [scope.firmId, scope.clientId, id])).rows[0];
  if (!row) captureFail('CAPTURE_SCOPE_REFUSED');
  return row;
};
export const createCaptureTask = async (client, scope, principal, body) => {
  await authorizeCaptureManager(client, scope, principal);
  requestKey(body.idempotency_key);
  const recipient = { principalType: body.principal_type, principalId: body.principal_id };
  const identity = await eligible(client, scope, recipient, 'observe_physical_reconciliation');
  const count = await session(client, scope, body.session_id);
  if (count.state !== 'open') captureFail('CAPTURE_SESSION_CLOSED', 409);
  if (typeof body.name !== 'string' || !body.name.trim() || body.name.length > 120) captureFail('CAPTURE_NAME_REQUIRED', 400);
  const inputHash = physicalHash({ sessionId: String(count.id), recipient, name: body.name.trim(), actorType: principal.principalType, actorId: principal.principalId });
  const prior = (await client.query('select * from inventory_capture_tasks where firm_id=$1 and client_id=$2 and idempotency_key=$3', [scope.firmId, scope.clientId, body.idempotency_key])).rows[0];
  if (prior) {
    if (prior.input_hash !== inputHash) captureFail('CAPTURE_IDEMPOTENCY_CONFLICT', 409);
    return { taskId: prior.id, replayed: true };
  }
  const active = (await client.query('select id from inventory_capture_tasks where count_session_id=$1 and revoked_at is null', [count.id])).rows[0];
  if (active) captureFail('CAPTURE_TASK_ALREADY_ASSIGNED', 409);
  const task = (await client.query(`insert into inventory_capture_tasks(id,firm_id,client_id,count_session_id,name,principal_type,principal_id,
    created_by_type,created_by_id,idempotency_key,input_hash,principal_user_id,principal_created_at) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [randomUUID(), scope.firmId, scope.clientId, count.id, body.name.trim(), recipient.principalType, recipient.principalId,
      principal.principalType, principal.principalId, body.idempotency_key, inputHash, identity.userId, identity.createdAt])).rows[0];
  await captureAudit(client, task, principal, 'inventory.capture.assigned', { count_session_id: String(count.id), recipient });
  return { taskId: task.id, replayed: false };
};
export const manageCaptureTask = async (client, scope, principal, id, action, body) => {
  await authorizeCaptureManager(client, scope, principal, action !== 'revoke');
  requestKey(body.idempotency_key);
  const task = (await client.query('select * from inventory_capture_tasks where firm_id=$1 and client_id=$2 and id=$3 for update', [scope.firmId, scope.clientId, id])).rows[0];
  if (!task) captureFail('CAPTURE_SCOPE_REFUSED');
  if (action === 'revoke') {
    if (!task.revoked_at) {
      await client.query('update inventory_capture_tasks set revoked_at=clock_timestamp(),invitation_hash=null,credential_hash=null where id=$1', [id]);
      await captureAudit(client, task, principal, 'inventory.capture.revoked');
    }
    return { taskId: id, revoked: true };
  }
  if (task.revoked_at) captureFail('CAPTURE_REVOKED');
  const identity = await eligible(client, scope, { principalType: task.principal_type, principalId: task.principal_id, userId: task.principal_user_id }, 'observe_physical_reconciliation');
  if (identity.createdAt.getTime() !== task.principal_created_at.getTime()) captureFail('CAPTURE_RECIPIENT_REFUSED');
  if ((await session(client, scope, task.count_session_id)).state !== 'open') captureFail('CAPTURE_SESSION_CLOSED', 409);
  // A replay cannot reveal or regenerate a one-use secret. An explicit new request
  // replaces the old invitation AND credential, with a new attributable receipt.
  const issued = (await client.query(`select actor_id from audit_events where action='inventory.capture.invitation_issued' and resource_type='inventory_capture_task'
    and resource_id=$1 and metadata->>'request_key'=$2 limit 1`, [id, body.idempotency_key])).rows[0];
  if (issued) {
    if (issued.actor_id !== principal.principalId) captureFail('CAPTURE_IDEMPOTENCY_CONFLICT', 409);
    return { taskId: id, invitationIssued: true, replayed: true };
  }
  const secret = newSecret();
  const updated = (await client.query(`update inventory_capture_tasks set invitation_hash=$2,invitation_expires_at=clock_timestamp()+interval '15 minutes',
    invitation_used_at=null,invitation_key=$3,credential_hash=null,credential_expires_at=null where id=$1 returning invitation_expires_at`, [id, secretHash(secret), body.idempotency_key])).rows[0];
  await captureAudit(client, task, principal, 'inventory.capture.invitation_issued', { request_key: body.idempotency_key });
  return { taskId: id, invitation: secret, expiresAt: updated.invitation_expires_at, replayed: false };
};
export const exchangeCaptureInvitation = async (client, invitation, principal) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(invitation || '')) captureFail('CAPTURE_INVITATION_REFUSED');
  // Read scope first, then take the canonical client -> task lock order.
  const candidate = (await client.query('select firm_id,client_id,id from inventory_capture_tasks where invitation_hash=$1', [secretHash(invitation)])).rows[0];
  if (!candidate) captureFail('CAPTURE_INVITATION_REFUSED');
  const scope = { firmId: candidate.firm_id, clientId: candidate.client_id };
  await scopeEnabled(client, scope);
  const task = (await client.query(`select *,clock_timestamp() as checked_at from inventory_capture_tasks where id=$1 for update`, [candidate.id])).rows[0];
  if (task.invitation_hash !== secretHash(invitation) || task.revoked_at || task.invitation_used_at || !task.invitation_expires_at
    || task.invitation_expires_at <= task.checked_at) captureFail('CAPTURE_INVITATION_REFUSED');
  if (principal?.principalType !== task.principal_type || principal?.principalId !== task.principal_id) captureFail('CAPTURE_RECIPIENT_REFUSED');
  const identity = await eligible(client, scope, { ...principal, userId: task.principal_user_id }, 'observe_physical_reconciliation');
  if (identity.createdAt.getTime() !== task.principal_created_at.getTime()) captureFail('CAPTURE_RECIPIENT_REFUSED');
  if ((await session(client, scope, task.count_session_id)).state !== 'open') captureFail('CAPTURE_SESSION_CLOSED', 409);
  const credential = newSecret();
  await client.query(`update inventory_capture_tasks set invitation_used_at=clock_timestamp(),credential_hash=$2,
    credential_expires_at=clock_timestamp()+interval '30 minutes' where id=$1`, [task.id, secretHash(credential)]);
  await captureAudit(client, task, principal, 'inventory.capture.exchanged');
  return { taskId: task.id, credential };
};
export const authorizeCaptureCredential = async (client, taskId, credential) => {
  if (!/^[A-Za-z0-9_-]{43}$/.test(credential || '')) captureFail('CAPTURE_CREDENTIAL_REQUIRED', 401);
  const candidate = (await client.query('select firm_id,client_id from inventory_capture_tasks where id=$1', [taskId])).rows[0];
  if (!candidate) captureFail('CAPTURE_SCOPE_REFUSED');
  const scope = { firmId: candidate.firm_id, clientId: candidate.client_id };
  await scopeEnabled(client, scope);
  const task = (await client.query('select *,clock_timestamp() as checked_at from inventory_capture_tasks where id=$1 for share', [taskId])).rows[0];
  if (task.credential_hash !== secretHash(credential) || task.revoked_at || !task.credential_expires_at || task.credential_expires_at <= task.checked_at) captureFail('CAPTURE_CREDENTIAL_REFUSED');
  const principal = await eligible(client, scope, { principalType: task.principal_type, principalId: task.principal_id, userId: task.principal_user_id }, 'observe_physical_reconciliation');
  if (principal.createdAt.getTime() !== task.principal_created_at.getTime()) captureFail('CAPTURE_RECIPIENT_REFUSED');
  await session(client, scope, task.count_session_id);
  return { task, scope, principal };
};
// Allowlist projection deliberately omits expectations, outcomes, prices, asks and
// arbitrary payloads, including after observation. Count status is only receipt status.
export const captureTaskView = async (client, task) => {
  const count = await session(client, { firmId: task.firm_id, clientId: task.client_id }, task.count_session_id);
  if (count.state !== 'open') return { taskId: task.id, completed: true, items: [], permissions: [] };
  const rows = (await client.query(`select l.id,l.item_id,l.location_id,l.uom_id,i.sku,i.name,u.code as unit,loc.name as location,
    l.physical_observation->>'quantity' as submitted_quantity,l.physical_observation->>'actorId' as submitter
    from inventory_count_lines l join inventory_items i on i.id=l.item_id
    join inventory_locations loc on loc.id=l.location_id left join inventory_units_of_measure u on u.id=l.uom_id
    where l.firm_id=$1 and l.client_id=$2 and l.count_session_id=$3 order by l.id`, [task.firm_id, task.client_id, task.count_session_id])).rows;
  return { taskId: task.id, name: task.name, expiresAt: task.credential_expires_at, permissions: ['upload_photo', 'submit_count'],
    items: rows.map(row => ({ lineId: String(row.id), sku: row.sku, name: row.name, unit: row.unit,
      location: row.location, received: Boolean(row.submitter) })) };
};
