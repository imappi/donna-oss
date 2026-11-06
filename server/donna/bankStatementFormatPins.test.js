import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__extractDocument } from './inngest/parseDocument.js';

// Synthetic, format-faithful Monzo CSV fixture; contains no real account data.
const MONZO = `Monzo Bank Limited account statement
Date,Time,Type,Name,Amount,Currency,Balance
30/07/2026,09:00:00,Card payment,Synthetic Cloud Host,-42.50,GBP,957.50
31/07/2026,12:00:00,Faster payment,Synthetic Customer,500.00,GBP,1457.50`;

// Synthetic, format-faithful Starling CSV fixture; contains no real account data.
const STARLING = `Starling Bank account statement
Date,Counter Party,Reference,Type,Amount (GBP),Balance (GBP)
01/08/2026,Synthetic Cloud Host,REF-1,CARD,-24.99,975.01
02/08/2026,Synthetic Customer,REF-2,FASTER PAYMENT,500.00,1475.01`;

// Synthetic, format-faithful HSBC CSV fixture; contains no real account data.
const HSBC = `HSBC UK Business Banking
Statement of account ending balance GBP 1140.00
Date,Type,Description,Paid out,Paid in,Balance
03/08/2026,DD,SYNTHETIC ENERGY LTD,60.00,,940.00
04/08/2026,CR,SYNTHETIC CLIENT RECEIPT,,200.00,1140.00`;

// Synthetic, format-faithful Lloyds CSV fixture; contains no real account data.
const LLOYDS = `Lloyds Bank statement
Statement of account ending balance GBP 1210.00
Transaction Date,Transaction Type,Transaction Description,Debit Amount,Credit Amount,Balance
05/08/2026,DEB,SYNTHETIC OFFICE SUPPLIES,40.00,,960.00
06/08/2026,FPI,SYNTHETIC CLIENT RECEIPT,,250.00,1210.00`;

// Synthetic, format-faithful NatWest CSV fixture; contains no real account data.
const NATWEST = `NatWest Bank statement
Statement of account ending balance GBP 1075.00
Date,Type,Description,Value,Balance
07/08/2026,POS,CARD PAYMENT SYNTHETIC CAFE,-25.00,975.00
08/08/2026,BGC,CREDIT SYNTHETIC CUSTOMER,100.00,1075.00`;

// Synthetic, format-faithful Nordea semicolon/decimal-comma fixture; contains no real account data.
const NORDEA = `Nordea account statement
Account statement ending balance EUR 1080,00
Booking date;Value date;Transaction;Amount;Balance
09.08.2026;09.08.2026;CARD PAYMENT SYNTHETIC HOST;-20,00;980,00
10.08.2026;10.08.2026;CREDIT SYNTHETIC CUSTOMER;100,00;1080,00`;

// Synthetic, format-faithful OP semicolon/decimal-comma fixture; contains no real account data.
const OP = `OP account statement
Account statement ending balance EUR 1150,00
Booking date;Value date;Payment type;Payee;Debit;Credit;Balance
11.08.2026;11.08.2026;CARD PAYMENT;SYNTHETIC HOST;30,00;;970,00
12.08.2026;12.08.2026;CREDIT TRANSFER;SYNTHETIC CUSTOMER;;180,00;1150,00`;

const driveWorkerToBankExtractor = (bank, text, ledgerCurrency) =>
  __test__extractDocument({
    document: {
      id: `synthetic-${bank}`,
      client_id: 'synthetic-client',
      document_type: 'bank_statement',
      filename: `${bank}-statement-2026.txt`,
      payload: { mime_type: 'text/plain' }
    },
    bytes: Buffer.from(text),
    log: console,
    ledgerCurrency
  });

const rows = (out) => out.transactions?.map(({ date, money_in, money_out, balance }) => ({
  date,
  money_in,
  money_out,
  balance
}));

const assertCurrencies = (out, currency) => {
  assert.equal(out.summary.statement_currency, currency);
  assert.equal(out.summary.ledger_currency, currency);
  for (const transaction of out.transactions || []) {
    assert.equal(transaction.account_currency, currency);
    assert.equal(transaction.ledger_currency, currency);
    assert.equal(transaction.ledger_conversion_status, 'native');
  }
};

test('F-10C-MONZO pins worker-to-extractor behavior', async () => {
  const out = await driveWorkerToBankExtractor('monzo', MONZO, 'GBP');
  assert.equal(out.kind, 'completed');
  // FIXED F-10C-MONZO: the per-row Currency column establishes GBP.
  assertCurrencies(out, 'GBP');
  assert.deepEqual(rows(out), [
    { date: '2026-07-30', money_in: 0, money_out: 42.5, balance: 957.5 },
    { date: '2026-07-31', money_in: 500, money_out: 0, balance: 1457.5 }
  ]);
});

test('currency column conflicting with statement header refuses currency', async () => {
  const conflicting = `Synthetic bank statement
Statement of account ending balance EUR 957.50
Date,Description,Amount,Currency,Balance
30/07/2026,Synthetic Cloud Host,-42.50,GBP,957.50`;
  const out = await driveWorkerToBankExtractor('currency-conflict', conflicting, 'GBP');
  assert.equal(out.kind, 'completed');
  assert.equal(out.summary.statement_currency, null);
  assert.deepEqual(out.transactions.map((tx) => tx.account_currency), ['']);
});

test('F-10C-STARLING pins worker-to-extractor behavior', async () => {
  const out = await driveWorkerToBankExtractor('starling', STARLING, 'GBP');
  assert.equal(out.kind, 'completed');
  // FIXED F-10C-STARLING: the amount/balance column labels establish GBP.
  assertCurrencies(out, 'GBP');
  assert.deepEqual(rows(out), [
    { date: '2026-08-01', money_in: 0, money_out: 24.99, balance: 975.01 },
    { date: '2026-08-02', money_in: 500, money_out: 0, balance: 1475.01 }
  ]);
});

test('HSBC pins debit/credit columns, dates, balances, and GBP', async () => {
  const out = await driveWorkerToBankExtractor('hsbc', HSBC, 'GBP');
  assert.equal(out.kind, 'completed');
  assertCurrencies(out, 'GBP');
  assert.deepEqual(rows(out), [
    { date: '2026-08-03', money_in: 0, money_out: 60, balance: 940 },
    { date: '2026-08-04', money_in: 200, money_out: 0, balance: 1140 }
  ]);
});

test('Lloyds pins debit/credit columns, dates, balances, and GBP', async () => {
  const out = await driveWorkerToBankExtractor('lloyds', LLOYDS, 'GBP');
  assert.equal(out.kind, 'completed');
  assertCurrencies(out, 'GBP');
  assert.deepEqual(rows(out), [
    { date: '2026-08-05', money_in: 0, money_out: 40, balance: 960 },
    { date: '2026-08-06', money_in: 250, money_out: 0, balance: 1210 }
  ]);
});

test('NatWest pins signed amounts, dates, balances, and GBP', async () => {
  const out = await driveWorkerToBankExtractor('natwest', NATWEST, 'GBP');
  assert.equal(out.kind, 'completed');
  assertCurrencies(out, 'GBP');
  assert.deepEqual(rows(out), [
    { date: '2026-08-07', money_in: 0, money_out: 25, balance: 975 },
    { date: '2026-08-08', money_in: 100, money_out: 0, balance: 1075 }
  ]);
});

test('F-10C-NORDEA pins decimal-comma worker-to-extractor behavior', async () => {
  const out = await driveWorkerToBankExtractor('nordea', NORDEA, 'EUR');
  assert.equal(out.kind, 'completed');
  assertCurrencies(out, 'EUR');
  // FIXED F-10C-NORDEA: semicolon cells preserve decimal-comma amounts.
  assert.deepEqual(rows(out), [
    { date: '2026-08-09', money_in: 0, money_out: 20, balance: 980 },
    { date: '2026-08-10', money_in: 100, money_out: 0, balance: 1080 }
  ]);
});

test('F-10C-OP pins decimal-comma worker-to-extractor behavior', async () => {
  const out = await driveWorkerToBankExtractor('op', OP, 'EUR');
  // FIXED F-10C-OP: semicolon debit/credit cells produce both rows.
  assert.equal(out.kind, 'completed');
  assertCurrencies(out, 'EUR');
  assert.deepEqual(rows(out), [
    { date: '2026-08-11', money_in: 0, money_out: 30, balance: 970 },
    { date: '2026-08-12', money_in: 180, money_out: 0, balance: 1150 }
  ]);
});
