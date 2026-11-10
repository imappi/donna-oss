// Owner answers are durable source work. The existing coding clock resumes the
// same reply writer; normal coding must continue to respect the live-ask fence.
import { ownerReplyIdentity } from './ownerReplyIdentity.js';
import { withFirmDbClient } from './db/pool.js';
import { __recodeTransactionAfterClientReplyWithClient } from './db/asks.js';
import { isCodingPolicyError } from './codingPolicy.js';
import { resolveClientCodingPolicyWithClient } from './db/coding.js';
import { withCodingPolicyIncidentLock } from './codingPolicyRecovery.js';
import { listStructuredOwnerReplyEvidenceTypes, resolveStructuredOwnerReplyAdapter, supportsStructuredOwnerReply } from './statutoryRegistry.js';
import { processStructuredOwnerReplyWithClient } from './structuredOwnerReply.js';
import { documentOwnerReplyDocumentId, processDocumentOwnerReplyWithClient } from './documentOwnerReply.js';
import { deliverOwnerFollowUpWithClient } from './ownerAskDelivery.js';
import { CODER_FINISHED_CODING_STATES, CORRECTION_OUTCOMES, correctionNotRecordedNotice, correctionOf } from './ownerReplyCorrection.js';
import { restoreUnrecordedCorrectionWithClient } from './db/asks.js';

export const OWNER_REPLY_MAX_ATTEMPTS = 3;
// An answer exhausted on a PROVIDER outage (never a policy failure, never a
// changed answer) rests for this long, then re-enters the clock as a new
// episode: the owner did their part; a dead provider must not turn that into
// a question nobody closes. Repeated outages therefore cost one bounded
// episode per cooldown, never an unbounded burst.
export const OWNER_REPLY_OUTAGE_COOLDOWN_MS = 60 * 60_000;
export const OWNER_REPLY_OUTAGE_CODE = 'OWNER_REPLY_PROVIDER_UNAVAILABLE';
export const DISCOVER_OWNER_REPLIES_SQL = `
  select r.id, r.client_id, r.transaction_id from client_evidence_requests r
  left join transactions t on t.firm_id = r.firm_id and t.client_id = r.client_id and t.id = r.transaction_id
  where r.firm_id = $1 and r.status = 'replied'
    and ((r.transaction_id is not null and t.id is not null
          and coalesce(t.coding_state, '') not in ('applied', 'held', 'posted', 'synced', 'closed'))
         -- A line-anchored lane question about the business (the registration
         -- question): its consumer is the lane adapter, whatever its anchor
         -- line's state (processOwnerReplyWithClient re-checks the adapter).
         or (r.transaction_id is not null and r.audience = 'client'
             and r.evidence_type || '#' || coalesce(r.request_payload->>'lane', '') = any($3::text[]))
         or (r.transaction_id is null and r.audience = 'client'
             and (r.evidence_type = any($3::text[])
                  or r.evidence_type || '#' || coalesce(r.request_payload->>'lane', '') = any($3::text[])))
         -- A document-anchored ask: its consumer is the reply-informed
         -- re-disposition (documentOwnerReply.js), lock-step with
         -- documentOwnerReplyDocumentId.
         or (r.transaction_id is null and r.review_item_id is null
             and nullif(btrim(r.request_payload->>'document_id'), '') is not null))
    and (nullif(btrim(r.response_payload->>'reply'), '') is not null
         or jsonb_array_length(coalesce(r.response_payload->'document_ids', '[]'::jsonb)) > 0)
    and coalesce(r.response_payload->'reply_processing'->>'state', '') not in ('completed', 'needs_clarification')
    and (coalesce(r.response_payload->'reply_processing'->>'state', '') <> 'exhausted'
         or r.response_payload->'reply_processing'->>'policy_failure' = 'true'
         or (r.response_payload->'reply_processing'->>'code' = '${OWNER_REPLY_OUTAGE_CODE}'
             and r.updated_at < now() - interval '${OWNER_REPLY_OUTAGE_COOLDOWN_MS} milliseconds'))
  order by r.updated_at, r.id limit $2`;

// The ask an unclear answer left waiting on the owner, whichever consumer read
// it: a structured (factual) reply reopens its own ask with the clarification
// question; a document-only reply resolves the answered ask and mints one
// bounded clarification ask; a bank-line reply under a native chart mints the
// specific follow-up fact ask. (A bank-line reply outside a native chart mints
// nothing here: the model's follow-up rides the next ask batch, whose first
// send is the same gated fan-out.)
export const clarificationFollowUpAskIds = (request, result) => {
  if (!result || (result.applied === false && result.skipped)) return [];
  return [...new Set([
    result.needsClarification ? request?.id : null,
    result.document_disposition?.clarification_request_id || null,
    result.follow_up_request_id || null
  ].filter(Boolean))];
};

// One delivery for all three: the gated fan-out, with the re-ask sweep's
// precedent when nothing delivers (ownerAskDelivery.js). Runs after the
// consumer committed, under this clock's lease and outside any transaction. A
// delivery problem never turns a processed answer into a processing failure.
// A correction (ownerReplyCorrection.js) whose line was finished before the
// coder could read it: no reader can take it now, so nothing on the line
// moves and the question goes back to its closed state, with both receipts.
const restoreUnreadCorrection = async ({ client, firmId, clientId, request, replyKey, reason }) => {
  const correction = correctionOf(request);
  await client.query('begin');
  try {
    const restored = await restoreUnrecordedCorrectionWithClient({ client, firmId, clientId, evidenceRequestId: request.id,
      replyKey, actorId: correction.actor_id || 'system', actorType: correction.actor_type || 'system', reason });
    if (restored) {
      const { recordOwnerReplyProcessingReceipt } = await import('./ownerReplyProcessingReceipt.js');
      await recordOwnerReplyProcessingReceipt({ client, firmId, clientId, evidenceRequestId: request.id, transactionId: request.transaction_id || null,
        actorId: correction.actor_id || 'system', processing: { reply_key: replyKey, state: 'completed', applied: false,
          correction: { ...correction, outcome: CORRECTION_OUTCOMES.notRecorded, reason } } });
    }
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  const profile = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  const notice = correctionNotRecordedNotice({ profile: profile?.profile, client: profile });
  return { applied: false, skipped: reason, correction: { outcome: CORRECTION_OUTCOMES.notRecorded }, owner_notice: notice, owner_notice_statement: notice };
};

const deliverClarificationFollowUp = async ({ client, firmId, clientId, request, result, deliverFollowUp = deliverOwnerFollowUpWithClient }) => {
  const ids = clarificationFollowUpAskIds(request, result);
  if (!ids.length) return result;
  const followUpDelivery = await deliverFollowUp({
    client, firmId, clientId, evidenceRequestIds: ids, surface: 'owner_reply_clarification'
  }).catch((error) => ({ error: error?.message || 'follow_up_failed' }));
  return { ...result, follow_up_delivery: followUpDelivery };
};

export const processOwnerReplyWithClient = async ({ client, firmId, clientId, evidenceRequestId,
  actorId = 'owner_reply_recovery', force = false, expectedReplyKey = null, expectedFailureId = null, recodeFn = __recodeTransactionAfterClientReplyWithClient } = {}) => {
  // Session advisory lease spans provider I/O without keeping an SQL transaction
  // open. A process death releases it; a new owner answer can still be saved.
  const lease = `owner_reply:${firmId}:${evidenceRequestId}`;
  const locked = (await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [lease])).rows[0]?.locked;
  if (!locked) return { applied: false, skipped: 'reply_processing_in_progress' };
  try {
    const request = (await client.query(
      'select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3',
      [firmId, clientId, evidenceRequestId]
    )).rows[0];
    // A line ask is the coder's reply, unless a lane adapter claims it as a
    // question about the business (the registration question).
    const structured = request?.transaction_id
      ? resolveStructuredOwnerReplyAdapter({ request })?.transactionAnchored === true
      : supportsStructuredOwnerReply(request);
    const documentReply = !request?.transaction_id && !structured && Boolean(documentOwnerReplyDocumentId(request));
    if (!request || request.status !== 'replied' || (!request.transaction_id && !structured && !documentReply)) return { applied: false, skipped: 'no_pending_reply' };
    const replyKey = ownerReplyIdentity(request);
    const previous = request.response_payload?.reply_processing || {};
    if (expectedReplyKey && expectedReplyKey !== replyKey) return { applied: false, skipped: 'reply_superseded' };
    if (expectedFailureId) {
      const latest = (await client.query(`select id, metadata from audit_events
        where firm_id = $1 and client_id = $2 and resource_type = 'client_evidence_request' and resource_id = $3
          and action in ('evidence_request.reply_processing_failed', 'evidence_request.reply_processed')
        order by id desc limit 1`, [firmId, clientId, evidenceRequestId])).rows[0];
      if (String(latest?.id) !== String(expectedFailureId) || latest?.metadata?.reply_key !== replyKey
          || (latest?.metadata?.transaction_id || null) !== (request.transaction_id || null)) {
        return { applied: false, skipped: 'reply_failure_superseded' };
      }
    }
    const same = previous.reply_key === replyKey;
    if (!force && same && ['completed', 'needs_clarification'].includes(previous.state)) return { applied: false, skipped: 'reply_already_processed' };
    let attempts = same ? Number(previous.attempts || 0) : 0;
    let episode = same ? Number(previous.episode || 1) : 1;
    const updatedAt = request.updated_at ? new Date(request.updated_at).getTime() : NaN;
    const outageEpisodeDue = same && attempts >= OWNER_REPLY_MAX_ATTEMPTS && !previous.policy_failure
      && previous.code === OWNER_REPLY_OUTAGE_CODE && Number.isFinite(updatedAt) && Date.now() - updatedAt >= OWNER_REPLY_OUTAGE_COOLDOWN_MS;
    if (outageEpisodeDue) {
      attempts = 0; episode += 1;
      // The new episode is receipted on the row before any provider call so
      // the completed receipt (written by the answer writer) keeps its number.
      await client.query(`update client_evidence_requests set response_payload = jsonb_set(response_payload, '{reply_processing,episode}', to_jsonb($4::int))
        where firm_id = $1 and client_id = $2 and id = $3`, [firmId, clientId, evidenceRequestId, episode]);
    }
    if (!force && attempts >= OWNER_REPLY_MAX_ATTEMPTS && !previous.policy_failure) return { applied: false, skipped: 'reply_attempts_exhausted' };
    const tx = request.transaction_id ? (await client.query('select coding_state, transaction_date from transactions where firm_id = $1 and client_id = $2 and id = $3', [firmId, clientId, request.transaction_id])).rows[0] : null;
    if (request.transaction_id && !structured && (!tx || CODER_FINISHED_CODING_STATES.includes(tx.coding_state))) {
      return correctionOf(request) ? restoreUnreadCorrection({ client, firmId, clientId, request, replyKey, reason: 'terminal_or_missing_transaction' })
        : { applied: false, skipped: 'terminal_or_missing_transaction' };
    }
    let result;
    try {
      if (documentReply) {
        result = await processDocumentOwnerReplyWithClient({ client, firmId, request, expectedReplyKey: replyKey, attempts, actorId });
        return await deliverClarificationFollowUp({ client, firmId, clientId, request, result });
      }
      if (structured) {
        result = await processStructuredOwnerReplyWithClient({ client, firmId, request, expectedReplyKey: replyKey, attempts });
        return await deliverClarificationFollowUp({ client, firmId, clientId, request, result });
      }
      // Exhausted policy failures may inspect repaired configuration without
      // buying another model call or extending the bounded failure history.
      if (same && previous.policy_failure && attempts >= OWNER_REPLY_MAX_ATTEMPTS) {
        await resolveClientCodingPolicyWithClient({ client, firmId, clientId, businessDate: tx.transaction_date });
      }
      result = await recodeFn({ client, firmId, clientId, transactionId: request.transaction_id,
        evidenceRequest: request, reply: request.response_payload?.reply || '',
        replyDocumentIds: request.response_payload?.document_ids || [], actorId, expectedReplyKey: replyKey });
      if (result?.skipped === 'terminal_or_missing_transaction' && correctionOf(request)) {
        return await restoreUnreadCorrection({ client, firmId, clientId, request, replyKey, reason: result.skipped });
      }
      if (result?.skipped === 'llm_unavailable') {
        const error = new Error('Reply coding is temporarily unavailable.');
        error.code = 'OWNER_REPLY_PROVIDER_UNAVAILABLE';
        throw error;
      }
      return await deliverClarificationFollowUp({ client, firmId, clientId, request, result });
    } catch (error) {
      if (error?.code === 'OWNER_REPLY_SUPERSEDED') return { applied: false, skipped: 'reply_superseded' };
      const policyFailure = isCodingPolicyError(error);
      const nextAttempts = Math.min(OWNER_REPLY_MAX_ATTEMPTS, attempts + 1);
      // Bound repeated outage receipts, but never suppress a different failure.
      if (!(same && attempts >= OWNER_REPLY_MAX_ATTEMPTS && previous.code === error?.code && !force)) {
        await client.query('begin');
        try {
          const current = (await client.query('select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3 for update', [firmId, clientId, evidenceRequestId])).rows[0];
          if (current?.status === 'replied' && ownerReplyIdentity(current) === replyKey && (current.transaction_id || null) === (request.transaction_id || null)) {
            const processing = { reply_key: replyKey, state: nextAttempts >= OWNER_REPLY_MAX_ATTEMPTS ? 'exhausted' : 'retry_pending', attempts: nextAttempts,
              ...(episode > 1 ? { episode } : {}),
              code: error?.code || 'OWNER_REPLY_PROCESSING_FAILED', policy_failure: policyFailure,
              actor_id: previous.actor_id, actor_type: previous.actor_type,
              ...(error?.interpretation ? { interpretation: error.interpretation } : {}),
              message: policyFailure ? 'Coding configuration needs repair.' : 'Your answer is saved, but processing could not finish.' };
            await withCodingPolicyIncidentLock({ client, firmId, clientId, transactionId: request.transaction_id || evidenceRequestId, operation: 'owner_reply' }, async () => {
              const receipt = await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
                values ($1, $2, 'system', $3, 'evidence_request.reply_processing_failed', 'client_evidence_request', $4, $5::jsonb) returning id`,
                [firmId, clientId, actorId, evidenceRequestId, JSON.stringify({ ...processing, operation: 'owner_reply', transaction_id: request.transaction_id })]);
              processing.failure_id = String(receipt.rows[0].id);
              await client.query(`update client_evidence_requests set response_payload = response_payload || jsonb_build_object('reply_processing', $4::jsonb), updated_at = now()
              where firm_id = $1 and client_id = $2 and id = $3`, [firmId, clientId, evidenceRequestId, JSON.stringify(processing)]);
            });
          }
          await client.query('commit');
        } catch (receiptError) { await client.query('rollback'); throw receiptError; }
      }
      return { applied: false, error: error?.message || 'Reply processing failed.', code: error?.code || 'OWNER_REPLY_PROCESSING_FAILED',
        policy_failure: policyFailure, retry_pending: nextAttempts < OWNER_REPLY_MAX_ATTEMPTS, exhausted: nextAttempts >= OWNER_REPLY_MAX_ATTEMPTS,
        ...(error?.documentDisposition ? { document_disposition: error.documentDisposition } : {}) };
    }
  } finally { await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lease]); }
};

export const retryOwnerReplyProcessingInDb = async ({ firmId, clientId, transactionId, evidenceRequestId,
  actorId = 'owner_reply_recovery', force = true, expectedReplyKey = null, expectedFailureId = null } = {}) => withFirmDbClient(async (client) => {
  const rows = (await client.query(`select id from client_evidence_requests
    where firm_id = $1 and client_id = $2 and status = 'replied'
      and ($3::text is null or transaction_id = $3) and ($4::text is null or id = $4)
    order by updated_at, id limit 25`, [firmId, clientId, transactionId || null, evidenceRequestId || null])).rows;
  const results = [];
  for (const row of rows) results.push({ evidence_request_id: row.id, ...await processOwnerReplyWithClient({ client, firmId, clientId, evidenceRequestId: row.id, actorId, force, expectedReplyKey, expectedFailureId }) });
  return { eligible_replies: rows.length, results };
});

export const recoverOwnerRepliesInDb = async ({ firmId, limit = 10, runWorkerAdmissionFn = async ({ work }) => work() } = {}) => {
  const rows = await withFirmDbClient(async (client) => (await client.query(DISCOVER_OWNER_REPLIES_SQL, [firmId, limit, listStructuredOwnerReplyEvidenceTypes()])).rows);
  const results = [];
  for (const row of rows) {
    try {
      const result = await runWorkerAdmissionFn({ firmId, clientId: row.client_id, work: () => withFirmDbClient((client) => processOwnerReplyWithClient({ client, firmId, clientId: row.client_id, evidenceRequestId: row.id })) });
      results.push({ evidence_request_id: row.id, client_id: row.client_id, ...result });
    } catch (error) { results.push({ evidence_request_id: row.id, client_id: row.client_id, error: error?.message || String(error) }); }
  }
  return results;
};
