import { normalizeIntelText } from './transactionIntel.js';
import { toLocalIsoDay } from './dates.js';
import { requireLedgerCurrency, assertLedgerCurrencyMatches } from './ledgerCurrency.js';
// NOTE (2026-07-27): this file used to `import { ALV_SPLIT_CONTROL,
// alvOutputCodeForRate } from './finland/alvCodes.js'` for the AR tax split.
// That import was gap 8's FOURTH and most load-bearing `finland/` edge — a
// country module reached into the isolation-listed ledger post path, so the
// generic outbound lane could only ever post a market whose vocabulary this
// file happened to import. It is DELETED, not relocated: the FI codes are
// FI statutory data and stay in `finland/`; the ENGINE stopped importing them.
// Callers now inject a `taxPosting` profile (see buildSalesInvoiceJournal).
// Design: docs/design-donna-gb-vat-ar-posting.md §3.

const trim = (value = '') => String(value || '').trim();

const numberValue = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const roundedMoney = (value) => Math.round(numberValue(value) * 100) / 100;

export const ledgerTransactionDirection = (transaction = {}) => {
  if (numberValue(transaction.money_in) > 0) return 'receive';
  if (numberValue(transaction.money_out) > 0) return 'spend';
  return 'zero';
};

export const ledgerTransactionAmount = (transaction = {}) => {
  const direction = ledgerTransactionDirection(transaction);
  if (direction === 'receive') return roundedMoney(transaction.money_in);
  if (direction === 'spend') return roundedMoney(transaction.money_out);
  return roundedMoney(transaction.amount);
};

export const ledgerDateOnly = (value = '') => {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    const year = value.getFullYear();
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  const text = trim(value);
  // NOTE: a datetime string truncates to its UTC calendar day here — the
  // right read for the created_at/uploaded_at FALLBACK paths that feed this.
  // Period BOUNDS have a stricter seam: normalizeLedgerPeriod
  // (ledgerReadModel.js) nearest-day-rounds a datetime first, because there
  // it is always a serialized `date` column, never a real instant.
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text));
};

const accountLabel = ({ code = '', name = '' } = {}) => {
  const cleanCode = trim(code);
  const cleanName = trim(name);
  return cleanCode && cleanName ? `${cleanCode} · ${cleanName}` : cleanName || cleanCode;
};

const accountTypeFor = ({ account = {}, fallback = '' } = {}) => {
  const raw = normalizeIntelText(account.type || account.xero_account_type || account.account_type || fallback);
  if (/bank/.test(raw)) return 'bank';
  if (/revenue|income|sales/.test(raw)) return 'revenue';
  if (/expense|direct cost|cost/.test(raw)) return 'expense';
  if (/asset|prepayment|inventory|equipment/.test(raw)) return 'asset';
  if (/liability|loan|payable|clearing|suspense/.test(raw)) return 'liability';
  if (/equity|capital|retained/.test(raw)) return 'equity';
  return 'unknown';
};

const normalBalanceForType = (type = '') =>
  ['asset', 'expense', 'bank'].includes(type) ? 'debit' : 'credit';

// RT-23: the coding's account type as the journal builder reads it — the
// posting policies key the tax-treatment invariant on it (a P&L leg for a
// VAT-registered client must carry a resolved code before it may post).
export const ledgerAccountTypeFor = (coding = {}) => accountTypeFor({ account: coding });

// A market-declared posting account (the country's provisioning policy —
// FI: tilikartta 1910 / 1900, provisioningPolicyRegistry
// .resolveMarketPostingAccounts) rides the coding or bank summary as
// `declared_account`. Its own type, role and statutory group are what the
// account mint writes; every account without one is shaped exactly as before.
const declaredAccountFields = (declared) => (declared
  ? { canonical_role: declared.canonical_role || null, statutory_group: declared.statutory_group || null } : {});

const ledgerAccountFromCoding = (coding = {}) => {
  const code = trim(coding.xero_account_code || coding.account_code || coding.code);
  const name = trim(coding.xero_account_name || coding.account_name || coding.proposed_account || coding.name || code);
  const declared = coding.declared_account || null;
  const type = declared?.account_type || accountTypeFor({ account: coding });
  return {
    role: 'counterparty',
    code,
    name,
    type,
    normal_balance: declared?.normal_balance || normalBalanceForType(type),
    tax_type: trim(coding.xero_tax_type || coding.tax_type),
    xero_account_id: trim(coding.xero_account_id || coding.account_id),
    label: coding.account_label || accountLabel({ code, name }),
    ...declaredAccountFields(declared)
  };
};

const ledgerAccountFromBank = (bankAccount = {}) => {
  const code = trim(bankAccount.code || bankAccount.xero_account_code || bankAccount.Code);
  const name = trim(bankAccount.name || bankAccount.xero_account_name || bankAccount.Name || code);
  const declared = bankAccount.declared_account || null;
  return {
    role: 'bank',
    code,
    name,
    type: declared?.account_type || 'bank',
    normal_balance: 'debit',
    tax_type: trim(bankAccount.tax_type || bankAccount.xero_tax_type || 'NONE'),
    xero_account_id: trim(bankAccount.xero_account_id || bankAccount.account_id || bankAccount.AccountID),
    label: bankAccount.account_label || accountLabel({ code, name }),
    ...declaredAccountFields(declared)
  };
};

// Slice 4b (docs/donna-settlement-answer-and-ledger-entry-plan.md §3) — the
// settlement journal for a MONEY-OUT document that settled outside the visible
// bank feed (cash / the owner's personal card): DR the expense account /
// CR the owner's-funds account. Balanced by construction (one debit + one
// credit of the same amount), same as the transaction builder above. Money-IN
// documents (a sales invoice settled in cash) are a DIFFERENT journal shape
// (owner drew the cash) and are deliberately NOT built here — the producer's
// gather excludes them; a future slice designs that case on purpose.
export const buildLedgerJournalForDocumentSettlement = ({
  document = {},
  expenseAccount = {},
  ownerFundsAccount = {},
  alvSplit = null
} = {}) => {
  const amount = roundedMoney(document.total_amount);
  if (!(amount > 0)) {
    const error = new Error('Settlement posting requires a positive document amount.');
    error.code = 'LEDGER_INVALID_DOCUMENT_AMOUNT';
    throw error;
  }
  const journalDate = ledgerDateOnly(document.document_date);
  if (!journalDate) {
    const error = new Error('Settlement posting requires a document date.');
    error.code = 'LEDGER_INVALID_DOCUMENT_DATE';
    throw error;
  }
  if (!document.id) {
    const error = new Error('Settlement posting requires a document id.');
    error.code = 'LEDGER_MISSING_SOURCE_ID';
    throw error;
  }

  const expense = ledgerAccountFromCoding(expenseAccount);
  if (!expense.code && !expense.name) {
    const error = new Error('Settlement posting requires an expense account.');
    error.code = 'LEDGER_MISSING_COUNTERPARTY_ACCOUNT';
    throw error;
  }
  const ownerCode = trim(ownerFundsAccount.code);
  const ownerName = trim(ownerFundsAccount.name);
  if (!ownerCode && !ownerName) {
    const error = new Error('Settlement posting requires an owner-funds account.');
    error.code = 'LEDGER_MISSING_OWNER_FUNDS_ACCOUNT';
    throw error;
  }
  const ownerFunds = {
    role: 'owner_funds',
    code: ownerCode,
    name: ownerName,
    type: trim(ownerFundsAccount.type) || 'liability',
    normal_balance: 'credit',
    tax_type: trim(ownerFundsAccount.tax_type || 'NONE'),
    xero_account_id: trim(ownerFundsAccount.xero_account_id),
    canonical_role: ownerFundsAccount.canonical_role || null,
    label: ownerFundsAccount.label || accountLabel({ code: ownerCode, name: ownerName })
  };

  const currency = requireLedgerCurrency(document.currency, 'document');
  const counterparty = trim(document.vendor_name || document.customer_name || '');
  const memo = counterparty
    ? `Settled outside the bank feed: ${counterparty}`
    : `Settled outside the bank feed: ${trim(document.filename || document.id)}`;

  const split = verifiedAlvSplit({alvSplit, gross: amount, code: 'LEDGER_SETTLEMENT_TAX_UNBALANCED'});
  const baseAmount = split?.net ?? amount;
  const lines = [
    {
      account: expense,
      direction: 'debit',
      debit: baseAmount,
      credit: 0,
      amount: baseAmount,
      currency,
      memo
    },
    ...(split ? [{account: split.controlAccount, direction:'debit', debit:split.vat, credit:0, amount:split.vat, currency, memo}] : []),
    {
      account: ownerFunds,
      direction: 'credit',
      debit: 0,
      credit: amount,
      amount,
      currency,
      memo
    }
  ];

  return {
    source_type: 'document_settlement',
    source_id: document.id,
    journal_date: journalDate,
    currency,
    status: 'posted',
    memo,
    direction: 'spend',
    amount,
    accounts: lines.map(line=>line.account),
    lines
  };
};

// FI-3 slice S (docs/design-donna-finland-fi3-alv-split.md) — normalize + VERIFY
// a caller-supplied ALV split against the journal's gross amount. The builders
// never recompute a split (KEEP: verify, don't shade); an unbalanced one refuses.
const verifiedAlvSplit = ({ alvSplit, gross, code }) => {
  if (!alvSplit) return null;
  const net = roundedMoney(alvSplit.net);
  const vat = roundedMoney(alvSplit.vat);
  if (!(net > 0) || !(vat > 0) || roundedMoney(net + vat) !== roundedMoney(gross)) {
    const error = new Error(`ALV split does not foot: net ${net} + vat ${vat} != gross ${roundedMoney(gross)}.`);
    error.code = code;
    throw error;
  }
  const control = alvSplit.controlAccount || {};
  return {
    net,
    vat,
    controlAccount: {
      role: alvSplit.role || 'alv_control',
      code: trim(control.code),
      name: trim(control.name),
      type: trim(control.account_type || control.type) || 'liability',
      normal_balance: trim(control.normal_balance).toLowerCase() === 'debit' ? 'debit' : 'credit',
      // The ALV code stays on the BASE line only (D-FI3-S3) — a code on a
      // control account is the D-FI3-A5 blocker, never something we post.
      tax_type: 'NONE',
      xero_account_id: '',
      label: accountLabel({ code: trim(control.code), name: trim(control.name) })
    }
  };
};

// RT-21f (docs/prompt-2026-09-08-rt-21-koontilasku-settlement-rows.md §2,
// §4 RT-21f; RT-18 §4 (ii)) — normalize + VERIFY a caller-supplied settlement
// split against the bank amount. A processor settlement row (a koontilasku
// row: gross card sales, the processor's fee, the NET that reached the bank)
// posts Dr bank NET · Dr expense.platform_fees fee (tax NONE — a VAT-free
// financial service, AVL 41 §) · Cr the coded revenue GROSS (carrying the
// coding's tax code; with an ALV split the gross is the VAT base). The builder
// never recomputes a row (KEEP: verify, don't shade): gross − fee − fee_tax
// must equal the bank amount to the cent, or it refuses by name.
const verifiedSettlementSplit = ({ settlementSplit, bankAmount, direction }) => {
  if (!settlementSplit) return null;
  if (direction !== 'receive') {
    const error = new Error('A settlement split applies to a money-in line only (the processor paid the firm).');
    error.code = 'LEDGER_SETTLEMENT_SPLIT_DIRECTION';
    throw error;
  }
  const gross = roundedMoney(settlementSplit.gross);
  const fee = roundedMoney(settlementSplit.fee ?? 0);
  const feeTax = roundedMoney(settlementSplit.fee_tax ?? 0);
  const net = roundedMoney(gross - fee - feeTax);
  if (!(gross > 0) || fee < 0 || feeTax < 0 || net !== roundedMoney(bankAmount)) {
    const error = new Error(`Settlement split does not foot: gross ${gross} − fee ${fee} − fee tax ${feeTax} = ${net} != bank ${roundedMoney(bankAmount)}.`);
    error.code = 'LEDGER_SETTLEMENT_SPLIT_UNBALANCED';
    throw error;
  }
  const feeDeduction = roundedMoney(fee + feeTax);
  const feeIn = settlementSplit.feeAccount || {};
  if (feeDeduction > 0 && !trim(feeIn.code) && !trim(feeIn.name)) {
    const error = new Error('A settlement split with a fee needs the fee account (role expense.platform_fees).');
    error.code = 'LEDGER_SETTLEMENT_SPLIT_FEE_ACCOUNT_MISSING';
    throw error;
  }
  return {
    gross,
    fee,
    fee_tax: feeTax,
    net,
    fee_deduction: feeDeduction,
    feeSplit: verifiedAlvSplit({ alvSplit: settlementSplit.fee_alv_split, gross: feeDeduction, code: 'LEDGER_SETTLEMENT_FEE_TAX_UNBALANCED' }),
    feeAccount: feeDeduction > 0
      ? {
          role: feeIn.role || 'expense.platform_fees',
          code: trim(feeIn.code),
          name: trim(feeIn.name),
          type: trim(feeIn.account_type || feeIn.type) || 'expense',
          normal_balance: 'debit',
          // The fee is VAT-free (a financial service); no code on the fee leg.
          tax_type: settlementSplit.fee_alv_split?.code || 'NONE',
          xero_account_id: trim(feeIn.xero_account_id),
          label: accountLabel({ code: trim(feeIn.code), name: trim(feeIn.name) })
        }
      : null,
    row: settlementSplit.row && typeof settlementSplit.row === 'object' ? { ...settlementSplit.row } : null
  };
};

export const buildLedgerJournalForTransaction = ({
  transaction = {},
  coding = {},
  bankAccount = {},
  alvSplit = null,
  // RT-21f: { gross, fee, fee_tax, feeAccount, row } from the matched
  // settlement row (db/ledger.js resolveSettlementRowSplit). null ⇒ the
  // two-line (or ALV three-line) journal, byte-identical.
  settlementSplit = null,
  documentAllocation = null
} = {}) => {
  const direction = ledgerTransactionDirection(transaction);
  const amount = ledgerTransactionAmount(transaction);
  if (!['spend', 'receive'].includes(direction)) {
    const error = new Error('Ledger posting requires a money-in or money-out transaction.');
    error.code = 'LEDGER_INVALID_TRANSACTION_DIRECTION';
    throw error;
  }
  if (!(amount > 0)) {
    const error = new Error('Ledger posting amount must be greater than zero.');
    error.code = 'LEDGER_INVALID_TRANSACTION_AMOUNT';
    throw error;
  }

  const journalDate = ledgerDateOnly(transaction.date || transaction.transaction_date || transaction.transactionDate);
  if (!journalDate) {
    const error = new Error('Ledger posting requires a transaction date.');
    error.code = 'LEDGER_INVALID_TRANSACTION_DATE';
    throw error;
  }

  const counterpartyAccount = ledgerAccountFromCoding(coding);
  const bankLedgerAccount = ledgerAccountFromBank(bankAccount);
  if (!counterpartyAccount.code && !counterpartyAccount.name) {
    const error = new Error('Ledger posting requires a coded account.');
    error.code = 'LEDGER_MISSING_COUNTERPARTY_ACCOUNT';
    throw error;
  }
  if (!bankLedgerAccount.code && !bankLedgerAccount.xero_account_id && !bankLedgerAccount.name) {
    const error = new Error('Ledger posting requires a bank account.');
    error.code = 'LEDGER_MISSING_BANK_ACCOUNT';
    throw error;
  }

  // A canonical correction to unknown cannot revive a bank/profile candidate.
  // Book currency never denominates an unconverted source amount.
  const currency = requireLedgerCurrency(
    Object.hasOwn(transaction, 'account_currency') ? transaction.account_currency
      : Object.hasOwn(transaction, 'currency') ? transaction.currency : bankAccount.currency,
    'bank transaction'
  );
  if (transaction.account_currency && transaction.currency) {
    assertLedgerCurrencyMatches(transaction.currency, currency, 'bank transaction');
  }
  if (bankAccount.currency) assertLedgerCurrencyMatches(bankAccount.currency, currency, 'bank account');
  const memo = trim(transaction.description || transaction.cleaned_description || transaction.raw_description || transaction.id || 'Donna ledger transaction');
  const debit = (account, value = amount, lineMemo = memo) => ({
    account,
    direction: 'debit',
    debit: value,
    credit: 0,
    amount: value,
    currency,
    memo: lineMemo
  });
  const credit = (account, value = amount, lineMemo = memo) => ({
    account,
    direction: 'credit',
    debit: 0,
    credit: value,
    amount: value,
    currency,
    memo: lineMemo
  });

  // RT-21f: a verified settlement split books the bank at the row's NET, the
  // processor fee on its own expense leg, and the coded revenue at the GROSS —
  // which is then the base an ALV split is verified against (the VAT is on
  // the sales, not on what the bank received).
  const settlement = verifiedSettlementSplit({ settlementSplit, bankAmount: amount, direction });
  const grossBase = settlement ? settlement.gross : amount;

  // FI-3 slice S (D-FI3-S1): a verified split books the NET base on the coded
  // counterparty line and the VAT on the role-marked control leg; the bank leg
  // stays gross. No split → the two-line journal, byte-identical.
  const split = documentAllocation ? null : verifiedAlvSplit({ alvSplit, gross: grossBase, code: 'LEDGER_ALV_SPLIT_UNBALANCED' });
  const feeMemo = settlement?.row?.label ? `${memo} · fee on ${settlement.row.label}` : `${memo} · processor fee`;
  let lines = direction === 'spend'
    ? (split
      ? [debit(counterpartyAccount, split.net), debit(split.controlAccount, split.vat), credit(bankLedgerAccount)]
      : [debit(counterpartyAccount), credit(bankLedgerAccount)])
    : settlement
      ? [
          debit(bankLedgerAccount, amount),
          ...(settlement.feeAccount ? settlement.feeSplit
            ? [debit(settlement.feeAccount, settlement.feeSplit.net, feeMemo), debit(settlement.feeSplit.controlAccount, settlement.feeSplit.vat, feeMemo)]
            : [debit(settlement.feeAccount, settlement.fee_deduction, feeMemo)] : []),
          ...(split
            ? [credit(counterpartyAccount, split.net), credit(split.controlAccount, split.vat)]
            : [credit(counterpartyAccount, settlement.gross)])
        ]
      : (split
        ? [debit(bankLedgerAccount), credit(counterpartyAccount, split.net), credit(split.controlAccount, split.vat)]
        : [debit(bankLedgerAccount), credit(counterpartyAccount)]);

  let allocationAccounts = null;
  if (documentAllocation) {
    const entries = documentAllocation.lines;
    if (split || settlement || !Array.isArray(entries) || entries.length < 1
      || entries.some(item => !Number.isFinite(item.amount) || item.amount <= 0)
      || entries.reduce((sum, item) => sum + Math.round(item.amount * 100), 0) !== Math.round(amount * 100)) {
      throw Object.assign(new Error('Document allocation must foot to the bank payment without another tax or settlement split.'), { code: 'LEDGER_DOCUMENT_ALLOCATION_INVALID' });
    }
    allocationAccounts = entries.map(item => ledgerAccountFromCoding(item.coding));
    if (allocationAccounts.some(account => !account.name && !account.code)) throw Object.assign(new Error('An allocation account is missing.'), { code: 'LEDGER_DOCUMENT_ALLOCATION_INVALID' });
    const postComponent = direction === 'spend' ? debit : credit;
    lines = entries.flatMap((item, index) => {
      const componentSplit = verifiedAlvSplit({ alvSplit: item.tax_split, gross: item.amount, code: 'LEDGER_DOCUMENT_ALLOCATION_INVALID' });
      const componentMemo = `${memo} · ${item.description}`;
      if (!componentSplit) return [postComponent(allocationAccounts[index], item.amount, componentMemo)];
      allocationAccounts.push(componentSplit.controlAccount);
      return [postComponent(allocationAccounts[index], componentSplit.net, componentMemo),
        postComponent(componentSplit.controlAccount, componentSplit.vat, componentMemo)];
    });
    if (direction === 'spend') lines.push(credit(bankLedgerAccount));
    else lines.unshift(debit(bankLedgerAccount));
  }

  return {
    source_type: 'transaction',
    source_id: transaction.id || transaction.transaction_id || null,
    journal_date: journalDate,
    currency,
    status: 'posted',
    memo,
    direction,
    amount,
    accounts: [
      ...(allocationAccounts || [counterpartyAccount]),
      ...(split ? [split.controlAccount] : []),
      ...(settlement?.feeAccount ? [settlement.feeAccount] : []),
      ...(settlement?.feeSplit ? [settlement.feeSplit.controlAccount] : []),
      bankLedgerAccount
    ],
    lines,
    ...(settlement
      ? { settlement_split: { gross: settlement.gross, fee: settlement.fee, fee_tax: settlement.fee_tax, net: settlement.net, row: settlement.row } }
      : {})
  };
};

// FI-6 Half A — the opening-balance journal (avaava tase) for a SWITCHER adopting
// Donna mid-life. A greenfield client needs none (inception == the tilikausi start,
// nothing to carry forward — the DB writer refuses that case). Pure builder:
// balanced-by-construction, dated at the tilikausi start, source_type
// 'opening_balance', source_id = <fiscal_year_id> (ONE avaava tase per tilikausi —
// the natural-key upsert makes a re-seed idempotent). It becomes the tilikausi's
// first voucher via the FI-5 tositenumero allocation in __writeLedgerJournalRows;
// this builder only shapes + balances the journal, it never touches the DB.
//
// `openingLines` is the per-account opening position — from a strong-model trial-
// balance extraction (the trust-the-strong-LLM default, decision D5) OR the bank-
// only degenerate pair (Dr Bank / Cr Oma pääoma). Each entry: { account, debit,
// credit }, exactly one side positive. The builder REFUSES an unbalanced seed
// (KEEP-layer: sum(debit) == sum(credit)); it does not guess the counter-account.
// Full design: docs/design-donna-finland-opening-balances.md §1.
export const buildOpeningBalanceJournal = ({
  fiscalYear = {},
  openingLines = [],
  currency = 'EUR',
  memo = null
} = {}) => {
  const startsOn = ledgerDateOnly(fiscalYear.starts_on);
  if (!startsOn) {
    const error = new Error('Opening balance requires the tilikausi start date.');
    error.code = 'OPENING_BALANCE_MISSING_TILIKAUSI_START';
    throw error;
  }
  const sourceId = trim(fiscalYear.id);
  if (!sourceId) {
    const error = new Error('Opening balance requires the tilikausi (fiscal_years) id.');
    error.code = 'OPENING_BALANCE_MISSING_TILIKAUSI_ID';
    throw error;
  }
  if (!Array.isArray(openingLines) || openingLines.length === 0) {
    const error = new Error('Opening balance requires at least one opening line.');
    error.code = 'OPENING_BALANCE_NO_LINES';
    throw error;
  }

  const journalCurrency = trim(currency || 'EUR').toUpperCase();
  const journalMemo = trim(memo) || `Opening balance (avaava tase) — tilikausi ${trim(fiscalYear.label) || startsOn}`;

  const accounts = [];
  const lines = [];
  let totalDebit = 0;
  let totalCredit = 0;
  for (const raw of openingLines) {
    const account = raw.account || {};
    const code = trim(account.code);
    const name = trim(account.name || account.label || code);
    if (!code && !name) {
      const error = new Error('Opening balance line requires a coded account.');
      error.code = 'OPENING_BALANCE_MISSING_ACCOUNT';
      throw error;
    }
    const debit = roundedMoney(raw.debit);
    const credit = roundedMoney(raw.credit);
    if (debit < 0 || credit < 0) {
      const error = new Error('Opening balance amounts must be non-negative.');
      error.code = 'OPENING_BALANCE_NEGATIVE_AMOUNT';
      throw error;
    }
    // Exactly one side positive: a zero/zero or two-sided line is malformed.
    if ((debit > 0) === (credit > 0)) {
      const error = new Error('Each opening balance line must carry exactly one of debit or credit.');
      error.code = 'OPENING_BALANCE_LINE_NOT_ONE_SIDED';
      throw error;
    }
    const normalized = {
      role: account.role || 'opening_balance',
      code,
      name,
      type: trim(account.type) || 'unknown',
      normal_balance: trim(account.normal_balance).toLowerCase() === 'credit' ? 'credit' : 'debit',
      tax_type: trim(account.tax_type || 'NONE'),
      xero_account_id: trim(account.xero_account_id),
      canonical_role: account.canonical_role || null,
      label: account.label || accountLabel({ code, name })
    };
    accounts.push(normalized);
    lines.push({
      account: normalized,
      direction: debit > 0 ? 'debit' : 'credit',
      debit,
      credit,
      amount: debit > 0 ? debit : credit,
      currency: journalCurrency,
      memo: journalMemo
    });
    totalDebit = roundedMoney(totalDebit + debit);
    totalCredit = roundedMoney(totalCredit + credit);
  }

  // KEEP-layer: the avaava tase must foot. Arithmetic, not judgment — refuse a
  // seed that does not balance rather than silently ratifying a bad opening.
  if (Math.abs(roundedMoney(totalDebit - totalCredit)) >= 0.01) {
    const error = new Error(`Opening balance does not balance: debits ${totalDebit} vs credits ${totalCredit}.`);
    error.code = 'OPENING_BALANCE_UNBALANCED';
    throw error;
  }

  return {
    source_type: 'opening_balance',
    source_id: sourceId,
    journal_date: startsOn,
    currency: journalCurrency,
    status: 'posted',
    memo: journalMemo,
    direction: 'opening',
    amount: totalDebit,
    accounts,
    lines
  };
};

// ---------------------------------------------------------------------------------
// FI-10 send-half — the AR (myyntisaamiset) journal for an ISSUED sale invoice.
// ---------------------------------------------------------------------------------
// DR 1700 Myyntisaamiset (total) / CR 3000 Myynti (subtotal), dated at the invoice
// date, source-keyed sales_invoice/<invoiceNumber> so a re-post is idempotent in
// __writeLedgerJournalRows. KEEP-layer (refuse, never shade):
//   • non-ALV only (D-FI10-S2): alvTotal > 0 refuses until FI-2/FI-3 wire the
//     ALV-payable side in Phase 2 — never a silent all-net post of a VAT invoice;
//   • the journal balances by construction (total == subtotal when alvTotal == 0)
//     and is re-asserted;
//   • a positive total is required (a zero/negative invoice is a category error —
//     credit notes are a separate artifact, not a negative sale).
// Accrual-only is enforced by the WRITER (basis is a client attribute, not an
// invoice attribute). Design: docs/design-donna-finland-fi10-send-half.md.
//
// The tax split is JURISDICTION-NEUTRAL (2026-07-27). The per-rate code map and
// the tax control account are INJECTED by the caller as `taxPosting`, the same
// idiom `receivableAccount`/`revenueAccount` already use — this file holds the
// arithmetic and the refusals, never a market's statutory vocabulary:
//
//   taxPosting = {
//     outputCodeForRate: (rate) => string | null,   // null ⇒ REFUSE, never guess
//     control: { role, account: { code, name, account_type, normal_balance } }
//   }
//
// Required only on the split branch (`invoice.alvExempt === false`); the
// non-registered branch never reads it. FI injects its frozen ALV_SPLIT_CONTROL
// + alvOutputCodeForRate and is byte-identical to the pre-injection behaviour;
// GB injects gb/vatCodes.js plus a control account resolved from the client's
// own chart by canonical role (the UK ships no statutory chart to hardcode).
export const buildSalesInvoiceJournal = ({
  invoice = {},
  currency = 'EUR',
  memo = null,
  receivableAccount = SALES_INVOICE_RECEIVABLE_ACCOUNT,
  revenueAccount = { code: '3000', name: 'Myynti', type: 'revenue', normal_balance: 'credit' },
  taxPosting = null
} = {}) => {
  const invoiceNumber = trim(invoice.invoiceNumber);
  if (!invoiceNumber) {
    const error = new Error('Sales-invoice journal requires the invoice number.');
    error.code = 'SALES_INVOICE_MISSING_NUMBER';
    throw error;
  }
  const journalDate = ledgerDateOnly(invoice.date);
  if (!journalDate) {
    const error = new Error('Sales-invoice journal requires the invoice date.');
    error.code = 'SALES_INVOICE_MISSING_DATE';
    throw error;
  }
  const subtotal = roundedMoney(invoice.subtotal);
  const alvTotal = roundedMoney(invoice.alvTotal);
  const total = roundedMoney(invoice.total);
  const journalCurrency = trim(currency || invoice.currency || 'EUR').toUpperCase();
  const buyerName = trim(invoice.buyer?.name || invoice.buyerName);
  const journalMemo = trim(memo) || `Myyntilasku ${invoiceNumber}${buyerName ? ` — ${buyerName}` : ''}`;

  const normalize = (account, role) => ({
    role,
    code: trim(account.code),
    name: trim(account.name || account.code),
    type: trim(account.type) || 'unknown',
    normal_balance: trim(account.normal_balance).toLowerCase() === 'credit' ? 'credit' : 'debit',
    tax_type: trim(account.tax_type || 'NONE'),
    xero_account_id: trim(account.xero_account_id),
    canonical_role: account.canonical_role || null,
    label: account.label || accountLabel({ code: account.code, name: account.name })
  });
  const receivable = normalize(receivableAccount, 'sales_invoice_receivable');

  // FI-13 13.4 follow-up — the fork. A NON-registered sale (alvExempt true, or
  // the field absent on a legacy/pre-ALV invoice) keeps the EXACT prior single-
  // net post, byte-identical, and still refuses a stray VAT total. An ALV-
  // registered invoice (alvExempt === false — produced only by the gated
  // issuance path) posts the split.
  const alvRegistered = invoice.alvExempt === false;

  if (!alvRegistered) {
    if (alvTotal !== 0) {
      const error = new Error('A non-ALV-registered sales invoice cannot carry a VAT total.');
      error.code = 'SALES_INVOICE_ALV_UNSUPPORTED';
      throw error;
    }
    if (!(total > 0)) {
      const error = new Error('Sales-invoice journal requires a positive invoice total.');
      error.code = 'SALES_INVOICE_NON_POSITIVE_TOTAL';
      throw error;
    }
    // Non-ALV arithmetic: total must equal subtotal. Refuse a model that does not foot.
    if (total !== subtotal) {
      const error = new Error(`Sales-invoice totals do not foot: total ${total} vs subtotal ${subtotal} with no VAT.`);
      error.code = 'SALES_INVOICE_TOTALS_MISMATCH';
      throw error;
    }
    const revenue = normalize(revenueAccount, 'sales_invoice_revenue');
    const lines = [
      { account: receivable, direction: 'debit', debit: total, credit: 0, amount: total, currency: journalCurrency, memo: journalMemo },
      { account: revenue, direction: 'credit', debit: 0, credit: subtotal, amount: subtotal, currency: journalCurrency, memo: journalMemo }
    ];
    // Belt-and-braces: re-assert the balance the arithmetic above guarantees.
    if (roundedMoney(lines[0].debit) !== roundedMoney(lines[1].credit)) {
      const error = new Error('Sales-invoice journal does not balance.');
      error.code = 'SALES_INVOICE_UNBALANCED';
      throw error;
    }
    return {
      source_type: 'sales_invoice',
      source_id: invoiceNumber,
      journal_date: journalDate,
      currency: journalCurrency,
      status: 'posted',
      memo: journalMemo,
      direction: 'receive',
      amount: total,
      accounts: [receivable, revenue],
      lines
    };
  }

  // --- Tax-registered split (D-FI3-S3 shape, jurisdiction-neutral) -----------
  // DR receivable (gross total) / CR revenue net PER RATE — each revenue leg
  // carries its rate's OUTPUT tax code so a return engine's base-code walk
  // (basePerCode) sees the sale — / CR the tax control account for the whole
  // tax, role-marked by the injected profile (a return engine's control
  // cross-check keys on the role; the code stays 'NONE' so the D-FI3-A5 "no tax
  // code on a control account" invariant holds). Balances by construction from
  // the invoice's OWN rounded figures (the builder guarantees subtotal+tax==total).
  //
  // The profile is required HERE and nowhere else. Refusing it by name beats a
  // TypeError on `taxPosting.outputCodeForRate` — a caller that reaches the
  // split branch without one has a wiring bug, and the outbound finalize
  // receipts a named skip rather than an `error:unknown`. The CODE MAP is
  // required for every registered invoice (even an all-zero-rated one still
  // codes its revenue legs); the CONTROL ACCOUNT is checked further down, where
  // it is actually used, so an all-zero-rated invoice is not refused for want of
  // an account no line will ever touch.
  if (!taxPosting || typeof taxPosting.outputCodeForRate !== 'function') {
    const error = new Error('A tax-registered sales-invoice journal requires a taxPosting profile with a per-rate output-code map.');
    error.code = 'SALES_INVOICE_TAX_POSTING_UNAVAILABLE';
    throw error;
  }
  if (!(total > 0)) {
    const error = new Error('Sales-invoice journal requires a positive invoice total.');
    error.code = 'SALES_INVOICE_NON_POSITIVE_TOTAL';
    throw error;
  }
  if (roundedMoney(subtotal + alvTotal) !== total) {
    const error = new Error(`Sales-invoice ALV totals do not foot: subtotal ${subtotal} + VAT ${alvTotal} != total ${total}.`);
    error.code = 'SALES_INVOICE_TOTALS_MISMATCH';
    throw error;
  }
  const invoiceLines = Array.isArray(invoice.lines) ? invoice.lines : [];
  if (!invoiceLines.length) {
    const error = new Error('An ALV sales-invoice journal requires the invoice lines to code revenue per rate.');
    error.code = 'SALES_INVOICE_ALV_NO_LINES';
    throw error;
  }

  // Group the invoice's own rounded per-line net + VAT by ALV rate, ascending
  // (deterministic). One coded revenue leg per rate; the summed VAT is the 2939 leg.
  const byRate = new Map();
  for (const l of invoiceLines) {
    const rate = roundedMoney(l.alvRate || 0);
    const cur = byRate.get(rate) || { rate, net: 0, vat: 0 };
    cur.net = roundedMoney(cur.net + roundedMoney(l.net));
    cur.vat = roundedMoney(cur.vat + roundedMoney(l.alv || 0));
    byRate.set(rate, cur);
  }
  const groups = [...byRate.values()].sort((a, b) => a.rate - b.rate);

  const revenueLines = [];
  const revenueAccounts = [];
  let netSum = 0;
  let vatSum = 0;
  for (const g of groups) {
    const code = taxPosting.outputCodeForRate(g.rate);
    if (!code) {
      const error = new Error(`No output tax code maps to rate ${g.rate} % — refusing to guess a code for a sales-invoice revenue leg.`);
      error.code = 'SALES_INVOICE_ALV_RATE_UNMAPPED';
      throw error;
    }
    const net = roundedMoney(g.net);
    // A rate group whose net rounds to 0 contributes no leg (and no VAT).
    if (!(net > 0)) continue;
    const acct = normalize({ ...revenueAccount, tax_type: code }, 'sales_invoice_revenue');
    revenueAccounts.push(acct);
    revenueLines.push({ account: acct, direction: 'credit', debit: 0, credit: net, amount: net, currency: journalCurrency, memo: journalMemo });
    netSum = roundedMoney(netSum + net);
    vatSum = roundedMoney(vatSum + roundedMoney(g.vat));
  }
  if (!revenueLines.length) {
    const error = new Error('An ALV sales-invoice journal produced no revenue legs.');
    error.code = 'SALES_INVOICE_ALV_NO_REVENUE';
    throw error;
  }
  if (netSum !== subtotal) {
    const error = new Error(`Sales-invoice ALV per-rate net legs (${netSum}) do not sum to the invoice subtotal (${subtotal}).`);
    error.code = 'SALES_INVOICE_ALV_NET_MISMATCH';
    throw error;
  }
  if (vatSum !== alvTotal) {
    const error = new Error(`Sales-invoice ALV per-rate VAT (${vatSum}) does not sum to the invoice VAT total (${alvTotal}).`);
    error.code = 'SALES_INVOICE_ALV_VAT_MISMATCH';
    throw error;
  }

  const lines = [
    { account: receivable, direction: 'debit', debit: total, credit: 0, amount: total, currency: journalCurrency, memo: journalMemo },
    ...revenueLines
  ];
  const accounts = [receivable, ...revenueAccounts];

  // The output tax control leg — only when tax exists (an all-zero-rated sale
  // posts net-only, its zero-rated legs still coded by the profile's zero code).
  if (alvTotal > 0) {
    const control = taxPosting.control;
    if (!control?.account?.code || !control?.role) {
      const error = new Error('A sales-invoice journal carrying tax requires the taxPosting profile\'s tax control account (code + line role).');
      error.code = 'SALES_INVOICE_TAX_POSTING_UNAVAILABLE';
      throw error;
    }
    const vatAccount = normalize({
      code: control.account.code,
      name: control.account.name,
      type: control.account.account_type,
      normal_balance: control.account.normal_balance,
      tax_type: 'NONE'
    }, control.role);
    lines.push({ account: vatAccount, direction: 'credit', debit: 0, credit: alvTotal, amount: alvTotal, currency: journalCurrency, memo: journalMemo });
    accounts.push(vatAccount);
  }

  const creditSum = roundedMoney(lines.slice(1).reduce((s, l) => s + roundedMoney(l.credit), 0));
  if (roundedMoney(total) !== creditSum) {
    const error = new Error(`ALV sales-invoice journal does not balance: DR ${total} vs CR ${creditSum}.`);
    error.code = 'SALES_INVOICE_UNBALANCED';
    throw error;
  }

  return {
    source_type: 'sales_invoice',
    source_id: invoiceNumber,
    journal_date: journalDate,
    currency: journalCurrency,
    status: 'posted',
    memo: journalMemo,
    direction: 'receive',
    amount: total,
    accounts,
    lines
  };
};

// ---------------------------------------------------------------------------------
// FI-15 G-8 — the AR-REVERSAL journal for an issued credit note (hyvityslasku).
// ---------------------------------------------------------------------------------
// The exact mirror of buildSalesInvoiceJournal: DR 3000 Myynti (the credited
// revenue) / CR 1700 Myyntisaamiset (the receivable given back), dated at the
// credit-note date, source-keyed credit_note/<creditNoteNumber> so a re-post is
// idempotent. The credit-note MODEL carries positive totals (D-G8-4 — sign is
// presentation); the reversal lives in the DR/CR direction, never in a negative
// amount. KEEP-layer (refuse, never shade):
//   • the credit note must reference its original invoice (an unanchored
//     hyvityslasku cannot post);
//   • non-ALV only (the D-FI10-S2 boundary, unchanged until Phase 2);
//   • a positive credit total is required and totals must foot;
//   • the journal balances by construction and is re-asserted.
// Accrual-only and the credit CAP (sum of credits <= original total) are
// enforced by the WRITER (basis is a client attribute; the cap needs the
// sibling rows). Design: docs/design-donna-finland-fi15-g8-credit-notes.md.
export const buildCreditNoteJournal = ({
  creditNote = {},
  currency = 'EUR',
  memo = null,
  receivableAccount = SALES_INVOICE_RECEIVABLE_ACCOUNT,
  revenueAccount = { code: '3000', name: 'Myynti', type: 'revenue', normal_balance: 'credit' }
} = {}) => {
  const creditNoteNumber = trim(creditNote.invoiceNumber);
  if (!creditNoteNumber) {
    const error = new Error('Credit-note journal requires the credit-note number.');
    error.code = 'CREDIT_NOTE_MISSING_NUMBER';
    throw error;
  }
  const originalNumber = trim(creditNote.creditsInvoiceNumber);
  if (!originalNumber) {
    const error = new Error('Credit-note journal requires the original invoice number the note credits.');
    error.code = 'CREDIT_NOTE_MISSING_ORIGINAL';
    throw error;
  }
  const journalDate = ledgerDateOnly(creditNote.date);
  if (!journalDate) {
    const error = new Error('Credit-note journal requires the credit-note date.');
    error.code = 'CREDIT_NOTE_MISSING_DATE';
    throw error;
  }
  const subtotal = roundedMoney(creditNote.subtotal);
  const alvTotal = roundedMoney(creditNote.alvTotal);
  const total = roundedMoney(creditNote.total);
  if (alvTotal !== 0) {
    const error = new Error('ALV-registered credit notes are not wired yet (Phase 2): a credit note with a VAT total cannot post.');
    error.code = 'CREDIT_NOTE_ALV_UNSUPPORTED';
    throw error;
  }
  if (!(total > 0)) {
    const error = new Error('Credit-note journal requires a positive credit total (the model stays positive; the reversal is the DR/CR direction).');
    error.code = 'CREDIT_NOTE_NON_POSITIVE_TOTAL';
    throw error;
  }
  if (total !== subtotal) {
    const error = new Error(`Credit-note totals do not foot: total ${total} vs subtotal ${subtotal} with no VAT.`);
    error.code = 'CREDIT_NOTE_TOTALS_MISMATCH';
    throw error;
  }

  const journalCurrency = trim(currency || creditNote.currency || 'EUR').toUpperCase();
  const buyerName = trim(creditNote.buyer?.name || creditNote.buyerName);
  const journalMemo = trim(memo) || `Hyvityslasku ${creditNoteNumber} (lasku ${originalNumber})${buyerName ? ` — ${buyerName}` : ''}`;

  const normalize = (account, role) => ({
    role,
    code: trim(account.code),
    name: trim(account.name || account.code),
    type: trim(account.type) || 'unknown',
    normal_balance: trim(account.normal_balance).toLowerCase() === 'credit' ? 'credit' : 'debit',
    tax_type: trim(account.tax_type || 'NONE'),
    xero_account_id: trim(account.xero_account_id),
    canonical_role: account.canonical_role || null,
    label: account.label || accountLabel({ code: account.code, name: account.name })
  });
  const revenue = normalize(revenueAccount, 'credit_note_revenue');
  const receivable = normalize(receivableAccount, 'credit_note_receivable');

  const lines = [
    { account: revenue, direction: 'debit', debit: subtotal, credit: 0, amount: subtotal, currency: journalCurrency, memo: journalMemo },
    { account: receivable, direction: 'credit', debit: 0, credit: total, amount: total, currency: journalCurrency, memo: journalMemo }
  ];
  if (roundedMoney(lines[0].debit) !== roundedMoney(lines[1].credit)) {
    const error = new Error('Credit-note journal does not balance.');
    error.code = 'CREDIT_NOTE_UNBALANCED';
    throw error;
  }

  return {
    source_type: 'credit_note',
    source_id: creditNoteNumber,
    journal_date: journalDate,
    currency: journalCurrency,
    status: 'posted',
    memo: journalMemo,
    direction: 'refund',
    amount: total,
    accounts: [revenue, receivable],
    lines
  };
};

// ---------------------------------------------------------------------------------
// FI-9 (P) — the AP (ostovelat) accrual journal for a received supplier bill.
// ---------------------------------------------------------------------------------
// DR <expense account — the coder's persisted verdict, resolved by the caller> /
// CR 2870 Ostovelat, dated at the invoice date, source-keyed
// supplier_bill/<documentId> so a re-post is idempotent in
// __writeLedgerJournalRows (the document id is the natural key — ONE AP journal
// per bill document; vendor reference numbers can collide across suppliers).
// KEEP-layer (refuse, never shade):
//   • the ALV fork (D-FI9-3) is deliberately ASYMMETRIC to the AR side: a
//     NON-ALV buyer posts GROSS — no input-VAT deduction exists for them, so the
//     statutorily correct expense is the gross total even when the supplier's
//     invoice carries VAT (the AR side's alvTotal refusal is about VAT we would
//     be CHARGING; it does not transfer to VAT we are being charged). An
//     ALV-CODING buyer REFUSES until FI-3's net-expense + ALV-receivable
//     split-posting convention mints — posting gross would silently forfeit the
//     input-VAT deduction, and wiring the split here ad hoc would fork the
//     convention FI-3 deliberately hasn't minted;
//   • a positive gross total is required (a credit note is a separate artifact,
//     not a negative bill);
//   • the journal balances by construction (one debit + one credit of the same
//     gross amount) and is re-asserted.
// Accrual-only is enforced by the WRITER (basis is a client attribute, not a
// bill attribute), as is the coding-verdict gate (D-FI9-2: the DR side is the
// coder's persisted verdict, never a guess at receive time). Design:
// docs/design-donna-finland-fi9-receive-and-ap-post.md §P.
// FI-9 trigger wiring (D-FI9-P1): the ONE payables account both legs share —
// the AP journal's CR side (below) and the settlement leg's swapped DR side
// (commitPreparedLedgerPosting in firmDb.js) read this same constant, so the
// two journals can never drift onto different payables accounts.
export const SUPPLIER_BILL_PAYABLES_ACCOUNT = Object.freeze({
  code: '2870',
  name: 'Ostovelat',
  type: 'liability',
  normal_balance: 'credit'
});

// F-G8-1 (D-AR-3): the ONE receivables account all three AR legs share — the
// issuance journal's DR side (buildSalesInvoiceJournal), the credit-note
// journal's CR side (buildCreditNoteJournal), and the AR settlement leg's
// swapped CR side (commitPreparedLedgerPosting in firmDb.js) — the exact
// mirror of SUPPLIER_BILL_PAYABLES_ACCOUNT above, so the legs can never drift
// onto different receivable accounts.
// Design: docs/design-donna-finland-ar-settlement-posting.md.
export const SALES_INVOICE_RECEIVABLE_ACCOUNT = Object.freeze({
  code: '1700',
  name: 'Myyntisaamiset',
  type: 'receivable',
  normal_balance: 'debit'
});

export const buildSupplierBillJournal = ({
  bill = {},
  expenseAccount = {},
  payablesAccount = SUPPLIER_BILL_PAYABLES_ACCOUNT,
  currency = 'EUR',
  memo = null,
  alvSplit = null
} = {}) => {
  const documentId = trim(bill.documentId || bill.document_id || bill.id);
  if (!documentId) {
    const error = new Error('Supplier-bill journal requires the bill document id.');
    error.code = 'SUPPLIER_BILL_MISSING_DOCUMENT_ID';
    throw error;
  }
  const journalDate = ledgerDateOnly(bill.date || bill.document_date);
  if (!journalDate) {
    const error = new Error('Supplier-bill journal requires the invoice date.');
    error.code = 'SUPPLIER_BILL_MISSING_DATE';
    throw error;
  }
  // FI-3 slice S (D-FI3-S4) retires the D-FI9-3 refusal: an ALV-coding
  // client's bill now posts SPLIT — DR expense net + DR 2940 vat / CR 2870
  // gross — with the split computed (and stated-VAT cross-checked) by the
  // WRITER; this builder only VERIFIES it. A non-ALV buyer still posts gross
  // unsplit (no deduction right exists for them, D-FI9-3's other half).
  const total = roundedMoney(bill.total ?? bill.total_amount);
  if (!(total > 0)) {
    const error = new Error('Supplier-bill journal requires a positive gross total.');
    error.code = 'SUPPLIER_BILL_NON_POSITIVE_TOTAL';
    throw error;
  }

  const normalize = (account, role, fallbackNormalBalance) => {
    const code = trim(account.code || account.account_code);
    const name = trim(account.name || account.account_name || code);
    return {
      role,
      code,
      name,
      type: trim(account.type || account.account_type) || 'unknown',
      normal_balance: trim(account.normal_balance || fallbackNormalBalance).toLowerCase() === 'credit' ? 'credit' : 'debit',
      tax_type: trim(account.tax_type || 'NONE'),
      xero_account_id: trim(account.xero_account_id),
      canonical_role: account.canonical_role || null,
      label: account.label || accountLabel({ code, name })
    };
  };
  const expense = normalize(expenseAccount, 'supplier_bill_expense', 'debit');
  if (!expense.code && !expense.name) {
    const error = new Error('Supplier-bill journal requires the expense account from the coding verdict.');
    error.code = 'SUPPLIER_BILL_MISSING_EXPENSE_ACCOUNT';
    throw error;
  }
  const payables = normalize(payablesAccount, 'supplier_bill_payable', 'credit');

  const journalCurrency = trim(currency || bill.currency || 'EUR').toUpperCase();
  const vendorName = trim(bill.vendorName || bill.vendor_name);
  const reference = trim(bill.referenceNumber || bill.reference_number);
  const journalMemo = trim(memo) || `Ostolasku${reference ? ` ${reference}` : ''}${vendorName ? ` — ${vendorName}` : ''}`;

  const split = verifiedAlvSplit({ alvSplit, gross: total, code: 'SUPPLIER_BILL_ALV_SPLIT_UNBALANCED' });
  const line = (account, direction, value) => ({
    account,
    direction,
    debit: direction === 'debit' ? value : 0,
    credit: direction === 'credit' ? value : 0,
    amount: value,
    currency: journalCurrency,
    memo: journalMemo
  });
  const lines = split
    ? [line(expense, 'debit', split.net), line(split.controlAccount, 'debit', split.vat), line(payables, 'credit', total)]
    : [line(expense, 'debit', total), line(payables, 'credit', total)];
  // Belt-and-braces: re-assert the balance the construction guarantees.
  const debits = roundedMoney(lines.reduce((sum, l) => sum + l.debit, 0));
  const credits = roundedMoney(lines.reduce((sum, l) => sum + l.credit, 0));
  if (debits !== credits) {
    const error = new Error('Supplier-bill journal does not balance.');
    error.code = 'SUPPLIER_BILL_UNBALANCED';
    throw error;
  }

  return {
    source_type: 'supplier_bill',
    source_id: documentId,
    journal_date: journalDate,
    currency: journalCurrency,
    status: 'posted',
    memo: journalMemo,
    direction: 'pay',
    amount: total,
    accounts: split ? [expense, split.controlAccount, payables] : [expense, payables],
    lines
  };
};
