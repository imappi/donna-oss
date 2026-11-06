import assert from 'node:assert/strict';
import test from 'node:test';

import {
  YHTEISOVERO_CONFIRMED_RATE,
  YHTEISOVERO_PENDING_CHANGE_FROM_YEAR,
  yhteisoveroRateForTaxYear,
  deriveTaxYears,
  buildTaxYear,
  buildTaxYearComputation,
  buildTaxYearSettlement,
  evaluateRateChange
} from './taxYear.js';

test('the confirmed rate is 20 % and the 18 % era is not coded (pending change from 2027)', () => {
  assert.equal(YHTEISOVERO_CONFIRMED_RATE, 0.20);
  assert.equal(YHTEISOVERO_PENDING_CHANGE_FROM_YEAR, 2027);
});

test('the rate keys on the tax year: 2026 confirmed 20 %; 2027+ stays 20 % flagged pending, never a silent 18 %', () => {
  const r2026 = yhteisoveroRateForTaxYear(2026);
  assert.equal(r2026.rate, 0.20);
  assert.equal(r2026.status, 'confirmed');
  assert.equal(r2026.note_en, null);

  const r2027 = yhteisoveroRateForTaxYear(2027);
  assert.equal(r2027.rate, 0.20, 'the coded rate is STILL 20 % — 18 % is not applied until primary-confirmed');
  assert.equal(r2027.status, 'pending_rate_change');
  assert.match(r2027.note_en, /18 %/);
  assert.match(r2027.note_fi, /18 %/);

  // A garbage year fails closed to the confirmed rate, flagged.
  const bad = yhteisoveroRateForTaxYear('nope');
  assert.equal(bad.rate, 0.20);
  assert.equal(bad.status, 'pending_rate_change');
});

test('the verovuosi rule: the tax year is the calendar year the tilikausi ENDS in', () => {
  const [ty] = deriveTaxYears({ fiscalPeriods: [{ id: 'p1', starts_on: '2026-01-01', ends_on: '2026-12-31' }] });
  assert.equal(ty.calendar_year, 2026);
  assert.deepEqual(ty.fiscal_period_ids, ['p1']);
  assert.equal(ty.combined, false);
  assert.equal(ty.starts_on, '2026-01-01');
  assert.equal(ty.ends_on, '2026-12-31');
});

test('an off-calendar tilikausi belongs to the calendar year of its END', () => {
  // Tilikausi 1.7.2025 .. 30.6.2026 ends in 2026 → verovuosi 2026, NOT 2025.
  const [ty] = deriveTaxYears({ fiscalPeriods: [{ id: 'p1', starts_on: '2025-07-01', ends_on: '2026-06-30' }] });
  assert.equal(ty.calendar_year, 2026);
  assert.equal(ty.starts_on, '2025-07-01');
  assert.equal(ty.ends_on, '2026-06-30');
});

test('multiple tilikaudet ending in ONE calendar year COMBINE into one tax year (§1)', () => {
  const tys = deriveTaxYears({ fiscalPeriods: [
    { id: 'p1', starts_on: '2025-01-01', ends_on: '2025-06-30' },
    { id: 'p2', starts_on: '2025-07-01', ends_on: '2025-12-31' },
    { id: 'p3', starts_on: '2026-01-01', ends_on: '2026-12-31' }
  ] });
  assert.equal(tys.length, 2, 'two tax years: 2025 (combined) and 2026');
  const ty2025 = tys.find((t) => t.calendar_year === 2025);
  assert.deepEqual(ty2025.fiscal_period_ids, ['p1', 'p2']);
  assert.equal(ty2025.combined, true);
  assert.equal(ty2025.starts_on, '2025-01-01');
  assert.equal(ty2025.ends_on, '2025-12-31', 'the combined tax year spans earliest start to latest end');
  assert.equal(tys.find((t) => t.calendar_year === 2026).combined, false);
});

test('deriveTaxYears is ordered ascending and ignores periods with a bad end date', () => {
  const tys = deriveTaxYears({ fiscalPeriods: [
    { id: 'p3', starts_on: '2027-01-01', ends_on: '2027-12-31' },
    { id: 'p1', starts_on: '2025-01-01', ends_on: '2025-12-31' },
    { id: 'bad', starts_on: '2026-01-01', ends_on: 'not-a-date' }
  ] });
  assert.deepEqual(tys.map((t) => t.calendar_year), [2025, 2027]);
});

test('buildTaxYearComputation applies the TaxYear rate to income-after-losses, never rate × posted result', () => {
  const comp = buildTaxYearComputation({
    taxYear: buildTaxYear({ calendarYear: 2026 }),
    taxableIncome: 100000,
    carriedLosses: [{ amount: 20000, vintage_year: 2024 }, { amount: 5000, vintage_year: 2025 }]
  });
  assert.equal(comp.usable_losses, 25000);
  assert.equal(comp.taxable_income_after_losses, 75000);
  assert.equal(comp.forecast_tax, 15000); // 75000 × 0.20
  assert.equal(comp.rate_status, 'confirmed');
  assert.equal(comp.lineage.basis_pending, false);
  assert.equal(comp.carried_losses[0].vintage_year, 2024, 'loss vintage is carried');
});

test('a computation with no supplied basis is a pending shell (13.5 fills the reconciliation)', () => {
  const comp = buildTaxYearComputation({ taxYear: buildTaxYear({ calendarYear: 2026 }) });
  assert.equal(comp.taxable_income, null);
  assert.equal(comp.forecast_tax, null);
  assert.equal(comp.lineage.basis_pending, true);
});

test('a 2027 computation carries the pending-rate-change flag through', () => {
  const comp = buildTaxYearComputation({ taxYear: buildTaxYear({ calendarYear: 2027 }), taxableIncome: 50000 });
  assert.equal(comp.rate, 0.20);
  assert.equal(comp.rate_status, 'pending_rate_change');
  assert.equal(comp.forecast_tax, 10000);
});

test('buildTaxYearSettlement nets liability against prepayments; assessment outranks forecast', () => {
  const ty = buildTaxYear({ calendarYear: 2026 });
  const onlyForecast = buildTaxYearSettlement({ taxYear: ty, forecastTax: 16000, prepayments: [{ amount: 10000 }], additionalPrepayments: [{ amount: 2000 }] });
  assert.equal(onlyForecast.prepaid_total, 12000);
  assert.equal(onlyForecast.net_position, 4000); // 16000 − 12000
  assert.equal(onlyForecast.net_position_basis, 'forecast');

  const assessed = buildTaxYearSettlement({ taxYear: ty, forecastTax: 16000, prepayments: [{ amount: 10000 }], assessment: { amount: 18000, decided_on: '2027-10-31' } });
  assert.equal(assessed.net_position, 8000); // 18000 − 10000, assessment basis
  assert.equal(assessed.net_position_basis, 'assessment');

  // A refund position (prepaid more than owed) is negative.
  const refund = buildTaxYearSettlement({ taxYear: ty, forecastTax: 5000, prepayments: [{ amount: 9000 }] });
  assert.equal(refund.net_position, -4000);
});

test('RateChangeEvent stays COLD in the pilot — never posts an uncoded era', () => {
  const cold2026 = evaluateRateChange({ taxYear: buildTaxYear({ calendarYear: 2026 }) });
  assert.equal(cold2026.applies, false);
  assert.equal(cold2026.reason, 'no_rate_change');
  assert.equal(cold2026.coded_rate, 0.20);

  const announced2027 = evaluateRateChange({ taxYear: buildTaxYear({ calendarYear: 2027 }) });
  assert.equal(announced2027.applies, false, 'announced but not coded ⇒ still no live post');
  assert.equal(announced2027.reason, 'rate_era_announced_not_coded');
  assert.equal(announced2027.coded_rate, 0.20);
});
