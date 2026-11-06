// Pure partnership statutory dates. The entity return belongs here; partners'
// individual payments on account do not.
import { resolveGbTaxYear } from './accountingPeriod.js';
import { buildGbVatDeadlineRows } from './vatDeadlines.js';

export const GB_PARTNERSHIP_STATUTORY_PROVENANCE = Object.freeze({
  authority: Object.freeze(['HM Revenue & Customs']),
  source: 'remembered HMRC statutory timetable',
  as_of: '2026-08-01',
  confirmedAgainstPrimary: false,
  verificationNote: 'Primary HMRC guidance was unavailable in the sandbox; confirm every remembered date before an acting filing or payment lane relies on it.'
});

export const GB_PARTNERSHIP_REFUSALS = Object.freeze({
  registration: 'GB_PARTNERSHIP_TRADING_START_NOT_ESTABLISHED',
  vatRegistration: 'GB_PARTNERSHIP_VAT_REGISTRATION_NOT_ESTABLISHED',
  vatStagger: 'GB_PARTNERSHIP_VAT_STAGGER_NOT_ESTABLISHED'
});

const row = (key, label, due_date) => ({ key, label, due_date, terminal: 'scheduled' });
const refusal = (key, label, reason_code) => ({ key, label, due_date: null, terminal: 'on_owner', reason_code });

export const buildGbPartnershipStatutoryDeadlines = ({ profile = {}, asOf } = {}) => {
  const taxYear = resolveGbTaxYear(profile.accounting_period_end || asOf);
  const filingYear = Number(taxYear.ends_on.slice(0, 4)) + 1;
  const deadlines = [
    row('partnership_return_online', 'Online SA800 partnership return', `${filingYear}-01-31`),
    refusal('partnership_registration', 'Register the partnership for Self Assessment', GB_PARTNERSHIP_REFUSALS.registration),
    ...buildGbVatDeadlineRows({
      profile,
      onDate: taxYear.ends_on,
      year: Number(taxYear.ends_on.slice(0, 4)),
      refusalCodes: GB_PARTNERSHIP_REFUSALS
    })
  ];
  return { entity_type: 'gb-partnership', tax_year: taxYear, deadlines, provenance: GB_PARTNERSHIP_STATUTORY_PROVENANCE };
};
