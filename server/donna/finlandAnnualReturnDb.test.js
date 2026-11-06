import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getFinlandAnnualReturnFromDb
} from './statutoryRegistry.js';

const enabledSnapshot = {
  FINLAND_ANNUAL_RETURN: { stage: 'auto', source: 'test' },
  FINLAND_TILIKAUSI: { stage: 'auto', source: 'test' }
};

const fakeClient = ({ incorporationDate = '2025-06-15', profile = {}, blockerInserts = null, extraFlags = {} } = {}) => ({
  async query(sql) {
    if (sql.includes('from client_capability_config')) {
      const flags = { ...enabledSnapshot, ...extraFlags };
      return { rows: Object.entries(flags).map(([flag_key, row]) => ({ flag_key, ...row, client_id: 'client-1' })) };
    }
    if (sql.includes('from cohort_capability_config')) return { rows: [] };
    if (sql.includes('select id from clients')) return { rows: [{ id: 'client-1' }] };
    if (sql.includes('select incorporation_date, profile from clients')) {
      return { rows: [{ incorporation_date: incorporationDate, profile }] };
    }
    // FI-13 13.0b — the entity-unsupported refusal mints a StatutoryBlocker.
    if (sql.includes('insert into statutory_blockers')) {
      if (blockerInserts) blockerInserts.push(sql);
      return { rows: [{ id: 'stat-blocker-client-1-finland_annual_return-abc', inserted: true, status: 'open', maybe_reopened: false }] };
    }
    if (sql.includes('insert into statutory_blocker_events')) return { rows: [] };
    throw new Error(`Unexpected query: ${sql}`);
  }
});

const call = (opts = {}) => getFinlandAnnualReturnFromDb({
  firmId: 'firm-1',
  clientId: 'client-1',
  taxYear: 2026,
  readAt: '2026-07-09T00:00:00.000Z',
  withFirmDbClientFn: async (fn) => fn(fakeClient(opts.client || {})),
  ...opts
});

const readModel = ({ rows = [], bs = { balanced: true, total_assets: 1000, total_liabilities: 200 } } = {}) => ({
  profit_and_loss: { rows },
  balance_sheet: bs
});

test('FI-12 DB caller period-bounds current tilikausi P&L and prior year-end BS', async () => {
  const reads = [];
  const result = await call({
    readModelGetter: async (args) => {
      reads.push(args);
      if (args.periodStart === '2026-01-01') {
        return readModel({ rows: [{ code: '3000', name: 'Sales in tilikausi', revenue: 500, expense: 0, statutory_group: 'turnover' }] });
      }
      return readModel({ bs: { balanced: true, total_assets: 1000, total_liabilities: 0 } });
    }
  });

  assert.deepEqual(reads.map((r) => [r.periodStart, r.periodEnd]), [['2026-01-01', '2026-12-31'], ['2025-06-15', '2025-12-31']]);
  assert.equal(result.return.income.sales, 500);
});

test('FI-12 DB caller greenfield year 1 has null prior BS, deferred split, ready + no_prior_year_end', async () => {
  const result = await call({
    client: { incorporationDate: '2026-06-15' },
    readModelGetter: async () => readModel({ rows: [{ code: '3000', revenue: 800, expense: 0, statutory_group: 'turnover' }] })
  });

  assert.equal(result.review.status, 'ready');
  assert.ok(result.review.blockers.includes('no_prior_year_end'));
  assert.equal(result.return.netBusinessAssets, null);
  assert.equal(result.return.split, null);
  assert.equal(result.return.needsNetAssetsForSplit, true);
});

test('FI-12 DB caller imbalanced prior BS needs review and the split stays DEFERRED', async () => {
  const result = await call({
    readModelGetter: async (args) => args.periodStart === '2026-01-01'
      ? readModel({ rows: [{ code: '3000', revenue: 1000, expense: 0, statutory_group: 'turnover' }] })
      : readModel({ bs: { balanced: false, imbalance: 10, total_assets: 1000, total_liabilities: 0 } })
  });

  assert.equal(result.review.status, 'needs_review');
  assert.ok(result.review.blockers.includes('prior_balance_sheet_imbalance'));
  // Net assets off a BS that doesn't foot are NOT a number we trust: the split is
  // deferred (null + needsNetAssetsForSplit), never computed from a fabricated zero.
  assert.equal(result.return.netBusinessAssets, null);
  assert.equal(result.return.split, null);
  assert.equal(result.return.needsNetAssetsForSplit, true);
});

test('FI-12 DB caller unmapped income rows need review and income tax is surfaced only', async () => {
  const result = await call({
    readModelGetter: async (args) => args.periodStart === '2026-01-01'
      ? readModel({ rows: [
          { code: '3999', name: 'Mystery income', revenue: 125, expense: 0, statutory_group: 'unknown' },
          { code: '8910', name: 'Income tax', revenue: 0, expense: 77, statutory_group: 'income_taxes' }
        ] })
      : readModel()
  });

  assert.equal(result.review.status, 'needs_review');
  assert.ok(result.review.blockers.includes('unmapped_income_rows'));
  assert.deepEqual(result.review.unmappedIncomeStatementRows, [{ code: '3999', name: 'Mystery income', revenue: 125, expense: 0, statutory_group: 'unknown' }]);
  assert.equal(result.review.nonDeductibleIncomeTaxes, 77);
  assert.equal(result.return.result, 0);
});

test('FI-12 DB caller missing incorporation date returns needs_review + missing_incorporation_date', async () => {
  let read = false;
  const result = await call({
    client: { incorporationDate: null },
    readModelGetter: async () => { read = true; return readModel(); }
  });

  assert.equal(read, false);
  assert.equal(result.review.status, 'needs_review');
  assert.ok(result.review.blockers.includes('missing_incorporation_date'));
});

test('FI-12 DB caller reads basis from client profile and falls back to accrual', async () => {
  const seen = [];
  await call({ client: { profile: { accounting_basis: 'cash' } }, readModelGetter: async (args) => { seen.push(args.basis); return readModel(); } });
  assert.deepEqual(seen, ['cash', 'cash']);

  const fallback = [];
  await call({ client: { profile: {} }, readModelGetter: async (args) => { fallback.push(args.basis); return readModel(); } });
  assert.deepEqual(fallback, ['accrual', 'accrual']);
});

// FI-13 (C1): an osakeyhtiö must never be served the form-5 elinkeinonharjoittaja
// return. The fail-safe inside getFinlandAnnualReturnFromDb refuses fi-oy before
// reading the ledger; toiminimi and an unset legal form are byte-identical.
test('FI-13 DB caller refuses an fi-oy client with a typed 409 (never a form-5 return)', async () => {
  let threw = null;
  let read = false;
  const blockerInserts = [];
  try {
    await call({
      client: { profile: { entity_type: 'fi-oy' }, blockerInserts },
      readModelGetter: async () => { read = true; return readModel(); }
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected a refusal for an Oy');
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.code, 'FINLAND_ANNUAL_RETURN_ENTITY_UNSUPPORTED');
  assert.equal(read, false, 'must refuse before touching the ledger read model');
  // 13.0b — the refusal minted a StatutoryBlocker (two-terminal-states): the
  // 409 now carries the blocker id and durable work rests on the firm.
  assert.equal(blockerInserts.length, 1, 'the refusal mints exactly one blocker');
  // The 409 carries the store's deterministic blocker id (not the mock's row id).
  assert.match(threw.blockerId, /^stat-blocker-client-1-finland-annual-return-[0-9a-f]{16}$/);
});

test('FI-13 DB caller serves an explicit fi-toiminimi exactly as an unset legal form', async () => {
  const rowsGetter = async (args) => args.periodStart === '2026-01-01'
    ? readModel({ rows: [{ code: '3000', revenue: 700, expense: 0, statutory_group: 'turnover' }] })
    : readModel();
  const withForm = await call({ client: { profile: { entity_type: 'fi-toiminimi' } }, readModelGetter: rowsGetter });
  const without = await call({ client: {}, readModelGetter: rowsGetter });
  assert.equal(withForm.return.income.sales, 700);
  assert.deepEqual(withForm.return, without.return);
});

// 13.0b flip — fail-closed-on-unknown, config-gated. With FINLAND_ENTITY_FAIL_CLOSED
// acting, a client with no resolved legal form is refused (and mints a blocker)
// instead of being served the form-5. OFF by default ⇒ byte-identical staging.
test('FI-13 flip ON refuses an unresolved legal form with a typed 409 + mints a blocker', async () => {
  let threw = null;
  let read = false;
  const blockerInserts = [];
  try {
    await call({
      client: {
        profile: {}, // no entity_type → unknown legal form
        blockerInserts,
        extraFlags: { FINLAND_ENTITY_FAIL_CLOSED: { stage: 'auto', source: 'test' } }
      },
      readModelGetter: async () => { read = true; return readModel(); }
    });
  } catch (e) {
    threw = e;
  }
  assert.ok(threw, 'expected a fail-closed refusal for an unknown legal form');
  assert.equal(threw.statusCode, 409);
  assert.equal(threw.code, 'FINLAND_ANNUAL_RETURN_ENTITY_UNKNOWN');
  assert.equal(read, false, 'must refuse before touching the ledger read model');
  assert.equal(blockerInserts.length, 1, 'the fail-closed refusal mints exactly one blocker');
  assert.match(threw.blockerId, /^stat-blocker-client-1-finland-annual-return-[0-9a-f]{16}$/);
});

test('FI-13 flip OFF (default) serves an unresolved legal form as toiminimi (byte-identical)', async () => {
  const blockerInserts = [];
  const result = await call({
    client: { profile: {}, blockerInserts }, // unknown form, flip OFF (default)
    readModelGetter: async (args) => args.periodStart === '2026-01-01'
      ? readModel({ rows: [{ code: '3000', revenue: 900, expense: 0, statutory_group: 'turnover' }] })
      : readModel()
  });
  assert.equal(result.return.income.sales, 900, 'served the form-5 exactly as before');
  assert.equal(blockerInserts.length, 0, 'no blocker minted when the flip is off');
});

// G-11: recorded profile.tax_adjustments for the return's tax year apply
// deterministically and ride the verdict per-item; other years are ignored.
test('FI-12 DB caller applies profile.tax_adjustments to the taxable result (G-11)', async () => {
  const result = await call({
    client: {
      profile: {
        tax_adjustments: [
          { tax_year: 2026, type: 'representation_expenses', amount_eur: 1000 },
          { tax_year: 2026, type: 'additional_deduction', amount_eur: 470, note: 'työhuonevähennys' },
          { tax_year: 2025, type: 'non_deductible', amount_eur: 999, note: 'wrong year' }
        ]
      }
    },
    readModelGetter: async (args) => args.periodStart === '2026-01-01'
      ? readModel({ rows: [{ code: '3000', revenue: 5000, expense: 0, statutory_group: 'turnover' }] })
      : readModel()
  });
  assert.equal(result.return.resultBeforeAdjustments, 5000);
  assert.equal(result.return.result, 5030); // +500 edustus add-back − 470 työhuone
  assert.equal(result.return.taxAdjustments.items.length, 2);
  assert.equal(result.return.taxAdjustments.totalAddBacks, 500);
  assert.equal(result.return.taxAdjustments.totalDeductions, 470);
});

// G-10: the cutover-recorded prior-year nettovarallisuus fills the switcher-year
// gap (no derived prior BS) with provenance stamped; losses/asset bases ride the
// envelope with the bounded-honesty note.
test('FI-12 DB caller uses the cutover net worth for the anchored year and surfaces the pack facts (G-10)', async () => {
  const profile = {
    cutover: {
      as_of: '2026-01-01',
      prior_year_net_worth_eur: 10000,
      confirmed_losses: [{ tax_year: 2024, amount_eur: 3200 }],
      fixed_assets: [{ description: 'Pakettiauto', category: 'machinery_and_equipment', undepreciated_balance_eur: 12000 }]
    }
  };
  const result = await call({
    client: { profile },
    readModelGetter: async (args) => args.periodStart === '2026-01-01'
      ? readModel({ rows: [{ code: '3000', revenue: 5000, expense: 0, statutory_group: 'turnover' }] })
      : readModel({ bs: {} }) // prior period exists but has no balance sheet content
  });
  assert.equal(result.return.netBusinessAssets, 10000);
  assert.equal(result.return.net_assets_source, 'cutover_profile');
  assert.equal(result.return.split.capitalIncome, 2000);
  assert.deepEqual(result.cutover.confirmed_losses_on_record, [{ tax_year: 2024, amount_eur: 3200 }]);
  assert.equal(result.cutover.fixed_asset_tax_bases[0].description, 'Pakettiauto');
  assert.ok(result.cutover.losses_note_fi.includes('Verohallinto tekee vähennyksen'));

  // A pack anchored to the 2026 cutover year does NOT leak into 2027 — the
  // later year derives from Donna's own persisted prior-year balance sheet.
  const laterYear = await call({
    taxYear: 2027,
    client: { profile },
    readModelGetter: async (args) => args.periodStart === '2027-01-01'
      ? readModel({ rows: [{ code: '3000', revenue: 5000, expense: 0, statutory_group: 'turnover' }] })
      : readModel({ bs: { balanced: true, assets: { total: 9000 }, liabilities: { total: 1000 } } })
  });
  assert.equal(laterYear.return.netBusinessAssets, 8000);
  assert.equal(laterYear.return.net_assets_source, 'prior_balance_sheet');
});

// F-G10-3: the EVL 30 § maximum computed on the recorded bases rides the
// envelope, compared against the booked poistot the return aggregated; absent
// pack ⇒ the key is ABSENT (byte-identical envelope, pinned).
test('FI-12 DB caller surfaces the EVL depreciation verdict for an anchored pack and omits it without one (F-G10-3)', async () => {
  const profile = {
    cutover: {
      as_of: '2026-01-01',
      fixed_assets: [{ description: 'Pakettiauto', category: 'machinery_and_equipment', undepreciated_balance_eur: 12000 }]
    }
  };
  const rows = [
    { code: '3000', revenue: 5000, expense: 0, statutory_group: 'turnover' },
    { code: '6800', name: 'Poistot', revenue: 0, expense: 3500, statutory_group: 'depreciation' }
  ];
  const result = await call({
    client: { profile },
    readModelGetter: async (args) => args.periodStart === '2026-01-01' ? readModel({ rows }) : readModel({ bs: {} })
  });
  assert.equal(result.evl_depreciation.status, 'computed');
  assert.equal(result.evl_depreciation.pool.opening_menojaannos_eur, 12000);
  assert.equal(result.evl_depreciation.pool.max_poisto_eur, 3000);
  // The booked figure IS the return's depreciation bucket — no second read.
  assert.equal(result.evl_depreciation.comparison.booked_depreciation_eur, 3500);
  assert.equal(result.evl_depreciation.comparison.severity, 'possible_excess');
  assert.equal(result.evl_depreciation.comparison.proposed_adjustment.amount_eur, 500);
  // Nothing auto-applied: the taxable result still reflects the books alone.
  assert.equal(result.return.result, 1500);
  assert.equal(result.return.taxAdjustments, null);

  // The pack does not leak into a later, non-anchored year as a computed pool.
  const laterYear = await call({
    taxYear: 2027,
    client: { profile },
    readModelGetter: async (args) => args.periodStart === '2027-01-01' ? readModel({ rows }) : readModel()
  });
  assert.equal(laterYear.evl_depreciation.status, 'not_anchored');
  assert.equal(laterYear.evl_depreciation.pool, null);

  // No pack ⇒ no key — the envelope is byte-identical to the pre-slice shape.
  const plain = await call({
    readModelGetter: async (args) => args.periodStart === '2026-01-01' ? readModel({ rows }) : readModel()
  });
  assert.equal('evl_depreciation' in plain, false);
});

// Happy path: a FOOTING prior BS with real net assets drives the capital/earned
// split. Uses the real read-model balance_sheet shape (`assets.total` /
// `liabilities.total`, which `netBusinessAssetsFromBalanceSheet` reads) — NOT the
// `total_assets`/`total_liabilities` aliases — so this guards the actual field the
// aggregator extracts and would fail if that extraction regressed.
test('FI-12 DB caller computes the capital/earned split from a footing prior BS', async () => {
  const result = await call({
    readModelGetter: async (args) => args.periodStart === '2026-01-01'
      ? readModel({ rows: [{ code: '3000', name: 'Sales', revenue: 5000, expense: 0, statutory_group: 'turnover' }] })
      : readModel({ bs: { balanced: true, assets: { total: 10000 }, liabilities: { total: 2000 }, total_assets: 10000, total_liabilities: 2000 } })
  });

  assert.equal(result.review.status, 'ready');
  assert.deepEqual(result.review.blockers, []);
  assert.equal(result.return.netBusinessAssets, 8000);
  // capitalIncome = min(result 5000, netAssets 8000 * 0.2 = 1600) = 1600; earned = 3400.
  assert.equal(result.return.split.capitalIncome, 1600);
  assert.equal(result.return.split.earnedIncome, 3400);
});
