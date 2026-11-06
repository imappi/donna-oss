// GB default chart for a client that has no synced chart. This is Donna-native
// convenience data, NOT a statutory UK chart and never an imposed replacement
// for a client's Xero/QBO chart. VAT posting continues to resolve the canonical
// role from ledger_accounts; codes here are defaults, not authority.
export const GB_DEFAULT_CHART_PROVENANCE = Object.freeze({ kind: 'donna_native_default', statutory: false, note: 'Seed only when the client has no chart; preserve synced client charts.' });

export const GB_DEFAULT_CHART = Object.freeze([
  ['1000', 'Plant and equipment', 'asset', 'debit', 'asset.fixed'], ['1100', 'Inventory', 'asset', 'debit', 'asset.inventory'],
  ['1200', 'Trade debtors', 'receivable', 'debit', 'asset.accounts_receivable'], ['1300', 'Other debtors and prepayments', 'receivable', 'debit', null],
  ['1400', 'Bank account', 'bank', 'debit', 'asset.cash'], ['2000', 'Share capital', 'equity', 'credit', 'equity.share_capital'],
  ['2100', 'Retained earnings', 'equity', 'credit', 'equity.retained_earnings'], ['2200', 'Trade creditors', 'liability', 'credit', 'liability.accounts_payable'],
  ['2210', 'Accruals and deferred income', 'liability', 'credit', null], ['2220', 'VAT control', 'liability', 'credit', 'liability.sales_tax_payable'],
  ['2230', 'Corporation tax payable', 'liability', 'credit', 'liability.tax_payable'], ['2240', 'Director loan', 'liability', 'credit', 'liability.director_loan'],
  ['3000', 'Sales', 'revenue', 'credit', 'revenue.operating'], ['3100', 'Other income', 'revenue', 'credit', 'revenue.other'],
  ['4000', 'Cost of sales', 'expense', 'debit', 'expense.cost_of_sales'], ['5000', 'Wages and salaries', 'expense', 'debit', 'expense.payroll'],
  ['6000', 'Rent', 'expense', 'debit', 'expense.rent'], ['6100', 'Software and IT', 'expense', 'debit', 'expense.software'],
  ['6200', 'Bank fees', 'expense', 'debit', 'expense.bank_fees'], ['6300', 'Professional fees', 'expense', 'debit', 'expense.professional_fees'],
  ['6400', 'Travel', 'expense', 'debit', 'expense.travel'], ['6500', 'Marketing', 'expense', 'debit', 'expense.marketing'],
  ['6600', 'Depreciation', 'expense', 'debit', null], ['6900', 'Other operating expenses', 'expense', 'debit', null]
].map(([code, name_en, account_type, normal_balance, canonical_role]) => Object.freeze({ code, name_en, account_type, normal_balance, canonical_role })));
export const GB_SOLE_TRADER_DEFAULT_CHART = Object.freeze(GB_DEFAULT_CHART
  .filter((account) => !['2000', '2230', '2240'].includes(account.code))
  .concat([
    // equity.owner_capital, NOT equity.retained_earnings: 2100 Retained earnings
    // already carries that role, and it is a cutover singleton — two accounts on
    // it meant a sole-trader opening balance could never land (2026-07-31).
    Object.freeze({ code: '2000', name_en: 'Owner capital introduced', account_type: 'equity', normal_balance: 'credit', canonical_role: 'equity.owner_capital' }),
    Object.freeze({ code: '2010', name_en: 'Owner drawings', account_type: 'equity', normal_balance: 'debit', canonical_role: 'equity.owner_drawings' })
  ]));
export const gbDefaultChartForEntityType = (entityType) => entityType === 'gb-sole-trader' ? GB_SOLE_TRADER_DEFAULT_CHART : GB_DEFAULT_CHART;
const BY_CODE = new Map(GB_DEFAULT_CHART.map((account) => [account.code, account]));
export const resolveGbDefaultAccount = (code) => BY_CODE.get(String(code ?? '').trim()) || null;
