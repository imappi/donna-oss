// AE ae_vat_registration — the REPLY path for the VAT-registration status
// ask (ae/vatRegistrationEscalation.js). The owner's answer is a structured
// fact set — registered or not; if registered, the TRN, the effective date,
// and the FTA-assigned tax period(s) — and this module is the ONLY writer
// that turns it into persisted state. RT-19 (forensics F-23).
//
// Three audited writes, in dependency order, each atomic on its own:
//   1. the registration RECORD on clients.profile.vat_registration, through
//      the AE normalizer (the same write-boundary rule clientProfileSchema.js
//      dispatches to for an AE client — a structurally invalid TRN is a
//      typed 400 BEFORE anything is written) with the owner attestation as
//      `verified_from` and `verified_at` deliberately NULL: an owner's word
//      is not a primary-source verification, so the record resolves with
//      confirmedAgainstPrimary: false until someone checks the certificate;
//   2. the tax period(s) through recordAeVatPeriod — the audited,
//      actor-attributed writer that takes the TRN from the record just
//      persisted, NEVER from this caller (the slice's rule, and the reason
//      the record must land first);
//   3. the ask resolved with the recorded facts in its response_payload and
//      an actor-attributed audit; when the answer is "registered" but no
//      period was supplied, the return lane's period-INTAKE ask (the same
//      deterministic id its daily drain mints — on conflict do nothing) is
//      opened in the same transaction, so the row moves from one owner
//      question to the next rather than resting on nobody until 04:15.
//
// Direct structured callers retain the original three-transaction behavior.
// The registered interpreter passes manageTransaction:false under its source
// locks, so all three existing writes and its interpretation receipt co-commit.
//
// Why not one transaction in the legacy call: recordAeVatPeriod owns its own begin/commit (the
// audit-as-precondition pattern) and a nested begin is not a savepoint. The
// sequence is honest under partial failure — a refused period leaves the
// registration recorded (it IS true) and the ask open, and the typed refusal
// names what is still missing; the next reply supplies it.
//
// Free-text interpretation is NOT here. The owner's WhatsApp reply lands on
// the ask as 'replied' through the existing resolve spine; turning "100 1234
// 5678 9012, Jan–Mar due 28 Apr" into this structured answer is the owner
// chat's job (a strong-model read, the trust-the-strong-LLM rail) and is
// named in the RT-19 handoff. This module is the Keep layer under it.

import { DEFAULT_FIRM_ID, deliverWhatsAppEvidenceAsksAfterSend, withFirmDbClient } from '../firmDb.js';
import { assertCurrentOwnerReply } from '../ownerReplyIdentity.js';
import { normalizeJurisdictionKey } from '../taxCodeJurisdiction.js';
import { toLocalIsoDay } from '../dates.js';
import { normalizeAeVatRegistration, resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { recordAeVatPeriod } from './vatPeriods.js';
import { aeVatRefusal } from './vatReturn.js';
import {
  AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE,
  aeVatReturnPeriodIntakeAskId,
  buildAeVatReturnPeriodIntakeQuestion
} from './vatReturnDeadlines.js';
import {
  AE_VAT_REGISTRATION_ASK_OPEN_STATUSES,
  AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE
} from './vatRegistrationEscalation.js';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  return ISO_DATE.test(raw) ? raw : null;
};

// The registration record the owner's answer becomes. Exported so the pure
// shape is pinnable without a database.
export const aeVatRegistrationRecordFromReply = ({ answer = {}, askId, answeredOn } = {}) => {
  const attestation = `owner attestation — reply to ask ${askId} on ${answeredOn}; not checked against an FTA certificate`;
  if (answer.registered === false) {
    return normalizeAeVatRegistration({ status: 'not_registered', verified_from: attestation });
  }
  if (answer.registered !== true) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', 'answer.registered must be true or false.', 400);
  }
  const registeredFrom = dateOnly(answer.registered_from);
  if (!registeredFrom) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', 'A registered answer requires registered_from (ISO date — the effective date on the FTA certificate).', 400);
  }
  const trn = String(answer.trn ?? answer.vat_registration_number ?? '').trim();
  if (!trn) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', 'A registered answer requires the 15-digit TRN.', 400);
  }
  try {
    return normalizeAeVatRegistration({
      status: 'registered',
      registered_from: registeredFrom,
      vat_registration_number: trn,
      registration_basis: answer.registration_basis ?? null,
      vat_return_period: answer.vat_return_period ?? null,
      verified_from: attestation
    });
  } catch (error) {
    // Re-type the normalizer's 400 so callers see the reply lane by name.
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', error.message, 400);
  }
};

const normalisePeriods = (periods) => {
  if (periods === null || periods === undefined) return [];
  if (!Array.isArray(periods)) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', 'answer.periods must be an array of { period_key, start_date, end_date, due_date }.', 400);
  }
  return periods.map((period, index) => {
    const key = String(period?.period_key ?? period?.periodKey ?? '').trim();
    const startsOn = dateOnly(period?.start_date ?? period?.startDate);
    const endsOn = dateOnly(period?.end_date ?? period?.endDate);
    const dueOn = dateOnly(period?.due_date ?? period?.dueDate);
    // The same rule the period writer refuses on, checked BEFORE the
    // registration is written so a malformed period never strands the
    // reply half-recorded.
    if (!key || !startsOn || !endsOn || !dueOn || endsOn < startsOn || dueOn < endsOn) {
      throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', `answer.periods[${index}] requires a period_key and ordered ISO dates (start ≤ end ≤ due).`, 400);
    }
    return { periodKey: key, startDate: startsOn, endDate: endsOn, dueDate: dueOn };
  });
};

// recordAeVatRegistrationReply({ firmId, clientId, evidenceRequestId,
// actorId, actorType, answer, reply, source, deliverAsksImpl })
// → { registration, periods, ask, intakeAsk }.
//
// Refusals (typed): AE_VAT_REGISTRATION_REPLY_SCOPE_REQUIRED (400),
// AE_VAT_REGISTRATION_REPLY_ACTOR_REQUIRED (422),
// AE_VAT_REGISTRATION_REPLY_INVALID (400), AE_VAT_REGISTRATION_ASK_NOT_FOUND
// (404), AE_VAT_REGISTRATION_ASK_NOT_OPEN (409),
// AE_VAT_REGISTRATION_REPLY_JURISDICTION (409), plus recordAeVatPeriod's own
// (AE_VAT_PERIOD_DUPLICATE and friends) for a period that cannot be recorded.
export const recordAeVatRegistrationReply = async ({
  firmId = DEFAULT_FIRM_ID,
  clientId,
  evidenceRequestId,
  actorId = null,
  actorType = 'client',
  answer = {},
  reply = null,
  source = null,
  deliverAsksImpl = null,
  manageTransaction = true,
  expectedReplyKey = null,
  withFirmDbClientFn = withFirmDbClient
} = {}) => {
  if (!firmId || !clientId || !evidenceRequestId) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_SCOPE_REQUIRED', 'firmId, clientId and evidenceRequestId are required.', 400);
  }
  const actor = String(actorId || '').trim();
  if (!actor) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_ACTOR_REQUIRED', 'Recording a VAT registration answer requires the answering actor.');
  }
  if (expectedReplyKey && manageTransaction) {
    throw aeVatRefusal('AE_VAT_REPLY_TRANSACTION_REQUIRED', 'Exact reply interpretation requires the caller-owned source transaction.', 409);
  }
  const answeredOn = toLocalIsoDay(new Date());
  const askId = String(evidenceRequestId).trim();
  // Validate the whole answer before touching the database.
  const record = aeVatRegistrationRecordFromReply({ answer, askId, answeredOn });
  const periods = record.status === 'registered' ? normalisePeriods(answer.periods) : [];
  if (record.status !== 'registered' && Array.isArray(answer.periods) && answer.periods.length > 0) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', 'Tax periods can only be recorded with a registered answer — the FTA assigns periods to registrants.', 400);
  }

  if (!manageTransaction && record.status === 'registered' && periods.length === 0) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_INVALID', 'The structured reply requires the assigned period before recording registration.', 400);
  }
  return withFirmDbClientFn(async (client) => {
    // A caller-owned transaction must already be active; never autocommit a
    // purported atomic interpretation. This savepoint refuses outside one.
    if (!manageTransaction) await client.query('savepoint structured_registration_reply');
    const askResult = await client.query(
      `select id, status, audience, evidence_type, response_payload, responded_at
         from client_evidence_requests
        where firm_id = $1 and client_id = $2 and id = $3
        limit 1 for update`,
      [firmId, clientId, askId]
    );
    const ask = askResult.rows[0];
    if (!ask || ask.evidence_type !== AE_VAT_REGISTRATION_STATUS_EVIDENCE_TYPE || ask.audience !== 'client') {
      throw aeVatRefusal('AE_VAT_REGISTRATION_ASK_NOT_FOUND', 'No VAT-registration status ask with that id belongs to this client.', 404);
    }
    if (expectedReplyKey) assertCurrentOwnerReply(ask, expectedReplyKey);
    if (!AE_VAT_REGISTRATION_ASK_OPEN_STATUSES.includes(String(ask.status || '').toLowerCase())) {
      throw aeVatRefusal('AE_VAT_REGISTRATION_ASK_NOT_OPEN', `This question is already ${ask.status}.`, 409, { status: ask.status });
    }
    const clientRow = await client.query(
      'select jurisdiction, profile from clients where firm_id = $1 and id = $2 limit 1 for no key update',
      [firmId, clientId]
    );
    const stored = clientRow.rows[0];
    const jurisdiction = normalizeJurisdictionKey(stored?.jurisdiction);
    const profileJurisdiction = normalizeJurisdictionKey(stored?.profile?.jurisdiction);
    if (jurisdiction !== 'ae' || (profileJurisdiction && profileJurisdiction !== jurisdiction)) {
      throw aeVatRefusal('AE_VAT_REGISTRATION_REPLY_JURISDICTION', `The AE VAT-registration reply path applies only to AE-jurisdiction clients, got ${JSON.stringify(jurisdiction || null)}.`, 409);
    }
    const priorRecord = stored?.profile?.vat_registration ?? null;

    // 1. The registration record — the same single-key merge
    //    updateClientProfileInDb performs, with the audit in-transaction.
    if (manageTransaction) await client.query('begin');
    try {
      await client.query(
        `update clients
            set profile = coalesce(profile, '{}'::jsonb) || jsonb_build_object('vat_registration', $3::jsonb),
                updated_at = now()
          where firm_id = $1 and id = $2`,
        [firmId, clientId, JSON.stringify(record)]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'vat_registration.recorded_from_reply', 'client', $2, $5::jsonb)`,
        [firmId, clientId, actorType, actor, JSON.stringify({
          evidence_request_id: askId,
          status: record.status,
          registered_from: record.registered_from,
          trn_recorded: Boolean(record.vat_registration_number),
          prior_status: priorRecord && typeof priorRecord === 'object' ? (priorRecord.status || null) : null,
          verified_from: record.verified_from,
          answer_source: source || null
        })]
      );
      if (manageTransaction) await client.query('commit');
    } catch (error) {
      if (manageTransaction) await client.query('rollback');
      throw error;
    }

    // 2. The tax periods — through the audited writer; the TRN is read from
    //    the record just persisted, never from the answer.
    const recordedPeriods = [];
    for (const period of periods) {
      const { period: recorded, dueDateNote } = await recordAeVatPeriod({
        client,
        firmId,
        clientId,
        registration: record,
        periodKey: period.periodKey,
        startDate: period.startDate,
        endDate: period.endDate,
        dueDate: period.dueDate,
        recordedBy: actor,
        manageTransaction,
        source: `owner reply to ask ${askId}${source ? ` via ${source}` : ''}`
      });
      recordedPeriods.push({ ...recorded, dueDateNote });
    }

    // 3. Resolve the ask; hand a registrant with no period straight to the
    //    return lane's intake ask.
    const now = new Date().toISOString();
    const intakeAskId = aeVatReturnPeriodIntakeAskId({ firmId, clientId, year: Number(answeredOn.slice(0, 4)) });
    let intakeInserted = false;
    if (manageTransaction) await client.query('begin');
    try {
      await client.query(
        `update client_evidence_requests
            set status = 'resolved',
                response_payload = response_payload || $4::jsonb,
                responded_at = coalesce(responded_at, $5::timestamptz),
                resolved_at = $5::timestamptz,
                resolved_by = $6,
                updated_at = now()
          where firm_id = $1 and client_id = $2 and id = $3`,
        [firmId, clientId, askId, JSON.stringify({
          reply: reply || ask.response_payload?.reply || null,
          answer_source: source || null,
          answer_recorded_by: actor,
          recorded: {
            registration_status: record.status,
            registered_from: record.registered_from,
            trn_recorded: Boolean(record.vat_registration_number),
            period_keys: recordedPeriods.map((period) => period.periodKey)
          },
          responded_at: expectedReplyKey ? ask.response_payload.responded_at : now,
          resolved_at: now
        }), now, actor]
      );
      await client.query(
        `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
         values ($1, $2, $3, $4, 'vat_registration.reply_recorded', 'client_evidence_request', $5, $6::jsonb)`,
        [firmId, clientId, actorType, actor, askId, JSON.stringify({
          registration_status: record.status,
          period_keys: recordedPeriods.map((period) => period.periodKey),
          answer_source: source || null
        })]
      );
      if (record.status === 'registered' && recordedPeriods.length === 0) {
        const intake = await client.query(
          `insert into client_evidence_requests (
             id, firm_id, client_id, status, evidence_type, question, request_payload,
             first_sent_at, last_sent_at, send_count, created_by
           )
           values ($1, $2, $3, 'open', $4, $5, $6::jsonb, now(), now(), 1, 'system')
           on conflict (id) do nothing
           returning id`,
          [intakeAskId, firmId, clientId, AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE, buildAeVatReturnPeriodIntakeQuestion(),
            JSON.stringify({ kind: AE_VAT_RETURN_PERIOD_INTAKE_EVIDENCE_TYPE, as_of: answeredOn, year: Number(answeredOn.slice(0, 4)), opened_by_reply_to: askId })]
        );
        intakeInserted = intake.rows.length > 0;
        if (intakeInserted) {
          await client.query(
            `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
             values ($1, $2, 'system', 'system', 'vat_return.period_intake_asked', 'client_evidence_request', $3, $4::jsonb)`,
            [firmId, clientId, intakeAskId, JSON.stringify({
              as_of: answeredOn,
              year: Number(answeredOn.slice(0, 4)),
              opened_by_reply_to: askId,
              authority_basis: 'statutory_obligation:ae_vat_return'
            })]
          );
        }
      }
      if (manageTransaction) await client.query('commit');
    } catch (error) {
      if (manageTransaction) await client.query('rollback');
      throw error;
    }
    if (!manageTransaction) await client.query('release savepoint structured_registration_reply');
    if (intakeInserted && manageTransaction) {
      const deliver = deliverAsksImpl
        || ((args) => deliverWhatsAppEvidenceAsksAfterSend({ client, ...args }));
      await deliver({ firmId, clientId, evidenceRequestIds: [intakeAskId] });
    }

    return {
      registration: resolveAeVatRegistrationOnDate({ registration: record, onDate: answeredOn }),
      periods: recordedPeriods,
      ask: { id: askId, status: 'resolved' },
      intakeAsk: intakeInserted ? { id: intakeAskId, status: 'open' } : null
    };
  });
};
