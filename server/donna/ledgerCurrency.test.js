import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLedgerJournalForTransaction, buildLedgerJournalForDocumentSettlement } from './ledger.js';

const transaction = { id: 'bank-line', date: '2026-09-05', money_out: 10 };
const coding = { account_code: 'EXP', account_name: 'Supplies' };
const bankAccount = { code: 'BANK', name: 'Business bank' };
const bankJournal = (row, bank = bankAccount) => buildLedgerJournalForTransaction({ transaction: { ...transaction, ...row }, coding, bankAccount: bank });

test('bank journals require amount denomination and preserve explicit unknown over candidate currencies', () => {
  for (const row of [{}, { ledger_currency: 'SGD' }, { currency: null }, { currency: ' ' },
    { currency: 'USD', account_currency: null }, { currency: 'dollars' },
    { currency: 'UNK' }, { currency: 'XXX' }, { currency: 'ABC' }]) {
    assert.throws(() => bankJournal(row), { code: 'LEDGER_CURRENCY_UNRESOLVED' });
  }
  assert.throws(() => bankJournal({ currency: null }, { ...bankAccount, currency: 'GBP' }), { code: 'LEDGER_CURRENCY_UNRESOLVED' });
  assert.throws(() => bankJournal({ currency: 'CAD', account_currency: 'GBP' }), { code: 'LEDGER_CURRENCY_CONFLICT' });
  assert.throws(() => bankJournal({ currency: 'CAD' }, { ...bankAccount, currency: 'GBP' }), { code: 'LEDGER_CURRENCY_CONFLICT' });
  for (const currency of ['SGD', 'EUR', 'GBP', 'AED', 'USD', 'AUD', 'CAD']) {
    const journal = bankJournal({ currency: currency.toLowerCase(), ledger_currency: 'GBP' });
    assert.equal(journal.currency, currency);
    assert.ok(journal.lines.every(line => line.currency === currency));
  }
  assert.equal(bankJournal({}, { ...bankAccount, currency: 'CAD' }).currency, 'CAD', 'an explicit account can denominate a legacy amount without a canonical field');
});

test('document settlement never derives denomination from entity or book context', () => {
  const build = currency => buildLedgerJournalForDocumentSettlement({
    document: { id: 'receipt', document_date: '2026-09-05', total_amount: 10,
      currency, jurisdiction: 'sg', ledger_currency: 'SGD' },
    expenseAccount: coding, ownerFundsAccount: { code: 'OWNER', name: 'Owner funds' }
  });
  for (const currency of [undefined, null, '', 'dollars']) {
    assert.throws(() => build(currency), { code: 'LEDGER_CURRENCY_UNRESOLVED' });
  }
  assert.equal(build('cad').currency, 'CAD');
});
