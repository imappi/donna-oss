// Pure UK-private-company deadline arithmetic. No model, network, or filing
// transport. Every statutory value is centralized in the unverified provenance
// block below so a network-open session can confirm the entire surface at once.

import { toUtcIsoDay } from '../dates.js';

export const GB_LTD_STATUTORY_PROVENANCE = Object.freeze({
  authority: Object.freeze(['Companies House', 'HM Revenue & Customs']),
  asOf: '2026-07-29',
  confirmedAgainstPrimary: false,
  rules: Object.freeze({
    accounts_filing_months: Object.freeze({ value: 9, note: 'Private-company accounts filing interval remembered as nine months after the accounting reference period; verify against Companies House primary guidance.' }),
    confirmation_statement_days: Object.freeze({ value: 14, note: 'Confirmation statement filing window remembered as fourteen days after the review-period end; verify against Companies House primary guidance.' }),
    ct600_filing_months: Object.freeze({ value: 12, note: 'Company Tax Return filing interval remembered as twelve months after the accounting period; verify against HMRC primary guidance.' }),
    corporation_tax_payment_months: Object.freeze({ value: 9, extraDays: 1, note: 'Corporation Tax payment interval remembered as nine months and one day after period end for a small company; verify scope and exceptions against HMRC primary guidance.' }),
    bank_holidays: Object.freeze({ constituentCountry: 'england_wales', note: 'England & Wales bank-holiday set and fixed-date substitute-day rule; verify against gov.uk primary guidance.' }),
    vat_staggers: Object.freeze({
      1: Object.freeze({ quarterEndMonths: Object.freeze([3, 6, 9, 12]), note: 'Stagger 1 quarter-end months require HMRC primary confirmation.' }),
      2: Object.freeze({ quarterEndMonths: Object.freeze([1, 4, 7, 10]), note: 'Stagger 2 quarter-end months require HMRC primary confirmation.' }),
      3: Object.freeze({ quarterEndMonths: Object.freeze([2, 5, 8, 11]), note: 'Stagger 3 quarter-end months require HMRC primary confirmation.' })
    })
  }),
  verificationNote: 'gov.uk was unavailable through the session egress proxy. These values are deliberately unconfirmed and must be checked together before an acting filing or payment lane relies on them.'
});

const ISO = /^\d{4}-\d{2}-\d{2}$/;
const utc = (iso) => new Date(`${iso}T00:00:00Z`);
// UTC on purpose: bare calendar days anchored at T00:00:00Z, read back with
// toUtcIsoDay so the host zone never moves them.
const toIso = toUtcIsoDay;

const validIso = (value) => {
  if (!ISO.test(String(value || ''))) return false;
  return toIso(utc(value)) === value;
};

const deadlineError = (code, message) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 422;
  return error;
};

const addDays = (iso, days) => {
  const date = utc(iso);
  date.setUTCDate(date.getUTCDate() + days);
  return toIso(date);
};

const addMonths = (iso, months) => {
  const date = utc(iso);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, last));
  return toIso(date);
};

// Anonymous Gregorian algorithm; pure and jurisdiction-neutral.
export const easterSundayIso = (year) => {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
};

const nthWeekday = (year, month, weekday, fromEnd = false) => {
  const day = fromEnd ? new Date(Date.UTC(year, month, 0)).getUTCDate() : 1;
  const step = fromEnd ? -1 : 1;
  for (let n = day; n >= 1 && n <= 31; n += step) {
    const iso = `${year}-${String(month).padStart(2, '0')}-${String(n).padStart(2, '0')}`;
    if (utc(iso).getUTCMonth() !== month - 1) continue;
    if (utc(iso).getUTCDay() === weekday) return iso;
  }
  return null;
};

export const ukBankHolidaysForYear = (year, { constituentCountry = 'england_wales' } = {}) => {
  if (constituentCountry !== 'england_wales') {
    throw deadlineError('GB_LTD_BANK_HOLIDAY_JURISDICTION_UNCONFIRMED', 'Only the provenance-pending England & Wales bank-holiday calendar is encoded.');
  }
  const easter = easterSundayIso(year);
  const holidays = new Set([
    `${year}-01-01`, addDays(easter, -2), addDays(easter, 1),
    nthWeekday(year, 5, 1), nthWeekday(year, 5, 1, true), nthWeekday(year, 8, 1, true),
    `${year}-12-25`, `${year}-12-26`
  ]);
  for (const fixed of [`${year}-01-01`, `${year}-12-25`, `${year}-12-26`]) {
    const dow = utc(fixed).getUTCDay();
    if (dow !== 0 && dow !== 6) continue;
    let substitute = addDays(fixed, dow === 6 ? 2 : 1);
    while (holidays.has(substitute) || [0, 6].includes(utc(substitute).getUTCDay())) substitute = addDays(substitute, 1);
    holidays.add(substitute);
  }
  return holidays;
};

export const isGbBusinessDay = (iso) => {
  if (!validIso(iso)) return false;
  const day = utc(iso).getUTCDay();
  return day !== 0 && day !== 6 && !ukBankHolidaysForYear(Number(iso.slice(0, 4))).has(iso);
};

export const nextGbBusinessDayIso = (iso) => {
  if (!validIso(iso)) return null;
  let current = iso;
  for (let i = 0; i < 21; i++) {
    if (isGbBusinessDay(current)) return current;
    current = addDays(current, 1);
  }
  return current;
};

export const shiftedDeadline = (rawIso) => {
  const dueDate = nextGbBusinessDayIso(rawIso);
  return { statutory_date: rawIso, due_date: dueDate, shifted: dueDate !== rawIso };
};

const lastDay = (year, month) => toIso(new Date(Date.UTC(year, month, 0)));

export const resolveGbVatQuarterEnds = ({ year, stagger } = {}) => {
  const y = Number(year);
  const key = Number(stagger);
  if (!Number.isInteger(y) || y < 1900 || y > 9999) {
    throw deadlineError('GB_LTD_VAT_YEAR_NOT_ESTABLISHED', 'A four-digit VAT year is required.');
  }
  const rule = GB_LTD_STATUTORY_PROVENANCE.rules.vat_staggers[key];
  if (!rule) {
    throw deadlineError('GB_LTD_VAT_STAGGER_NOT_ESTABLISHED', 'The client\'s HMRC-assigned VAT stagger must be 1, 2, or 3.');
  }
  return rule.quarterEndMonths.map((month) => lastDay(y, month));
};

export const computeGbLtdStatutoryDeadlines = ({
  accountingPeriodEnd,
  confirmationReviewPeriodEnd,
  vatStagger
} = {}) => {
  if (!validIso(accountingPeriodEnd)) {
    throw deadlineError('GB_LTD_ACCOUNTING_PERIOD_END_NOT_ESTABLISHED', 'A valid accounting period end is required.');
  }
  if (!validIso(confirmationReviewPeriodEnd)) {
    throw deadlineError('GB_LTD_CONFIRMATION_REVIEW_END_NOT_ESTABLISHED', 'A valid confirmation-statement review-period end is required.');
  }
  const rules = GB_LTD_STATUTORY_PROVENANCE.rules;
  const taxPaymentBase = addMonths(accountingPeriodEnd, rules.corporation_tax_payment_months.value);
  return {
    accountingPeriodEnd,
    companiesHouseAccountsDue: shiftedDeadline(addMonths(accountingPeriodEnd, rules.accounts_filing_months.value)),
    confirmationStatementDue: shiftedDeadline(addDays(confirmationReviewPeriodEnd, rules.confirmation_statement_days.value)),
    ct600Due: shiftedDeadline(addMonths(accountingPeriodEnd, rules.ct600_filing_months.value)),
    corporationTaxPaymentDue: shiftedDeadline(addDays(taxPaymentBase, rules.corporation_tax_payment_months.extraDays)),
    // VAT quarter ends are period ends, not filing deadlines, so remain unshifted.
    vatQuarterEnds: resolveGbVatQuarterEnds({ year: Number(accountingPeriodEnd.slice(0, 4)), stagger: vatStagger }),
    provenance: GB_LTD_STATUTORY_PROVENANCE
  };
};
