import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GB_LTD_STATUTORY_PROVENANCE,
  computeGbLtdStatutoryDeadlines,
  isGbBusinessDay,
  nextGbBusinessDayIso,
  ukBankHolidaysForYear,
  resolveGbVatQuarterEnds
} from './ltdStatutoryDeadlines.js';

test('all statutory values live in one honestly unverified provenance block', () => {
  assert.equal(GB_LTD_STATUTORY_PROVENANCE.confirmedAgainstPrimary, false);
  assert.deepEqual(Object.keys(GB_LTD_STATUTORY_PROVENANCE.rules), [
    'accounts_filing_months', 'confirmation_statement_days', 'ct600_filing_months',
    'corporation_tax_payment_months', 'bank_holidays', 'vat_staggers'
  ]);
  for (const value of Object.values(GB_LTD_STATUTORY_PROVENANCE.rules)) {
    if ('note' in value) assert.ok(value.note.includes('verify'));
  }
});

test('computes accounts, confirmation statement, CT600 and CT payment windows deterministically', () => {
  const out = computeGbLtdStatutoryDeadlines({
    accountingPeriodEnd: '2025-12-31',
    confirmationReviewPeriodEnd: '2026-01-15',
    vatStagger: 1
  });
  assert.deepEqual(out.companiesHouseAccountsDue, { statutory_date: '2026-09-30', due_date: '2026-09-30', shifted: false });
  assert.deepEqual(out.confirmationStatementDue, { statutory_date: '2026-01-29', due_date: '2026-01-29', shifted: false });
  assert.deepEqual(out.ct600Due, { statutory_date: '2026-12-31', due_date: '2026-12-31', shifted: false });
  assert.deepEqual(out.corporationTaxPaymentDue, { statutory_date: '2026-10-01', due_date: '2026-10-01', shifted: false });
  assert.deepEqual(out.vatQuarterEnds, ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31']);
});

test('weekends shift forward while weekdays remain unchanged', () => {
  assert.equal(nextGbBusinessDayIso('2026-07-01'), '2026-07-01');
  assert.equal(nextGbBusinessDayIso('2026-07-04'), '2026-07-06');
  assert.equal(nextGbBusinessDayIso('2026-07-05'), '2026-07-06');
});

test('England and Wales calendar includes Easter and the three Monday holidays', () => {
  const holidays = ukBankHolidaysForYear(2026);
  for (const iso of ['2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31']) {
    assert.ok(holidays.has(iso));
    assert.equal(isGbBusinessDay(iso), false);
  }
});

test('fixed-date weekend holidays include collision-safe substitute days', () => {
  const christmas = ukBankHolidaysForYear(2027);
  assert.ok(christmas.has('2027-12-25'));
  assert.ok(christmas.has('2027-12-27'));
  assert.ok(christmas.has('2027-12-28'));
  assert.equal(nextGbBusinessDayIso('2027-12-25'), '2027-12-29');
  assert.equal(nextGbBusinessDayIso('2027-12-28'), '2027-12-29');
  assert.ok(ukBankHolidaysForYear(2028).has('2028-01-03'));
});

test('deadline output proves a weekend statutory date shifts but VAT period ends do not', () => {
  const out = computeGbLtdStatutoryDeadlines({ accountingPeriodEnd: '2026-01-31', confirmationReviewPeriodEnd: '2026-01-01', vatStagger: 2 });
  assert.deepEqual(out.companiesHouseAccountsDue, { statutory_date: '2026-10-31', due_date: '2026-11-02', shifted: true });
  for (const key of ['companiesHouseAccountsDue', 'confirmationStatementDue', 'ct600Due', 'corporationTaxPaymentDue']) {
    assert.deepEqual(Object.keys(out[key]), ['statutory_date', 'due_date', 'shifted']);
    assert.equal(isGbBusinessDay(out[key].due_date), true);
  }
  assert.deepEqual(out.vatQuarterEnds, ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
});

test('unsupported constituent countries are refused rather than guessed', () => {
  assert.doesNotThrow(() => ukBankHolidaysForYear(2026));
  assert.throws(() => ukBankHolidaysForYear(2026, { constituentCountry: 'scotland' }), (error) => error.code === 'GB_LTD_BANK_HOLIDAY_JURISDICTION_UNCONFIRMED' && error.statusCode === 422);
});

test('resolves each VAT stagger and refuses to guess an absent or invalid assignment', () => {
  assert.deepEqual(resolveGbVatQuarterEnds({ year: 2026, stagger: 2 }), ['2026-01-31', '2026-04-30', '2026-07-31', '2026-10-31']);
  assert.deepEqual(resolveGbVatQuarterEnds({ year: 2026, stagger: 3 }), ['2026-02-28', '2026-05-31', '2026-08-31', '2026-11-30']);
  assert.throws(() => resolveGbVatQuarterEnds({ year: 2026 }), (error) => error.code === 'GB_LTD_VAT_STAGGER_NOT_ESTABLISHED');
  assert.throws(() => resolveGbVatQuarterEnds({ year: 'unknown', stagger: 1 }), (error) => error.code === 'GB_LTD_VAT_YEAR_NOT_ESTABLISHED');
});

test('invalid and missing source dates produce named refusals', () => {
  assert.throws(() => computeGbLtdStatutoryDeadlines({ accountingPeriodEnd: '2026-02-30', confirmationReviewPeriodEnd: '2026-01-01', vatStagger: 1 }),
    (error) => error.code === 'GB_LTD_ACCOUNTING_PERIOD_END_NOT_ESTABLISHED');
  assert.throws(() => computeGbLtdStatutoryDeadlines({ accountingPeriodEnd: '2026-01-01', vatStagger: 1 }),
    (error) => error.code === 'GB_LTD_CONFIRMATION_REVIEW_END_NOT_ESTABLISHED');
});
