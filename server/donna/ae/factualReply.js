// Country-owned reply orchestration over the existing factual writers. The
// structured worker owns the transaction, model receipt and exact source fence.
import { updateClientProfileInDb } from '../db/clients.js';
import { enqueueLocalJob } from '../desktop/localJobQueue.js';
import { assertCurrentOwnerReply } from '../ownerReplyIdentity.js';
import { toIsoDay, toUtcIsoDay } from '../dates.js';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { normalizeAeCtRegistration } from './ctRegistration.js';
import { recordAeVatPeriod } from './vatPeriods.js';
import { assertAeFactualReplyActor } from './factualReplyActor.js';

const refuse = (code, message) => { throw Object.assign(new Error(message), { code, statusCode: 409 }); };
export const validAeReplyDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && toUtcIsoDay(value) === value;
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));
export const validateAeCtReply = answer => {
  if (!exact(answer, ['registered', 'trn', 'registered_from'])) return false;
  if (answer.registered === false) return Object.keys(answer).length === 1;
  if (answer.registered !== true || !validAeReplyDay(answer.registered_from) || typeof answer.trn !== 'string' || !answer.trn.trim()) return false;
  try { normalizeAeCtRegistration({ status: 'registered', registered_from: answer.registered_from, ct_registration_number: answer.trn }); return true; } catch { return false; }
};
export const validateAePeriodReply = answer => {
  if (!exact(answer, ['periods']) || !Array.isArray(answer.periods) || !answer.periods.length || answer.periods.length > 12) return false;
  const keys = new Set();
  return answer.periods.every((period, index) => {
    if (!exact(period, ['period_key', 'start_date', 'end_date', 'due_date']) || typeof period.period_key !== 'string'
      || !period.period_key.trim() || period.period_key !== period.period_key.trim() || keys.has(period.period_key)
      || ![period.start_date, period.end_date, period.due_date].every(validAeReplyDay)
      || period.start_date > period.end_date || period.end_date > period.due_date) return false;
    keys.add(period.period_key);
    return !answer.periods.slice(0, index).some(prior => prior.start_date <= period.end_date && prior.end_date >= period.start_date);
  });
};


export const applyAeFactualReply = async ({ client, firmId, request, expectedReplyKey, actorId, answer }) => {
  await client.query('savepoint ae_factual_reply'); // Refuse outside caller transaction.
  assertCurrentOwnerReply(request, expectedReplyKey);
  const kind = request.evidence_type;
  const periodIntake = kind === 'vat_return_period_intake';
  const ctStatus = kind === 'ct_registration_status';
  const ctDeadline = kind === 'ct_registration_deadline';
  if ((!periodIntake && !ctStatus && !ctDeadline) || request.audience !== 'client' || request.transaction_id
    || (periodIntake ? !validateAePeriodReply(answer) : !validateAeCtReply(answer))
    || (ctDeadline && !answer.registered)) refuse('AE_FACTUAL_REPLY_INVALID', 'The answer does not supply the required facts for this question.');
  const human = await assertAeFactualReplyActor({ client, firmId, clientId: request.client_id, actorId });
  const row = (await client.query('select jurisdiction, profile from clients where firm_id=$1 and id=$2 for no key update', [firmId, request.client_id])).rows[0];
  if (String(row?.jurisdiction).toLowerCase() !== 'ae' || (row.profile?.jurisdiction && String(row.profile.jurisdiction).toLowerCase() !== 'ae')) {
    refuse('AE_FACTUAL_REPLY_JURISDICTION', 'The factual reply requires the current UAE client identity.');
  }
  const source = `owner attestation — reply to ask ${request.id}; not checked against an FTA certificate`;
  let recorded;
  let superseded = false;
  if (periodIntake) {
    const existing = (await client.query('select * from ae_vat_periods where firm_id=$1 and client_id=$2 for update', [firmId, request.client_id])).rows;
    recorded = [];
    for (const period of answer.periods) {
      const registration = resolveAeVatRegistrationOnDate({ registration: row.profile?.vat_registration, onDate: period.start_date });
      if (registration.registered !== true || !registration.registrationId) refuse('AE_VAT_REGISTRATION_NOT_ESTABLISHED', 'The current VAT registration must establish the recorded period and TRN.');
      const sameKey = existing.find(item => item.period_key === period.period_key);
      const overlapping = existing.filter(item => toIsoDay(item.start_date) <= period.end_date && toIsoDay(item.end_date) >= period.start_date);
      if (sameKey && sameKey.trn === registration.registrationId && ['start_date', 'end_date', 'due_date'].every(key => toIsoDay(sameKey[key]) === period[key]) && overlapping.every(item => item.id === sameKey.id)) {
        recorded.push({ id: sameKey.id, periodKey: sameKey.period_key, alreadyRecorded: true });
        continue;
      }
      if (sameKey || overlapping.length) refuse('AE_VAT_PERIOD_CONFLICT', 'These dates conflict with a recorded VAT period; the existing period must be corrected through its own workflow.');
      const result = await recordAeVatPeriod({ client, firmId, clientId: request.client_id, registration: row.profile?.vat_registration,
        periodKey: period.period_key, startDate: period.start_date, endDate: period.end_date, dueDate: period.due_date,
        recordedBy: human.actorId, source, manageTransaction: false });
      recorded.push(result.period);
    }
  } else {
    const registration = normalizeAeCtRegistration({ status: answer.registered ? 'registered' : 'not_registered',
      ...(answer.registered ? { registered_from: answer.registered_from, ct_registration_number: answer.trn } : {}), verified_from: source });
    const current = row.profile?.ct_registration;
    if (current?.status === 'registered') {
      // A generated status/deadline question is not correction authority for
      // registration facts established after that question was opened. Keep
      // primary provenance intact even for an identical owner answer.
      const digits = value => String(value || '').replace(/[\s-]/g, '');
      superseded = !answer.registered || current.registered_from !== registration.registered_from
        || digits(current.ct_registration_number) !== digits(registration.ct_registration_number);
      recorded = current;
    } else {
      await updateClientProfileInDb({ firmId, clientId: request.client_id, profilePatch: { ct_registration: registration },
        actorId: human.actorId, dbClient: client, manageTransaction: false });
      recorded = registration;
    }
  }
  const closed = (await client.query(`update client_evidence_requests set status=case when $7::boolean then 'cancelled' else 'resolved' end, resolved_at=now(), resolved_by=$4,
    response_payload=response_payload || $5::jsonb, updated_at=now()
    where firm_id=$1 and client_id=$2 and (id=$3 or ($6::boolean and status='open' and audience='client'
      and evidence_type in ('ct_registration_status','ct_registration_deadline')))
    returning id`, [firmId, request.client_id, request.id, human.actorId,
    JSON.stringify({ recorded, answer_source: 'structured_owner_reply', answer_recorded_by: human.actorId, settled_by_reply_to: request.id,
      ...(superseded ? { superseded: true, superseded_reason: 'newer_ct_registration' } : {}) }),
    !periodIntake && answer.registered && !superseded, superseded])).rows.map(item => item.id);
  await client.query(`insert into audit_events(firm_id,client_id,actor_type,actor_id,action,resource_type,resource_id,metadata)
    values($1,$2,$3,$4,case when $7::boolean then 'ae.factual_reply.superseded' else 'ae.factual_reply.recorded' end,'client_evidence_request',$5,$6::jsonb)`,
  [firmId, request.client_id, human.actorType, human.actorId, request.id, JSON.stringify({ kind, recorded, superseded, resolved_ask_ids: superseded ? [] : closed, superseded_ask_ids: superseded ? closed : [],
    reply_key: expectedReplyKey, authority_basis: superseded ? 'newer_persisted_registration' : 'persisted_owner_answer', source_actor_id: actorId }), superseded]);
  const clock = await enqueueLocalJob({ client, functionId: 'parse-cron:statutory_watches', handlerVersion: '2',
    payload: { firm_id: firmId, client_id: request.client_id, evidence_request_id: request.id, reply_key: expectedReplyKey },
    dedupeKey: `ae-factual-reply:${expectedReplyKey}`, maxAttempts: 1 });
  await client.query('release savepoint ae_factual_reply');
  return { recorded, superseded, ask: { id: request.id, status: superseded ? 'cancelled' : 'resolved' },
    resolvedAskIds: superseded ? [] : closed, supersededAskIds: superseded ? closed : [], clockJobId: clock?.id || null };
};
