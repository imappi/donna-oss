import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAnnualReturn,
  CAPITAL_RETURN_RATES,
  netBusinessAssetsFromBalanceSheet,
  buildAnnualReturnFromReadModel
} from './annualReturn.js';

test('rolls income minus expenses minus additional deductions into the result', () => {
  const r = buildAnnualReturn({
    taxYear: 2026,
    income: { sales: 50000, otherIncome: 500 },
    expenses: { materials: 8000, personnel: 0, otherOperating: 12000, depreciation: 1000, financial: 200 },
    additionalDeductions: { travel: 1710 }
  });
  assert.equal(r.income.total, 50500);
  assert.equal(r.deductibleExpenses.total, 21200);
  assert.equal(r.additionalDeductions.total, 1710);
  assert.equal(r.result, 50500 - 21200 - 1710); // 27590
  assert.equal(r.isLoss, false);
});

test('a negative result is flagged as a loss (tappio), no split', () => {
  const r = buildAnnualReturn({
    taxYear: 2026,
    income: { sales: 5000 },
    expenses: { otherOperating: 9000 }
  });
  assert.equal(r.result, -4000);
  assert.equal(r.isLoss, true);
  assert.equal(r.split, null);
  assert.equal(r.needsNetAssetsForSplit, false);
});

test('a positive result without net assets flags that the split is deferred', () => {
  const r = buildAnnualReturn({ income: { sales: 30000 }, expenses: { otherOperating: 10000 } });
  assert.equal(r.result, 20000);
  assert.equal(r.split, null);
  assert.equal(r.needsNetAssetsForSplit, true);
});

test('with net assets, the default 20% capital return splits capital vs earned income', () => {
  const r = buildAnnualReturn({
    income: { sales: 30000 },
    expenses: { otherOperating: 10000 },
    netBusinessAssets: 50000
  });
  // 20% of 50000 = 10000 capital, remainder 10000 earned.
  assert.equal(r.split.capitalReturnRate, 0.2);
  assert.equal(r.split.capitalIncome, 10000);
  assert.equal(r.split.earnedIncome, 10000);
});

test('capital income never exceeds the business result', () => {
  const r = buildAnnualReturn({
    income: { sales: 12000 },
    expenses: { otherOperating: 10000 }, // result 2000
    netBusinessAssets: 100000 // 20% = 20000, capped at 2000
  });
  assert.equal(r.split.capitalIncome, 2000);
  assert.equal(r.split.earnedIncome, 0);
});

test('an elected capital return rate (10% / 0%) is honoured; unknown falls back to 20%', () => {
  const ten = buildAnnualReturn({ income: { sales: 30000 }, expenses: { otherOperating: 10000 }, netBusinessAssets: 50000, capitalReturnRate: 0.1 });
  assert.equal(ten.split.capitalIncome, 5000);
  const zero = buildAnnualReturn({ income: { sales: 30000 }, expenses: { otherOperating: 10000 }, netBusinessAssets: 50000, capitalReturnRate: 0 });
  assert.equal(zero.split.capitalIncome, 0);
  assert.equal(zero.split.earnedIncome, 20000);
  const bogus = buildAnnualReturn({ income: { sales: 30000 }, expenses: { otherOperating: 10000 }, netBusinessAssets: 50000, capitalReturnRate: 0.99 });
  assert.equal(bogus.split.capitalReturnRate, 0.2);
  assert.ok(CAPITAL_RETURN_RATES.includes(0.2));
});

test('missing/malformed numeric fields default to zero', () => {
  const r = buildAnnualReturn({ income: { sales: 'x' }, expenses: {} });
  assert.equal(r.income.total, 0);
  assert.equal(r.result, 0);
});

// --- FI-12 net-assets input --------------------------------------------------------

test('netBusinessAssetsFromBalanceSheet — assets − liabilities from the persisted BS', () => {
  const bs = { assets: { total: 60000 }, liabilities: { total: 12000 } };
  assert.equal(netBusinessAssetsFromBalanceSheet(bs), 48000);
});

test('netBusinessAssetsFromBalanceSheet — floored at 0 (negative net worth ⇒ 0 capital base)', () => {
  assert.equal(netBusinessAssetsFromBalanceSheet({ assets: { total: 5000 }, liabilities: { total: 9000 } }), 0);
});

test('netBusinessAssetsFromBalanceSheet — null BS ⇒ null (split stays deferred)', () => {
  assert.equal(netBusinessAssetsFromBalanceSheet(null), null);
  assert.equal(netBusinessAssetsFromBalanceSheet(undefined), null);
});

// A tilikausi P&L as the read model emits it: each row is a coded account with its
// own revenue/expense totals. resolveAccount maps the code → statutory group.
const READ_MODEL_PL = {
  rows: [
    { code: '3000', name: 'Myynti', revenue: 50000, expense: 0 },
    { code: '3900', name: 'Muut tuotot', revenue: 500, expense: 0 },
    { code: '4000', name: 'Ostot', revenue: 0, expense: 8000 },
    { code: '5000', name: 'Palkat', revenue: 0, expense: 0 }, // dormant — skipped
    { code: '7000', name: 'Vuokrat', revenue: 0, expense: 12000 },
    { code: '6800', name: 'Poistot', revenue: 0, expense: 1000 },
    { code: '9200', name: 'Korkokulut', revenue: 0, expense: 200 },
    { code: '9300', name: 'Korkotuotot', revenue: 300, expense: 0 },
    { code: '9800', name: 'Tuloverot', revenue: 0, expense: 4000 } // non-deductible
  ],
  revenue: 50800,
  expenses: 25200
};

test('buildAnnualReturnFromReadModel — maps the tilikausi P&L into tax buckets by statutory group', () => {
  const r = buildAnnualReturnFromReadModel({ taxYear: 2026, profitAndLoss: READ_MODEL_PL });
  assert.equal(r.income.sales, 50000);
  // other operating income + interest income both land in otherIncome.
  assert.equal(r.income.otherIncome, 800);
  assert.equal(r.deductibleExpenses.materials, 8000);
  assert.equal(r.deductibleExpenses.otherOperating, 12000);
  assert.equal(r.deductibleExpenses.depreciation, 1000);
  assert.equal(r.deductibleExpenses.financial, 200);
  // income tax is surfaced as non-deductible, NOT in the result.
  assert.equal(r.nonDeductibleIncomeTaxes, 4000);
  // result = (50000 + 800) − (8000 + 12000 + 1000 + 200) = 29600
  assert.equal(r.result, 29600);
  assert.equal(r.unmappedIncomeStatementRows.length, 0);
});

test('buildAnnualReturnFromReadModel — derives net assets from the prior year-end BS and splits', () => {
  const r = buildAnnualReturnFromReadModel({
    taxYear: 2026,
    profitAndLoss: { rows: [{ code: '3000', revenue: 30000, expense: 0 }, { code: '7000', revenue: 0, expense: 10000 }] },
    priorYearEndBalanceSheet: { assets: { total: 60000 }, liabilities: { total: 10000 } } // net 50000
  });
  assert.equal(r.netBusinessAssets, 50000);
  assert.equal(r.result, 20000);
  // 20% of 50000 = 10000 capital, remainder 10000 earned.
  assert.equal(r.split.capitalIncome, 10000);
  assert.equal(r.split.earnedIncome, 10000);
  assert.equal(r.needsNetAssetsForSplit, false);
});

test('buildAnnualReturnFromReadModel — no prior BS ⇒ net assets null, split deferred', () => {
  const r = buildAnnualReturnFromReadModel({
    profitAndLoss: { rows: [{ code: '3000', revenue: 30000, expense: 0 }, { code: '7000', revenue: 0, expense: 10000 }] }
  });
  assert.equal(r.netBusinessAssets, null);
  assert.equal(r.split, null);
  assert.equal(r.needsNetAssetsForSplit, true);
});

test('buildAnnualReturnFromReadModel — an uncoded/unknown row is surfaced, never bucketed', () => {
  const r = buildAnnualReturnFromReadModel({
    profitAndLoss: { rows: [
      { code: '3000', revenue: 30000, expense: 0 },
      { code: null, name: 'Mystery income', revenue: 999, expense: 0 }
    ] }
  });
  assert.equal(r.income.sales, 30000);
  assert.equal(r.unmappedIncomeStatementRows.length, 1);
  assert.equal(r.unmappedIncomeStatementRows[0].name, 'Mystery income');
  assert.equal(r.unmappedIncomeStatementRows[0].revenue, 999);
});

test('buildAnnualReturnFromReadModel — a row may carry its own statutory_group (used over the code)', () => {
  const r = buildAnnualReturnFromReadModel({
    profitAndLoss: { rows: [{ code: 'X', name: 'Consulting', statutory_group: 'turnover', revenue: 1000, expense: 0 }] }
  });
  assert.equal(r.income.sales, 1000);
  assert.equal(r.unmappedIncomeStatementRows.length, 0);
});
