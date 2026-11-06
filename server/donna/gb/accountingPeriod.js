// Pure GB accounting-reference-period arithmetic. No model, DB, network, or
// filing transport. The remembered statutory rules are deliberately collected
// in one unverified provenance block so they can be curated together.

import { clientFlagActs } from '../clientConfig.js';
import { toUtcIsoDay } from '../dates.js';

export const GB_ACCOUNTING_PERIOD_PROVENANCE = Object.freeze({
  authority: Object.freeze(['Companies House', 'HM Revenue & Customs']),
  asOf: '2026-07-30',
  confirmedAgainstPrimary: false,
  rules: Object.freeze({
    ard: Object.freeze({ value: 'last_day_of_first_anniversary_month', note: 'Remembered rule: the first accounting reference date is the last day of the first-anniversary month, recurring at that month-end; verify against Companies House primary guidance.' }),
    first_period_min_months: Object.freeze({ value: 6, note: 'Remembered lower bound for a first Companies House accounts period; verify together with the ARD rule.' }),
    first_period_max_months: Object.freeze({ value: 18, note: 'Remembered upper bound for a first Companies House accounts period; verify together with the ARD rule.' }),
    subsequent_period_months: Object.freeze({ value: 12, note: 'Remembered normal length for a subsequent unchanged-ARD accounts period; verify against Companies House primary guidance.' }),
    ct_period_max_months: Object.freeze({ value: 12, note: 'Remembered maximum Company Tax Return accounting-period length; verify against HMRC primary guidance.' }),
    tax_year: Object.freeze({ value: '04-06_to_04-05', note: 'Remembered rule: the UK tax year runs 6 April to 5 April; under basis-period reform (2024/25 onward) unincorporated businesses are taxed on the tax-year basis. A 31 March / other year-end election is expressed through the persisted fiscal_years registry, never derived. Verify against HMRC primary guidance.' })
  }),
  verificationNote: 'gov.uk unavailable through the session egress proxy; verify the ARD rule, the 6/18-month first-period bounds, and the 12-month CT cap together before an acting lane relies on them.'
});

// Config-plane flag, migration 042 pattern — clientFlagActs, envFallback: () => false;
// dark by default, canary per client.
export const GB_ACCOUNTING_PERIOD_FLAG_KEY = 'GB_ACCOUNTING_PERIOD';
export const gbAccountingPeriodEnabled = ({ snapshot = null, env = process.env } = {}) => clientFlagActs({
  flagKey: GB_ACCOUNTING_PERIOD_FLAG_KEY,
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

// UTC epoch-day integer for an ISO date — deterministic, timezone-free.
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

// Deterministic jurisdiction-neutral calendar-month arithmetic, clamped to the
// target month's last day.
const addMonthsIso = (iso, months) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return toIso(d);
};

const monthEndIso = (year, zeroBasedMonth) => toIso(new Date(Date.UTC(year, zeroBasedMonth + 1, 0)));

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

export const deriveGbAccountingReferenceDate = (incorporationDate) => {
  if (!isIsoDate(incorporationDate)) {
    throw inputError('GB_ACCOUNTING_PERIOD_INCORPORATION_DATE_NOT_ESTABLISHED', 'A valid incorporation date is required to derive the accounting reference date.');
  }
  const anniversary = addMonthsIso(incorporationDate, 12);
  const date = utc(anniversary);
  return monthEndIso(date.getUTCFullYear(), date.getUTCMonth());
};

export const resolveGbFirstAccountingPeriod = (incorporationDate) => ({
  starts_on: incorporationDate,
  ends_on: deriveGbAccountingReferenceDate(incorporationDate)
});

export const resolveGbAccountingPeriod = ({ date, incorporationDate } = {}) => {
  if (!isIsoDate(date)) {
    throw inputError('GB_ACCOUNTING_PERIOD_DATE_NOT_ESTABLISHED', 'A valid date is required to resolve a GB accounting period.');
  }
  const firstArd = deriveGbAccountingReferenceDate(incorporationDate);
  const ardMonth = Number(firstArd.slice(5, 7)) - 1;
  let endYear = Number(date.slice(0, 4));
  let ends_on = monthEndIso(endYear, ardMonth);
  if (date > ends_on) ends_on = monthEndIso(++endYear, ardMonth);
  const priorArd = monthEndIso(endYear - 1, ardMonth);
  return { starts_on: dayAfterIso(priorArd), ends_on, label: ends_on.slice(0, 4) };
};

export const resolveGbAccountingPeriodForEntity = ({
  date,
  incorporationDate = null,
  persistedPeriod = null,
  ardChanged = false
} = {}) => {
  if (!isIsoDate(date)) {
    throw inputError('GB_ACCOUNTING_PERIOD_DATE_NOT_ESTABLISHED', 'A valid date is required to resolve a GB accounting period.');
  }
  if (!ardChanged) return resolveGbAccountingPeriod({ date, incorporationDate });
  if (persistedPeriod && isIsoDate(persistedPeriod.starts_on) && isIsoDate(persistedPeriod.ends_on)) {
    if (date < persistedPeriod.starts_on || date > persistedPeriod.ends_on) {
      throw periodError('GB_ACCOUNTING_PERIOD_REGISTRY_MISMATCH', `${date} is outside persisted period ${persistedPeriod.starts_on}..${persistedPeriod.ends_on}.`);
    }
    return {
      starts_on: persistedPeriod.starts_on,
      ends_on: persistedPeriod.ends_on,
      label: persistedPeriod.label ?? persistedPeriod.ends_on.slice(0, 4)
    };
  }
  throw periodError('GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED', 'A company with a changed ARD requires a persisted accounting period covering the date.');
};

export const gbAccountingPeriodLengthDays = (starts_on, ends_on) => {
  if (!isIsoDate(starts_on) || !isIsoDate(ends_on)) return NaN;
  return toEpochDay(ends_on) - toEpochDay(starts_on) + 1;
};

// The UK tax year `date` falls in: 6 April – 5 April, labelled '2026/27'
// (HMRC's own convention). The unincorporated (sole trader / partnership)
// fiscal year under basis-period reform — see the tax_year provenance rule.
// Deterministic: every date maps to exactly one tax year; a 31 March (or
// other) year-end election is a persisted-registry fact, never derived here.
export const resolveGbTaxYear = (date) => {
  if (!isIsoDate(date)) {
    throw inputError('GB_ACCOUNTING_PERIOD_DATE_NOT_ESTABLISHED', 'A valid date is required to resolve a GB tax year.');
  }
  const year = Number(date.slice(0, 4));
  const startYear = date >= `${year}-04-06` ? year : year - 1;
  return {
    label: `${startYear}/${String((startYear + 1) % 100).padStart(2, '0')}`,
    starts_on: `${startYear}-04-06`,
    ends_on: `${startYear + 1}-04-05`
  };
};

// The entity-aware GB fiscal-year resolver — the GB twin of Finland's
// resolveFiscalYearForEntity (tilikausi.js), consumed by firmDb's
// resolveClientFiscalYearTx so every consumer path resolves through ONE seam.
// Same law, GB statute:
//
//   1. A PERSISTED fiscal_years row covering the date wins for every entity
//      axis — it is where an explicit intake (fiscalPeriodIntake), a changed
//      ARD, or a sole trader's 31 March election lives.
//   2. No persisted row: an incorporated company (ltd/llp) DERIVES its
//      accounting reference period from the incorporation date (the ARD is
//      set by statute at incorporation — first period incorporation → the
//      first-anniversary month-end, then 12-month month-end periods); no
//      incorporation date ⇒ REFUSE. Calendar-year resolution is never
//      assumed for a company — the exact C6 posture fi-oy takes.
//   3. An unincorporated business (sole_trader/partnership) resolves the
//      statutory 6-April tax year — deterministic, no registry required.
//
// A date before an incorporated company's incorporation falls in NO accounting
// period (the company did not exist) — refused, never clamped: a genuine
// pre-incorporation expense is deemed incurred on the first day of trading and
// should be journalled there, not have the period resolver paper over it.
export const resolveGbFiscalYearForEntity = ({
  date,
  entityAxis = null,
  incorporationDate = null,
  persistedPeriod = null
} = {}) => {
  if (!isIsoDate(date)) {
    throw inputError('GB_ACCOUNTING_PERIOD_DATE_NOT_ESTABLISHED', 'A valid date is required to resolve a GB fiscal year.');
  }
  if (persistedPeriod && isIsoDate(persistedPeriod.starts_on) && isIsoDate(persistedPeriod.ends_on)) {
    if (date < persistedPeriod.starts_on || date > persistedPeriod.ends_on) {
      throw periodError('GB_ACCOUNTING_PERIOD_REGISTRY_MISMATCH', `${date} is outside the persisted period ${persistedPeriod.starts_on}..${persistedPeriod.ends_on}.`);
    }
    return {
      label: persistedPeriod.label ?? persistedPeriod.ends_on.slice(0, 4),
      starts_on: persistedPeriod.starts_on,
      ends_on: persistedPeriod.ends_on
    };
  }
  if (entityAxis === 'sole_trader' || entityAxis === 'partnership') {
    return resolveGbTaxYear(date);
  }
  if (entityAxis === 'ltd' || entityAxis === 'llp') {
    if (!isIsoDate(incorporationDate)) {
      throw periodError('GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED', 'A GB company requires a persisted accounting period or an incorporation date to resolve its fiscal year — calendar-year resolution is not permitted for a company.');
    }
    if (date < incorporationDate) {
      throw periodError('GB_ACCOUNTING_PERIOD_DATE_BEFORE_INCORPORATION', `${date} precedes the company's incorporation on ${incorporationDate} — no accounting period covers it.`);
    }
    const first = resolveGbFirstAccountingPeriod(incorporationDate);
    if (date <= first.ends_on) {
      return { label: first.ends_on.slice(0, 4), starts_on: first.starts_on, ends_on: first.ends_on };
    }
    return resolveGbAccountingPeriod({ date, incorporationDate });
  }
  throw periodError('GB_ACCOUNTING_PERIOD_ENTITY_NOT_ESTABLISHED', 'A GB fiscal year requires a resolved entity axis (ltd, llp, sole_trader or partnership).');
};

export const splitGbAccountingPeriodForCT = ({ starts_on, ends_on } = {}) => {
  if (!isIsoDate(starts_on) || !isIsoDate(ends_on) || ends_on < starts_on) {
    throw inputError('GB_ACCOUNTING_PERIOD_BOUNDS_NOT_ESTABLISHED', 'Valid, ordered accounting-period bounds are required.');
  }
  const twelveMonthAnniversary = addMonthsIso(starts_on, GB_ACCOUNTING_PERIOD_PROVENANCE.rules.ct_period_max_months.value);
  if (ends_on < twelveMonthAnniversary) return [{ starts_on, ends_on }];
  const twentyFourMonthAnniversary = addMonthsIso(starts_on, 24);
  if (ends_on >= twentyFourMonthAnniversary) {
    throw inputError('GB_ACCOUNTING_PERIOD_TOO_LONG_TO_SPLIT', 'An accounting period of more than 24 months cannot be split into two CT periods.');
  }
  return [
    { starts_on, ends_on: dayBeforeIso(twelveMonthAnniversary) },
    { starts_on: twelveMonthAnniversary, ends_on }
  ];
};

export const assertValidGbAccountingPeriod = ({ starts_on, ends_on, isFirst = false } = {}) => {
  const lengthDays = gbAccountingPeriodLengthDays(starts_on, ends_on);
  if (!Number.isFinite(lengthDays) || ends_on <= starts_on) {
    throw periodError('GB_ACCOUNTING_PERIOD_BOUNDS_NOT_ESTABLISHED', 'Accounting-period bounds must be valid, ordered YYYY-MM-DD dates.');
  }
  if (isFirst) {
    const minEnd = dayBeforeIso(addMonthsIso(starts_on, GB_ACCOUNTING_PERIOD_PROVENANCE.rules.first_period_min_months.value));
    const maxEnd = dayBeforeIso(addMonthsIso(starts_on, GB_ACCOUNTING_PERIOD_PROVENANCE.rules.first_period_max_months.value));
    if (ends_on < minEnd || ends_on > maxEnd) {
      throw periodError('GB_ACCOUNTING_PERIOD_FIRST_LENGTH_INVALID', `First accounting period must be between ${minEnd} and ${maxEnd}.`);
    }
  } else {
    const expectedEnd = dayBeforeIso(addMonthsIso(starts_on, GB_ACCOUNTING_PERIOD_PROVENANCE.rules.subsequent_period_months.value));
    const endDate = utc(ends_on);
    const isMonthEnd = ends_on === monthEndIso(endDate.getUTCFullYear(), endDate.getUTCMonth());
    if (ends_on !== expectedEnd || !isMonthEnd) {
      throw periodError('GB_ACCOUNTING_PERIOD_LENGTH_INVALID', 'A subsequent accounting period must span 12 calendar months and end on a month-end ARD.');
    }
  }
  return { starts_on, ends_on, lengthDays };
};

export const assertGbAccountingPeriodsContiguous = (periods = []) => {
  const sorted = [...periods]
    .filter((period) => isIsoDate(period?.starts_on) && isIsoDate(period?.ends_on))
    .sort((a, b) => a.starts_on.localeCompare(b.starts_on));
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (current.starts_on <= previous.ends_on) {
      throw periodError('GB_ACCOUNTING_PERIOD_OVERLAP', `Accounting periods overlap at ${current.starts_on}.`);
    }
    if (dayAfterIso(previous.ends_on) !== current.starts_on) {
      throw periodError('GB_ACCOUNTING_PERIOD_GAP', `Gap between accounting periods ending ${previous.ends_on} and starting ${current.starts_on}.`);
    }
  }
  return sorted;
};
