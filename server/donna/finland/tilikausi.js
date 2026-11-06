// FI-4 — Tilikausi (Finnish fiscal year) resolver + KEEP-layer invariants.
// Pure DATA + pure compute. This module DECIDES tilikausi bounds and REFUSES
// invalid ones; the DB glue (the `fiscal_years` rows + the close-period nesting
// guard) lives in firmDb.js and calls these functions. No ledger post here.
//
// Statutory basis (Kirjanpitolaki): a tilikausi is normally 12 months. A
// single-entry (cash-basis, `yhdenkertainen`) sole trader — the Phase-1 non-ALV
// toiminimi — MUST use the calendar year, and its maximum length is 12 months
// (the 18-month deviation is the general/double-entry rule that arrives with Oy
// in Phase 2). The one in-scope deviation is a SHORT FIRST year: a business
// started mid-year runs its first tilikausi from the start date to 31 Dec, then
// full calendar years after. Off-calendar years are out of Phase-1 scope
// (decision F1, Kari 2026-07-09). Full design:
// docs/design-donna-finland-tilikausi-tositenumero.md §1.
//
// KEEP-layer: tilikausi length / nesting / overlap / continuity are deterministic
// legal invariants, not model judgment — they refuse, they do not guess.

import { toUtcIsoDay } from '../dates.js';

// The config-plane rollout flag key (a client_capability_config stage, migration
// 042; never an env pair). Read via clientFlagActs with envFallback () => false.
export const FINLAND_TILIKAUSI_FLAG_KEY = 'FINLAND_TILIKAUSI';

// FI-5 — the tositenumero (gap-free voucher numbering) rollout flag. Same
// config-plane discipline. DEPENDS on FINLAND_TILIKAUSI (the allocation needs a
// tilikausi row to count against); the dependency is enforced at flag-read in
// firmDb.js (both must act), never here.
export const FINLAND_TOSITENUMERO_FLAG_KEY = 'FINLAND_TOSITENUMERO';

// FI-6 — opening balances (switcher seed) + the year-2 ledgerReadModel
// carryforward (the F4-deferred equity split). Same config-plane discipline.
// DEPENDS on FINLAND_TILIKAUSI (both halves need the fiscal_years boundary to
// resolve); the dependency is enforced at flag-read in the caller (both must
// act), never here. Off ⇒ byte-identical: no opening journal, and the read model
// keeps its single cumulative-earnings equity line.
export const FINLAND_OPENING_BALANCES_FLAG_KEY = 'FINLAND_OPENING_BALANCES';

// FI-12 — annual return compute flag. DEPENDS on FINLAND_TILIKAUSI; callers enforce
// both config-plane flags with envFallback () => false (never an env pair).
export const FINLAND_ANNUAL_RETURN_FLAG_KEY = 'FINLAND_ANNUAL_RETURN';

// FI-10 — invoicing send-half (transmit + AR post) flag. Same config-plane
// discipline (envFallback () => false; never an env pair). The AR-post writer
// gates on it; tosite allocation additionally follows FI-4/FI-5's own flags.
// Design: docs/design-donna-finland-fi10-send-half.md.
export const FINLAND_INVOICING_FLAG_KEY = 'FINLAND_INVOICING';

// Persisted tilikausi lifecycle. Pinned to the migration 063 CHECK by
// migrations.test.js so the column and the runtime can never drift.
export const FISCAL_YEAR_STATUSES = Object.freeze(['open', 'closing', 'closed']);

// Max tilikausi length for the single-entry toiminimi profile: 12 months,
// leap-safe = 366 inclusive days (a calendar year is 365, 366 in a leap year,
// so 366 is the exact 12-month ceiling). The general/double-entry (Oy) profile
// is capped at 18 CALENDAR MONTHS — validated with month arithmetic, NOT a
// day-count. The old `MAX_GENERAL_TILIKAUSI_DAYS = 550` day-count is RETIRED in
// slice 13.1: 550 days can pass a period longer than 18 calendar months (e.g.
// 2028-01-01..2029-07-31 is 578 days but only 18m+30d — the day-count rejected
// it while a genuine 18-month period starting in a long-month stretch could
// slip through). KPL keys on calendar months, so we do too (D-FI13, §1 length row).
export const MAX_TOIMINIMI_TILIKAUSI_DAYS = 366;
export const MAX_GENERAL_TILIKAUSI_MONTHS = 18;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isIsoDate = (s) => typeof s === 'string' && ISO_DATE.test(s);

// UTC epoch-day integer for an ISO date — deterministic, timezone-free.
const toEpochDay = (iso) => Math.floor(Date.parse(`${iso}T00:00:00Z`) / 86400000);

// UTC on purpose, here and in addMonthsIso / dayBeforeIso: bare calendar
// days anchored at T00:00:00Z, read back with toUtcIsoDay so the host zone
// never moves them.
// The day after an ISO date, as ISO (UTC, no DST hazard).
const dayAfterIso = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return toUtcIsoDay(d);
};

// addMonthsIso(iso, n) — add n calendar months, clamping the day to the target
// month's last day (2026-01-31 + 1m → 2026-02-28, never a rolled-over 03-03).
// Deterministic UTC. This is what makes the 18-month cap a calendar-month rule.
const addMonthsIso = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const lastDayOfTargetMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDayOfTargetMonth));
  return toUtcIsoDay(d);
};

// The inclusive last valid ends_on for a general (Oy) tilikausi that starts on
// `starts_on`: the day BEFORE the 18-month anniversary (a half-open [start, start+18m)
// window rendered inclusive). 2026-01-01 → 2027-06-30.
export const maxGeneralTilikausiEndIso = (starts_on) =>
  isIsoDate(starts_on) ? dayBeforeIso(addMonthsIso(starts_on, MAX_GENERAL_TILIKAUSI_MONTHS)) : null;

// The day before an ISO date, as ISO (UTC).
const dayBeforeIso = (iso) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return toUtcIsoDay(d);
};

const tilikausiError = (message, code) => {
  const e = new Error(message);
  e.statusCode = 409;
  e.code = code;
  return e;
};

// tilikausiLengthDays(starts_on, ends_on) — inclusive day span (NaN on bad input).
export const tilikausiLengthDays = (starts_on, ends_on) => {
  if (!isIsoDate(starts_on) || !isIsoDate(ends_on)) return NaN;
  return toEpochDay(ends_on) - toEpochDay(starts_on) + 1;
};

// resolveFiscalYear({ date, incorporationDate }) — the tilikausi `date` falls in.
// Calendar-year by default; the FIRST tilikausi is SHORT when the business
// started mid-year (starts_on = incorporationDate rather than 1 Jan). Returns
// { label, starts_on, ends_on }.
export const resolveFiscalYear = ({ date, incorporationDate = null } = {}) => {
  if (!isIsoDate(date)) throw tilikausiError('resolveFiscalYear: date must be YYYY-MM-DD', 'TILIKAUSI_BAD_DATE');
  const year = date.slice(0, 4);
  const jan1 = `${year}-01-01`;
  const ends_on = `${year}-12-31`;
  let starts_on = jan1;
  // Short first year: incorporation in THIS year and after 1 Jan ⇒ the first
  // tilikausi starts on the incorporation date. A later year is a full calendar
  // year (incorporation in a prior year ⇒ no truncation).
  if (isIsoDate(incorporationDate) && incorporationDate.slice(0, 4) === year && incorporationDate > jan1) {
    starts_on = incorporationDate;
  }
  return { label: year, starts_on, ends_on };
};

// FI-13 slice 13.1a — the entity-aware fiscal-year resolver (D-FI13-3, C6).
//
// resolveFiscalYear ASSUMES the calendar year. That is correct for a toiminimi
// (single-entry, calendar-bound) but WRONG for an osakeyhtiö, whose tilikausi
// can be off-calendar and up to 18 months — an Oy silently resolved to
// calendar-year bounds mis-nests closes, mis-numbers tositteet, and mis-scopes
// the annual return. So for `fi-oy` calendar resolution is REFUSED: the period
// must come from the PERSISTED fiscal_years registry, or an EXPLICIT calendar
// override the caller sets on purpose. No persisted period + no override ⇒ throw
// (the C6 runtime assertion). This is entity-SAFETY, the same "refuse wrong
// output, never guess" family as the 13.0 form-5 guards — deliberately NOT flag-
// gated. It is byte-identical for every non-Oy entity type (calendar, exactly as
// before), and since no `fi-oy` client exists yet it is a pure no-op for the
// live book — the guard is installed ahead of the first Oy.
//
// `persistedPeriod` is the single fiscal_years row the DB caller resolved for the
// date ({ label, starts_on, ends_on }), or null. The caller is responsible for
// registry consistency (exactly one covering row) — an AMBIGUOUS registry
// (overlapping rows) is caught in the DB glue before this is called; here we only
// enforce that the row it passed actually COVERS the date (registry-mismatch).
export const resolveFiscalYearForEntity = ({
  date,
  incorporationDate = null,
  entityType = null,
  persistedPeriod = null,
  allowCalendarOverride = false
} = {}) => {
  if (!isIsoDate(date)) {
    throw tilikausiError('resolveFiscalYearForEntity: date must be YYYY-MM-DD', 'TILIKAUSI_BAD_DATE');
  }
  // Every non-Oy entity: calendar resolution, byte-identical to before.
  if (entityType !== 'fi-oy') {
    return resolveFiscalYear({ date, incorporationDate });
  }
  // fi-oy: a persisted period is the only honest source of bounds.
  if (persistedPeriod && isIsoDate(persistedPeriod.starts_on) && isIsoDate(persistedPeriod.ends_on)) {
    if (date < persistedPeriod.starts_on || date > persistedPeriod.ends_on) {
      throw tilikausiError(
        `fiscal-year registry mismatch: ${date} is outside the persisted tilikausi ${persistedPeriod.starts_on}..${persistedPeriod.ends_on}`,
        'FISCAL_YEAR_REGISTRY_MISMATCH'
      );
    }
    return {
      label: persistedPeriod.label ?? persistedPeriod.starts_on.slice(0, 4),
      starts_on: persistedPeriod.starts_on,
      ends_on: persistedPeriod.ends_on
    };
  }
  // No persisted period. Calendar resolution is refused for an Oy unless the
  // caller deliberately overrode (a genuine calendar-year Oy with no row yet).
  if (allowCalendarOverride) {
    return resolveFiscalYear({ date, incorporationDate });
  }
  throw tilikausiError(
    `osakeyhtiö fiscal-year resolution requires a persisted tilikausi for ${date} — calendar-year resolution is not permitted for an Oy without an explicit override`,
    'FISCAL_YEAR_OY_REQUIRES_PERSISTED_PERIOD'
  );
};

// assertValidTilikausi({ starts_on, ends_on, profile }) — throw on an invalid
// tilikausi; return { starts_on, ends_on, lengthDays } on success. profile
// 'toiminimi' (default, single-entry, 12-month cap) or 'general' (Oy/double-
// entry, 18-month cap).
export const assertValidTilikausi = ({ starts_on, ends_on, profile = 'toiminimi' } = {}) => {
  if (!isIsoDate(starts_on) || !isIsoDate(ends_on)) {
    throw tilikausiError('tilikausi bounds must be YYYY-MM-DD dates', 'TILIKAUSI_BAD_BOUNDS');
  }
  const lengthDays = tilikausiLengthDays(starts_on, ends_on);
  if (lengthDays <= 0) {
    throw tilikausiError('tilikausi ends_on must be on or after starts_on', 'TILIKAUSI_BAD_BOUNDS');
  }
  if (profile === 'general') {
    // 18 CALENDAR MONTHS (Oy/double-entry), not a day-count. Valid iff ends_on
    // is on or before the day before the 18-month anniversary of starts_on.
    const maxEnd = maxGeneralTilikausiEndIso(starts_on);
    if (ends_on > maxEnd) {
      throw tilikausiError(
        `tilikausi ${starts_on}..${ends_on} exceeds the general (Oy) maximum of ${MAX_GENERAL_TILIKAUSI_MONTHS} calendar months (last valid end ${maxEnd})`,
        'TILIKAUSI_TOO_LONG'
      );
    }
  } else if (lengthDays > MAX_TOIMINIMI_TILIKAUSI_DAYS) {
    throw tilikausiError(
      `tilikausi length ${lengthDays}d exceeds the toiminimi maximum (${MAX_TOIMINIMI_TILIKAUSI_DAYS}d)`,
      'TILIKAUSI_TOO_LONG'
    );
  }
  return { starts_on, ends_on, lengthDays };
};

// periodNestsInFiscalYear(period, fy) — a close period must lie WITHIN one
// tilikausi. Lexicographic ISO-date comparison is correct for YYYY-MM-DD.
export const periodNestsInFiscalYear = ({ period_start, period_end } = {}, fy = {}) =>
  isIsoDate(period_start) && isIsoDate(period_end) && isIsoDate(fy.starts_on) && isIsoDate(fy.ends_on) &&
  period_start >= fy.starts_on && period_end <= fy.ends_on;

// periodStraddlesTilikausi({ period_start, period_end, incorporationDate }) —
// true when the two ends resolve to DIFFERENT tilikaudet (the period crosses a
// fiscal-year boundary and may not be closed as one unit).
export const periodStraddlesTilikausi = ({ period_start, period_end, incorporationDate = null } = {}) => {
  const a = resolveFiscalYear({ date: period_start, incorporationDate });
  const b = resolveFiscalYear({ date: period_end, incorporationDate });
  return a.label !== b.label;
};

// assertTositeSequenceGapFree(numbers) — FI-5 KEEP-layer. The set of assigned
// tositenumerot within one tilikausi must be exactly {1..N}: gap-free (aukoton),
// no duplicates. Pure decision over the raw integer set — the DB glue in firmDb.js
// gathers the numbers (posted + voided; a voided voucher KEEPS its number) and
// hands them here. Empty set is trivially valid (no journals yet). Refuses, does
// not guess: a hole in the voucher sequence breaks the kirjausketju (audit trail).
export const assertTositeSequenceGapFree = (numbers = []) => {
  const seen = new Set();
  for (const raw of numbers) {
    if (!Number.isInteger(raw) || raw < 1) {
      throw tilikausiError(`tositenumero must be a positive integer, got ${raw}`, 'TOSITE_BAD_NUMBER');
    }
    if (seen.has(raw)) {
      throw tilikausiError(`duplicate tositenumero ${raw} in the tilikausi`, 'TOSITE_SEQUENCE_DUPLICATE');
    }
    seen.add(raw);
  }
  const n = seen.size;
  for (let i = 1; i <= n; i++) {
    if (!seen.has(i)) {
      throw tilikausiError(`tositenumero sequence has a gap at ${i} (aukoton kirjausketju broken)`, 'TOSITE_SEQUENCE_GAP');
    }
  }
  return n;
};

// assertFiscalYearsContiguous(years) — a client's tilikaudet must not overlap and
// must be gap-free (each starts the day after the previous ends). Continuity is
// what makes the FI-6 year-end roll-forward well-defined. Returns the sorted set.
export const assertFiscalYearsContiguous = (years = []) => {
  const sorted = [...years]
    .filter((y) => isIsoDate(y?.starts_on) && isIsoDate(y?.ends_on))
    .sort((a, b) => (a.starts_on < b.starts_on ? -1 : a.starts_on > b.starts_on ? 1 : 0));
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (cur.starts_on <= prev.ends_on) {
      throw tilikausiError(`tilikaudet overlap: ${prev.label ?? prev.starts_on} and ${cur.label ?? cur.starts_on}`, 'TILIKAUSI_OVERLAP');
    }
    if (dayAfterIso(prev.ends_on) !== cur.starts_on) {
      throw tilikausiError(`gap between tilikaudet ${prev.label ?? prev.ends_on} and ${cur.label ?? cur.starts_on}`, 'TILIKAUSI_GAP');
    }
  }
  return sorted;
};
