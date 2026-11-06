import assert from 'node:assert/strict';
import test from 'node:test';

import * as XLSX from 'xlsx';

import {
  ACCOUNTING_IMPORT_KINDS,
  ACCOUNTING_IMPORT_LIMITS,
  ACCOUNTING_IMPORT_SCHEMA_VERSION,
  inspectAccountingImport
} from './accountingImport.js';

const BANK_ROWS = [
  ['Date', 'Description', 'Amount', 'Currency'],
  ['2026-01-10', 'Coffee, beans', -12.5, 'GBP'],
  ['2026-01-11', 'Customer payment', 120, 'GBP']
];

const workbookBytes = (bookType, rows = BANK_ROWS, mutate = null) => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  if (typeof mutate === 'function') mutate({ workbook, sheet });
  XLSX.utils.book_append_sheet(workbook, sheet, 'Transactions');
  return XLSX.write(workbook, { type: 'buffer', bookType });
};

const planProjection = (result) => ({
  schema: result.schema_version,
  state: result.state,
  columns: result.sheets[0].columns.map((column) => column.label),
  rows: result.sheets[0].preview_rows.map((row) => row.values),
  mapping: result.plan.mapping.map((entry) => [entry.field, entry.source_label]),
  totals: result.plan.validation.totals
});

test('CSV, TSV, XLSX and legacy XLS produce an equivalent normalized bank preview', () => {
  const csv = Buffer.from([
    'Date,Description,Amount,Currency',
    '2026-01-10,"Coffee, beans",-12.5,GBP',
    '2026-01-11,Customer payment,120,GBP'
  ].join('\n'));
  const tsv = Buffer.from([
    'Date\tDescription\tAmount\tCurrency',
    '2026-01-10\tCoffee, beans\t-12.5\tGBP',
    '2026-01-11\tCustomer payment\t120\tGBP'
  ].join('\n'));
  const inputs = [
    ['bank.csv', csv, 'csv'],
    ['bank.tsv', tsv, 'tsv'],
    ['bank.xlsx', workbookBytes('xlsx'), 'xlsx'],
    ['bank.xls', workbookBytes('xls'), 'xls']
  ];
  const results = inputs.map(([filename, bytes, detected]) => {
    const result = inspectAccountingImport({
      bytes,
      filename,
      requestedImportKind: 'bank_transactions'
    });
    assert.equal(result.source.detected_format, detected);
    assert.equal(result.state, 'ready_to_apply');
    assert.equal(result.plan.validation.issue_count, 0);
    return result;
  });
  const expected = planProjection(results[0]);
  for (const result of results.slice(1)) assert.deepEqual(planProjection(result), expected);
  assert.equal(expected.schema, ACCOUNTING_IMPORT_SCHEMA_VERSION);
});

test('every first-release import kind has a deterministic schema that can reach a clean preview', () => {
  const fixtures = {
    bank_transactions: 'Date,Description,Amount\n2026-01-10,Coffee,-4.50\n',
    payment_account_transactions: 'Date,Description,Amount\n2026-01-10,Card purchase,-4.50\n',
    chart_of_accounts: 'Account Code,Account Name,Account Type\n1000,Cash,Asset\n',
    opening_trial_balance: 'Account Code,Debit,Credit\n1000,100,\n3000,,100\n',
    parties: 'Name,Email\nAda Ltd,books@ada.example\n',
    general_ledger: 'Date,Journal Reference,Account Code,Description,Debit,Credit\n2026-01-10,J1,1000,Cash,100,\n2026-01-10,J1,4000,Revenue,,100\n',
    open_receivables: 'Invoice Number,Customer,Issue Date,Outstanding Amount\nINV-1,Ada Ltd,2026-01-10,120\n',
    open_payables: 'Bill Number,Supplier,Issue Date,Outstanding Amount\nBILL-1,Bea Ltd,2026-01-10,90\n'
  };
  assert.deepEqual(Object.keys(fixtures).sort(), ACCOUNTING_IMPORT_KINDS.map((kind) => kind.value).sort());
  Object.entries(fixtures).forEach(([requestedImportKind, source]) => {
    const result = inspectAccountingImport({
      bytes: Buffer.from(source),
      filename: `${requestedImportKind}.csv`,
      requestedImportKind
    });
    assert.equal(result.state, 'ready_to_apply', `${requestedImportKind}: ${JSON.stringify(result.plan.validation.issues)}`);
    assert.equal(result.plan.validation.issue_count, 0, requestedImportKind);
  });
});

test('an unconfirmed CSV remains needs_kind even when its headers resemble transactions', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount\n2026-01-10,Coffee,-4.50\n'),
    filename: 'activity.csv'
  });
  assert.equal(result.state, 'needs_kind');
  assert.equal(result.plan, null);
  assert.equal(result.suggested_import_kind, null, 'bank vs payment-account ambiguity must stay with the owner');
});

test('a generic CSV is never silently assigned to the bank-statement kind', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('Thing,Other\nA,B\n'),
    filename: 'export.csv'
  });
  assert.equal(result.state, 'needs_kind');
  assert.equal(result.plan, null);
  assert.equal(result.suggested_import_kind, null);
});

test('container bytes outrank a misleading filename extension', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('Name\tEmail\nAda\tada@example.com\n'),
    filename: 'contacts.xlsx'
  });
  assert.equal(result.source.detected_format, 'tsv');
  assert.ok(result.warnings.some((warning) => warning.code === 'IMPORT_EXTENSION_MISMATCH'));
});

test('quoted CSV fields retain delimiters, newlines and physical source-row coordinates', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('\uFEFFDate;Description;Amount\n2026-01-10;"Coffee;\nbeans";-12,50\n2026-01-11;Sale;120,00\n'),
    filename: 'bank.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(result.source.encoding, 'utf-8-bom');
  assert.equal(result.source.delimiter, 'semicolon');
  assert.equal(result.sheets[0].preview_rows[0].source_row_number, 2);
  assert.equal(result.sheets[0].preview_rows[0].values[1], 'Coffee;\nbeans');
  assert.equal(result.sheets[0].preview_rows[1].source_row_number, 4);
  assert.equal(result.plan.validation.totals.amount, 107.5);
});

test('malformed CSV quoting is refused instead of repaired heuristically', () => {
  assert.throws(
    () => inspectAccountingImport({ bytes: Buffer.from('Date,Description\n2026-01-01,"open\n'), filename: 'bad.csv' }),
    (error) => error.code === 'IMPORT_CSV_MALFORMED' && error.statusCode === 400
  );
});

test('ambiguous dates and amounts identify the exact owner-correction row', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount\n01/02/2026,Coffee,"1,234"\n'),
    filename: 'ambiguous.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(result.state, 'needs_correction');
  assert.equal(result.plan.validation.blocked_rows, 1);
  assert.deepEqual(
    result.plan.validation.issues.map((issue) => [issue.code, issue.source_row_number]),
    [['IMPORT_DATE_AMBIGUOUS', 2], ['IMPORT_NUMBER_AMBIGUOUS', 2]]
  );
});

test('an explicit date and number convention resolves ambiguity without changing source values', () => {
  const bytes = Buffer.from('Date,Description,Amount\n01/02/2026,Coffee,"1,234"\n');
  const result = inspectAccountingImport({
    bytes,
    filename: 'declared-locale.csv',
    requestedImportKind: 'bank_transactions',
    dateConvention: 'dmy',
    numberConvention: 'dot_decimal'
  });
  assert.equal(result.state, 'ready_to_apply');
  assert.equal(result.plan.validation.issue_count, 0);
  assert.equal(result.plan.validation.totals.amount, 1234);
  assert.deepEqual(result.plan.conventions, { date: 'dmy', number: 'dot_decimal' });
  assert.equal(result.sheets[0].preview_rows[0].values[0], '01/02/2026');
  assert.equal(result.sheets[0].preview_rows[0].values[2], '1,234');
});

test('calendar validation refuses impossible dates but accepts a convention-neutral same-day/month date', () => {
  const invalid = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount\n2026-02-30,Coffee,12.50\n'),
    filename: 'invalid-date.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(invalid.state, 'needs_correction');
  assert.ok(invalid.plan.validation.issues.some((issue) => issue.code === 'IMPORT_DATE_INVALID'));

  const valid = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount\n01/01/2026,Coffee,12.50\n'),
    filename: 'same-day-month.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(valid.state, 'ready_to_apply');
});

test('number conventions refuse malformed grouping rather than deleting separators', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount\n2026-01-10,Coffee,"12,34,56"\n'),
    filename: 'bad-grouping.csv',
    requestedImportKind: 'bank_transactions',
    numberConvention: 'dot_decimal'
  });
  assert.equal(result.state, 'needs_correction');
  assert.ok(result.plan.validation.issues.some((issue) => issue.code === 'IMPORT_NUMBER_INVALID'));
});

test('a row may use any fully mapped amount layout and an empty sheet cannot be ready', () => {
  const mixed = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount,Debit,Credit\n2026-01-10,Coffee,,12.50,\n'),
    filename: 'mixed-layout.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(mixed.state, 'ready_to_apply');
  assert.equal(mixed.plan.validation.issue_count, 0);

  const empty = inspectAccountingImport({
    bytes: Buffer.from('Date,Description,Amount\n'),
    filename: 'empty.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(empty.state, 'needs_correction');
  assert.ok(empty.plan.validation.issues.some((issue) => issue.code === 'IMPORT_NO_DATA_ROWS'));
});

test('missing and duplicate mappings are visible blockers', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('When,Text,Value\n2026-01-10,Coffee,-4.50\n'),
    filename: 'custom.csv',
    requestedImportKind: 'bank_transactions',
    requestedMapping: {
      date: 'column_1',
      description: 'column_2',
      amount: 'column_2'
    }
  });
  assert.equal(result.state, 'needs_mapping');
  assert.ok(result.plan.validation.issues.some((issue) => issue.code === 'IMPORT_COLUMN_MAPPED_TWICE'));
  assert.equal(result.plan.validation.valid_rows, 0);
  assert.equal(result.plan.validation.blocked_rows, 1);
});

test('an unbalanced general-ledger batch cannot pass preview', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from([
      'Date,Journal Reference,Account Code,Description,Debit,Credit',
      '2026-01-10,J1,1000,Cash,100,',
      '2026-01-10,J1,4000,Revenue,,90'
    ].join('\n')),
    filename: 'ledger.csv',
    requestedImportKind: 'general_ledger'
  });
  assert.equal(result.state, 'needs_correction');
  assert.ok(result.plan.validation.issues.some((issue) => issue.code === 'IMPORT_JOURNAL_UNBALANCED'));
  assert.equal(result.plan.validation.blocked_rows, 2, 'the atomic journal group is wholly blocked');
  assert.equal(result.plan.validation.valid_rows, 0);
});

test('a title row is excluded explicitly and the denser next row becomes the header', () => {
  const result = inspectAccountingImport({
    bytes: Buffer.from('Bank export\nDate,Description,Amount\n2026-01-10,Coffee,-4.50\n'),
    filename: 'bank.csv',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(result.sheets[0].header_row_number, 2);
  assert.deepEqual(result.sheets[0].excluded_rows.title_or_preamble, [1]);
  assert.equal(result.sheets[0].preview_rows[0].source_row_number, 3);
});

test('formula cells are never executed and a missing cached value blocks the sheet', () => {
  const bytes = workbookBytes('xlsx', BANK_ROWS, ({ sheet }) => {
    sheet.C2 = { t: 'n', f: '1+1' };
  });
  const result = inspectAccountingImport({
    bytes,
    filename: 'formula.xlsx',
    requestedImportKind: 'bank_transactions'
  });
  assert.equal(result.sheets[0].features.formula_cells, 1);
  assert.equal(result.sheets[0].features.formulas_without_cached_values, 1);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'IMPORT_FORMULA_VALUE_MISSING'));
  assert.equal(result.state, 'needs_correction');
});

test('hidden rows are surfaced as a blocker rather than silently imported', () => {
  const bytes = workbookBytes('xlsx', BANK_ROWS, ({ sheet }) => {
    sheet['!rows'] = [null, { hidden: true }];
  });
  const result = inspectAccountingImport({ bytes, filename: 'hidden.xlsx' });
  assert.equal(result.sheets[0].features.hidden_rows, 1);
  assert.ok(result.blockers.some((blocker) => blocker.code === 'IMPORT_HIDDEN_DATA_PRESENT'));
});

test('file and ZIP-expansion limits refuse before workbook parsing', () => {
  assert.throws(
    () => inspectAccountingImport({
      bytes: Buffer.alloc(ACCOUNTING_IMPORT_LIMITS.maxFileBytes + 1, 0x20),
      filename: 'large.csv'
    }),
    (error) => error.code === 'IMPORT_FILE_SIZE_LIMIT' && error.statusCode === 413
  );

  const bytes = Buffer.from(workbookBytes('xlsx'));
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const centralOffset = bytes.indexOf(centralSignature);
  assert.ok(centralOffset > 0);
  bytes.writeUInt32LE(ACCOUNTING_IMPORT_LIMITS.maxArchiveUncompressedBytes + 1, centralOffset + 24);
  assert.throws(
    () => inspectAccountingImport({ bytes, filename: 'bomb.xlsx' }),
    (error) => error.code === 'IMPORT_ARCHIVE_EXPANSION_LIMIT' && error.statusCode === 413
  );
});
