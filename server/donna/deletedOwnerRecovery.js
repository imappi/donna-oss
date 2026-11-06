// Explicit present-day recovery of a deleted login subject. An email locates
// the candidate; only the owner's request AND a separate exact-bound operator
// may authorize the compare-and-set. This does not grant pilot/readiness access.
import { createHash } from 'node:crypto';
import { withFirmDbClient } from './db/pool.js';
import { assertFirmScopeAllowed, resolveConfiguredDefaultFirmId } from './firmDb.js';
import { selfProvisionId } from './selfProvisionIdentity.js';
import { assertPilotBookEmptyWithClient, OWNER_REVALIDATION_TTL_MS } from './existingOwnerRevalidation.js';

export const RECOVERY_VERSION = 'donna.deleted-owner-recovery.v1';
const REQUEST = 'client.owner_recovery_requested';
const APPLIED = 'client.owner_identity_rebound';
const CLOSED = ['client.owner_recovery_cancelled', 'client.owner_recovery_superseded', APPLIED];
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const iso = value => new Date(value).toISOString();
const fail = (code, message, statusCode=409) => { throw Object.assign(new Error(message), { code: `OWNER_REVALIDATION_RECOVERY_${code}`, statusCode }); };
const changed = () => fail('CHANGED', 'The sign-in recovery evidence changed. Review it again.');
const validDigest = value => /^[a-f0-9]{64}$/.test(value || '');
const checkScope = firmId => {
  if (firmId !== resolveConfiguredDefaultFirmId()) fail('SCOPE', 'This workspace is outside the configured firm.');
  assertFirmScopeAllowed(firmId);
};
const transaction = (write, fn) => withFirmDbClient(async client => {
  // A server transaction deadline terminates the connection. Keep its error
  // listener until the socket is closed, then let the pool discard it.
  const connectionError = () => {};
  client.on('error', connectionError);
  try {
    await client.query(write ? 'begin' : 'begin isolation level repeatable read read only');
    // PostgreSQL refuses any RLS-filtered observation instead of letting
    // invisible identities or book rows masquerade as authoritative absence.
    await client.query("set local row_security=off");
    await client.query("set local transaction_timeout='5s'");
    await client.query("set local idle_in_transaction_session_timeout='5s'");
    await client.query("set local lock_timeout='5s'");
    await client.query("set local statement_timeout='5s'");
    const result = await fn(client);
    await client.query('commit'); return result;
  } catch (error) {
    try { await client.query('rollback'); } catch { await client.end().catch(() => {}); }
    if (String(error.code).startsWith('OWNER_REVALIDATION_') || String(error.code).startsWith('PILOT_')) throw error;
    throw Object.assign(new Error('Sign-in recovery is temporarily unavailable. Review again before trying.'),
      {code:'OWNER_REVALIDATION_RECOVERY_UNAVAILABLE',statusCode:503});
  } finally { client.removeListener('error', connectionError); }
});
const lockEntity = async (client, firmId, clientId) => {
  await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`entity-readiness:${firmId}:${clientId}`]);
  await client.query('select id from clients where firm_id=$1 and id=$2 for update nowait', [firmId, clientId]);
};
const append = async (client, { firmId, clientId, actorType, actorId, action, metadata }) =>
  (await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,$3,$4,$5,'client',$2,$6::jsonb) returning id,created_at`,
  [firmId,clientId,actorType,actorId,action,JSON.stringify({version:RECOVERY_VERSION,...metadata})])).rows[0];

// Authoritative provider state, not a caller-supplied claim or cached lookup.
// No absence inference from an unavailable relation/permission: SQL must succeed.
const authIdentity = async (client, userId, email) => {
  const rows = (await client.query(`select id::text as id,lower(email) as email,email_confirmed_at::text,created_at::text
    from auth.users where id::text=$1 and lower(email)=$2 and email_confirmed_at is not null
      and is_anonymous is not true and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp())`, [userId,email])).rows;
  if (rows.length !== 1) fail('IDENTITY', 'A current confirmed sign-in is required for this recovery.');
  const row = rows[0];
  return { user_id:row.id, email:row.email, created_at:row.created_at, email_confirmed_at:row.email_confirmed_at };
};
const readSource = async (client, {firmId,clientId,userId,email,lock=false,reboundFrom=null}) => {
  checkScope(firmId);
  if (clientId !== selfProvisionId('client-self',firmId,email)) fail('SCOPE','Review your own existing workspace.');
  const target = (await client.query(`select id,company_name,jurisdiction,entity_type,status,profile,created_at,
    xmin::text as version,clock_timestamp() as observed_at from clients where firm_id=$1 and id=$2`,[firmId,clientId])).rows[0];
  if (!target || target.status!=='active' || target.jurisdiction!=='FI' || target.entity_type!=='fi-oy') fail('CLIENT','An existing active Finnish Oy workspace is required.');
  await assertPilotBookEmptyWithClient(client,{firmId,clientId});
  const used = await client.query(`select 1 from audit_events where firm_id=$1 and client_id=$2
    and action in ('pilot.prepared','client.owner_revalidated','pilot.processing_enabled') limit 1`,[firmId,clientId]);
  const enrolled = await client.query(`select 1 from client_capability_config where firm_id=$1 and client_id=$2
    and flag_key in ('INTERNAL_PILOT_ACCESS','ENTITY_READINESS_ADMISSION') limit 1`,[firmId,clientId]);
  if (used.rowCount || enrolled.rowCount) fail('ALREADY_USED','This recovery is only available before pilot adoption.');
  if(lock) await client.query('select id from firm_collaborators where firm_id=$1 and lower(email)=$2 for update nowait',[firmId,email]);
  const owners = (await client.query(`select id,user_id,role,status,access_level,seat_role,affiliation,starts_at,ends_at,xmin::text as version
    from firm_collaborators where firm_id=$1 and lower(email)=$2`,[firmId,email])).rows;
  const owner = owners[0], now = Date.parse(iso(target.observed_at));
  const within = row => (!row.starts_at || Date.parse(iso(row.starts_at))<=now) && (!row.ends_at || Date.parse(iso(row.ends_at))>now);
  if(owners.length!==1 || owner.role!=='owner' || owner.status!=='active' || owner.access_level!=='client_scoped'
    || owner.seat_role || owner.affiliation!=='internal' || !within(owner) || !owner.user_id || (reboundFrom ? owner.user_id!==userId : owner.user_id===userId)) fail('OWNER','The existing owner binding is not eligible for this recovery.');
  if(lock) await client.query(`select id from client_assignments where principal_type='firm_collaborator' and principal_id=$1 for share nowait`,[owner.id]);
  const assignments = (await client.query(`select id,firm_id,client_id,assignment_kind,role,status,access_level,starts_at,ends_at,xmin::text as version
    from client_assignments where principal_type='firm_collaborator' and principal_id=$1`,[owner.id])).rows;
  const assignment = assignments[0];
  if(assignments.length!==1 || assignment.firm_id!==firmId || assignment.client_id!==clientId || assignment.assignment_kind!=='capability' || assignment.role!=='owner' || assignment.status!=='active' || assignment.access_level!=='client_scoped'
    || !within(assignment)) fail('ASSIGNMENT','The existing owner assignment is not eligible for recovery.');
  if((await client.query('select 1 from auth.users where id::text=$1',[reboundFrom || owner.user_id])).rowCount) fail('OLD_PRESENT','The previous sign-in still exists. This recovery cannot replace it.');
  const identity = await authIdentity(client,userId,email);
  const conflicts = await client.query(`select 1 from firm_collaborators where firm_id=$1 and user_id=$2 and ($3::text is null or id<>$3)
    union all select 1 from firm_members where firm_id=$1 and user_id=$2`,[firmId,userId,reboundFrom ? owner.id : null]);
  if(conflicts.rowCount) fail('CONFLICT','This sign-in is already bound to another principal.');
  return {firmId,clientId,userId,email,target,observedAt:iso(target.observed_at),binding:{
    firm_id:firmId,client_id:clientId,client_created_at:iso(target.created_at),client_version:target.version,
    profile_digest:hash([target.company_name,target.jurisdiction,target.entity_type,target.profile]),
    collaborator_id:owner.id,collaborator_version:owner.version,assignment_id:assignment.id,assignment_version:assignment.version,
    old_user_id:reboundFrom || owner.user_id,new_identity:identity}};
};
const latest = async (client,firmId,clientId) => (await client.query(`select id,actor_type,actor_id,metadata,created_at from audit_events
  where firm_id=$1 and client_id=$2 and resource_type='client' and resource_id=$2 and action=$3 order by id desc limit 1`,[firmId,clientId,REQUEST])).rows[0];
const closure = async (client,firmId,clientId,id) => (await client.query(`select id,action,actor_id,metadata from audit_events
  where firm_id=$1 and client_id=$2 and resource_type='client' and resource_id=$2 and action=any($3::text[])
    and metadata->>'request_id'=$4 order by id desc limit 1`,[firmId,clientId,CLOSED,String(id)])).rows[0];
const requestValid = (row,source) => row?.actor_type==='supabase_user' && row.actor_id===source.userId
  && row.metadata?.version===RECOVERY_VERSION && row.metadata.authority_basis==='authenticated_owner_recovery_request'
  && row.metadata.source_digest===hash(source.binding) && hash(row.metadata.binding)===hash(source.binding)
  && Date.parse(row.metadata.expires_at)-Date.parse(iso(row.created_at))===OWNER_REVALIDATION_TTL_MS
  && Date.parse(iso(row.created_at))<=Date.parse(source.observedAt)
  && Date.parse(row.metadata.expires_at)>Date.parse(source.observedAt);
const view = source => ({firm_id:source.firmId,client_id:source.clientId,actor_id:source.userId,
  company_name:source.target.company_name,owner_email:source.email,jurisdiction:'FI',entity_type:'fi-oy',
  purpose:'deleted_owner_recovery',review_digest:hash(source.binding),processing_readiness:'INCOMPLETE'});

export const requestDeletedOwnerRecovery = async ({firmId,clientId,userId,email,request}) => {
  if(!request || typeof request!=='object' || Array.isArray(request)
    || Object.keys(request).some(key=>!['action','confirmed','review_digest'].includes(key))
    || !['recovery_review','recovery_request','recovery_cancel'].includes(request.action)) fail('INPUT','Review this sign-in recovery before continuing.');
  const write=request.action!=='recovery_review';
  if(write && (request.confirmed!==true || !validDigest(request.review_digest))) fail('CONSENT','Review and explicitly confirm this sign-in recovery.');
  return transaction(write,async client=>{
    if(write) await lockEntity(client,firmId,clientId);
    const source=await readSource(client,{firmId,clientId,userId,email,lock:write});
    const result=view(source);
    if(write && request.review_digest!==result.review_digest) changed();
    const previous=await latest(client,firmId,clientId);
    const closed=previous && await closure(client,firmId,clientId,previous.id);
    if(request.action==='recovery_cancel') {
      if(!requestValid(previous,source) || closed) changed();
      const row=await append(client,{firmId,clientId,actorType:'supabase_user',actorId:userId,
        action:'client.owner_recovery_cancelled',metadata:{request_id:Number(previous.id),authority_basis:'authenticated_owner_cancellation'}});
      return {...result,cancelled:true,receipt_id:Number(row.id)};
    }
    if(previous && !closed && requestValid(previous,source)) return {...result,pending:true,receipt_id:Number(previous.id),expires_at:previous.metadata.expires_at};
    if(!write) return result;
    if(previous && !closed) await append(client,{firmId,clientId,actorType:'supabase_user',actorId:userId,
      action:'client.owner_recovery_superseded',metadata:{request_id:Number(previous.id),authority_basis:'fresh_owner_recovery_request'}});
    // now() and audit_events.created_at share the transaction timestamp.
    const expires=(await client.query("select now()+($1 * interval '1 millisecond') as expires",[OWNER_REVALIDATION_TTL_MS])).rows[0].expires;
    const row=await append(client,{firmId,clientId,actorType:'supabase_user',actorId:userId,action:REQUEST,
      metadata:{binding:source.binding,source_digest:result.review_digest,expires_at:iso(expires),authority_basis:'authenticated_owner_recovery_request'}});
    const final=await readSource(client,{firmId,clientId,userId,email,lock:true});
    if(hash(final.binding)!==result.review_digest || Date.parse(iso(expires))<=Date.parse(final.observedAt)) changed();
    return {...result,pending:true,receipt_id:Number(row.id),expires_at:iso(expires)};
  });
};

const readOperator = async (client, {firmId,auth,lock}) => {
  if(auth?.type!=='supabase_user' || !auth.userId || !auth.email) fail('OPERATOR','A separately signed-in operator must approve recovery.');
  const email=String(auth.email).trim().toLowerCase();
  if(lock) await client.query('select id from firm_members where firm_id=$1 and user_id=$2 for share nowait',[firmId,auth.userId]);
  const rows=(await client.query(`select id,xmin::text as version from firm_members
    where firm_id=$1 and user_id=$2 and lower(email)=$3 and status='active'`,[firmId,auth.userId,email])).rows;
  if(rows.length!==1) fail('OPERATOR','An active operator with a verified sign-in binding must approve recovery.');
  return {...rows[0],identity:await authIdentity(client,auth.userId,email)};
};
const operatorDigest = (source,request,operator) => hash({binding:source.binding,request_id:Number(request.id),
  request:request.metadata,operator});

export const operateDeletedOwnerRecovery = async ({firmId,clientId,auth,request={action:'review'}}) => {
  checkScope(firmId);
  if(!request || typeof request!=='object' || Array.isArray(request)
    || Object.keys(request).some(key=>!['action','confirmed','review_digest'].includes(key))
    || !['review','approve'].includes(request.action)) fail('INPUT','Review the owner recovery request first.');
  const write=request.action==='approve';
  if(write && (request.confirmed!==true || !validDigest(request.review_digest))) fail('CONSENT','Explicitly approve the reviewed owner recovery request.');
  return transaction(write,async client=>{
    // Unauthorized callers never acquire locks that serialize provider writes.
    await readOperator(client,{firmId,auth,lock:false});
    const privileges=await client.query(`select bool_and(
      has_table_privilege(current_user,relation,'SELECT')
      and has_table_privilege(current_user,relation,'MAINTAIN,UPDATE,DELETE,TRUNCATE')) as allowed
      from unnest(array['auth.users','firm_members','firm_collaborators','client_assignments']) as relation`);
    if(privileges.rows[0]?.allowed!==true) fail('PRIVILEGES',
      'The runtime database permissions required for safe sign-in recovery are unavailable. Ask the operator to verify the configured connection.',503);
    if(write) {
      await lockEntity(client,firmId,clientId);
      // No user_id uniqueness or polymorphic-principal FK exists. Serialize
      // the negative identity/grant predicates as well as existing rows.
      // NOWAIT refuses competing writers immediately; readers remain free.
      await client.query('lock table auth.users in share mode nowait');
      await client.query('lock table firm_members,firm_collaborators,client_assignments in share row exclusive mode nowait');
    }
    const operator=await readOperator(client,{firmId,auth,lock:write});
    const ownerRequest=await latest(client,firmId,clientId);
    if(!ownerRequest) fail('REQUEST','The owner must request sign-in recovery first.');
    const closed=await closure(client,firmId,clientId,ownerRequest.id);
    if(closed) {
      // Idempotent response, never a second authority mutation. A revoked or
      // changed current identity cannot replay a successful-looking receipt.
      if(write && closed.action===APPLIED && closed.actor_id===operator.id
        && closed.metadata.operator_digest===request.review_digest) {
        const binding=ownerRequest.metadata.binding;
        const current=await readSource(client,{firmId,clientId,userId:binding.new_identity.user_id,
          email:binding.new_identity.email,reboundFrom:binding.old_user_id,lock:true});
        if(hash(current.binding)!==closed.metadata.rebound_digest || hash(operator)!==hash(closed.metadata.operator)) changed();
        return {firm_id:firmId,client_id:clientId,actor_id:operator.id,actor_user_id:auth.userId,purpose:'deleted_owner_recovery_applied',
          receipt_id:Number(closed.id),already_applied:true,processing_readiness:'INCOMPLETE'};
      }
      fail('CLOSED','This recovery request is no longer pending. The owner can review the workspace again.');
    }
    const identity=ownerRequest.metadata?.binding?.new_identity;
    if(!identity || identity.user_id===auth.userId) fail('OPERATOR','A separate operator must approve the owner request.');
    const source=await readSource(client,{firmId,clientId,userId:identity.user_id,email:identity.email,lock:write});
    if(!requestValid(ownerRequest,source)) changed();
    const digest=operatorDigest(source,ownerRequest,operator);
    if(write && digest!==request.review_digest) changed();
    const result={...view(source),actor_id:operator.id,actor_user_id:auth.userId,review_digest:digest,request_id:Number(ownerRequest.id),
      expires_at:ownerRequest.metadata.expires_at,runtime_privileges_verified:true,purpose:'deleted_owner_recovery_operator'};
    if(!write) return result;
    // Refresh wall-clock/auth evidence after every possible lock wait. The final
    // statement repeats provider-state, uniqueness, empty-book and expiry guards.
    const final=await readSource(client,{firmId,clientId,userId:identity.user_id,email:identity.email,lock:true});
    const finalOperator=await readOperator(client,{firmId,auth,lock:true});
    if(operatorDigest(final,ownerRequest,finalOperator)!==digest || !requestValid(ownerRequest,final)) changed();
    const b=source.binding;
    const updated=await client.query(`update firm_collaborators fc set user_id=$4,updated_at=clock_timestamp()
      where fc.firm_id=$1 and fc.id=$2 and fc.user_id=$3 and xmin::text=$5
        and fc.role='owner' and fc.status='active' and fc.access_level='client_scoped'
        and (fc.starts_at is null or fc.starts_at<=clock_timestamp()) and (fc.ends_at is null or fc.ends_at>clock_timestamp())
        and clock_timestamp()<$6::timestamptz
        and not exists(select 1 from auth.users where id::text=$3)
        and exists(select 1 from auth.users where id::text=$4 and lower(email)=$7 and email_confirmed_at=$8::timestamptz
          and created_at=$9::timestamptz and is_anonymous is not true and deleted_at is null and (banned_until is null or banned_until<=clock_timestamp()))
        and not exists(select 1 from firm_collaborators where firm_id=$1 and user_id=$4)
        and not exists(select 1 from firm_members where firm_id=$1 and user_id=$4)
        and not exists(select 1 from documents where firm_id=$1 and client_id=$10)
        and not exists(select 1 from transactions where firm_id=$1 and client_id=$10)
        and not exists(select 1 from ledger_journals where firm_id=$1 and client_id=$10)
        and exists(select 1 from client_assignments where firm_id=$1 and id=$11 and xmin::text=$12
          and (starts_at is null or starts_at<=clock_timestamp()) and (ends_at is null or ends_at>clock_timestamp()))
      returning id`,[firmId,b.collaborator_id,b.old_user_id,identity.user_id,b.collaborator_version,
      ownerRequest.metadata.expires_at,identity.email,identity.email_confirmed_at,identity.created_at,clientId,b.assignment_id,b.assignment_version]);
    if(updated.rowCount!==1) changed();
    const rebound=await readSource(client,{firmId,clientId,userId:identity.user_id,email:identity.email,
      reboundFrom:b.old_user_id,lock:true});
    if(!requestValid(ownerRequest,{...rebound,binding:source.binding})) changed();
    const receipt=await append(client,{firmId,clientId,actorType:'firm_member',actorId:operator.id,action:APPLIED,
      metadata:{request_id:Number(ownerRequest.id),owner_actor_id:identity.user_id,operator_identity:operator.identity,
        operator_digest:digest,operator,rebound_digest:hash(rebound.binding),binding:b,authority_basis:'owner_request_and_exact_bound_operator_approval'}});
    const settled=await readSource(client,{firmId,clientId,userId:identity.user_id,email:identity.email,
      reboundFrom:b.old_user_id,lock:true});
    if(hash(settled.binding)!==hash(rebound.binding) || !requestValid(ownerRequest,{...settled,binding:source.binding})) changed();
    return {...result,purpose:'deleted_owner_recovery_applied',receipt_id:Number(receipt.id)};
  });
};
