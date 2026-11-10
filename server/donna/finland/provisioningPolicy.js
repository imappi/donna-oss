// FI-21 (2026-10-15) — the chart a NEW Finnish osakeyhtiö book is born with.
//
// The statutory reference is tilikartta.js (codes, Finnish names, KPA
// statutory groups — the chart annualReturn.js and the Oy watches already
// read). This module only composes it for birth: which rows a fresh book
// carries, which canonical role each carries, and which pack-palette name
// (the coder's menu vocabulary, packs/fi chart_of_accounts.fallback_accounts)
// resolves to each row. The palette stays the coder's menu, unchanged; the
// seeder takes each aliased row's role FROM the palette, so chart and menu
// cannot disagree, and the posting paths resolve a palette name to its coded
// row through the alias (db/ledger.js). Pure data, no writer.
import { buildOyChart, resolveAccount } from './tilikartta.js';
import { isFinlandOsakeyhtio } from './entity.js';

export const FI_OY_BIRTH_CHART_ID = 'fi_oy_tilikartta';
export const FI_OY_BIRTH_CHART_VERSION = 1;

// Pack-palette name → the statutory account it posts to. Every Oy palette
// entry except the coding policy's exclusions ('Owner drawings': an Oy has
// none) has exactly one home (machine-checked by provisioningPolicy.test.js).
export const FI_OY_PALETTE_CODES = Object.freeze({
  'Sales': '3000',
  'Other income': '3900',
  'Interest income': '9300',
  'Cost of sales': '4000',
  'Operating supplies': '4100',
  'Software subscriptions': '7680',
  'Travel': '7300',
  'Meals and entertainment': '7350',
  'Marketing': '7600',
  'Professional fees': '7860',
  'Accounting fees': '7840',
  'Statutory filing fees': '7870',
  'Payroll': '5000',
  'Rent': '7000',
  'Utilities': '7050',
  'Telecommunications': '7700',
  'Insurance': '7720',
  'Office expenses': '7740',
  'Motor expenses': '7400',
  'Interest expense': '9200',
  'Bank fees': '7900',
  'Platform and processor fees': '7910',
  'Foreign exchange gain/loss': '9400',
  'Director loan': '2762',
  'Loan payable': '2620',
  'Shareholder receivable': '1760',
  'Share capital': '2000',
  'Share premium': '2020',
  'Retained earnings': '2251',
  'Intercompany transfer': '1790',
  'Payment processor clearing': '1795',
  'Suoritettava arvonlisävero': '2939',
  'Ennakkovero payable': '2930',
  'TyEL and payroll contributions payable': '2950',
  'Payroll withholding and employer health-insurance payable': '2945',
  'YEL contributions': '5310',
  'Suspense': '1990'
});

// Roles for statutory rows the palette does not name. Only roles whose
// lookups are already coded to these accounts (1700/2870 are the AR/AP
// constants in ledger.js) or are unambiguous in this chart; every other row
// is born roleless, like the GB default chart's unroled rows.
const STATUTORY_ROLES = Object.freeze({
  '1120': 'asset.fixed',
  '1500': 'asset.inventory',
  '1700': 'asset.accounts_receivable',
  '1750': 'asset.prepaid',
  '2870': 'liability.accounts_payable'
});

// Not born: the bank/cash rows (the bank leg resolves or mints a bank
// account per currency at first posting; one seeded bank row would pin every
// currency to it — FI_POSTING_ACCOUNTS below says what that mint is), GRNI
// (seeded only with inventory accounting) and the inventory-change
// presentation row the perpetual ledger never posts to.
const NOT_BORN = new Set(['1900', '1910', '2880', '4090']);

// Donna's operational clearing accounts. Not KPA statement lines: clearing and
// suspense balances surface as draft-ness by role (account_type 'unknown',
// as the palette seed has always minted them), never guessed onto a side.
const OPERATIONAL_ACCOUNTS = Object.freeze([
  { code: '1790', name_fi: 'Konsernin sisäinen selvittelytili', account_type: 'unknown', normal_balance: 'debit', statutory_group: null },
  { code: '1795', name_fi: 'Maksunvälittäjien selvittelytili', account_type: 'unknown', normal_balance: 'debit', statutory_group: null },
  { code: '1990', name_fi: 'Selvittelytili', account_type: 'unknown', normal_balance: 'debit', statutory_group: null }
]);

const paletteNameByCode = new Map(Object.entries(FI_OY_PALETTE_CODES).map(([name, code]) => [code, name]));

export const FI_OY_BIRTH_CHART = Object.freeze({
  id: FI_OY_BIRTH_CHART_ID,
  version: FI_OY_BIRTH_CHART_VERSION,
  accounts: Object.freeze([...buildOyChart({ alvRegistered: true }), ...OPERATIONAL_ACCOUNTS]
    .filter((row) => !NOT_BORN.has(row.code))
    .map((row) => Object.freeze({
      code: row.code,
      name: row.name_fi,
      account_type: row.account_type,
      normal_balance: row.normal_balance,
      statutory_group: row.statutory_group,
      palette_name: paletteNameByCode.get(row.code) || null,
      canonical_role: STATUTORY_ROLES[row.code] || null
    })))
});

// The bank and cash accounts a Finnish book posts to, minted at first posting
// by the market-neutral mint (donnaLedgerWriteback.js, through
// provisioningPolicyRegistry.resolveMarketPostingAccounts) — never seeded, so
// each currency gets its own row. Every field comes from the tilikartta.js
// rows; nothing here invents a code.
//   - bank, book currency (a Finnish kirjanpito is kept in euros):
//     the chart's own 1910 Pankkitili, cash/bank role, KPA group
//     'Rahat ja pankkisaamiset'.
//   - bank, a further currency: the chart declares ONE bank row, and a second
//     code for it would be invented here. The further currency gets its own
//     row in the same statutory group with the chart's Finnish name and the
//     currency in the name (the row is keyed on that name, so it is one
//     stable row per currency), and no code until the chart itself declares
//     one. A further bank account in the SAME currency is not distinguished:
//     the bank leg has no account identity to mint on (it only uses a
//     statement's bank hint to choose among rows that already exist).
//   - cash: the chart's 1900 Käteinen raha (the company's cash box). It is
//     never the bank leg of a statement line; a bank line or a cash-paid
//     document the coder books to the cash box posts to it.
const chartPostingAccount = (code) => {
  const row = resolveAccount(code);
  return Object.freeze({ code: row.code, name: row.name_fi, account_type: row.account_type,
    normal_balance: row.normal_balance, canonical_role: 'asset.cash', statutory_group: row.statutory_group });
};
const FI_BANK_ACCOUNT = chartPostingAccount('1910');
const FI_CASH_ACCOUNT = chartPostingAccount('1900');
export const FI_BOOK_CURRENCY = 'EUR';
export const FI_POSTING_ACCOUNTS = Object.freeze({
  bankAccount: ({ currency = '' } = {}) => {
    const code = String(currency || '').trim().toUpperCase();
    if (!code || code === FI_BOOK_CURRENCY) return Object.freeze({ ...FI_BANK_ACCOUNT, currency: FI_BOOK_CURRENCY });
    return Object.freeze({ ...FI_BANK_ACCOUNT, code: null, name: `${FI_BANK_ACCOUNT.name} · ${code}`, currency: code });
  },
  cashAccount: () => FI_CASH_ACCOUNT
});

export const FI_PROVISIONING_POLICY = Object.freeze({
  postingAccounts: FI_POSTING_ACCOUNTS,
  // Toiminimi books keep the palette chart until their own chart is composed.
  birthChart: ({ entityType } = {}) => (isFinlandOsakeyhtio({ entity_type: entityType }) ? FI_OY_BIRTH_CHART : null)
});
