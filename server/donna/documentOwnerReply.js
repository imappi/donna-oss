// The owner-reply consumer for a document-anchored ask (transaction_id null,
// the document id in request_payload): ONE reply-informed re-disposition of
// that document (runOwnerReplyRedisposition), shared by the inline reply leg
// and the existing owner-reply clock (ownerReplyRecovery.js). The clock owns
// the advisory lease, the attempt bound, the outage cooldown and the failure
// receipts; this module only maps the re-disposition's outcome onto them.
import { clientFlagActs, readClientConfigSnapshot } from './clientConfig.js';
import { readLaneDecidingPolicy } from './modelLanePolicy.js';
import { DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY } from './documentDispositionShape.js';
import { assertCurrentOwnerReply } from './ownerReplyIdentity.js';
import { recordOwnerReplyProcessingReceipt } from './ownerReplyProcessingReceipt.js';

// The document a reply re-disposes, or null when the ask is not document-only.
export const documentOwnerReplyDocumentId = (request) => (!request?.transaction_id && !request?.review_item_id
  ? String(request?.request_payload?.document_id || '').trim() || null
  : null);

// Re-disposition outcomes that can never succeed on a retry of the same answer.
const SOURCE_INVALID_SKIPS = new Set(['missing_ids', 'document_not_found']);
// Outcomes that are not a provider gap (the re-disposition reached its own
// write and it did not land, or a live-match resolve rolled back).
const PROCESSING_FAILED_SKIPS = new Set(['live_match']);

// Gated on the SAME plane flag the ask leg acts under. Dynamic import: the
// static chain documentDispositionLlm → reconciliationLlmCore → firmDb is a cycle.
export const redisposeDocumentOwnerReplyWithClient = async ({ client, firmId, request, actorId = 'system' }) => {
  const clientId = request.client_id;
  const documentId = documentOwnerReplyDocumentId(request);
  const snapshot = await readClientConfigSnapshot(client, { firmId, clientId });
  if (!clientFlagActs({ flagKey: DOCUMENT_NO_LINE_DISPOSITION_FLAG_KEY, snapshot, envFallback: () => false })) {
    // F8 flag-down: receipt WHY the answer rests so it is explicable from
    // the audit trail alone.
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'system', $3, 'evidence_request.reply_unprocessed', 'client_evidence_request', $4, $5::jsonb)`,
      [firmId, clientId, actorId, request.id, JSON.stringify({ document_id: documentId, reason: 'disposition_flag_inactive' })]
    );
    return { skipped: 'disposition_flag_inactive', request_resolved: false };
  }
  const { runOwnerReplyRedisposition } = await import('./documentDispositionLlm.js');
  // The #1748 shape: the reconciliation_reasoning lane's seat decides when a
  // non-claude rung is seated. Best-effort read; null ⇒ the strong default.
  let decidingPolicy = null;
  try {
    decidingPolicy = await readLaneDecidingPolicy({ client, firmId, clientId, laneId: 'reconciliation_reasoning' });
  } catch { decidingPolicy = null; }
  return runOwnerReplyRedisposition({
    client, firmId, clientId, documentId,
    evidenceRequestId: request.id,
    answeredEvidenceType: request.evidence_type || 'payment_method',
    askedQuestion: request.question || '',
    ownerReply: request.response_payload?.reply || '',
    replyDocumentIds: request.response_payload?.document_ids || [],
    actorId,
    decidingPolicy
  });
};

// Called by processOwnerReplyWithClient under its lease. Throws a coded error
// for the clock's bounded failure receipt; on a consequence (the ask resolved
// by a verdict, a live match, or a resolved ask plus a clarification asked of
// the owner) writes the completed processing receipt.
export const processDocumentOwnerReplyWithClient = async ({ client, firmId, request, expectedReplyKey, attempts = 0, actorId = 'system' }) => {
  const persisted = (await client.query('select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3',
    [firmId, request.client_id, request.id])).rows[0];
  assertCurrentOwnerReply(persisted, expectedReplyKey);
  const disposition = await redisposeDocumentOwnerReplyWithClient({ client, firmId, request: persisted, actorId });
  if (!disposition?.request_resolved) {
    const skipped = disposition?.skipped || null;
    const code = skipped === 'disposition_flag_inactive' ? 'OWNER_REPLY_CONSUMER_INACTIVE'
      : SOURCE_INVALID_SKIPS.has(skipped) ? 'OWNER_REPLY_SOURCE_INVALID'
        : !skipped || PROCESSING_FAILED_SKIPS.has(skipped) ? 'OWNER_REPLY_PROCESSING_FAILED'
          : 'OWNER_REPLY_PROVIDER_UNAVAILABLE';
    throw Object.assign(new Error('The document answer could not be processed.'), { code, documentDisposition: disposition });
  }
  const processing = { reply_key: expectedReplyKey, state: 'completed', attempts: attempts + 1,
    driven_action: disposition.lane?.kind === 'owner_ask' ? 'owner_clarification'
      : disposition.lane?.kind === 'owner_ask_exhausted' ? 'owner_clarification_exhausted'
        : disposition.skipped === 'live_match' ? 'live_match' : 'document_redisposition',
    disposition: disposition.disposition || null,
    ...(disposition.clarification_request_id ? { clarification_request_id: disposition.clarification_request_id } : {}) };
  await recordOwnerReplyProcessingReceipt({ client, firmId, clientId: request.client_id, evidenceRequestId: request.id,
    actorId, processing, metadata: { document_id: documentOwnerReplyDocumentId(persisted) } });
  return { applied: true, document_disposition: disposition };
};
