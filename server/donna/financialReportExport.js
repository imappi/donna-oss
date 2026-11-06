import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// Downloadable exports for the financial statements. These are a pure projection
// of the report payload built by buildFinancialReport (ledgerReadModel.js) — they
// compute NO figures of their own; every number here came from the deterministic
// GL aggregation. CSV carries the raw data; the PDF is the formatted statement.
// Both stamp the draft/final verdict so a half-coded export can never be mistaken
// for a closed one.

const numberValue = (value) => {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
};

const roundedMoney = (value) => Math.round(numberValue(value) * 100) / 100;

// Machine-parseable money for CSV: fixed 2 decimals, no separators, '-' negative.
const csvMoney = (value) => roundedMoney(value).toFixed(2);

// Human money for the PDF: thousands separators, parentheses for negatives.
const pdfMoney = (value) => {
  const n = roundedMoney(value);
  const abs = Math.abs(n)
    .toFixed(2)
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return n < 0 ? `(${abs})` : abs;
};

const currencyLabel = (currency = {}) => {
  if (currency?.mixed) return `MIXED: ${(currency.currencies || []).join(', ')}`;
  return currency?.presentation || (currency?.currencies || [])[0] || '';
};

const periodLabel = (report = {}) => `${report.period_start || ''} to ${report.period_end || ''}`;

const csvField = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const csvRow = (fields = []) => fields.map(csvField).join(',');

export const buildFinancialReportCsv = (report = {}) => {
  const lines = [];
  const pnl = report.profit_and_loss || {};
  const bs = report.balance_sheet || {};
  const tb = report.trial_balance || {};
  const draft = report.draft || {};
  const currency = report.currency || {};

  lines.push(csvRow(['Donna financial statements']));
  lines.push(csvRow(['Source', 'Donna posted ledger']));
  lines.push(csvRow(['Firm', report.firm_id || '']));
  lines.push(csvRow(['Client', report.client_id || '']));
  lines.push(csvRow(['Period', periodLabel(report)]));
  lines.push(csvRow(['As of', report.as_of || report.period_end || '']));
  lines.push(csvRow(['Basis', report.basis || 'accrual']));
  lines.push(csvRow(['Currency', currencyLabel(currency)]));
  lines.push(csvRow(['Status', draft.stamp || (draft.is_draft ? 'DRAFT' : 'FINAL')]));
  if (currency.mixed) {
    lines.push(csvRow(['Note', 'Books span multiple currencies; subtotalled by currency, no FX applied.']));
  }
  for (const reason of draft.reasons || []) {
    lines.push(csvRow(['Draft reason', reason.detail || reason.code || '']));
  }
  lines.push('');

  // Profit & Loss (period)
  lines.push(csvRow([`Profit and Loss (${periodLabel(report)})`]));
  lines.push(csvRow(['Account code', 'Account name', 'Type', 'Currency', 'Revenue', 'Expense', 'Net']));
  for (const account of pnl.accounts || []) {
    lines.push(csvRow([
      account.code || '',
      account.name || '',
      account.account_type || '',
      account.currency || '',
      csvMoney(account.revenue),
      csvMoney(account.expense),
      csvMoney(account.net)
    ]));
  }
  lines.push(csvRow(['', 'Total revenue', '', '', csvMoney(pnl.revenue), '', '']));
  lines.push(csvRow(['', 'Total expenses', '', '', '', csvMoney(pnl.expenses), '']));
  lines.push(csvRow(['', 'Net income', '', '', '', '', csvMoney(pnl.net_income)]));
  lines.push('');

  // Balance Sheet (as-of)
  lines.push(csvRow([`Balance Sheet (as of ${report.as_of || report.period_end || ''})`]));
  lines.push(csvRow(['Section', 'Account code', 'Account name', 'Currency', 'Amount', 'Unclassified']));
  const bsSection = (label, section = {}) => {
    for (const account of section.accounts || []) {
      lines.push(csvRow([
        label,
        account.code || '',
        account.name || '',
        account.currency || '',
        csvMoney(account.amount),
        account.unclassified ? 'yes' : ''
      ]));
    }
  };
  bsSection('Assets', bs.assets);
  lines.push(csvRow(['Total assets', '', '', '', csvMoney(bs.total_assets), '']));
  bsSection('Liabilities', bs.liabilities);
  lines.push(csvRow(['Total liabilities', '', '', '', csvMoney(bs.total_liabilities), '']));
  bsSection('Equity', bs.equity);
  lines.push(csvRow(['Total equity', '', '', '', csvMoney(bs.total_equity), '']));
  lines.push(csvRow(['Total liabilities and equity', '', '', '', csvMoney(bs.total_liabilities_and_equity), '']));
  lines.push(csvRow(['Balance sheet foots (A = L + E)', '', '', '', bs.balanced ? 'yes' : 'NO', '']));
  if (!bs.balanced) {
    lines.push(csvRow(['Imbalance', '', '', '', csvMoney(bs.imbalance), '']));
  }
  lines.push('');

  // Trial Balance (supporting)
  lines.push(csvRow(['Trial Balance']));
  lines.push(csvRow(['Account code', 'Account name', 'Type', 'Currency', 'Debit', 'Credit']));
  for (const account of tb.accounts || []) {
    lines.push(csvRow([
      account.code || '',
      account.name || '',
      account.account_type || '',
      account.currency || '',
      csvMoney(account.debit_balance),
      csvMoney(account.credit_balance)
    ]));
  }
  lines.push(csvRow(['', 'Total', '', '', csvMoney(tb.total_debit), csvMoney(tb.total_credit)]));
  lines.push(csvRow(['', 'Balanced', '', '', tb.balanced ? 'yes' : 'NO', '']));

  return `${lines.join('\n')}\n`;
};

// ---------------------------------------------------------------------------
// PDF — a formatted P&L + Balance Sheet statement (the trial balance stays in the
// CSV / firm view; the client PDF is the two headline statements).

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points.
const MARGIN = 48;
const LINE = 16;

export const buildFinancialReportPdf = async (report = {}) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);

  const pnl = report.profit_and_loss || {};
  const bs = report.balance_sheet || {};
  const draft = report.draft || {};
  const currency = report.currency || {};
  const cur = currency.mixed ? '' : currencyLabel(currency);
  const ink = rgb(0.1, 0.12, 0.16);
  const muted = rgb(0.4, 0.43, 0.49);
  const danger = rgb(0.72, 0.16, 0.16);

  let page = pdf.addPage([PAGE.width, PAGE.height]);
  let y = PAGE.height - MARGIN;

  const newPage = () => {
    page = pdf.addPage([PAGE.width, PAGE.height]);
    y = PAGE.height - MARGIN;
  };
  const ensure = (needed = LINE) => {
    if (y - needed < MARGIN) newPage();
  };
  const text = (value, { x = MARGIN, size = 10, useFont = font, color = ink } = {}) => {
    page.drawText(String(value === null || value === undefined ? '' : value), { x, y, size, font: useFont, color });
  };
  // A label (left) + amount (right-aligned at the right margin) row.
  const rightX = PAGE.width - MARGIN;
  const amountRow = (label, amount, { size = 10, useFont = font, color = ink, indent = 0 } = {}) => {
    ensure();
    text(label, { x: MARGIN + indent, size, useFont, color });
    const amountText = amount === '' || amount === null || amount === undefined ? '' : pdfMoney(amount);
    const w = useFont.widthOfTextAtSize(amountText, size);
    page.drawText(amountText, { x: rightX - w, y, size, font: useFont, color });
    y -= LINE;
  };
  const heading = (value) => {
    ensure(LINE * 1.6);
    y -= 4;
    text(value, { size: 13, useFont: bold });
    y -= LINE;
  };
  const rule = () => {
    ensure(6);
    page.drawLine({ start: { x: MARGIN, y: y + 10 }, end: { x: rightX, y: y + 10 }, thickness: 0.6, color: rgb(0.85, 0.87, 0.9) });
  };

  // Title + metadata
  text('Financial statements', { size: 18, useFont: bold });
  y -= LINE * 1.4;
  text(`Client ${report.client_id || ''}`, { size: 10, color: muted });
  y -= LINE;
  text(`Period ${periodLabel(report)}  ·  As of ${report.as_of || report.period_end || ''}`, { size: 10, color: muted });
  y -= LINE;
  text(`Basis: ${report.basis || 'accrual'}${cur ? `  ·  Currency: ${cur}` : ''}`, { size: 10, color: muted });
  y -= LINE;
  text('Source: Donna posted ledger', { size: 9, color: muted });
  y -= LINE * 1.2;

  // Draft / final banner
  if (draft.is_draft) {
    page.drawRectangle({ x: MARGIN, y: y - 4, width: rightX - MARGIN, height: LINE + 8, color: rgb(0.99, 0.93, 0.86) });
    text('DRAFT — not a closed period. Figures may change as coding completes.', { x: MARGIN + 8, size: 10, useFont: bold, color: danger });
    y -= LINE + 12;
    for (const reason of (draft.reasons || []).slice(0, 6)) {
      ensure();
      text(`•  ${reason.detail || reason.code}`, { x: MARGIN + 8, size: 9, color: danger });
      y -= LINE * 0.85;
    }
    y -= 4;
  } else {
    text('FINAL — closed period.', { size: 10, useFont: bold, color: rgb(0.12, 0.5, 0.28) });
    y -= LINE;
  }
  if (currency.mixed) {
    text('Books span multiple currencies; amounts are not summed across currencies (no FX applied).', { size: 9, color: danger });
    y -= LINE;
  }

  // Profit & Loss
  heading('Profit & Loss');
  rule();
  for (const account of pnl.accounts || []) {
    amountRow(account.account_label || `${account.code || ''} ${account.name || ''}`.trim(), account.net, { indent: 8 });
  }
  amountRow('Total revenue', pnl.revenue, { useFont: bold });
  amountRow('Total expenses', pnl.expenses, { useFont: bold });
  amountRow('Net income', pnl.net_income, { useFont: bold });
  y -= LINE * 0.6;

  // Balance Sheet
  heading(`Balance Sheet (as of ${report.as_of || report.period_end || ''})`);
  rule();
  const bsGroup = (label, section = {}, total) => {
    text(label, { size: 11, useFont: bold });
    y -= LINE;
    for (const account of section.accounts || []) {
      const name = account.synthetic
        ? account.name
        : (account.account_label || `${account.code || ''} ${account.name || ''}`.trim());
      amountRow(`${name}${account.unclassified ? '  (unclassified)' : ''}`, account.amount, { indent: 8, color: account.unclassified ? danger : ink });
    }
    amountRow(`Total ${label.toLowerCase()}`, total, { useFont: bold });
    y -= LINE * 0.4;
  };
  bsGroup('Assets', bs.assets, bs.total_assets);
  bsGroup('Liabilities', bs.liabilities, bs.total_liabilities);
  bsGroup('Equity', bs.equity, bs.total_equity);
  amountRow('Total liabilities and equity', bs.total_liabilities_and_equity, { useFont: bold });
  ensure();
  text(
    bs.balanced ? 'Balanced: Assets = Liabilities + Equity.' : `DOES NOT FOOT — off by ${pdfMoney(bs.imbalance)}.`,
    { size: 9, useFont: bold, color: bs.balanced ? muted : danger }
  );
  y -= LINE;

  return pdf.save();
};

// A filesystem-safe filename stamped with client / period / draft state.
export const financialReportFilename = (report = {}, extension = 'pdf') => {
  const slug = (value) => String(value || '').replace(/[^a-zA-Z0-9-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase();
  const stamp = report?.draft?.is_draft ? 'draft' : 'final';
  const parts = ['donna', slug(report.client_id) || 'client', slug(report.period_start), 'to', slug(report.period_end), stamp];
  return `${parts.filter(Boolean).join('-')}.${extension}`;
};
