// Above-the-wire GB VAT preparation route. Reads a persisted HMRC period and
// posted ledger verdicts, prepares an owner-presentable return, and refuses at
// the unconfirmed MTD transport boundary.

import { withFirmDbClient } from '../firmDb.js';
import { resolveGbVatRegistrationOnDate } from './vatRegistration.js';
import { buildGbVatReturnFromLedgerLines, gbVatRefusal, resolveGbVatPeriod } from './vatReturn.js';

export const prepareGbVatReturnWithClient = async ({ client, firmId, clientId, periodKey, asOf, vatRegistration } = {}) => {
  if (!firmId || !clientId) throw gbVatRefusal('GB_VAT_SCOPE_REQUIRED', 'firmId and clientId are required.', 400);
  const periodResult = await client.query(
    `select id, period_key, start_date, end_date, due_date, status
       from vat_periods
      where firm_id = $1 and client_id = $2
      order by start_date asc, id asc`,
    [firmId, clientId]
  );
  const period = resolveGbVatPeriod({ periods: periodResult.rows, periodKey, asOf });
  // Registration is resolved at BOTH period boundary dates — a return is a
  // statement about the period, not about today. Absence of a record must
  // never read as a VAT duty or its inverse, and a registration covering only
  // part of the period must never render a silently-partial nine-box; every
  // verdict lands before any ledger read.
  const atStart = resolveGbVatRegistrationOnDate({ registration: vatRegistration, onDate: period.startsOn });
  const atEnd = resolveGbVatRegistrationOnDate({ registration: vatRegistration, onDate: period.endsOn });
  if (atStart.registered === null || atEnd.registered === null) {
    throw gbVatRefusal('GB_VAT_REGISTRATION_NOT_ESTABLISHED', "No VAT registration record establishes the client's status across this period; record the registration (or non-registration) before preparing a return.", 422);
  }
  if (atStart.registered === false && atEnd.registered === false) {
    throw gbVatRefusal('GB_VAT_RETURN_NOT_REGISTERED_FOR_PERIOD', 'The client is recorded as not VAT-registered across this period.', 422);
  }
  if (atStart.registered !== atEnd.registered) {
    throw gbVatRefusal('GB_VAT_REGISTRATION_PARTIAL_PERIOD', 'The VAT registration covers only part of this period; a partial-period return needs review.', 422);
  }
  const lineResult = await client.query(
    `select ll.journal_id, ll.line_no, ll.debit, ll.credit, ll.tax_type,
            ll.payload->>'role' as role, la.code as account_code, la.account_type
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where lj.firm_id = $1 and lj.client_id = $2 and lj.status in ('posted', 'closed')
        and lj.journal_date between $3 and $4
      order by lj.journal_date asc, ll.journal_id asc, ll.line_no asc`,
    [firmId, clientId, period.startsOn, period.endsOn]
  );
  return buildGbVatReturnFromLedgerLines({ period, lines: lineResult.rows });
};

export const prepareGbVatReturnFromDb = ({ firmId, clientId, periodKey, asOf, withFirmDbClientFn = withFirmDbClient } = {}) =>
  withFirmDbClientFn(async (client) => {
    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    return prepareGbVatReturnWithClient({
      client,
      firmId,
      clientId,
      periodKey,
      asOf,
      vatRegistration: profileResult.rows[0]?.profile?.vat_registration
    });
  });

// The OWNER surface's verdict lives in the market-NEUTRAL dispatcher
// ../ownerVatReturnSurface.js — moved there so AE could join the dispatch
// without a gb→ae import (the gap-8 edge shape), unconditional since
// 2026-08-31 (Kari, "nothing dark"). This module keeps only the GB
// preparation, rendering, and transmit seam.

const pounds = (value) => `£${Math.abs(Number(value) || 0).toFixed(2)}`;
export const renderGbVatReturnForOwner = ({ period, vatReturn } = {}) => {
  if (!period || !vatReturn) throw gbVatRefusal('GB_VAT_RETURN_NOT_PREPARED', 'A prepared VAT return is required.');
  assertPrepared(vatReturn);
  const lines = [
    `VAT return ${period.periodKey} (${period.startsOn} to ${period.endsOn})`,
    ...Array.from({ length: 9 }, (_, index) => `Box ${index + 1}: ${pounds(vatReturn.boxes[String(index + 1)])}`),
    vatReturn.outcome === 'repayment' ? `Repayment due: ${pounds(vatReturn.netVat)}` : `VAT due: ${pounds(vatReturn.netVat)}`,
    `Due ${period.dueOn}`
  ];
  return lines.join('\n');
};

const assertPrepared = (vatReturn) => {
  if (Object.keys(vatReturn.boxes || {}).length !== 9) {
    throw gbVatRefusal('GB_VAT_RETURN_NOT_PREPARED', 'All nine VAT boxes are required.');
  }
};

export const mtdVatSubmissionTransportPendingConfirmation = async () => {
  throw gbVatRefusal('GB_VAT_FILING_CHANNEL_UNAVAILABLE', 'HMRC MTD submission is unavailable pending primary-source wire confirmation.', 503);
};

export const submitPreparedGbVatReturn = async ({ prepared, transport = mtdVatSubmissionTransportPendingConfirmation } = {}) => {
  if (!prepared?.vatReturn) throw gbVatRefusal('GB_VAT_RETURN_NOT_PREPARED', 'A prepared VAT return is required.');
  assertPrepared(prepared.vatReturn);
  return transport({ prepared });
};
