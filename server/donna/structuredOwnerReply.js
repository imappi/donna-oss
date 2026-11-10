import { assertCurrentOwnerReply } from './ownerReplyIdentity.js';
import { normalizeJurisdictionKey } from './taxCodeJurisdiction.js';
import { resolveStructuredOwnerReplyAdapter } from './statutoryRegistry.js';
import { interpretOwnerReply } from './ownerReplyInterpreter.js';
import { recordEvidenceTopicTurnInDb, loadReplyDocumentsWithContent, restoreUnrecordedCorrectionWithClient } from './db/asks.js';
import { CORRECTION_OUTCOMES, correctionNotRecordedNotice, correctionOf } from './ownerReplyCorrection.js';
import { recordOwnerReplyProcessingReceipt } from './ownerReplyProcessingReceipt.js';
import { ownerNoticeFromOutcome, recordOwnerNoticeWithClient } from './ownerReplyNotice.js';
const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const canonicalCountry = row => {
  const country = normalizeJurisdictionKey(row?.jurisdiction);
  const profile = normalizeJurisdictionKey(row?.profile?.jurisdiction);
  if (!country || (profile && country !== profile)) refuse('OWNER_REPLY_JURISDICTION_UNRESOLVED', 'The client jurisdiction must be resolved before interpreting its answer.');
  return country;
};
const askContext = request => ({ transaction_id: request.transaction_id, audience: request.audience, document_id: request.document_id, review_item_id: request.review_item_id, evidence_type: request.evidence_type, question: request.question,
  fact_at_mint: request.request_payload, reply: request.response_payload?.reply,
  replied_at: request.response_payload?.responded_at, document_ids: request.response_payload?.document_ids || [] });

// The existing owner-reply worker owns its session lease and bounded failures.
// No SQL transaction is held over provider I/O. Exact source and jurisdiction are
// checked again under row locks before the named writer and receipt co-commit.
export const processStructuredOwnerReplyWithClient = async ({ client, firmId, request, expectedReplyKey,
  attempts = 0, env = process.env, fetchImpl = globalThis.fetch, resolveAdapter = resolveStructuredOwnerReplyAdapter }) => {
  // A line-anchored ask reaches this worker only through a lane adapter that
  // declares it (transactionAnchored: the question is minted on a line but is
  // about the business, e.g. taxRegistrationReply.js); every other line ask
  // belongs to the coder's reply writer.
  const anchoredAllowed = row => !row?.transaction_id
    || resolveAdapter({ request: row })?.transactionAnchored === true;
  if (!request || request.firm_id !== firmId || !anchoredAllowed(request) || request.audience !== 'client') {
    refuse('OWNER_REPLY_SOURCE_INVALID', 'The registered reply requires its own client-scoped ask.');
  }
  assertCurrentOwnerReply(request, expectedReplyKey);
  const clientId = request.client_id;
  const persisted = (await client.query('select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3', [firmId, clientId, request.id])).rows[0];
  assertCurrentOwnerReply(persisted, expectedReplyKey);
  if (!anchoredAllowed(persisted) || (persisted.transaction_id || null) !== (request.transaction_id || null) || persisted.audience !== 'client'
    || JSON.stringify(askContext(persisted)) !== JSON.stringify(askContext(request))) {
    refuse('OWNER_REPLY_SUPERSEDED', 'The question source changed before interpretation.');
  }
  request = persisted;
  const profile = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0];
  const adapter = resolveAdapter({ jurisdiction: canonicalCountry(profile), evidenceType: request.evidence_type, request });
  if (!adapter) refuse('OWNER_REPLY_KIND_UNSUPPORTED', 'No factual reply resolver is registered for this client and question.');
  // Read the authenticated source receipt, not the worker/retry principal.
  const actor = (await client.query(`select actor_id, actor_type from audit_events
    where firm_id = $1 and client_id = $2 and resource_type = 'client_evidence_request' and resource_id = $3
      and action in ('evidence_request.reply', 'evidence_request.correction') and metadata->>'reply_key' = $4 order by id desc limit 1`,
  [firmId, clientId, request.id, expectedReplyKey])).rows[0];
  if (!actor?.actor_id || !['client', 'firm', 'owner', 'user', 'member'].includes(actor.actor_type)) {
    refuse('OWNER_REPLY_ACTOR_UNAVAILABLE', 'The exact answer has no authenticated source actor.');
  }
  // Country-owned factual consumers may require current scoped human authority.
  if (adapter.authorize) await adapter.authorize({ client, firmId, request, actorId: actor.actor_id });
  const documentIds = [...new Set([request.document_id, ...(adapter.contextDocumentIds?.(request) || []),
    ...(request.response_payload?.document_ids || [])].filter(Boolean))];
  const documents = await loadReplyDocumentsWithContent({ client, firmId, clientId, documentIds });
  if (documents.length !== documentIds.length) refuse('OWNER_REPLY_SOURCE_INVALID', 'An answer document does not belong to this client.');
  const context = { ask_id: request.id, reply_key: expectedReplyKey, ...askContext(request), client: profile, documents };
  // Optional adapter contract (FI-03): `settle` answers from the evidence alone
  // (no model call; the writer re-validates it under the commit locks), and
  // `maxClarifications` bounds the clarification turns — past the bound the
  // adapter's fixed `exhaustedQuestion` keeps the question on the owner and
  // further text is not re-interpreted — unless the adapter declares
  // `readsAfterExhaustion` (a later reply may still carry the fact; any
  // further clarification is the fixed request again, receipted once).
  // Optional `clarificationQuestion` replaces the model's clarification text
  // with the adapter's fixed wording in the owner's language.
  const priorClarifications = (request.request_payload?.evidence_topic?.turns || [])
    .filter(turn => ['clarification_requested', 'clarification_exhausted'].includes(turn?.outcome)).length;
  const bounded = Number.isInteger(adapter.maxClarifications);
  const exhaustedAlready = bounded && request.request_payload?.evidence_topic?.last_assessment?.reason === 'clarification_bound_exhausted';
  // A correction to the answer the closed question holds
  // (ownerReplyCorrection.js): read only by an adapter that declares it can,
  // never turned into a clarification turn (the earlier answer stands until a
  // correction is recorded), and the question goes back as it was when the
  // adapter records nothing.
  const correction = correctionOf(request);
  if (correction && adapter.readsCorrections !== true) refuse('OWNER_REPLY_KIND_UNSUPPORTED', 'This question kind does not read corrections.');
  const settled = adapter.settle ? await adapter.settle({ client, firmId, request }) : null;
  const interpretation = settled
    ? { answer: settled, confidence: 1, clarification: null, needsClarification: false, model: null, promptVersion: null, settledBy: 'evidence' }
    : exhaustedAlready && !adapter.readsAfterExhaustion
      ? { answer: null, confidence: null, clarification: await adapter.exhaustedQuestion({ client, firmId, request }), needsClarification: true, model: null, promptVersion: null }
      : await interpretOwnerReply({ request, adapter, context, env, fetchImpl });
  await client.query('begin');
  try {
    // Match client deletion order; NO KEY UPDATE still permits reply ingress's
    // audit FK KEY SHARE while that ingress holds the question row.
    const currentProfile = (await client.query('select jurisdiction, profile from clients where firm_id = $1 and id = $2 for no key update', [firmId, clientId])).rows[0];
    const current = (await client.query('select * from client_evidence_requests where firm_id = $1 and client_id = $2 and id = $3 for update', [firmId, clientId, request.id])).rows[0];
    assertCurrentOwnerReply(current, expectedReplyKey);
    if (JSON.stringify(askContext(current)) !== JSON.stringify(askContext(request))) refuse('OWNER_REPLY_SUPERSEDED', 'The question context changed during interpretation.');
    if (JSON.stringify(currentProfile) !== JSON.stringify(profile)) refuse('OWNER_REPLY_SUPERSEDED', 'The client context changed during interpretation.');
    if (documentIds.length) await client.query('select id from documents where firm_id = $1 and client_id = $2 and id = any($3::text[]) for share', [firmId, clientId, documentIds]);
    const currentDocuments = await loadReplyDocumentsWithContent({ client, firmId, clientId, documentIds });
    if (JSON.stringify(currentDocuments) !== JSON.stringify(documents)) refuse('OWNER_REPLY_SUPERSEDED', 'The answer evidence changed during interpretation.');
    // Recheck for both answers and clarifications after provider I/O.
    if (adapter.authorize) await adapter.authorize({ client, firmId, request: current, actorId: actor.actor_id });
    let outcome;
    const clarify = async (question, exhausted) => {
      const prior = current.request_payload?.evidence_topic || {};
      const now = new Date().toISOString();
      const turn = { at: now, channel: prior.channel || 'owner_reply', actor_id: actor.actor_id,
        reply_key: expectedReplyKey, outcome: exhausted ? 'clarification_exhausted' : 'clarification_requested', terminal: false,
        reply_excerpt: String(current.response_payload?.reply || '').slice(0, 240),
        question, document_ids: documentIds };
      await client.query(`update client_evidence_requests set status = 'open', resolved_at = null, resolved_by = null,
        question = $4, updated_at = now() where firm_id = $1 and client_id = $2 and id = $3`,
      [firmId, clientId, request.id, question]);
      await recordEvidenceTopicTurnInDb({ firmId, evidenceRequestId: request.id,
        actorId: actor.actor_id, actorType: actor.actor_type, withFirmDbClientFn: fn => fn(client),
        topicState: { ...prior, version: 1, status: 'open', original_question: prior.original_question || current.question, current_need: question,
          last_assessment: { outcome: turn.outcome, can_resolve: false,
            still_missing: [question], reason: exhausted ? 'clarification_bound_exhausted' : 'structured_reply_ambiguity' },
          turns: [...(prior.turns || []), turn].slice(-10) } });
      return { needsClarification: true, clarification: question, ...(exhausted ? { clarificationExhausted: true } : {}) };
    };
    // Past the bound a fresh clarification becomes the adapter's fixed request,
    // receipted once by the adapter where the discrepancy is surfaced.
    const boundedClarify = async (question) => {
      if (!bounded || (!exhaustedAlready && priorClarifications < adapter.maxClarifications)) return clarify(question, false);
      if (!exhaustedAlready) await adapter.exhaust?.({ client, firmId, request: current, actorId: actor.actor_id, actorType: actor.actor_type });
      return clarify(await adapter.exhaustedQuestion({ client, firmId, request: current }), true);
    };
    if (correction && interpretation.needsClarification) {
      outcome = { recorded: false, correction_unclear: true, drivenAction: 'owner_correction_unclear' };
    } else if (interpretation.needsClarification) {
      outcome = await boundedClarify(adapter.clarificationQuestion && interpretation.model
        ? await adapter.clarificationQuestion({ client, firmId, request: current }) : interpretation.clarification);
    } else {
      outcome = await adapter.apply({ client, firmId, request: current, expectedReplyKey,
        actorId: actor.actor_id, actorType: actor.actor_type, answer: interpretation.answer,
        interpretation: { model: interpretation.model, promptVersion: interpretation.promptVersion, confidence: interpretation.confidence },
        ...(correction ? { correction } : {}) });
      // A writer may find at commit that the answer cannot be applied as given.
      if (outcome?.needsClarification) {
        outcome = correction ? { recorded: false, correction_unclear: true, drivenAction: 'owner_correction_unclear' }
          : await boundedClarify(outcome.clarification);
      }
    }
    // A correction the adapter did not record (its writer left the question
    // waiting): the question goes back to its closed state, and the owner is
    // told the earlier answer stands.
    let correctionOutcome = null;
    if (correction) {
      const restored = await restoreUnrecordedCorrectionWithClient({ client, firmId, clientId, evidenceRequestId: request.id,
        replyKey: expectedReplyKey, actorId: actor.actor_id, actorType: actor.actor_type,
        reason: outcome?.correction_unclear ? 'unclear' : outcome?.drivenAction || adapter.action });
      correctionOutcome = restored ? CORRECTION_OUTCOMES.notRecorded : CORRECTION_OUTCOMES.recorded;
      if (restored) {
        const notice = correctionNotRecordedNotice({ profile: currentProfile?.profile, client: currentProfile });
        outcome = { ...outcome, owner_notice: notice, owner_notice_statement: notice };
      }
    }
    const clarified = Boolean(outcome?.needsClarification);
    // The line the lane wrote for the owner about this answer, kept on the
    // answered question with the outcome (ownerReplyNotice.js).
    if (!clarified) await recordOwnerNoticeWithClient({ client, firmId, clientId, evidenceRequestId: request.id, notice: ownerNoticeFromOutcome(outcome, { replyKey: expectedReplyKey }) });
    const processing = { reply_key: expectedReplyKey, state: clarified ? 'needs_clarification' : 'completed',
      attempts: attempts + 1, model: interpretation.model, prompt_version: interpretation.promptVersion,
      structured_answer: interpretation.answer, confidence: interpretation.confidence,
      driven_action: outcome?.clarificationExhausted ? 'owner_clarification_exhausted' : clarified ? 'owner_clarification' : outcome?.superseded ? 'owner_reply_superseded' : outcome?.drivenAction || adapter.action,
      clarification: clarified ? outcome.clarification : interpretation.clarification, actor_id: actor.actor_id, actor_type: actor.actor_type,
      ...(interpretation.settledBy ? { settled_by: interpretation.settledBy } : {}),
      ...(correction ? { correction: { ...correction, outcome: correctionOutcome } } : {}) };
    await recordOwnerReplyProcessingReceipt({ client, firmId, clientId, evidenceRequestId: request.id,
      actorId: actor.actor_id, actorType: actor.actor_type, processing, metadata: { authority_basis: 'persisted_owner_answer',
        evidence_request_id: request.id, reply_turn_id: expectedReplyKey } });
    await client.query('commit');
    return { applied: !clarified, ...outcome, processing, ...(correction ? { correction: { outcome: correctionOutcome } } : {}) };
  } catch (error) { await client.query('rollback'); throw error; }
};
