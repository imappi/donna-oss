// Called inside the named answer writer's transaction, after its source locks.
// Processing success repairs the runtime failure; it does not claim the books
// resolved when the writer's persisted outcome asks the owner for clarification.
import { withCodingPolicyIncidentLock } from './codingPolicyRecovery.js';

export const recordOwnerReplyProcessingReceipt = async ({ client, firmId, clientId,
  evidenceRequestId, transactionId = null, actorId, actorType = 'system', processing, metadata = {} }) => {
  return withCodingPolicyIncidentLock({ client, firmId, clientId,
    transactionId: transactionId || evidenceRequestId, operation: 'owner_reply' }, async () => {
    const previous = (await client.query(`select id, action, metadata from audit_events
      where firm_id = $1 and client_id = $2 and resource_type = 'client_evidence_request' and resource_id = $3
        and action in ('evidence_request.reply_processing_failed', 'evidence_request.reply_processed')
      order by id desc limit 1`, [firmId, clientId, evidenceRequestId])).rows[0];
    const recoveredFailureId = previous?.action === 'evidence_request.reply_processing_failed'
      && previous.metadata?.reply_key === processing.reply_key
      && (previous.metadata?.transaction_id || null) === (transactionId || null) ? String(previous.id) : null;
    // A later episode (an outage-exhausted answer re-entering after its
    // cooldown) keeps its episode number on the completed receipt; a first
    // episode writes exactly what it always did.
    const priorEpisode = Number((await client.query(`select response_payload->'reply_processing'->>'episode' as episode
      from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3`, [firmId, clientId, evidenceRequestId])).rows[0]?.episode || 0);
    const persisted = priorEpisode > 1 ? { episode: priorEpisode, ...processing } : processing;
    const outcome = { ...metadata, ...persisted, operation: 'owner_reply', transaction_id: transactionId,
      ...(recoveredFailureId ? { recovered_failure_id: recoveredFailureId } : {}) };
    await client.query(`update client_evidence_requests set response_payload = response_payload || jsonb_build_object('reply_processing', $4::jsonb)
      where firm_id = $1 and client_id = $2 and id = $3`,
    [firmId, clientId, evidenceRequestId, JSON.stringify(persisted)]);
    await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
      values ($1, $2, $6, $3, 'evidence_request.reply_processed', 'client_evidence_request', $4, $5::jsonb)`,
    [firmId, clientId, actorId, evidenceRequestId, JSON.stringify(outcome), actorType]);
    return outcome;
  });
};
