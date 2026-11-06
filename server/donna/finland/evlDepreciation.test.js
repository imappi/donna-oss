// F-G10-3 — the EVL depreciation engine (menojäännöspoisto):
// node --test server/donna/finland/evlDepreciation.test.js
// Design: docs/design-donna-finland-evl-depreciation.md (D-G10-3-1…6).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EVL_DEPRECIATION_RATES_BY_YEAR,
  EVL_DEPRECIATION_PROVENANCE,
  evlRatesForYear,
  evaluateEvlDepreciation
} from './evlDepreciation.js';

const TILIKAUSI_2026 = { starts_on: '2026-01-01', ends_on: '2026-12-31' };

const pack = (overrides = {}) => ({
  as_of: '2026-01-01',
  fixed_assets: [
    { description: 'Pakettiauto', category: 'machinery_and_equipment', undepreciated_balance_eur: 12000 }
  ],
  ...overrides
});

const evaluate = (overrides = {}) =>
  evaluateEvlDepreciation({ cutover: pack(), tilikausi: TILIKAUSI_2026, taxYear: 2026, ...overrides });

test('pins: the closed rate shape — 25 % machinery rate, €1,200 small-pool threshold, provenance not primary-confirmed', () => {
  const row = EVL_DEPRECIATION_RATES_BY_YEAR[2026];
  assert.equal(row.machinery_and_equipment, 0.25);
  assert.equal(row.small_pool_full_deduction_max_eur, 1200);
  assert.equal(row.confirmedAgainstPrimary, false);
  assert.match(EVL_DEPRECIATION_PROVENANCE.statute, /EVL 30 §/);
  assert.equal(EVL_DEPRECIATION_PROVENANCE.confirmedAgainstPrimary, false);
});

test('evlRatesForYear resolves exact years and substitutes the latest flagged exact:false — never silent', () => {
  assert.deepEqual(evlRatesForYear(2026), { year: 2026, rates: EVL_DEPRECIATION_RATES_BY_YEAR[2026], exact: true });
  const future = evlRatesForYear(2031);
  assert.equal(future.exact, false);
  assert.equal(future.year, 2026);
});

test('returns null (envelope byte-identical) without a pack, without bases, or without a usable tax year', () => {
  assert.equal(evaluateEvlDepreciation({ cutover: null, tilikausi: TILIKAUSI_2026, taxYear: 2026 }), null);
  assert.equal(evaluate({ cutover: { as_of: '2026-01-01' } }), null);
  assert.equal(evaluate({ cutover: pack({ fixed_assets: [] }) }), null);
  assert.equal(evaluate({ taxYear: 'not-a-year' }), null);
});

test('anchor rule: a pack whose as_of falls outside the tilikausi computes nothing (not_anchored, no pool, no comparison)', () => {
  const verdict = evaluate({ tilikausi: { starts_on: '2027-01-01', ends_on: '2027-12-31' }, taxYear: 2027 });
  assert.equal(verdict.status, 'not_anchored');
  assert.equal(verdict.pool, null);
  assert.equal(verdict.comparison, null);
  assert.match(verdict.summary_fi, /ei ankkuroidu/);
});

test('computes the 25 % machinery maximum and the closing menojäännös if the max were taken', () => {
  const verdict = evaluate({ bookedDepreciationEur: 2000 });
  assert.equal(verdict.status, 'computed');
  assert.equal(verdict.pool.opening_menojaannos_eur, 12000);
  assert.equal(verdict.pool.max_poisto_eur, 3000);
  assert.equal(verdict.pool.small_pool_rule_applied, false);
  assert.equal(verdict.pool.closing_menojaannos_if_max_eur, 9000);
  assert.equal(verdict.comparison.severity, 'ok');
  assert.equal(verdict.comparison.headroom_eur, 1000);
  assert.equal(verdict.comparison.proposed_adjustment, null);
});

test('a pool at or under the small-pool threshold is fully deductible (EVL 30 § kertavähennys)', () => {
  const small = evaluate({
    cutover: pack({ fixed_assets: [{ description: 'Läppäri', category: 'machinery_and_equipment', undepreciated_balance_eur: 1100 }] }),
    bookedDepreciationEur: 1100
  });
  assert.equal(small.pool.small_pool_rule_applied, true);
  assert.equal(small.pool.max_poisto_eur, 1100);
  assert.equal(small.pool.closing_menojaannos_if_max_eur, 0);
  assert.equal(small.comparison.severity, 'ok');

  const boundary = evaluate({
    cutover: pack({ fixed_assets: [{ description: 'Kalusto', category: 'machinery_and_equipment', undepreciated_balance_eur: 1200 }] })
  });
  assert.equal(boundary.pool.small_pool_rule_applied, true);
  assert.equal(boundary.pool.max_poisto_eur, 1200);
});

test('machinery-only excess proposes a depreciation_difference record — surfaced, never applied', () => {
  const verdict = evaluate({ bookedDepreciationEur: 3500 });
  assert.equal(verdict.comparison.severity, 'possible_excess');
  assert.equal(verdict.comparison.excess_eur, 500);
  assert.deepEqual(
    { type: verdict.comparison.proposed_adjustment.type, tax_year: verdict.comparison.proposed_adjustment.tax_year, amount_eur: verdict.comparison.proposed_adjustment.amount_eur },
    { type: 'depreciation_difference', tax_year: 2026, amount_eur: 500 }
  );
  // The proposal is honest about its own blind spot: in-year additions raise the ceiling.
  assert.match(verdict.comparison.proposed_adjustment.note_fi, /lisäykset kasvattavat menojäännöstä/);
  assert.match(verdict.summary_fi, /odottaa vahvistusta/);
});

test('an existing depreciation_difference record for the year suppresses the proposal (double-count guard)', () => {
  const verdict = evaluate({
    bookedDepreciationEur: 3500,
    taxAdjustments: [
      { tax_year: 2026, type: 'depreciation_difference', amount_eur: 500, note: 'kirjattu jo' },
      { tax_year: 2025, type: 'depreciation_difference', amount_eur: 999, note: 'wrong year' }
    ]
  });
  assert.equal(verdict.comparison.severity, 'possible_excess');
  assert.equal(verdict.comparison.existing_adjustment_eur, 500);
  assert.equal(verdict.comparison.proposed_adjustment, null);
  assert.match(verdict.comparison.note_fi, /jo kirjattu poistoero/);
});

test('buildings/other bases are surfaced not_computed with stated reasons — never guessed, and they downgrade an excess to unverified', () => {
  const mixed = evaluate({
    cutover: pack({
      fixed_assets: [
        { description: 'Pakettiauto', category: 'machinery_and_equipment', undepreciated_balance_eur: 12000 },
        { description: 'Halli', category: 'buildings', undepreciated_balance_eur: 80000 },
        { description: 'Muu', category: 'other', undepreciated_balance_eur: 700 }
      ]
    }),
    bookedDepreciationEur: 6200
  });
  // Pool sums machinery only.
  assert.equal(mixed.pool.opening_menojaannos_eur, 12000);
  assert.deepEqual(mixed.not_computed.map((e) => [e.category, e.recorded_base_eur]), [['buildings', 80000], ['other', 700]]);
  assert.match(mixed.not_computed[0].reason_fi, /EVL 34 §/);
  // Booked 6200 > machinery max 3000, but the booked total may include building
  // depreciation the engine cannot bound — unverified, no proposal.
  assert.equal(mixed.comparison.severity, 'unverified');
  assert.equal(mixed.comparison.proposed_adjustment, null);
});

test('a pack with no machinery assets computes no pool and no comparison, stated in the summary', () => {
  const verdict = evaluate({
    cutover: pack({ fixed_assets: [{ description: 'Halli', category: 'buildings', undepreciated_balance_eur: 80000 }] }),
    bookedDepreciationEur: 4000
  });
  assert.equal(verdict.status, 'computed');
  assert.equal(verdict.pool, null);
  assert.equal(verdict.comparison, null);
  assert.match(verdict.summary_fi, /ei ole koneita ja kalustoa/);
});

test('an unavailable booked figure yields an unverified comparison, never a guess', () => {
  const verdict = evaluate({ bookedDepreciationEur: null });
  assert.equal(verdict.comparison.severity, 'unverified');
  assert.equal(verdict.comparison.booked_depreciation_eur, null);
  assert.equal(verdict.comparison.proposed_adjustment, null);
});
