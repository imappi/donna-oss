// G-10 (FI-15) — cutover-pack tests
// (docs/design-donna-finland-fi15-g10-g14-p2-batch.md, D-P2-4/D-P2-5).

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUTOVER_FIXED_ASSET_CATEGORIES,
  CUTOVER_CONTROL_CODES,
  normalizeCutoverProfile,
  evaluateCutoverPack,
  cutoverNetWorthForTaxYear
} from './cutover.js';
import { buildAnnualReturnFromReadModel } from './annualReturn.js';

const FULL_PACK = {
  as_of: '2026-01-01',
  prior_year_net_worth_eur: 18000,
  confirmed_losses: [{ tax_year: 2024, amount_eur: 3200 }, { tax_year: 2023, amount_eur: 500 }],
  fixed_assets: [
    { description: 'Pakettiauto', category: 'machinery_and_equipment', undepreciated_balance_eur: 12000 },
    { description: 'Työkoneet', category: 'machinery_and_equipment', undepreciated_balance_eur: 3000 }
  ],
  open_receivables: [
    { counterparty: 'Asiakas Oy', amount_eur: 1200, invoice_number: '2025-041', issued_on: '2025-12-03' },
    { counterparty: 'Toinen Oy', amount_eur: 800.5 }
  ],
  open_payables: [{ counterparty: 'Tukku Oy', amount_eur: 350 }],
  vat_opening: { payable_eur: 950, period_label: '2025-Q4' },
  note: 'Edellinen kirjanpitäjä: Tili-Testi Oy'
};

test('pins: closed fixed-asset categories + the control-code map', () => {
  assert.deepEqual([...CUTOVER_FIXED_ASSET_CATEGORIES], ['machinery_and_equipment', 'buildings', 'other']);
  assert.deepEqual(CUTOVER_CONTROL_CODES.receivables, ['1700']);
  assert.deepEqual(CUTOVER_CONTROL_CODES.payables, ['2870']);
  assert.deepEqual(CUTOVER_CONTROL_CODES.vat_payable, ['2939']);
  assert.deepEqual(CUTOVER_CONTROL_CODES.vat_receivable, ['1763']);
});

test('normalizer: accepts the full pack, sorts losses, refuses bad shapes with 400s', () => {
  assert.equal(normalizeCutoverProfile(null), null);
  const pack = normalizeCutoverProfile(FULL_PACK);
  assert.equal(pack.as_of, '2026-01-01');
  assert.equal(pack.prior_year_net_worth_eur, 18000);
  assert.deepEqual(pack.confirmed_losses.map((l) => l.tax_year), [2023, 2024]);
  assert.equal(pack.open_receivables.length, 2);
  assert.equal(pack.open_receivables[1].amount_eur, 800.5);
  assert.equal(pack.vat_opening.payable_eur, 950);

  for (const bad of [
    'string',
    {}, // missing as_of
    { as_of: 'not-a-date' },
    { as_of: '2026-02-30' }, // invalid calendar date
    { as_of: '2026-01-01', prior_year_net_worth_eur: -1 },
    { as_of: '2026-01-01', open_receivables: [{ amount_eur: 100 }] }, // missing counterparty
    { as_of: '2026-01-01', open_receivables: [{ counterparty: 'X', amount_eur: 0 }] }, // zero amount
    { as_of: '2026-01-01', open_receivables: [{ counterparty: 'X', amount_eur: 10, issued_on: 'huhtikuu' }] },
    { as_of: '2026-01-01', fixed_assets: [{ description: 'Auto', category: 'vehicles', undepreciated_balance_eur: 1 }] }, // unknown category
    { as_of: '2026-01-01', confirmed_losses: [{ tax_year: 2024, amount_eur: 0 }] },
    { as_of: '2026-01-01', vat_opening: { period_label: 'Q4' } } // needs an amount
  ]) {
    assert.throws(() => normalizeCutoverProfile(bad), (e) => e.statusCode === 400, JSON.stringify(bad));
  }
});

test('evaluate: reconciled when the pack sums match the posted opening journal (sign conventions honoured)', () => {
  const pack = normalizeCutoverProfile(FULL_PACK);
  // Signed net (debit − credit) per code: assets positive, liabilities negative.
  const openingBalances = {
    1700: 2000.5,          // = 1200 + 800.5
    2870: -350,            // credit balance
    2939: -950,            // credit balance
    1120: 16000, 1180: -2500, // book value 13500 ≠ tax bases 15000 → INFO only
    1910: 5000, 2050: -20200.5
  };
  const out = evaluateCutoverPack({ cutover: pack, openingBalances });
  assert.equal(out.status, 'reconciled');
  const byCode = Object.fromEntries(out.checks.map((c) => [c.code, c]));
  assert.equal(byCode.open_receivables_vs_1700.severity, 'ok');
  assert.equal(byCode.open_payables_vs_2870.severity, 'ok');
  assert.equal(byCode.vat_payable_vs_2939.severity, 'ok');
  // Fixed assets differ but stay INFO — the tax base may legitimately differ.
  assert.equal(byCode.fixed_asset_bases_vs_book.severity, 'info');
  assert.equal(byCode.fixed_asset_bases_vs_book.recorded_eur, 15000);
  assert.equal(byCode.fixed_asset_bases_vs_book.opening_journal_eur, 13500);
});

test('evaluate: a genuine sum mismatch is a MISMATCH note with the delta — surfaced, never auto-corrected', () => {
  const pack = normalizeCutoverProfile(FULL_PACK);
  const out = evaluateCutoverPack({
    cutover: pack,
    openingBalances: { 1700: 1500, 2870: -350, 2939: -950 }
  });
  assert.equal(out.status, 'mismatches');
  const rec = out.checks.find((c) => c.code === 'open_receivables_vs_1700');
  assert.equal(rec.severity, 'mismatch');
  assert.equal(rec.delta_eur, 500.5);
  assert.ok(rec.note_fi.includes('Ei täsmää'));
});

test('evaluate: no posted opening journal ⇒ unverified (stated, never guessed); no pack ⇒ no_pack', () => {
  const pack = normalizeCutoverProfile(FULL_PACK);
  const out = evaluateCutoverPack({ cutover: pack, openingBalances: null });
  assert.equal(out.status, 'unverified');
  assert.ok(out.checks.every((c) => c.severity === 'unverified'));
  assert.equal(evaluateCutoverPack({ cutover: null }).status, 'no_pack');
  // Garbage never throws.
  assert.ok(evaluateCutoverPack({ cutover: 'garbage' }));
});

test('evaluate: a POSTED journal with no line on a control code means ZERO there — recorded items mismatch against 0, not "unverified"', () => {
  const out = evaluateCutoverPack({
    cutover: normalizeCutoverProfile({
      as_of: '2026-01-01',
      open_receivables: [{ counterparty: 'Asiakas Oy', amount_eur: 1200 }]
    }),
    openingBalances: { 1910: 5000, 2050: -5000 } // posted, but no 1700 line
  });
  assert.equal(out.status, 'mismatches');
  const check = out.checks[0];
  assert.equal(check.code, 'open_receivables_vs_1700');
  assert.equal(check.severity, 'mismatch');
  assert.equal(check.opening_journal_eur, 0);
  assert.equal(check.delta_eur, 1200);
});

test('cutoverNetWorthForTaxYear: anchors to the tilikausi containing as_of only (D-P2-5)', () => {
  const cutover = { as_of: '2026-01-01', prior_year_net_worth_eur: 18000 };
  const y2026 = { starts_on: '2026-01-01', ends_on: '2026-12-31' };
  const y2027 = { starts_on: '2027-01-01', ends_on: '2027-12-31' };
  assert.equal(cutoverNetWorthForTaxYear({ cutover, tilikausi: y2026 }), 18000);
  assert.equal(cutoverNetWorthForTaxYear({ cutover, tilikausi: y2027 }), null);
  assert.equal(cutoverNetWorthForTaxYear({ cutover: null, tilikausi: y2026 }), null);
  assert.equal(cutoverNetWorthForTaxYear({ cutover: { as_of: '2026-01-01' }, tilikausi: y2026 }), null);
});

test('read-model wiring: the RECORDED figure wins for the anchored year (an empty prior BS derives 0, not null — the trap D-P2-5 exists to close), provenance stamped', () => {
  const pl = { rows: [{ code: '3000', statutory_group: 'turnover', revenue: 30000, expense: 0 }] };

  const fromOverride = buildAnnualReturnFromReadModel({
    taxYear: 2026,
    profitAndLoss: pl,
    priorYearEndBalanceSheet: null,
    netBusinessAssetsOverride: 18000
  });
  assert.equal(fromOverride.netBusinessAssets, 18000);
  assert.equal(fromOverride.net_assets_source, 'cutover_profile');
  assert.equal(fromOverride.split.capitalIncome, 3600);

  // A switcher's prior year in Donna is an EMPTY balance sheet — the derived
  // figure is 0, indistinguishable from truly-zero net worth. The recorded
  // cutover figure must win, or it could never apply at all.
  const emptyPrior = buildAnnualReturnFromReadModel({
    taxYear: 2026,
    profitAndLoss: pl,
    priorYearEndBalanceSheet: {},
    netBusinessAssetsOverride: 18000
  });
  assert.equal(emptyPrior.netBusinessAssets, 18000);
  assert.equal(emptyPrior.net_assets_source, 'cutover_profile');

  // No override (the caller anchors it away from non-cutover years) ⇒ derived.
  const derivedOnly = buildAnnualReturnFromReadModel({
    taxYear: 2027,
    profitAndLoss: pl,
    priorYearEndBalanceSheet: { assets: { total: 25000 }, liabilities: { total: 5000 } },
    netBusinessAssetsOverride: null
  });
  assert.equal(derivedOnly.netBusinessAssets, 20000);
  assert.equal(derivedOnly.net_assets_source, 'prior_balance_sheet');

  const neither = buildAnnualReturnFromReadModel({ taxYear: 2026, profitAndLoss: pl });
  assert.equal(neither.netBusinessAssets, null);
  assert.equal(neither.net_assets_source, null);
  assert.equal(neither.needsNetAssetsForSplit, true);
});
