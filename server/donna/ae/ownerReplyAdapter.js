// Country-owned interpretation contract. The shared worker knows only the
// registered ask kind, schema, validation and existing factual writer.
import { AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE } from './vatRegistrationEscalation.js';
import { aeVatRegistrationRecordFromReply, recordAeVatRegistrationReply } from './vatRegistrationReply.js';
import { assertAeFactualReplyActor } from './factualReplyActor.js';
import { applyAeFactualReply, validateAeCtReply, validateAePeriodReply } from './factualReply.js';
import { toUtcIsoDay } from '../dates.js';
import { aeVatRecoveryReplyAdapter } from './vatRecoveryReply.js';
const date = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => keys.includes(key));
const validDay = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && toUtcIsoDay(value) === value;
const answerSchema = {
  type: 'object', additionalProperties: false, required: ['registered'], properties: {
    registered: { type: 'boolean' }, trn: { type: 'string' }, registered_from: date,
    periods: { type: 'array', maxItems: 12, items: { type: 'object', additionalProperties: false,
      required: ['period_key', 'start_date', 'end_date', 'due_date'], properties: {
        period_key: { type: 'string' }, start_date: date, end_date: date, due_date: date
      } } }
  }
};
export const validateRegistrationAnswer = answer => {
  if (!exactKeys(answer, ['registered', 'trn', 'registered_from', 'periods'])) return false;
  if (answer.registered === false) return Object.keys(answer).length === 1;
  if (answer.registered !== true || !validDay(answer.registered_from)
    || typeof answer.trn !== 'string' || !Array.isArray(answer.periods)
    || answer.periods.length < 1 || answer.periods.length > 12) return false;
  try { aeVatRegistrationRecordFromReply({ answer, askId: 'validation', answeredOn: answer.registered_from }); } catch { return false; }
  const keys = new Set();
  return answer.periods.every(period => {
    if (!exactKeys(period, ['period_key', 'start_date', 'end_date', 'due_date'])
      || typeof period.period_key !== 'string' || !period.period_key.trim() || keys.has(period.period_key)
      || ![period.start_date, period.end_date, period.due_date].every(validDay)
      || period.start_date < answer.registered_from || period.end_date < period.start_date || period.due_date < period.end_date) return false;
    keys.add(period.period_key); return true;
  });
};
const adapter = Object.freeze({
  evidenceType: AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE,
  action: 'record_vat_registration_reply',
  answerSchema,
  instructions: `Interpret the owner's answer about UAE VAT registration. Record owner attestation only, never primary verification, filing authority or a posting. A positive answer needs the owner's 15-digit TRN, effective registration date and explicitly supplied FTA-assigned tax period start, end and due dates. Normalize formatting and dates from the cited evidence and topic; never assume registration or invent an effective date, period, year or deadline from a legal default. Use a stable period_key from explicit dates (start_date/end_date is acceptable). When any required fact is missing, ask one specific clarification naming all missing facts. A clear not-registered answer is {registered:false}. An uncertain answer or a request to ask someone else needs clarification.`,
  validateAnswer: validateRegistrationAnswer,
  apply: ({ client, firmId, request, expectedReplyKey, actorId, actorType, answer }) => recordAeVatRegistrationReply({
    firmId, clientId: request.client_id, evidenceRequestId: request.id, actorId, actorType,
    answer, reply: request.response_payload.reply, source: 'structured_owner_reply',
    expectedReplyKey, manageTransaction: false, withFirmDbClientFn: fn => fn(client)
  })
});
const authorize = ({ client, firmId, request, actorId }) => assertAeFactualReplyActor({ client, firmId, clientId: request.client_id, actorId });
const ctSchema = { type: 'object', additionalProperties: false, required: ['registered'], properties: {
  registered: { type: 'boolean' }, trn: { type: 'string' }, registered_from: date
} };
const ctInstructions = `Interpret UAE corporate tax registration facts, separately from VAT. Only explicit owner facts or supplied evidence may establish registration. A registered answer needs the corporate tax TRN (15 digits) and explicitly stated effective registration date. Never copy a VAT number into CT registration or infer a date from incorporation, upload time or today's date. Record owner attestation only, never primary verification, filing or authority. Missing or uncertain facts require one specific clarification naming the missing facts.`;
const ctStatusAdapter = Object.freeze({ evidenceType: 'ct_registration_status', action: 'record_ct_registration_reply', authorize, answerSchema: ctSchema,
  instructions: ctInstructions + ` A clear not-registered answer is {registered:false}; the existing statutory watch will take over the registration deadline.`,
  validateAnswer: answer => validateAeCtReply(answer), apply: args => applyAeFactualReply(args) });
const ctDeadlineAdapter = Object.freeze({ evidenceType: 'ct_registration_deadline', action: 'record_ct_registration_reply', authorize, answerSchema: ctSchema,
  instructions: ctInstructions + ` This question is a live registration duty. Only an explicit completed registration with TRN and effective date can resolve it. An acknowledgment, plan to register or still-not-registered reply must remain a clarification asking for the completed registration facts when available. Incorporation/licence details, turnover-year facts and deregistration/restart facts have no consumer in this bounded adapter; ask a precise clarification without claiming those facts were recorded or the deadline recalculated.`,
  validateAnswer: answer => validateAeCtReply(answer) && answer.registered === true, apply: args => applyAeFactualReply(args) });
const periodAdapter = Object.freeze({ evidenceType: 'vat_return_period_intake', action: 'record_vat_period_reply', authorize,
  answerSchema: { type: 'object', additionalProperties: false, required: ['periods'], properties: { periods: answerSchema.properties.periods } },
  instructions: `Interpret the owner's explicitly assigned UAE VAT period dates from the reply and supplied evidence. Supply one to twelve periods with period_key, start_date, end_date and due_date. Use a stable key from explicit dates (start_date/end_date is acceptable). Never invent a period, year, start date or due date using statutory defaults, quarterly cadence or today's date. Missing facts or uncertainty require one specific clarification naming all missing facts. This records owner attestation of assigned periods only; it neither verifies FTA records nor files a return.`,
  validateAnswer: answer => validateAePeriodReply(answer), apply: args => applyAeFactualReply(args) });
export const getOwnerReplyAdapters = () => [adapter, ctStatusAdapter, ctDeadlineAdapter, periodAdapter, aeVatRecoveryReplyAdapter];
