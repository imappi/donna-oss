import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__extractDocument } from './inngest/parseDocument.js';

// CSV statement intake — the worker→extractor pin
// (docs/design-donna-csv-statement-intake.md §5). The format-pin suites
// (`bankStatementFormatPins*.test.js`) drive CSV CONTENT through the worker as
// `text/plain`/`.txt`; this file pins the exact mime/filename pair the new
// entry points admit — `text/csv` + `*.csv` — and the extractor's content
// behavior for the un-normalized legacy declaration, proving the worker needs
// zero edits for CSV (the mint gate normalizes; the extractor text-parses any
// non-PDF).

// Synthetic, format-faithful Monzo CSV fixture; contains no real account data.
const MONZO_CSV = `Monzo Bank Limited account statement
Date,Time,Type,Name,Amount,Currency,Balance
30/07/2026,09:00:00,Card payment,Synthetic Cloud Host,-42.50,GBP,957.50
31/07/2026,12:00:00,Faster payment,Synthetic Customer,500.00,GBP,1457.50`;

const driveWorker = ({ filename, mimeType }) =>
  __test__extractDocument({
    document: {
      id: `synthetic-${filename}`,
      client_id: 'synthetic-client',
      document_type: 'bank_statement',
      filename,
      payload: { mime_type: mimeType }
    },
    bytes: Buffer.from(MONZO_CSV),
    log: console,
    ledgerCurrency: 'GBP'
  });

const expectedRows = [
  { date: '2026-07-30', money_in: 0, money_out: 42.5, balance: 957.5 },
  { date: '2026-07-31', money_in: 500, money_out: 0, balance: 1457.5 }
];

const rows = (out) => out.transactions?.map(({ date, money_in, money_out, balance }) => ({
  date,
  money_in,
  money_out,
  balance
}));

test('a text/csv *.csv bank statement parses worker-to-extractor', async () => {
  const out = await driveWorker({ filename: 'monzo-statement-2026.csv', mimeType: 'text/csv' });
  assert.equal(out.kind, 'completed');
  assert.equal(out.summary.statement_currency, 'GBP');
  assert.equal(out.summary.ledger_currency, 'GBP');
  assert.deepEqual(rows(out), expectedRows);
  for (const transaction of out.transactions) {
    assert.equal(transaction.ledger_conversion_status, 'native');
  }
});

test('an un-normalized vnd.ms-excel declaration on a .csv file still text-parses (the extractor is the sniff layer)', async () => {
  const out = await driveWorker({ filename: 'monzo-statement-2026.csv', mimeType: 'application/vnd.ms-excel' });
  assert.equal(out.kind, 'completed');
  assert.deepEqual(rows(out), expectedRows);
});
