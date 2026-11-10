import assert from 'node:assert/strict';

import { buildLedgerJournalForTransaction } from './ledger.js';
import {
  DEFAULT_DONNA_BANK_ACCOUNT_NAME,
  buildDonnaLedgerWriteback,
  defaultDonnaBankAccount,
  findDonnaLedgerBankAccount,
  isDonnaBankLikeAccount
} from './donnaLedgerWriteback.js';

// Honeybee-shaped fixture: the seeded US apiary chart types the checking
// account as plain 'asset' (not 'bank') — the exact row the old Xero-table
// resolver could never see.
const honeybeeChart = [
  { id: 'acct-1000', code: '1000', name: 'Operating Checking', type: 'asset', currency: 'USD', status: 'active' },
  { id: 'acct-1010', code: '1010', name: 'Savings', type: 'asset', currency: 'USD', status: 'active' },
  { id: 'acct-1100', code: '1100', name: 'Accounts Receivable', type: 'asset', currency: 'USD', status: 'active' },
  { id: 'acct-1200', code: '1200', name: 'Inventory — Honey', type: 'asset', currency: 'USD', status: 'active' },
  { id: 'acct-4000', code: '4000', name: 'Retail Honey Sales', type: 'revenue', currency: 'USD', status: 'active' },
  { id: 'acct-6010', code: '6010', name: 'Vehicle Fuel', type: 'expense', currency: 'USD', status: 'active' },
  { id: 'acct-6080', code: '6080', name: 'Bank & Card Fees', type: 'expense', currency: 'USD', status: 'active' },
  { id: 'acct-9999', code: '9999', name: 'Suspense', type: 'asset', currency: 'USD', status: 'active' }
];

// ─── isDonnaBankLikeAccount: asset-side gate first, cue second ─────────────
assert.equal(isDonnaBankLikeAccount({ name: 'Operating Checking', type: 'asset' }), true);
assert.equal(isDonnaBankLikeAccount({ name: 'Main Account', type: 'bank' }), true);
assert.equal(isDonnaBankLikeAccount({ name: 'Petty Cash', type: 'asset' }), true);
assert.equal(isDonnaBankLikeAccount({ name: 'Till Float', type: 'asset', canonical_role: 'asset.cash' }), true);
// name cue on the WRONG side of the balance sheet must not resolve as bank
assert.equal(isDonnaBankLikeAccount({ name: 'Bank & Card Fees', type: 'expense' }), false);
assert.equal(isDonnaBankLikeAccount({ name: 'Cash Sales', type: 'revenue' }), false);
// asset without a cue is not a bank
assert.equal(isDonnaBankLikeAccount({ name: 'Accounts Receivable', type: 'asset' }), false);
assert.equal(isDonnaBankLikeAccount({ name: 'Inventory — Honey', type: 'asset' }), false);

// ─── findDonnaLedgerBankAccount ─────────────────────────────────────────────
// Operating Checking beats Savings (checking/operating cue), and the
// expense row named 'Bank & Card Fees' is never a candidate.
assert.equal(
  findDonnaLedgerBankAccount({
    transaction: { account_currency: 'USD', description: 'SHELL OIL 5744' },
    ledgerAccounts: honeybeeChart
  })?.code,
  '1000'
);
// currency outranks the name cue
assert.equal(
  findDonnaLedgerBankAccount({
    transaction: { account_currency: 'EUR' },
    ledgerAccounts: [
      ...honeybeeChart,
      { id: 'acct-090', code: '090', name: 'Bank EUR', type: 'bank', currency: 'EUR', status: 'active' }
    ]
  })?.code,
  '090'
);
// an explicit source-account hint on the transaction wins outright
assert.equal(
  findDonnaLedgerBankAccount({
    transaction: { account_currency: 'USD', source_account_code: '1010' },
    ledgerAccounts: honeybeeChart
  })?.code,
  '1010'
);
// dismissed rows are out; no bank-like row at all → null
assert.equal(
  findDonnaLedgerBankAccount({
    transaction: { account_currency: 'USD' },
    ledgerAccounts: [{ id: 'acct-x', code: '1000', name: 'Operating Checking', type: 'asset', status: 'archived' }]
  }),
  null
);
assert.equal(findDonnaLedgerBankAccount({ transaction: {}, ledgerAccounts: [] }), null);

// ─── defaultDonnaBankAccount: one stable row per currency ──────────────────
assert.deepEqual(defaultDonnaBankAccount({ account_currency: 'USD' }).name, `${DEFAULT_DONNA_BANK_ACCOUNT_NAME} · USD`);
assert.equal(defaultDonnaBankAccount({ account_currency: 'USD' }).type, 'bank');
assert.equal(defaultDonnaBankAccount({}).name, DEFAULT_DONNA_BANK_ACCOUNT_NAME);

// ─── buildDonnaLedgerWriteback: chart match resolves the real code ──────────
const fuel = buildDonnaLedgerWriteback({
  transaction: {
    id: 'tx-shell',
    date: '2026-05-14',
    description: 'SHELL OIL 5744',
    money_out: 61.6,
    account_currency: 'USD',
    ai_suggestion: { proposed_account: 'Vehicle Fuel' }
  },
  ledgerAccounts: honeybeeChart
});
assert.equal(fuel.transaction_id, 'tx-shell');
assert.equal(fuel.coding.account_code, '6010');
assert.equal(fuel.coding.xero_account_match_status, 'matched');
assert.equal(fuel.bank_account.code, '1000');
assert.equal(fuel.bank_account.name, 'Operating Checking');
assert.equal(fuel.bank_account.currency, 'USD');

// …and the preview feeds the journal builder unchanged: balanced spend =
// debit expense / credit the resolved checking account.
const fuelJournal = buildLedgerJournalForTransaction({
  transaction: { id: 'tx-shell', date: '2026-05-14', description: 'SHELL OIL 5744', money_out: 61.6, account_currency: 'USD' },
  coding: fuel.coding,
  bankAccount: fuel.bank_account
});
assert.equal(fuelJournal.direction, 'spend');
assert.equal(fuelJournal.currency, 'USD');
assert.deepEqual(
  fuelJournal.lines.map((line) => [line.account.role, line.direction, line.account.code]),
  [['counterparty', 'debit', '6010'], ['bank', 'credit', '1000']]
);

// ─── mint-by-name: EMPTY chart still posts ──────────────────────────────────
// The live -llc client's chart may be empty (the seed scripts target the old
// client id). The coded NAME carries the line; the synthesized default bank
// carries the credit; upsertLedgerAccountForJournal mints both rows on commit.
const minted = buildDonnaLedgerWriteback({
  transaction: {
    id: 'tx-fuel-nochart',
    date: '2026-05-14',
    money_out: 61.6,
    account_currency: 'USD',
    ai_suggestion: { proposed_account: 'Vehicle Fuel' }
  },
  ledgerAccounts: []
});
// the name-as-code fallback from codingInputFromTransaction must NOT persist
// the name into the code slot — the row keys on the name instead
assert.equal(minted.coding.account_code, '');
assert.equal(minted.coding.account_name, 'Vehicle Fuel');
assert.equal(minted.bank_account.name, 'Business Checking · USD');
assert.equal(minted.bank_account.source, 'donna_default_bank');

const mintedJournal = buildLedgerJournalForTransaction({
  transaction: { id: 'tx-fuel-nochart', date: '2026-05-14', money_out: 61.6, account_currency: 'USD' },
  coding: minted.coding,
  bankAccount: minted.bank_account
});
assert.deepEqual(
  mintedJournal.lines.map((line) => [line.account.role, line.direction, line.account.name]),
  [['counterparty', 'debit', 'Vehicle Fuel'], ['bank', 'credit', 'Business Checking · USD']]
);

// receive direction: money-in debits the bank leg
const sale = buildDonnaLedgerWriteback({
  transaction: {
    id: 'tx-farmers-mkt',
    date: '2026-05-16',
    money_in: 312.5,
    account_currency: 'USD',
    ai_suggestion: { proposed_account: 'Retail Honey Sales' }
  },
  ledgerAccounts: honeybeeChart
});
const saleJournal = buildLedgerJournalForTransaction({
  transaction: { id: 'tx-farmers-mkt', date: '2026-05-16', money_in: 312.5, account_currency: 'USD' },
  coding: sale.coding,
  bankAccount: sale.bank_account
});
assert.deepEqual(
  saleJournal.lines.map((line) => [line.account.role, line.direction, line.account.code]),
  [['bank', 'debit', '1000'], ['counterparty', 'credit', '4000']]
);

// ─── matched to a CODE-LESS chart row: the name never lands in the code slot ─
// xeroFieldsFor sets `account_code: match.code || match.name`, so a verdict-
// minted (code-less) chart row matches with its NAME in the code position.
// Persisting that would weld the name into ledger_accounts.code and render
// "Insurance · Insurance" on the statements.
const codelessChart = [
  { id: 'acct-ins', code: null, name: 'Insurance', type: 'expense', status: 'active' },
  { id: 'acct-chk', code: null, name: 'Business Checking · USD', type: 'bank', currency: 'USD', status: 'active' }
];
const matchedCodeless = buildDonnaLedgerWriteback({
  transaction: {
    id: 'tx-ins',
    date: '2026-06-10',
    money_out: 285.47,
    account_currency: 'USD',
    ai_suggestion: { proposed_account: 'Insurance' }
  },
  ledgerAccounts: codelessChart
});
assert.equal(matchedCodeless.coding.xero_account_match_status, 'matched');
assert.equal(matchedCodeless.coding.account_code, '');
assert.equal(matchedCodeless.coding.account_name, 'Insurance');
assert.equal(matchedCodeless.coding.account_label, 'Insurance');

// ─── refusals ───────────────────────────────────────────────────────────────
// no coded account at all
assert.throws(
  () => buildDonnaLedgerWriteback({
    transaction: { id: 'tx-uncoded', date: '2026-05-14', money_out: 10, account_currency: 'USD' },
    ledgerAccounts: honeybeeChart
  }),
  (error) => error.code === 'LEDGER_WRITEBACK_INVALID_PAYLOAD' && /coded account/.test(error.message)
);
// line account resolving to the bank account itself
assert.throws(
  () => buildDonnaLedgerWriteback({
    transaction: {
      id: 'tx-self',
      date: '2026-05-14',
      money_out: 10,
      account_currency: 'USD',
      ai_suggestion: { proposed_account: 'Operating Checking' }
    },
    ledgerAccounts: honeybeeChart
  }),
  (error) => error.code === 'LEDGER_WRITEBACK_INVALID_PAYLOAD' && /same as the bank account/.test(error.message)
);

// ─── a market's declared bank and cash accounts (FI: tilikartta 1910 / 1900) ─
const fiCoded = (name, extra = {}) => buildDonnaLedgerWriteback({ jurisdiction: 'fi',
  transaction: { id: 'tx-fi', date: '2026-03-05', money_out: 120, account_currency: 'EUR', ai_suggestion: { proposed_account: name }, ...extra.transaction },
  ledgerAccounts: extra.ledgerAccounts || [{ id: 'acct-7000', code: '7000', name: 'Vuokrakulut', type: 'expense', status: 'active', aliases: ['Rent'] }] });
// An empty bank side mints the chart's 1910, carrying its declaration.
const fiRent = fiCoded('Rent');
assert.deepEqual([fiRent.bank_account.code, fiRent.bank_account.name, fiRent.bank_account.currency, fiRent.bank_account.source],
  ['1910', 'Pankkitili', 'EUR', 'market_declared_bank']);
assert.equal(fiRent.bank_account.declared_account.statutory_group, 'cash_and_bank');
const fiJournal = buildLedgerJournalForTransaction({ transaction: { id: 'tx-fi', date: '2026-03-05', money_out: 120, account_currency: 'EUR' },
  coding: fiRent.coding, bankAccount: fiRent.bank_account });
assert.deepEqual(fiJournal.lines.map((l) => [l.direction, l.account.code, l.account.type, l.account.canonical_role ?? null, l.account.statutory_group ?? null]),
  [['debit', '7000', 'expense', null, null], ['credit', '1910', 'bank', 'asset.cash', 'cash_and_bank']]);
// A further currency never lands on (and is never refused by) the EUR row.
const eurBank = { id: 'acct-1910', code: '1910', name: 'Pankkitili', type: 'bank', currency: 'EUR', canonical_role: 'asset.cash', status: 'active' };
const fiUsd = fiCoded('Rent', { transaction: { account_currency: 'USD' }, ledgerAccounts: [eurBank] });
assert.deepEqual([fiUsd.bank_account.code, fiUsd.bank_account.name, fiUsd.bank_account.currency], [null, 'Pankkitili · USD', 'USD']);
const usdRow = { id: 'acct-usd', code: null, name: 'Pankkitili · USD', type: 'bank', currency: 'USD', canonical_role: 'asset.cash', status: 'active' };
const fiUsdAgain = fiCoded('Rent', { transaction: { account_currency: 'USD' }, ledgerAccounts: [eurBank, usdRow] });
assert.equal(fiUsdAgain.bank_account.id, 'acct-usd', 'one stable row per currency');
assert.equal(fiUsdAgain.bank_account.declared_account.name, 'Pankkitili · USD', 'the minted row keeps its declaration');
// The cash box: the coder's chart name posts to 1900 with the chart shape,
// minted or not; it is never a bank leg.
const cashRow = { id: 'acct-1900', code: '1900', name: 'Käteinen raha', type: 'cash', currency: 'EUR', canonical_role: 'asset.cash', status: 'active' };
const fiCash = fiCoded('Käteinen raha', { ledgerAccounts: [eurBank] });
assert.deepEqual([fiCash.coding.account_code, fiCash.coding.account_name, fiCash.coding.declared_account.account_type, fiCash.bank_account.code],
  ['1900', 'Käteinen raha', 'cash', '1910']);
const cashJournal = buildLedgerJournalForTransaction({ transaction: { id: 'tx-fi', date: '2026-03-05', money_out: 120, account_currency: 'EUR' },
  coding: fiCash.coding, bankAccount: fiCash.bank_account });
assert.deepEqual(cashJournal.lines[0].account, { role: 'counterparty', code: '1900', name: 'Käteinen raha', type: 'cash', normal_balance: 'debit', tax_type: '',
  xero_account_id: '', label: '1900 · Käteinen raha', canonical_role: 'asset.cash', statutory_group: 'cash_and_bank' });
assert.equal(findDonnaLedgerBankAccount({ transaction: { account_currency: 'EUR' }, ledgerAccounts: [cashRow],
  postingAccounts: (await import('./provisioningPolicyRegistry.js')).resolveMarketPostingAccounts('fi') }), null, 'the cash box is not a bank leg');
assert.equal(fiCoded('Rent', { ledgerAccounts: [cashRow] }).bank_account.code, '1910');
// An existing book's engine-default row keeps the EUR bank leg (no mid-book
// move), unless the chart's own 1910 is there too (the opening balance posts it).
const legacyDefault = { id: 'acct-default', code: null, name: 'Business Checking · EUR', type: 'bank', currency: 'EUR', status: 'active' };
assert.equal(fiCoded('Rent', { ledgerAccounts: [legacyDefault] }).bank_account.id, 'acct-default');
assert.equal(fiCoded('Rent', { ledgerAccounts: [legacyDefault, eurBank] }).bank_account.id, 'acct-1910');
assert.equal(fiCoded('Rent', { ledgerAccounts: [legacyDefault, eurBank], transaction: { bank_account_code: 'Business Checking · EUR' } }).bank_account.id,
  'acct-default', 'a statement\'s explicit bank hint still wins');
// No declaration: byte-identical to before — the EUR default for any currency.
const gbChart = [{ id: 'gb-1400', code: '1400', name: 'Bank account', type: 'bank', canonical_role: 'asset.cash', status: 'active' }];
for (const jurisdiction of ['gb', 'sg', 'us', null]) {
  const result = buildDonnaLedgerWriteback({ jurisdiction, ledgerAccounts: gbChart,
    transaction: { id: 'tx-n', date: '2026-03-05', money_out: 5, account_currency: 'USD', ai_suggestion: { proposed_account: 'Käteinen raha' } } });
  assert.deepEqual(result.bank_account, { id: 'gb-1400', code: '1400', name: 'Bank account', currency: null, tax_type: null,
    account_label: '1400 · Bank account', source: 'native_ledger' }, String(jurisdiction));
  assert.equal(result.coding.declared_account, undefined);
  assert.equal(result.coding.account_code, '', 'no market cash account where none is declared');
  assert.deepEqual(buildDonnaLedgerWriteback({ jurisdiction, ledgerAccounts: [legacyDefault],
    transaction: { id: 'tx-n', date: '2026-03-05', money_out: 5, account_currency: 'USD', ai_suggestion: { proposed_account: 'Rent' } } }).bank_account.id,
  'acct-default', 'without a declaration the finder still takes the only bank row');
}

console.log('donnaLedgerWriteback tests passed');
