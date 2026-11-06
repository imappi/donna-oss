// FI-12 (aggregation-half) — the annual Finnish sole-trader business tax return
// (elinkeinonharjoittajan veroilmoitus, "lomake 5"). Pure aggregation: roll a
// tilikausi's income and deductible expenses (incl. the FI-11 travel deductions)
// into the taxable business result. This COMPUTES and RENDERS a verdict; it does
// NOT submit to OmaVero — submission is gated (same file-vs-notify posture as the
// ALV return, decision D3). No ledger post, no isolation-listed import.
//
// KEEP-layer: result = total income − total deductible expenses − additional
// deductions is deterministic arithmetic, not a model judgment.
//
// Scope note: this computes the elinkeinotoiminnan tulos (business result). The
// form-5 split of a positive result into capital income (pääomatulo — a deemed
// return on the business's net assets / nettovarallisuus) and earned income
// (ansiotulo) is computed ONLY when `netBusinessAssets` is supplied; otherwise the
// split is left null and flagged, because it depends on the prior year-end balance
// sheet (a downstream input), not the income statement.
//
// FI-12 net-assets input (this slice): that "downstream input" is now wired.
// `netBusinessAssetsFromBalanceSheet` derives nettovarallisuus from FI-6 Half B's
// persisted, tilikausi-bounded balance sheet (assets − liabilities, floored at 0),
// and `buildAnnualReturnFromReadModel` maps the read model's tilikausi P&L into the
// tax buckets (via the tilikartta statutory groups — render-the-persisted-verdict,
// not a re-inference) and feeds both into `buildAnnualReturn`. It CONSUMES the read
// model's persisted output objects (passed in as args); it never imports the
// isolation-listed `ledgerReadModel.js` — the header rule holds.

import { resolveAccount } from './tilikartta.js';

const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

// The capital-income return rates a sole trader may elect (Tuloverolaki): 20%
// default, or 10%, or 0% (all earned income).
export const CAPITAL_RETURN_RATES = [0.2, 0.1, 0];

// buildAnnualReturn({ taxYear, income, expenses, additionalDeductions,
// netBusinessAssets, capitalReturnRate, taxAdjustments }) — returns the
// aggregated return. `taxAdjustments` (G-11, D-P2-3) is evaluateTaxAdjustments'
// output for THIS tax year (or null): recorded accounting-vs-tax treatment
// items applied deterministically — result = resultBeforeAdjustments +
// add-backs − deductions, the capital/earned split divides the ADJUSTED
// result, and every item is surfaced verbatim. Absent ⇒ every existing key is
// byte-identical to the pre-G-11 output.
export const buildAnnualReturn = ({
  taxYear,
  income = {},
  expenses = {},
  additionalDeductions = {},
  netBusinessAssets = null,
  capitalReturnRate = 0.2,
  taxAdjustments = null
} = {}) => {
  // Income (tuotot).
  const sales = num(income.sales);
  const otherIncome = num(income.otherIncome);
  const totalIncome = round2(sales + otherIncome);

  // Deductible expenses (vähennyskelpoiset kulut).
  const materials = num(expenses.materials);
  const personnel = num(expenses.personnel);
  const otherOperating = num(expenses.otherOperating);
  const depreciation = num(expenses.depreciation);
  const financial = num(expenses.financial);
  const totalExpenses = round2(materials + personnel + otherOperating + depreciation + financial);

  // Additional deductions (lisävähennykset) — FI-11 travel totals, and any other.
  const travel = num(additionalDeductions.travel);
  const other = num(additionalDeductions.other);
  const totalAdditional = round2(travel + other);

  // Business result (elinkeinotoiminnan tulos/tappio) per the BOOKS, then the
  // recorded tax adjustments (G-11): taxable result = book-side result +
  // add-backs − extra tax deductions. KEEP-layer arithmetic on human-recorded
  // treatment records; nothing here is inferred.
  const resultBeforeAdjustments = round2(totalIncome - totalExpenses - totalAdditional);
  const adjustments = taxAdjustments && Array.isArray(taxAdjustments.items) && taxAdjustments.items.length
    ? taxAdjustments
    : null;
  const result = adjustments
    ? round2(resultBeforeAdjustments + num(adjustments.totalAddBacks) - num(adjustments.totalDeductions))
    : resultBeforeAdjustments;
  const isLoss = result < 0;

  // Capital/earned split — only when net assets are supplied and there is a
  // positive result to split.
  let split = null;
  let needsNetAssetsForSplit = false;
  if (result > 0) {
    if (netBusinessAssets === null || netBusinessAssets === undefined) {
      needsNetAssetsForSplit = true;
    } else {
      const rate = CAPITAL_RETURN_RATES.includes(capitalReturnRate) ? capitalReturnRate : 0.2;
      const capitalIncome = Math.min(result, round2(num(netBusinessAssets) * rate));
      const earnedIncome = round2(result - capitalIncome);
      split = { capitalReturnRate: rate, capitalIncome, earnedIncome };
    }
  }

  return {
    taxYear: taxYear ?? null,
    income: { sales, otherIncome, total: totalIncome },
    deductibleExpenses: { materials, personnel, otherOperating, depreciation, financial, total: totalExpenses },
    additionalDeductions: { travel, other, total: totalAdditional },
    result,
    resultBeforeAdjustments,
    taxAdjustments: adjustments,
    isLoss,
    split,
    needsNetAssetsForSplit
  };
};

// ---------------------------------------------------------------------------------
// FI-12 net-assets input — derive nettovarallisuus from a persisted balance sheet.
// ---------------------------------------------------------------------------------
// `balanceSheet` is FI-6 Half B's persisted BS output (ledgerReadModel's
// `balance_sheet`): { assets: { total }, liabilities: { total }, ... }. Net business
// assets (nettovarallisuus) = assets − liabilities, FLOORED AT 0: the deemed
// capital-income return (pääomatulo-osuus) base under Tuloverolaki is never
// negative — a business with negative net worth yields a 0% capital portion (all
// earned income). Pure; returns null when no balance sheet is available (so the
// split stays deferred rather than computed off a zero it can't distinguish from
// "truly zero net assets").
export const netBusinessAssetsFromBalanceSheet = (balanceSheet) => {
  if (!balanceSheet || typeof balanceSheet !== 'object') return null;
  const assets = num(balanceSheet.assets?.total);
  const liabilities = num(balanceSheet.liabilities?.total);
  return Math.max(0, round2(assets - liabilities));
};

// Map each income-statement statutory group to the annual-return bucket it feeds.
// Revenue side and expense side are kept separate so the financial group
// (interest income vs interest expense) routes correctly: its income lands in
// `otherIncome`, its cost in the deductible `financial` expense. Income taxes
// (tuloverot) are NOT a deductible business expense — routed to a surfaced
// non-deductible bucket, never silently folded into the result.
const PL_GROUP_TO_INCOME_BUCKET = Object.freeze({
  turnover: 'sales',
  other_operating_income: 'otherIncome',
  financial_income_and_expenses: 'otherIncome'
});
const PL_GROUP_TO_EXPENSE_BUCKET = Object.freeze({
  materials_and_services: 'materials',
  personnel_expenses: 'personnel',
  other_operating_expenses: 'otherOperating',
  depreciation: 'depreciation',
  financial_income_and_expenses: 'financial'
});

// Resolve a P&L row's statutory group. Prefers the row's own statutory_group, else
// resolves it from the account code via the tilikartta. Returns null when the row
// is uncoded/unknown — such a row is SURFACED as unmapped, never guessed into a
// bucket (a misbucketed expense is a tax error).
const plRowStatutoryGroup = (row = {}) => {
  const declared = String(row.statutory_group || '').trim();
  if (declared) return declared;
  const resolved = resolveAccount(row.code);
  return resolved?.statutory_group || null;
};

// buildAnnualReturnFromReadModel({ taxYear, profitAndLoss, priorYearEndBalanceSheet,
//   additionalDeductions, capitalReturnRate }) — the wired FI-12 aggregation.
//
// `profitAndLoss` is the read model's tilikausi-bounded `profit_and_loss`
// ({ rows: [{ code, account_type, revenue, expense, ... }], ... }); each row's
// revenue/expense are already the persisted, coded totals (render-the-persisted-
// verdict). `priorYearEndBalanceSheet` is the read model's `balance_sheet` as of the
// PRIOR tilikausi end — nettovarallisuus for the deemed capital return is the prior
// year-end figure (for a switcher's first Donna year that is the FI-6 opening avaava
// tase; for a greenfield year-1 it is null/zero). Returns the buildAnnualReturn
// verdict plus `netBusinessAssets`, the surfaced `nonDeductibleIncomeTaxes`, and any
// `unmappedIncomeStatementRows` (draft-ness surfaced, not hidden behind a clean total).
// `netBusinessAssetsOverride` (G-10, D-P2-5): the cutover-recorded prior-year
// nettovarallisuus. The caller passes it ONLY for the tilikausi the cutover
// pack anchors to (cutoverNetWorthForTaxYear) — a year for which Donna by
// definition has no authoritative prior books, so a "derived" prior figure is
// an empty-BS zero indistinguishable from truly-zero. The RECORDED figure
// therefore WINS for that year; every later year derives from Donna's own
// persisted balance sheets. `net_assets_source` stamps the provenance on the
// verdict (the-model-id-is-part-of-the-receipt discipline, applied to inputs).
export const buildAnnualReturnFromReadModel = ({
  taxYear = null,
  profitAndLoss = {},
  priorYearEndBalanceSheet = null,
  additionalDeductions = {},
  capitalReturnRate = 0.2,
  taxAdjustments = null,
  netBusinessAssetsOverride = null
} = {}) => {
  const income = { sales: 0, otherIncome: 0 };
  const expenses = { materials: 0, personnel: 0, otherOperating: 0, depreciation: 0, financial: 0 };
  let nonDeductibleIncomeTaxes = 0;
  const unmappedIncomeStatementRows = [];

  for (const row of Array.isArray(profitAndLoss?.rows) ? profitAndLoss.rows : []) {
    const revenue = num(row.revenue);
    const expense = num(row.expense);
    if (revenue === 0 && expense === 0) continue; // dormant account, no signal
    const group = plRowStatutoryGroup(row);

    if (group === 'income_taxes') {
      nonDeductibleIncomeTaxes = round2(nonDeductibleIncomeTaxes + expense);
      continue;
    }

    const incomeBucket = PL_GROUP_TO_INCOME_BUCKET[group];
    const expenseBucket = PL_GROUP_TO_EXPENSE_BUCKET[group];
    if (!incomeBucket && !expenseBucket) {
      // Uncoded / unknown / out-of-model group — surface it, never guess a bucket.
      unmappedIncomeStatementRows.push({ code: row.code ?? null, name: row.name ?? null, revenue, expense, statutory_group: group || null });
      continue;
    }
    if (incomeBucket && revenue) income[incomeBucket] = round2(income[incomeBucket] + revenue);
    if (expenseBucket && expense) expenses[expenseBucket] = round2(expenses[expenseBucket] + expense);
  }

  const derivedNetAssets = netBusinessAssetsFromBalanceSheet(priorYearEndBalanceSheet);
  const overrideNetAssets = Number.isFinite(Number(netBusinessAssetsOverride)) && netBusinessAssetsOverride !== null
    ? Math.max(0, round2(Number(netBusinessAssetsOverride)))
    : null;
  const netBusinessAssets = overrideNetAssets !== null ? overrideNetAssets : derivedNetAssets;
  const netAssetsSource = overrideNetAssets !== null
    ? 'cutover_profile'
    : derivedNetAssets !== null
      ? 'prior_balance_sheet'
      : null;

  const annual = buildAnnualReturn({ taxYear, income, expenses, additionalDeductions, netBusinessAssets, capitalReturnRate, taxAdjustments });
  return {
    ...annual,
    netBusinessAssets,
    net_assets_source: netAssetsSource,
    nonDeductibleIncomeTaxes,
    unmappedIncomeStatementRows
  };
};
