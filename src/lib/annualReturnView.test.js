// FI-12 read surface — view-model helpers over the persisted annual-return
// envelope: node --test src/lib/annualReturnView.test.js
// Design: docs/design-donna-finland-fi12-read-surface.md (D-FI12-R3).

import assert from 'node:assert/strict';
import test from 'node:test';

import { blockerView, buildAnnualReturnViewModel, formatEur } from './annualReturnView.js';

const readyEnvelope = (overrides = {}) => ({
  taxYear: 2026,
  tilikausi: { starts_on: '2026-01-01', ends_on: '2026-12-31' },
  basis: 'accrual',
  return: {
    taxYear: 2026,
    income: { sales: 42000, otherIncome: 0, total: 42000 },
    deductibleExpenses: { materials: 1200, personnel: 0, otherOperating: 8300.5, depreciation: 0, financial: 99.5, total: 9600 },
    additionalDeductions: { travel: 0, other: 0, total: 0 },
    result: 32400,
    isLoss: false,
    split: { capitalReturnRate: 0.2, capitalIncome: 2400, earnedIncome: 30000 },
    needsNetAssetsForSplit: false,
    netBusinessAssets: 12000,
    nonDeductibleIncomeTaxes: 0,
    unmappedIncomeStatementRows: []
  },
  review: { status: 'ready', blockers: [], nonDeductibleIncomeTaxes: 0, unmappedIncomeStatementRows: [] },
  provenance: { source: 'ledger_read_model', readAt: '2026-07-10T02:00:00.000Z', deterministic: true },
  ...overrides
});

test('formatEur renders fi-style amounts', () => {
  assert.equal(formatEur(12345.678), '12 345,68 €');
  assert.equal(formatEur(0), '0,00 €');
  assert.equal(formatEur(-42), '−42,00 €');
});

test('a ready envelope maps to the full view model, split rendered verbatim', () => {
  const vm = buildAnnualReturnViewModel(readyEnvelope());
  assert.equal(vm.status, 'ready');
  assert.equal(vm.taxYear, 2026);
  assert.equal(vm.tilikausiLabel, '1.1.2026 – 31.12.2026');
  assert.equal(vm.basis, 'accrual');
  assert.equal(vm.blockers.length, 0);
  // Zero-amount buckets are dropped; non-zero rows carry Finnish labels.
  assert.deepEqual(vm.incomeRows.map((r) => r.key), ['sales']);
  assert.equal(vm.incomeRows[0].display, '42 000,00 €');
  assert.deepEqual(vm.expenseRows.map((r) => r.key), ['materials', 'otherOperating', 'financial']);
  assert.equal(vm.result, '32 400,00 €');
  assert.equal(vm.resultLabel, 'Elinkeinotoiminnan tulos');
  assert.equal(vm.split.capitalIncome, '2 400,00 €');
  assert.equal(vm.split.earnedIncome, '30 000,00 €');
  assert.equal(vm.split.netBusinessAssets, '12 000,00 €');
  assert.equal(vm.splitDeferredNote, null);
  assert.equal(vm.additionalTotal, null);
  assert.match(vm.provenanceLine, /Deterministinen/);
});

test('needsNetAssetsForSplit renders the deferral note, never a computed split', () => {
  const env = readyEnvelope();
  env.return.split = null;
  env.return.needsNetAssetsForSplit = true;
  env.review.blockers = ['no_prior_year_end'];
  const vm = buildAnnualReturnViewModel(env);
  assert.equal(vm.status, 'ready'); // info-grade blocker does not flip readiness
  assert.equal(vm.split, null);
  assert.match(vm.splitDeferredNote, /nettovarallisuutta/);
  assert.equal(vm.blockers[0].severity, 'info');
});

test('needs_review blockers map to Finnish views; unknown codes surface verbatim', () => {
  const env = readyEnvelope();
  env.review.status = 'needs_review';
  env.review.blockers = ['prior_balance_sheet_imbalance', 'unmapped_income_rows', 'brand_new_code'];
  env.review.unmappedIncomeStatementRows = [{ code: '9999', name: 'Tuntematon', revenue: 0, expense: 120 }];
  const vm = buildAnnualReturnViewModel(env);
  assert.equal(vm.status, 'needs_review');
  assert.equal(vm.blockers[0].label, 'Edellisen tilikauden tase ei täsmää');
  assert.equal(vm.blockers[1].label, 'Kohdistamattomia tuloslaskelman rivejä');
  assert.equal(vm.blockers[2].label, 'brand_new_code'); // surfaced, not dropped
  assert.equal(vm.unmappedRows.length, 1);
  assert.equal(vm.unmappedRows[0].expense, '120,00 €');
});

test('non-deductible income taxes and losses render honestly', () => {
  const env = readyEnvelope();
  env.return.result = -1500;
  env.return.isLoss = true;
  env.return.split = null;
  env.review.nonDeductibleIncomeTaxes = 300;
  const vm = buildAnnualReturnViewModel(env);
  assert.equal(vm.resultLabel, 'Elinkeinotoiminnan tappio');
  assert.equal(vm.result, '−1 500,00 €');
  assert.match(vm.nonDeductibleNote, /300,00 €/);
});

test('non-envelope shapes yield null (callers hide the surface)', () => {
  assert.equal(buildAnnualReturnViewModel(null), null);
  assert.equal(buildAnnualReturnViewModel({}), null);
  assert.equal(buildAnnualReturnViewModel({ error: 'nope' }), null);
});

test('blockerView knows the closed vocabulary', () => {
  assert.equal(blockerView('missing_incorporation_date').severity, 'blocker');
  assert.equal(blockerView('no_prior_year_end').severity, 'info');
  assert.equal(blockerView('mystery').label, 'mystery');
});

test('G-11/G-10: tax adjustments, net-assets provenance, and cutover facts render verbatim; absent ⇒ null', () => {
  const plain = buildAnnualReturnViewModel(readyEnvelope());
  assert.equal(plain.taxAdjustments, null);
  assert.equal(plain.cutover, null);
  assert.equal(plain.netAssetsSourceNote, null);

  const env = readyEnvelope();
  env.return.net_assets_source = 'cutover_profile';
  env.return.resultBeforeAdjustments = 32370;
  env.return.taxAdjustments = {
    items: [
      { type: 'representation_expenses', label_fi: 'Edustuskulut (50 % vähennyskelpoinen)', amount_eur: 1000, add_back_eur: 500, deduction_eur: 0, note: null },
      { type: 'additional_deduction', label_fi: 'Verotuksessa vähennettävä lisäerä', amount_eur: 470, add_back_eur: 0, deduction_eur: 470, note: 'Työhuonevähennys' }
    ],
    totalAddBacks: 500,
    totalDeductions: 470
  };
  env.cutover = {
    confirmed_losses_on_record: [{ tax_year: 2024, amount_eur: 3200 }],
    fixed_asset_tax_bases: [{ description: 'Pakettiauto', category: 'machinery_and_equipment', undepreciated_balance_eur: 12000 }],
    losses_note_fi: 'Vahvistetut tappiot vähennetään verotuksessa — Donna kirjaa ne muistiin, Verohallinto tekee vähennyksen.'
  };
  const vm = buildAnnualReturnViewModel(env);
  assert.match(vm.netAssetsSourceNote, /cutover-paketista/);
  assert.equal(vm.taxAdjustments.items.length, 2);
  assert.equal(vm.taxAdjustments.items[0].addBack, '500,00 €');
  assert.equal(vm.taxAdjustments.items[0].deduction, null);
  assert.equal(vm.taxAdjustments.items[1].deduction, '470,00 €');
  assert.equal(vm.taxAdjustments.items[1].note, 'Työhuonevähennys');
  assert.equal(vm.taxAdjustments.resultBeforeAdjustments, '32 370,00 €');
  assert.deepEqual(vm.cutover.confirmedLosses, [{ taxYear: 2024, amount: '3 200,00 €' }]);
  assert.equal(vm.cutover.fixedAssetTaxBases[0].base, '12 000,00 €');
  assert.match(vm.cutover.lossesNote, /Verohallinto tekee vähennyksen/);
});

test('F-G10-3: the EVL depreciation verdict renders verbatim — pool, comparison, proposal, provenance; absent ⇒ null', () => {
  assert.equal(buildAnnualReturnViewModel(readyEnvelope()).evlDepreciation, null);

  const env = readyEnvelope();
  env.evl_depreciation = {
    status: 'computed',
    tax_year: 2026,
    rate: { year: 2026, machinery_rate: 0.25, small_pool_full_deduction_max_eur: 1200, exact: true, confirmedAgainstPrimary: false, source: 'EVL 30 §' },
    pool: {
      category: 'machinery_and_equipment',
      opening_menojaannos_eur: 12000,
      max_poisto_eur: 3000,
      small_pool_rule_applied: false,
      closing_menojaannos_if_max_eur: 9000
    },
    not_computed: [{ category: 'buildings', recorded_base_eur: 80000, reason_fi: 'Rakennukset poistetaan EVL 34 §:n mukaan…' }],
    comparison: {
      booked_depreciation_eur: 3500,
      severity: 'possible_excess',
      excess_eur: 500,
      existing_adjustment_eur: null,
      proposed_adjustment: { type: 'depreciation_difference', tax_year: 2026, amount_eur: 500, note_fi: 'Lisää poistoero…' },
      note_fi: 'Kirjanpidon poistot näyttävät ylittävän EVL-enimmäispoiston…'
    },
    summary_fi: 'EVL-enimmäispoisto laskettu.',
    provenance: { statute: 'EVL 30 §', confirmedAgainstPrimary: false, corroboratedOn: '2026-07-11' }
  };
  const vm = buildAnnualReturnViewModel(env);
  assert.equal(vm.evlDepreciation.status, 'computed');
  assert.equal(vm.evlDepreciation.rateLabel, '25 % (EVL 30 §)');
  assert.equal(vm.evlDepreciation.pool.openingBase, '12 000,00 €');
  assert.equal(vm.evlDepreciation.pool.maxPoisto, '3 000,00 €');
  assert.equal(vm.evlDepreciation.pool.closingIfMax, '9 000,00 €');
  assert.equal(vm.evlDepreciation.pool.smallPoolRuleApplied, false);
  assert.deepEqual(vm.evlDepreciation.notComputed, [{ category: 'buildings', base: '80 000,00 €', reason: 'Rakennukset poistetaan EVL 34 §:n mukaan…' }]);
  assert.equal(vm.evlDepreciation.comparison.severity, 'possible_excess');
  assert.equal(vm.evlDepreciation.comparison.booked, '3 500,00 €');
  assert.equal(vm.evlDepreciation.comparison.excess, '500,00 €');
  assert.equal(vm.evlDepreciation.comparison.headroom, null);
  assert.equal(vm.evlDepreciation.comparison.proposedAdjustment.amount, '500,00 €');
  assert.match(vm.evlDepreciation.provenanceNote, /toissijaisista lähteistä/);
});
