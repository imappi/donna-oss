import test from 'node:test';
import assert from 'node:assert/strict';
import { US_MILEAGE_RATE_BY_YEAR, usBusinessMileageDeduction, usMileageRateForYear } from './us/mileage.js';

test('US 2026 business mileage rate is the IRS 72.5 cents per mile row', () => {
  assert.equal(US_MILEAGE_RATE_BY_YEAR[2026].business, 0.725);
  assert.equal(US_MILEAGE_RATE_BY_YEAR[2026].confirmedAgainstPrimary, true);
  const rate = usMileageRateForYear(2026);
  assert.equal(rate.exact, true);
  assert.equal(rate.rate.currency, 'USD');
});

test('usBusinessMileageDeduction computes the current-rate amount without tax-advice wording', () => {
  const computed = usBusinessMileageDeduction({ miles: 120, year: 2026 });
  assert.equal(computed.miles, 120);
  assert.equal(computed.rate, 0.725);
  assert.equal(computed.deduction, 87);
  assert.equal(computed.currency, 'USD');
});
