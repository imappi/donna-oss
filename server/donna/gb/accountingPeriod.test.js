import assert from 'node:assert/strict';
import test from 'node:test';
import {
  GB_ACCOUNTING_PERIOD_FLAG_KEY,
  GB_ACCOUNTING_PERIOD_PROVENANCE,
  assertGbAccountingPeriodsContiguous,
  assertValidGbAccountingPeriod,
  deriveGbAccountingReferenceDate,
  gbAccountingPeriodEnabled,
  gbAccountingPeriodLengthDays,
  resolveGbAccountingPeriod,
  resolveGbAccountingPeriodForEntity,
  resolveGbFirstAccountingPeriod,
  resolveGbFiscalYearForEntity,
  resolveGbTaxYear,
  splitGbAccountingPeriodForCT
} from './accountingPeriod.js';

const hasCode = (code, statusCode) => (error) => error.code === code && (statusCode == null || error.statusCode === statusCode);

test('derives first-anniversary month-end ARDs, including month-end and February clamping', () => {
  assert.equal(deriveGbAccountingReferenceDate('2025-03-15'), '2026-03-31');
  assert.equal(deriveGbAccountingReferenceDate('2025-07-04'), '2026-07-31');
  assert.equal(deriveGbAccountingReferenceDate('2025-04-30'), '2026-04-30');
  assert.equal(deriveGbAccountingReferenceDate('2025-02-10'), '2026-02-28');
});

test('refuses missing, malformed, and impossible incorporation dates', () => {
  for (const value of ['', '2025/03/15', '2025-02-30']) {
    assert.throws(() => deriveGbAccountingReferenceDate(value), hasCode('GB_ACCOUNTING_PERIOD_INCORPORATION_DATE_NOT_ESTABLISHED', 422));
  }
});

test('resolves the untruncated first accounting period', () => {
  assert.deepEqual(resolveGbFirstAccountingPeriod('2025-03-15'), { starts_on: '2025-03-15', ends_on: '2026-03-31' });
});

test('resolves a subsequent unchanged-ARD 12-month period', () => {
  assert.deepEqual(resolveGbAccountingPeriod({ date: '2027-01-01', incorporationDate: '2025-03-15' }), {
    starts_on: '2026-04-01', ends_on: '2027-03-31', label: '2027'
  });
});

test('changed ARDs require a covering persisted period', () => {
  const persistedPeriod = { starts_on: '2026-02-01', ends_on: '2027-01-31', label: 'custom-2027' };
  assert.deepEqual(resolveGbAccountingPeriodForEntity({ date: '2026-08-01', ardChanged: true, persistedPeriod }), persistedPeriod);
  assert.throws(() => resolveGbAccountingPeriodForEntity({ date: '2027-02-01', ardChanged: true, persistedPeriod }), hasCode('GB_ACCOUNTING_PERIOD_REGISTRY_MISMATCH'));
  assert.throws(() => resolveGbAccountingPeriodForEntity({ date: '2026-08-01', ardChanged: true }), hasCode('GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED'));
});

test('unchanged ARDs derive rather than requiring persistence', () => {
  assert.deepEqual(resolveGbAccountingPeriodForEntity({ date: '2027-01-01', incorporationDate: '2025-03-15', ardChanged: false }), {
    starts_on: '2026-04-01', ends_on: '2027-03-31', label: '2027'
  });
});

test('splits a long first accounts period into at most two CT periods', () => {
  assert.deepEqual(splitGbAccountingPeriodForCT({ starts_on: '2025-03-15', ends_on: '2026-03-31' }), [
    { starts_on: '2025-03-15', ends_on: '2026-03-14' },
    { starts_on: '2026-03-15', ends_on: '2026-03-31' }
  ]);
  assert.deepEqual(splitGbAccountingPeriodForCT({ starts_on: '2025-04-01', ends_on: '2026-03-31' }), [
    { starts_on: '2025-04-01', ends_on: '2026-03-31' }
  ]);
});

test('CT splitting refuses bad bounds and periods over 24 months', () => {
  assert.throws(() => splitGbAccountingPeriodForCT({ starts_on: '2026-03-31', ends_on: '2025-03-15' }), hasCode('GB_ACCOUNTING_PERIOD_BOUNDS_NOT_ESTABLISHED'));
  assert.throws(() => splitGbAccountingPeriodForCT({ starts_on: '2025-01-01', ends_on: '2027-01-01' }), hasCode('GB_ACCOUNTING_PERIOD_TOO_LONG_TO_SPLIT'));
});

test('length helper is inclusive and returns NaN for invalid input', () => {
  assert.equal(gbAccountingPeriodLengthDays('2026-04-01', '2027-03-31'), 365);
  assert.equal(Number.isNaN(gbAccountingPeriodLengthDays('bad', '2027-03-31')), true);
});

test('validates first-period calendar bounds and subsequent ARD periods', () => {
  assert.doesNotThrow(() => assertValidGbAccountingPeriod({ starts_on: '2025-03-15', ends_on: '2026-03-31', isFirst: true }));
  assert.doesNotThrow(() => assertValidGbAccountingPeriod({ starts_on: '2026-04-01', ends_on: '2027-03-31' }));
  assert.throws(() => assertValidGbAccountingPeriod({ starts_on: '2025-01-01', ends_on: '2026-07-31', isFirst: true }), hasCode('GB_ACCOUNTING_PERIOD_FIRST_LENGTH_INVALID', 409));
  assert.throws(() => assertValidGbAccountingPeriod({ starts_on: '2025-01-01', ends_on: '2025-05-31', isFirst: true }), hasCode('GB_ACCOUNTING_PERIOD_FIRST_LENGTH_INVALID'));
  assert.throws(() => assertValidGbAccountingPeriod({ starts_on: '2026-04-01', ends_on: '2027-01-31' }), hasCode('GB_ACCOUNTING_PERIOD_LENGTH_INVALID'));
});

test('contiguity invariant accepts adjacency and names gaps and overlaps', () => {
  const first = { starts_on: '2025-04-01', ends_on: '2026-03-31' };
  const second = { starts_on: '2026-04-01', ends_on: '2027-03-31' };
  assert.deepEqual(assertGbAccountingPeriodsContiguous([second, first]), [first, second]);
  assert.throws(() => assertGbAccountingPeriodsContiguous([first, { ...second, starts_on: '2026-04-02' }]), hasCode('GB_ACCOUNTING_PERIOD_GAP', 409));
  assert.throws(() => assertGbAccountingPeriodsContiguous([first, { ...second, starts_on: '2026-03-31' }]), hasCode('GB_ACCOUNTING_PERIOD_OVERLAP', 409));
});

test('config-plane flag is born off and canary-enabled from a snapshot', () => {
  assert.equal(GB_ACCOUNTING_PERIOD_FLAG_KEY, 'GB_ACCOUNTING_PERIOD');
  assert.equal(gbAccountingPeriodEnabled({}), false);
  assert.equal(gbAccountingPeriodEnabled({ snapshot: { GB_ACCOUNTING_PERIOD: { stage: 'auto' } } }), true);
});

test('all remembered statutory rules stay in one unverified, noted provenance block', () => {
  assert.equal(GB_ACCOUNTING_PERIOD_PROVENANCE.confirmedAgainstPrimary, false);
  for (const rule of Object.values(GB_ACCOUNTING_PERIOD_PROVENANCE.rules)) assert.ok(rule.note);
});

test('resolveGbTaxYear: 6 April boundary, HMRC label convention, bad input refused', () => {
  assert.deepEqual(resolveGbTaxYear('2026-04-06'), { label: '2026/27', starts_on: '2026-04-06', ends_on: '2027-04-05' });
  assert.deepEqual(resolveGbTaxYear('2026-04-05'), { label: '2025/26', starts_on: '2025-04-06', ends_on: '2026-04-05' });
  assert.deepEqual(resolveGbTaxYear('2026-12-31'), { label: '2026/27', starts_on: '2026-04-06', ends_on: '2027-04-05' });
  assert.deepEqual(resolveGbTaxYear('2026-01-01'), { label: '2025/26', starts_on: '2025-04-06', ends_on: '2026-04-05' });
  // Century label wrap stays two digits.
  assert.equal(resolveGbTaxYear('2099-06-01').label, '2099/00');
  assert.throws(() => resolveGbTaxYear('06/04/2026'), hasCode('GB_ACCOUNTING_PERIOD_DATE_NOT_ESTABLISHED', 422));
});

test('resolveGbFiscalYearForEntity: persisted registry row wins for every axis; mismatch refused', () => {
  const persisted = { label: 'FY26', starts_on: '2026-01-01', ends_on: '2026-12-31' };
  for (const entityAxis of ['ltd', 'llp', 'sole_trader', 'partnership']) {
    assert.deepEqual(
      resolveGbFiscalYearForEntity({ date: '2026-06-15', entityAxis, persistedPeriod: persisted }),
      { label: 'FY26', starts_on: '2026-01-01', ends_on: '2026-12-31' }
    );
  }
  assert.throws(
    () => resolveGbFiscalYearForEntity({ date: '2027-06-15', entityAxis: 'ltd', persistedPeriod: persisted }),
    hasCode('GB_ACCOUNTING_PERIOD_REGISTRY_MISMATCH', 409)
  );
});

test('resolveGbFiscalYearForEntity: a company derives ARD periods from incorporation — first period, then 12-month month-ends', () => {
  // Incorporated 2025-05-10 → first ARD 2026-05-31.
  const first = resolveGbFiscalYearForEntity({ date: '2025-08-15', entityAxis: 'ltd', incorporationDate: '2025-05-10' });
  assert.deepEqual(first, { label: '2026', starts_on: '2025-05-10', ends_on: '2026-05-31' });
  // The last day of the first period still belongs to it.
  assert.equal(resolveGbFiscalYearForEntity({ date: '2026-05-31', entityAxis: 'ltd', incorporationDate: '2025-05-10' }).starts_on, '2025-05-10');
  // A date after the first ARD resolves the subsequent month-end period.
  const second = resolveGbFiscalYearForEntity({ date: '2026-07-15', entityAxis: 'llp', incorporationDate: '2025-05-10' });
  assert.deepEqual(second, { label: '2027', starts_on: '2026-06-01', ends_on: '2027-05-31' });
});

test('resolveGbFiscalYearForEntity: refusals — no incorporation date, pre-incorporation date, no axis', () => {
  assert.throws(
    () => resolveGbFiscalYearForEntity({ date: '2026-06-15', entityAxis: 'ltd' }),
    hasCode('GB_ACCOUNTING_PERIOD_REQUIRES_PERSISTED', 409)
  );
  assert.throws(
    () => resolveGbFiscalYearForEntity({ date: '2025-05-09', entityAxis: 'ltd', incorporationDate: '2025-05-10' }),
    hasCode('GB_ACCOUNTING_PERIOD_DATE_BEFORE_INCORPORATION', 409)
  );
  assert.throws(
    () => resolveGbFiscalYearForEntity({ date: '2026-06-15', entityAxis: null }),
    hasCode('GB_ACCOUNTING_PERIOD_ENTITY_NOT_ESTABLISHED', 409)
  );
});

test('resolveGbFiscalYearForEntity: an unincorporated business resolves the statutory 6-April tax year with no registry row', () => {
  assert.deepEqual(
    resolveGbFiscalYearForEntity({ date: '2026-06-15', entityAxis: 'sole_trader' }),
    { label: '2026/27', starts_on: '2026-04-06', ends_on: '2027-04-05' }
  );
  assert.equal(resolveGbFiscalYearForEntity({ date: '2026-02-01', entityAxis: 'partnership' }).label, '2025/26');
});
