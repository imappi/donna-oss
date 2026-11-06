import { toLocalIsoDay, toUtcIsoDay } from './dates.js';

const dateOnly = (value = '') => {
  const text = String(value || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const match = text.match(/Date\((\d+)/);
  if (match) {
    // UTC on purpose: Xero's `/Date(ms)/` is the UTC-midnight epoch of the
    // day it names — the host zone must not move it.
    return toUtcIsoDay(new Date(Number(match[1])));
  }
  // Free text parses to host-local midnight, so the host-local day is the
  // day the text named (audit F-11).
  return toLocalIsoDay(new Date(text));
};

const money = (value = 0) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? Math.round(numeric * 100) / 100 : 0;
};

const lineTotal = (bankTransaction = {}) => {
  if (bankTransaction.Total != null) return money(bankTransaction.Total);
  return money((bankTransaction.LineItems || []).reduce((sum, line) => {
    const quantity = Number(line.Quantity || 1);
    const unitAmount = line.UnitAmount == null ? line.LineAmount : line.UnitAmount;
    return sum + money(unitAmount) * quantity;
  }, 0));
};

const accountRef = (bankTransaction = {}) => {
  const account = bankTransaction.BankAccount || bankTransaction.bankAccount || {};
  return {
    id: String(account.AccountID || account.accountId || account.ID || account.id || '').trim(),
    code: String(account.Code || account.code || '').trim(),
    name: String(account.Name || account.name || '').trim()
  };
};

const taxTypes = (bankTransaction = {}) =>
  Array.from(new Set((bankTransaction.LineItems || [])
    .map((line) => String(line.TaxType || line.taxType || '').trim())
    .filter(Boolean)))
    .sort();

const firstBankTransaction = (response = {}) =>
  response?.BankTransactions?.[0] ||
  response?.bankTransactions?.[0] ||
  response?.BankTransaction ||
  response?.bankTransaction ||
  null;

const accountMatches = (expected = {}, actual = {}) => {
  const expectedAccount = accountRef(expected);
  const actualAccount = accountRef(actual);
  if (expectedAccount.id && actualAccount.id) return expectedAccount.id === actualAccount.id;
  if (expectedAccount.code && actualAccount.code) return expectedAccount.code === actualAccount.code;
  return Boolean(actualAccount.id || actualAccount.code || actualAccount.name);
};

const sameTaxTypes = (expected = {}, actual = {}) => {
  const expectedTypes = taxTypes(expected);
  const actualTypes = taxTypes(actual);
  if (!expectedTypes.length) return true;
  return expectedTypes.length === actualTypes.length && expectedTypes.every((type, index) => type === actualTypes[index]);
};

export const buildXeroMirrorVerificationResult = ({
  transaction = {},
  expectedBankTransaction = {},
  xeroResponse = null,
  error = null
} = {}) => {
  const transactionId = transaction.id || transaction.transaction_id || null;
  const xeroBankTransactionId =
    transaction.xero_bank_transaction_id ||
    transaction.xeroBankTransactionId ||
    expectedBankTransaction.BankTransactionID ||
    expectedBankTransaction.bankTransactionId ||
    null;

  if (error) {
    return {
      transaction_id: transactionId,
      xero_bank_transaction_id: xeroBankTransactionId,
      status: 'mirror_error',
      severity: 'warning',
      error: error.message || String(error),
      checks: {}
    };
  }

  const actual = firstBankTransaction(xeroResponse || {});
  if (!actual) {
    return {
      transaction_id: transactionId,
      xero_bank_transaction_id: xeroBankTransactionId,
      status: 'mirror_missing',
      severity: 'warning',
      checks: {
        exists: false
      },
      expected: {
        date: dateOnly(expectedBankTransaction.Date || expectedBankTransaction.DateString || transaction.date),
        amount: lineTotal(expectedBankTransaction),
        account: accountRef(expectedBankTransaction),
        tax_types: taxTypes(expectedBankTransaction)
      }
    };
  }

  const expectedDate = dateOnly(expectedBankTransaction.Date || expectedBankTransaction.DateString || transaction.date);
  const actualDate = dateOnly(actual.DateString || actual.Date);
  const expectedAmount = lineTotal(expectedBankTransaction);
  const actualAmount = lineTotal(actual);
  const actualStatus = String(actual.Status || actual.status || '').trim().toUpperCase();
  const checks = {
    exists: true,
    date: !expectedDate || expectedDate === actualDate,
    amount: Math.abs(expectedAmount - actualAmount) < 0.01,
    account: accountMatches(expectedBankTransaction, actual),
    tax_type: sameTaxTypes(expectedBankTransaction, actual),
    status: actualStatus !== 'DELETED' && actualStatus !== 'VOIDED'
  };
  const ok = Object.values(checks).every(Boolean);

  return {
    transaction_id: transactionId,
    xero_bank_transaction_id: xeroBankTransactionId,
    status: ok ? 'mirror_ok' : 'mirror_drift',
    severity: 'warning',
    checks,
    expected: {
      date: expectedDate,
      amount: expectedAmount,
      account: accountRef(expectedBankTransaction),
      tax_types: taxTypes(expectedBankTransaction)
    },
    actual: {
      date: actualDate,
      amount: actualAmount,
      account: accountRef(actual),
      tax_types: taxTypes(actual),
      status: actualStatus || null
    }
  };
};
