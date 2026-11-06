import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__extractDocument } from './inngest/parseDocument.js';

const fixtures = {
  revolut: `Revolut Business account statement
Type,Product,Started Date,Completed Date,Description,Amount,Fee,Currency,State,Balance
CARD,Current,2026-08-01,2026-08-01,Synthetic hosting,-42.50,0.00,GBP,COMPLETED,957.50
TRANSFER,Current,2026-08-02,2026-08-02,Synthetic customer,500.00,0.00,GBP,COMPLETED,1457.50`,
  wise: `Wise Business account statement
TransferWise ID,Date,Amount,Currency,Description,Payment Reference,Running Balance
SYNTHETIC-1,03/08/2026,-24.99,GBP,Synthetic software,REF-1,975.01
SYNTHETIC-2,04/08/2026,300.00,GBP,Synthetic customer,REF-2,1275.01`,
  tide: `Tide business current account statement
Date,Transaction ID,Transaction Type,Transaction Description,Amount (GBP),Balance (GBP)
05/08/2026,SYNTHETIC-1,Card payment,Synthetic supplies,-35.00,965.00
06/08/2026,SYNTHETIC-2,Transfer in,Synthetic customer,125.00,1090.00`,
  santander: `Santander Business Banking statement
Statement of account ending balance GBP 1170.00
Date,Description,Money in,Money out,Balance
07/08/2026,Synthetic utilities,,70.00,930.00
08/08/2026,Synthetic customer,240.00,,1170.00`,
  nationwide: `Nationwide Business account statement
Statement of account ending balance GBP 1115.00
Date,Transaction type,Description,Paid out,Paid in,Balance
09/08/2026,Card payment,Synthetic fuel,45.00,,955.00
10/08/2026,Credit,Synthetic customer,,160.00,1115.00`
};

const expected = {
  revolut: [
    { date: '2026-08-01', money_in: 0, money_out: 42.5, balance: 957.5 },
    { date: '2026-08-02', money_in: 500, money_out: 0, balance: 1457.5 }
  ],
  wise: [
    { date: '2026-08-03', money_in: 0, money_out: 24.99, balance: 975.01 },
    { date: '2026-08-04', money_in: 300, money_out: 0, balance: 1275.01 }
  ],
  tide: [
    { date: '2026-08-05', money_in: 0, money_out: 35, balance: 965 },
    { date: '2026-08-06', money_in: 125, money_out: 0, balance: 1090 }
  ],
  santander: [
    { date: '2026-08-07', money_in: 0, money_out: 70, balance: 930 },
    { date: '2026-08-08', money_in: 240, money_out: 0, balance: 1170 }
  ],
  nationwide: [
    { date: '2026-08-09', money_in: 0, money_out: 45, balance: 955 },
    { date: '2026-08-10', money_in: 160, money_out: 0, balance: 1115 }
  ]
};

const driveWorkerToBankExtractor = (bank, text) =>
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
    ledgerCurrency: 'GBP'
  });

const rows = (out) => out.transactions?.map(({ date, money_in, money_out, balance }) => ({
  date,
  money_in,
  money_out,
  balance
}));

for (const [bank, fixture] of Object.entries(fixtures)) {
  test(`${bank} GBP export pins worker-to-extractor behavior`, async () => {
    const out = await driveWorkerToBankExtractor(bank, fixture);
    assert.equal(out.kind, 'completed');
    assert.equal(out.summary.statement_currency, 'GBP');
    assert.equal(out.summary.ledger_currency, 'GBP');
    assert.deepEqual(rows(out), expected[bank]);
    for (const transaction of out.transactions) {
      assert.equal(transaction.account_currency, 'GBP');
      assert.equal(transaction.ledger_currency, 'GBP');
      assert.equal(transaction.ledger_conversion_status, 'native');
    }
  });
}

test('European thousands-dot and comma-decimal amounts stay intact', async () => {
  const fixture = `Synthetic European account statement
Statement of account ending balance EUR 2.234,56
Date;Description;Amount;Balance
11.08.2026;Synthetic European grouping;-1.234,56;2.234,56
12.08.2026;Synthetic comma decimal;-1234,56;1000,00
13.08.2026;Synthetic US grouping;-1,234.56;234.56
14.08.2026;Synthetic comma thousands;-1,234;100.00`;
  const out = await __test__extractDocument({
    document: {
      id: 'synthetic-european-grouping',
      client_id: 'synthetic-client',
      document_type: 'bank_statement',
      filename: 'synthetic_EUR_statement_2026.txt',
      payload: { mime_type: 'text/plain' }
    },
    bytes: Buffer.from(fixture),
    log: console,
    ledgerCurrency: 'EUR'
  });

  assert.equal(out.kind, 'completed');
  assert.deepEqual(rows(out), [
    { date: '2026-08-11', money_in: 0, money_out: 1234.56, balance: 2234.56 },
    { date: '2026-08-12', money_in: 0, money_out: 1234.56, balance: 1000 },
    { date: '2026-08-13', money_in: 0, money_out: 1234.56, balance: 234.56 },
    { date: '2026-08-14', money_in: 0, money_out: 1234, balance: 100 }
  ]);
});
