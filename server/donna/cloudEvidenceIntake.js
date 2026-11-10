// Direct signed PUTs enter private quarantine. Only the existing document
// registration transaction releases bytes after current admission and hashing.
// Intent/release receipts live in the existing audit trail; no intake database.
import { randomUUID, createHash } from 'node:crypto';
import { resolveRuntimeHostIdentity } from './runtimeHostIdentity.js';
import { readInternalPilotSendRestrictionWithClient } from './internalPilotAccess.js';
import { checkEntityReadinessAdmissionWithClient, EntityReadinessAdmissionError } from './runtimeReadinessAdmission.js';
import { createEvidenceSignedUploadUrl, fetchEvidenceObjectBytes } from './evidenceStorage.js';
import { withCloudReadinessClient } from './cloudRuntimeReadiness.js';
import { requireClientInFirm } from './db/clients.js';
// Readiness takes its advisory fence first. Never wait on a client row while
// holding it: identity writers may already own that row and need readiness.
// SHARE also fences non-key firm/status changes, unlike the insert's FK lock.
export const lockUploadClientInFirm = async ({ client, firmId, clientId }) => {
  let locked;
  try {
    locked = await client.query('select id from clients where firm_id=$1 and id=$2 for share nowait', [firmId, clientId]);
  } catch (error) {
    if (error.code === '55P03') error.statusCode = 409;
    throw error; // The transaction owner must roll back before any effects.
  }
  // A row born after an empty lock read has not been fenced by this operation.
  // Keep the existing ownership helper's non-disclosing not-found semantics.
  if (locked.rows.length !== 1 || locked.rows[0].id !== clientId) {
    throw Object.assign(new Error('Client not found for Xero connection.'), { statusCode: 404 });
  }
  await requireClientInFirm({ client, firmId, clientId });
};
export const CLOUD_UPLOAD_INTENT_ACTION = 'pilot.evidence_upload.quarantined';
const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
export const cloudUploadPrincipal = principal => {
  const type = principal?.principalType, id = principal?.principalId || principal?.member?.id || principal?.collaborator?.id;
  if (!['firm_member','firm_collaborator'].includes(type) || !id) refuse('PILOT_UPLOAD_PRINCIPAL_REQUIRED','A signed-in pilot owner or member must upload this file.');
  return { type, id };
};
// Re-read at the write boundary, after byte verification. NOWAIT avoids the
// reverse order of actor invalidation triggers acquiring the readiness lock.
const lockUploadActor = async (client, {firmId,clientId}, actor) => {
  let active;
  if (actor.type === 'firm_member') {
    active = (await client.query("select id from firm_members where firm_id=$1 and id=$2 and status='active' for share nowait", [firmId,actor.id])).rowCount;
  } else {
    active = (await client.query(`select id from firm_collaborators where firm_id=$1 and id=$2 and status='active'
      and (starts_at is null or starts_at <= clock_timestamp()) and (ends_at is null or ends_at > clock_timestamp()) for share nowait`, [firmId,actor.id])).rowCount;
    if (active) active = (await client.query(`select id from client_assignments where firm_id=$1 and client_id=$2
      and principal_type='firm_collaborator' and principal_id=$3 and assignment_kind='capability' and status='active'
      and (starts_at is null or starts_at <= clock_timestamp()) and (ends_at is null or ends_at > clock_timestamp()) for share nowait`, [firmId,clientId,actor.id])).rowCount;
  }
  if (!active) refuse('PILOT_UPLOAD_PRINCIPAL_REVOKED','Your access to this client changed. The file remains private.');
};
export const cloudPilotIntakeApplies = async (client, scope) => resolveRuntimeHostIdentity().runtime_host === 'vercel'
  && await readInternalPilotSendRestrictionWithClient(client,scope);
const requireAdmission = async (client, scope) => {
  const admission = await checkEntityReadinessAdmissionWithClient({ client, ...scope });
  if (!admission.allowed) throw new EntityReadinessAdmissionError(admission);
  if (!admission.enforced) refuse('PILOT_PROCESSING_NOT_ENROLLED','Pilot processing has not been reviewed and enabled.');
  return admission;
};
export const createCloudPilotUpload = async ({ firmId, clientId, principal, bucket, filename, checksum, size, mimeType }) =>
  resolveRuntimeHostIdentity().runtime_host !== 'vercel' ? null : withCloudReadinessClient(async (client, signal) => {
    await client.query('begin');
    try {
      await requireClientInFirm({ client, firmId, clientId });
      if (!await cloudPilotIntakeApplies(client,{firmId,clientId})) { await client.query('rollback'); return null; }
      const actor = cloudUploadPrincipal(principal);
      if (!/^[a-f0-9]{64}$/.test(checksum || '')) refuse('PILOT_UPLOAD_CHECKSUM_REQUIRED','The file needs a complete SHA-256 checksum.');
      const key = `${firmId}/${clientId}/__quarantine__/${randomUUID()}/${String(filename).replace(/[^\w.\-]/g,'_').slice(-160)}`;
      const admission = await requireAdmission(client,{firmId,clientId,boundary:'upload_sign',resourceType:'evidence_upload',resourceId:key});
      await lockUploadClientInFirm({ client, firmId, clientId });
      const identity = resolveRuntimeHostIdentity();
      const metadata = { version:'donna.cloud-evidence-intake.v1', bucket,key,checksum,size,mime_type:mimeType,
        host_generation:identity.generation_digest,entity_dependency_digest:admission.entity_dependency_digest,
        principal:actor,expires_at:new Date(Date.now()+10*60*1000).toISOString(),authority_basis:'scoped_principal_and_current_entity_readiness' };
      const receipt = (await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
        values($1,$2,$3,$4,$5,'evidence_upload',$6,$7::jsonb) returning id`,[firmId,clientId,actor.type,actor.id,CLOUD_UPLOAD_INTENT_ACTION,key,JSON.stringify(metadata)])).rows[0];
      const signed = await createEvidenceSignedUploadUrl({bucket,key,expiresIn:600,signal});
      await lockUploadActor(client,{firmId,clientId},actor);
      signal.throwIfAborted(); await client.query('commit');
      return {...signed,intake_receipt_id:Number(receipt.id),intake_state:'quarantined'};
    } catch(error) {
      // Admission already appended its blocked receipt in this transaction.
      if (error instanceof EntityReadinessAdmissionError) await client.query('commit');
      else await client.query('rollback').catch(()=>{});
      throw error;
    }
  });

// The file type and size the SERVER signed for one quarantine key, for a
// register caller that holds no trusted copy (the phone contract's register
// item carries neither; the adapter signed the intent a moment earlier).
// createCloudPilotUpload wrote both from values it checked, under a key it
// minted. Returned only for the newest intent of this exact key, version and
// principal — the row validateCloudPilotRegistration reads — so nothing is
// lifted from another person's upload. The registration check against this
// row and the byte verification (size and SHA-256) are unchanged. Null when
// no such intent exists (not a pilot book, or not this person's upload).
export const readCloudUploadIntentFileFacts = async ({ query, firmId, clientId, key, principal }) => {
  if (!firmId || !clientId || typeof key !== 'string' || !key.startsWith(`${firmId}/${clientId}/__quarantine__/`)) return null;
  const type = principal?.principalType, id = principal?.principalId;
  if (!type || !id) return null;
  const intent = (await query(`select metadata from audit_events where firm_id=$1 and client_id=$2 and action=$3
    and resource_type='evidence_upload' and resource_id=$4 order by id desc limit 1`,
  [firmId, clientId, CLOUD_UPLOAD_INTENT_ACTION, key])).rows[0]?.metadata;
  if (!intent || intent.version !== 'donna.cloud-evidence-intake.v1' || intent.key !== key
    || intent.principal?.type !== type || intent.principal?.id !== id
    || typeof intent.mime_type !== 'string' || !Number.isInteger(intent.size)) return null;
  return { mime_type: intent.mime_type, size: intent.size };
};

export const validateCloudPilotRegistration = async ({ client,firmId,document,principal }) => {
  if (!await cloudPilotIntakeApplies(client,{firmId,clientId:document.client_id})) return null;
  const actor = cloudUploadPrincipal(principal);
  const row = (await client.query(`select id,metadata from audit_events where firm_id=$1 and client_id=$2 and action=$3
    and resource_type='evidence_upload' and resource_id=$4 order by id desc limit 1 for update`,
  [firmId,document.client_id,CLOUD_UPLOAD_INTENT_ACTION,document.storage_object_key])).rows[0];
  const intent = row?.metadata;
  if (!intent || intent.version !== 'donna.cloud-evidence-intake.v1'
    || intent.bucket!==document.storage_bucket || intent.principal?.type!==actor.type || intent.principal?.id!==actor.id
    || intent.checksum!==document.checksum_sha256 || intent.mime_type!==(document.mime_type ?? document.file_storage?.mime_type) || intent.size!==Number(document.file_size ?? document.file_storage?.size)) {
    refuse('PILOT_UPLOAD_INTENT_MISMATCH','This file has no matching upload receipt for this signed-in person. Retry the upload.');
  }
  // A committed canonical registration is a no-op replay even after expiry or
  // host replacement. It must belong to this exact signed intent and actor.
  const canonical = (await client.query(`select d.id from documents d join audit_events a on a.firm_id=d.firm_id
    and a.client_id=d.client_id and a.resource_id=d.id and a.action='pilot.evidence_upload.released'
    where d.firm_id=$1 and d.client_id=$2 and d.storage_object_key=$3 and d.checksum_sha256=$4
      and a.metadata->>'upload_receipt_id'=$5 limit 1 for share of d nowait`,
    [firmId,document.client_id,intent.key,intent.checksum,String(row.id)])).rows[0];
  if (canonical) { await lockUploadActor(client,{firmId,clientId:document.client_id},actor); return {replay:true,canonical_id:canonical.id}; }
  if ((!Number.isFinite(Date.parse(intent.expires_at)) || Date.parse(intent.expires_at)<=Date.now()) || intent.host_generation!==resolveRuntimeHostIdentity().generation_digest) {
    refuse('PILOT_UPLOAD_GENERATION_CHANGED','Runtime readiness changed during upload. The private file remains quarantined; retry the upload.');
  }
  // This first check precedes remote byte I/O. The second check below locks
  // current authority at the write, so revocation can complete during the read.
  await requireAdmission(client,{firmId,clientId:document.client_id,boundary:'document_register',resourceType:'document',
    lock:false,resourceId:document.id,expectedDependencyDigest:intent.entity_dependency_digest});
  const verificationSignal = AbortSignal.timeout(5000);
  let bytes;
  try {
    bytes = await fetchEvidenceObjectBytes({bucket:intent.bucket,key:intent.key,maxBytes:intent.size,signal:verificationSignal});
  } catch (cause) {
    if (!verificationSignal.aborted) throw cause;
    throw Object.assign(new Error('The uploaded file is saved, but checking its bytes timed out. Retry queuing this file.'), {
      code: 'PILOT_UPLOAD_VERIFICATION_TIMEOUT', statusCode: 503, retryable: true, cause
    });
  }
  if (bytes.length!==intent.size || createHash('sha256').update(bytes).digest('hex')!==intent.checksum) {
    refuse('PILOT_UPLOAD_BYTES_MISMATCH','The stored bytes do not match the upload receipt. The file remains quarantined.');
  }
  if ((!Number.isFinite(Date.parse(intent.expires_at)) || Date.parse(intent.expires_at)<=Date.now())) refuse('PILOT_UPLOAD_GENERATION_CHANGED','The upload receipt expired while verifying the bytes. Retry the upload.');
  await requireAdmission(client,{firmId,clientId:document.client_id,boundary:'document_register',resourceType:'document',
    resourceId:document.id,expectedDependencyDigest:intent.entity_dependency_digest});
  await lockUploadActor(client,{firmId,clientId:document.client_id},actor);
  return { upload_receipt_id:Number(row.id),actor,key:intent.key,checksum:intent.checksum };
};

// Called only after the existing writer inserted its actual document row.
export const releaseCloudPilotRegistration = async ({client,firmId,document,intake}) => {
  if (!intake || intake.replay) return;
  await lockUploadActor(client,{firmId,clientId:document.client_id},intake.actor);
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,$3,$4,'pilot.evidence_upload.released','document',$5,$6::jsonb)`,[firmId,document.client_id,intake.actor.type,intake.actor.id,document.id,
    JSON.stringify({upload_receipt_id:intake.upload_receipt_id,key:intake.key,checksum:intake.checksum,authority_basis:'scoped_principal_and_current_entity_readiness'})]);
};
