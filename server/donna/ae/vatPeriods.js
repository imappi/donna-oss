// AE FTA-assigned tax periods — the audited writer and the pure resolver
// over the ae_vat_periods store (migration 128). The FTA assigns tax periods
// and due dates PER REGISTRANT, so a period is client DATA recorded from the
// owner's EmaraTax view — there is no obligations sync and no pack constant.
// Design: docs/design-donna-ae-vat-return.md (build-state 2026-08-30).
//
// Write discipline: the period insert and its audit event commit in ONE
// transaction (audit-as-precondition, the threshold-mint pattern) with the
// recording actor attributed — a failed receipt aborts the record, never a
// warn line. The TRN is taken from the persisted vat_registration record at
// record time, never caller-supplied.

import { randomUUID } from 'node:crypto';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { aeVatRefusal } from './vatReturn.js';
import { toUtcIsoDay, toIsoDay } from '../dates.js';

// The statutory due-date rule the writer checks records AGAINST, not with:
// a return and payment are due within 28 days of the period end, shifted to
// the next business day over a weekend/holiday — so a recorded due date that
// deviates from end+28 is legitimate and gets a NOTE, never a refusal.
// Provenance: Federal Decree-Law No. 8 of 2017 + Executive Regulation;
// corroborated via secondaries as_of 2026-08-30, primary read still owed
// (tax.gov.ae egress-blocked).
export const AE_VAT_RETURN_DUE_DAYS = 28;

const dateOnly = (value) => {
  const raw = String(value || '').slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
};

const plusDays = (isoDate, days) => {
  const base = new Date(`${isoDate}T00:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return toUtcIsoDay(base); // UTC on purpose: bare-day arithmetic at T00:00:00Z
};

// resolveAeVatPeriod({ periods, periodKey, asOf }) — the pure resolver, the
// GB shape: exactly one persisted period must match the request (by key, or
// by containing asOf), and an incomplete row refuses by the missing field.
export const resolveAeVatPeriod = ({ periods = [], periodKey, asOf } = {}) => {
  const candidates = periods.filter((period) => {
    if (periodKey !== undefined) return period.period_key === periodKey || period.periodKey === periodKey;
    return asOf && toIsoDay(period.start_date || period.startDate) <= asOf
      && toIsoDay(period.end_date || period.endDate) >= asOf;
  });
  if (candidates.length === 0) {
    throw aeVatRefusal('AE_VAT_PERIOD_NOT_ESTABLISHED', 'No recorded FTA-assigned tax period matches the request; record the period from EmaraTax first.');
  }
  if (candidates.length !== 1) {
    throw aeVatRefusal('AE_VAT_PERIOD_NOT_UNIQUE', 'More than one recorded tax period matches the request.');
  }
  const row = candidates[0];
  for (const field of ['period_key', 'start_date', 'end_date', 'due_date']) {
    const camel = field.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!row[field] && !row[camel]) {
      throw aeVatRefusal('AE_VAT_PERIOD_INCOMPLETE', `Recorded tax period is missing ${field}.`);
    }
  }
  return {
    id: row.id,
    periodKey: row.period_key ?? row.periodKey,
    startsOn: toIsoDay(row.start_date ?? row.startDate),
    endsOn: toIsoDay(row.end_date ?? row.endDate),
    dueOn: toIsoDay(row.due_date ?? row.dueDate),
    status: row.status
  };
};

// recordAeVatPeriod({ client, firmId, clientId, registration, periodKey,
// startDate, endDate, dueDate, recordedBy, source }) → { period, dueDateNote }.
//
// Refusals (typed):
//   AE_VAT_PERIOD_SCOPE_REQUIRED       — firmId/clientId missing (400)
//   AE_VAT_PERIOD_ACTOR_REQUIRED       — no recording actor (the attribution
//                                        rail: "which human" must be answerable)
//   AE_VAT_PERIOD_INVALID              — missing/backwards dates or key
//   AE_VAT_REGISTRATION_NOT_ESTABLISHED— no registration record resolves on
//                                        the period start (absence ≠ a "no")
//   AE_VAT_PERIOD_NOT_REGISTERED       — the record says not registered
//   AE_VAT_PERIOD_TRN_REQUIRED         — registered but no TRN on the record
//                                        (the approval window: the FTA has not
//                                        issued the number the period hangs on)
//   AE_VAT_PERIOD_DUPLICATE            — the period_key is already recorded
export const recordAeVatPeriod = async ({
  client,
  firmId,
  clientId,
  registration = null,
  periodKey,
  startDate,
  endDate,
  dueDate,
  recordedBy = null,
  source = null,
  manageTransaction = true
} = {}) => {
  if (!manageTransaction) await client.query('savepoint structured_vat_period');
  if (!firmId || !clientId) throw aeVatRefusal('AE_VAT_PERIOD_SCOPE_REQUIRED', 'firmId and clientId are required.', 400);
  if (!recordedBy || !String(recordedBy).trim()) {
    throw aeVatRefusal('AE_VAT_PERIOD_ACTOR_REQUIRED', 'Recording a tax period requires the recording actor.');
  }
  const key = String(periodKey || '').trim();
  const startsOn = dateOnly(startDate);
  const endsOn = dateOnly(endDate);
  const dueOn = dateOnly(dueDate);
  if (!key || !startsOn || !endsOn || !dueOn || endsOn < startsOn || dueOn < endsOn) {
    throw aeVatRefusal('AE_VAT_PERIOD_INVALID', 'A tax period requires a key and ordered ISO dates (start ≤ end ≤ due).');
  }
  const atStart = resolveAeVatRegistrationOnDate({ registration, onDate: startsOn });
  if (atStart.registered === null) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_NOT_ESTABLISHED', "No VAT registration record establishes the client's status on the period start; record the registration first.");
  }
  if (atStart.registered === false) {
    throw aeVatRefusal('AE_VAT_PERIOD_NOT_REGISTERED', 'The client is recorded as not VAT-registered on the period start; the FTA assigns tax periods to registrants.');
  }
  // The TRN comes from the RESOLVED registration state — the resolver only
  // surfaces it on a positive resolution, which is exactly the rule here.
  const trn = String(atStart.registrationId || '').trim();
  if (!trn) {
    throw aeVatRefusal('AE_VAT_PERIOD_TRN_REQUIRED', 'The registration record carries no TRN yet; record the TRN before recording its tax periods.');
  }
  const existing = await client.query(
    'select id from ae_vat_periods where firm_id = $1 and client_id = $2 and period_key = $3 limit 1',
    [firmId, clientId, key]
  );
  if (existing.rows.length > 0) {
    throw aeVatRefusal('AE_VAT_PERIOD_DUPLICATE', `Tax period ${key} is already recorded.`, 409, { id: existing.rows[0].id });
  }
  const expectedDue = plusDays(endsOn, AE_VAT_RETURN_DUE_DAYS);
  const dueDateNote = dueOn === expectedDue
    ? null
    : `Recorded due date ${dueOn} differs from period end + ${AE_VAT_RETURN_DUE_DAYS} days (${expectedDue}) — legitimate when the 28th day falls on a weekend/holiday; recorded as EmaraTax states it.`;
  const id = `ae-vat-period-${randomUUID()}`;
  if (manageTransaction) await client.query('begin');
  try {
    await client.query(
      `insert into ae_vat_periods (id, firm_id, client_id, trn, period_key, start_date, end_date, due_date, status, source)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'open', $9::jsonb)`,
      [id, firmId, clientId, trn, key, startsOn, endsOn, dueOn, JSON.stringify({
        recorded_by: String(recordedBy),
        recorded_from: source ? String(source) : null,
        due_date_note: dueDateNote
      })]
    );
    // Audit-as-precondition: same transaction as the record — a period the
    // audit trail cannot see must not exist.
    await client.query(
      `insert into audit_events (firm_id, client_id, actor_type, actor_id, action, resource_type, resource_id, metadata)
       values ($1, $2, 'operator', $3, 'ae_vat.period_recorded', 'ae_vat_period', $4, $5::jsonb)`,
      [firmId, clientId, String(recordedBy), id, JSON.stringify({
        period_key: key,
        start_date: startsOn,
        end_date: endsOn,
        due_date: dueOn,
        trn,
        due_date_note: dueDateNote,
        recorded_from: source ? String(source) : null
      })]
    );
    if (manageTransaction) await client.query('commit');
  } catch (error) {
    if (manageTransaction) await client.query('rollback');
    throw error;
  }
  if (!manageTransaction) await client.query('release savepoint structured_vat_period');
  return {
    period: { id, periodKey: key, startsOn, endsOn, dueOn, status: 'open' },
    dueDateNote
  };
};
