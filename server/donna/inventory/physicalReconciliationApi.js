// Narrow authenticated HTTP adapter; inventory and ledger mutations stay in the kernel.
import { assertFirmAccess, getAssignmentRoleForPrincipal, withFirmDbClient } from '../firmDb.js';
import { requireClientInFirm } from '../db/clients.js';
import { clientFlagActs, readClientConfigSnapshot } from '../clientConfig.js';
import { authorizeOperatorAction } from '../operatorCapability.js';
import { registerDocumentInDb } from '../parseDocumentsDb.js';

export const PHYSICAL_RECONCILIATION_PATH = '/inventory/physical-reconciliation';
const fail = (code, message, statusCode = 400) => { throw Object.assign(new Error(message), { code, statusCode }); };
const send = (res, body, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
const enabled = async (client, scope) => {
  const snapshot = await readClientConfigSnapshot(client, { ...scope, strict: true });
  // Pilot enrollment is explicitly per-client; a broad firm/cohort default cannot enroll stock.
  const exact = (await client.query(`select stage from client_capability_config where firm_id=$1 and client_id=$2
    and flag_key='PHYSICAL_RECONCILIATION' and valid_to is null`, [scope.firmId, scope.clientId])).rows[0];
  return Boolean(exact && clientFlagActs({ flagKey: 'PHYSICAL_RECONCILIATION', snapshot, envFallback: () => false }));
};

export async function handlePhysicalReconciliationRequest({ req, res, requestUrl, readBody }) {
  if (!requestUrl.pathname.startsWith(PHYSICAL_RECONCILIATION_PATH)) return false;
  const suffix = requestUrl.pathname.slice(PHYSICAL_RECONCILIATION_PATH.length);
  const match = suffix.match(/^\/([^/]+)(?:\/(observations|resolutions|acknowledgements))?$/);
  const evidence = suffix === '/evidence';
  if (suffix && !match) { send(res, { error: 'Physical check route not found.' }, 404); return true; }
  const write = req.method === 'POST';
  if (!['GET', 'POST'].includes(req.method) || (evidence && !write) || (match?.[2] && !write)) {
    send(res, { error: 'Method not allowed.' }, 405); return true;
  }
  const body = write ? await readBody() : {};
  const firmId = String(body.firm_id || requestUrl.searchParams.get('firm_id') || req.donnaAuth?.firmId || '').trim();
  const clientId = String(body.client_id || requestUrl.searchParams.get('client_id') || '').trim();
  if (!firmId || !clientId) fail('PHYSICAL_SCOPE_REQUIRED', 'Choose a firm and client.');
  const scope = { firmId, clientId };
  const access = await assertFirmAccess({ ...scope, auth: req.donnaAuth, clientIds: [clientId] });
  const principal = access.principal;
  // A shared infrastructure token is not an attributable person.
  if (!['firm_member', 'firm_collaborator'].includes(principal?.principalType) || !principal.principalId) {
    fail('PHYSICAL_PERSON_REQUIRED', 'Sign in with your own account to use physical checks.', 403);
  }
  scope.actorId = principal.principalId;
  scope.actorType = principal.principalType;
  const verb = evidence ? 'register_physical_evidence' : !suffix ? 'open_physical_reconciliation'
    : match?.[2] === 'acknowledgements' ? 'acknowledge_physical_request' : match?.[2] === 'observations' ? 'observe_physical_reconciliation' : 'resolve_physical_reconciliation';
  const authorize = async (client) => {
    await requireClientInFirm({ client, firmId, clientId });
    const current = await assertFirmAccess({ firmId, clientIds: [clientId], resolvedPrincipal: principal, dbClient: client });
    if (!(await enabled(client, scope))) fail('PHYSICAL_RECONCILIATION_DISABLED', 'Physical checks are not enabled for this client.', 403);
    const assignmentRole = await getAssignmentRoleForPrincipal({ ...scope, principal: current.principal, dbClient: client });
    const canReview = authorizeOperatorAction({ principal: current.principal, assignmentRole, actionType: 'resolve_physical_reconciliation' }).allowed;
    if (!write && !canReview) fail('PHYSICAL_REVIEW_AUTHORITY_REQUIRED', 'Physical check review requires a reviewer role.', 403);
    if (write) {
      if (!authorizeOperatorAction({ principal: current.principal, assignmentRole, actionType: verb }).allowed) {
        fail('PHYSICAL_AUTHORITY_REFUSED', 'Your role cannot perform this physical check action.', 403);
      }
      if (match?.[2] === 'resolutions' && ['confirmed_shortage', 'confirmed_found_stock'].includes(body.action)) {
        const snapshot = await readClientConfigSnapshot(client, { ...scope, strict: true });
        if (clientFlagActs({ flagKey: 'INVENTORY_ACCOUNTING', snapshot, envFallback: () => false })
          && !authorizeOperatorAction({ principal: current.principal, assignmentRole, actionType: 'post_inventory_journal' }).allowed) {
          fail('PHYSICAL_POSTING_AUTHORITY_REQUIRED', 'An authorized inventory posting approver must accept this correction.', 403);
        }
      }
    }
    return { canReview };
  };
  // Lock the current authority rows before authorization and hold them through the
  // read/response projection, so a concurrent revocation cannot cross this boundary.
  const authorizedRead = async (client, read) => {
    await client.query('begin');
    try {
      await client.query('select id from clients where firm_id=$1 and id=$2 for update', [firmId, clientId]);
      await client.query(principal.principalType === 'firm_member'
        ? 'select id from firm_members where firm_id=$1 and id=$2 for share'
        : 'select id from firm_collaborators where firm_id=$1 and id=$2 for share', [firmId, scope.actorId]);
      await client.query('select id from client_assignments where firm_id=$1 and client_id=$2 and principal_type=$3 and principal_id=$4 for share', [firmId, clientId, scope.actorType, scope.actorId]);
      await client.query('select id from client_capability_config where firm_id=$1 and (client_id=$2 or client_id is null) for share', [firmId, clientId]);
      const authority = await authorize(client);
      const result = await read(authority);
      await client.query('commit'); return result;
    } catch (error) { await client.query('rollback'); throw error; }
  };
  await withFirmDbClient(authorize);
  if (evidence) {
    const d = body.document || {};
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(d.mime_type) || !(d.file_size > 0 && d.file_size <= 10 * 1024 * 1024)) {
      fail('PHYSICAL_PHOTO_REQUIRED', 'Use a JPEG, PNG or WebP photo up to 10 MB.');
    }
    if (d.client_id !== clientId || !/^[a-f0-9]{64}$/.test(d.checksum_sha256 || '')) fail('PHYSICAL_EVIDENCE_SCOPE', 'Photo client and checksum must match.');
    const result = await registerDocumentInDb({ firmId, uploadPrincipal: principal, evidenceOnly: true, authorize,
      document: { id: d.id, client_id: clientId, filename: d.filename, document_type: 'unknown', document_label: 'Inventory count photo', evidence_purpose: 'physical_inventory_count',
        status: 'received', source: 'browser_photo_upload', storage_provider: d.storage_provider,
        storage_bucket: d.storage_bucket, storage_object_key: d.storage_object_key,
        checksum_sha256: d.checksum_sha256, file_size: d.file_size, mime_type: d.mime_type,
        physical_provenance: { source_kind: 'browser_photo_upload', actor_id: scope.actorId,
          capture_control: 'uploaded', challenge_outcome: 'not_used', continuity: 'not_established', model: 'not_used' } } });
    send(res, { document: result.document }); return true;
  }
  if (match?.[2] === 'acknowledgements') {
    const { acknowledgePhysicalAsk } = await import('./physicalReconciliationAsks.js');
    const result = await withFirmDbClient(async client => {
      await client.query('begin');
      try {
        await authorize(client);
        const receipt = await acknowledgePhysicalAsk({ client, ...scope, sessionId: decodeURIComponent(match[1]), lineId: body.line_id, askId: body.ask_id });
        await client.query('commit'); return receipt;
      } catch (error) { await client.query('rollback'); throw error; }
    });
    send(res, result); return true;
  }
  const kernel = await import('./physicalReconciliationDb.js');
  const result = await withFirmDbClient(async client => {
    const args = { client, ...scope, authorize };
    if (!write) return authorizedRead(client, () => match ? kernel.getPhysicalReconciliation({ ...args, sessionId: decodeURIComponent(match[1]) })
      : kernel.listPhysicalReconciliation(args));
    const idempotencyKey = String(body.idempotency_key || '').trim();
    if (!idempotencyKey || idempotencyKey.length > 200) fail('PHYSICAL_IDEMPOTENCY_REQUIRED', 'A valid request identifier is required.');
    if (!suffix) {
      if (!Array.isArray(body.item_ids) || body.item_ids.length < 5 || body.item_ids.length > 20) fail('PHYSICAL_PILOT_SCOPE', 'Choose 5 to 20 items for this check.');
      return kernel.openPhysicalReconciliation({ ...args, idempotencyKey, locationId: body.location_id, itemIds: body.item_ids });
    }
    const common = { ...args, idempotencyKey, sessionId: decodeURIComponent(match[1]), lineId: body.line_id };
    if (match[2] === 'observations') {
      const observed = await kernel.observePhysicalReconciliation({ ...common,
      observedQuantity: body.observed_quantity, evidenceRefs: body.evidence_refs, observedAt: body.observed_at,
      confidence: body.confidence, uncertain: body.uncertain === true, humanConfirmed: body.human_confirmed === true,
      notes: body.notes, modelReceipt: null });
      return authorizedRead(client, ({ canReview }) => canReview ? observed : captureResult(observed, body.line_id));
    }
    if (match[2] === 'resolutions') return kernel.resolvePhysicalReconciliation({ ...common,
      action: body.action, reason: body.reason, expectedObservationDigest: body.expected_observation_digest, reversesCountOperationId: body.reverses_count_operation_id, countCause: body.count_cause || null, failureClass: body.failure_class, alternateAction: body.alternate_action, reviewSeconds: body.review_seconds });
    fail('PHYSICAL_ROUTE_NOT_FOUND', 'Physical check action not found.', 404);
  });
  send(res, result); return true;
}

// Capture permission conveys only the submitted fact and its handling status.
// Use an allowlist: future kernel accounting/valuation fields stay private by default.
const captureResult = (result, lineId) => ({
  applied: result.applied,
  ...(result.reason ? { reason: result.reason } : {}),
  ...(result.receipt ? { receipt: { sessionId: result.receipt.sessionId, lineId: result.receipt.lineId, replayed: result.receipt.replayed === true } } : {}),
  ...(result.session ? { session: { id: result.session.id, state: result.session.state } } : {}),
  ...(result.lines ? { lines: result.lines.filter(line => String(line.id) === String(lineId)).map(line => ({
    id: line.id, item_id: line.item_id, location_id: line.location_id, physical_status: line.physical_status,
    physical_observation: line.physical_observation ? {
      quantity: line.physical_observation.quantity, observedAt: line.physical_observation.observedAt,
      actorId: line.physical_observation.actorId, uncertain: line.physical_observation.uncertain,
      humanConfirmed: line.physical_observation.humanConfirmed
    } : null,
    payload: { owner: line.payload?.owner ? { actorId: line.payload.owner.actorId, dueAt: line.payload.owner.dueAt, ask: captureAsk(line.payload.owner.ask) } : null }
  })) } : {})
});

const captureAsk = ask => ask ? {
  id: ask.id, status: ask.status, deliveryStatus: ask.deliveryStatus,
  recipient: ask.recipient, dueAt: ask.dueAt
} : null;
