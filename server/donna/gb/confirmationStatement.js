// Pure GB confirmation-statement arithmetic and content structure. No model,
// DB, network, or filing transport. Remembered statutory rules stay together
// in one unverified provenance block for later primary-source curation.

import { clientFlagActs } from '../clientConfig.js';
import { isValidCompanyNumber } from './entity.js';
import { toUtcIsoDay } from '../dates.js';

export const GB_CONFIRMATION_STATEMENT_PROVENANCE = Object.freeze({
  authority: Object.freeze(['Companies House']),
  asOf: '2026-07-30',
  confirmedAgainstPrimary: false,
  rules: Object.freeze({
    review_period_months: Object.freeze({ value: 12, note: 'Remembered: a confirmation-statement review period is 12 months; verify against Companies House primary guidance.' }),
    first_review_period_start: Object.freeze({ value: 'incorporation_date', note: 'Remembered: the first confirmation-statement review period starts on the incorporation date; verify against Companies House primary guidance.' }),
    filing_window_days: Object.freeze({ value: 14, note: 'Remembered: file within 14 days of the review-period end; verify. (Mirrors gb/ltdStatutoryDeadlines confirmation_statement_days.)' }),
    max_sic_codes: Object.freeze({ value: 4, note: 'Remembered: up to 4 SIC codes may be recorded; verify.' }),
    full_shareholder_list_cadence: Object.freeze({ value: 3, note: 'Remembered: a full shareholder list is required on the first statement and every third statement thereafter, changes-only otherwise; verify.' }),
    registered_email_required: Object.freeze({ value: true, note: 'Remembered (ECCTA 2023): a registered email address is a required element; verify effective date and scope.' })
  }),
  verificationNote: 'gov.uk is unavailable through the egress proxy; confirm the 12-month review period, 14-day filing window, ≤4 SIC-code cap, full shareholder-list cadence, and registered-email requirement together against Companies House primary guidance before any acting lane relies on them.'
});

export const GB_CONFIRMATION_STATEMENT_FLAG_KEY = 'GB_CONFIRMATION_STATEMENT';
export const gbConfirmationStatementEnabled = ({ snapshot = null, env = process.env } = {}) => clientFlagActs({
  flagKey: GB_CONFIRMATION_STATEMENT_FLAG_KEY,
  snapshot,
  envFallback: () => false,
  env
});

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
// UTC on purpose: bare calendar days anchored at T00:00:00Z, read back with
// toUtcIsoDay so the host zone never moves them.
const toIso = toUtcIsoDay;
const isIsoDate = (value) => typeof value === 'string' && ISO_DATE.test(value) && toIso(utc(value)) === value;
const toEpochDay = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

const dayAfterIso = (iso) => {
  const date = utc(iso);
  date.setUTCDate(date.getUTCDate() + 1);
  return toIso(date);
};

const dayBeforeIso = (iso) => {
  const date = utc(iso);
  date.setUTCDate(date.getUTCDate() - 1);
  return toIso(date);
};

const addMonthsIso = (iso, months) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return toIso(d);
};

const inputError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  return error;
};

const periodError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 409;
  return error;
};

export const deriveGbConfirmationReviewPeriod = (incorporationDate) => {
  if (!isIsoDate(incorporationDate)) {
    throw inputError('GB_CONFIRMATION_REVIEW_PERIOD_INCORPORATION_DATE_NOT_ESTABLISHED', 'A valid incorporation date is required to derive the first confirmation-statement review period.');
  }
  return {
    starts_on: incorporationDate,
    // This end is the input seam expected by gb/ltdStatutoryDeadlines.js.
    ends_on: dayBeforeIso(addMonthsIso(incorporationDate, GB_CONFIRMATION_STATEMENT_PROVENANCE.rules.review_period_months.value))
  };
};

export const resolveGbNextConfirmationReviewPeriod = (lastReviewPeriodEnd) => {
  if (!isIsoDate(lastReviewPeriodEnd)) {
    throw inputError('GB_CONFIRMATION_REVIEW_PERIOD_END_NOT_ESTABLISHED', 'A valid prior review-period end is required to derive the next confirmation-statement review period.');
  }
  const starts_on = dayAfterIso(lastReviewPeriodEnd);
  return {
    starts_on,
    ends_on: dayBeforeIso(addMonthsIso(starts_on, GB_CONFIRMATION_STATEMENT_PROVENANCE.rules.review_period_months.value))
  };
};

export const gbConfirmationReviewPeriodLengthDays = (starts_on, ends_on) => {
  if (!isIsoDate(starts_on) || !isIsoDate(ends_on)) return NaN;
  return toEpochDay(ends_on) - toEpochDay(starts_on) + 1;
};

export const assertGbConfirmationReviewPeriodsContiguous = (periods = []) => {
  const sorted = [...periods]
    .filter((period) => isIsoDate(period?.starts_on) && isIsoDate(period?.ends_on))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.starts_on <= previous.ends_on) {
      throw periodError('GB_CONFIRMATION_REVIEW_PERIOD_OVERLAP', `Confirmation-statement review periods overlap at ${current.starts_on}.`);
    }
    if (dayAfterIso(previous.ends_on) !== current.starts_on) {
      throw periodError('GB_CONFIRMATION_REVIEW_PERIOD_GAP', `Gap between confirmation-statement review periods ending ${previous.ends_on} and starting ${current.starts_on}.`);
    }
  }
  return sorted;
};

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const withinRoundingTolerance = (actual, expected) => Number.isFinite(Number(actual)) &&
  Number.isFinite(Number(expected)) && Math.abs(round2(actual) - round2(expected)) <= 0.005;

export const assertGbStatementOfCapitalFoots = ({
  share_classes,
  total_issued_shares,
  total_aggregate_nominal_value
} = {}) => {
  if (!Array.isArray(share_classes) || share_classes.length === 0) {
    throw inputError('GB_STATEMENT_OF_CAPITAL_EMPTY', 'At least one share class is required for a statement of capital.');
  }
  const currencies = new Set(share_classes.map((shareClass) => String(shareClass?.currency ?? '').trim()));
  if (currencies.size !== 1 || currencies.has('')) {
    throw inputError('GB_STATEMENT_OF_CAPITAL_MIXED_CURRENCY', 'All statement-of-capital share classes must use one currency.');
  }
  for (const shareClass of share_classes) {
    const expected = Number(shareClass?.shares_issued) * Number(shareClass?.nominal_value_per_share);
    if (!withinRoundingTolerance(shareClass?.aggregate_nominal_value, expected)) {
      throw periodError('GB_STATEMENT_OF_CAPITAL_CLASS_UNBALANCED', `Share class ${String(shareClass?.class ?? '(unnamed)')} does not foot.`);
    }
  }
  const issuedShares = share_classes.reduce((sum, shareClass) => sum + Number(shareClass.shares_issued), 0);
  const aggregateNominalValue = share_classes.reduce((sum, shareClass) => sum + Number(shareClass.aggregate_nominal_value), 0);
  if (!withinRoundingTolerance(total_issued_shares, issuedShares) ||
      !withinRoundingTolerance(total_aggregate_nominal_value, aggregateNominalValue)) {
    throw periodError('GB_STATEMENT_OF_CAPITAL_TOTALS_UNBALANCED', 'Statement-of-capital totals do not match the share-class totals.');
  }
  return { share_classes, total_issued_shares, total_aggregate_nominal_value, currency: [...currencies][0] };
};

export const assertGbSicCodes = (sicCodes = []) => {
  if (!Array.isArray(sicCodes)) {
    throw inputError('GB_CONFIRMATION_SIC_CODES_INVALID', 'SIC codes must contain between one and four five-digit codes.');
  }
  const deduped = [...new Set(sicCodes)];
  if (deduped.length === 0 || sicCodes.length > GB_CONFIRMATION_STATEMENT_PROVENANCE.rules.max_sic_codes.value ||
      deduped.some((code) => typeof code !== 'string' || !/^\d{5}$/.test(code))) {
    throw inputError('GB_CONFIRMATION_SIC_CODES_INVALID', 'SIC codes must contain between one and four five-digit codes.');
  }
  return deduped;
};

const isBlank = (value) => value == null ||
  (typeof value === 'string' && value.trim() === '') ||
  (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0);

export const buildGbConfirmationStatement = ({
  company_number,
  review_period,
  registered_office,
  registered_email,
  sic_codes,
  officers,
  psc_statement,
  statement_of_capital,
  shareholders
} = {}) => {
  if (!isValidCompanyNumber(company_number)) throw inputError('GB_CONFIRMATION_COMPANY_NUMBER_INVALID', 'A valid Companies House company number is required.');
  if (!isIsoDate(review_period?.starts_on) || !isIsoDate(review_period?.ends_on) || review_period.ends_on < review_period.starts_on) {
    throw inputError('GB_CONFIRMATION_REVIEW_PERIOD_NOT_ESTABLISHED', 'Valid, ordered confirmation-statement review-period bounds are required.');
  }
  if (isBlank(registered_office)) throw inputError('GB_CONFIRMATION_REGISTERED_OFFICE_MISSING', 'The registered office is required.');
  if (isBlank(registered_email)) throw inputError('GB_CONFIRMATION_REGISTERED_EMAIL_MISSING', 'The registered email address is required.');
  if (!Array.isArray(officers) || officers.length === 0) throw inputError('GB_CONFIRMATION_OFFICERS_MISSING', 'At least one officer is required.');
  if (!psc_statement || typeof psc_statement !== 'object' || Array.isArray(psc_statement)) {
    throw inputError('GB_CONFIRMATION_PSC_STATEMENT_MISSING', 'A PSC or no-PSC/exemption statement is required.');
  }
  const validatedSicCodes = assertGbSicCodes(sic_codes);
  const validatedCapital = statement_of_capital == null ? null : assertGbStatementOfCapitalFoots(statement_of_capital);
  const shareholder_list_note = `A full shareholder list is remembered as required on the first statement and every ${GB_CONFIRMATION_STATEMENT_PROVENANCE.rules.full_shareholder_list_cadence.value}rd statement; callers must surface and verify the applicable cadence.`;
  return Object.freeze({
    company_number,
    review_period: Object.freeze({ starts_on: review_period.starts_on, ends_on: review_period.ends_on }),
    content: Object.freeze({
      registered_office,
      registered_email,
      sic_codes: Object.freeze(validatedSicCodes),
      officers,
      psc_statement,
      statement_of_capital: validatedCapital,
      shareholders: shareholders ?? null,
      shareholder_list_note
    }),
    owner_confirmation_required: true,
    provenance_ref: 'GB_CONFIRMATION_STATEMENT_PROVENANCE'
  });
};
