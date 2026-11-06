// Present-day ownership evidence for an empty legacy workspace. This is not
// historical creation authority, readiness, membership or processing enrollment.
import { createHash } from 'node:crypto';
import { withFirmDbClient } from './db/pool.js';
import { HOSTED_PILOT_VERSION } from './internalPilotAccess.js';

export const OWNER_ADOPTION_PROFILE_ID = 'fi-oy.existing-owner-adoption.vercel.none.management-books.fi-cloud-pilot-v1';
export const OWNER_REVALIDATION_ACTION = 'client.owner_revalidated';
export const OWNER_REVALIDATION_VERSION = 'donna.existing-owner-revalidation.v1';
export const OWNER_REVALIDATION_TTL_MS = 30 * 60 * 1000;
// jsonb reorders object keys; canonical serialization must survive persistence.
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const iso = value => new Date(value).toISOString();
const validFact = row => {
  const fact = row?.metadata;
  return Boolean(fact && fact.version === OWNER_REVALIDATION_VERSION && fact.empty_book === true
    && fact.authority_basis === 'current_authenticated_owner_revalidation'
    && fact.binding?.user_id === row.actor_id && fact.binding?.email
    && fact.review_digest === digest(fact.binding)
    && Number.isFinite(Date.parse(fact.observed_at))
    && Date.parse(fact.expires_at) - Date.parse(fact.observed_at) === OWNER_REVALIDATION_TTL_MS);
};
const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };

export const assertPilotBookEmptyWithClient = async (client, { firmId, clientId }) => {
  const result = await client.query(`select
    exists(select 1 from documents where firm_id=$1 and client_id=$2)
    or exists(select 1 from transactions where firm_id=$1 and client_id=$2)
    or exists(select 1 from ledger_journals where firm_id=$1 and client_id=$2) as has_books`, [firmId, clientId]);
  if (result.rows[0]?.has_books !== false) refuse('PILOT_EMPTY_CLIENT_REQUIRED', 'This confirmation requires an empty workspace. Existing books cannot be adopted into this pilot.');
};

const readOwnerSource = async (client, { firmId, clientId, userId, email, lock = false, sharedClientLock = false }) => {
  // Lock only the selected rows, then use identical read predicates in both
  // review and confirm. Fixed SQL keeps the reader boundary inspectable.
  if (lock) {
    // Consumed adoption is a read-only admission check. Shared locks allow
    // sibling uploads while still fencing company edits/deletion. Original
    // owner confirmation/preparation retains its exclusive client lock.
    if (sharedClientLock) await client.query('select id from clients where firm_id=$1 and id=$2 for share nowait', [firmId, clientId]);
    else await client.query('select id from clients where firm_id=$1 and id=$2 for update nowait', [firmId, clientId]);
  }
  const target = (await client.query(`select id, firm_id, company_name, jurisdiction, entity_type, status,
    profile, created_at, xmin::text as row_version, clock_timestamp() as observed_at
    from clients where firm_id=$1 and id=$2`, [firmId, clientId])).rows[0];
  if (!target || target.status !== 'active' || target.jurisdiction !== 'FI' || target.entity_type !== 'fi-oy') {
    refuse('OWNER_REVALIDATION_CLIENT_REQUIRED', 'This signed-in account has no eligible existing Finnish Oy workspace.');
  }
  if (lock) await client.query('select id from firm_collaborators where firm_id=$1 and user_id=$2 and lower(email)=$3 for share nowait', [firmId, userId, email]);
  const owners = await client.query(`select id as collaborator_id, user_id, lower(email) as owner_email,
    xmin::text as collaborator_version from firm_collaborators
    where firm_id=$1 and user_id=$2 and lower(email)=$3
      and role='owner' and status='active' and access_level='client_scoped'
      and (starts_at is null or starts_at<=clock_timestamp()) and (ends_at is null or ends_at>clock_timestamp())`, [firmId, userId, email]);
  if (owners.rows.length !== 1) refuse('OWNER_REVALIDATION_IDENTITY_REQUIRED', 'Your active owner assignment could not be verified.');
  const owner = owners.rows[0];
  if (lock) await client.query(`select id from client_assignments where firm_id=$1 and client_id=$2
    and principal_type='firm_collaborator' and principal_id=$3 for share nowait`, [firmId, clientId, owner.collaborator_id]);
  const assignments = await client.query(`select id as assignment_id, xmin::text as assignment_version from client_assignments
    where firm_id=$1 and client_id=$2 and principal_type='firm_collaborator' and principal_id=$3
      and assignment_kind='capability' and role='owner' and status='active' and access_level='client_scoped'
      and (starts_at is null or starts_at<=clock_timestamp()) and (ends_at is null or ends_at>clock_timestamp())`, [firmId, clientId, owner.collaborator_id]);
  if (assignments.rows.length !== 1) refuse('OWNER_REVALIDATION_IDENTITY_REQUIRED', 'Your active owner assignment could not be verified.');
  Object.assign(owner, assignments.rows[0]);
  const binding = { firm_id: firmId, client_id: clientId, client_created_at: iso(target.created_at),
    client_version: target.row_version, profile_digest: digest([target.company_name, target.jurisdiction, target.entity_type, target.profile]),
    collaborator_id: owner.collaborator_id, collaborator_version: owner.collaborator_version,
    assignment_id: owner.assignment_id, assignment_version: owner.assignment_version,
    user_id: userId, email };
  return { binding, target, observedAt: iso(target.observed_at) };
};

export const ownerAdoptedProfileDigest = target => digest([target.company_name, target.jurisdiction, target.entity_type, target.profile]);

// Admission tolerates only the parser's existing server-owned observations.
// Owner review/confirmation and the original full-profile digest stay exact.
export const OWNER_ADOPTION_ADMISSION_DIGEST_VERSION = 'donna.owner-adoption-admission.v1';
const DERIVED_JURISDICTION_KEYS = new Set(['jurisdiction_detected', 'jurisdiction_detected_confidence', 'jurisdiction_signals']);
export const ownerAdoptedAdmissionDigest = target => digest([target.company_name, target.jurisdiction, target.entity_type,
  target.profile && typeof target.profile === 'object' && !Array.isArray(target.profile)
    ? Object.fromEntries(Object.entries(target.profile).filter(([key]) => !DERIVED_JURISDICTION_KEYS.has(key))) : target.profile]);

export const adoptedProfileMatches = (metadata, target) => {
  // Absence means the historical exact contract; never reinterpret old facts.
  if (metadata.adopted_admission_digest_version === undefined) return metadata.adopted_profile_digest === ownerAdoptedProfileDigest(target);
  if (metadata.adopted_admission_digest_version !== OWNER_ADOPTION_ADMISSION_DIGEST_VERSION) return false;
  return metadata.adopted_admission_digest === ownerAdoptedAdmissionDigest(target);
};

const view = source => ({ firm_id: source.binding.firm_id, client_id: source.binding.client_id,
  actor_id: source.binding.user_id, owner_email: source.binding.email,
  company_name: source.target.company_name, jurisdiction: source.target.jurisdiction,
  entity_type: source.target.entity_type, review_digest: digest(source.binding),
  processing_readiness: 'INCOMPLETE', purpose: 'existing_empty_owner_revalidation' });

// Called only by the existing self-provision writer, using its server-resolved
// firm, authenticated identity and deterministic self-workspace id.
export const revalidateExistingOwnerForPilot = async ({ firmId, clientId, userId, email, request }) => {
  if (!request || typeof request !== 'object' || Array.isArray(request)
    || Object.keys(request).some(key => !['action', 'confirmed', 'review_digest'].includes(key))
    || !['review', 'confirm'].includes(request.action)) {
    refuse('OWNER_REVALIDATION_INPUT_INVALID', 'Review this workspace before confirming it.');
  }
  if (request.action === 'confirm' && (request.confirmed !== true || !/^[a-f0-9]{64}$/.test(request.review_digest || ''))) {
    refuse('OWNER_REVALIDATION_CONFIRMATION_REQUIRED', 'Review this workspace and explicitly confirm ownership.');
  }
  return withFirmDbClient(async client => {
    await client.query(request.action === 'review' ? 'begin isolation level repeatable read read only' : 'begin');
    try {
      await client.query("set local lock_timeout='5s'");
      await client.query("set local statement_timeout='5s'");
      if (request.action === 'confirm') await client.query("select pg_advisory_xact_lock(hashtextextended($1,0))", [`entity-readiness:${firmId}:${clientId}`]);
      const source = await readOwnerSource(client, { firmId, clientId, userId, email, lock: request.action === 'confirm' });
      await assertPilotBookEmptyWithClient(client, { firmId, clientId });
      const result = view(source);
      if (request.action === 'confirm') {
        if (request.review_digest !== result.review_digest) refuse('OWNER_REVALIDATION_CHANGED', 'The workspace or owner assignment changed. Review it again.');
        const previous = (await client.query(`select id, actor_id, metadata from audit_events where firm_id=$1 and client_id=$2
          and actor_type='supabase_user' and resource_type='client' and resource_id=$2 and action=$3 order by id desc limit 1`, [firmId, clientId, OWNER_REVALIDATION_ACTION])).rows[0];
        if (validFact(previous) && Date.parse(previous.metadata.observed_at) <= Date.parse(source.observedAt) && previous.actor_id === userId && previous.metadata.review_digest === result.review_digest && Date.parse(previous.metadata.expires_at) > Date.parse(source.observedAt)) {
          result.receipt_id = Number(previous.id); result.expires_at = previous.metadata.expires_at; result.already_confirmed = true;
        } else {
          const receipt = { version: OWNER_REVALIDATION_VERSION, binding: source.binding,
            review_digest: result.review_digest, observed_at: source.observedAt,
            expires_at: new Date(Date.parse(source.observedAt) + OWNER_REVALIDATION_TTL_MS).toISOString(),
            empty_book: true, authority_basis: 'current_authenticated_owner_revalidation' };
          const row = (await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
            values($1,$2,'supabase_user',$3,$4,'client',$2,$5::jsonb) returning id`,
          [firmId, clientId, userId, OWNER_REVALIDATION_ACTION, JSON.stringify(receipt)])).rows[0];
          result.receipt_id = Number(row.id); result.expires_at = receipt.expires_at;
        }
        // Calendar windows can expire while SQL waits even though locked row
        // versions cannot change. Re-read the real wall-clock predicates last.
        const final = await readOwnerSource(client, { firmId, clientId, userId, email, lock: true });
        if (digest(final.binding) !== result.review_digest) refuse('OWNER_REVALIDATION_CHANGED', 'Your owner assignment changed during confirmation.');
        if (Date.parse(result.expires_at) <= Date.parse(final.observedAt)) refuse('OWNER_REVALIDATION_EXPIRED', 'The owner confirmation expired. Review again.');
      }
      await client.query('commit');
      return result;
    } catch (error) { await client.query('rollback'); throw error; }
  });
};

// The pilot writer consumes this distinct proof without ever fabricating a
// client.create receipt. A consumed pilot receipt keeps the original proof;
// current identity, assignment and client generation are still required.
export const readOwnerRevalidationForPilot = async (client, { firmId, clientId, lock = false, prepared = null, requireFresh = false, sharedClientLock = false }) => {
  const consumed = prepared?.metadata?.owner_provenance;
  const row = (await client.query(`select id, actor_id, metadata from audit_events where firm_id=$1 and client_id=$2
    and action=$3 and actor_type='supabase_user' and resource_type='client' and resource_id=$2
    and ($4::bigint is null or id=$4) order by id desc limit 1`,
  [firmId, clientId, OWNER_REVALIDATION_ACTION, consumed?.kind === 'existing_owner_revalidated' ? consumed.receipt_id : null])).rows[0];
  const fact = row?.metadata;
  if (!validFact(row)) return null;
  const source = await readOwnerSource(client, { firmId, clientId, userId: fact.binding.user_id, email: fact.binding.email, lock, sharedClientLock });
  if (Date.parse(fact.observed_at) > Date.parse(source.observedAt) || source.binding.client_created_at !== fact.binding.client_created_at) return null;
  for (const key of ['firm_id','client_id','user_id','email','collaborator_id','collaborator_version','assignment_id','assignment_version']) {
    if (source.binding[key] !== fact.binding[key]) return null;
  }
  if (consumed?.kind === 'existing_owner_revalidated') {
    if (consumed.review_digest !== fact.review_digest || consumed.client_created_at !== source.binding.client_created_at
      || !adoptedProfileMatches(prepared.metadata, source.target)) return null;
  }
  if (!consumed || requireFresh) {
    if (Date.parse(fact.expires_at) <= Date.parse(source.observedAt) || !Number.isFinite(Date.parse(fact.expires_at))
      || (!consumed && fact.review_digest !== digest(source.binding))) return null;
    await assertPilotBookEmptyWithClient(client, { firmId, clientId });
  }
  return { kind: 'existing_owner_revalidated', receipt_id: Number(row.id), review_digest: fact.review_digest,
    client_created_at: source.binding.client_created_at, owner_id: row.actor_id, owner_email: fact.binding.email,
    confirmed_at: fact.observed_at, confirmation_expires_at: fact.expires_at, expires_at: consumed ? null : fact.expires_at };
};

// Read-only consumer shared by operator enable, readiness certification/recovery
// and every enforced admission. Current ownership never comes from birth history.
export const readConsumedOwnerAdoptionWithClient = async (client, {firmId, clientId, lock=false}) => {
  const prepared=(await client.query(`select id,actor_type,actor_id,metadata,created_at from audit_events
    where firm_id=$1 and client_id=$2 and resource_type='client' and resource_id=$2
      and action='pilot.prepared' order by id desc limit 1`,[firmId,clientId])).rows[0];
  if(prepared?.metadata?.owner_provenance?.kind!=='existing_owner_revalidated') return null;
  if(prepared.actor_type!=='firm_member' || !prepared.actor_id || prepared.actor_id==='system'
    || prepared.metadata.version!==HOSTED_PILOT_VERSION
    || prepared.metadata.firm_id!==firmId || prepared.metadata.client_id!==clientId || prepared.metadata.actor_id!==prepared.actor_id
    || prepared.metadata.authority_basis!=='explicit_internal_pilot_setup') {
    refuse('OWNER_REVALIDATION_PREPARATION_INVALID','The recorded operator preparation could not be verified.');
  }
  if(lock) await client.query('select id from firm_members where firm_id=$1 and id=$2 for share nowait',[firmId,prepared.actor_id]);
  const operator=(await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active'",[firmId,prepared.actor_id])).rows[0];
  const owner=await readOwnerRevalidationForPilot(client,{firmId,clientId,lock,prepared,sharedClientLock:true});
  if(!operator || !owner || Date.parse(owner.confirmed_at)>new Date(prepared.created_at).getTime()
    || new Date(prepared.created_at).getTime()>=Date.parse(owner.confirmation_expires_at)) {
    refuse('OWNER_REVALIDATION_CHANGED','The current owner, operator or adopted company profile changed. Review the workspace again.');
  }
  return {...owner,preparation_receipt_id:Number(prepared.id),operator_id:prepared.actor_id,
    adopted_profile_digest:prepared.metadata.adopted_profile_digest,
    ...(prepared.metadata.adopted_admission_digest_version === undefined ? {} : {
      adopted_admission_digest_version:prepared.metadata.adopted_admission_digest_version,
      adopted_admission_digest:prepared.metadata.adopted_admission_digest
    })};
};
