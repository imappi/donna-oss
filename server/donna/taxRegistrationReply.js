// The owner-reply consumer for the VAT/ALV registration question.
//
// A bank line the ledger refused because the business is not recorded as
// registered on its date (TAX_REGISTRATION_REFUSALS, codingPolicyRecovery.js)
// becomes one question to the owner (transactionLlm.js, the
// tax_registration_unrecorded guard), minted once per client
// (mintTaxRegistrationQuestionInDb, db/asks.js) with
// `request_payload.lane = 'tax_registration'`. This adapter is that question's
// registered reply consumer. The shared owner-reply worker
// (ownerReplyRecovery.js → structuredOwnerReply.js) owns the lease, the bounded
// failures, the strong reading (ownerReplyInterpreter.js, through llmCall.js,
// model on the receipt) and the bounded follow-up; this module owns only the
// registration contract:
//
// - The model reads the reply into a closed shape: registered yes, no or
//   unclear; the start date; an end date only if the owner states one.
// - Nothing the model says is trusted without checks that do not depend on it:
//   the dates are real ISO days, not in the future, in order, and the record is
//   built by the country's own normaliser. Unclear, low confidence, "yes"
//   without a usable date or a date that fails the checks records nothing and
//   asks one follow-up in the owner's language (the country's wording,
//   taxRegistration.answerQuestion); past the bound the question stays on the
//   owner with the country's fixed request.
// - An answer never removes a registered day the record already holds
//   (registrationAnswerEffect): it may add a record, extend one (an earlier
//   start, an end removed) or restate it. A plain "no" when a record exists
//   writes nothing: it confirms the record, which is why the question was
//   asked. Anything that would remove a covered day (a later start, a new or
//   earlier end, registered replaced by not_registered) records nothing and
//   rests where a locked fact rests.
// - The record is written through the one profile writer
//   (updateClientProfileInDb), which applies the Finnish intake guard. A fact
//   the guard locks is not worked around: nothing is recorded, the answer is
//   receipted as not recorded, and the line keeps its owner-answered note.
// - In the worker's transaction: the receipt (who answered, the question, the
//   record before and after, the model that read the reply, the undo patch),
//   every live registration question of this client closed with a receipt that
//   points at this answer, and every line refused for registration re-admitted
//   to the coder with the answer stamped on it (tax_registration_answer).
// - The outcome carries one line for the owner in their language (the
//   country's recordedNotice, or notRecordedNotice when nothing was recorded),
//   with and without its invitation to reply; the worker keeps it on the
//   answered question (ownerReplyNotice.js).
//
// - A reply after the question closed is a correction to the answer it holds
//   (ownerReplyCorrection.js; this adapter declares readsCorrections). It is
//   read and checked exactly as an answer, and both receipts carry the
//   correction (the earlier answer, who and when). One that records nothing
//   stamps no line: every line keeps the earlier answer's stamp and state, and
//   the worker puts the question back as it was.
//
// The country specifics (record key, normaliser, wording) come from the
// country posting policy's taxRegistration declaration; nothing here knows a
// country. No static database imports: the statutory registry imports this
// module and the firmDb chain is an import cycle.
import { toUtcIsoDay } from './dates.js';
import { preferredOwnerTemplateLanguage } from './ownerLanguage.js';

export const TAX_REGISTRATION_LANE = 'tax_registration';
// The fact flavour the coding auto-post owner ask mints for an owner_fact
// coding (codingAutoPost.js buildOwnerAsk → 'business_purpose').
export const TAX_REGISTRATION_EVIDENCE_TYPE = 'business_purpose';
export const TAX_REGISTRATION_CONSTRAINT = 'tax_registration_unrecorded';
export const TAX_REGISTRATION_ANSWERS = Object.freeze(['yes', 'no', 'unclear']);

const refuse = (code, message) => { throw Object.assign(new Error(message), { code }); };
const day = /^\d{4}-\d{2}-\d{2}$/;
const nullableDay = { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] };
const answerSchema = { type: 'object', additionalProperties: false, required: ['registered', 'registered_from', 'registered_until'], properties: {
  registered: { type: 'string', enum: [...TAX_REGISTRATION_ANSWERS] },
  registered_from: nullableDay,
  registered_until: nullableDay
} };
export const validateTaxRegistrationAnswer = (answer) => Boolean(answer && typeof answer === 'object' && !Array.isArray(answer)
  && Object.keys(answer).length === 3 && TAX_REGISTRATION_ANSWERS.includes(answer.registered)
  && ['registered_from', 'registered_until'].every((key) => Object.hasOwn(answer, key)
    && (answer[key] === null || (typeof answer[key] === 'string' && day.test(answer[key])))));

// The checks that do not depend on the model. A real calendar day (2026-02-30
// is not one), not after today (UTC), an end not before its start. Returns the
// facts to record, or the follow-up kind when nothing may be recorded.
export const checkTaxRegistrationAnswer = (answer, { today = toUtcIsoDay(new Date()) } = {}) => {
  if (!validateTaxRegistrationAnswer(answer) || answer.registered === 'unclear') return { followUp: 'unclear' };
  const real = (value) => value === null || (toUtcIsoDay(value) === value && value <= today);
  const from = answer.registered_from, until = answer.registered_until;
  if (!real(from) || !real(until) || (from && until && until < from)) return { followUp: 'date' };
  if (answer.registered === 'yes' && !from) return { followUp: 'date' };
  // "Not registered" with a start and no end names no state the record can hold.
  if (answer.registered === 'no' && from && !until) return { followUp: 'unclear' };
  return { registered: answer.registered === 'yes', registeredFrom: from, registeredUntil: until };
};

export const sameRegistrationRecord = (left, right) => sameRecord(left, right);
const sameRecord = (left, right) => ['status', 'registered_from', 'registered_until']
  .every((key) => (left?.[key] ?? null) === (right?.[key] ?? null));

// The days a normalised record covers: [registered_from, registered_until]
// (open-ended without an end) for a dated registered/deregistered record.
// A deregistered record with an end and no start (both normalisers allow it)
// is read as covering every day up to its end (from: null, an open start), so
// no answer replaces it unless it too has an open start, which an owner's
// answer never produces. Nothing for not_registered or an undated record.
// Both countries' normalisers share these keys and statuses.
const coveredDays = (record) => {
  if (!record || !['registered', 'deregistered'].includes(record.status)) return null;
  if (record.registered_from) return { from: record.registered_from, until: record.registered_until || null };
  return record.status === 'deregistered' && record.registered_until ? { from: null, until: record.registered_until } : null;
};
// An owner's answer never removes a registered day the record already holds:
// the question was asked because the record does not say registered on the
// line's date, so an answer may only extend what the record covers. Returns
// 'write', 'confirm' (the answer restates the record, or a plain "no" when a
// record exists: nothing to write) or 'conflict' (it would remove covered days).
export const registrationAnswerEffect = ({ before = null, record, checked }) => {
  if (sameRecord(before, record)) return 'confirm';
  if (before && checked.registered === false && !checked.registeredFrom && !checked.registeredUntil) return 'confirm';
  const held = coveredDays(before);
  if (!held) return 'write';
  const next = coveredDays(record);
  const keeps = next && (held.from === null ? next.from === null : next.from !== null && next.from <= held.from)
    && (next.until === null || (held.until !== null && next.until >= held.until));
  return keeps ? 'write' : 'conflict';
};

const readRule = async (row) => {
  const { resolvePostingPolicy } = await import('./postingPolicy.js');
  try { return resolvePostingPolicy({ jurisdiction: row?.jurisdiction }).taxRegistration || null; } catch { return null; }
};

const readClient = async (client, firmId, clientId) => (await client.query(
  'select jurisdiction, profile from clients where firm_id = $1 and id = $2', [firmId, clientId])).rows[0] || null;

const assertQuestionOfClient = (request) => {
  const payload = request?.request_payload || {};
  if (payload.lane !== TAX_REGISTRATION_LANE || !request.client_id
    || (payload.tax_registration?.client_id && payload.tax_registration.client_id !== request.client_id)) {
    refuse('OWNER_REPLY_SOURCE_INVALID', 'The registration answer must belong to the client its question was asked of.');
  }
};

// The live registration questions of this client and every line they carry.
const liveQuestions = async (client, firmId, clientId) => (await client.query(
  `select * from client_evidence_requests
    where firm_id = $1 and client_id = $2 and audience = 'client' and request_payload->>'lane' = $3
      and status in ('draft', 'open', 'replied')
    order by created_at, id for update`, [firmId, clientId, TAX_REGISTRATION_LANE])).rows;
const questionLineIds = (asks) => [...new Set(asks.flatMap((ask) => [ask.transaction_id,
  ...(Array.isArray(ask.request_payload?.tax_registration?.lines) ? ask.request_payload.tax_registration.lines.map((line) => line?.transaction_id) : [])])
  .filter(Boolean))];

// Every not-yet-decided line of this client the registration question stands
// for: those its questions name, and any other line refused for registration
// or carrying the registration guard.
const refusedLines = async (client, firmId, clientId, ids, refusalCodes) => (await client.query(
  `select id, transaction_date, coding_state, payload from transactions
    where firm_id = $1 and client_id = $2
      and (id = any($3::text[])
           or payload->'ai_suggestion'->'tax_unresolved_guard'->>'constraint' = $5
           or payload->'ledger_post_refusal'->>'code' = any($4::text[])
           or payload->'posting_recovery'->'review'->'previous_refusal'->>'code' = any($4::text[]))
      and coalesce(coding_state, '') not in ('held', 'posted', 'synced', 'closed')
      -- An applied line is still open only while the ledger refuses it for registration.
      and (coalesce(coding_state, '') <> 'applied' or payload->'ledger_post_refusal'->>'code' = any($4::text[]))
      and payload->>'ledger_journal_id' is null
    order by id for update`, [firmId, clientId, ids, refusalCodes, TAX_REGISTRATION_CONSTRAINT])).rows;

const lineAsOf = (row) => toUtcIsoDay(row.payload?.ai_suggestion?.tax_unresolved_guard?.as_of
  || row.payload?.posting_recovery?.review?.previous_refusal?.details?.as_of
  || row.payload?.ledger_post_refusal?.details?.as_of || row.transaction_date) || null;

// The answer on each line, and the line back to the coder. A line the record
// now says registered on posts through the normal path once re-coded (the
// guard is silent); any other line keeps the stamp, so the coder's contract
// knows the owner has answered and does not ask again.
const stampLines = async ({ client, firmId, clientId, request, rule, profile, receiptId, state, lines }) => {
  const { applyCodingTransitionIfAllowed } = await import('./codingState.js');
  const out = [];
  for (const row of lines) {
    const asOf = lineAsOf(row);
    let status = { registered: null, reason: 'no_as_of_date' };
    try { status = rule.onDate({ profile, onDate: asOf }); } catch { status = { registered: null, reason: 'registration_unavailable' }; }
    const stamp = { evidence_request_id: request.id, receipt_id: receiptId, state, as_of: asOf,
      registered: status?.registered ?? null, registration_reason: status?.reason || null };
    const readmit = state === 'recorded' && row.coding_state === 'asked';
    await client.query(`update transactions set payload = payload || $4::jsonb,
        status = case when $5::boolean then 'needs_review' else status end, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3`, [firmId, clientId, row.id,
      JSON.stringify({ tax_registration_answer: stamp, ...(readmit ? { status: 'needs_review', transaction_status: 'needs_review' } : {}) }), readmit]);
    if (readmit) await applyCodingTransitionIfAllowed(client, { firmId, clientId, transactionId: row.id, to: 'proposed' });
    out.push({ transaction_id: row.id, as_of: asOf, registered: stamp.registered, readmitted: readmit });
  }
  return out;
};

export const applyTaxRegistrationAnswer = async ({ client, firmId, request, actorId, actorType, answer, interpretation = {},
  correction = null, today = toUtcIsoDay(new Date()) }) => {
  assertQuestionOfClient(request);
  const clientId = request.client_id;
  const row = await readClient(client, firmId, clientId);
  const rule = await readRule(row);
  if (!rule) refuse('OWNER_REPLY_KIND_UNSUPPORTED', 'No registration record is declared for this client\'s country.');
  const language = preferredOwnerTemplateLanguage(row.profile || {}, row);
  const checked = checkTaxRegistrationAnswer(answer, { today });
  if (checked.followUp) return { needsClarification: true, clarification: rule.answerQuestion({ language, kind: checked.followUp }) };

  const before = row.profile?.[rule.profileField] ?? null;
  const record = rule.recordFromAnswer({ current: before, registered: checked.registered,
    registeredFrom: checked.registeredFrom, registeredUntil: checked.registeredUntil,
    source: `Owner answer to question ${request.id}` });
  const effect = registrationAnswerEffect({ before, record, checked });
  const changed = effect === 'write';
  let locked = effect === 'conflict' ? { code: 'conflicts_with_recorded_registration',
    message: 'The answer would remove registered days the record already holds; nothing was recorded.' } : null;
  if (changed) {
    const { updateClientProfileInDb } = await import('./db/clients.js');
    try {
      await updateClientProfileInDb({ firmId, clientId, profilePatch: { [rule.profileField]: record }, actorId,
        principal: { principalType: actorType, principalId: actorId }, dbClient: client, manageTransaction: false });
    } catch (error) {
      if (!rule.recordLockedCodes.includes(error?.code)) throw error;
      locked = { code: error.code, message: error.message };
    }
  }
  const asks = await liveQuestions(client, firmId, clientId);
  const lines = await refusedLines(client, firmId, clientId, questionLineIds([request, ...asks]), rule.refusalCodes);
  const reading = { model: interpretation.model || null, prompt_version: interpretation.promptVersion || null,
    confidence: interpretation.confidence ?? null, answer };
  const answeredBy = { actor_id: actorId, actor_type: actorType };

  if (locked) {
    // Nothing is recorded and nothing is worked around: the profile guard
    // refused (a prepared client's recorded fact), or the answer would remove
    // registered days the record holds. The question stays answered (replied)
    // and the lines keep the owner-answered note; the record changes only
    // through a person (the reviewed reapproval workflow the guard names, or a
    // firm correction of the record).
    const conflict = locked.code === 'conflicts_with_recorded_registration';
    const receipt = (await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
      values ($1, $2, $3, $4, 'tax_registration.owner_answer_not_recorded', 'client', $2, $5::jsonb) returning id`,
    [firmId, clientId, actorType || 'client', actorId, JSON.stringify({ evidence_request_id: request.id, answered_by: answeredBy,
      profile_field: rule.profileField, record: before, proposed: record, refusal: locked, reason: locked.code, reading,
      line_ids: lines.map((line) => line.id), rests_on: correction ? 'earlier_answer_stands' : conflict ? 'firm_record_correction' : 'firm_reapproval_workflow',
      ...(correction ? { correction } : {}) })])).rows[0].id;
    const state = conflict ? 'record_conflict' : 'record_locked';
    // A correction that records nothing leaves every line as the earlier
    // answer left it: its stamp is the one the coder must keep reading.
    const stamped = correction ? [] : await stampLines({ client, firmId, clientId, request, rule, profile: row.profile || {}, receiptId: String(receipt), state, lines });
    // The owner is told, in their language, that nothing was recorded and a
    // person must check it; never that it was recorded. The line invites no
    // reply, so it is its own statement (ownerReplyNotice.js).
    const notRecorded = String(rule.notRecordedNotice({ language, reason: state }) || '').slice(0, 500);
    return { recorded: false, [state]: true, receipt_id: String(receipt), lines: stamped, drivenAction: `tax_registration_${state}`,
      owner_notice: notRecorded, owner_notice_statement: notRecorded };
  }

  const profile = changed ? (await readClient(client, firmId, clientId))?.profile || {} : row.profile || {};
  const after = profile[rule.profileField] ?? null;
  const ownerNotice = String(rule.recordedNotice({ language, record: after }) || '').slice(0, 500);
  // The same line without its invitation to reply, for a surface where the
  // closed question has no reply (the portal's answered questions).
  const ownerNoticeStatement = String(rule.recordedNotice({ language, record: after, replyInvitation: false }) || '').slice(0, 500);
  const receipt = (await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
    values ($1, $2, $3, $4, 'tax_registration.owner_answer_recorded', 'client', $2, $5::jsonb) returning id`,
  [firmId, clientId, actorType || 'client', actorId, JSON.stringify({ evidence_request_id: request.id, answered_by: answeredBy,
    profile_field: rule.profileField, before, after, changed, outcome: changed ? 'recorded' : 'confirmed_record', reading, owner_notice: ownerNotice, language,
    // The undo: write the prior record back through the same profile writer.
    undo: { profile_patch: { [rule.profileField]: before } },
    line_ids: lines.map((line) => line.id), ...(correction ? { correction } : {}) })])).rows[0].id;
  const receiptId = String(receipt);
  // One answer settles every live registration question of this client.
  const closedIds = [];
  for (const ask of [request, ...asks.filter((ask) => ask.id !== request.id)]) {
    const closed = await client.query(`update client_evidence_requests set status = 'resolved', resolved_at = now(), resolved_by = $4,
        request_payload = jsonb_set(request_payload, '{evidence_request,status}', '"resolved"'::jsonb, true),
        response_payload = response_payload || $5::jsonb, updated_at = now()
      where firm_id = $1 and client_id = $2 and id = $3 and status in ('draft', 'open', 'replied') returning id`,
    [firmId, clientId, ask.id, actorId, JSON.stringify({ tax_registration_resolution: { settled_by_evidence_request_id: request.id,
      registration_receipt_id: receiptId, record: after } })]);
    if (!closed.rowCount) continue;
    closedIds.push(ask.id);
    await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
      values ($1, $2, $3, $4, 'evidence_request.resolved_by_registration_answer', 'client_evidence_request', $5, $6::jsonb)`,
    [firmId, clientId, actorType || 'client', actorId, ask.id, JSON.stringify({ settled_by_evidence_request_id: request.id,
      registration_receipt_id: receiptId, transaction_id: ask.transaction_id || null, prior_status: ask.status })]);
  }
  if (!closedIds.includes(request.id)) refuse('OWNER_REPLY_SUPERSEDED', 'The registration question changed before it could close.');
  const stamped = await stampLines({ client, firmId, clientId, request, rule, profile, receiptId, state: 'recorded', lines });
  // The worker keeps the line on the answered question (ownerReplyNotice.js).
  return { recorded: true, changed, record: after, receipt_id: receiptId, resolved_ask_ids: closedIds, lines: stamped,
    owner_notice: ownerNotice, owner_notice_statement: ownerNoticeStatement };
};

const readFollowUp = async ({ client, firmId, request, kind }) => {
  const row = await readClient(client, firmId, request.client_id);
  const rule = await readRule(row);
  if (!rule) refuse('OWNER_REPLY_KIND_UNSUPPORTED', 'No registration record is declared for this client\'s country.');
  return rule.answerQuestion({ language: preferredOwnerTemplateLanguage(row.profile || {}, row), kind });
};

export const taxRegistrationReplyAdapter = Object.freeze({
  lane: TAX_REGISTRATION_LANE,
  evidenceType: TAX_REGISTRATION_EVIDENCE_TYPE,
  // The question is minted on the first refused line (the owner-ask writer's
  // anchor), but it is about the business, not that line.
  transactionAnchored: true,
  action: 'record_tax_registration_answer',
  maxClarifications: 1,
  // Past the bound a later reply is still read: the owner may send the date.
  readsAfterExhaustion: true,
  // A reply after the question closed is read as a correction (ownerReplyCorrection.js).
  readsCorrections: true,
  answerSchema,
  instructions: `This ask is whether the business is registered for VAT (the register the question names) and from what date. Return registered "yes" only when the owner clearly says the business is registered, "no" only when they clearly say it is not, otherwise "unclear". registered_from is the date the registration took effect, only when the owner states a full calendar date (day, month and year); a month or year alone, "a while ago", or a date you would have to infer from the question, today, incorporation, a filing or any legal default is null. registered_until is set only when the owner states that the registration ended, and only as a full stated date; otherwise null. Never guess a date. Do not ask for anything else.`,
  validateAnswer: validateTaxRegistrationAnswer,
  // The owner-facing follow-up is the country's fixed wording in the owner's
  // language, never the model's text.
  clarificationQuestion: ({ client, firmId, request }) => readFollowUp({ client, firmId, request, kind: 'unclear' }),
  exhaustedQuestion: ({ client, firmId, request }) => readFollowUp({ client, firmId, request, kind: 'exhausted' }),
  exhaust: async ({ client, firmId, request, actorId, actorType }) => {
    await client.query(`insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
      values ($1, $2, $3, $4, 'tax_registration.clarification_exhausted', 'client_evidence_request', $5, $6::jsonb)`,
    [firmId, request.client_id, actorType || 'client', actorId, request.id, JSON.stringify({ transaction_id: request.transaction_id || null,
      rests_on: 'owner', next_need: 'registration_effective_date' })]);
  },
  apply: (args) => applyTaxRegistrationAnswer(args)
});
