import assert from 'node:assert/strict';
import test from 'node:test';

import { __test__extractDocument } from './inngest/parseDocument.js';

const driveCsv = (csv, mimeType = 'text/csv') =>
  __test__extractDocument({
    document: {
      id: 'synthetic-csv-hardening',
      client_id: 'synthetic-client',
      document_type: 'bank_statement',
      filename: 'synthetic-bank-export-2026.csv',
      payload: { mime_type: mimeType }
    },
    bytes: Buffer.from(csv),
    log: console,
    ledgerCurrency: 'GBP'
  });

const rowShape = ({ date, description, money_in, money_out, balance }) => ({
  date,
  description,
  money_in,
  money_out,
  balance
});

const assertSingleRow = async (csv, expected, mimeType) => {
  const out = await driveCsv(csv, mimeType);
  assert.equal(out.kind, 'completed');
  assert.deepEqual(out.transactions.map(rowShape), [expected]);
};

const expectedPayment = (description = 'PAYMENT, THANK YOU') => ({
  date: '2026-08-01',
  description,
  money_in: 0,
  money_out: 42.5,
  balance: 957.5
});

test('UTF-8 BOM before the CSV header is ignored worker-to-extractor', async () => {
  await assertSingleRow(
    '\uFEFFDate,Description,Amount,Balance\n01/08/2026,"PAYMENT, THANK YOU",-42.50,957.50',
    expectedPayment()
  );
});

test('CRLF CSV records parse worker-to-extractor', async () => {
  await assertSingleRow(
    'Date,Description,Amount,Balance\r\n01/08/2026,"PAYMENT, THANK YOU",-42.50,957.50\r\n',
    expectedPayment()
  );
});

test('a .csv masquerading as application/vnd.ms-excel reaches the text extractor', async () => {
  await assertSingleRow(
    'Date,Description,Amount,Balance\n01/08/2026,"PAYMENT, THANK YOU",-42.50,957.50',
    expectedPayment(),
    'application/vnd.ms-excel'
  );
});

test('quoted commas and escaped quotes survive worker-to-extractor parsing', async () => {
  await assertSingleRow(
    'Date,Description,Amount,Balance\n01/08/2026,"PAYMENT, ""THANK YOU""",-42.50,957.50',
    expectedPayment('PAYMENT, "THANK YOU"')
  );
});

test('trailing empty columns and blank padding rows do not create or shift transactions', async () => {
  await assertSingleRow(
    '\n\nDate,Description,Amount,Balance,Unused,\n01/08/2026,"PAYMENT, THANK YOU",-42.50,957.50,,\n\n  \n',
    expectedPayment()
  );
});

test('a quoted description containing a newline remains one CSV record', async () => {
  await assertSingleRow(
    'Date,Description,Amount,Balance\n01/08/2026,"PAYMENT,\nTHANK YOU",-42.50,957.50',
    expectedPayment()
  );
});

test('an unterminated quoted continuation refuses a shifted delimited interpretation', async () => {
  const out = await driveCsv(
    'Date,Description,Amount,Balance\n01/08/2026,"PAYMENT,\nTHANK YOU,-42.50,957.50'
  );
  assert.deepEqual(out.transactions ?? [], []);
});

test('a stray quote in non-delimited statement text still parses through the text lanes', async () => {
  // F-14B-STRAY-QUOTE-ZEROES-STATEMENT regression: parseTextTransactions
  // serves the PDF/OCR/vision lanes too, so an odd quote count in ordinary
  // statement text (OCR noise, inch marks) must not zero the statement.
  // Before the fix this extraction returned kind: 'skipped' with no rows.
  const text = `Synthetic Bank statement
Account 12345678 Sort 01-02-03
01 Aug 2026 CARD PAYMENT 3" PIPE CO 42.50 957.50
02 Aug 2026 FASTER PAYMENT RECEIVED SYNTH LTD 100.00 1057.50`;
  const out = await __test__extractDocument({
    document: {
      id: 'synthetic-stray-quote',
      client_id: 'synthetic-client',
      document_type: 'bank_statement',
      filename: 'synthetic-ocr-statement-2026.txt',
      payload: { mime_type: 'text/plain' }
    },
    bytes: Buffer.from(text),
    log: console,
    ledgerCurrency: 'GBP'
  });
  assert.equal(out.kind, 'completed');
  assert.deepEqual(out.transactions.map(rowShape), [
    { date: '2026-08-01', description: 'CARD PAYMENT 3" PIPE CO', money_in: 0, money_out: 42.5, balance: 957.5 },
    { date: '2026-08-02', description: 'FASTER PAYMENT RECEIVED SYNTH LTD', money_in: 100, money_out: 0, balance: 1057.5 }
  ]);
});
