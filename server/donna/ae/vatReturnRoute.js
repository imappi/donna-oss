// Above-the-wire AE VAT preparation route. Reads a recorded FTA-assigned
// period and posted ledger verdicts, prepares an owner-presentable VAT201,
// and refuses at the unaccredited EmaraTax transport boundary — the GB route
// shape (gb/vatReturnRoute.js) on the AE stack. The shipping terminal is
// decide-and-notify: Donna computes and re-foots; the OWNER files in
// EmaraTax and the submit seam stays a typed refusal until a Digital Tax
// Integrator channel slice lands (docs/design-donna-ae-vat-return.md §2–3).
//
// AED is assumed as the book currency — gap 14 (cross-currency conversion
// display) is parked because the outbound lane issues in book currency; an
// AE book is AED. Revisit before any AE cross-currency issuance.

import { withFirmDbClient, DEFAULT_FIRM_ID } from '../firmDb.js';
import { resolveAeVatRegistrationOnDate } from './vatRegistration.js';
import { aeVatRefusal, buildAeVatReturnFromLedgerLines } from './vatReturn.js';
import { resolveAeVatPeriod } from './vatPeriods.js';
import { resolveAeEstablishment } from './establishment.js';
import { toIsoDay } from '../dates.js';
import { AE_EMIRATES } from './vatCodes.js';

export const prepareAeVatReturnWithClient = async ({
  client,
  firmId,
  clientId,
  periodKey,
  asOf,
  vatRegistration,
  aeEstablishment
} = {}) => {
  if (!firmId || !clientId) throw aeVatRefusal('AE_VAT_SCOPE_REQUIRED', 'firmId and clientId are required.', 400);
  const periodResult = await client.query(
    `select id, period_key, start_date, end_date, due_date, status
       from ae_vat_periods
      where firm_id = $1 and client_id = $2
      order by start_date asc, id asc`,
    [firmId, clientId]
  );
  const period = resolveAeVatPeriod({ periods: periodResult.rows, periodKey, asOf });
  // Registration is resolved at BOTH period boundary dates — a return is a
  // statement about the period, not about today. Absence of a record must
  // never read as a VAT duty or its inverse (the tri-state rule), and a
  // registration covering only part of the period must never render a
  // silently-partial return.
  const atStart = resolveAeVatRegistrationOnDate({ registration: vatRegistration, onDate: period.startsOn });
  const atEnd = resolveAeVatRegistrationOnDate({ registration: vatRegistration, onDate: period.endsOn });
  if (atStart.registered === null || atEnd.registered === null) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_NOT_ESTABLISHED', "No VAT registration record establishes the client's status across this period; record the registration (or non-registration) before preparing a return.", 422);
  }
  if (atStart.registered === false && atEnd.registered === false) {
    throw aeVatRefusal('AE_VAT_RETURN_NOT_REGISTERED_FOR_PERIOD', 'The client is recorded as not VAT-registered across this period.', 422);
  }
  if (atStart.registered !== atEnd.registered) {
    throw aeVatRefusal('AE_VAT_REGISTRATION_PARTIAL_PERIOD', 'The VAT registration covers only part of this period; a partial-period return needs review.', 422);
  }
  const establishment = resolveAeEstablishment(aeEstablishment);
  const lineResult = await client.query(
    `select ll.journal_id, ll.line_no, ll.debit, ll.credit, ll.tax_type,
            ll.payload->>'role' as role, la.code as account_code, la.account_type,
            lj.journal_date, lj.currency, lj.source_id, lj.payload->'tax_point' as tax_point
       from ledger_lines ll
       join ledger_journals lj on lj.id = ll.journal_id
       join ledger_accounts la on la.id = ll.account_id
      where lj.firm_id = $1 and lj.client_id = $2 and lj.status in ('posted', 'closed')
        and lj.journal_date between $3 and $4
      order by lj.journal_date asc, ll.journal_id asc, ll.line_no asc`,
    [firmId, clientId, period.startsOn, period.endsOn]
  );
  // Native standard postings carry a distinct statutory-date receipt. No
  // historical gross or unproven journal becomes a bank-date VAT allocation.
  const runtimeAuthorities = new Map();
  for (const line of lineResult.rows) {
    if (!['AE_VAT_SR_5_OUTPUT', 'AE_VAT_SR_5_INPUT'].includes(line.tax_type)) continue;
    const point = line.tax_point;
    let authority = point?.authority_basis === 'transaction_review_correction';
    if (point?.authority_basis === 'config_plane:AE_VAT_FACT_AUTOMATION'
      && point.actor_id === 'ae_vat_fact_automation' && point.facts_version === 1 && point.model && point.context_digest && point.facts_digest) {
      if (!runtimeAuthorities.has(line.journal_id)) runtimeAuthorities.set(line.journal_id, (await client.query(
        `select id from audit_events where firm_id=$1 and client_id=$2 and actor_id=$3
          and action='transaction.tax_facts_generated' and resource_type='transaction' and resource_id=$4
          and metadata->>'tax_posting_facts_digest'=$5 and metadata->>'context_digest'=$6
          and metadata->>'model'=$7 and metadata->>'document_id'=$8 and metadata->>'evidence_digest'=$9
          and metadata->>'date_of_supply'=$10 and metadata->>'reporting_date'=$11 limit 1`,
        [firmId, clientId, point.actor_id, line.source_id, point.facts_digest, point.context_digest, point.model,
          point.document_id, point.evidence_digest, point.date_of_supply, point.reporting_date])).rows.length === 1);
      authority = runtimeAuthorities.get(line.journal_id);
    }
    if (line.currency !== 'AED' || !point?.document_id || !point?.evidence_digest
      || !point?.actor_id || !authority
      || point.reporting_date !== toIsoDay(line.journal_date) || point.date_of_supply !== point.reporting_date) {
      throw aeVatRefusal('AE_VAT_POSTED_TAX_POINT_UNSUPPORTED',
        'A native standard-rated journal requires its authoritative same-day supply/reporting receipt; statutory allocation cannot silently use its bank date.');
    }
  }
  return buildAeVatReturnFromLedgerLines({
    period,
    lines: lineResult.rows,
    establishmentEmirate: establishment.emirate,
    qualifyingEcommerceRegistrant: establishment.qualifyingEcommerceRegistrant
  });
};

export const prepareAeVatReturnFromDb = ({ firmId = DEFAULT_FIRM_ID, clientId, periodKey, asOf, withFirmDbClientFn = withFirmDbClient } = {}) =>
  withFirmDbClientFn(async (client) => {
    const profileResult = await client.query(
      'select profile from clients where firm_id = $1 and id = $2 limit 1',
      [firmId, clientId]
    );
    const profile = profileResult.rows[0]?.profile || {};
    return prepareAeVatReturnWithClient({
      client,
      firmId,
      clientId,
      periodKey,
      asOf,
      vatRegistration: profile.vat_registration,
      aeEstablishment: profile.ae_establishment
    });
  });

const dirhams = (value) => `AED ${Math.abs(Number(value) || 0).toFixed(2)}`;

const assertPrepared = (vatReturn) => {
  const byEmirate = vatReturn?.fields?.standard_rated_supplies?.by_emirate || {};
  if (Object.keys(byEmirate).length !== Object.keys(AE_EMIRATES).length || !vatReturn?.totals) {
    throw aeVatRefusal('AE_VAT_RETURN_NOT_PREPARED', 'A prepared VAT201 with all emirate rows is required.');
  }
};

// The owner-presentable rendering: every VAT201 field the book computes, the
// two honesty lines a filing owner must see (the customs-populated imports
// figure, the tourist-refund scope), and the due date. Emirate rows render
// only where nonzero — the seven-row zero wall is portal furniture, not
// information.
export const renderAeVatReturnForOwner = ({ period, vatReturn } = {}) => {
  if (!period || !vatReturn) throw aeVatRefusal('AE_VAT_RETURN_NOT_PREPARED', 'A prepared VAT return is required.');
  assertPrepared(vatReturn);
  const fields = vatReturn.fields;
  const emirateLines = Object.entries(fields.standard_rated_supplies.by_emirate)
    .filter(([, row]) => row.amount !== 0 || row.vat !== 0)
    .map(([key, row]) => `Standard-rated supplies — ${AE_EMIRATES[key]}: ${dirhams(row.amount)} (VAT ${dirhams(row.vat)})`);
  const lines = [
    `VAT return ${period.periodKey} (${period.startsOn} to ${period.endsOn})`,
    ...(emirateLines.length ? emirateLines : ['Standard-rated supplies: AED 0.00']),
    `Standard-rated total: ${dirhams(fields.standard_rated_supplies.total.amount)} (VAT ${dirhams(fields.standard_rated_supplies.total.vat)})`,
    `Zero-rated supplies: ${dirhams(fields.zero_rated_supplies.amount)}`,
    `Exempt supplies: ${dirhams(fields.exempt_supplies.amount)}`,
    `Reverse-charge supplies: ${dirhams(fields.reverse_charge_supplies.amount)} (VAT ${dirhams(fields.reverse_charge_supplies.vat)})`,
    'Goods imports: confirm the customs-populated figure in EmaraTax before filing.',
    `Standard-rated expenses: ${dirhams(fields.standard_rated_expenses.amount)} (recoverable ${dirhams(fields.standard_rated_expenses.recoverable_vat)})`,
    `Reverse-charge recoveries: ${dirhams(fields.reverse_charge_expenses.recoverable_vat)}`,
    `Total output VAT: ${dirhams(vatReturn.totals.output_vat)}`,
    `Total recoverable VAT: ${dirhams(vatReturn.totals.recoverable_vat)}`,
    vatReturn.outcome === 'refund' ? `Refund position: ${dirhams(vatReturn.netVat)}` : `VAT due: ${dirhams(vatReturn.netVat)}`,
    `Due ${period.dueOn} — you file this in EmaraTax; Donna prepared the figures.`
  ];
  return lines.join('\n');
};

// The transmit seam, kept dark by construction (scoping note §3): EmaraTax
// submission needs FTA Digital Tax Integrator recognition — a business
// precondition, not a code gap — plus a wire contract read. Until that slice
// lands, a transmit without an injected channel is this typed refusal, never
// a silent no-op or a false receipt.
export const aeVatSubmissionTransportPendingAccreditation = async () => {
  throw aeVatRefusal('AE_VAT_FILING_CHANNEL_UNAVAILABLE', 'EmaraTax submission is unavailable pending FTA Digital Tax Integrator accreditation; the owner files the prepared return in EmaraTax.', 503);
};

export const submitPreparedAeVatReturn = async ({ prepared, transport = aeVatSubmissionTransportPendingAccreditation } = {}) => {
  if (!prepared?.vatReturn) throw aeVatRefusal('AE_VAT_RETURN_NOT_PREPARED', 'A prepared VAT return is required.');
  assertPrepared(prepared.vatReturn);
  return transport({ prepared });
};
