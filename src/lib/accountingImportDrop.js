const ACCOUNTING_IMPORT_EXTENSIONS = new Set(['xlsx', 'xls', 'tsv']);

const fileExtension = (file) => {
  const name = String(file?.name || '').trim();
  const separator = name.lastIndexOf('.');
  return separator >= 0 ? name.slice(separator + 1).toLowerCase() : '';
};

// CSV deliberately stays in evidence intake until the shared bank-statement
// migration slice replaces that existing route. Workbooks and TSV have no
// evidence meaning, so the desktop drop surface hands them to Import data.
export const isAccountingImportDropFile = (file) =>
  ACCOUNTING_IMPORT_EXTENSIONS.has(fileExtension(file));

export const partitionFirmDropFiles = (files = []) => {
  const accountingImportFiles = [];
  const evidenceFiles = [];
  for (const file of Array.from(files || [])) {
    if (isAccountingImportDropFile(file)) accountingImportFiles.push(file);
    else evidenceFiles.push(file);
  }
  return { accountingImportFiles, evidenceFiles };
};
