// Pure sole-trader statutory dates. Values remain provenance-pending until the
// network-open primary-source pass; missing owner facts become named rows.
import { resolveGbTaxYear } from './accountingPeriod.js';
import { buildGbVatDeadlineRows } from './vatDeadlines.js';

export const GB_SOLE_TRADER_STATUTORY_PROVENANCE = Object.freeze({
  authority: Object.freeze(['HM Revenue & Customs']), source: 'remembered HMRC statutory timetable',
  as_of: '2026-08-01', confirmedAgainstPrimary: false,
  verificationNote: 'Primary HMRC guidance was unavailable in the sandbox; confirm every remembered date before an acting filing or payment lane relies on it.'
});

export const GB_SOLE_TRADER_REFUSALS = Object.freeze({
  registration: 'GB_SOLE_TRADER_TRADING_START_NOT_ESTABLISHED',
  paymentsOnAccount: 'GB_SOLE_TRADER_PAYMENTS_ON_ACCOUNT_NOT_ESTABLISHED',
  vatRegistration: 'GB_SOLE_TRADER_VAT_REGISTRATION_NOT_ESTABLISHED',
  vatStagger: 'GB_SOLE_TRADER_VAT_STAGGER_NOT_ESTABLISHED'
});

const row = (key, label, due_date) => ({ key, label, due_date, terminal: 'scheduled' });
const refusal = (key, label, reason_code) => ({ key, label, due_date: null, terminal: 'on_owner', reason_code });

export const buildGbSoleTraderStatutoryDeadlines = ({ profile = {}, asOf } = {}) => {
  const taxYear = resolveGbTaxYear(profile.accounting_period_end || asOf);
  const nextYear = Number(taxYear.ends_on.slice(0, 4)) + 1;
  const deadlines = [
    row('self_assessment_online', 'Online Self Assessment return', `${nextYear}-01-31`),
    row('balancing_payment', 'Self Assessment balancing payment', `${nextYear}-01-31`),
    refusal('self_assessment_registration', 'Register for Self Assessment', GB_SOLE_TRADER_REFUSALS.registration)
  ];
  deadlines.push(refusal('payments_on_account', 'Payments on account', GB_SOLE_TRADER_REFUSALS.paymentsOnAccount));
  deadlines.push(...buildGbVatDeadlineRows({
    profile,
    onDate: taxYear.ends_on,
    year: Number(taxYear.ends_on.slice(0, 4)),
    refusalCodes: GB_SOLE_TRADER_REFUSALS
  }));
  return { entity_type: 'gb-sole-trader', tax_year: taxYear, deadlines, provenance: GB_SOLE_TRADER_STATUTORY_PROVENANCE };
};
