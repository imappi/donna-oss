// A separately authenticated, deliberately tiny capture surface. A task cookie is
// never recognized by the firm API, chat, review, resolution or posting routes.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { withFirmDbClient, assertFirmAccess } from '../firmDb.js';
import { registerDocumentInDb } from '../parseDocumentsDb.js';
import { createCloudPilotUpload } from '../cloudEvidenceIntake.js';
import { createEvidenceSignedUploadUrl, buildEvidenceStorageKey, storeLocalEvidenceBytes } from '../evidenceStorage.js';
import { observePhysicalReconciliation } from './physicalReconciliationDb.js';
import { authorizeCaptureCredential, captureAudit, captureFail, captureTaskView, captureTransaction,
  createCaptureTask, exchangeCaptureInvitation, listCaptureRecipients, manageCaptureTask, requestKey, secretHash } from './captureAccessDb.js';

export const CAPTURE_API_PATH = '/api/donna/physical';
export const CAPTURE_COOKIE = '__Secure-donna_capture';
const taskIdPattern = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const send = (res, body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const headers = res => {
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
};
const cookie = req => {
  const values = String(req.headers.cookie || '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${CAPTURE_COOKIE}=`));
  return values.length === 1 ? values[0].slice(CAPTURE_COOKIE.length + 1) : '';
};
const csrfFor = credential => secretHash(`donna.capture.csrf:${credential}`);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const csrf = (req, credential, publicOrigin) => {
  const origin = publicOrigin || `http://${req.headers.host}`;
  if (!same(req.headers.origin, new URL(origin).origin)) captureFail('CAPTURE_ORIGIN_REFUSED');
  if (credential && !same(req.headers['x-donna-capture-csrf'], csrfFor(credential))) captureFail('CAPTURE_CSRF_REFUSED');
};
const scopeFrom = body => {
  if (!body.firm_id || !body.client_id || typeof body.firm_id !== 'string' || typeof body.client_id !== 'string') captureFail('CAPTURE_SCOPE_REQUIRED', 400);
  return { firmId: body.firm_id, clientId: body.client_id };
};
const validLine = async (client, task, lineId) => {
  if (!/^[1-9][0-9]*$/.test(String(lineId))) captureFail('CAPTURE_LINE_REFUSED');
    const row = (await client.query(`select id,physical_status,physical_observation from inventory_count_lines where firm_id=$1 and client_id=$2 and count_session_id=$3 and id=$4 for share`,
    [task.firm_id, task.client_id, task.count_session_id, lineId])).rows[0];
  if (!row) captureFail('CAPTURE_LINE_REFUSED');
  return row;
};
// Capture can submit one factual version per reviewer-opened attempt. Both
// matched and unresolved counts have the same boundary, so trial quantities
// and upload probes cannot disclose the hidden expectation.
const alreadyReceived = line => Boolean(line.physical_observation) || ['matched','dismissed','applied'].includes(line.physical_status);
const refuseReceived = line => { if (alreadyReceived(line)) captureFail('CAPTURE_ALREADY_RECEIVED', 409); };
const authorized = (id, credential, work) => withFirmDbClient(client => captureTransaction(client, async () => {
  const current = await authorizeCaptureCredential(client, id, credential);
  return work(client, current);
}));

const uploadPhoto = async (req, id, credential, body) => {
  requestKey(body.idempotency_key);
  if (!['image/png','image/jpeg','image/webp'].includes(body.mime_type) || typeof body.base64 !== 'string'
    || body.base64.length > 2800000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) captureFail('CAPTURE_PHOTO_REQUIRED', 400);
  const bytes = Buffer.from(body.base64, 'base64');
  // Fits the hosted request body ceiling; native/resumable transport is deferred.
  if (!bytes.length || bytes.length > 2 * 1024 * 1024) captureFail('CAPTURE_PHOTO_TOO_LARGE', 413);
  const mime = bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
    : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
    : bytes.toString('ascii',0,4) === 'RIFF' && bytes.toString('ascii',8,12) === 'WEBP' ? 'image/webp' : null;
  if (mime !== body.mime_type) captureFail('CAPTURE_PHOTO_REQUIRED', 400);
  const byteHash = createHash('sha256').update(bytes).digest('hex');
  const filename = String(body.filename || 'count-photo').replace(/[^\w.\-]/g, '_').slice(-120);
  const input = { lineId: String(body.line_id), checksum: byteHash, size: bytes.length, mime: body.mime_type, filename };
  const find = async client => (await client.query(`select metadata from audit_events where action='inventory.capture.upload_staged'
    and resource_type='inventory_capture_task' and resource_id=$1 and metadata->>'request_key'=$2 order by id desc limit 1`, [id, body.idempotency_key])).rows[0]?.metadata;
  const prepare = async (client, current) => {
    const line = await validLine(client, current.task, body.line_id);
    refuseReceived(line);
    const prior = await find(client);
    if (prior && JSON.stringify(prior.input) !== JSON.stringify(input)) {
      // JSONB key order is not presentation order.
      if (secretHash(JSON.stringify(Object.entries(prior.input).sort())) !== secretHash(JSON.stringify(Object.entries(input).sort()))) captureFail('CAPTURE_IDEMPOTENCY_CONFLICT', 409);
    }
    return { ...current, prior };
  };
  let state = await authorized(id, credential, prepare);
  let intent = state.prior;
  if (!intent) {
    const bucket = process.env.DONNA_EVIDENCE_BUCKET || process.env.SUPABASE_EVIDENCE_BUCKET || 'donna-evidence';
    const candidateId = randomUUID();
    const signal = AbortSignal.timeout(10000);
    const pilot = await createCloudPilotUpload({ ...state.scope, principal: state.principal, bucket, filename, checksum: byteHash, size: bytes.length, mimeType: body.mime_type });
    const key = pilot?.key || buildEvidenceStorageKey({ ...state.scope, filename, checksum: byteHash, evidenceRequestId: candidateId });
    intent = await authorized(id, credential, async (client, current) => {
      const raced = await prepare(client, current);
      if (raced.prior) return raced.prior;
      const value = { request_key: body.idempotency_key, input, document_id: candidateId, bucket, key,
        provider: pilot?.provider || (process.env.DONNA_DESKTOP_BLOB_DIR ? 'local_blob' : 'supabase_storage') };
      await captureAudit(client, current.task, current.principal, 'inventory.capture.upload_staged', value);
      signal.throwIfAborted(); return value;
    });
  }
  // No checkout or transaction is held across storage I/O, and no signed URL
  // leaves this adapter. Revocation during I/O prevents the registration below.
  await authorized(id, credential, prepare);
  const existing = await withFirmDbClient(async client => (await client.query('select id from documents where firm_id=$1 and client_id=$2 and id=$3 and checksum_sha256=$4', [state.scope.firmId, state.scope.clientId, intent.document_id, byteHash])).rows[0]);
  if (!existing) {
    if (intent.provider === 'local_blob') await storeLocalEvidenceBytes({ bucket: intent.bucket, key: intent.key, bytes, contentType: body.mime_type });
    else {
      const signal = AbortSignal.timeout(10000);
      const signed = await createEvidenceSignedUploadUrl({ bucket: intent.bucket, key: intent.key, expiresIn: 60, signal });
      const response = await fetch(signed.signed_url, { method: 'PUT', headers: { 'Content-Type': body.mime_type, 'x-upsert': 'false' }, body: bytes, signal });
      // An interrupted prior PUT may have committed. Only the canonical byte
      // verifier can admit it; a storage conflict alone is never success.
      if (!response.ok && ![400,409].includes(response.status)) captureFail('CAPTURE_STORAGE_UNAVAILABLE', 503);
    }
  }
  const authorize = async client => {
    const current = await authorizeCaptureCredential(client, id, credential);
    const line = await validLine(client, current.task, body.line_id);
    refuseReceived(line);
  };
  await registerDocumentInDb({ ...state.scope, uploadPrincipal: state.principal, evidenceOnly: true, authorize,
    document: { id: intent.document_id, client_id: state.scope.clientId, filename, mime_type: body.mime_type, file_size: bytes.length,
      storage_provider: intent.provider, storage_bucket: intent.bucket, storage_object_key: intent.key, checksum_sha256: byteHash,
      document_type: 'unknown', status: 'received', source: 'browser_photo_upload', evidence_purpose: 'physical_inventory_count',
      physical_provenance: { task_id: id, actor_id: state.principal.principalId, source_kind: 'browser_photo_upload', capture_control: 'uploaded', continuity: 'not_established', model: 'not_used' } } });
  return authorized(id, credential, async (client, current) => {
    const document = (await client.query('select id from documents where firm_id=$1 and client_id=$2 and id=$3 and checksum_sha256=$4 for share',
      [current.scope.firmId, current.scope.clientId, intent.document_id, byteHash])).rows[0];
    if (!document) captureFail('CAPTURE_EVIDENCE_REFUSED');
    const prior = (await client.query(`select id from audit_events where resource_type='inventory_capture_task' and resource_id=$1
      and action='inventory.capture.evidence_admitted' and metadata->>'document_id'=$2 limit 1`, [id, document.id])).rows[0];
    if (!prior) await captureAudit(client, current.task, current.principal, 'inventory.capture.evidence_admitted', { document_id: document.id, line_id: String(body.line_id), checksum: byteHash });
    return { received: true, evidence: { documentId: document.id, checksum: byteHash } };
  });
};

export async function handleCaptureAccessRequest({ req, res, requestUrl, readBody, resolveAuth, publicOrigin }) {
  if (!(requestUrl.pathname === CAPTURE_API_PATH || requestUrl.pathname.startsWith(`${CAPTURE_API_PATH}/`))) return false;
  headers(res);
  try {
    const suffix = requestUrl.pathname.slice(CAPTURE_API_PATH.length);
    const manager = suffix.match(new RegExp(`^/tasks(?:/(${taskIdPattern})/(invitation|revoke))?$`));
    const worker = suffix.match(new RegExp(`^/capture/tasks/(${taskIdPattern})(?:/(uploads|responses))?$`));
    const exchange = suffix === '/capture/exchange';
    if (!manager && !worker && !exchange) { send(res, { code: 'CAPTURE_ROUTE_NOT_FOUND' }, 404); return true; }
    const managerRead = manager && !manager[1] && req.method === 'GET';
    if (!managerRead && ((worker && !worker[2] && req.method !== 'GET') || ((!worker || worker[2]) && req.method !== 'POST'))) {
      send(res, { code: 'CAPTURE_METHOD_REFUSED' }, 405); return true;
    }
    const credential = cookie(req);
    if (req.method === 'POST') csrf(req, worker ? credential : null, publicOrigin);
    const body = req.method === 'POST' ? await readBody({ maxBytes: 3 * 1024 * 1024 }) : Object.fromEntries(requestUrl.searchParams);
    if (manager || exchange) {
      const auth = await resolveAuth(req);
      if (!auth || auth.type !== 'supabase_user') captureFail('CAPTURE_PERSON_REQUIRED', 401);
      let scope;
      if (manager) scope = scopeFrom(body);
      else {
        if (!/^[A-Za-z0-9_-]{43}$/.test(body.invitation || '')) captureFail('CAPTURE_INVITATION_REFUSED');
        scope = await withFirmDbClient(async client => {
          const task = (await client.query('select firm_id,client_id from inventory_capture_tasks where invitation_hash=$1', [secretHash(body.invitation)])).rows[0];
          if (!task) captureFail('CAPTURE_INVITATION_REFUSED');
          return { firmId: task.firm_id, clientId: task.client_id };
        });
      }
      const { principal } = await assertFirmAccess({ firmId: scope.firmId, clientIds: [scope.clientId], auth });
      const result = await withFirmDbClient(client => captureTransaction(client, () => managerRead
        ? listCaptureRecipients(client, scope, principal, body.session_id) : manager
        ? manager[1] ? manageCaptureTask(client, scope, principal, manager[1], manager[2], body) : createCaptureTask(client, scope, principal, body)
        : exchangeCaptureInvitation(client, body.invitation, principal)));
      if (exchange) {
        res.setHeader('Set-Cookie', `${CAPTURE_COOKIE}=${result.credential}; Path=${CAPTURE_API_PATH}/capture; Max-Age=1800; Secure; HttpOnly; SameSite=Strict`);
        send(res, { taskId: result.taskId, csrf: csrfFor(result.credential) });
      } else send(res, result);
      return true;
    }
    const id = worker[1];
    if (!worker[2]) {
      const view = await authorized(id, credential, (client, { task }) => captureTaskView(client, task));
      send(res, { ...view, csrf: csrfFor(credential) }); return true;
    }
    if (worker[2] === 'uploads') { send(res, await uploadPhoto(req, id, credential, body)); return true; }
    requestKey(body.idempotency_key);
    const state = await authorized(id, credential, async (client, current) => { await validLine(client, current.task, body.line_id); return current; });
    const evidenceRefs = body.evidence_refs;
    if (!Array.isArray(evidenceRefs) || !evidenceRefs.length || evidenceRefs.length > 10) captureFail('CAPTURE_EVIDENCE_REQUIRED', 400);
    const observationKey = `task:${id}:${secretHash(body.idempotency_key)}`;
    const authorize = async client => {
      const current = await authorizeCaptureCredential(client, id, credential);
      const line = await validLine(client, current.task, body.line_id);
      if (alreadyReceived(line)) {
        // This is only a replay eligibility lookup. The canonical writer still
        // verifies the entire input hash and current authority before replay.
        const prior = (await client.query(`select receipt from inventory_command_receipts
          where firm_id=$1 and client_id=$2 and idempotency_key=$3`,
          [current.scope.firmId, current.scope.clientId, `physical:${current.scope.firmId}:${current.scope.clientId}:observe:${observationKey}`])).rows[0]?.receipt;
        if (!prior || String(prior.sessionId) !== String(current.task.count_session_id) || String(prior.lineId) !== String(body.line_id)) {
          captureFail('CAPTURE_ALREADY_RECEIVED', 409);
        }
      }
      for (const ref of evidenceRefs) {
        const admitted = (await client.query(`select id from audit_events where firm_id=$1 and client_id=$2 and action='inventory.capture.evidence_admitted'
          and resource_type='inventory_capture_task' and resource_id=$3 and metadata->>'document_id'=$4 and metadata->>'line_id'=$5 and metadata->>'checksum'=$6 limit 1`,
          [current.scope.firmId, current.scope.clientId, id, ref?.documentId, String(body.line_id), ref?.checksum])).rows[0];
        if (!admitted) captureFail('CAPTURE_EVIDENCE_REFUSED');
      }
    };
    const result = await withFirmDbClient(client => observePhysicalReconciliation({ client, ...state.scope,
      actorId: state.principal.principalId, actorType: state.principal.principalType, authorize,
      sessionId: String(state.task.count_session_id), lineId: String(body.line_id), idempotencyKey: observationKey,
      observedQuantity: body.observed_quantity, evidenceRefs, observedAt: body.observed_at,
      uncertain: body.uncertain === true, humanConfirmed: body.human_confirmed === true, confidence: null, modelReceipt: null,
      notes: { capture_task_id: id, source_kind: 'browser_photo_upload', blind_count: true } }));
    if (!result.applied) { send(res, { received: false, code: result.reason }, 409); return true; }
    // The kernel returns reviewer data; this adapter returns only acknowledgment.
    const response = await authorized(id, credential, () => ({ received: true, lineId: String(body.line_id), replayed: result.receipt.replayed === true }));
    send(res, response); return true;
  } catch (error) {
    // Never serialize provider errors, request bodies, secrets or raw storage URLs.
    send(res, { code: error.code?.startsWith('CAPTURE_') || error.code?.startsWith('PHYSICAL_EVIDENCE_') ? error.code : 'CAPTURE_REQUEST_REFUSED' }, error.statusCode || 500);
    return true;
  }
}
