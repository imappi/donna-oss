import { createHash } from 'node:crypto';

import * as XLSX from 'xlsx';

export const ACCOUNTING_IMPORT_SCHEMA_VERSION = 'accounting_import_inspection.v1';

export const ACCOUNTING_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: 6 * 1024 * 1024,
  maxArchiveEntries: 512,
  maxArchiveUncompressedBytes: 48 * 1024 * 1024,
  maxArchiveCompressionRatio: 80,
  maxSheets: 24,
  maxRowsPerSheet: 50_000,
  maxColumnsPerSheet: 128,
  maxCells: 500_000,
  maxCellCharacters: 20_000,
  previewRows: 25,
  maxReportedIssues: 200
});

const IMPORT_KIND_DEFINITIONS = Object.freeze({
  bank_transactions: {
    label: 'Bank transactions',
    fields: [
      ['date', 'Date', ['date', 'transaction date', 'booking date', 'value date']],
      ['description', 'Description', ['description', 'details', 'narrative', 'memo', 'payee']],
      ['amount', 'Amount', ['amount', 'transaction amount', 'value']],
      ['debit', 'Debit', ['debit', 'money out', 'withdrawal', 'paid out']],
      ['credit', 'Credit', ['credit', 'money in', 'deposit', 'paid in']],
      ['balance', 'Balance', ['balance', 'running balance']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']],
      ['reference', 'Reference', ['reference', 'transaction id', 'transaction reference']]
    ],
    requiredAll: ['date', 'description'],
    requiredOneOf: [['amount'], ['debit', 'credit']]
  },
  payment_account_transactions: {
    label: 'Card or payment-account transactions',
    fields: [
      ['date', 'Date', ['date', 'transaction date', 'booking date', 'value date']],
      ['description', 'Description', ['description', 'details', 'narrative', 'memo', 'merchant']],
      ['amount', 'Amount', ['amount', 'transaction amount', 'value']],
      ['debit', 'Debit', ['debit', 'money out', 'withdrawal', 'charge']],
      ['credit', 'Credit', ['credit', 'money in', 'deposit', 'refund']],
      ['balance', 'Balance', ['balance', 'running balance']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']],
      ['reference', 'Reference', ['reference', 'transaction id', 'transaction reference']]
    ],
    requiredAll: ['date', 'description'],
    requiredOneOf: [['amount'], ['debit', 'credit']]
  },
  chart_of_accounts: {
    label: 'Chart of accounts',
    fields: [
      ['account_code', 'Account code', ['account code', 'code', 'account number', 'number']],
      ['account_name', 'Account name', ['account name', 'name', 'account']],
      ['account_type', 'Account type', ['account type', 'type', 'class', 'category']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']],
      ['status', 'Status', ['status', 'active', 'archived']]
    ],
    requiredAll: ['account_code', 'account_name'],
    requiredOneOf: []
  },
  opening_trial_balance: {
    label: 'Opening trial balance',
    fields: [
      ['account_code', 'Account code', ['account code', 'code', 'account number']],
      ['account_name', 'Account name', ['account name', 'name', 'account']],
      ['balance', 'Balance', ['balance', 'opening balance', 'closing balance']],
      ['debit', 'Debit', ['debit', 'debit balance']],
      ['credit', 'Credit', ['credit', 'credit balance']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']]
    ],
    requiredAll: ['account_code'],
    requiredOneOf: [['balance'], ['debit', 'credit']]
  },
  parties: {
    label: 'Customers and suppliers',
    fields: [
      ['party_name', 'Name', ['party name', 'name', 'contact name', 'customer', 'supplier', 'vendor']],
      ['party_type', 'Customer or supplier', ['party type', 'contact type', 'type', 'customer or supplier']],
      ['email', 'Email', ['email', 'email address']],
      ['tax_identifier', 'Tax identifier', ['tax id', 'tax identifier', 'vat number', 'vat id', 'business id']],
      ['address', 'Address', ['address', 'postal address', 'billing address']]
    ],
    requiredAll: ['party_name'],
    requiredOneOf: []
  },
  general_ledger: {
    label: 'General ledger or journals',
    fields: [
      ['date', 'Date', ['date', 'journal date', 'posting date']],
      ['entry_reference', 'Journal reference', ['journal reference', 'entry reference', 'journal number', 'batch id']],
      ['account_code', 'Account code', ['account code', 'code', 'account number']],
      ['description', 'Description', ['description', 'memo', 'narrative']],
      ['debit', 'Debit', ['debit', 'debit amount']],
      ['credit', 'Credit', ['credit', 'credit amount']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']]
    ],
    requiredAll: ['date', 'account_code'],
    requiredOneOf: [['debit', 'credit']]
  },
  open_receivables: {
    label: 'Open customer invoices',
    fields: [
      ['document_number', 'Invoice number', ['invoice number', 'document number', 'number', 'reference']],
      ['party_name', 'Customer', ['customer', 'customer name', 'contact', 'party name']],
      ['issue_date', 'Issue date', ['issue date', 'invoice date', 'date']],
      ['due_date', 'Due date', ['due date', 'payment due']],
      ['gross_amount', 'Gross amount', ['gross amount', 'total', 'invoice total']],
      ['outstanding_amount', 'Outstanding amount', ['outstanding amount', 'amount due', 'balance due', 'open balance']],
      ['tax_amount', 'Tax amount', ['tax amount', 'vat amount', 'tax']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']]
    ],
    requiredAll: ['document_number', 'party_name', 'issue_date', 'outstanding_amount'],
    requiredOneOf: []
  },
  open_payables: {
    label: 'Open supplier bills',
    fields: [
      ['document_number', 'Bill number', ['bill number', 'invoice number', 'document number', 'number', 'reference']],
      ['party_name', 'Supplier', ['supplier', 'supplier name', 'vendor', 'vendor name', 'contact', 'party name']],
      ['issue_date', 'Issue date', ['issue date', 'bill date', 'invoice date', 'date']],
      ['due_date', 'Due date', ['due date', 'payment due']],
      ['gross_amount', 'Gross amount', ['gross amount', 'total', 'bill total', 'invoice total']],
      ['outstanding_amount', 'Outstanding amount', ['outstanding amount', 'amount due', 'balance due', 'open balance']],
      ['tax_amount', 'Tax amount', ['tax amount', 'vat amount', 'tax']],
      ['currency', 'Currency', ['currency', 'currency code', 'ccy']]
    ],
    requiredAll: ['document_number', 'party_name', 'issue_date', 'outstanding_amount'],
    requiredOneOf: []
  }
});

export const ACCOUNTING_IMPORT_KINDS = Object.freeze(
  Object.entries(IMPORT_KIND_DEFINITIONS).map(([value, definition]) => ({ value, label: definition.label }))
);

const extensionOf = (filename) => {
  const match = String(filename || '').trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || null;
};

const importError = (code, message, statusCode = 400, details = null) => {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
};

const normalizeHeader = (value) => String(value ?? '')
  .normalize('NFKC')
  .trim()
  .toLowerCase()
  .replace(/[_\-.\/]+/g, ' ')
  .replace(/[^\p{L}\p{N} ]+/gu, '')
  .replace(/\s+/g, ' ');

const isBlank = (value) => value == null || String(value).trim() === '';

const spreadsheetColumnLabel = (index) => {
  let n = index + 1;
  let label = '';
  while (n > 0) {
    const remainder = (n - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    n = Math.floor((n - 1) / 26);
  }
  return label;
};

const inspectZipContainer = (bytes) => {
  const eocdSignature = 0x06054b50;
  const centralSignature = 0x02014b50;
  const minOffset = Math.max(0, bytes.length - 65_557);
  let eocdOffset = -1;
  for (let offset = bytes.length - 22; offset >= minOffset; offset -= 1) {
    if (bytes.readUInt32LE(offset) === eocdSignature) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw importError('IMPORT_XLSX_INVALID', 'This ZIP container has no valid workbook directory.');
  }

  const entryCount = bytes.readUInt16LE(eocdOffset + 10);
  const directorySize = bytes.readUInt32LE(eocdOffset + 12);
  const directoryOffset = bytes.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) {
    throw importError('IMPORT_XLSX_ZIP64_UNSUPPORTED', 'ZIP64 workbooks are not supported. Export a smaller XLSX file.');
  }
  if (entryCount > ACCOUNTING_IMPORT_LIMITS.maxArchiveEntries) {
    throw importError('IMPORT_ARCHIVE_ENTRY_LIMIT', 'This workbook contains too many internal files.', 413, {
      max_archive_entries: ACCOUNTING_IMPORT_LIMITS.maxArchiveEntries,
      archive_entries: entryCount
    });
  }
  if (directoryOffset + directorySize > eocdOffset || directoryOffset < 0) {
    throw importError('IMPORT_XLSX_INVALID', 'This workbook directory is malformed.');
  }

  let offset = directoryOffset;
  let totalCompressed = 0;
  let totalUncompressed = 0;
  const filenames = [];
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== centralSignature) {
      throw importError('IMPORT_XLSX_INVALID', 'This workbook directory is incomplete.');
    }
    const flags = bytes.readUInt16LE(offset + 8);
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const uncompressed = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > bytes.length || compressed === 0xffffffff || uncompressed === 0xffffffff) {
      throw importError('IMPORT_XLSX_INVALID', 'This workbook contains an unsupported archive entry.');
    }
    if ((flags & 0x1) !== 0) {
      throw importError('IMPORT_WORKBOOK_ENCRYPTED', 'Password-protected workbooks are not supported. Export an unprotected copy.');
    }
    if (method !== 0 && method !== 8) {
      throw importError('IMPORT_XLSX_COMPRESSION_UNSUPPORTED', 'This workbook uses an unsupported compression method.');
    }
    const filename = bytes.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    const normalizedPath = filename.replace(/\\/g, '/');
    if (!normalizedPath || normalizedPath.includes('\0') || normalizedPath.startsWith('/') || normalizedPath.split('/').includes('..')) {
      throw importError('IMPORT_XLSX_UNSAFE_PATH', 'This workbook contains an unsafe internal path.');
    }
    filenames.push(normalizedPath.toLowerCase());
    totalCompressed += compressed;
    totalUncompressed += uncompressed;
    offset = nextOffset;
  }

  const ratio = totalCompressed > 0 ? totalUncompressed / totalCompressed : (totalUncompressed > 0 ? Infinity : 1);
  if (totalUncompressed > ACCOUNTING_IMPORT_LIMITS.maxArchiveUncompressedBytes
    || ratio > ACCOUNTING_IMPORT_LIMITS.maxArchiveCompressionRatio) {
    throw importError('IMPORT_ARCHIVE_EXPANSION_LIMIT', 'This workbook expands beyond Donna’s safe processing limit.', 413, {
      max_uncompressed_bytes: ACCOUNTING_IMPORT_LIMITS.maxArchiveUncompressedBytes,
      uncompressed_bytes: totalUncompressed,
      max_compression_ratio: ACCOUNTING_IMPORT_LIMITS.maxArchiveCompressionRatio,
      compression_ratio: Number.isFinite(ratio) ? Number(ratio.toFixed(2)) : null
    });
  }

  if (!filenames.includes('[content_types].xml') || !filenames.includes('xl/workbook.xml')) {
    throw importError('IMPORT_XLSX_INVALID', 'This ZIP file is not an XLSX workbook.');
  }
  return {
    entry_count: entryCount,
    uncompressed_bytes: totalUncompressed,
    compression_ratio: Number(ratio.toFixed(2)),
    vba_present: filenames.includes('xl/vbaproject.bin') || filenames.some((name) => name.includes('/macrosheets/')),
    external_links_present: filenames.some((name) => name.startsWith('xl/externallinks/')),
    connections_present: filenames.includes('xl/connections.xml') || filenames.some((name) => name.startsWith('xl/querytables/'))
  };
};

const decodeTextBytes = (bytes) => {
  let encoding = 'utf-8';
  let offset = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
    encoding = 'utf-8-bom';
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    offset = 2;
    encoding = 'utf-16le';
  } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    offset = 2;
    encoding = 'utf-16be';
  }
  try {
    const decoderName = encoding === 'utf-8-bom' ? 'utf-8' : encoding;
    const text = new TextDecoder(decoderName, { fatal: true }).decode(bytes.subarray(offset));
    const unsafeControls = Array.from(text).filter((character) => {
      const code = character.charCodeAt(0);
      return code < 32 && character !== '\t' && character !== '\r' && character !== '\n';
    }).length;
    if (unsafeControls > 0) throw new Error('control characters');
    return { text, encoding };
  } catch {
    throw importError('IMPORT_TEXT_ENCODING_UNSUPPORTED', 'This text file is not valid UTF-8 or BOM-marked UTF-16. Export it as UTF-8 CSV or TSV.');
  }
};

const scoreDelimiter = (text, delimiter) => {
  const counts = [];
  let count = 0;
  let quoted = false;
  const sample = text.slice(0, 128 * 1024);
  for (let index = 0; index < sample.length && counts.length < 30; index += 1) {
    const character = sample[index];
    if (character === '"') {
      if (quoted && sample[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) count += 1;
    else if (!quoted && (character === '\n' || character === '\r')) {
      if (character === '\r' && sample[index + 1] === '\n') index += 1;
      if (count > 0) counts.push(count);
      count = 0;
    }
  }
  if (count > 0) counts.push(count);
  if (!counts.length) return { score: 0, mode: 0, consistency: 0 };
  const frequency = new Map();
  counts.forEach((value) => frequency.set(value, (frequency.get(value) || 0) + 1));
  const [mode, occurrences] = Array.from(frequency.entries()).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  const consistency = occurrences / counts.length;
  return { score: (consistency * 1000) + (occurrences * 10) + mode, mode, consistency };
};

const detectDelimiter = (text, extension) => {
  const candidates = [',', '\t', ';'].map((delimiter) => ({ delimiter, ...scoreDelimiter(text, delimiter) }));
  candidates.sort((a, b) => b.score - a.score);
  if (candidates[0].score === 0) return { delimiter: extension === 'tsv' ? '\t' : ',', detected: false };
  return { delimiter: candidates[0].delimiter, detected: true };
};

const parseDelimitedText = (text, delimiter) => {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let atFieldStart = true;
  let closedQuote = false;
  let cellCount = 0;
  let physicalLine = 1;
  let rowStartLine = 1;

  const pushField = () => {
    if (field.length > ACCOUNTING_IMPORT_LIMITS.maxCellCharacters) {
      throw importError('IMPORT_CELL_LENGTH_LIMIT', 'A cell exceeds Donna’s safe character limit.', 413, {
        max_cell_characters: ACCOUNTING_IMPORT_LIMITS.maxCellCharacters
      });
    }
    row.push({ value: field, raw_value: field, type: 'string', formula: false, has_cached_value: true });
    field = '';
    atFieldStart = true;
    closedQuote = false;
    cellCount += 1;
    if (row.length > ACCOUNTING_IMPORT_LIMITS.maxColumnsPerSheet || cellCount > ACCOUNTING_IMPORT_LIMITS.maxCells) {
      throw importError('IMPORT_TABLE_SIZE_LIMIT', 'This table exceeds Donna’s safe row, column or cell limit.', 413, ACCOUNTING_IMPORT_LIMITS);
    }
  };
  const pushRow = () => {
    pushField();
    rows.push({ rowNumber: rowStartLine, cells: row });
    row = [];
    if (rows.length > ACCOUNTING_IMPORT_LIMITS.maxRowsPerSheet + 1) {
      throw importError('IMPORT_ROW_LIMIT', 'This table has more rows than Donna can inspect safely.', 413, {
        max_rows_per_sheet: ACCOUNTING_IMPORT_LIMITS.maxRowsPerSheet
      });
    }
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
          atFieldStart = false;
          closedQuote = true;
        }
      } else {
        if (character === '\r' && text[index + 1] === '\n') {
          field += '\n';
          index += 1;
          physicalLine += 1;
        } else {
          field += character;
          if (character === '\n' || character === '\r') physicalLine += 1;
        }
      }
      continue;
    }
    if (character === '"') {
      if (!atFieldStart) throw importError('IMPORT_CSV_MALFORMED', 'A quoted field starts after other text. Fix the CSV quoting and try again.');
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      pushField();
      continue;
    }
    if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      pushRow();
      physicalLine += 1;
      rowStartLine = physicalLine;
      continue;
    }
    if (closedQuote && character !== ' ' && character !== '\t') {
      throw importError('IMPORT_CSV_MALFORMED', 'Unexpected text follows a closing quote. Fix the CSV quoting and try again.');
    }
    if (closedQuote) continue;
    field += character;
    atFieldStart = false;
  }
  if (quoted) throw importError('IMPORT_CSV_MALFORMED', 'A quoted field is not closed. Fix the CSV quoting and try again.');
  if (field !== '' || row.length > 0) pushRow();
  return rows;
};

const xlsxDateValue = (cell, workbook) => {
  if (cell?.t !== 'n' || !cell?.z || !XLSX.SSF.is_date(cell.z)) return null;
  const parsed = XLSX.SSF.parse_date_code(cell.v, { date1904: Boolean(workbook?.Workbook?.WBProps?.date1904) });
  if (!parsed) return null;
  return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
};

const normalizedWorkbookCell = (cell, workbook) => {
  const dateValue = xlsxDateValue(cell, workbook);
  const rawValue = cell?.v ?? null;
  let value = dateValue;
  let type = dateValue ? 'date' : 'blank';
  if (value == null && rawValue != null) {
    if (typeof rawValue === 'string') {
      value = rawValue;
      type = 'string';
    } else if (typeof rawValue === 'number') {
      value = String(rawValue);
      type = 'number';
    } else if (typeof rawValue === 'boolean') {
      value = rawValue ? 'TRUE' : 'FALSE';
      type = 'boolean';
    } else {
      value = String(rawValue);
      type = cell?.t === 'e' ? 'error' : 'string';
    }
  }
  if (typeof value === 'string' && value.length > ACCOUNTING_IMPORT_LIMITS.maxCellCharacters) {
    throw importError('IMPORT_CELL_LENGTH_LIMIT', 'A cell exceeds Donna’s safe character limit.', 413, {
      max_cell_characters: ACCOUNTING_IMPORT_LIMITS.maxCellCharacters
    });
  }
  const formula = typeof cell?.f === 'string' && cell.f.length > 0;
  return {
    value: value ?? '',
    raw_value: rawValue,
    type,
    formula,
    has_cached_value: !formula || rawValue != null,
    external_reference: formula && /\[[^\]]+\]/.test(cell.f)
  };
};

const worksheetRows = (worksheet, workbook) => {
  const rowMap = new Map();
  let populatedCells = 0;
  let maximumRow = -1;
  let maximumColumn = -1;
  for (const address of Object.keys(worksheet || {})) {
    if (address.startsWith('!')) continue;
    const coordinate = XLSX.utils.decode_cell(address);
    if (coordinate.r >= ACCOUNTING_IMPORT_LIMITS.maxRowsPerSheet + 1
      || coordinate.c >= ACCOUNTING_IMPORT_LIMITS.maxColumnsPerSheet) {
      throw importError('IMPORT_TABLE_SIZE_LIMIT', 'This sheet exceeds Donna’s safe row or column limit.', 413, ACCOUNTING_IMPORT_LIMITS);
    }
    const normalized = normalizedWorkbookCell(worksheet[address], workbook);
    if (isBlank(normalized.value) && !normalized.formula) continue;
    if (!rowMap.has(coordinate.r)) rowMap.set(coordinate.r, []);
    rowMap.get(coordinate.r)[coordinate.c] = normalized;
    maximumRow = Math.max(maximumRow, coordinate.r);
    maximumColumn = Math.max(maximumColumn, coordinate.c);
    populatedCells += 1;
    if (populatedCells > ACCOUNTING_IMPORT_LIMITS.maxCells) {
      throw importError('IMPORT_TABLE_SIZE_LIMIT', 'This workbook contains too many populated cells.', 413, {
        max_cells: ACCOUNTING_IMPORT_LIMITS.maxCells
      });
    }
  }
  if (worksheet?.['!fullref']) {
    const fullRange = XLSX.utils.decode_range(worksheet['!fullref']);
    if (fullRange.e.r >= ACCOUNTING_IMPORT_LIMITS.maxRowsPerSheet + 1) {
      throw importError('IMPORT_ROW_LIMIT', 'This sheet has more rows than Donna can inspect safely.', 413, {
        max_rows_per_sheet: ACCOUNTING_IMPORT_LIMITS.maxRowsPerSheet
      });
    }
  }
  return {
    rows: Array.from(rowMap.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([rowIndex, cells]) => ({ rowNumber: rowIndex + 1, cells })),
    maximumRow,
    maximumColumn,
    populatedCells
  };
};

const rowNonBlankCount = (row) => (row?.cells || []).filter((cell) => !isBlank(cell?.value) || cell?.formula).length;

const buildSheetModel = ({ name, handle, hidden, rows, maximumRow, maximumColumn, worksheet }) => {
  const nonEmptyRows = rows.filter((row) => rowNonBlankCount(row) > 0);
  let header = nonEmptyRows[0] || { rowNumber: 1, cells: [] };
  if (rowNonBlankCount(header) <= 1) {
    const denser = nonEmptyRows.slice(1, 10).find((row) => rowNonBlankCount(row) >= 2);
    if (denser) header = denser;
  }
  const dataRows = nonEmptyRows.filter((row) => row.rowNumber > header.rowNumber);
  const widestColumn = Math.max(maximumColumn, header.cells.length - 1, ...dataRows.map((row) => row.cells.length - 1), -1);
  const columns = Array.from({ length: widestColumn + 1 }, (_, columnIndex) => ({
    handle: `column_${columnIndex + 1}`,
    source_column: columnIndex + 1,
    source_letter: spreadsheetColumnLabel(columnIndex),
    label: isBlank(header.cells[columnIndex]?.value)
      ? `Column ${spreadsheetColumnLabel(columnIndex)}`
      : String(header.cells[columnIndex].value).trim()
  }));

  const hiddenRows = Array.isArray(worksheet?.['!rows'])
    ? worksheet['!rows'].reduce((count, row) => count + (row?.hidden ? 1 : 0), 0)
    : 0;
  const hiddenColumns = Array.isArray(worksheet?.['!cols'])
    ? worksheet['!cols'].reduce((count, column) => count + (column?.hidden ? 1 : 0), 0)
    : 0;
  let formulaCells = 0;
  let formulasWithoutCachedValues = 0;
  let externalFormulaReferences = 0;
  rows.forEach((row) => row.cells.forEach((cell) => {
    if (!cell?.formula) return;
    formulaCells += 1;
    if (!cell.has_cached_value) formulasWithoutCachedValues += 1;
    if (cell.external_reference) externalFormulaReferences += 1;
  }));

  return {
    handle,
    name,
    hidden,
    row_count: dataRows.length,
    source_row_count: maximumRow >= 0 ? maximumRow + 1 : 0,
    column_count: columns.length,
    header_row_number: header.rowNumber,
    columns,
    excluded_rows: {
      title_or_preamble: nonEmptyRows.filter((row) => row.rowNumber < header.rowNumber).map((row) => row.rowNumber),
      blank_count: Math.max(0, (maximumRow + 1) - nonEmptyRows.length)
    },
    features: {
      formula_cells: formulaCells,
      formulas_without_cached_values: formulasWithoutCachedValues,
      external_formula_references: externalFormulaReferences,
      hidden_rows: hiddenRows,
      hidden_columns: hiddenColumns
    },
    preview_rows: dataRows.slice(0, ACCOUNTING_IMPORT_LIMITS.previewRows).map((row, index) => ({
      handle: `row_${index + 1}`,
      source_row_number: row.rowNumber,
      values: columns.map((_, columnIndex) => row.cells[columnIndex]?.value ?? ''),
      types: columns.map((_, columnIndex) => row.cells[columnIndex]?.type ?? 'blank'),
      formula_columns: columns
        .filter((_, columnIndex) => row.cells[columnIndex]?.formula)
        .map((column) => column.handle)
    })),
    _dataRows: dataRows
  };
};

const readWorkbook = (bytes, containerInspection) => {
  let workbook;
  try {
    workbook = XLSX.read(bytes, {
      type: 'buffer',
      raw: true,
      cellDates: false,
      cellFormula: true,
      cellNF: true,
      cellStyles: true,
      bookVBA: true,
      bookFiles: true,
      sheetRows: ACCOUNTING_IMPORT_LIMITS.maxRowsPerSheet + 1,
      WTF: false
    });
  } catch (error) {
    const message = String(error?.message || '');
    if (/password|encrypt/i.test(message)) {
      throw importError('IMPORT_WORKBOOK_ENCRYPTED', 'Password-protected workbooks are not supported. Export an unprotected copy.');
    }
    throw importError('IMPORT_WORKBOOK_INVALID', 'Donna could not read this workbook. Export it again as XLSX, XLS, CSV or TSV.', 400, {
      parser_message: message.slice(0, 240) || null
    });
  }
  if (!Array.isArray(workbook.SheetNames) || workbook.SheetNames.length === 0) {
    throw importError('IMPORT_WORKBOOK_EMPTY', 'This workbook contains no readable worksheets.');
  }
  if (workbook.SheetNames.length > ACCOUNTING_IMPORT_LIMITS.maxSheets) {
    throw importError('IMPORT_SHEET_LIMIT', 'This workbook contains too many worksheets.', 413, {
      max_sheets: ACCOUNTING_IMPORT_LIMITS.maxSheets,
      sheets: workbook.SheetNames.length
    });
  }
  let totalCells = 0;
  const sheets = workbook.SheetNames.map((name, index) => {
    const worksheet = workbook.Sheets[name];
    const parsed = worksheetRows(worksheet, workbook);
    totalCells += parsed.populatedCells;
    if (totalCells > ACCOUNTING_IMPORT_LIMITS.maxCells) {
      throw importError('IMPORT_TABLE_SIZE_LIMIT', 'This workbook contains too many populated cells.', 413, {
        max_cells: ACCOUNTING_IMPORT_LIMITS.maxCells
      });
    }
    const hiddenValue = Number(workbook?.Workbook?.Sheets?.[index]?.Hidden || 0);
    return buildSheetModel({
      name,
      handle: `sheet_${index + 1}`,
      hidden: hiddenValue === 2 ? 'very_hidden' : hiddenValue === 1 ? 'hidden' : 'visible',
      ...parsed,
      worksheet
    });
  });
  return {
    sheets,
    security: {
      vba_present: Boolean(containerInspection?.vba_present || workbook.vbaraw),
      external_links_present: Boolean(containerInspection?.external_links_present),
      connections_present: Boolean(containerInspection?.connections_present)
    }
  };
};

const detectContainer = (bytes, filename) => {
  if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50) {
    return { format: 'xlsx', archive: inspectZipContainer(bytes) };
  }
  const oleMagic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  if (bytes.length >= oleMagic.length && bytes.subarray(0, oleMagic.length).equals(oleMagic)) {
    return { format: 'xls', archive: null };
  }
  const decoded = decodeTextBytes(bytes);
  const delimiter = detectDelimiter(decoded.text, extensionOf(filename));
  return {
    format: delimiter.delimiter === '\t' ? 'tsv' : 'csv',
    archive: null,
    text: decoded.text,
    encoding: decoded.encoding,
    delimiter: delimiter.delimiter,
    delimiterDetected: delimiter.detected
  };
};

const expectedExtensionFormat = (extension) => {
  if (extension === 'tsv') return 'tsv';
  if (extension === 'csv') return 'csv';
  if (extension === 'xlsx') return 'xlsx';
  if (extension === 'xls') return 'xls';
  return null;
};

const autoMap = (sheet, definition) => {
  const normalizedColumns = sheet.columns.map((column) => ({ ...column, normalized: normalizeHeader(column.label) }));
  return Object.fromEntries(definition.fields.map(([field, , aliases]) => {
    const normalizedAliases = new Set(aliases.map(normalizeHeader));
    const candidates = normalizedColumns.filter((column) => normalizedAliases.has(column.normalized));
    return [field, candidates.length === 1 ? candidates[0].handle : null];
  }));
};

const mappingMeetsRequirements = (mapping, definition) => {
  const missingAll = definition.requiredAll.filter((field) => !mapping[field]);
  const oneOfSatisfied = definition.requiredOneOf.length === 0
    || definition.requiredOneOf.some((option) => option.every((field) => Boolean(mapping[field])));
  return { missingAll, oneOfSatisfied };
};

const suggestedKindForSheet = (sheet) => {
  const scored = Object.entries(IMPORT_KIND_DEFINITIONS).map(([kind, definition]) => {
    const mapping = autoMap(sheet, definition);
    const requirements = mappingMeetsRequirements(mapping, definition);
    const mappedCount = Object.values(mapping).filter(Boolean).length;
    return {
      value: kind,
      label: definition.label,
      score: requirements.missingAll.length === 0 && requirements.oneOfSatisfied ? mappedCount : 0,
      matched_fields: Object.entries(mapping).filter(([, column]) => column).map(([field]) => field)
    };
  }).sort((a, b) => b.score - a.score || a.value.localeCompare(b.value));
  const best = scored[0];
  const runnerUp = scored[1];
  if (!best || best.score < 3 || best.score === runnerUp?.score) return null;
  return {
    value: best.value,
    label: best.label,
    confidence: best.score >= 5 && best.score >= (runnerUp?.score || 0) + 2 ? 'high' : 'medium',
    matched_fields: best.matched_fields
  };
};

const isCalendarDate = (year, month, day) => {
  if (!Number.isInteger(year) || year < 1000 || year > 9999
    || !Number.isInteger(month) || month < 1 || month > 12
    || !Number.isInteger(day) || day < 1 || day > 31) return false;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year
    && candidate.getUTCMonth() === month - 1
    && candidate.getUTCDate() === day;
};

const dateStatus = (cell, convention = 'safe') => {
  if (!cell || isBlank(cell.value)) return 'missing';
  const text = String(cell.value).trim();
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return isCalendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3])) ? 'valid' : 'invalid';
  if (cell.type === 'date') return 'invalid';
  const match = text.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{4})$/);
  if (!match) return 'invalid';
  const first = Number(match[1]);
  const second = Number(match[2]);
  const year = Number(match[3]);
  if (convention === 'dmy') return isCalendarDate(year, second, first) ? 'valid' : 'invalid';
  if (convention === 'mdy') return isCalendarDate(year, first, second) ? 'valid' : 'invalid';
  if (first <= 12 && second <= 12) {
    if (first !== second) return 'ambiguous';
    return isCalendarDate(year, first, second) ? 'valid' : 'invalid';
  }
  if (first > 12) return isCalendarDate(year, second, first) ? 'valid' : 'invalid';
  if (second > 12) return isCalendarDate(year, first, second) ? 'valid' : 'invalid';
  return 'invalid';
};

const numericValue = (cell, convention = 'safe') => {
  if (!cell || isBlank(cell.value)) return { status: 'missing', value: null };
  if (cell.type === 'number' && typeof cell.raw_value === 'number' && Number.isFinite(cell.raw_value)) {
    return { status: 'valid', value: cell.raw_value };
  }
  let text = String(cell.value).trim().replace(/[£€$¥]/g, '').replace(/\s+/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (!/^[+-]?[\d.,]+$/.test(text)) return { status: 'invalid', value: null };
  const commas = (text.match(/,/g) || []).length;
  const dots = (text.match(/\./g) || []).length;
  if (convention === 'dot_decimal') {
    if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) {
      return { status: 'invalid', value: null };
    }
    text = text.replace(/,/g, '');
    const value = Number(text);
    return Number.isFinite(value)
      ? { status: 'valid', value: negative ? -Math.abs(value) : value }
      : { status: 'invalid', value: null };
  }
  if (convention === 'comma_decimal') {
    if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d+)?$/.test(text)) {
      return { status: 'invalid', value: null };
    }
    text = text.replace(/\./g, '').replace(',', '.');
    const value = Number(text);
    return Number.isFinite(value)
      ? { status: 'valid', value: negative ? -Math.abs(value) : value }
      : { status: 'invalid', value: null };
  }
  if (commas > 0 && dots > 0) {
    if (text.lastIndexOf(',') > text.lastIndexOf('.')) {
      if (!/^[+-]?(?:\d+|\d{1,3}(?:\.\d{3})+),\d+$/.test(text)) return { status: 'invalid', value: null };
      text = text.replace(/\./g, '').replace(',', '.');
    } else {
      if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d+$/.test(text)) return { status: 'invalid', value: null };
      text = text.replace(/,/g, '');
    }
  } else if (commas > 0) {
    if (commas === 1) {
      if (/,\d{3}$/.test(text)) return { status: 'ambiguous', value: null };
      text = text.replace(',', '.');
    } else {
      if (!/^[+-]?\d{1,3}(?:,\d{3})+$/.test(text)) return { status: 'invalid', value: null };
      text = text.replace(/,/g, '');
    }
  } else if (dots > 1) {
    if (!/^[+-]?\d{1,3}(?:\.\d{3})+$/.test(text)) return { status: 'invalid', value: null };
    text = text.replace(/\./g, '');
  } else if (dots === 1 && /\.\d{3}$/.test(text)) {
    return { status: 'ambiguous', value: null };
  }
  const value = Number(text);
  return Number.isFinite(value)
    ? { status: 'valid', value: negative ? -Math.abs(value) : value }
    : { status: 'invalid', value: null };
};

const buildPreviewPlan = ({
  sheet,
  importKind,
  requestedMapping = {},
  dateConvention = 'safe',
  numberConvention = 'safe'
}) => {
  const definition = IMPORT_KIND_DEFINITIONS[importKind];
  if (!definition) throw importError('IMPORT_KIND_UNSUPPORTED', 'Choose one of Donna’s supported accounting data types.');
  const knownColumnHandles = new Set(sheet.columns.map((column) => column.handle));
  const knownFields = new Set(definition.fields.map(([field]) => field));
  const automatic = autoMap(sheet, definition);
  const mapping = { ...automatic };
  Object.entries(requestedMapping || {}).forEach(([field, column]) => {
    if (!knownFields.has(field)) return;
    mapping[field] = column && knownColumnHandles.has(column) ? column : null;
  });
  const columnIndexByHandle = new Map(sheet.columns.map((column, index) => [column.handle, index]));
  const requirements = mappingMeetsRequirements(mapping, definition);
  const mappingIssues = [];
  requirements.missingAll.forEach((field) => mappingIssues.push({
    code: 'IMPORT_REQUIRED_COLUMN_UNMAPPED',
    field,
    message: `${definition.fields.find(([candidate]) => candidate === field)?.[1] || field} needs a source column.`
  }));
  if (!requirements.oneOfSatisfied) {
    mappingIssues.push({
      code: 'IMPORT_AMOUNT_COLUMNS_UNMAPPED',
      field: null,
      message: `Map ${definition.requiredOneOf.map((option) => option.join(' + ')).join(' or ')}.`
    });
  }
  const duplicateColumns = Object.entries(mapping).filter(([, value]) => value)
    .reduce((accumulator, [field, column]) => {
      if (!accumulator.has(column)) accumulator.set(column, []);
      accumulator.get(column).push(field);
      return accumulator;
    }, new Map());
  duplicateColumns.forEach((fields, column) => {
    if (fields.length > 1) mappingIssues.push({
      code: 'IMPORT_COLUMN_MAPPED_TWICE',
      field: null,
      column_handle: column,
      message: `One source column is mapped to ${fields.join(' and ')}.`
    });
  });

  let issueCount = mappingIssues.length;
  const issues = [...mappingIssues];
  const blockedRows = new Set();
  const totals = {};
  const journalGroups = new Map();
  const addIssue = (issue) => {
    issueCount += 1;
    if (issue.source_row_number) blockedRows.add(issue.source_row_number);
    if (Array.isArray(issue.source_row_numbers)) issue.source_row_numbers.forEach((rowNumber) => blockedRows.add(rowNumber));
    if (issues.length < ACCOUNTING_IMPORT_LIMITS.maxReportedIssues) issues.push(issue);
  };
  const cellFor = (row, field) => {
    const handle = mapping[field];
    const index = handle ? columnIndexByHandle.get(handle) : null;
    return Number.isInteger(index) ? row.cells[index] : null;
  };
  const accumulate = (field, value) => {
    if (!Number.isFinite(value)) return;
    totals[field] = Number(((totals[field] || 0) + value).toFixed(6));
  };

  if (mappingIssues.length > 0) {
    sheet._dataRows.forEach((row) => blockedRows.add(row.rowNumber));
  } else if (sheet._dataRows.length === 0) {
    addIssue({
      code: 'IMPORT_NO_DATA_ROWS',
      field: null,
      message: 'This sheet has a header but no accounting data rows.'
    });
  }

  if (mappingIssues.length === 0) {
    sheet._dataRows.forEach((row) => {
      definition.requiredAll.forEach((field) => {
        if (isBlank(cellFor(row, field)?.value)) addIssue({
          code: 'IMPORT_REQUIRED_VALUE_MISSING',
          field,
          source_row_number: row.rowNumber,
          message: `${definition.fields.find(([candidate]) => candidate === field)?.[1] || field} is empty.`
        });
      });
      if (definition.requiredOneOf.length > 0) {
        const activeOptions = definition.requiredOneOf.filter((option) => option.every((field) => mapping[field]));
        if (activeOptions.length > 0
          && !activeOptions.some((option) => option.some((field) => !isBlank(cellFor(row, field)?.value)))) addIssue({
          code: 'IMPORT_REQUIRED_VALUE_MISSING',
          field: activeOptions.flat().join('_or_'),
          source_row_number: row.rowNumber,
          message: `This row has no ${activeOptions.map((option) => option.join(' or ')).join(' or ')} value.`
        });
      }

      for (const field of ['date', 'issue_date', 'due_date']) {
        if (!mapping[field] || isBlank(cellFor(row, field)?.value)) continue;
        const status = dateStatus(cellFor(row, field), dateConvention);
        if (status !== 'valid') addIssue({
          code: status === 'ambiguous' ? 'IMPORT_DATE_AMBIGUOUS' : 'IMPORT_DATE_INVALID',
          field,
          source_row_number: row.rowNumber,
          message: status === 'ambiguous'
            ? `${cellFor(row, field).value} could be day/month or month/day. Choose an unambiguous date format.`
            : `${cellFor(row, field).value} is not a supported date.`
        });
      }
      for (const field of ['amount', 'debit', 'credit', 'balance', 'gross_amount', 'outstanding_amount', 'tax_amount']) {
        if (!mapping[field] || isBlank(cellFor(row, field)?.value)) continue;
        const parsed = numericValue(cellFor(row, field), numberConvention);
        if (parsed.status !== 'valid') addIssue({
          code: parsed.status === 'ambiguous' ? 'IMPORT_NUMBER_AMBIGUOUS' : 'IMPORT_NUMBER_INVALID',
          field,
          source_row_number: row.rowNumber,
          message: parsed.status === 'ambiguous'
            ? `${cellFor(row, field).value} has an ambiguous decimal/thousands separator.`
            : `${cellFor(row, field).value} is not a number.`
        });
        else accumulate(field, parsed.value);
      }
      if (mapping.currency && !isBlank(cellFor(row, 'currency')?.value)
        && !/^[A-Za-z]{3}$/.test(String(cellFor(row, 'currency').value).trim())) {
        addIssue({
          code: 'IMPORT_CURRENCY_INVALID',
          field: 'currency',
          source_row_number: row.rowNumber,
          message: `${cellFor(row, 'currency').value} is not a three-letter currency code.`
        });
      }
      if (mapping.email && !isBlank(cellFor(row, 'email')?.value)
        && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(cellFor(row, 'email').value).trim())) {
        addIssue({
          code: 'IMPORT_EMAIL_INVALID',
          field: 'email',
          source_row_number: row.rowNumber,
          message: `${cellFor(row, 'email').value} is not a valid email address.`
        });
      }
      if (mapping.debit && mapping.credit) {
        const debit = numericValue(cellFor(row, 'debit'), numberConvention);
        const credit = numericValue(cellFor(row, 'credit'), numberConvention);
        if (debit.status === 'valid' && credit.status === 'valid' && debit.value !== 0 && credit.value !== 0) {
          addIssue({
            code: 'IMPORT_DEBIT_CREDIT_BOTH_SET',
            field: 'debit_credit',
            source_row_number: row.rowNumber,
            message: 'Debit and credit are both populated on this row.'
          });
        }
        if (importKind === 'general_ledger') {
          const reference = String(cellFor(row, 'entry_reference')?.value || '__whole_file__');
          const group = journalGroups.get(reference) || { debit: 0, credit: 0, rows: [] };
          if (debit.status === 'valid') group.debit += debit.value;
          if (credit.status === 'valid') group.credit += credit.value;
          group.rows.push(row.rowNumber);
          journalGroups.set(reference, group);
        }
      }
    });
  }

  if (mappingIssues.length === 0 && importKind === 'opening_trial_balance') {
    const imbalance = mapping.balance
      ? Math.abs(totals.balance || 0)
      : Math.abs((totals.debit || 0) - (totals.credit || 0));
    if (imbalance > 0.005) addIssue({
      code: 'IMPORT_TRIAL_BALANCE_UNBALANCED',
      field: null,
      source_row_numbers: sheet._dataRows.map((row) => row.rowNumber),
      message: mapping.balance
        ? `Signed trial-balance values do not net to zero (${totals.balance || 0}).`
        : `Trial balance debits (${totals.debit || 0}) do not equal credits (${totals.credit || 0}).`
    });
  }
  if (mappingIssues.length === 0 && importKind === 'general_ledger') {
    journalGroups.forEach((group, reference) => {
      if (Math.abs(group.debit - group.credit) > 0.005) addIssue({
        code: 'IMPORT_JOURNAL_UNBALANCED',
        field: 'entry_reference',
        source_row_number: group.rows[0],
        source_row_numbers: group.rows,
        message: `Journal ${reference === '__whole_file__' ? 'batch' : reference} does not balance (${group.debit} debit, ${group.credit} credit).`
      });
    });
  }

  const state = mappingIssues.length > 0
    ? 'needs_mapping'
    : issueCount > 0 ? 'needs_correction' : 'ready_to_apply';
  return {
    import_kind: importKind,
    import_kind_label: definition.label,
    sheet_handle: sheet.handle,
    conventions: {
      date: dateConvention,
      number: numberConvention
    },
    state,
    mapping: definition.fields.map(([field, label]) => {
      const columnHandle = mapping[field] || null;
      const column = sheet.columns.find((candidate) => candidate.handle === columnHandle);
      return {
        field,
        label,
        required: definition.requiredAll.includes(field),
        column_handle: columnHandle,
        source_label: column?.label || null
      };
    }),
    validation: {
      source_rows: sheet.row_count,
      valid_rows: Math.max(0, sheet.row_count - blockedRows.size),
      blocked_rows: blockedRows.size,
      issue_count: issueCount,
      issues_truncated: issueCount > issues.length,
      issues,
      totals
    }
  };
};

const publicSheet = (sheet) => {
  const { _dataRows, ...visible } = sheet;
  return visible;
};

export const inspectAccountingImport = ({
  bytes: inputBytes,
  filename = 'accounting-data',
  mimeType = '',
  requestedImportKind = null,
  requestedSheetHandle = null,
  requestedMapping = {},
  dateConvention = 'safe',
  numberConvention = 'safe'
} = {}) => {
  const bytes = Buffer.isBuffer(inputBytes) ? inputBytes : Buffer.from(inputBytes || []);
  if (bytes.length === 0) throw importError('IMPORT_FILE_EMPTY', 'Choose a non-empty CSV, TSV, XLSX or XLS file.');
  if (bytes.length > ACCOUNTING_IMPORT_LIMITS.maxFileBytes) {
    throw importError('IMPORT_FILE_SIZE_LIMIT', 'This file is larger than Donna’s safe import-preview limit.', 413, {
      max_file_bytes: ACCOUNTING_IMPORT_LIMITS.maxFileBytes,
      file_bytes: bytes.length
    });
  }

  const detected = detectContainer(bytes, filename);
  let sheets;
  let security = { vba_present: false, external_links_present: false, connections_present: false };
  if (detected.format === 'xlsx' || detected.format === 'xls') {
    const workbook = readWorkbook(bytes, detected.archive);
    sheets = workbook.sheets;
    security = workbook.security;
  } else {
    const rows = parseDelimitedText(detected.text, detected.delimiter);
    const maximumColumn = Math.max(...rows.map((row) => row.cells.length - 1), -1);
    sheets = [buildSheetModel({
      name: 'Table',
      handle: 'sheet_1',
      hidden: 'visible',
      rows,
      maximumRow: rows.length - 1,
      maximumColumn,
      worksheet: null
    })];
  }

  const selectedSheet = requestedSheetHandle
    ? sheets.find((sheet) => sheet.handle === requestedSheetHandle)
    : sheets.find((sheet) => sheet.hidden === 'visible') || sheets[0];
  if (!selectedSheet) throw importError('IMPORT_SHEET_UNKNOWN', 'Choose a worksheet that exists in this file.');

  const warnings = [];
  const blockers = [];
  const extension = extensionOf(filename);
  const expectedFormat = expectedExtensionFormat(extension);
  if (!expectedFormat || expectedFormat !== detected.format) warnings.push({
    code: 'IMPORT_EXTENSION_MISMATCH',
    message: expectedFormat
      ? `The filename says ${expectedFormat.toUpperCase()}, but the bytes are ${detected.format.toUpperCase()}. Donna used the bytes.`
      : `The filename extension is not one of CSV, TSV, XLSX or XLS. The bytes were read as ${detected.format.toUpperCase()}.`
  });
  if (detected.delimiterDetected === false) warnings.push({
    code: 'IMPORT_DELIMITER_UNDETECTED',
    message: 'Donna found a one-column text file and used the delimiter implied by its filename.'
  });
  if (security.vba_present) blockers.push({
    code: 'IMPORT_MACROS_PRESENT',
    message: 'This workbook contains macros or macro sheets. Export a macro-free XLSX values copy before importing.'
  });
  if (security.external_links_present || security.connections_present) warnings.push({
    code: 'IMPORT_EXTERNAL_DATA_PRESENT',
    message: 'This workbook contains external links or data connections. Donna did not open or refresh them.'
  });
  if (selectedSheet.hidden !== 'visible') blockers.push({
    code: 'IMPORT_HIDDEN_SHEET_SELECTED',
    sheet_handle: selectedSheet.handle,
    message: 'The selected worksheet is hidden. Unhide and review it in the source workbook before importing.'
  });
  if (selectedSheet.features.hidden_rows > 0 || selectedSheet.features.hidden_columns > 0) blockers.push({
    code: 'IMPORT_HIDDEN_DATA_PRESENT',
    sheet_handle: selectedSheet.handle,
    message: `The selected worksheet has ${selectedSheet.features.hidden_rows} hidden rows and ${selectedSheet.features.hidden_columns} hidden columns. Unhide and review them first.`
  });
  if (selectedSheet.features.formulas_without_cached_values > 0) blockers.push({
    code: 'IMPORT_FORMULA_VALUE_MISSING',
    sheet_handle: selectedSheet.handle,
    message: `${selectedSheet.features.formulas_without_cached_values} formula cells have no cached value. Export a values-only copy.`
  });
  if (selectedSheet.features.formula_cells > 0) warnings.push({
    code: 'IMPORT_FORMULAS_NOT_EXECUTED',
    message: `${selectedSheet.features.formula_cells} formula cells were not executed; Donna used cached values only.`
  });

  const normalizedKind = requestedImportKind ? String(requestedImportKind).trim().toLowerCase() : null;
  if (normalizedKind && !IMPORT_KIND_DEFINITIONS[normalizedKind]) {
    throw importError('IMPORT_KIND_UNSUPPORTED', 'Choose one of Donna’s supported accounting data types.');
  }
  const normalizedDateConvention = ['safe', 'dmy', 'mdy'].includes(dateConvention) ? dateConvention : 'safe';
  const normalizedNumberConvention = ['safe', 'dot_decimal', 'comma_decimal'].includes(numberConvention) ? numberConvention : 'safe';
  const plan = normalizedKind
    ? buildPreviewPlan({
        sheet: selectedSheet,
        importKind: normalizedKind,
        requestedMapping,
        dateConvention: normalizedDateConvention,
        numberConvention: normalizedNumberConvention
      })
    : null;
  let state = plan?.state || 'needs_kind';
  if (blockers.length > 0 && state !== 'needs_kind' && state !== 'needs_mapping') state = 'needs_correction';

  return {
    schema_version: ACCOUNTING_IMPORT_SCHEMA_VERSION,
    state,
    source: {
      filename: String(filename || 'accounting-data').slice(0, 255),
      byte_length: bytes.length,
      checksum_sha256: createHash('sha256').update(bytes).digest('hex'),
      claimed_mime_type: String(mimeType || '').slice(0, 160) || null,
      extension,
      detected_format: detected.format,
      encoding: detected.encoding || null,
      delimiter: detected.delimiter === '\t' ? 'tab' : detected.delimiter === ';' ? 'semicolon' : detected.delimiter ? 'comma' : null
    },
    security: {
      ...security,
      archive: detected.archive ? {
        entry_count: detected.archive.entry_count,
        uncompressed_bytes: detected.archive.uncompressed_bytes,
        compression_ratio: detected.archive.compression_ratio
      } : null
    },
    available_import_kinds: ACCOUNTING_IMPORT_KINDS,
    selected_sheet_handle: selectedSheet.handle,
    suggested_import_kind: suggestedKindForSheet(selectedSheet),
    sheets: sheets.map(publicSheet),
    warnings,
    blockers,
    plan
  };
};
