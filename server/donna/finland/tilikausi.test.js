import test from 'node:test';
import assert from 'node:assert/strict';
import {
  FINLAND_TILIKAUSI_FLAG_KEY,
  FINLAND_TOSITENUMERO_FLAG_KEY,
  FISCAL_YEAR_STATUSES,
  MAX_TOIMINIMI_TILIKAUSI_DAYS,
  MAX_GENERAL_TILIKAUSI_MONTHS,
  maxGeneralTilikausiEndIso,
  tilikausiLengthDays,
  resolveFiscalYear,
  resolveFiscalYearForEntity,
  assertValidTilikausi,
  periodNestsInFiscalYear,
  periodStraddlesTilikausi,
  assertFiscalYearsContiguous,
  assertTositeSequenceGapFree
} from './tilikausi.js';

test('flag key and status vocabulary are the expected constants', () => {
  assert.equal(FINLAND_TILIKAUSI_FLAG_KEY, 'FINLAND_TILIKAUSI');
  assert.equal(FINLAND_TOSITENUMERO_FLAG_KEY, 'FINLAND_TOSITENUMERO');
  assert.deepEqual([...FISCAL_YEAR_STATUSES], ['open', 'closing', 'closed']);
});

test('assertTositeSequenceGapFree accepts {1..N} in any order (incl. an empty set)', () => {
  assert.equal(assertTositeSequenceGapFree([]), 0);
  assert.equal(assertTositeSequenceGapFree([1]), 1);
  assert.equal(assertTositeSequenceGapFree([3, 1, 2]), 3);
  // Voided vouchers keep their number, so the DB set may include a voided one — the
  // CHECK is over the integer set only, and {1..N} is still intact.
  assert.equal(assertTositeSequenceGapFree([1, 2, 3, 4, 5]), 5);
});

test('assertTositeSequenceGapFree rejects a hole (aukoton kirjausketju broken)', () => {
  assert.throws(() => assertTositeSequenceGapFree([1, 2, 4]), /gap at 3/);
  assert.throws(() => assertTositeSequenceGapFree([2, 3]), /gap at 1/);
});

test('assertTositeSequenceGapFree rejects duplicates and non-positive integers', () => {
  assert.throws(() => assertTositeSequenceGapFree([1, 2, 2, 3]), /duplicate tositenumero 2/);
  assert.throws(() => assertTositeSequenceGapFree([0, 1]), /positive integer/);
  assert.throws(() => assertTositeSequenceGapFree([1, 2.5]), /positive integer/);
});

test('resolveFiscalYear defaults to the calendar year', () => {
  const fy = resolveFiscalYear({ date: '2026-05-14' });
  assert.deepEqual(fy, { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' });
});

test('resolveFiscalYear truncates the FIRST year to a mid-year incorporation (short first year)', () => {
  const fy = resolveFiscalYear({ date: '2026-08-01', incorporationDate: '2026-06-15' });
  assert.deepEqual(fy, { label: '2026', starts_on: '2026-06-15', ends_on: '2026-12-31' });
});

test('resolveFiscalYear does not truncate a later year (incorporation in a prior year)', () => {
  const fy = resolveFiscalYear({ date: '2027-03-01', incorporationDate: '2026-06-15' });
  assert.deepEqual(fy, { label: '2027', starts_on: '2027-01-01', ends_on: '2027-12-31' });
});

test('resolveFiscalYear treats a 1 Jan incorporation as a full calendar year', () => {
  const fy = resolveFiscalYear({ date: '2026-09-09', incorporationDate: '2026-01-01' });
  assert.equal(fy.starts_on, '2026-01-01');
});

test('resolveFiscalYear rejects a non-ISO date', () => {
  assert.throws(() => resolveFiscalYear({ date: '2026/01/01' }), /YYYY-MM-DD/);
});

// ── FI-13 13.1a — the entity-aware resolver (C6) ─────────────────────────────

test('resolveFiscalYearForEntity is byte-identical to calendar for every non-Oy entity', () => {
  for (const entityType of [null, undefined, 'fi-toiminimi', 'sg-pte', 'us-llc']) {
    assert.deepEqual(
      resolveFiscalYearForEntity({ date: '2026-05-14', entityType }),
      resolveFiscalYear({ date: '2026-05-14' })
    );
    // The short-first-year truncation still flows through for a toiminimi.
    assert.deepEqual(
      resolveFiscalYearForEntity({ date: '2026-08-01', incorporationDate: '2026-06-15', entityType }),
      resolveFiscalYear({ date: '2026-08-01', incorporationDate: '2026-06-15' })
    );
  }
});

test('an fi-oy WITHOUT a persisted period throws the C6 assertion (calendar resolution refused)', () => {
  assert.throws(
    () => resolveFiscalYearForEntity({ date: '2026-05-14', entityType: 'fi-oy' }),
    (e) => e.code === 'FISCAL_YEAR_OY_REQUIRES_PERSISTED_PERIOD' && e.statusCode === 409
  );
});

test('an fi-oy WITH an explicit override falls back to calendar (the deliberate escape hatch)', () => {
  const fy = resolveFiscalYearForEntity({ date: '2026-05-14', entityType: 'fi-oy', allowCalendarOverride: true });
  assert.deepEqual(fy, { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' });
});

test('an fi-oy resolves from its persisted (off-calendar) tilikausi', () => {
  const persistedPeriod = { label: 'FY2026', starts_on: '2026-07-01', ends_on: '2027-06-30' };
  const fy = resolveFiscalYearForEntity({ date: '2027-01-15', entityType: 'fi-oy', persistedPeriod });
  assert.deepEqual(fy, { label: 'FY2026', starts_on: '2026-07-01', ends_on: '2027-06-30' });
  // The label falls back to the start year when the persisted row carries none.
  const fyNoLabel = resolveFiscalYearForEntity({
    date: '2027-01-15', entityType: 'fi-oy',
    persistedPeriod: { starts_on: '2026-07-01', ends_on: '2027-06-30' }
  });
  assert.equal(fyNoLabel.label, '2026');
});

test('a persisted period that does NOT cover the date is a registry mismatch (never silently used)', () => {
  assert.throws(
    () => resolveFiscalYearForEntity({
      date: '2026-06-15', entityType: 'fi-oy',
      persistedPeriod: { label: 'FY2026', starts_on: '2026-07-01', ends_on: '2027-06-30' }
    }),
    (e) => e.code === 'FISCAL_YEAR_REGISTRY_MISMATCH' && e.statusCode === 409
  );
});

test('resolveFiscalYearForEntity rejects a non-ISO date up front', () => {
  assert.throws(() => resolveFiscalYearForEntity({ date: 'nope', entityType: 'fi-oy' }), /YYYY-MM-DD/);
});

test('tilikausiLengthDays counts inclusive days (full calendar year = 365, leap = 366)', () => {
  assert.equal(tilikausiLengthDays('2026-01-01', '2026-12-31'), 365);
  assert.equal(tilikausiLengthDays('2024-01-01', '2024-12-31'), 366); // 2024 is a leap year
  assert.equal(tilikausiLengthDays('2026-06-15', '2026-12-31'), 200);
});

test('assertValidTilikausi accepts a calendar year and a short first year', () => {
  assert.equal(assertValidTilikausi({ starts_on: '2026-01-01', ends_on: '2026-12-31' }).lengthDays, 365);
  assert.equal(assertValidTilikausi({ starts_on: '2026-06-15', ends_on: '2026-12-31' }).lengthDays, 200);
  // a full leap-year calendar tilikausi (366d) sits exactly on the toiminimi ceiling
  assert.equal(assertValidTilikausi({ starts_on: '2024-01-01', ends_on: '2024-12-31' }).lengthDays, MAX_TOIMINIMI_TILIKAUSI_DAYS);
});

test('assertValidTilikausi rejects a single-entry toiminimi year over 12 months', () => {
  // 2026-01-01 .. 2027-01-31 is > 366 days
  assert.throws(() => assertValidTilikausi({ starts_on: '2026-01-01', ends_on: '2027-01-31' }), /exceeds the toiminimi maximum/);
});

test('assertValidTilikausi allows up to 18 CALENDAR months for the general (Oy) profile', () => {
  // 2026-01-01 .. 2027-06-30 is exactly 18 calendar months (the day before the
  // 18-month anniversary 2027-07-01) — the boundary must PASS.
  const res = assertValidTilikausi({ starts_on: '2026-01-01', ends_on: '2027-06-30', profile: 'general' });
  assert.ok(res.lengthDays > MAX_TOIMINIMI_TILIKAUSI_DAYS);
  assert.equal(maxGeneralTilikausiEndIso('2026-01-01'), '2027-06-30');
  // One day past the boundary must FAIL, by calendar months not a day-count.
  assert.throws(
    () => assertValidTilikausi({ starts_on: '2026-01-01', ends_on: '2027-07-01', profile: 'general' }),
    /exceeds the general \(Oy\) maximum of 18 calendar months/
  );
});

test('the calendar-month cap validates by months, not the old 550-day count', () => {
  // The rule is now calendar months: 18m from 2027-02-01 lands on 2028-08-01, so
  // the last valid end is 2028-07-31 and 2028-08-01 is one day over — rejected by
  // the month rule regardless of the exact inclusive day-count.
  assert.equal(maxGeneralTilikausiEndIso('2027-02-01'), '2028-07-31');
  assert.throws(
    () => assertValidTilikausi({ starts_on: '2027-02-01', ends_on: '2028-08-01', profile: 'general' }),
    /18 calendar months/
  );
  // Month-end clamping: a start on the 31st resolves the anniversary to the
  // target month's last day (no rollover). 2026-08-31 + 18m → 2028-02-29 (leap),
  // last valid end = 2028-02-28.
  assert.equal(MAX_GENERAL_TILIKAUSI_MONTHS, 18);
  assert.equal(maxGeneralTilikausiEndIso('2026-08-31'), '2028-02-28');
});

test('assertValidTilikausi rejects reversed or non-ISO bounds', () => {
  assert.throws(() => assertValidTilikausi({ starts_on: '2026-12-31', ends_on: '2026-01-01' }), /on or after/);
  assert.throws(() => assertValidTilikausi({ starts_on: 'x', ends_on: '2026-12-31' }), /YYYY-MM-DD/);
});

test('periodNestsInFiscalYear is true only when the period lies within the tilikausi', () => {
  const fy = { starts_on: '2026-01-01', ends_on: '2026-12-31' };
  assert.equal(periodNestsInFiscalYear({ period_start: '2026-03-01', period_end: '2026-03-31' }, fy), true);
  assert.equal(periodNestsInFiscalYear({ period_start: '2026-01-01', period_end: '2026-12-31' }, fy), true);
  assert.equal(periodNestsInFiscalYear({ period_start: '2025-12-01', period_end: '2026-01-31' }, fy), false);
  assert.equal(periodNestsInFiscalYear({ period_start: '2026-12-01', period_end: '2027-01-31' }, fy), false);
});

test('periodStraddlesTilikausi flags a period crossing the year boundary', () => {
  assert.equal(periodStraddlesTilikausi({ period_start: '2026-03-01', period_end: '2026-03-31' }), false);
  assert.equal(periodStraddlesTilikausi({ period_start: '2026-12-01', period_end: '2027-01-31' }), true);
});

test('periodStraddlesTilikausi respects the short first year boundary', () => {
  // a period starting before incorporation resolves to the same year label, so it
  // does not "straddle" — but the nesting guard (periodNestsInFiscalYear) still
  // rejects it because it falls before starts_on.
  assert.equal(
    periodStraddlesTilikausi({ period_start: '2026-05-01', period_end: '2026-07-31', incorporationDate: '2026-06-15' }),
    false
  );
});

test('assertFiscalYearsContiguous accepts a gap-free, non-overlapping set', () => {
  const sorted = assertFiscalYearsContiguous([
    { label: '2027', starts_on: '2027-01-01', ends_on: '2027-12-31' },
    { label: '2026', starts_on: '2026-06-15', ends_on: '2026-12-31' } // short first year
  ]);
  assert.deepEqual(sorted.map((y) => y.label), ['2026', '2027']);
});

test('assertFiscalYearsContiguous rejects overlap and gaps', () => {
  assert.throws(() => assertFiscalYearsContiguous([
    { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' },
    { label: '2026b', starts_on: '2026-12-15', ends_on: '2027-06-30' }
  ]), /overlap/);
  assert.throws(() => assertFiscalYearsContiguous([
    { label: '2026', starts_on: '2026-01-01', ends_on: '2026-12-31' },
    { label: '2028', starts_on: '2028-01-01', ends_on: '2028-12-31' } // 2027 missing
  ]), /gap/);
});
