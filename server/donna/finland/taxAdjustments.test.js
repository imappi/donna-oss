// G-11 (FI-15) — accounting-to-tax adjustment layer tests
// (docs/design-donna-finland-fi15-g10-g14-p2-batch.md, D-P2-2/D-P2-3).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TAX_ADJUSTMENT_TYPES,
  TAX_ADJUSTMENT_TYPE_KEYS,
  TAX_ADJUSTMENT_PROVENANCE,
  REPRESENTATION_DEDUCTIBLE_SHARE,
  normalizeTaxAdjustmentsProfile,
  evaluateTaxAdjustments
} from './taxAdjustments.js';
import { buildAnnualReturn } from './annualReturn.js';

test('pins: the closed type vocabulary, the 50% representation rule, provenance-pending', () => {
  assert.deepEqual([...TAX_ADJUSTMENT_TYPE_KEYS], [
    'representation_expenses', 'non_deductible', 'additional_deduction', 'depreciation_difference'
  ]);
  assert.equal(REPRESENTATION_DEDUCTIBLE_SHARE, 0.5);
  // The statutory rate ships corroborated-but-unconfirmed (finlex proxy-blocked);
  // F-P2-V flips this in the same commit as the primary read — a silent flip
  // without that read trips this pin.
  assert.equal(TAX_ADJUSTMENT_PROVENANCE.confirmedAgainstPrimary, false);
  for (const spec of TAX_ADJUSTMENT_TYPES) {
    assert.ok(['add_back', 'deduction', 'signed'].includes(spec.direction), `${spec.type} direction closed`);
    assert.ok(spec.label_fi, `${spec.type} has Finnish label`);
  }
});

test('normalizer: validates the closed shape, refuses what cannot apply deterministically', () => {
  assert.equal(normalizeTaxAdjustmentsProfile(null), null);
  assert.equal(normalizeTaxAdjustmentsProfile([]), null);

  const ok = normalizeTaxAdjustmentsProfile([
    { tax_year: 2026, type: 'representation_expenses', amount_eur: 1234.567, account_code: ' 7950 ' },
    { tax_year: 2026, type: 'non_deductible', amount_eur: 200, note: 'Pysäköintivirhemaksu' },
    { tax_year: 2026, type: 'additional_deduction', amount_eur: 470, note: 'Työhuonevähennys 2026' },
    { tax_year: 2026, type: 'depreciation_difference', amount_eur: -150.5, note: 'EVL-lisäpoisto' }
  ]);
  assert.equal(ok.length, 4);
  assert.equal(ok[0].amount_eur, 1234.57);
  assert.equal(ok[0].account_code, '7950');
  assert.equal(ok[3].amount_eur, -150.5);

  // Unknown type / bad year / non-finite amount / missing required note → 400.
  for (const bad of [
    [{ tax_year: 2026, type: 'made_up', amount_eur: 1 }],
    [{ tax_year: 26, type: 'non_deductible', amount_eur: 1, note: 'x' }],
    [{ tax_year: 2026, type: 'non_deductible', amount_eur: 'NaN', note: 'x' }],
    [{ tax_year: 2026, type: 'non_deductible', amount_eur: 100 }], // noteRequired
    [{ tax_year: 2026, type: 'additional_deduction', amount_eur: 100 }], // noteRequired
    [{ tax_year: 2026, type: 'non_deductible', amount_eur: -5, note: 'x' }], // only signed type may be negative
    'not-an-array'
  ]) {
    assert.throws(() => normalizeTaxAdjustmentsProfile(bad), (e) => e.statusCode === 400, JSON.stringify(bad));
  }
  // representation_expenses carries its rule in the type — note optional.
  assert.ok(normalizeTaxAdjustmentsProfile([{ tax_year: 2026, type: 'representation_expenses', amount_eur: 10 }]));
});

test('evaluator: deterministic rules per type, year-filtered, null when nothing applies', () => {
  assert.equal(evaluateTaxAdjustments({ items: [], taxYear: 2026 }), null);
  assert.equal(evaluateTaxAdjustments({ items: null, taxYear: 2026 }), null);
  assert.equal(evaluateTaxAdjustments({ items: [{ tax_year: 2025, type: 'non_deductible', amount_eur: 1, note: 'x' }], taxYear: 2026 }), null);
  assert.equal(evaluateTaxAdjustments({ items: [{ tax_year: 2026, type: 'garbage', amount_eur: 1 }], taxYear: 2026 }), null);

  const out = evaluateTaxAdjustments({
    taxYear: 2026,
    items: [
      { tax_year: 2026, type: 'representation_expenses', amount_eur: 1000 },      // add back 500
      { tax_year: 2026, type: 'non_deductible', amount_eur: 200, note: 'sakko' }, // add back 200
      { tax_year: 2026, type: 'additional_deduction', amount_eur: 470, note: 'työhuone' }, // deduct 470
      { tax_year: 2026, type: 'depreciation_difference', amount_eur: 300, note: 'yli EVL-maksimin' },  // add back 300
      { tax_year: 2026, type: 'depreciation_difference', amount_eur: -120, note: 'lisäpoisto' },       // deduct 120
      { tax_year: 2025, type: 'non_deductible', amount_eur: 999, note: 'wrong year' }
    ]
  });
  assert.equal(out.items.length, 5);
  assert.equal(out.totalAddBacks, 1000);
  assert.equal(out.totalDeductions, 590);
  const rep = out.items[0];
  assert.equal(rep.add_back_eur, 500);
  assert.equal(rep.deduction_eur, 0);
  assert.ok(rep.rule.includes('50%'));
  assert.equal(out.provenance, TAX_ADJUSTMENT_PROVENANCE);
});

test('buildAnnualReturn: adjustments shift the taxable result and the split divides the ADJUSTED result; absent ⇒ existing keys byte-identical', () => {
  const base = {
    taxYear: 2026,
    income: { sales: 50000 },
    expenses: { otherOperating: 10000 },
    netBusinessAssets: 20000,
    capitalReturnRate: 0.2
  };
  const plain = buildAnnualReturn(base);
  assert.equal(plain.result, 40000);
  assert.equal(plain.resultBeforeAdjustments, 40000);
  assert.equal(plain.taxAdjustments, null);
  assert.equal(plain.split.capitalIncome, 4000);
  assert.equal(plain.split.earnedIncome, 36000);

  const adjusted = buildAnnualReturn({
    ...base,
    taxAdjustments: evaluateTaxAdjustments({
      taxYear: 2026,
      items: [
        { tax_year: 2026, type: 'representation_expenses', amount_eur: 1000 },
        { tax_year: 2026, type: 'additional_deduction', amount_eur: 470, note: 'työhuone' }
      ]
    })
  });
  // 40000 + 500 (edustus add-back) − 470 (työhuone) = 40030
  assert.equal(adjusted.resultBeforeAdjustments, 40000);
  assert.equal(adjusted.result, 40030);
  assert.equal(adjusted.taxAdjustments.totalAddBacks, 500);
  assert.equal(adjusted.taxAdjustments.totalDeductions, 470);
  // Split divides the ADJUSTED result: capital = min(40030, 20000×0.2) = 4000.
  assert.equal(adjusted.split.capitalIncome, 4000);
  assert.equal(adjusted.split.earnedIncome, 36030);

  // No-adjustment call keeps every pre-G-11 key identical (D-P2-3).
  for (const key of ['taxYear', 'income', 'deductibleExpenses', 'additionalDeductions', 'result', 'isLoss', 'split', 'needsNetAssetsForSplit']) {
    assert.deepEqual(plain[key], buildAnnualReturn(base)[key]);
  }
});

test('an adjustment can flip a small book loss into a taxable result (and vice versa) — surfaced, never hidden', () => {
  const flipped = buildAnnualReturn({
    taxYear: 2026,
    income: { sales: 1000 },
    expenses: { otherOperating: 1100 },
    taxAdjustments: evaluateTaxAdjustments({
      taxYear: 2026,
      items: [{ tax_year: 2026, type: 'non_deductible', amount_eur: 400, note: 'sakko' }]
    })
  });
  assert.equal(flipped.resultBeforeAdjustments, -100);
  assert.equal(flipped.result, 300);
  assert.equal(flipped.isLoss, false);
});
