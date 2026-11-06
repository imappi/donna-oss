// Donna Loops — Phase 3: evidence-reply auto-resume processor.
//
// When a client reply lands against an evidence case that is parked in
// waiting_client, the Phase-1 producer (loopsShadowProducers.onClientReplyReceived)
// records a `client_reply.received` row in loop_event_inbox — and then nothing
// happens: the missing_client_answer blocker stays open, the case stays
// waiting_client until a human notices. This module is the CONSUMER: it reads the
// queued event, records the reply AS EVIDENCE (INV-12), resolves the blocker, and
// re-activates the case (waiting_client → open via rebuildCaseStatus), then
// enqueues a NON-DISPATCHED proposal_rerun.requested outbox row.
//
// Shadow-scope (the v1 autonomy boundary, contract §7): this moves WORKFLOW state
// only. It does NOT call the strong model to regenerate the proposal, post to the
// ledger, send anything client-visible, or mint memory — the outbox row records
// the intent; a later flag-on phase dispatches it. The reply is untrusted content
// (§6): it is sanitized to evidence here, and when the LLM proposal surface lands,
// filterUntrustedActions (untrustedContent.js) is the gate on any action it emits.
//
// Pure processing: the caller (the inbox drainer) owns the transaction.

import {
  openOrFindCase, appendCaseEvent, linkObject, resolveBlocker
} from './caseManager.js';
import { enqueueOutbox } from './loopEventOutbox.js';
import { sanitizeUntrustedText } from './untrustedContent.js';
import { closeAnsweredCodingCases } from './codingCloseProducer.js';

// Process one claimed `client_reply.received` inbox event. Returns an outcome
// object; throws only on a genuine DB error (the drainer turns that into a
// markFailed + rollback).
export const resumeFromClientReply = async ({ client, event } = {}) => {
  if (!client || !event) return { resumed: false, reason: 'no_event' };
  const firmId = event.firm_id;
  const clientId = event.client_id;
  const evidenceRequestId = event.object_id;
  if (!firmId || !clientId || !evidenceRequestId) return { resumed: false, reason: 'incomplete_event' };

  // The loop reads persisted state: pull the authoritative reply. response_payload
  // holds { reply, document_ids } (firmDb.resolveClientEvidenceRequestInDb).
  const reqRes = await client.query(
    `select id, transaction_id, status, response_payload
       from client_evidence_requests
      where id = $1 and firm_id = $2 and client_id = $3
      limit 1`,
    [evidenceRequestId, firmId, clientId]
  );
  const request = reqRes.rows[0] || null;
  const replyText = String(request?.response_payload?.reply || '');
  const documentIds = Array.isArray(request?.response_payload?.document_ids)
    ? request.response_payload.document_ids.filter(Boolean)
    : [];

  // Untrusted content (§6): quarantine the reply as evidence + annotate any
  // embedded injection attempt. Never stored or used as an instruction.
  const sanitized = sanitizeUntrustedText({ source: 'client_reply', text: replyText });

  // Idempotent find of the evidence case (the Phase-1 producer created it).
  const kase = await openOrFindCase({
    client, firmId, clientId, caseType: 'evidence',
    primaryObject: { type: 'client_evidence_request', id: evidenceRequestId }
  });
  if (!kase) return { resumed: false, reason: 'no_case' };

  // Record the reply AS EVIDENCE: the sanitized text + injection annotation,
  // actor_type = client. The raw text is never carried as an instruction.
  const resumedEvent = await appendCaseEvent({
    client, firmId, clientId, caseId: kase.id,
    eventType: 'client_reply.resumed', actorType: 'client',
    triggerEventId: event.id,
    objectType: 'client_evidence_request', objectId: evidenceRequestId,
    payload: {
      reply_evidence: sanitized.safe_text,
      injection_detected: sanitized.injection_detected,
      injection_signals: sanitized.injection_signals,
      document_ids: documentIds,
      transaction_id: request?.transaction_id || event.payload?.transaction_id || null
    }
  });

  // Link the reply (idempotent; Phase-1 already linked it) + any attached docs.
  await linkObject({
    client, firmId, clientId, caseId: kase.id,
    objectType: 'client_evidence_request', objectId: evidenceRequestId, role: 'client_reply'
  });
  for (const docId of documentIds) {
    await linkObject({
      client, firmId, clientId, caseId: kase.id,
      objectType: 'document', objectId: docId, role: 'evidence'
    });
  }

  // Resolve the missing_client_answer blocker(s) for this request → resolveBlocker
  // re-projects the status (waiting_client → open, unless another blocker outranks).
  const blockerRes = await client.query(
    `select id from bookkeeping_case_blockers
      where case_id = $1 and blocker_type = 'missing_client_answer' and status = 'open'
        and coalesce(object_type, '') in ('', 'client_evidence_request')
        and coalesce(object_id, '') in ('', $2)
      order by created_at asc`,
    [kase.id, evidenceRequestId]
  );
  let resolvedBlockers = 0;
  let status = null;
  for (const b of blockerRes.rows) {
    const r = await resolveBlocker({
      client, blockerId: b.id,
      resolutionEventId: resumedEvent?.id || null,
      reason: 'Client reply received.'
    });
    if (r.resolved) { resolvedBlockers += 1; status = r.status; }
  }

  // Request a proposal re-run — NON-DISPATCHED. No LLM here; the outbox row records
  // the intent only, for the flag-on / surfacing phase to pick up (INV-8: a
  // `dispatched` status means a REAL side effect, which no Phase-3 code emits).
  await enqueueOutbox({
    client, firmId, clientId,
    eventType: 'proposal_rerun.requested',
    objectType: 'client_evidence_request', objectId: evidenceRequestId,
    payload: {
      case_id: kase.id,
      trigger: 'client_reply',
      injection_detected: sanitized.injection_detected,
      has_documents: documentIds.length > 0
    }
  });

  // §6.2 cascade signal: the evidence GOAL ("the client answered") is now met (its
  // missing_client_answer blocker cleared), so emit the `case.resolved` cascade row.
  // The Step-7 dispatcher fans `dependency.resolved` out to every CODING case this
  // evidence case blocks, which re-evaluates "are all my questions answered?". This
  // is a Keep-layer side effect, not a verdict — enqueued inside the drain txn
  // (INV-8), held at shadow, fanning to zero when the evidence case blocks nothing.
  let codingClosed = { closedCases: 0, resolvedBlockers: 0 };
  if (resolvedBlockers > 0) {
    await enqueueOutbox({
      client, firmId, clientId,
      eventType: 'case.resolved',
      objectType: 'bookkeeping_case', objectId: kase.id,
      payload: {
        case_id: kase.id, via: 'client_reply',
        idempotencyKey: `case_resolved:evidence:${kase.id}:${event.id}`
      }
    });

    // The §6.2 CLOSE half (codingCloseProducer): if this reply answered the LAST
    // outstanding question a coding (ask-batch) case is blocked on, resolve that
    // batch's missing_client_answer blocker AND persist its met GoalReport now —
    // so the coding verdict and the blocker ladder move together (the dispatcher's
    // read-only wake would mint the verdict but resolve nothing). Runs in THIS drain
    // txn, like the resume's other workflow mutations; a reply that completes no
    // batch leaves every coding case standing. NB this is distinct from the cascade
    // row above: the cascade row re-WAKES downstream cases (held at canary+), this
    // CLOSES the directly-unblocked batch (shadow-level, like the evidence resume).
    codingClosed = await closeAnsweredCodingCases({
      client, firmId, clientId, evidenceCaseId: kase.id, triggerEventId: resumedEvent?.id || null
    });
  }

  return {
    resumed: true,
    caseId: kase.id,
    status,
    resolvedBlockers,
    codingCasesClosed: codingClosed.closedCases,
    injectionDetected: sanitized.injection_detected
  };
};
