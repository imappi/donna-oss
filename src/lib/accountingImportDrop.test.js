import assert from 'node:assert/strict';
import test from 'node:test';

import { isAccountingImportDropFile, partitionFirmDropFiles } from './accountingImportDrop.js';

test('desktop venture drops hand workbook and TSV containers to Import data', () => {
  for (const name of ['book.xlsx', 'legacy.XLS', 'journal.tsv']) {
    assert.equal(isAccountingImportDropFile({ name }), true, name);
  }
});

test('CSV and evidence documents keep their existing evidence-upload route', () => {
  for (const file of [
    { name: 'statement.csv', type: 'application/vnd.ms-excel' },
    { name: 'invoice.pdf', type: 'application/pdf' },
    { name: 'receipt.png', type: 'image/png' }
  ]) {
    assert.equal(isAccountingImportDropFile(file), false, file.name);
  }
});

test('drop partition preserves every file and its original order within each lane', () => {
  const files = [
    { name: 'invoice.pdf' },
    { name: 'cutover.xlsx' },
    { name: 'statement.csv' },
    { name: 'journal.tsv' }
  ];
  const result = partitionFirmDropFiles(files);
  assert.deepEqual(result.accountingImportFiles, [files[1], files[3]]);
  assert.deepEqual(result.evidenceFiles, [files[0], files[2]]);
  assert.equal(result.accountingImportFiles.length + result.evidenceFiles.length, files.length);
});
