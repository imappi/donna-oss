import { normalizeIntelText } from './transactionIntel.js';
import { enrichCodingWithXeroAccount } from './xeroAccountMatcher.js';
import { codingInputFromTransaction } from './xeroWriteback.js';
import { resolveMarketPostingAccounts } from './provisioningPolicyRegistry.js';

// Donna-ledger-native posting preview for clients with NO external accounting
// system (accounting_system = 'none'). Sibling of buildXeroBankTransactionWriteback
// with the same return shape ({ transaction_id, coding, bank_account }) so
// prepareLedgerTransactionPosting can feed either into
// buildLedgerJournalForTransaction unchanged. Differences from the Xero builder:
//
//   - The account universe is the client's OWN ledger_accounts chart
//     (getDonnaLedgerAccountsForClient), not the xero_accounts mirror — the
//     mirror is empty for a Donna-ledger-only client, which is exactly why the
//     old path threw "No Xero bank account is synced" on every post.
//   - Mint-by-name: a coded account with no chart match still posts by NAME.
//     upsertLedgerAccountForJournal mints a code-less ledger_accounts row keyed
//     on the name (the ensureLedgerAccountFromVerdict scheme), so later posts
//     land on the same row. The local ledger auto-creates its chart at posting
//     time; a "matched code required" gate is Xero-writeback scaffolding that
//     has no correctness role here.
//   - A chart with no bank-like row falls back to the bank account the
//     client's market declares (provisioningPolicyRegistry
//     .resolveMarketPostingAccounts — FI: tilikartta 1910 Pankkitili), and
//     only for a market that declares none to a synthesized default bank
//     account (defaultDonnaBankAccount). The first successful post mints it
//     into ledger_accounts (type 'bank'), so resolution self-heals — no manual
//     provisioning step per Donna-ledger client. Under a declaration the bank
//     leg never lands on a row of another currency (that currency mints its
//     own declared row) nor on the declared cash account.

const trim = (value = '') => String(value || '').trim();

const validationError = (message) => {
  const error = new Error(message);
  error.statusCode = 400;
  error.code = 'LEDGER_WRITEBACK_INVALID_PAYLOAD';
  return error;
};

const accountCode = (account = {}) => trim(account.code || account.account_code);
const accountName = (account = {}) => trim(account.name || account.account_name);
const accountCurrency = (account = {}) => trim(account.currency || account.account_currency).toUpperCase();
const accountType = (account = {}) => normalizeIntelText(account.type || account.account_type);

const accountLabel = (account = {}) => {
  const code = accountCode(account);
  const name = accountName(account);
  return code && name ? `${code} · ${name}` : name || code;
};

const isActive = (account = {}) => {
  const status = normalizeIntelText(account.status);
  return !status || status === 'active';
};

const transactionCurrency = (transaction = {}) =>
  trim(transaction.account_currency || transaction.currency).toUpperCase();

// Same explicit bank hints findXeroBankAccount honours — a statement-derived
// transaction may carry the source account it settled through.
const explicitBankKeys = (transaction = {}) =>
  [
    transaction.bank_account_code,
    transaction.bankAccountCode,
    transaction.source_account_code,
    transaction.sourceAccountCode,
    transaction.bank_account_id,
    transaction.bankAccountId
  ]
    .map(trim)
    .filter(Boolean);

const BANK_NAME_CUE = /(?:^|\s)(?:bank|checking|chequing|savings|cash)(?:\s|$)/;

const isBankTyped = (account = {}) =>
  /bank|cash/.test(accountType(account)) || trim(account.canonical_role) === 'asset.cash';

// Asset-side gate first, name cue second — "Bank & Card Fees" (expense) and
// "Cash Sales" (revenue) must never resolve as the bank leg; "Operating
// Checking" (typed plain asset by the seed) must.
const isAssetSide = (account = {}) => {
  const type = accountType(account);
  return !type || /bank|cash|asset|current/.test(type);
};

export const isDonnaBankLikeAccount = (account = {}) =>
  isAssetSide(account) &&
  (isBankTyped(account) || BANK_NAME_CUE.test(normalizeIntelText(accountName(account))));

const sameDeclaredAccount = (account = {}, declared = null) => {
  if (!declared) return false;
  const code = accountCode(account);
  return code && declared.code ? code === declared.code
    : !code && !declared.code && normalizeIntelText(accountName(account)) === normalizeIntelText(declared.name);
};

// `postingAccounts` is the market's declaration (null: today's behaviour,
// byte-identical). With one, the declared cash account is never a bank leg,
// and a row denominated in another currency is never this line's bank leg.
export const findDonnaLedgerBankAccount = ({ transaction = {}, ledgerAccounts = [], postingAccounts = null } = {}) => {
  const currency = transactionCurrency(transaction);
  const cash = postingAccounts?.cashAccount?.() || null;
  const candidates = ledgerAccounts.filter((account) => isActive(account) && isDonnaBankLikeAccount(account)
    && !(postingAccounts && (sameDeclaredAccount(account, cash)
      || (currency && accountCurrency(account) && accountCurrency(account) !== currency))));
  if (!candidates.length) return null;

  const keys = explicitBankKeys(transaction).map(normalizeIntelText).filter(Boolean);
  // The market's own bank row for this currency outranks an engine default
  // that a book posted to before the market declared one (the FI opening
  // balance already lands on 1910); a statement's explicit hint still wins.
  const declaredBank = postingAccounts?.bankAccount?.({ currency }) || null;
  const scored = candidates.map((account) => {
    const code = accountCode(account);
    const name = accountName(account);
    const candidateCurrency = accountCurrency(account);
    let score = 0;
    if (keys.some((key) => [code, name, account.id].map(normalizeIntelText).includes(key))) score += 100;
    if (currency && candidateCurrency === currency) score += 40;
    if (!candidateCurrency) score += 10;
    if (isBankTyped(account)) score += 30;
    if (/(?:^|\s)(?:bank|checking|chequing|operating)(?:\s|$)/.test(normalizeIntelText(name))) score += 8;
    if (code) score += 3;
    if (sameDeclaredAccount(account, declaredBank)) score += 50;
    return { account, score };
  });

  scored.sort((left, right) => right.score - left.score || accountLabel(left.account).localeCompare(accountLabel(right.account)));
  return scored[0]?.account || null;
};

export const DEFAULT_DONNA_BANK_ACCOUNT_NAME = 'Business Checking';

// The synthesized default when the chart has no bank-like row. Currency is part
// of the NAME so upsertLedgerAccountForJournal (which keys the row id on the
// name for code-less accounts) mints one stable row per currency instead of one
// row whose currency flips with each post.
export const defaultDonnaBankAccount = (transaction = {}) => {
  const currency = transactionCurrency(transaction);
  const name = currency ? `${DEFAULT_DONNA_BANK_ACCOUNT_NAME} · ${currency}` : DEFAULT_DONNA_BANK_ACCOUNT_NAME;
  return {
    code: '',
    name,
    type: 'bank',
    currency: currency || null,
    account_label: name,
    source: 'donna_default_bank'
  };
};

// The bank account the market declares for this line's currency, shaped like
// a chart row, for a chart that has no bank row for it yet. The mint carries
// the declared type, role and statutory group (ledger.js ledgerAccountFromBank
// → upsertLedgerAccountForJournal), so it lands where the market's statements
// expect it.
export const declaredDonnaBankAccount = (postingAccounts, transaction = {}) => {
  const declared = postingAccounts?.bankAccount?.({ currency: transactionCurrency(transaction) });
  if (!declared) return null;
  return {
    code: declared.code || '',
    name: declared.name,
    type: declared.account_type,
    currency: declared.currency || transactionCurrency(transaction) || null,
    account_label: accountLabel(declared),
    declared_account: declared,
    source: 'market_declared_bank'
  };
};

// buildLedgerJournalForTransaction reads bankAccount.currency (the journal
// currency fallback), so unlike the Xero summary this one keeps it. A
// market-declared account also carries its declaration (only then: every
// other summary is unchanged).
const donnaBankAccountSummary = (bankAccount = {}) => ({
  id: bankAccount.id || null,
  code: accountCode(bankAccount) || null,
  name: accountName(bankAccount) || null,
  currency: accountCurrency(bankAccount) || null,
  tax_type: trim(bankAccount.tax_type) || null,
  account_label: bankAccount.account_label || accountLabel(bankAccount),
  source: bankAccount.source || 'native_ledger',
  ...(bankAccount.declared_account ? { declared_account: bankAccount.declared_account } : {})
});

// A chart row that IS a declared account (minted earlier, or seeded by another
// writer on the same code — the FI opening balance posts 1910) still carries
// the declaration, so the mint's coalesce-fill completes a row that was
// minted without its role or statutory group.
const withDeclaration = (account, declared) =>
  account && declared && sameDeclaredAccount(account, declared) ? { ...account, declared_account: declared } : account;

export const buildDonnaLedgerWriteback = ({ transaction = {}, ledgerAccounts = [], jurisdiction = null } = {}) => {
  // The matcher machinery is shape-agnostic ({ code, name, type, status }), so
  // the Donna chart slots in as the universe: a chart match resolves the coded
  // account to its real code + chart name (by code, name or palette alias).
  // This chart IS the coder's vocabulary, so nothing is substituted: a coded
  // account with no row mints by name below, never lands on a neighbour
  // ("Other income" on Sales).
  const coding = enrichCodingWithXeroAccount({
    coding: codingInputFromTransaction(transaction),
    transaction,
    xeroAccounts: ledgerAccounts,
    jurisdiction,
    substitute: false
  });
  const rawCode = trim(coding.xero_account_code || coding.account_code);
  const rawLineName = trim(coding.xero_account_name || coding.account_name || coding.proposed_account);
  // Mint-by-name: both codingInputFromTransaction (unmatched) and xeroFieldsFor
  // (matched to a CODE-LESS chart row: `account_code: match.code || match.name`)
  // fall back to the account NAME for account_code. A name must never persist
  // into the chart code slot — it renders "Insurance · Insurance" and welds the
  // name into `code` on the upsert — so blank it whenever code === name and let
  // the name key the row. A real chart code survives (it differs from the name).
  let lineCode = rawCode && normalizeIntelText(rawCode) === normalizeIntelText(rawLineName) ? '' : rawCode;
  let lineName = rawLineName;
  if (!lineCode && !lineName) {
    throw validationError('A coded account (code or name) is required before ledger posting.');
  }

  const postingAccounts = resolveMarketPostingAccounts(jurisdiction);
  // The coder booked the line to the market's declared cash account (by its
  // code or its chart name): post it there with the declared shape, whether
  // or not the row has been minted yet — never a code-less mint by name.
  const cash = postingAccounts?.cashAccount?.() || null;
  const cashLine = cash && (lineCode ? lineCode === cash.code : normalizeIntelText(lineName) === normalizeIntelText(cash.name));
  if (cashLine) {
    lineCode = cash.code;
    lineName = cash.name;
  }

  const bankAccount = postingAccounts
    ? withDeclaration(findDonnaLedgerBankAccount({ transaction, ledgerAccounts, postingAccounts }),
      postingAccounts.bankAccount({ currency: transactionCurrency(transaction) })) || declaredDonnaBankAccount(postingAccounts, transaction)
    : findDonnaLedgerBankAccount({ transaction, ledgerAccounts }) || defaultDonnaBankAccount(transaction);
  const bankCode = accountCode(bankAccount);
  const sameAsBank = lineCode && bankCode
    ? lineCode === bankCode
    : normalizeIntelText(lineName) === normalizeIntelText(accountName(bankAccount));
  if (sameAsBank) {
    throw validationError('Ledger line account cannot be the same as the bank account.');
  }

  return {
    transaction_id: transaction.id || null,
    coding: {
      ...coding,
      account_code: lineCode,
      account_name: lineName,
      account_label: cashLine ? accountLabel(cash) : coding.account_label || accountLabel({ code: lineCode, name: lineName }),
      ...(cashLine ? { xero_account_code: cash.code, xero_account_name: cash.name, declared_account: cash } : {})
    },
    bank_account: donnaBankAccountSummary(bankAccount)
  };
};
