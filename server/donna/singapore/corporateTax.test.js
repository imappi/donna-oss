// SG-4 — corporate tax: YA resolution, exemption tiers, ECI waiver, form
// routing, the deadline calendar.
// node --test server/donna/singapore/corporateTax.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SINGAPORE_CORPORATE_TAX_FLAG_KEY,
  SG_CORPORATE_TAX_RATE,
  SG_CORPORATE_TAX_PROVENANCE,
  yearOfAssessmentForFye,
  resolveBasisPeriod,
  STARTUP_EXEMPTION,
  PARTIAL_EXEMPTION,
  computeSingaporeCorporateTax,
  startupExemptionApplies,
  ECI_WAIVER_REVENUE_CEILING_SGD,
  buildEciAssessment,
  FORM_CS_REVENUE_CEILING_SGD,
  FORM_CS_LITE_REVENUE_CEILING_SGD,
  citReturnFormForRevenue,
  citFilingDueDate,
  buildPteLtdTaxDeadlines
} from './corporateTax.js';

test('the rate pin + provenance honesty (no rebates encoded)', () => {
  assert.equal(SG_CORPORATE_TAX_RATE, 17);
  assert.equal(SINGAPORE_CORPORATE_TAX_FLAG_KEY, 'SINGAPORE_CORPORATE_TAX');
  assert.equal(SG_CORPORATE_TAX_PROVENANCE.confirmedAgainstPrimary, true);
  assert.match(SG_CORPORATE_TAX_PROVENANCE.source, /rebates deliberately NOT encoded/);
});

test('YA is the year after the basis-period end (preceding-year basis)', () => {
  assert.equal(yearOfAssessmentForFye('2025-06-30'), 2026);
  assert.equal(yearOfAssessmentForFye('2025-12-31'), 2026);
  assert.equal(yearOfAssessmentForFye('nope'), null);
  const basis = resolveBasisPeriod({ fyEndsOn: '2025-06-30' });
  assert.deepEqual(basis, { ya: 2026, starts_on: '2024-07-01', ends_on: '2025-06-30' });
  const explicit = resolveBasisPeriod({ fyEndsOn: '2025-12-31', fyStartsOn: '2025-04-01' });
  assert.equal(explicit.starts_on, '2025-04-01', 'an explicit (short/long) period is honoured, never re-derived');
  assert.throws(() => resolveBasisPeriod({}), (e) => e.code === 'SINGAPORE_BASIS_PERIOD_INVALID');
});

test('the exemption tiers: startup 75%/100k + 50%/100k; partial 75%/10k + 50%/190k', () => {
  assert.equal(STARTUP_EXEMPTION.yaCount, 3);
  // Startup at exactly 200k chargeable income: 75k + 50k = 125k exempt.
  const startup = computeSingaporeCorporateTax({ chargeableIncome: 200000, scheme: 'startup' });
  assert.equal(startup.exemptAmount, 125000);
  assert.equal(startup.taxableAfterExemption, 75000);
  assert.equal(startup.grossTax, 12750);
  // Partial at 200k: 7.5k + 95k = 102.5k exempt.
  const partial = computeSingaporeCorporateTax({ chargeableIncome: 200000, scheme: 'partial' });
  assert.equal(partial.exemptAmount, 102500);
  assert.equal(partial.taxableAfterExemption, 97500);
  assert.equal(partial.grossTax, 16575);
  // Below the first tier.
  assert.equal(computeSingaporeCorporateTax({ chargeableIncome: 8000, scheme: 'partial' }).exemptAmount, 6000);
  // Above the tiers the marginal band is fully taxed.
  const big = computeSingaporeCorporateTax({ chargeableIncome: 1000000, scheme: 'partial' });
  assert.equal(big.exemptAmount, 102500);
  assert.equal(big.grossTax, Math.round((1000000 - 102500) * 0.17 * 100) / 100);
  // scheme 'none' takes the flat rate.
  assert.equal(computeSingaporeCorporateTax({ chargeableIncome: 100000, scheme: 'none' }).grossTax, 17000);
  // Unknown scheme falls to partial (the safe default), negatives clamp.
  assert.equal(computeSingaporeCorporateTax({ chargeableIncome: -5, scheme: 'weird' }).grossTax, 0);
  assert.ok(PARTIAL_EXEMPTION.tiers[1].upTo === 200000);
});

test('startupExemptionApplies is pure YA-window arithmetic, conservative on missing data', () => {
  assert.equal(startupExemptionApplies({ incorporationYa: 2025, ya: 2025 }), true);
  assert.equal(startupExemptionApplies({ incorporationYa: 2025, ya: 2027 }), true, 'third YA');
  assert.equal(startupExemptionApplies({ incorporationYa: 2025, ya: 2028 }), false, 'fourth YA is out');
  assert.equal(startupExemptionApplies({ ya: 2026 }), false, 'missing data never over-promises the startup tiers');
});

test('ECI: due 3 months after FYE; waived only on revenue ≤ S$5M AND nil ECI', () => {
  assert.equal(ECI_WAIVER_REVENUE_CEILING_SGD, 5000000);
  const waived = buildEciAssessment({ fyEndsOn: '2025-12-31', annualRevenue: 400000, estimatedChargeableIncome: 0 });
  assert.equal(waived.ya, 2026);
  assert.equal(waived.dueOn, '2026-03-31');
  assert.equal(waived.waived, true);
  assert.equal(waived.mustFile, false);
  const notWaivedIncome = buildEciAssessment({ fyEndsOn: '2025-12-31', annualRevenue: 400000, estimatedChargeableIncome: 1 });
  assert.equal(notWaivedIncome.waived, false, 'positive ECI files even under the ceiling');
  const notWaivedRevenue = buildEciAssessment({ fyEndsOn: '2025-12-31', annualRevenue: 6000000, estimatedChargeableIncome: 0 });
  assert.equal(notWaivedRevenue.waived, false, 'revenue over the ceiling files even at nil');
  // Month-end clamp: FYE Nov 30 + 3 months → Feb 28/29, never Mar 2.
  assert.equal(buildEciAssessment({ fyEndsOn: '2025-11-30' }).dueOn, '2026-02-28');
  assert.throws(() => buildEciAssessment({}), (e) => e.code === 'SINGAPORE_BASIS_PERIOD_INVALID');
});

test('form routing by revenue + the 30 November filing deadline', () => {
  assert.equal(FORM_CS_LITE_REVENUE_CEILING_SGD, 200000);
  assert.equal(FORM_CS_REVENUE_CEILING_SGD, 5000000);
  assert.equal(citReturnFormForRevenue(150000), 'form_c_s_lite');
  assert.equal(citReturnFormForRevenue(3000000), 'form_c_s');
  assert.equal(citReturnFormForRevenue(8000000), 'form_c');
  assert.equal(citFilingDueDate(2026), '2026-11-30');
  assert.equal(citFilingDueDate(null), null);
});

test('the Pte Ltd tax calendar assembles ECI + the annual return with applies flags', () => {
  const calendar = buildPteLtdTaxDeadlines({ fyEndsOn: '2025-12-31', annualRevenue: 400000, estimatedChargeableIncome: 0 });
  assert.equal(calendar.ya, 2026);
  const [eci, cit] = calendar.deadlines;
  assert.equal(eci.kind, 'eci');
  assert.equal(eci.applies, false, 'waived ECI is carried with applies:false, never dropped');
  assert.match(eci.note, /waived/);
  assert.equal(cit.kind, 'cit_return');
  assert.equal(cit.due_on, '2026-11-30');
  assert.equal(cit.form, 'form_c_s');
  assert.equal(cit.applies, true);
});

// https://www.iras.gov.sg/taxes/corporate-income-tax/form-c-s-form-c-s-(lite)-form-c-filing/overview-of-form-c-s-form-c-s-(lite)-form-c
// SG-2, retrieved 2026-09-24: inclusive ceilings; revenue alone is insufficient.
test('C-S revenue boundaries and non-revenue eligibility remain explicit', () => {
  assert.equal(citReturnFormForRevenue(200000), 'form_c_s_lite');
  assert.equal(citReturnFormForRevenue(200000.01), 'form_c_s');
  assert.equal(citReturnFormForRevenue(5000000), 'form_c_s');
  assert.equal(citReturnFormForRevenue(5000000.01), 'form_c');
  const row = buildPteLtdTaxDeadlines({ fyEndsOn: '2025-12-31', annualRevenue: 200000 }).deadlines[1];
  assert.match(row.note, /requires all IRAS qualifying conditions/);
  assert.match(SG_CORPORATE_TAX_PROVENANCE.forms.scope, /foreign tax credit or tax deducted at source/);
  assert.equal(buildEciAssessment({ fyEndsOn: '2025-12-31', annualRevenue: 5000000, estimatedChargeableIncome: 0 }).waived, true);
  assert.equal(buildEciAssessment({ fyEndsOn: '2025-12-31', annualRevenue: 5000000.01, estimatedChargeableIncome: 0 }).waived, false);
});

// https://www.iras.gov.sg/due-dates — Due Dates, retrieved 2026-09-24.
// Published September-FYE ECI deadline: 31 Dec 2026.
test('ECI preserves month end: September FYE is due December 31, not December 30', () => {
  assert.equal(buildEciAssessment({ fyEndsOn: '2026-09-30' }).dueOn, '2026-12-31');
  assert.equal(buildEciAssessment({ fyEndsOn: '2026-06-30' }).dueOn, '2026-09-30');
  assert.equal(buildEciAssessment({ fyEndsOn: '2026-03-31' }).dueOn, '2026-06-30');
});
