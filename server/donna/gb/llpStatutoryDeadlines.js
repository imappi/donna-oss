// Pure LLP statutory deadline rows. LLPs file at Companies House but are
// tax-transparent: gb/entity.js deliberately excludes them from Corporation
// Tax, so CT600 and Corporation Tax payment rows do not belong in this pack.
// Tax-transparent is NOT tax-silent: an LLP trading with a view to profit
// files the SA800 partnership return — the same duty the partnership pack
// renders, and omitting it here would be the silence the two-terminal rail
// forbids.
import { resolveGbTaxYear } from './accountingPeriod.js';
import { computeGbLtdStatutoryDeadlines } from './ltdStatutoryDeadlines.js';
import { buildGbVatDeadlineRows } from './vatDeadlines.js';

export const GB_LLP_STATUTORY_PROVENANCE = Object.freeze({
  authority: Object.freeze(['Companies House', 'HM Revenue & Customs']),
  source: 'remembered Companies House and HMRC statutory timetable',
  as_of: '2026-08-01',
  confirmedAgainstPrimary: false,
  verificationNote: 'Primary guidance was unavailable in the sandbox; confirm every remembered date before an acting filing or payment lane relies on it.'
});

export const GB_LLP_REFUSALS = Object.freeze({
  accountingPeriod: 'GB_LLP_ACCOUNTING_PERIOD_NOT_ESTABLISHED',
  confirmationReviewPeriod: 'GB_LLP_CONFIRMATION_REVIEW_PERIOD_NOT_ESTABLISHED',
  registration: 'GB_LLP_SA_REGISTRATION_NOT_ESTABLISHED',
  vatRegistration: 'GB_LLP_VAT_REGISTRATION_NOT_ESTABLISHED',
  vatStagger: 'GB_LLP_VAT_STAGGER_NOT_ESTABLISHED'
});

const row = (key, label, due_date) => ({ key, label, due_date, terminal: 'scheduled' });
const refusal = (key, label, reason_code) => ({ key, label, due_date: null, terminal: 'on_owner', reason_code });

// ltdStatutoryDeadlines currently exposes one composite compute. Supply valid
// inert counterparts and discard its company-tax/VAT results rather than
// re-deriving either Companies House interval here.
const computeCompaniesHouseDates = ({ accountingPeriodEnd, confirmationReviewPeriodEnd }) =>
  computeGbLtdStatutoryDeadlines({
    accountingPeriodEnd: accountingPeriodEnd || '2000-12-31',
    confirmationReviewPeriodEnd: confirmationReviewPeriodEnd || '2000-12-31',
    vatStagger: 1
  });

export const buildGbLlpStatutoryDeadlines = ({ profile = {}, asOf } = {}) => {
  const computed = computeCompaniesHouseDates({
    accountingPeriodEnd: profile.accounting_period_end,
    confirmationReviewPeriodEnd: profile.confirmation_review_period_end
  });
  const deadlines = [
    profile.accounting_period_end
      ? row('accounts', 'Companies House LLP accounts', computed.companiesHouseAccountsDue.due_date)
      : refusal('accounts', 'Companies House LLP accounts', GB_LLP_REFUSALS.accountingPeriod),
    profile.confirmation_review_period_end
      ? row('confirmation', 'LLP confirmation statement', computed.confirmationStatementDue.due_date)
      : refusal('confirmation', 'LLP confirmation statement', GB_LLP_REFUSALS.confirmationReviewPeriod)
  ];
  // The members' partnership return — same construction and keys as the
  // partnership pack, LLP-worded labels.
  const taxYear = resolveGbTaxYear(profile.accounting_period_end || asOf);
  const filingYear = Number(taxYear.ends_on.slice(0, 4)) + 1;
  deadlines.push(
    row('partnership_return_online', 'Online SA800 partnership return (LLP)', `${filingYear}-01-31`),
    refusal('partnership_registration', 'Register the LLP for Self Assessment', GB_LLP_REFUSALS.registration)
  );
  const vatOnDate = profile.accounting_period_end || asOf;
  deadlines.push(...buildGbVatDeadlineRows({
    profile,
    onDate: vatOnDate,
    year: Number(vatOnDate.slice(0, 4)),
    refusalCodes: GB_LLP_REFUSALS
  }));
  return { entity_type: 'gb-llp', deadlines, provenance: GB_LLP_STATUTORY_PROVENANCE };
};
